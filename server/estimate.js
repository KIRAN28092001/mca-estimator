// Project estimate building blocks shared by the API, the seed and the migration.
// Adding a bid item COPIES its components and prices into the project, so later
// edits to the bid item database never silently change an existing estimate.

// New projects start with no sections: the estimator creates them (1 – POOL, 2 – HARDSCAPES …).
const DEFAULT_SECTIONS = [];

class EstimateError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (msg, status = 400) => { throw new EstimateError(status, msg); };

const maxSort = (db, sql, ...a) => db.prepare(sql).get(...a).m ?? 0;

/**
 * Sections carry a permanent integer NUMBER (1, 2, 3 …) separate from their display order (sort).
 * Call inside a transaction; UNIQUE(project_id, number) backs it up.
 */
function createSection(db, projectId, name, sort) {
  if (!String(name || '').trim()) fail('Section name is required');
  if (sort == null) sort = maxSort(db, 'SELECT MAX(sort) m FROM estimate_sections WHERE project_id = ?', projectId) + 1;
  const number = maxSort(db, 'SELECT MAX(number) m FROM estimate_sections WHERE project_id = ?', projectId) + 1;
  const info = db.prepare('INSERT INTO estimate_sections (project_id, number, name, sort) VALUES (?,?,?,?)').run(projectId, number, String(name).trim(), sort);
  return Number(info.lastInsertRowid);
}

/**
 * Next bid item sequence in a section (1, 2, 3 …). Counts deleted items too, so a number is
 * never reused and remaining items are never renumbered. UNIQUE(section_id, item_sequence) backs it up.
 */
const nextSequence = (db, sectionId) => maxSort(db, 'SELECT MAX(item_sequence) m FROM estimate_items WHERE section_id = ?', sectionId) + 1;

/** Section that new items go into when none is given: the last one (so they land at the end of the list). */
function defaultSection(db, projectId) {
  const s = db.prepare('SELECT id FROM estimate_sections WHERE project_id = ? ORDER BY sort DESC, id DESC LIMIT 1').get(projectId);
  return s ? s.id : createSection(db, projectId, DEFAULT_SECTIONS[0]);
}

function checkOwnership(db, d) {
  const sec = db.prepare('SELECT project_id FROM estimate_sections WHERE id = ?').get(d.section_id);
  if (!sec || sec.project_id !== d.project_id) fail('Section does not belong to this project');
  const area = db.prepare('SELECT project_id FROM areas WHERE id = ?').get(d.area_id);
  if (!area || area.project_id !== d.project_id) fail('Pool / area does not belong to this project');
  if (d.alternate_id) {
    const alt = db.prepare('SELECT project_id FROM alternates WHERE id = ?').get(d.alternate_id);
    if (!alt || alt.project_id !== d.project_id) fail('Alternate does not belong to this project');
  }
}

/**
 * Insert a component. Description, unit, cost type and unit cost are SNAPSHOTS: anything not
 * given is copied from the database item now, so later database edits never change this estimate.
 */
