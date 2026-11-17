const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, validate, variablesIn } = require('../formula');
const { applyMarkups, buildEstimate } = require('../calc');
const { open } = require('../db');
const { seed } = require('../seed');
const { createApp } = require('../app');
const { normalizeCode, LEGACY_DIVISIONS } = require('../csi');
const { migrate } = require('../migrate-csi');
const { migrateLegacyEstimates } = require('../migrate');
const M = require('../money');

const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
const cents = (list, f) => list.reduce((s, x) => s + M.cents(f(x)), 0);
function freshDb() { const db = open(':memory:'); seed(db); return db; }

test('formula: arithmetic, precedence, functions', () => {
  near(evaluate('(8/12)*3200/27').value, 79.0123, 0.001);
  assert.equal(evaluate('2+3*4').value, 14);
  assert.equal(evaluate('-2^2').value, -4);
  assert.equal(evaluate('ROUNDUP(6.01,0)').value, 7);
  assert.equal(evaluate('ROUNDUP(7,0)').value, 7);
  assert.equal(evaluate('ROUNDUP(1.231,2)').value, 1.24);
  assert.equal(evaluate('ROUNDDOWN(1.239,2)').value, 1.23);
  assert.equal(evaluate('IF(X=12, 5, 0)', { X: 12 }).value, 5);
  assert.equal(evaluate('IF(X = 12, 5, 0)', { X: 14 }).value, 0);
  assert.equal(evaluate('IF(AND(X>17,X<24),1,0)', { X: 18 }).value, 1);
  assert.equal(evaluate('IF(OR(X<1,X>5),1,0)', { X: 3 }).value, 0);
  assert.equal(evaluate('x<>3', { X: 4 }).value, 1);
  assert.equal(evaluate('10/0').value, 0);
});

test('formula: missing variables, errors, no code execution', () => {
  const r = evaluate('A + B', { A: 1 });
  assert.equal(r.value, 1); assert.deepEqual(r.missing, ['B']);
  assert.ok(evaluate('(1+2').error);
  assert.ok(evaluate('FOO(1)').error);
  assert.ok(validate('process.exit()'));
  assert.ok(validate('constructor["x"]'));
  assert.deepEqual(variablesIn('IF(MC_A>0, mc_b*2, 0)').sort(), ['MC_A', 'MC_B']);
});

