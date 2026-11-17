// Estimate calculation engine. Pure reads from the DB → computed estimate.
//
// All money is integer cents (see money.js). Every component of every estimate item
// becomes an "atom" carrying its direct cost; markups are calculated once per bid group
// and then allocated to atoms (largest remainder), so every rollup — section, pool,
// cost code, division, SOV line — adds up to the bid total exactly.
const { evaluate } = require('./formula');
const { divisionOf } = require('./csi');
const M = require('./money');

const TYPES = M.TYPES;
const TYPE_NAMES = { L: 'Labor', M: 'Material', E: 'Equipment', S: 'Subcontractor', O: 'Other' };
const ALT_STATUSES = ['proposed', 'pending', 'accepted', 'rejected', 'excluded'];
const zero = () => Object.fromEntries(TYPES.map((t) => [t, 0]));
const $ = M.dollars;
const toDollars = (b) => Object.fromEntries(TYPES.map((t) => [t, $(b[t])]));

/** Resolve variable values for an area: area value → project value → default. */
function variableContext(db, projectId) {
  const vars = db.prepare('SELECT * FROM variables ORDER BY sort, name').all();
  const vals = db.prepare('SELECT area_id, variable_id, value FROM var_values WHERE project_id = ?').all(projectId);
  const byArea = new Map();
  for (const v of vals) {
    if (!byArea.has(v.area_id)) byArea.set(v.area_id, new Map());
    byArea.get(v.area_id).set(v.variable_id, v.value);
  }
  return (areaId) => {
    const out = {};
    const proj = byArea.get(0) || new Map();
    const area = byArea.get(areaId) || new Map();
    for (const v of vars) {
      let val = v.default_value;
      if (proj.has(v.id)) val = proj.get(v.id);
      if (v.scope === 'area' && area.has(v.id)) val = area.get(v.id);
      out[v.name.toUpperCase()] = val;
    }
    return out;
  };
}

/** Markup chain on {L,M,S,O} dollars → dollars (kept for callers that work in dollars). */
function applyMarkups(costs, markups) {
  const b = zero(); for (const t of TYPES) b[t] = M.cents(costs[t] || 0);
  const r = M.markupChain(b, markups);
  return { direct: $(r.direct), markups: r.markups.map((m) => ({ ...m, amount: $(m.amount), base: $(m.base) })), total: $(r.total) };
}

/** Allocate a group's markups onto its atoms (sets atom.markup, atom.sell). Returns the chain in cents. */
function allocateMarkups(atoms, markups) {
  const buckets = zero();
  for (const a of atoms) buckets[a.cost_type] += a.direct;
  const chain = M.markupChain(buckets, markups);
  const running = atoms.map((a) => a.direct);
  for (const a of atoms) a.markup = 0;
  chain.markups.forEach((m) => {
    const weights = atoms.map((a, i) => (TYPES.includes(m.basis) ? (a.cost_type === m.basis ? a.direct : 0) : m.basis === 'direct' ? a.direct : running[i]));
    M.allocate(m.amount, weights).forEach((amt, i) => { atoms[i].markup += amt; running[i] += amt; });
  });
  for (const a of atoms) a.sell = a.direct + a.markup;
  return chain;
}

const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

/**
 * The cost code shown on a worksheet row: the one carrying most of the item's cost
 * (an assembly can span several, e.g. shotcrete, rebar and excavation). All codes are listed too.
 */
function primaryCostCode(comps) {
  const by = new Map();
  for (const c of comps) {
    if (!c.cost_code_id) continue;
    const r = by.get(c.cost_code_id) || { code: c.cost_code, name: c.cost_code_name, cents: 0 };
    if (!c.excluded) r.cents += Math.abs(c.ext_cents);
    by.set(c.cost_code_id, r);
  }
  const list = [...by.values()].sort((a, b) => b.cents - a.cents);
  return { cost_code: list[0]?.code ?? null, cost_code_name: list[0]?.name ?? null, cost_codes: list.map((r) => ({ code: r.code, name: r.name, amount: $(r.cents) })) };
}