function insComponent(db, c) {
  const it = db.prepare('SELECT description, unit, cost_type, unit_cost FROM items WHERE id = ?').get(c.item_id);
  if (!it) fail('Database item not found', 404);
  return db.prepare(`INSERT INTO estimate_components
    (estimate_item_id, item_id, assembly_item_id, label, formula, waste_pct, qty, unit_cost, unit, cost_type, excluded, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.estimate_item_id, c.item_id, c.assembly_item_id ?? null, c.label ?? it.description, c.formula ?? '1', c.waste_pct ?? 0,
      c.qty ?? null, c.unit_cost ?? it.unit_cost, c.unit || it.unit, c.cost_type || it.cost_type, c.excluded ? 1 : 0, c.sort ?? 0).lastInsertRowid;
}

/** Next free "BI-001"-style bid item number in a project. */
function nextBidItemNo(db, projectId) {
  const nums = db.prepare("SELECT bid_item_no FROM estimate_items WHERE project_id = ? AND bid_item_no LIKE 'BI-%'").all(projectId)
    .map((r) => Number(/^BI-(\d+)$/i.exec(r.bid_item_no)?.[1])).filter(Number.isFinite);
  return `BI-${String(Math.max(0, ...nums) + 1).padStart(3, '0')}`;
}

/** An EMPTY parent bid item at the bottom of the worksheet: no components, base price $0.00. */
/** An EMPTY parent bid item at the bottom of the chosen section: no components, base price $0.00. */
function createBlankItem(db, projectId, { section_id, area_id, name = '' } = {}) {
  if (!section_id) fail('Choose a section for the new bid item (or add a section first)');
  const area = area_id || db.prepare('SELECT id FROM areas WHERE project_id = ? ORDER BY sort, id LIMIT 1').get(projectId)?.id;
  if (!area) fail('Add a pool / area to the project first');
  checkOwnership(db, { project_id: projectId, section_id, area_id: area });
  const sort = maxSort(db, 'SELECT MAX(sort) m FROM estimate_items WHERE section_id = ?', section_id) + 1;
  return Number(db.prepare(`INSERT INTO estimate_items (project_id, section_id, item_sequence, area_id, name, qty, unit, sort) VALUES (?,?,?,?,?,1,'LS',?)`)
    .run(projectId, section_id, nextSequence(db, section_id), area, name, sort).lastInsertRowid);
}

/** Copy an assembly's lines into an estimate item as components. */
function copyAssembly(db, estimateItemId, assemblyId) {
  const rows = db.prepare(`SELECT s.*, i.description AS item_description, i.unit_cost FROM assembly_items s
                           JOIN items i ON i.id = s.item_id WHERE s.assembly_id = ? ORDER BY s.sort, s.id`).all(assemblyId);
  rows.forEach((s, i) => insComponent(db, { estimate_item_id: estimateItemId, item_id: s.item_id, assembly_item_id: s.id,
    label: s.label || s.item_description, formula: s.formula, waste_pct: s.waste_pct, unit_cost: s.unit_cost, sort: i }));
  return rows.length;
}

/**
 * Add a bid item to the estimate.
 * d: { project_id, section_id, area_id, alternate_id?, assembly_id | item_id, name?, description?, qty?, unit?, unit_price?, notes? }
 */
function addEstimateItem(db, d) {
  checkOwnership(db, d);
  const sort = d.sort ?? maxSort(db, 'SELECT MAX(sort) m FROM estimate_items WHERE section_id = ?', d.section_id) + 1;
  // Base bid items get the next number in their section; items priced inside an alternate don't take one
  const seq = d.alternate_id ? null : nextSequence(db, d.section_id);
  const ins0 = db.prepare(`INSERT INTO estimate_items (project_id, section_id, area_id, alternate_id, assembly_id, bid_item_no, name, description,
    notes, qty, unit, unit_price, sort, item_sequence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ins = { run: (...a) => ins0.run(...a, seq) };
  const num = (v, dflt) => (v === '' || v == null ? dflt : Number(v));
  if (d.assembly_id) {
    const a = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(d.assembly_id); if (!a) fail('Assembly not found', 404);
    const id = Number(ins.run(d.project_id, d.section_id, d.area_id, d.alternate_id || null, a.id, a.code, d.name || a.name,
      d.description ?? a.description, d.notes ?? null, num(d.qty, 1), d.unit || a.unit || 'LS', num(d.unit_price, null), sort).lastInsertRowid);
    copyAssembly(db, id, a.id);
    return id;
  }
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(d.item_id); if (!it) fail('Item not found', 404);
  const id = Number(ins.run(d.project_id, d.section_id, d.area_id, d.alternate_id || null, null, it.item_code, d.name || it.description,
    d.description ?? null, d.notes ?? null, num(d.qty, 0), d.unit || it.unit, null, sort).lastInsertRowid);
  insComponent(db, { estimate_item_id: id, item_id: it.id, label: it.description, formula: '1', unit_cost: num(d.unit_price, it.unit_cost) });
  return id;
}

/** True when the estimate item is a single database item (its unit price IS the component price). */
function isSimple(db, itemId) {
  const e = db.prepare('SELECT assembly_id FROM estimate_items WHERE id = ?').get(itemId);
  const comps = db.prepare('SELECT id, formula, qty, waste_pct FROM estimate_components WHERE estimate_item_id = ?').all(itemId);
  return e && !e.assembly_id && comps.length === 1 && comps[0].formula.trim() === '1' && comps[0].qty == null && !comps[0].waste_pct ? comps[0].id : null;
}

/**
 * Re-copy prices (and, for assembly items, formulas and lines) from the database.
 * Explicit overrides on components (qty, exclusion) are kept.
 */
function refreshFromDatabase(db, itemId) {
  const e = db.prepare('SELECT * FROM estimate_items WHERE id = ?').get(itemId); if (!e) fail('Not found', 404);
  let changed = 0;
  const comps = db.prepare('SELECT c.*, i.unit_cost AS db_cost, i.unit AS db_unit, i.description AS item_description FROM estimate_components c JOIN items i ON i.id = c.item_id WHERE c.estimate_item_id = ?').all(itemId);
  const upd = db.prepare('UPDATE estimate_components SET unit_cost = ?, formula = ?, waste_pct = ?, label = ? WHERE id = ?');
  const updUnit = db.prepare('UPDATE estimate_components SET unit = ? WHERE id = ?'); // cost type is the estimator's choice; left as is
  const master = e.assembly_id ? new Map(db.prepare('SELECT * FROM assembly_items WHERE assembly_id = ?').all(e.assembly_id).map((s) => [s.id, s])) : new Map();
  for (const c of comps) {
    const s = c.assembly_item_id ? master.get(c.assembly_item_id) : null;
    if (c.assembly_item_id && e.assembly_id && !s) { db.prepare('DELETE FROM estimate_components WHERE id = ?').run(c.id); changed++; continue; }
    const next = s ? [c.db_cost, s.formula, s.waste_pct, s.label || c.item_description] : [c.db_cost, c.formula, c.waste_pct, c.label];
    if (next[0] !== c.unit_cost || next[1] !== c.formula || next[2] !== c.waste_pct || next[3] !== c.label) { upd.run(...next, c.id); changed++; }
    if (c.unit !== c.db_unit) updUnit.run(c.db_unit, c.id);
    if (s) master.delete(s.id);
  }
  if (e.assembly_id) {
    // Lines added to the assembly since this item was copied
    for (const s of master.values()) {
      const it = db.prepare('SELECT description, unit_cost FROM items WHERE id = ?').get(s.item_id);
      insComponent(db, { estimate_item_id: itemId, item_id: s.item_id, assembly_item_id: s.id, label: s.label || it.description,
        formula: s.formula, waste_pct: s.waste_pct, unit_cost: it.unit_cost, sort: s.sort });
      changed++;
    }
  }
  return changed;
}

module.exports = { DEFAULT_SECTIONS, EstimateError, createSection, defaultSection, nextSequence, addEstimateItem, createBlankItem, nextBidItemNo, copyAssembly, insComponent, isSimple, refreshFromDatabase };