test('money: exact decimal arithmetic and allocation', () => {
  assert.equal(0.1 + 0.2 === 0.3, false); // the float problem this avoids
  assert.equal(M.cents(0.1) + M.cents(0.2), M.cents(0.3));
  assert.equal(M.cents(1.005), 101); // half away from zero, no 1.00499999 surprise
  assert.equal(M.ext(3, 19.99), 5997);
  assert.equal(M.ext(1234.5678, 9.87), 1218518); // 12,185.184186 → $12,185.18
  assert.equal(M.ext(2.5, 0.01), 3); // 0.025 → $0.03 (half away from zero)
  assert.equal(M.ext(-2, 10.005), -2001);
  assert.equal(M.pct(10000, 0.0825), 825);
  assert.deepEqual(M.allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(M.allocate(-100, [1, 1, 1]).reduce((a, b) => a + b), -100);
  assert.deepEqual(M.allocate(1000, [0, 0]), [1000, 0]);
  const parts = M.allocate(123457, [333, 333, 334, 1, 0]);
  assert.equal(parts.reduce((a, b) => a + b), 123457);
});

test('markups: chain in cents', () => {
  const mk = [{ name: 'Tax', percent: 0.0825, basis: 'M' }, { name: 'OH', percent: 0.1, basis: 'running' }, { name: 'P', percent: 0.1, basis: 'running' }];
  // 300 direct + 16.50 tax = 316.50 → +31.65 → +34.82 = 382.97
  assert.equal(applyMarkups({ L: 100, M: 200, S: 0, O: 0 }, mk).total, 382.97);
});

test('estimate: sections, pools, cost codes and SOV all tie to the penny', () => {
  const e = buildEstimate(freshDb(), 1);
  assert.equal(e.warnings.length, 0, e.warnings.join('\n'));
  const base = M.cents(e.totals.base_sell);
  assert.equal(base, M.cents(e.base.total));
  assert.equal(cents(e.sections, (s) => s.sell), base);
  assert.equal(cents(e.sov, (r) => r.value), base);
  assert.equal(cents(e.grid, (r) => r.total), base);
  assert.equal(cents(e.divisions, (d) => d.total), base);
  assert.equal(cents(e.base.areas, (a) => a.total), base);
  assert.equal(cents(e.items.filter((i) => !i.alternate_id), (i) => i.sell), base);
  assert.equal(cents(e.items.filter((i) => !i.alternate_id), (i) => i.direct), M.cents(e.totals.base_direct));
  // Two pools share cost codes, tracked separately
  const shotcrete = e.grid.find((r) => r.code === '03 37 13');
  const [p1, p2] = e.areas;
  assert.ok(shotcrete.cells[p1.id].total > 0 && shotcrete.cells[p2.id].total > 0);
  const jc = new Set(e.lines.filter((l) => l.cost_code === '03 37 13').map((l) => l.job_cost_code));
  assert.ok(jc.has('03 37 13-P1') && jc.has('03 37 13-P2'));
  // Alternate-priced items never land in the base bid
  assert.ok(!e.lines.filter((l) => !l.alternate_id).some((l) => l.description.includes('Over Excavation')));
  // Numbering
  // Section-based numbering: <section number>.<sequence>, each section starting at .1
  for (const sec of e.sections) assert.deepEqual(sec.item_ids.map((id) => e.items.find((i) => i.id === id).number), sec.item_ids.map((_, k) => `${sec.number}.${k + 1}`));
  assert.equal(e.order.length, e.items.filter((i) => !i.alternate_id).length);
  assert.equal(e.items.find((i) => i.name === 'Pool Structure – Activity Pool').number, '2.2');
});

test('estimate: known quantities from MC formulas', () => {
  const e = buildEstimate(freshDb(), 1);
  const comp = (item, label) => e.items.find((i) => i.name === item).components.find((c) => c.label === label);
  near(comp('Pool Structure – Main Pool', 'Shotcrete – Floor').calc_qty, (8 / 12) * 3200 / 27 * 1.1, 1e-9);
  assert.equal(comp('Pool Structure – Main Pool', 'Rebar Labor').qty, 7); // ROUNDUP(4280*.228*.668*20/2000) = ROUNDUP(6.52)
  assert.equal(comp('Pool Structure – Main Pool', 'Rebar #4 Pieces').qty, 1050);
  assert.equal(comp('Interior Finish & Tile – Main Pool', 'Plaster – Quartz').qty, 4280); // plaster type 2 on P1
  assert.equal(comp('Interior Finish & Tile – Main Pool', 'Plaster – White').qty, 0);
  near(comp('Coping – Main Pool', 'Coping 16"').qty, 240 * 1.05, 1e-9);
});

test('alternates: VE replacement is a net difference; nothing affects the base until accepted', () => {
  const db = freshDb();
  const e = buildEstimate(db, 1);
  const ve = e.alternates.find((a) => a.tag === 'VE 1');
  const deck = e.items.find((i) => i.id === ve.item_id);
  assert.equal(deck.direct, 28840);
  assert.equal(ve.net_direct, 2800 * 8.75 - 28840); // −4,340: alternate minus original, not the whole alternate
  assert.equal(M.cents(ve.alt_sell) - M.cents(ve.original_sell), M.cents(ve.net_sell));
  assert.equal(e.totals.ve_sell, 0); // pending
  assert.equal(M.cents(e.totals.optional_sell), M.cents(ve.net_sell) + M.cents(e.alternates.find((a) => a.tag === 'ALT 1').net_sell));
  assert.equal(e.totals.grand_sell, e.totals.base_sell);

  db.prepare("UPDATE alternates SET status = 'accepted'").run();
  const a = buildEstimate(db, 1);
  assert.equal(a.totals.base_sell, e.totals.base_sell); // base never changes
  assert.ok(a.totals.ve_sell < 0 && a.totals.add_sell > 0);
  assert.equal(M.cents(a.totals.grand_sell), M.cents(a.totals.base_sell) + M.cents(a.totals.ve_sell) + M.cents(a.totals.add_sell));
  assert.equal(a.totals.optional_sell, 0);

  db.prepare("UPDATE alternates SET status = 'rejected'").run();
  const r = buildEstimate(db, 1);
  assert.equal(r.totals.grand_sell, r.totals.base_sell);
  assert.equal(r.totals.optional_sell, 0);
});

test('estimate items: overrides, exclusion and price snapshots', () => {
  const db = freshDb();
  const e0 = buildEstimate(db, 1);
  const pool = e0.items.find((i) => i.name === 'Pool Structure – Main Pool');
  // Lump-sum override: base cost becomes exactly that, spread over components
  db.prepare('UPDATE estimate_items SET total_override = 90000.01 WHERE id = ?').run(pool.id);
  let e = buildEstimate(db, 1);
  assert.equal(e.items.find((i) => i.id === pool.id).direct, 90000.01);
  assert.equal(cents(e.lines.filter((l) => l.item_id === pool.id), (l) => l.total), 9000001);
  assert.equal(cents(e.sections, (s) => s.sell), M.cents(e.totals.base_sell));
  // Qty multiplies the per-unit price
  db.prepare('UPDATE estimate_items SET total_override = NULL, qty = 2 WHERE id = ?').run(pool.id);
  e = buildEstimate(db, 1);
  assert.equal(M.cents(e.items.find((i) => i.id === pool.id).direct), 2 * M.cents(pool.direct));
  // Excluded items cost nothing
  db.prepare('UPDATE estimate_items SET excluded = 1 WHERE id = ?').run(pool.id);
  e = buildEstimate(db, 1);
  assert.equal(e.items.find((i) => i.id === pool.id).direct, 0);
  // Changing the master price does NOT change the estimate (snapshot) …
  db.prepare('UPDATE estimate_items SET excluded = 0, qty = 1 WHERE id = ?').run(pool.id);
  const before = buildEstimate(db, 1).totals.base_direct;
  db.prepare("UPDATE items SET unit_cost = unit_cost * 2 WHERE item_code = '06.0000.0010'").run();
  e = buildEstimate(db, 1);
  assert.equal(e.totals.base_direct, before);
  assert.ok(e.items.find((i) => i.id === pool.id).price_changes > 0); // … but the change is flagged
});

test('changing a cost code in the database updates every estimate output', () => {
  const db = freshDb();
  const before = buildEstimate(db, 1);
  db.prepare("UPDATE cost_codes SET code = '03 37 13.10' WHERE code = '03 37 13'").run();
  const after = buildEstimate(db, 1);
  assert.ok(after.grid.some((r) => r.code === '03 37 13.10'));
  assert.ok(!after.grid.some((r) => r.code === '03 37 13'));
  assert.ok(after.sov.some((r) => r.job_cost_code === '03 37 13.10-P1'));
  assert.equal(after.base.total, before.base.total);
});

test('variables: changing a pool takeoff re-prices only that pool', () => {
  const db = freshDb();
  const before = buildEstimate(db, 1);
  const [p1] = before.areas;
  const v = db.prepare("SELECT id FROM variables WHERE name='MC_POOL_WATER_SF'").get().id;
  db.prepare('UPDATE var_values SET value = 4000 WHERE project_id=1 AND area_id=? AND variable_id=?').run(p1.id, v);
  const after = buildEstimate(db, 1);
  assert.ok(after.base.areas[0].total > before.base.areas[0].total);
  // P2's own cost is untouched; its share of the (re-rounded) markups may move by at most a cent
  assert.equal(after.base.areas[1].direct, before.base.areas[1].direct);
  assert.ok(Math.abs(M.cents(after.base.areas[1].total) - M.cents(before.base.areas[1].total)) <= 1);
});

async function withServer(fn) {
  const db = freshDb();
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body, user = 'Test Estimator') => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-User': user }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
  };
  try { await fn(call, db); } finally { server.close(); }
}

