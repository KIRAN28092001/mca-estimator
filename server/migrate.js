// Database migrations run every time the database is opened. Each one is idempotent
// and never overwrites or deletes existing records.
const { DEFAULT_SECTIONS, createSection, insComponent } = require('./estimate');

const COLUMNS = {
  assemblies: [['code', 'TEXT'], ['category', 'TEXT'], ['unit', "TEXT NOT NULL DEFAULT 'LS'"]],
  projects: [['estimate_name', "TEXT NOT NULL DEFAULT 'Base Estimate'"]],
  alternates: [
    ['status', "TEXT NOT NULL DEFAULT 'proposed'"],          // proposed | pending | accepted | rejected | excluded
    ['section_id', 'INTEGER REFERENCES estimate_sections(id) ON DELETE SET NULL'],
    ['item_id', 'INTEGER REFERENCES estimate_items(id) ON DELETE SET NULL'], // associated base bid item
    ['replaces', 'INTEGER NOT NULL DEFAULT 0'],               // 1 = priced as net difference vs. item_id
    ['bid_item_no', 'TEXT'], ['description', 'TEXT'],
    ['qty', 'REAL'], ['unit', 'TEXT'], ['unit_price', 'REAL'], // simple pricing: qty × unit price
    ['cost_type', "TEXT NOT NULL DEFAULT 'S'"],
    ['reason', 'TEXT'], ['notes', 'TEXT'],
  ],
  // Snapshots taken when a component is added (NULL on older rows until backfilled below)
  estimate_components: [['unit', 'TEXT'], ['cost_type', 'TEXT']],
  // Permanent numbering, stored as separate integers: a bid item shows as "<section number>.<item sequence>"
  estimate_sections: [['number', 'INTEGER']],
  estimate_items: [['item_sequence', 'INTEGER']],
};

function ensureColumns(db) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}

const done = (db, name) => !!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
const mark = (db, name) => db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);

/**
 * Copy estimates built with the old tables (assembly_instances + instance_overrides + lines)
 * into the worksheet tables. One section per pool/area keeps the old grouping; quantities,
 * overrides and current prices carry over, so every bid total is unchanged.
 */
