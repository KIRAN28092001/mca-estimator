// Moves an existing database from the old MC two-digit divisions (01–18) to
// CSI MasterFormat cost codes. Safe to run more than once.
//
//   node server/migrate-csi.js
//
// 1. Adds every MasterFormat cost code from csi.js that is missing.
// 2. Re-points items still on an old two-digit code: starter items go to their
//    exact code (per seed.js), anything else to the closest code for its division.
// 3. Deletes the old two-digit codes once no item uses them.
const { open, DB_PATH } = require('./db');
const { COST_CODES, LEGACY_DIVISIONS } = require('./csi');
const { ITEMS } = require('./seed');

function migrate(db) {
  const exact = Object.fromEntries(ITEMS.map(([itemCode, , , , , cc]) => [itemCode, cc]));
  const report = { added: 0, remapped: 0, removed: 0 };
  db.transaction(() => {
    const idOf = (code) => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code)?.id;
    const ins = db.prepare('INSERT INTO cost_codes (code, name, sort) VALUES (?,?,?)');
    COST_CODES.forEach(([code, name], i) => { if (!idOf(code)) { ins.run(code, name, 100 + i); report.added++; } });
    // Put the MasterFormat codes in division order
    const sort = db.prepare('UPDATE cost_codes SET sort = ? WHERE code = ?');
    COST_CODES.forEach(([code], i) => sort.run(i, code));

    const legacy = db.prepare(`SELECT id, code FROM cost_codes WHERE code IN (${Object.keys(LEGACY_DIVISIONS).map(() => '?').join(',')})`)
      .all(...Object.keys(LEGACY_DIVISIONS));
    const setCode = db.prepare('UPDATE items SET cost_code_id = ? WHERE id = ?');
    for (const old of legacy) {
      for (const it of db.prepare('SELECT id, item_code FROM items WHERE cost_code_id = ?').all(old.id)) {
        setCode.run(idOf(exact[it.item_code] || LEGACY_DIVISIONS[old.code]), it.id);
        report.remapped++;
      }
      report.removed += db.prepare('DELETE FROM cost_codes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM items WHERE cost_code_id = ?)').run(old.id, old.id).changes;
    }
  })();
  return report;
}

module.exports = { migrate };

if (require.main === module) {
  const r = migrate(open());
  console.log(`${DB_PATH}: added ${r.added} MasterFormat cost codes, re-coded ${r.remapped} item(s), removed ${r.removed} old division code(s).`);
}