test('API: estimator workflow — sections, add items, edit, components, undo', async () => withServer(async (call) => {
  const p = (await call('POST', '/projects', { name: 'Test Job', pool_count: 2 })).body;
  let e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  assert.deepEqual(e.areas.map((a) => a.tag), ['P1', 'P2', 'GEN']);
  assert.deepEqual(e.sections, []); // new projects start without sections
  const pool = (await call('POST', `/projects/${p.id}/sections`, { name: 'pool' })).body;
  assert.equal(pool.number, 1); assert.equal(pool.name, 'POOL');
  const [P1] = e.areas;

  const vars = (await call('GET', '/variables')).body;
  await call('PUT', `/projects/${p.id}/vars`, { area_id: P1.id, variable_id: vars.find((v) => v.name === 'MC_POOL_WATER_SF').id, value: 100 });

  const cat = (await call('GET', `/projects/${p.id}/catalog?area_id=${P1.id}`)).body.rows;
  const asm = cat.find((r) => r.kind === 'assembly' && r.name.startsWith('Pool On Grade'));
  const deck = cat.find((r) => r.kind === 'item' && r.bid_item_no === '14.0000.0020');
  assert.equal(asm.bid_item_no, '13 11 23.10');
  assert.ok(asm.components.length > 5 && asm.default_unit_price > 0);
  assert.ok(asm.components.some((c) => c.cost_code === '03 37 13')); // searchable by cost code
  assert.equal(deck.components[0].cost_code, '32 13 13');

  // Multi-select add: no section given → appended to the end of the list
  const added = (await call('POST', `/projects/${p.id}/estimate-items`, [
    { assembly_id: asm.id, section_id: pool.id, area_id: P1.id, name: 'Pool shell' },
    { item_id: deck.id, section_id: pool.id, area_id: P1.id, qty: 1000, unit_price: 9.5 },
  ])).body;
  assert.equal(added.ids.length, 2);
  e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  const shell = e.items.find((i) => i.id === added.ids[0]);
  const deckItem = e.items.find((i) => i.id === added.ids[1]);
  assert.equal(shell.number, '1.1');
  assert.equal(deckItem.number, '1.2');
  assert.deepEqual(e.order, added.ids);
  assert.equal(deckItem.direct, 9500);
  assert.equal(shell.components.find((c) => c.label === 'Layout').qty, 100);

  // Validation
  assert.equal((await call('POST', `/projects/${p.id}/estimate-items`, { item_id: deck.id, area_id: P1.id })).status, 400); // no section
  assert.equal((await call('PUT', `/estimate-items/${deckItem.id}`, { qty: 'abc' })).status, 400);
  assert.equal((await call('PUT', `/estimate-items/${deckItem.id}`, { name: '' })).status, 400);

  // Inline edits
  await call('PUT', `/estimate-items/${deckItem.id}`, { qty: 1200 });
  await call('PUT', `/estimate-items/${deckItem.id}`, { unit_price: 10 }); // simple item → component price
  e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  let d = e.items.find((i) => i.id === deckItem.id);
  assert.equal(d.direct, 12000); assert.equal(d.unit_price_overridden, false);
  await call('PUT', `/estimate-items/${shell.id}`, { total_override: 50000 });
  e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  assert.equal(e.items.find((i) => i.id === shell.id).direct, 50000);
  await call('PUT', `/estimate-items/${shell.id}`, { total_override: null });

  // Components: override qty, add, remove
  const layout = shell.components.find((c) => c.label === 'Layout');
  await call('PUT', `/components/${layout.id}`, { qty: 150 });
  const extra = (await call('POST', `/estimate-items/${shell.id}/components`, { item_id: deck.id, qty: 10 })).body;
  e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  const s2 = e.items.find((i) => i.id === shell.id);
  assert.equal(s2.components.find((c) => c.id === layout.id).qty, 150);
  assert.equal(s2.components.length, shell.components.length + 1);
  await call('DELETE', `/components/${extra.id}`);
  assert.equal((await call('PUT', `/components/${layout.id}`, { formula: '(1+' })).status, 400);

  // Delete is soft; restore undoes it
  await call('DELETE', `/estimate-items/${deckItem.id}`);
  e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  assert.ok(!e.items.some((i) => i.id === deckItem.id));
  await call('POST', `/estimate-items/${deckItem.id}/restore`);
  e = (await call('GET', `/projects/${p.id}/estimate`)).body;
  assert.ok(e.items.some((i) => i.id === deckItem.id));

  // Sections are internal now, but the API still refuses to delete a non-empty one
  assert.equal((await call('DELETE', `/sections/${pool.id}`)).status, 409);

  // Database items in use cannot be deleted
  assert.equal((await call('DELETE', `/items/${deck.id}`)).status, 409);
}));