function buildEstimate(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const areas = db.prepare('SELECT * FROM areas WHERE project_id = ? ORDER BY sort, id').all(projectId);
  const markups = db.prepare('SELECT * FROM markups WHERE project_id = ? ORDER BY sort, id').all(projectId);
  const sectionRows = db.prepare('SELECT * FROM estimate_sections WHERE project_id = ? ORDER BY sort, id').all(projectId);
  const altRows = db.prepare('SELECT * FROM alternates WHERE project_id = ? ORDER BY sort, id').all(projectId);
  const itemRows = db.prepare(`SELECT e.*, a.name AS assembly_name FROM estimate_items e LEFT JOIN assemblies a ON a.id = e.assembly_id
                               WHERE e.project_id = ? AND e.deleted_at IS NULL ORDER BY e.sort, e.id`).all(projectId);
  // Unit and cost type come from the component's snapshot (falling back to the item for safety)
  const compRows = db.prepare(`SELECT c.id, c.estimate_item_id, c.item_id, c.assembly_item_id, c.label, c.formula, c.waste_pct, c.qty, c.unit_cost, c.excluded, c.sort,
                                 COALESCE(c.unit, i.unit) AS unit, COALESCE(c.cost_type, i.cost_type) AS cost_type,
                                 i.item_code, i.description AS item_description, i.unit_cost AS db_unit_cost,
                                 i.cost_code_id, cc.code AS cost_code, cc.name AS cost_code_name, cc.sort AS cost_code_sort
                               FROM estimate_components c JOIN estimate_items e ON e.id = c.estimate_item_id
                               JOIN items i ON i.id = c.item_id LEFT JOIN cost_codes cc ON cc.id = i.cost_code_id
                               WHERE e.project_id = ? AND e.deleted_at IS NULL ORDER BY c.sort, c.id`).all(projectId);
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const varsFor = variableContext(db, projectId);
  const compsByItem = new Map();
  for (const c of compRows) { if (!compsByItem.has(c.estimate_item_id)) compsByItem.set(c.estimate_item_id, []); compsByItem.get(c.estimate_item_id).push(c); }

  const atoms = [];
  const warnings = [];
  const codeInfo = (c) => ({
    cost_code_id: c?.cost_code_id ?? null, cost_code: c?.cost_code || 'UNCODED', cost_code_name: c?.cost_code_name || 'No cost code', cost_code_sort: c?.cost_code_sort ?? 9999,
  });

  // ---- Estimate items and their components
  const items = itemRows.map((e) => {
    const area = areaById.get(e.area_id);
    const ctx = varsFor(e.area_id);
    const comps = (compsByItem.get(e.id) || []).map((c) => {
      const res = evaluate(c.formula, ctx);
      const calcQty = res.value * (1 + (c.waste_pct || 0));
      const qty = c.qty != null ? c.qty : calcQty;
      const ext = c.excluded ? 0 : M.ext(qty, c.unit_cost);
      if (!e.excluded && !c.excluded) {
        if (res.error) warnings.push(`${area?.tag} · ${e.name} › ${c.label}: formula error – ${res.error}`);
        if (res.missing.length) warnings.push(`${area?.tag} · ${e.name} › ${c.label}: unknown variable(s) ${res.missing.join(', ')}`);
        if (!c.cost_code_id) warnings.push(`${area?.tag} · ${e.name} › ${c.label}: item has no cost code`);
      }
      return {
        id: c.id, item_id: c.item_id, item_code: c.item_code, label: c.label || c.item_description, unit: c.unit, cost_type: c.cost_type,
        ...codeInfo(c), formula: c.formula, waste_pct: c.waste_pct, calc_qty: calcQty, qty, qty_overridden: c.qty != null,
        unit_cost: c.unit_cost, db_unit_cost: c.db_unit_cost, price_changed: Math.abs(c.unit_cost - c.db_unit_cost) > 1e-9,
        excluded: !!c.excluded, ext_cents: ext, formula_error: res.error, missing_vars: res.missing, assembly_item_id: c.assembly_item_id,
      };
    });
    const builtCents = sum(comps, (c) => c.ext_cents); // per 1 unit of the estimate item
    const unitCents = e.unit_price != null ? M.cents(e.unit_price) : builtCents;
    let directCents = e.total_override != null ? M.cents(e.total_override) : M.extCents(e.qty, unitCents);
    if (e.excluded) directCents = 0;

    // Spread the item's cost over its components (exact when nothing is overridden)
    const live = comps.filter((c) => !c.excluded && c.ext_cents !== 0);
    const parts = live.length ? M.allocate(directCents, live.map((c) => c.ext_cents)) : [directCents];
    const owners = live.length ? live : [comps[0] || null];
    const adjusted = e.unit_price != null || e.total_override != null;
    owners.forEach((c, i) => {
      if (!parts[i] && !c) return;
      atoms.push({
        item_id: e.id, component_id: c?.id ?? null, area_id: e.area_id, area_tag: area?.tag, area_name: area?.name,
        alternate_id: e.alternate_id, section_id: e.section_id, cost_type: c?.cost_type || 'S', ...codeInfo(c),
        item_code: c?.item_code || e.bid_item_no, description: c?.label || e.name, unit: c?.unit || e.unit,
        qty: c ? c.qty * e.qty : e.qty, calc_qty: c ? c.calc_qty * e.qty : e.qty, unit_cost: c ? c.unit_cost : $(unitCents),
        direct: parts[i], adjusted, estimate_item: e.name,
      });
    });

    return {
      id: e.id, section_id: e.section_id, area_id: e.area_id, area_tag: area?.tag, area_name: area?.name, alternate_id: e.alternate_id,
      assembly_id: e.assembly_id, assembly_name: e.assembly_name, source: e.assembly_id ? 'assembly' : comps.length === 1 ? 'item' : 'custom',
      bid_item_no: e.bid_item_no, name: e.name, description: e.description, notes: e.notes, qty: e.qty, unit: e.unit,
      unit_price: $(unitCents), built_unit_price: $(builtCents), unit_price_overridden: e.unit_price != null,
      total_overridden: e.total_override != null, excluded: !!e.excluded, direct: $(directCents), direct_cents: directCents,
      simple: !e.assembly_id && comps.length === 1 && comps[0].formula.trim() === '1' && !comps[0].qty_overridden && !comps[0].waste_pct,
      price_changes: comps.filter((c) => c.price_changed).length, sort: e.sort, item_sequence: e.item_sequence, updated_at: e.updated_at,
      ...primaryCostCode(comps),
      components: comps.map((c) => ({ ...c, ext: $(c.ext_cents) })),
    };
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  // ---- Base bid: markups allocated over base atoms
  const baseAtoms = atoms.filter((a) => !a.alternate_id);
  const baseChain = allocateMarkups(baseAtoms, markups);
  const sellOfItem = new Map();
  for (const a of baseAtoms) sellOfItem.set(a.item_id, (sellOfItem.get(a.item_id) || 0) + a.sell);
  for (const it of items) if (!it.alternate_id) { it.sell_cents = sellOfItem.get(it.id) || 0; it.sell = $(it.sell_cents); }

  const groupFor = (key, name, alternate, groupAtoms, chain) => {
    const costs = zero(); for (const a of groupAtoms) costs[a.cost_type] += a.direct;
    return {
      key, name, alternate, costs: toDollars(costs), direct: $(chain.direct), total: $(chain.total), line_count: groupAtoms.length,
      markups: chain.markups.map((m) => ({ id: m.id, name: m.name, percent: m.percent, basis: m.basis, amount: $(m.amount) })),
      areas: areas.map((ar) => {
        const own = groupAtoms.filter((a) => a.area_id === ar.id); const c = zero(); for (const a of own) c[a.cost_type] += a.direct;
        return { area_id: ar.id, tag: ar.tag, name: ar.name, costs: toDollars(c), direct: $(sum(own, (a) => a.direct)), total: $(sum(own, (a) => a.sell)) };
      }),
    };
  };
  const base = groupFor('BASE', 'Base Bid', null, baseAtoms, baseChain);

  // ---- Alternates / VE register
  const groups = [base];
  const alternates = altRows.map((alt) => {
    const altAtoms = atoms.filter((a) => a.alternate_id === alt.id).map((a) => ({ ...a }));
    if (alt.unit_price != null) {
      altAtoms.push({ item_id: null, area_id: null, alternate_id: alt.id, cost_type: alt.cost_type || 'S', ...codeInfo(null), item_code: alt.bid_item_no,
        description: alt.name, unit: alt.unit, qty: alt.qty ?? 1, unit_cost: alt.unit_price, direct: M.ext(alt.qty ?? 1, alt.unit_price) });
    }
    const target = alt.item_id ? itemById.get(alt.item_id) : null;
    const replaced = alt.replaces && target && !target.alternate_id ? baseAtoms.filter((a) => a.item_id === target.id) : [];
    const altDirect = sum(altAtoms, (a) => a.direct);
    const origDirect = sum(replaced, (a) => a.direct);
    const origSell = sum(replaced, (a) => a.sell);
    // Net change to the price: replacement = alternate − original; otherwise add (+) or deduct (−) the alternate's price
    const sign = replaced.length || alt.kind === 'add' ? 1 : -1;
    const netAtoms = [...altAtoms.map((a) => ({ ...a, direct: sign * a.direct })), ...replaced.map((a) => ({ ...a, direct: -a.direct }))];
    const chain = allocateMarkups(netAtoms, markups);
    const status = ALT_STATUSES.includes(alt.status) ? alt.status : 'proposed';
    const r = {
      ...alt, status, replaces: !!alt.replaces, included: status === 'accepted', open: status === 'proposed' || status === 'pending',
      item_name: target?.name ?? null, item_number: null, detail_count: altAtoms.filter((a) => a.item_id).length,
      alt_direct: $(altDirect), original_direct: $(origDirect), net_direct: $(chain.direct),
      original_sell: $(origSell), net_sell: $(chain.total), alt_sell: $(chain.total + (replaced.length ? origSell : 0)),
      net_direct_cents: chain.direct, net_sell_cents: chain.total,
      extended: alt.unit_price != null ? $(M.ext(alt.qty ?? 1, alt.unit_price)) : null,
    };
    if (!replaced.length && sign < 0) r.alt_sell = $(-chain.total);
    groups.push(groupFor(`ALT${alt.id}`, `${alt.tag} – ${alt.name}`, r, netAtoms, chain));
    return r;
  });

  // ---- Sections (level 1) and bid item numbers. A bid item's number is the text
  // "<section number>.<item sequence>", both stored as separate integers.
  const sections = sectionRows.map((s) => {
    const own = items.filter((i) => i.section_id === s.id && !i.alternate_id);
    own.forEach((it) => { it.number = it.item_sequence != null ? `${s.number}.${it.item_sequence}` : `${s.number}.?`; });
    const alts = alternates.filter((a) => a.section_id === s.id);
    const accepted = alts.filter((a) => a.included);
    return {
      id: s.id, name: s.name, sort: s.sort, number: s.number, item_ids: own.map((i) => i.id), alternate_ids: alts.map((a) => a.id),
      direct: $(sum(own, (i) => i.direct_cents)), sell: $(sum(own, (i) => i.sell_cents || 0)),
      alt_direct: $(sum(accepted, (a) => a.net_direct_cents)), alt_sell: $(sum(accepted, (a) => a.net_sell_cents)),
    };
  });
  const order = sections.flatMap((s) => s.item_ids); // flat worksheet order of base bid items
  for (const a of alternates) a.item_number = a.item_id ? itemById.get(a.item_id)?.number ?? null : null;
  for (const it of items) if (it.alternate_id) it.number = alternates.find((a) => a.id === it.alternate_id)?.tag;

  // ---- Cost code × area grid (base bid)
  const codeMap = new Map();
  for (const a of baseAtoms) {
    const k = a.cost_code_id ?? 0;
    if (!codeMap.has(k)) codeMap.set(k, { cost_code_id: a.cost_code_id, code: a.cost_code, name: a.cost_code_name, sort: a.cost_code_sort, atoms: [] });
    codeMap.get(k).atoms.push(a);
  }
  const grid = [...codeMap.values()]
    .sort((a, b) => a.sort - b.sort || String(a.code).localeCompare(String(b.code)))
    .map((row) => {
      const cells = {};
      for (const ar of areas) {
        const own = row.atoms.filter((a) => a.area_id === ar.id);
        cells[ar.id] = { direct: $(sum(own, (a) => a.direct)), total: $(sum(own, (a) => a.sell)) };
      }
      const costs = zero(); for (const a of row.atoms) costs[a.cost_type] += a.direct;
      const div = divisionOf(row.cost_code_id ? row.code : null);
      return { cost_code_id: row.cost_code_id, code: row.code, name: row.name, division: div.division, division_name: div.name,
        costs: toDollars(costs), cells, direct: $(sum(row.atoms, (a) => a.direct)), total: $(sum(row.atoms, (a) => a.sell)), atoms: row.atoms };
    });

  // ---- CSI division rollup
  const divMap = new Map();
  for (const row of grid) {
    if (!divMap.has(row.division)) {
      divMap.set(row.division, { division: row.division, name: row.division_name, codes: [], atoms: [] });
    }
    const d = divMap.get(row.division); d.codes.push(row.code); d.atoms.push(...row.atoms);
  }
  const divisions = [...divMap.values()]
    .sort((a, b) => (a.division === '—') - (b.division === '—') || a.division.localeCompare(b.division))
    .map((d) => ({
      division: d.division, name: d.name, codes: d.codes, direct: $(sum(d.atoms, (a) => a.direct)), total: $(sum(d.atoms, (a) => a.sell)),
      cells: Object.fromEntries(areas.map((ar) => {
        const own = d.atoms.filter((a) => a.area_id === ar.id);
        return [ar.id, { direct: $(sum(own, (a) => a.direct)), total: $(sum(own, (a) => a.sell)) }];
      })),
    }));

  // ---- Schedule of values (base bid): one row per area × cost code
  const sov = [];
  for (const ar of areas) {
    for (const row of grid) {
      const own = row.atoms.filter((a) => a.area_id === ar.id);
      if (!own.length) continue;
      const value = sum(own, (a) => a.sell);
      if (value === 0) continue;
      sov.push({ area_id: ar.id, area_tag: ar.tag, area_name: ar.name, cost_code: row.code, division: row.division, division_name: row.division_name,
        job_cost_code: `${row.code}-${ar.tag}`, description: row.name, direct: $(sum(own, (a) => a.direct)), value: $(value) });
    }
  }
  for (const row of grid) delete row.atoms;

  // ---- Totals (cents first, then dollars)
  const pick = (f) => alternates.filter(f);
  const acceptedDeducts = pick((a) => a.included && a.net_sell_cents < 0);
  const acceptedAdds = pick((a) => a.included && a.net_sell_cents >= 0);
  const open = pick((a) => a.open);
  const t = {
    base_direct: baseChain.direct, base_sell: baseChain.total,
    ve_direct: sum(acceptedDeducts, (a) => a.net_direct_cents), ve_sell: sum(acceptedDeducts, (a) => a.net_sell_cents),
    add_direct: sum(acceptedAdds, (a) => a.net_direct_cents), add_sell: sum(acceptedAdds, (a) => a.net_sell_cents),
    optional_direct: sum(open, (a) => a.net_direct_cents), optional_sell: sum(open, (a) => a.net_sell_cents),
  };
  t.grand_direct = t.base_direct + t.ve_direct + t.add_direct;
  t.grand_sell = t.base_sell + t.ve_sell + t.add_sell;
  const totals = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, $(v)]));
  totals.counts = Object.fromEntries(ALT_STATUSES.map((s) => [s, alternates.filter((a) => a.status === s).length]));

  // Flat component lines (Detail export)
  const lines = atoms.map((a) => ({ ...a, total: $(a.direct), job_cost_code: a.area_tag ? `${a.cost_code}-${a.area_tag}` : a.cost_code,
    alternate_tag: a.alternate_id ? altRows.find((x) => x.id === a.alternate_id)?.tag : null,
    item_number: itemById.get(a.item_id)?.number, section_name: sectionRows.find((s) => s.id === a.section_id)?.name }));

  for (const it of items) delete it.direct_cents;
  for (const a of alternates) { delete a.net_direct_cents; delete a.net_sell_cents; }

  return {
    project, areas, markups, sections, order, items, alternates, groups, base, grid, divisions, sov, totals, lines,
    warnings: [...new Set(warnings)], type_names: TYPE_NAMES, alt_statuses: ALT_STATUSES,
  };
}

module.exports = { buildEstimate, applyMarkups, variableContext, TYPES, TYPE_NAMES, ALT_STATUSES };
