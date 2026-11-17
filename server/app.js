const express = require('express');
const path = require('path');
const fs = require('fs');
const { buildEstimate, applyMarkups, variableContext, ALT_STATUSES, TYPES } = require('./calc');
const M = require('./money');
const { DEFAULT_SECTIONS, createSection, defaultSection, nextSequence, addEstimateItem, createBlankItem, insComponent, isSimple, refreshFromDatabase } = require('./estimate');
const { evaluate, validate, variablesIn, FUNCTIONS } = require('./formula');
const { DEFAULT_MARKUPS, DEFAULT_TERMS, DEFAULT_EXCLUSIONS, DEFAULT_INCLUSIONS } = require('./seed');
const exportsXlsx = require('./export');
const { normalizeCode, divisionOf } = require('./csi');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

/** Pick allowed fields from a body. */
function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body && Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f] === '' ? null : body[f];
  return out;
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const api = express.Router();
  const h = (fn) => (req, res, next) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { next(e); } };
  const id = (req, k = 'id') => { const n = Number(req.params[k]); if (!Number.isInteger(n)) bad('Bad id'); return n; };

  function insert(table, data) {
    const keys = Object.keys(data);
    const info = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => data[k]));
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
  }
  function update(table, rowId, data) {
    const keys = Object.keys(data);
    if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`).run(...keys.map((k) => data[k]), rowId);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId);
    if (!row) throw new HttpError(404, 'Not found');
    return row;
  }
  function remove(table, rowId) {
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rowId);
    if (!info.changes) throw new HttpError(404, 'Not found');
    return { ok: true };
  }
  const touch = (pid) => db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(pid);
  const projectOf = (table, rowId) => db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(rowId)?.project_id;

  // ================= COST CODES =================
  const CC = ['code', 'name', 'sort'];
  const normCC = (d) => { if (d.code != null) d.code = normalizeCode(d.code); return d; };
  api.get('/cost-codes', h(() => db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.cost_code_id = c.id) AS item_count
                                            FROM cost_codes c ORDER BY sort, code`).all()
    .map((c) => { const d = divisionOf(c.code); return { ...c, division: d.division, division_name: d.name }; })));
  api.post('/cost-codes', h((req) => {
    const d = normCC(pick(req.body, CC)); if (!d.code || !d.name) bad('Code and name are required');
    if (d.sort == null) d.sort = (db.prepare('SELECT MAX(sort) m FROM cost_codes').get().m ?? 0) + 1;
    return insert('cost_codes', d);
  }));
  api.put('/cost-codes/:id', h((req) => update('cost_codes', id(req), normCC(pick(req.body, CC)))));
  api.delete('/cost-codes/:id', h((req) => remove('cost_codes', id(req))));

  // ================= ITEMS =================
  const IT = ['item_code', 'description', 'unit', 'cost_type', 'unit_cost', 'cost_code_id', 'notes', 'active'];
  api.get('/items', h(() => db.prepare(`SELECT i.*, c.code AS cost_code, c.name AS cost_code_name,
      (SELECT COUNT(*) FROM assembly_items s WHERE s.item_id = i.id) + (SELECT COUNT(*) FROM estimate_components x WHERE x.item_id = i.id) AS usage
      FROM items i LEFT JOIN cost_codes c ON c.id = i.cost_code_id ORDER BY i.item_code, i.id`).all()));
  api.post('/items', h((req) => {
    const d = pick(req.body, IT); if (!d.item_code || !d.description) bad('Item code and description are required');
    return insert('items', d);
  }));
  api.put('/items/:id', h((req) => update('items', id(req), pick(req.body, IT))));
  api.delete('/items/:id', h((req) => {
    const used = db.prepare('SELECT COUNT(*) n FROM estimate_components WHERE item_id = ?').get(id(req)).n;
    if (used) throw new HttpError(409, `Item is used on ${used} estimate line(s) — deactivate it instead.`);
    return remove('items', id(req));
  }));

  // Bulk import (rows parsed client-side from pasted Excel / CSV)
  api.post('/import/cost-codes', h((req) => {
    const rows = req.body.rows || []; let added = 0, updated = 0;
    db.transaction(() => {
      let sort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM cost_codes').get().m;
      for (const r of rows) {
        if (!r.code || !r.name) continue;
        const code = normalizeCode(r.code);
        const ex = db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code);
        if (ex) { db.prepare('UPDATE cost_codes SET name = ? WHERE id = ?').run(r.name, ex.id); updated++; }
        else { db.prepare('INSERT INTO cost_codes (code, name, sort) VALUES (?,?,?)').run(code, r.name, ++sort); added++; }
      }
    })();
    return { added, updated };
  }));
  api.post('/import/items', h((req) => {
    const rows = req.body.rows || []; let added = 0, updated = 0; const skipped = [];
    db.transaction(() => {
      for (const r of rows) {
        if (!r.item_code || !r.description) { skipped.push(r); continue; }
        const cc = r.cost_code ? db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(normalizeCode(r.cost_code)) : null;
        const type = String(r.cost_type || 'M').trim().toUpperCase()[0];
        const d = { item_code: String(r.item_code), description: r.description, unit: r.unit || 'EA',
          cost_type: TYPES.includes(type) ? type : 'M', unit_cost: Number(String(r.unit_cost ?? 0).replace(/[$,]/g, '')) || 0,
          cost_code_id: cc ? cc.id : null };
        const ex = db.prepare('SELECT id FROM items WHERE item_code = ? AND description = ?').get(d.item_code, d.description);
        if (ex) { update('items', ex.id, d); updated++; } else { insert('items', d); added++; }
      }
    })();
    return { added, updated, skipped: skipped.length };
  }));

  // ================= VARIABLES =================
  const VA = ['name', 'label', 'unit', 'input_type', 'options', 'default_value', 'scope', 'sort'];
  const normVar = (d) => {
    if (d.name) { d.name = String(d.name).trim().toUpperCase(); if (!/^[A-Z_][A-Z0-9_]*$/.test(d.name)) bad('Variable names may use letters, numbers and _ only'); }
    if (d.options && typeof d.options !== 'string') d.options = JSON.stringify(d.options);
    return d;
  };
  api.get('/variables', h(() => db.prepare('SELECT * FROM variables ORDER BY sort, name').all()));
  api.post('/variables', h((req) => { const d = normVar(pick(req.body, VA)); if (!d.name || !d.label) bad('Name and label are required'); return insert('variables', d); }));
  api.put('/variables/:id', h((req) => update('variables', id(req), normVar(pick(req.body, VA)))));
  api.delete('/variables/:id', h((req) => remove('variables', id(req))));

  // ================= ASSEMBLIES =================
  const asmItems = db.prepare(`SELECT s.*, i.item_code, i.description AS item_description, i.unit, i.cost_type, i.unit_cost, c.code AS cost_code
     FROM assembly_items s JOIN items i ON i.id = s.item_id LEFT JOIN cost_codes c ON c.id = i.cost_code_id
     WHERE s.assembly_id = ? ORDER BY s.sort, s.id`);
  api.get('/assemblies', h(() => db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM assembly_items s WHERE s.assembly_id = a.id) AS item_count,
     (SELECT COUNT(*) FROM estimate_items x WHERE x.assembly_id = a.id AND x.deleted_at IS NULL) AS usage FROM assemblies a ORDER BY code, name`).all()));
  api.get('/assemblies/:id', h((req) => {
    const a = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(id(req)); if (!a) throw new HttpError(404, 'Not found');
    a.items = asmItems.all(a.id).map((s) => ({ ...s, formula_error: validate(s.formula), variables: validate(s.formula) ? [] : variablesIn(s.formula) }));
    return a;
  }));
  const AS = ['name', 'code', 'category', 'unit', 'description'];
  api.post('/assemblies', h((req) => { const d = pick(req.body, AS); if (!d.name) bad('Name is required'); return insert('assemblies', d); }));
  api.put('/assemblies/:id', h((req) => update('assemblies', id(req), pick(req.body, AS))));
  api.delete('/assemblies/:id', h((req) => remove('assemblies', id(req))));
  api.post('/assemblies/:id/duplicate', h((req) => {
    const a = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(id(req)); if (!a) throw new HttpError(404, 'Not found');
    let copy;
    db.transaction(() => {
      copy = insert('assemblies', { name: `${a.name} (copy)`, code: a.code ? `${a.code}-COPY` : null, category: a.category, unit: a.unit, description: a.description });
      db.prepare(`INSERT INTO assembly_items (assembly_id, item_id, label, formula, waste_pct, sort)
                  SELECT ?, item_id, label, formula, waste_pct, sort FROM assembly_items WHERE assembly_id = ?`).run(copy.id, a.id);
    })();
    return copy;
  }));
  const AI = ['item_id', 'label', 'formula', 'waste_pct', 'sort'];
  const checkFormula = (d) => { if (d.formula != null) { const err = validate(d.formula); if (err) bad(`Formula error: ${err}`); } return d; };
  api.post('/assemblies/:id/items', h((req) => {
    const d = checkFormula(pick(req.body, AI)); if (!d.item_id) bad('Item is required');
    d.assembly_id = id(req); if (d.sort == null) d.sort = (db.prepare('SELECT MAX(sort) m FROM assembly_items WHERE assembly_id = ?').get(d.assembly_id).m ?? 0) + 1;
    return insert('assembly_items', d);
  }));
  api.put('/assembly-items/:id', h((req) => update('assembly_items', id(req), checkFormula(pick(req.body, AI)))));
  api.delete('/assembly-items/:id', h((req) => remove('assembly_items', id(req))));
  // Try an assembly with test variable values
  api.post('/assemblies/:id/test', h((req) => {
    const vars = {};
    for (const v of db.prepare('SELECT name, default_value FROM variables').all()) vars[v.name] = v.default_value;
    for (const [k, v] of Object.entries(req.body.vars || {})) vars[k.toUpperCase()] = Number(v) || 0;
    const rows = asmItems.all(id(req)).map((s) => {
      const r = evaluate(s.formula, vars); const qty = r.value * (1 + (s.waste_pct || 0));
      return { id: s.id, label: s.label || s.item_description, unit: s.unit, cost_type: s.cost_type, qty, unit_cost: s.unit_cost, total: qty * s.unit_cost, error: r.error, missing: r.missing };
    });
    return { rows, total: rows.reduce((t, r) => t + r.total, 0) };
  }));
  api.post('/formula/check', h((req) => {
    const err = validate(req.body.formula || '');
    return { error: err, variables: err ? [] : variablesIn(req.body.formula), functions: FUNCTIONS };
  }));

  // ================= PROJECTS =================
  const PR = ['name', 'number', 'client', 'gc', 'location', 'bid_date', 'estimator', 'status', 'estimate_name', 'inclusions', 'exclusions', 'terms'];
  api.get('/projects', h(() => db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all().map((p) => {
    const e = buildEstimate(db, p.id);
    return { ...p, base_total: e.totals.base_sell, grand_total: e.totals.grand_sell, area_count: e.areas.length, alternate_count: e.alternates.length };
  })));
  api.post('/projects', h((req) => {
    const d = pick(req.body, PR); if (!d.name) bad('Project name is required');
    let p;
    db.transaction(() => {
      p = insert('projects', { inclusions: DEFAULT_INCLUSIONS, exclusions: DEFAULT_EXCLUSIONS, terms: DEFAULT_TERMS, ...d });
      const pools = Math.max(1, Math.min(20, Number(req.body.pool_count) || 1));
      for (let i = 1; i <= pools; i++) insert('areas', { project_id: p.id, tag: `P${i}`, name: pools === 1 ? 'Pool' : `Pool ${i}`, sort: i });
      insert('areas', { project_id: p.id, tag: 'GEN', name: 'Site-wide / General', sort: 99 });
      DEFAULT_MARKUPS.forEach(([n, pc, b], i) => insert('markups', { project_id: p.id, name: n, percent: pc, basis: b, sort: i }));
      DEFAULT_SECTIONS.forEach((n, i) => createSection(db, p.id, n, i + 1));
      const tv = db.prepare("SELECT id FROM variables WHERE name = 'MC_TOTAL_NUMBER_OF_POOLS'").get();
      if (tv) db.prepare('INSERT INTO var_values (project_id, area_id, variable_id, value) VALUES (?,0,?,?)').run(p.id, tv.id, pools);
    })();
    return p;
  }));
  api.get('/projects/:id', h((req) => { const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id(req)); if (!p) throw new HttpError(404, 'Not found'); return p; }));
  api.put('/projects/:id', h((req) => { const r = update('projects', id(req), pick(req.body, PR)); touch(r.id); return r; }));
  api.delete('/projects/:id', h((req) => remove('projects', id(req))));
  api.post('/projects/:id/duplicate', h((req) => {
    const src = id(req); const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(src); if (!p) throw new HttpError(404, 'Not found');
    let np;
    db.transaction(() => {
      const { id: _i, created_at, updated_at, ...rest } = p;
      np = insert('projects', { ...rest, name: `${p.name} (copy)` });
      const areaMap = { 0: 0 }, altMap = {}, instMap = {};
      for (const a of db.prepare('SELECT * FROM areas WHERE project_id = ?').all(src)) areaMap[a.id] = insert('areas', { project_id: np.id, tag: a.tag, name: a.name, sort: a.sort }).id;
      for (const a of db.prepare('SELECT * FROM alternates WHERE project_id = ?').all(src)) {
        const { id: _a, project_id, section_id, item_id, ...ar } = a;
        altMap[a.id] = insert('alternates', { ...ar, project_id: np.id }).id;
      }
      for (const v of db.prepare('SELECT * FROM var_values WHERE project_id = ?').all(src)) if (areaMap[v.area_id] != null) db.prepare('INSERT INTO var_values VALUES (?,?,?,?)').run(np.id, areaMap[v.area_id], v.variable_id, v.value);
      for (const m of db.prepare('SELECT * FROM markups WHERE project_id = ?').all(src)) insert('markups', { project_id: np.id, name: m.name, percent: m.percent, basis: m.basis, sort: m.sort });
      const secMap = {}, itemMap = {};
      for (const x of db.prepare('SELECT * FROM estimate_sections WHERE project_id = ?').all(src)) secMap[x.id] = insert('estimate_sections', { project_id: np.id, name: x.name, sort: x.sort }).id;
      for (const x of db.prepare('SELECT * FROM estimate_items WHERE project_id = ? AND deleted_at IS NULL').all(src)) {
        const { id: oldId, project_id, section_id, area_id, alternate_id, created_at: _c, updated_at: _u, deleted_at, ...rest } = x;
        itemMap[oldId] = insert('estimate_items', { ...rest, project_id: np.id, section_id: secMap[section_id], area_id: areaMap[area_id], alternate_id: alternate_id ? altMap[alternate_id] : null }).id;
        for (const c of db.prepare('SELECT * FROM estimate_components WHERE estimate_item_id = ?').all(oldId)) {
          const { id: _cid, estimate_item_id, ...cr } = c;
          insert('estimate_components', { ...cr, estimate_item_id: itemMap[oldId] });
        }
      }
      for (const a of db.prepare('SELECT * FROM alternates WHERE project_id = ?').all(src)) {
        db.prepare('UPDATE alternates SET section_id = ?, item_id = ? WHERE id = ?').run(a.section_id ? secMap[a.section_id] ?? null : null, a.item_id ? itemMap[a.item_id] ?? null : null, altMap[a.id]);
      }
    })();
    return np;
  }));
  api.get('/projects/:id/estimate', h((req) => { const e = buildEstimate(db, id(req)); if (!e) throw new HttpError(404, 'Not found'); return e; }));

  // ---- Areas (pools) / alternates / markups
  const childRoutes = (table, fields, required) => {
    api.post(`/projects/:id/${table}`, h((req) => {
      const d = pick(req.body, fields); for (const f of required) if (d[f] == null) bad(`${f} is required`);
      d.project_id = id(req);
      if (d.sort == null) d.sort = (db.prepare(`SELECT MAX(sort) m FROM ${table} WHERE project_id = ?`).get(d.project_id).m ?? 0) + 1;
      const r = insert(table, d); touch(d.project_id); return r;
    }));
    api.put(`/${table}/:id`, h((req) => { const r = update(table, id(req), pick(req.body, fields)); touch(r.project_id); return r; }));
    api.delete(`/${table}/:id`, h((req) => { const pid = projectOf(table, id(req)); const r = remove(table, id(req)); touch(pid); return r; }));
  };
  childRoutes('areas', ['tag', 'name', 'sort'], ['tag', 'name']);
  childRoutes('markups', ['name', 'percent', 'basis', 'sort'], ['name']);

  // ---- Variable values
  api.get('/projects/:id/vars', h((req) => db.prepare('SELECT * FROM var_values WHERE project_id = ?').all(id(req))));
  api.put('/projects/:id/vars', h((req) => {
    const pid = id(req);
    const list = Array.isArray(req.body) ? req.body : [req.body];
    db.transaction(() => {
      for (const { area_id = 0, variable_id, value } of list) {
        if (value === null || value === '' || value === undefined) db.prepare('DELETE FROM var_values WHERE project_id = ? AND area_id = ? AND variable_id = ?').run(pid, area_id, variable_id);
        else db.prepare(`INSERT INTO var_values (project_id, area_id, variable_id, value) VALUES (?,?,?,?)
                         ON CONFLICT(project_id, area_id, variable_id) DO UPDATE SET value = excluded.value`).run(pid, area_id, variable_id, Number(value));
      }
    })();
    touch(pid);
    return { ok: true };
  }));

  // ================= ESTIMATE WORKSHEET =================
  // Every change is written to estimate_log with the user's name (X-User header).
  const who = (req) => String(req.get('X-User') || '').trim().slice(0, 60) || 'Unknown';
  const log = (req, pid, action, detail) => {
    db.prepare('INSERT INTO estimate_log (project_id, user, action, detail) VALUES (?,?,?,?)').run(pid, who(req), action, detail ?? null);
    touch(pid);
  };
  const row = (table, rowId) => { const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId); if (!r) throw new HttpError(404, 'Not found'); return r; };
  const numOrNull = (v, label) => {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v); if (!Number.isFinite(n)) bad(`${label} must be a number`); return n;
  };
  const fmt = (v) => (v == null ? '—' : String(v));
  const tx = (fn) => db.transaction(fn)();

  // ---- Bid item catalog for the Add Item search (assemblies + database items)
  api.get('/projects/:id/catalog', h((req) => {
    const pid = id(req);
    const areaId = Number(req.query.area_id) || db.prepare('SELECT id FROM areas WHERE project_id = ? ORDER BY sort, id LIMIT 1').get(pid)?.id || 0;
    const ctx = variableContext(db, pid)(areaId);
    const comps = db.prepare(`SELECT s.*, i.item_code, i.description AS item_description, i.unit, i.cost_type, i.unit_cost, c.code AS cost_code FROM assembly_items s
                              JOIN items i ON i.id = s.item_id LEFT JOIN cost_codes c ON c.id = i.cost_code_id WHERE s.assembly_id = ? ORDER BY s.sort, s.id`);
    const assemblies = db.prepare('SELECT * FROM assemblies ORDER BY code, name').all().map((a) => {
      const parts = comps.all(a.id).map((s) => {
        const r = evaluate(s.formula, ctx); const qty = r.value * (1 + (s.waste_pct || 0));
        return { label: s.label || s.item_description, item_code: s.item_code, cost_code: s.cost_code, unit: s.unit, cost_type: s.cost_type, qty, unit_cost: s.unit_cost, ext: M.dollars(M.ext(qty, s.unit_cost)) };
      });
      return { key: `A${a.id}`, kind: 'assembly', id: a.id, bid_item_no: a.code || `ASM-${a.id}`, name: a.name, description: a.description,
        category: a.category || 'Assembly', unit: a.unit || 'LS', default_qty: 1, default_unit_price: M.dollars(parts.reduce((s, p) => s + M.cents(p.ext), 0)), components: parts };
    });
    const items = db.prepare(`SELECT i.*, c.code AS cost_code, c.name AS cost_code_name FROM items i LEFT JOIN cost_codes c ON c.id = i.cost_code_id
                              WHERE i.active = 1 ORDER BY i.item_code`).all().map((i) => ({
      key: `I${i.id}`, kind: 'item', id: i.id, bid_item_no: i.item_code, name: i.description, description: i.notes, cost_code: i.cost_code,
      category: i.cost_code ? `${i.cost_code} ${i.cost_code_name}` : 'Uncoded', unit: i.unit, cost_type: i.cost_type, default_qty: null, default_unit_price: i.unit_cost,
      components: [{ label: i.description, item_code: i.item_code, cost_code: i.cost_code, unit: i.unit, cost_type: i.cost_type, qty: 1, unit_cost: i.unit_cost, ext: i.unit_cost }],
    }));
    return { area_id: areaId, rows: [...assemblies, ...items] };
  }));

  // ---- Sections (level 1)
  api.post('/projects/:id/sections', h((req) => {
    const pid = id(req); row('projects', pid);
    const sid = tx(() => createSection(db, pid, String(req.body.name || '').trim().toUpperCase()));
    const sec = row('estimate_sections', sid);
    log(req, pid, 'section.add', `${sec.number} – ${sec.name}`); return sec;
  }));
  api.put('/sections/:id', h((req) => {
    const s = row('estimate_sections', id(req)); const d = pick(req.body, ['name', 'sort']);
    if (d.name !== undefined && !String(d.name || '').trim()) bad('Section name is required');
    const r = update('estimate_sections', s.id, d); log(req, s.project_id, 'section.edit', `${s.name} → ${r.name}`); return r;
  }));
  api.post('/sections/:id/move', h((req) => {
    const s = row('estimate_sections', id(req));
    const list = db.prepare('SELECT id FROM estimate_sections WHERE project_id = ? ORDER BY sort, id').all(s.project_id).map((x) => x.id);
    const i = list.indexOf(s.id), j = i + (Number(req.body.dir) < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return { ok: true };
    [list[i], list[j]] = [list[j], list[i]];
    tx(() => list.forEach((sid, k) => db.prepare('UPDATE estimate_sections SET sort = ? WHERE id = ?').run(k + 1, sid)));
    log(req, s.project_id, 'section.move', s.name); return { ok: true };
  }));
  api.delete('/sections/:id', h((req) => {
    const s = row('estimate_sections', id(req));
    const n = db.prepare('SELECT COUNT(*) n FROM estimate_items WHERE section_id = ? AND deleted_at IS NULL').get(s.id).n
      + db.prepare('SELECT COUNT(*) n FROM alternates WHERE section_id = ?').get(s.id).n;
    if (n) throw new HttpError(409, `${s.name} still has ${n} item(s) or alternate(s). Move or delete them first.`);
    tx(() => { db.prepare('DELETE FROM estimate_items WHERE section_id = ?').run(s.id); remove('estimate_sections', s.id); });
    log(req, s.project_id, 'section.delete', s.name); return { ok: true };
  }));

  // Displayed bid item number: "<section number>.<item sequence>", built as text (never stored, never a key)
  const itemNo = (e) => {
    const s = db.prepare('SELECT number FROM estimate_sections WHERE id = ?').get(e.section_id);
    return e.item_sequence != null && s ? `${s.number}.${e.item_sequence}` : '';
  };

  // ---- New EMPTY parent bid item (no components, $0.00) at the bottom of the chosen section
  api.post('/projects/:id/estimate-items/blank', h((req) => {
    const pid = id(req); row('projects', pid);
    const eid = tx(() => createBlankItem(db, pid, { section_id: Number(req.body.section_id) || null, area_id: req.body.area_id ? Number(req.body.area_id) : undefined, name: req.body.name || '' }));
    const e = row('estimate_items', eid);
    log(req, pid, 'item.add', `${itemNo(e)} (empty bid item)`); return { ...e, number: itemNo(e) };
  }));

  // ---- Estimate items (level 2). POST accepts one item or an array (multi-select add).
  api.post('/projects/:id/estimate-items', h((req) => {
    const pid = id(req); row('projects', pid);
    const list = Array.isArray(req.body) ? req.body : [req.body];
    if (!list.length) bad('Nothing to add');
    const ids = [];
    tx(() => {
      const newSections = new Map();
      for (const raw of list) {
        const d = { ...raw, project_id: pid };
        if (!d.section_id && d.new_section_name) {
          const key = String(d.new_section_name).trim().toUpperCase();
          if (!newSections.has(key)) newSections.set(key, createSection(db, pid, key));
          d.section_id = newSections.get(key);
        }
        if (!d.section_id) bad('Choose a section');
        if (!d.area_id) bad('Choose a pool / area');
        if (!d.assembly_id && !d.item_id) bad('Choose a bid item');
        for (const k of ['qty', 'unit_price']) d[k] = numOrNull(d[k], k === 'qty' ? 'Quantity' : 'Unit price');
        ids.push(addEstimateItem(db, d));
      }
    });
    const names = ids.map((i) => db.prepare('SELECT bid_item_no, name FROM estimate_items WHERE id = ?').get(i)).map((r) => `${r.bid_item_no || ''} ${r.name}`.trim());
    log(req, pid, 'item.add', names.join('; '));
    return { ids };
  }));
  const ITEM_FIELDS = ['bid_item_no', 'name', 'description', 'notes', 'qty', 'unit', 'unit_price', 'total_override', 'area_id', 'section_id', 'alternate_id', 'excluded'];
  api.put('/estimate-items/:id', h((req) => {
    const e = row('estimate_items', id(req)); if (e.deleted_at) throw new HttpError(404, 'This item was deleted');
    const d = pick(req.body, ITEM_FIELDS);
    if (d.name !== undefined && !String(d.name || '').trim()) bad('Description is required');
    if (d.unit !== undefined && !String(d.unit || '').trim()) bad('Unit is required');
    if (d.bid_item_no !== undefined) {
      d.bid_item_no = String(d.bid_item_no || '').trim();
      if (!d.bid_item_no) bad('Bid item number is required');
      // BI-### numbers identify parent bid items, so they must be unique (assembly codes may repeat per pool)
      if (/^BI-/i.test(d.bid_item_no) && db.prepare('SELECT 1 FROM estimate_items WHERE project_id = ? AND bid_item_no = ? AND id <> ? AND deleted_at IS NULL').get(e.project_id, d.bid_item_no, e.id)) {
        bad(`${d.bid_item_no} is already used in this estimate`);
      }
    }
    if (d.qty !== undefined) d.qty = numOrNull(d.qty, 'Quantity') ?? 0;
    if (d.unit_price !== undefined) d.unit_price = numOrNull(d.unit_price, 'Unit price');
    if (d.total_override !== undefined) d.total_override = numOrNull(d.total_override, 'Base estimate cost');
    if (d.excluded !== undefined) d.excluded = d.excluded ? 1 : 0;
    const check = (table, v, label) => { if (v != null && db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(v)?.project_id !== e.project_id) bad(`${label} does not belong to this project`); };
    check('areas', d.area_id, 'Pool / area'); check('estimate_sections', d.section_id, 'Section'); check('alternates', d.alternate_id, 'Alternate');
    if (d.section_id === null || d.area_id === null) bad('Section and pool / area are required');
    tx(() => {
      // A single database item's unit price IS its component price; anything else is a per-unit override.
      if (d.unit_price != null) {
        const simple = isSimple(db, e.id);
        if (simple) { db.prepare('UPDATE estimate_components SET unit_cost = ? WHERE id = ?').run(d.unit_price, simple); d.unit_price = null; }
      }
      // Entering a quantity or unit price clears a lump-sum total, so the row is qty × unit price again.
      if ((req.body.unit_price !== undefined || req.body.qty !== undefined) && d.total_override === undefined) d.total_override = null;
      // Moving to another section: keep the item's id and components, give it the next number there
      const toSection = d.section_id !== undefined && d.section_id !== e.section_id ? d.section_id : null;
      const toAlt = d.alternate_id !== undefined ? d.alternate_id : e.alternate_id;
      if (toSection) {
        d.item_sequence = toAlt ? null : nextSequence(db, toSection);
        d.sort = (db.prepare('SELECT MAX(sort) m FROM estimate_items WHERE section_id = ?').get(toSection).m ?? 0) + 1;
      } else if (!toAlt && e.item_sequence == null) {
        d.item_sequence = nextSequence(db, e.section_id); // back into the base bid from an alternate
      }
      d.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      update('estimate_items', e.id, d);
    });
    const changes = Object.keys(req.body).filter((k) => ITEM_FIELDS.includes(k)).map((k) => `${k}: ${fmt(e[k])} → ${fmt(req.body[k])}`);
    log(req, e.project_id, 'item.edit', `${itemNo(e) || e.bid_item_no || ''} ${e.name} — ${changes.join(', ')}${d.item_sequence != null && d.item_sequence !== e.item_sequence ? ` (now ${itemNo(row('estimate_items', e.id))})` : ''}`);
    return { ok: true };
  }));
  api.delete('/estimate-items/:id', h((req) => {
    const e = row('estimate_items', id(req));
    db.prepare("UPDATE estimate_items SET deleted_at = datetime('now') WHERE id = ?").run(e.id);
    log(req, e.project_id, 'item.delete', `${itemNo(e)} ${e.name} (number not reused)`); return { ok: true };
  }));
  api.post('/estimate-items/:id/restore', h((req) => {
    const e = row('estimate_items', id(req));
    db.prepare('UPDATE estimate_items SET deleted_at = NULL WHERE id = ?').run(e.id);
    log(req, e.project_id, 'item.restore', `${e.bid_item_no || ''} ${e.name}`); return { ok: true };
  }));
  api.post('/estimate-items/:id/move', h((req) => {
    // Re-order within the section. Only the display order (sort) changes; numbers stay put.
    const e = row('estimate_items', id(req));
    const list = db.prepare('SELECT id FROM estimate_items WHERE section_id = ? AND deleted_at IS NULL AND alternate_id IS ? ORDER BY sort, id').all(e.section_id, e.alternate_id).map((x) => x.id);
    const i = list.indexOf(e.id), j = i + (Number(req.body.dir) < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return { ok: true };
    [list[i], list[j]] = [list[j], list[i]];
    tx(() => list.forEach((x, k) => db.prepare('UPDATE estimate_items SET sort = ? WHERE id = ?').run(k + 1, x)));
    log(req, e.project_id, 'item.move', `${itemNo(e)} ${e.name}`); return { ok: true };
  }));
  api.post('/estimate-items/:id/refresh', h((req) => {
    const e = row('estimate_items', id(req));
    const n = tx(() => refreshFromDatabase(db, e.id));
    log(req, e.project_id, 'item.refresh', `${e.name}: ${n} component(s) updated from database`); return { changed: n };
  }));

  // ---- Components (level 3)
  const COMP_FIELDS = ['label', 'formula', 'waste_pct', 'qty', 'unit', 'unit_cost', 'cost_type', 'excluded'];
  const projOfComp = (cid) => db.prepare('SELECT e.project_id, e.name, c.label FROM estimate_components c JOIN estimate_items e ON e.id = c.estimate_item_id WHERE c.id = ?').get(cid);
  const cleanComp = (d) => {
    if (d.formula !== undefined) { d.formula = String(d.formula || '').trim() || '1'; const err = validate(d.formula); if (err) bad(`Formula error: ${err}`); }
    if (d.qty !== undefined) { d.qty = numOrNull(d.qty, 'Quantity'); if (d.qty != null && d.qty < 0) bad('Quantity cannot be negative'); }
    if (d.unit_cost !== undefined) { d.unit_cost = numOrNull(d.unit_cost, 'Unit cost'); if (d.unit_cost == null) bad('Unit cost is required'); if (d.unit_cost < 0) bad('Unit cost cannot be negative'); }
    if (d.unit !== undefined && !String(d.unit || '').trim()) bad('Unit is required');
    if (d.cost_type !== undefined && !TYPES.includes(d.cost_type)) bad('Cost type must be Labor, Material, Equipment, Subcontractor or Other');
    if (d.label !== undefined && !String(d.label || '').trim()) bad('Description is required');
    if (d.waste_pct !== undefined) d.waste_pct = numOrNull(d.waste_pct, 'Waste') ?? 0;
    if (d.excluded !== undefined) d.excluded = d.excluded ? 1 : 0;
    return d;
  };
  api.post('/estimate-items/:id/components', h((req) => {
    const e = row('estimate_items', id(req));
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.body.item_id); if (!it) bad('Choose a database item');
    const d = cleanComp(pick(req.body, COMP_FIELDS));
    const sort = (db.prepare('SELECT MAX(sort) m FROM estimate_components WHERE estimate_item_id = ?').get(e.id).m ?? 0) + 1;
    if (e.deleted_at) bad('That bid item was deleted');
    const cid = insComponent(db, { estimate_item_id: e.id, item_id: it.id, label: d.label || it.description, formula: d.formula || '1', waste_pct: d.waste_pct,
      qty: d.qty, unit: d.unit, unit_cost: d.unit_cost ?? it.unit_cost, cost_type: d.cost_type, excluded: d.excluded, sort });
    log(req, e.project_id, 'component.add', `${e.bid_item_no || ''} ${e.name} › ${d.label || it.description}${d.qty != null ? ` × ${d.qty}` : ''}`); return { id: Number(cid) };
  }));
  api.put('/components/:id', h((req) => {
    const p = projOfComp(id(req)); if (!p) throw new HttpError(404, 'Not found');
    const d = cleanComp(pick(req.body, COMP_FIELDS));
    // Reassign to another parent bid item in the same project
    if (req.body.estimate_item_id !== undefined) {
      const to = db.prepare('SELECT project_id, deleted_at FROM estimate_items WHERE id = ?').get(Number(req.body.estimate_item_id));
      if (!to || to.project_id !== p.project_id || to.deleted_at) bad('Choose a bid item in this estimate');
      d.estimate_item_id = Number(req.body.estimate_item_id);
      d.sort = (db.prepare('SELECT MAX(sort) m FROM estimate_components WHERE estimate_item_id = ?').get(d.estimate_item_id).m ?? 0) + 1;
    }
    const r = update('estimate_components', id(req), d);
    log(req, p.project_id, 'component.edit', `${p.name} › ${p.label}: ${Object.entries(req.body).map(([k, v]) => `${k} → ${fmt(v)}`).join(', ')}`); return r;
  }));
  api.delete('/components/:id', h((req) => {
    const p = projOfComp(id(req)); if (!p) throw new HttpError(404, 'Not found');
    const c = row('estimate_components', id(req)); remove('estimate_components', c.id);
    log(req, p.project_id, 'component.delete', `${p.name} › ${p.label}`); return c;
  }));

  // ---- Alternates / VE register
  const ALT_FIELDS = ['tag', 'name', 'kind', 'status', 'section_id', 'item_id', 'replaces', 'bid_item_no', 'description', 'qty', 'unit', 'unit_price', 'cost_type', 'reason', 'notes', 'sort'];
  const cleanAlt = (pid, d) => {
    if (d.kind !== undefined && !['add', 'deduct'].includes(d.kind)) bad('Type must be VE Deduct or Add Alternate');
    if (d.status !== undefined && !ALT_STATUSES.includes(d.status)) bad(`Status must be one of ${ALT_STATUSES.join(', ')}`);
    if (d.cost_type !== undefined && !TYPES.includes(d.cost_type)) bad('Cost type must be L, M, E, S or O');
    if (d.name !== undefined && !String(d.name || '').trim()) bad('Item name is required');
    for (const [k, l] of [['qty', 'Quantity'], ['unit_price', 'Unit price']]) if (d[k] !== undefined) d[k] = numOrNull(d[k], l);
    if (d.unit_price != null && d.unit_price < 0) bad('Enter the unit price as a positive number — the type decides add or deduct');
    if (d.replaces !== undefined) d.replaces = d.replaces ? 1 : 0;
    if (d.section_id != null && db.prepare('SELECT project_id FROM estimate_sections WHERE id = ?').get(d.section_id)?.project_id !== pid) bad('Section does not belong to this project');
    if (d.item_id != null) {
      const it = db.prepare('SELECT project_id, alternate_id, deleted_at FROM estimate_items WHERE id = ?').get(d.item_id);
      if (!it || it.project_id !== pid || it.deleted_at || it.alternate_id) bad('Associated bid item must be a base bid item in this project');
    }
    return d;
  };
  api.post('/projects/:id/alternates', h((req) => {
    const pid = id(req); row('projects', pid);
    const d = cleanAlt(pid, pick(req.body, ALT_FIELDS));
    d.kind = d.kind || 'add'; d.status = d.status || 'proposed'; if (!d.name) bad('Item name is required');
    if (!d.tag) {
      const prefix = d.kind === 'deduct' ? 'VE' : 'ALT';
      const nums = db.prepare('SELECT tag FROM alternates WHERE project_id = ?').all(pid)
        .map((a) => new RegExp(`^${prefix}\\s*(\\d+)$`, 'i').exec(a.tag)?.[1]).filter(Boolean).map(Number);
      d.tag = `${prefix} ${Math.max(0, ...nums) + 1}`;
    }
    d.project_id = pid; d.sort = (db.prepare('SELECT MAX(sort) m FROM alternates WHERE project_id = ?').get(pid).m ?? 0) + 1;
    if (d.qty == null && d.unit_price != null) d.qty = 1;
    const r = insert('alternates', d); log(req, pid, 'alternate.add', `${r.tag} ${r.name}`); return r;
  }));
  api.put('/alternates/:id', h((req) => {
    const a = row('alternates', id(req));
    const r = update('alternates', a.id, cleanAlt(a.project_id, pick(req.body, ALT_FIELDS)));
    log(req, a.project_id, 'alternate.edit', `${a.tag} — ${Object.entries(req.body).map(([k, v]) => `${k}: ${fmt(a[k])} → ${fmt(v)}`).join(', ')}`); return r;
  }));
  api.delete('/alternates/:id', h((req) => {
    const a = row('alternates', id(req)); remove('alternates', a.id);
    log(req, a.project_id, 'alternate.delete', `${a.tag} ${a.name}`); return { ok: true };
  }));

  // ---- Revisions (Rev 0, Rev 1 ...) and change log
  const snapshot = (e) => ({
    totals: e.totals,
    sections: e.sections.map((s) => ({ id: s.id, number: s.number, name: s.name, direct: s.direct, sell: s.sell })),
    items: e.items.map((i) => ({ id: i.id, number: i.number, section_id: i.section_id, alternate_id: i.alternate_id, bid_item_no: i.bid_item_no, name: i.name,
      area_tag: i.area_tag, qty: i.qty, unit: i.unit, unit_price: i.unit_price, direct: i.direct, sell: i.sell ?? null, excluded: i.excluded })),
    alternates: e.alternates.map((a) => ({ id: a.id, tag: a.tag, name: a.name, kind: a.kind, status: a.status, net_direct: a.net_direct, net_sell: a.net_sell })),
  });
  const diff = (from, to) => {
    const out = { items: [], alternates: [], totals: {} };
    const A = new Map(from.items.map((i) => [i.id, i])), B = new Map(to.items.map((i) => [i.id, i]));
    for (const [k, b] of B) {
      const a = A.get(k);
      if (!a) { out.items.push({ change: 'added', ...b }); continue; }
      const fields = ['name', 'qty', 'unit', 'unit_price', 'direct', 'excluded', 'area_tag'].filter((f) => a[f] !== b[f]);
      if (fields.length) out.items.push({ change: 'changed', ...b, before: Object.fromEntries(fields.map((f) => [f, a[f]])), fields });
    }
    for (const [k, a] of A) if (!B.has(k)) out.items.push({ change: 'removed', ...a });
    const X = new Map(from.alternates.map((a) => [a.id, a])), Y = new Map(to.alternates.map((a) => [a.id, a]));
    for (const [k, b] of Y) {
      const a = X.get(k);
      if (!a) out.alternates.push({ change: 'added', ...b });
      else if (a.status !== b.status || a.net_direct !== b.net_direct || a.name !== b.name) out.alternates.push({ change: 'changed', ...b, before: { status: a.status, net_direct: a.net_direct, name: a.name } });
    }
    for (const [k, a] of X) if (!Y.has(k)) out.alternates.push({ change: 'removed', ...a });
    for (const k of ['base_direct', 'base_sell', 'grand_sell']) out.totals[k] = { from: from.totals[k], to: to.totals[k], delta: M.dollars(M.cents(to.totals[k]) - M.cents(from.totals[k])) };
    return out;
  };
  api.get('/projects/:id/revisions', h((req) => {
    const pid = id(req);
    const e = buildEstimate(db, pid); if (!e) throw new HttpError(404, 'Not found');
    const revs = db.prepare('SELECT * FROM estimate_revisions WHERE project_id = ? ORDER BY rev').all(pid);
    const list = revs.map((r, i) => {
      const data = JSON.parse(r.data);
      return { id: r.id, rev: r.rev, label: r.label, note: r.note, created_by: r.created_by, created_at: r.created_at, totals: data.totals,
        changes: i ? diff(JSON.parse(revs[i - 1].data), data) : null };
    });
    const last = revs.at(-1);
    const working = last ? diff(JSON.parse(last.data), snapshot(e)) : null;
    const dirty = !!working && working.items.length + working.alternates.length > 0;
    const since = db.prepare('SELECT * FROM estimate_log WHERE project_id = ? AND id > ? ORDER BY id DESC LIMIT 200')
      .all(pid, last ? db.prepare("SELECT COALESCE(MAX(id),0) m FROM estimate_log WHERE project_id = ? AND action = 'revision.issue'").get(pid).m : 0);
    return { revisions: list, working: { changes: working, dirty, totals: e.totals, log: since } };
  }));
  api.post('/projects/:id/revisions', h((req) => {
    const pid = id(req); const e = buildEstimate(db, pid); if (!e) throw new HttpError(404, 'Not found');
    const rev = (db.prepare('SELECT MAX(rev) m FROM estimate_revisions WHERE project_id = ?').get(pid).m ?? -1) + 1;
    const r = insert('estimate_revisions', { project_id: pid, rev, label: String(req.body.label || '').trim() || `Rev ${rev}`, note: req.body.note || null,
      created_by: who(req), data: JSON.stringify(snapshot(e)) });
    log(req, pid, 'revision.issue', `${r.label}${r.note ? ` — ${r.note}` : ''}`);
    const { data, ...meta } = r; return meta;
  }));

  // ---- Excel exports
  api.get('/projects/:id/export/:kind', async (req, res, next) => {
    try {
      const e = buildEstimate(db, id(req)); if (!e) throw new HttpError(404, 'Not found');
      const kind = req.params.kind.replace(/\.xlsx$/, '');
      if (!exportsXlsx[kind]) throw new HttpError(404, 'Unknown export');
      const wb = exportsXlsx[kind](e);
      const safe = (e.project.number ? `${e.project.number} ` : '') + e.project.name;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safe.replace(/[^\w\- ]+/g, '').trim()} - ${kind.toUpperCase()}.xlsx"`);
      await wb.xlsx.write(res); res.end();
    } catch (err) { next(err); }
  });

  app.use('/api', api);

  // Serve the built React app
  const dist = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, _req, res, _next) => {
    let status = err.status || 500; let msg = err.message;
    if (/UNIQUE constraint/.test(msg)) { status = 409; msg = 'That code / tag already exists.'; }
    if (/FOREIGN KEY constraint/.test(msg)) { status = 409; msg = 'This record is still in use elsewhere.'; }
    if (status === 500) console.error(err);
    res.status(status).json({ error: msg });
  });
  return app;
}

module.exports = { createApp, applyMarkups };