test('API: alternates register, revisions and change log', async () => withServer(async (call) => {
  let e = (await call('GET', '/projects/1/estimate')).body;
  const deck = e.items.find((i) => i.bid_item_no === '14.0000.0010');
  const base = e.totals.base_sell;

  const ve = (await call('POST', '/projects/1/alternates', { kind: 'deduct', name: 'Delete deck', section_id: deck.section_id, item_id: deck.id, replaces: true, qty: 1, unit_price: 0 })).body;
  assert.equal(ve.tag, 'VE 2');
  const add = (await call('POST', '/projects/1/alternates', { kind: 'add', name: 'Tanning shelf lights', qty: 4, unit: 'EA', unit_price: 1250, cost_type: 'M' })).body;
  assert.equal(add.tag, 'ALT 2');
  assert.equal((await call('POST', '/projects/1/alternates', { kind: 'sideways', name: 'x' })).status, 400);
  assert.equal((await call('POST', '/projects/1/alternates', { kind: 'add', name: 'x', unit_price: -5 })).status, 400);
  assert.equal((await call('PUT', `/alternates/${add.id}`, { status: 'maybe' })).status, 400);

  e = (await call('GET', '/projects/1/estimate')).body;
  const v = e.alternates.find((a) => a.id === ve.id);
  assert.equal(v.net_direct, -deck.direct);
  assert.equal(e.alternates.find((a) => a.id === add.id).net_direct, 5000);
  assert.equal(e.totals.base_sell, base);

  // Revision 0, then accept both and issue Rev 1
  const r0 = (await call('POST', '/projects/1/revisions', { note: 'Bid day' })).body;
  assert.equal(r0.rev, 0); assert.equal(r0.created_by, 'Test Estimator');
  await call('PUT', `/alternates/${ve.id}`, { status: 'accepted' }, 'Pat Reviewer');
  await call('PUT', `/alternates/${add.id}`, { status: 'accepted' }, 'Pat Reviewer');
  await call('PUT', `/estimate-items/${deck.id}`, { qty: 3000 }, 'Pat Reviewer');
  let revs = (await call('GET', '/projects/1/revisions')).body;
  assert.ok(revs.working.dirty);
  assert.ok(revs.working.log.some((l) => l.user === 'Pat Reviewer' && l.action === 'alternate.edit'));
  assert.ok(revs.working.changes.items.some((i) => i.id === deck.id && i.fields.includes('qty')));
  const r1 = (await call('POST', '/projects/1/revisions', {})).body;
  assert.equal(r1.label, 'Rev 1');
  revs = (await call('GET', '/projects/1/revisions')).body;
  assert.equal(revs.revisions.length, 2);
  assert.equal(revs.working.dirty, false);
  assert.ok(revs.revisions[1].changes.alternates.some((a) => a.id === add.id && a.before.status === 'proposed'));

  e = (await call('GET', '/projects/1/estimate')).body;
  assert.equal(M.cents(e.totals.grand_sell), M.cents(e.totals.base_sell) + M.cents(e.totals.ve_sell) + M.cents(e.totals.add_sell));
  // Historical revision is frozen even after more edits
  await call('PUT', `/estimate-items/${deck.id}`, { qty: 1 });
  revs = (await call('GET', '/projects/1/revisions')).body;
  assert.notEqual(revs.revisions[1].totals.base_sell, (await call('GET', '/projects/1/estimate')).body.totals.base_sell);

  // Exports and duplicate still work
  assert.equal((await call('GET', '/projects/1/export/sov.xlsx')).status, 200);
  const x = await call('GET', '/projects/1/export/estimate.xlsx');
  assert.equal(x.status, 200); assert.ok(x.body.byteLength > 5000);
  const copy = (await call('POST', '/projects/1/duplicate')).body;
  const ce = (await call('GET', `/projects/${copy.id}/estimate`)).body;
  const oe = (await call('GET', '/projects/1/estimate')).body;
  assert.equal(ce.totals.grand_sell, oe.totals.grand_sell);
  assert.equal(ce.alternates.find((a) => a.name === 'Delete deck').item_name, deck.name);

  const imp = (await call('POST', '/import/items', { rows: [{ item_code: '99.0000.0010', description: 'Test item', unit: 'EA', cost_type: 'Labor', unit_cost: '$1,250.50', cost_code: '017123' },
    { item_code: '99.0000.0020', description: 'Excavator', unit: 'DAY', cost_type: 'Equipment', unit_cost: 900, cost_code: '312316' }] })).body;
  assert.equal(imp.added, 2);
  assert.equal((await call('GET', '/items')).body.find((i) => i.item_code === '99.0000.0020').cost_type, 'E');
  assert.equal((await call('POST', '/projects/1/alternates', { kind: 'add', name: 'Crane day', qty: 1, unit_price: 2400, cost_type: 'E' })).status, 200);
  assert.equal((await call('POST', '/projects/1/alternates', { kind: 'add', name: 'Bad', cost_type: 'X' })).status, 400);
  const it = (await call('GET', '/items')).body.find((i) => i.item_code === '99.0000.0010');
  assert.equal(it.cost_type, 'L'); assert.equal(it.unit_cost, 1250.5); assert.equal(it.cost_code, '01 71 23');
}));