function migrateLegacyEstimates(db) {
  for (const p of db.prepare('SELECT id FROM projects').all()) {
    if (db.prepare('SELECT 1 FROM estimate_sections WHERE project_id = ?').get(p.id)) continue;
    const instances = db.prepare(`SELECT x.*, a.name, a.code, a.description FROM assembly_instances x JOIN assemblies a ON a.id = x.assembly_id
                                  WHERE x.project_id = ? ORDER BY x.sort, x.id`).all(p.id);
    const lines = db.prepare(`SELECT l.*, i.item_code, i.description AS item_description, i.unit, i.unit_cost AS db_cost FROM lines l
                              JOIN items i ON i.id = l.item_id WHERE l.project_id = ? ORDER BY l.sort, l.id`).all(p.id);
    if (!instances.length && !lines.length) { DEFAULT_SECTIONS.forEach((n, i) => createSection(db, p.id, n, i + 1)); continue; }

    const sectionOf = new Map();
    const areas = db.prepare('SELECT * FROM areas WHERE project_id = ? ORDER BY sort, id').all(p.id);
    const used = new Set([...instances, ...lines].map((r) => r.area_id));
    for (const a of areas) if (used.has(a.id)) sectionOf.set(a.id, createSection(db, p.id, a.name.toUpperCase()));

    const ins = db.prepare(`INSERT INTO estimate_items (project_id, section_id, area_id, alternate_id, assembly_id, bid_item_no, name, description,
      notes, qty, unit, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let sort = 0;
    for (const x of instances) {
      const id = ins.run(p.id, sectionOf.get(x.area_id), x.area_id, x.alternate_id, x.assembly_id, x.code, x.name, x.description, null, 1, 'LS', ++sort).lastInsertRowid;
      const ov = new Map(db.prepare('SELECT * FROM instance_overrides WHERE instance_id = ?').all(x.id).map((o) => [o.assembly_item_id, o]));
      const rows = db.prepare(`SELECT s.*, i.description AS item_description, i.unit_cost FROM assembly_items s JOIN items i ON i.id = s.item_id
                               WHERE s.assembly_id = ? ORDER BY s.sort, s.id`).all(x.assembly_id);
      rows.forEach((s, i) => {
        const o = ov.get(s.id) || {};
        insComponent(db, { estimate_item_id: id, item_id: s.item_id, assembly_item_id: s.id, label: s.label || s.item_description, formula: s.formula,
          waste_pct: s.waste_pct, qty: o.qty ?? null, unit_cost: o.unit_cost ?? s.unit_cost, excluded: o.excluded, sort: i });
      });
    }
    for (const l of lines) {
      const id = ins.run(p.id, sectionOf.get(l.area_id), l.area_id, l.alternate_id, null, l.item_code, l.description || l.item_description, null,
        l.notes, l.qty, l.unit, ++sort).lastInsertRowid;
      insComponent(db, { estimate_item_id: id, item_id: l.item_id, label: l.item_description, formula: '1', unit_cost: l.unit_cost ?? l.db_cost });
    }
    // Alternates go to the section of their first priced item (they stay "proposed": never in the base bid)
    for (const alt of db.prepare('SELECT id FROM alternates WHERE project_id = ?').all(p.id)) {
      const first = db.prepare('SELECT section_id FROM estimate_items WHERE alternate_id = ? ORDER BY sort LIMIT 1').get(alt.id);
      db.prepare('UPDATE alternates SET section_id = ? WHERE id = ?').run(first?.section_id ?? [...sectionOf.values()][0], alt.id);
    }
  }
}

/** Give every assembly a bid item number (starter assemblies get their standard one) and copy it onto estimate items. */
function backfillAssemblyCodes(db) {
  const { ASSEMBLIES } = require('./seed');
  for (const a of db.prepare('SELECT id, name FROM assemblies WHERE code IS NULL').all()) {
    const meta = ASSEMBLIES[a.name];
    db.prepare('UPDATE assemblies SET code = ?, category = COALESCE(category, ?) WHERE id = ?').run(meta?.code || `ASM-${a.id}`, meta?.category ?? null, a.id);
  }
  db.prepare(`UPDATE estimate_items SET bid_item_no = (SELECT code FROM assemblies a WHERE a.id = estimate_items.assembly_id)
              WHERE bid_item_no IS NULL AND assembly_id IS NOT NULL`).run();
}

/**
 * SQLite cannot change a CHECK constraint in place, so a table whose constraint lacks
 * Equipment ('E') is rebuilt: create a copy with the widened constraint, copy every row
 * (same ids, same columns), drop the old table, rename, recreate its indexes.
 * Foreign keys are switched off only for the swap and checked before committing.
 */
const WIDEN = [
  ['items', "CHECK (cost_type IN ('L','M','S','O'))", "CHECK (cost_type IN ('L','M','E','S','O'))"],
  ['markups', "CHECK (basis IN ('L','M','S','O','direct','running'))", "CHECK (basis IN ('L','M','E','S','O','direct','running'))"],
];
function addEquipmentType(db) {
  const todo = WIDEN.filter(([t, from]) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql.includes(from));
  if (!todo.length) return;
  safetyBackup(db, 'before-equipment');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [table, from, to] of todo) {
        const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table).map((r) => r.sql);
        const tmp = `${table}__widen`;
        db.exec(sql.replace(from, to).replace(new RegExp(`^CREATE TABLE\\s+("?)${table}\\1`), `CREATE TABLE ${tmp}`));
        db.exec(`INSERT INTO ${tmp} SELECT * FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
        for (const ix of indexes) db.exec(ix);
      }
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Equipment cost type migration would break ${broken.length} reference(s); nothing was changed.`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Back up a file database (only if it holds data) before a migration restructures it. */
function safetyBackup(db, label) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'projects'").get()) return;
  if (!db.prepare('SELECT 1 FROM projects LIMIT 1').get() && !db.prepare('SELECT 1 FROM items LIMIT 1').get()) return;
  const out = require('./backup').backup(db, label);
  if (out) console.log(`Backed up the database before upgrading it: ${out}`);
}

/** Give existing sections numbers 1..n (in their current order) and base bid items 1..n within each section. */
function numberSections(db) {
  for (const p of db.prepare('SELECT id FROM projects').all()) {
    db.prepare('SELECT id FROM estimate_sections WHERE project_id = ? ORDER BY sort, id').all(p.id)
      .forEach((s, i) => {
        db.prepare('UPDATE estimate_sections SET number = ? WHERE id = ?').run(i + 1, s.id);
        // deleted items keep a number too, so a restored item gets its old number back
        db.prepare('SELECT id FROM estimate_items WHERE section_id = ? AND alternate_id IS NULL ORDER BY (deleted_at IS NOT NULL), sort, id').all(s.id)
          .forEach((it, k) => db.prepare('UPDATE estimate_items SET item_sequence = ? WHERE id = ?').run(k + 1, it.id));
      });
  }
}

function migrate(db) {
  if (!done(db, 'estimate_v2') && db.prepare('SELECT 1 FROM assembly_instances UNION ALL SELECT 1 FROM lines LIMIT 1').get()) safetyBackup(db, 'before-worksheet');
  ensureColumns(db);
  addEquipmentType(db);
  db.transaction(() => {
    if (!done(db, 'estimate_v2')) { migrateLegacyEstimates(db); mark(db, 'estimate_v2'); }
    if (!done(db, 'assembly_codes')) { backfillAssemblyCodes(db); mark(db, 'assembly_codes'); }
    if (!done(db, 'component_snapshots')) {
      // Older components read unit and cost type live from the item; freeze today's values
      db.exec(`UPDATE estimate_components SET unit = COALESCE(unit, (SELECT unit FROM items i WHERE i.id = estimate_components.item_id)),
               cost_type = COALESCE(cost_type, (SELECT cost_type FROM items i WHERE i.id = estimate_components.item_id))`);
      mark(db, 'component_snapshots');
    }
    if (!done(db, 'section_numbering')) { numberSections(db); mark(db, 'section_numbering'); }
    // Duplicate numbers are impossible at the database level (NULL sequences = items priced in alternates)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_section_number ON estimate_sections(project_id, number);
             CREATE UNIQUE INDEX IF NOT EXISTS ux_item_sequence ON estimate_items(section_id, item_sequence);`);
  })();
}

module.exports = { migrate, migrateLegacyEstimates };