test('migration: estimates in the old tables move to the worksheet with identical totals', () => {
  const db = open(':memory:'); seed(db);
  // Build an old-style project: assembly instances (+ an override) and a manual line
  const pid = db.prepare("INSERT INTO projects (name) VALUES ('Legacy job')").run().lastInsertRowid;
  const area = db.prepare("INSERT INTO areas (project_id, tag, name, sort) VALUES (?, 'P1', 'Lap Pool', 1)").run(pid).lastInsertRowid;
  const alt = db.prepare("INSERT INTO alternates (project_id, tag, name, kind) VALUES (?, 'ALT 1', 'Drainage', 'add')").run(pid).lastInsertRowid;
  db.prepare('INSERT INTO markups (project_id, name, percent, basis, sort) VALUES (?, ?, ?, ?, ?)').run(pid, 'OH', 0.1, 'running', 1);
  const sf = db.prepare("SELECT id FROM variables WHERE name='MC_POOL_WATER_SF'").get().id;
  db.prepare('INSERT INTO var_values VALUES (?,?,?,?)').run(pid, area, sf, 2000);
  const asm = (n) => db.prepare('SELECT id FROM assemblies WHERE name LIKE ?').get(`${n}%`).id;
  const inst = db.prepare('INSERT INTO assembly_instances (project_id, area_id, assembly_id, sort) VALUES (?,?,?,1)').run(pid, area, asm('Pool On Grade')).lastInsertRowid;
  db.prepare('INSERT INTO assembly_instances (project_id, area_id, assembly_id, alternate_id, sort) VALUES (?,?,?,?,2)').run(pid, area, asm('Structural Upgrade'), alt);
  const layout = db.prepare("SELECT s.id FROM assembly_items s WHERE s.label = 'Layout'").get().id;
  db.prepare('INSERT INTO instance_overrides VALUES (?,?,?,?,?)').run(inst, layout, 2500, 0.5, 0);
  const deck = db.prepare("SELECT id, unit_cost FROM items WHERE item_code = '14.0000.0020'").get();
  db.prepare('INSERT INTO lines (project_id, area_id, item_id, qty, unit_cost, sort) VALUES (?,?,?,?,?,1)').run(pid, area, deck.id, 500, 9);

  migrateLegacyEstimates(db);
  const e = buildEstimate(db, pid);
  assert.deepEqual(e.sections.map((s) => s.name), ['LAP POOL']);
  assert.equal(e.items.filter((i) => !i.alternate_id).length, 2);
  const l = e.items.find((i) => i.name.startsWith('Pool On Grade')).components.find((c) => c.label === 'Layout');
  assert.equal(l.qty, 2500); assert.equal(l.unit_cost, 0.5);
  assert.equal(e.items.find((i) => i.bid_item_no === '14.0000.0020').direct, 4500);
  assert.equal(e.alternates[0].section_id, e.sections[0].id);
  assert.equal(e.alternates[0].status, 'proposed');
  assert.ok(e.alternates[0].net_direct > 0);
  // Running it again changes nothing
  migrateLegacyEstimates(db);
  assert.equal(buildEstimate(db, pid).items.length, e.items.length);
});

test('equipment: E cost type in items, estimates, markups and import; old databases upgrade in place', () => {
  const fs = require('fs'), path = require('path'), Database = require('better-sqlite3');
  // A database created with the old four-type constraint
  const oldSchema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8')
    .replace("CHECK (cost_type IN ('L','M','E','S','O'))", "CHECK (cost_type IN ('L','M','S','O'))")
    .replace("CHECK (basis IN ('L','M','E','S','O','direct','running'))", "CHECK (basis IN ('L','M','S','O','direct','running'))");
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(oldSchema);
  db.exec("INSERT INTO cost_codes (id, code, name) VALUES (1, '03 37 13', 'Shotcrete')");
  db.exec("INSERT INTO items (id, item_code, description, unit, cost_type, unit_cost, cost_code_id) VALUES (7, 'X1', 'Pump', 'DAY', 'S', 1000, 1)");
  db.exec("INSERT INTO assemblies (id, name) VALUES (1, 'A'); INSERT INTO assembly_items (assembly_id, item_id, formula) VALUES (1, 7, '2')");
  db.exec("INSERT INTO projects (id, name) VALUES (1, 'P'); INSERT INTO markups (project_id, name, percent, basis) VALUES (1, 'OH', 0.1, 'running')");
  assert.throws(() => db.prepare("UPDATE items SET cost_type = 'E' WHERE id = 7").run(), /CHECK/); // old constraint
  require('../migrate').migrate(db);
  require('../migrate').migrate(db); // second run is a no-op
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'items'").get().sql, /'E'/);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'markups'").get().sql, /'E'/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_items_code'").get());
  assert.deepEqual(db.prepare('SELECT id, item_code, cost_type, unit_cost FROM items').all(), [{ id: 7, item_code: 'X1', cost_type: 'S', unit_cost: 1000 }]);
  assert.equal(db.prepare('SELECT item_id FROM assembly_items').get().item_id, 7);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.prepare("UPDATE items SET cost_type = 'E' WHERE id = 7").run();
  db.prepare("INSERT INTO markups (project_id, name, percent, basis) VALUES (1, 'Equipment fuel', 0.05, 'E')").run();
  assert.throws(() => db.prepare("INSERT INTO assembly_items (assembly_id, item_id, formula) VALUES (1, 999, '1')").run(), /FOREIGN KEY/); // FKs enforced again

  // Fresh databases: the seeded pump is Equipment and rolls up under E
  const e = buildEstimate(freshDb(), 1);
  const pump = e.items.find((i) => i.name === 'Pool Structure – Main Pool').components.find((c) => c.item_code === '06.0000.0030');
  assert.equal(pump.cost_type, 'E'); assert.equal(pump.qty, 2); // ROUNDUP(113.4 CY / 80)
  assert.ok(e.base.costs.E > 0);
  assert.equal(M.cents(e.base.costs.L) + M.cents(e.base.costs.M) + M.cents(e.base.costs.E) + M.cents(e.base.costs.S) + M.cents(e.base.costs.O), M.cents(e.totals.base_direct));
  assert.equal(applyMarkups({ L: 0, M: 0, E: 1000, S: 0, O: 0 }, [{ name: 'Fuel', percent: 0.05, basis: 'E' }]).total, 1050);
});

test('backup: a WAL-mode database is copied completely, including uncheckpointed changes', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-backup-'));
  try {
    const db = open(path.join(dir, 'estimator.db')); seed(db);
    db.prepare("UPDATE projects SET name = 'Changed after seeding' WHERE id = 1").run(); // still only in the -wal file
    const out = require('../backup').backup(db, 'test');
    const copy = new Database(out, { readonly: true });
    assert.equal(copy.prepare('SELECT name FROM projects WHERE id = 1').get().name, 'Changed after seeding');
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM items').get().n, db.prepare('SELECT COUNT(*) n FROM items').get().n);
    copy.close(); db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CSI divisions: every starter item is coded and divisions roll up the grid', () => {
  const db = freshDb();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE cost_code_id IS NULL').get().n, 0);
  const e = buildEstimate(db, 1);
  const concrete = e.divisions.find((d) => d.division === '03');
  assert.equal(concrete.name, 'Concrete');
  assert.deepEqual([...concrete.codes].sort(), ['03 21 00', '03 37 13', '03 39 00']);
  assert.equal(cents([concrete], (d) => d.total), cents(e.grid.filter((r) => r.division === '03'), (r) => r.total));
  for (const a of e.areas) assert.equal(cents(e.divisions, (d) => d.cells[a.id].total), M.cents(e.base.areas.find((x) => x.area_id === a.id).total));
  assert.equal(normalizeCode('033713'), '03 37 13');
  assert.equal(normalizeCode('03-37-13'), '03 37 13');
  assert.equal(normalizeCode('GEN-1'), 'GEN-1');
});

test('migration: old MC two-digit divisions move to MasterFormat codes without changing the bid', () => {
  const db = freshDb();
  const before = buildEstimate(db, 1).base.total;
  const legacy = Object.keys(LEGACY_DIVISIONS);
  const ins = db.prepare('INSERT INTO cost_codes (code, name, sort) VALUES (?,?,?)');
  const oldId = Object.fromEntries(legacy.map((c, i) => [c, ins.run(c, `Old ${c}`, i).lastInsertRowid]));
  db.prepare('UPDATE items SET cost_code_id = ?').run(null);
  for (const it of db.prepare('SELECT id, item_code FROM items').all()) db.prepare('UPDATE items SET cost_code_id = ? WHERE id = ?').run(oldId[it.item_code.slice(0, 2)], it.id);
  db.prepare(`DELETE FROM cost_codes WHERE code NOT IN (${legacy.map(() => '?').join(',')})`).run(...legacy);
  const custom = db.prepare("INSERT INTO items (item_code, description, unit, cost_type, unit_cost, cost_code_id) VALUES ('16.0000.0001','Fire bowl','EA','M',900,?)").run(oldId['16']).lastInsertRowid;

  const r = migrate(db);
  assert.equal(r.removed, legacy.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cost_codes WHERE length(code) = 2').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE cost_code_id IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT c.code FROM items i JOIN cost_codes c ON c.id = i.cost_code_id WHERE i.item_code = ?').get('05.0000.0050').code, '07 21 00');
  assert.equal(db.prepare('SELECT c.code FROM items i JOIN cost_codes c ON c.id = i.cost_code_id WHERE i.id = ?').get(custom).code, '10 30 00');
  assert.equal(buildEstimate(db, 1).base.total, before);
  assert.deepEqual(migrate(db), { added: 0, remapped: 0, removed: 0 });
});

test('numbering: sections and per-section sequences, no renumbering, moves get a new number, no duplicates', async () => withServer(async (call, db) => {
  const p = (await call('POST', '/projects', { name: 'Numbering', pool_count: 1 })).body;
  const est = async () => (await call('GET', `/projects/${p.id}/estimate`)).body;
  const no = (e, id) => e.items.find((i) => i.id === id).number;
  assert.equal((await call('POST', `/projects/${p.id}/estimate-items/blank`, {})).status, 400); // a section is required
  const s1 = (await call('POST', `/projects/${p.id}/sections`, { name: 'POOL' })).body;
  const s2 = (await call('POST', `/projects/${p.id}/sections`, { name: 'HARDSCAPES' })).body;
  assert.deepEqual([s1.number, s2.number], [1, 2]);
  const blank = async (sec) => (await call('POST', `/projects/${p.id}/estimate-items/blank`, { section_id: sec.id })).body;
  const a = await blank(s1), b = await blank(s1), c = await blank(s2), d = await blank(s1);
  assert.deepEqual([a.number, b.number, c.number, d.number], ['1.1', '1.2', '2.1', '1.3']);
  // Stored as separate integers; the displayed text is never stored
  const row = db.prepare('SELECT section_id, item_sequence FROM estimate_items WHERE id = ?').get(b.id);
  assert.deepEqual(row, { section_id: s1.id, item_sequence: 2 });
  assert.throws(() => db.prepare('UPDATE estimate_items SET item_sequence = 1 WHERE id = ?').run(b.id), /UNIQUE/); // backend constraint
  assert.throws(() => db.prepare('UPDATE estimate_sections SET number = 1 WHERE id = ?').run(s2.id), /UNIQUE/);

  // Delete 1.2: the others keep 1.1 and 1.3; the next new item is 1.4 (never reuses 1.2)
  await call('DELETE', `/estimate-items/${b.id}`);
  let e = await est();
  assert.deepEqual(e.sections[0].item_ids.map((id) => no(e, id)), ['1.1', '1.3']);
  const f = await blank(s1);
  assert.equal(f.number, '1.4');
  // Restoring the deleted item brings back its own number
  await call('POST', `/estimate-items/${b.id}/restore`);
  assert.equal(no(await est(), b.id), '1.2');

  // Move 1.1 to HARDSCAPES: same id and components, next number there (2.2); others unchanged
  const items = (await call('GET', '/items')).body;
  await call('POST', `/estimate-items/${a.id}/components`, { item_id: items[0].id, qty: 2, unit_cost: 50 });
  await call('PUT', `/estimate-items/${a.id}`, { section_id: s2.id });
  e = await est();
  assert.equal(no(e, a.id), '2.2');
  assert.equal(e.items.find((i) => i.id === a.id).components.length, 1);
  assert.deepEqual([no(e, c.id), no(e, d.id), no(e, f.id)], ['2.1', '1.3', '1.4']);
  // Re-ordering changes display order only, never numbers
  await call('POST', `/estimate-items/${f.id}/move`, { dir: -1 });
  e = await est();
  assert.deepEqual(e.sections[0].item_ids.map((id) => no(e, id)), ['1.2', '1.4', '1.3']);
  await call('POST', `/sections/${s2.id}/move`, { dir: -1 });
  e = await est();
  assert.deepEqual(e.sections.map((s) => `${s.number} ${s.name}`), ['2 HARDSCAPES', '1 POOL']); // order changes, numbers don't
  // Every number unique; section subtotals add up to the base subtotal
  const nums = e.items.filter((i) => !i.alternate_id).map((i) => i.number);
  assert.equal(new Set(nums).size, nums.length);
  assert.equal(e.sections.reduce((s, x) => s + M.cents(x.direct), 0), M.cents(e.totals.base_direct));
  // A non-empty section cannot be deleted; an empty one can
  assert.equal((await call('DELETE', `/sections/${s1.id}`)).status, 409);
}));

test('ProEst-style entry: empty parents, components assigned to a chosen parent, totals, VE separate', async () => withServer(async (call) => {
  const p = (await call('POST', '/projects', { name: 'Acceptance', pool_count: 1 })).body;
  const est = async () => (await call('GET', `/projects/${p.id}/estimate`)).body;
  // New Bid Item → empty parent at the bottom of the chosen section, numbered 1.1, 1.2
  const sec = (await call('POST', `/projects/${p.id}/sections`, { name: 'POOL' })).body;
  const bi1 = (await call('POST', `/projects/${p.id}/estimate-items/blank`, { section_id: sec.id })).body;
  const bi2 = (await call('POST', `/projects/${p.id}/estimate-items/blank`, { section_id: sec.id })).body;
  assert.equal(bi1.number, '1.1'); assert.equal(bi2.number, '1.2');
  let e = await est();
  assert.deepEqual(e.order, [bi1.id, bi2.id]);
  assert.equal(e.items.find((i) => i.id === bi1.id).direct, 0);
  assert.equal(e.items.find((i) => i.id === bi1.id).components.length, 0);
  await call('PUT', `/estimate-items/${bi1.id}`, { name: 'Pool Shell' });
  await call('PUT', `/estimate-items/${bi2.id}`, { name: 'Pool Plumbing' });

  const items = (await call('GET', '/items')).body;
  const pick = (code) => items.find((i) => i.item_code === code);
  const shot = pick('06.0000.0010'), rebar = pick('04.0610.0050'), labor = pick('04.0610.0060'), plumb = pick('05.0000.0020');
  const add = (parent, it, body) => call('POST', `/estimate-items/${parent}/components`, { item_id: it.id, ...body });
  await add(bi1.id, shot, { qty: 100, unit_cost: 150.25, cost_type: 'M' });
  await add(bi1.id, rebar, { qty: 400, unit_cost: 9 });
  await add(bi1.id, labor, { qty: 3, unit_cost: 1600, cost_type: 'L' });
  await add(bi2.id, plumb, { qty: 1000, unit_cost: 6.2, unit: 'SF', label: 'Pool plumbing materials' });
  // Validation: unknown parent, negative quantity, bad cost type
  assert.equal((await add(999999, shot, { qty: 1, unit_cost: 1 })).status, 404);
  assert.equal((await add(bi1.id, shot, { qty: -1, unit_cost: 1 })).status, 400);
  assert.equal((await add(bi1.id, shot, { qty: 1, unit_cost: 1, cost_type: 'Z' })).status, 400);

  e = await est();
  const P1 = e.items.find((i) => i.id === bi1.id), P2 = e.items.find((i) => i.id === bi2.id);
  // Only each parent's own components
  assert.deepEqual(P1.components.map((c) => c.item_code).sort(), [shot.item_code, rebar.item_code, labor.item_code].sort());
  assert.deepEqual(P2.components.map((c) => c.label), ['Pool plumbing materials']);
  // Extended = qty × unit cost; parent = sum of children; subtotal = sum of parents (children never counted twice)
  assert.equal(P1.components.find((c) => c.item_code === shot.item_code).ext, 15025);
  assert.equal(P1.direct, 15025 + 3600 + 4800);
  assert.equal(P2.direct, 6200);
  assert.equal(e.totals.base_direct, P1.direct + P2.direct);
  assert.equal(P1.components.find((c) => c.item_code === labor.item_code).cost_type, 'L');
  assert.equal(e.base.costs.L, 4800);

  // Change cost type and unit on a component; move a component between parents (both totals follow)
  const rb = P1.components.find((c) => c.item_code === rebar.item_code);
  await call('PUT', `/components/${rb.id}`, { cost_type: 'S', unit: 'PCS' });
  await call('PUT', `/components/${rb.id}`, { estimate_item_id: bi2.id });
  e = await est();
  assert.equal(e.items.find((i) => i.id === bi1.id).direct, 15025 + 4800);
  assert.equal(e.items.find((i) => i.id === bi2.id).direct, 6200 + 3600);
  const moved = e.items.find((i) => i.id === bi2.id).components.find((c) => c.id === rb.id);
  assert.equal(moved.cost_type, 'S'); assert.equal(moved.unit, 'PCS');
  const other = (await call('POST', '/projects', { name: 'Other' })).body;
  const otherSec = (await call('POST', `/projects/${other.id}/sections`, { name: 'X' })).body;
  const foreign = (await call('POST', `/projects/${other.id}/estimate-items/blank`, { section_id: otherSec.id })).body;
  assert.equal((await call('PUT', `/components/${rb.id}`, { estimate_item_id: foreign.id })).status, 400); // no cross-project moves

  // Snapshot: changing the database price does not change the estimate
  const before = (await est()).totals.base_direct;
  await call('PUT', `/items/${shot.id}`, { unit_cost: 999 });
  assert.equal((await est()).totals.base_direct, before);

  // A VE deduct never changes the base subtotal
  await call('POST', `/projects/${p.id}/alternates`, { kind: 'deduct', status: 'accepted', name: 'Reduce rebar', item_id: bi1.id, qty: 1, unit_price: 500 });
  e = await est();
  assert.equal(e.totals.base_direct, before);
  assert.equal(e.totals.ve_direct, -500);
  assert.equal(e.totals.grand_direct, before - 500);
}));
