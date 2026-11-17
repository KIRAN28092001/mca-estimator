// Consistent database backups. The database runs in WAL mode, so copying the .db file
// alone misses recent changes (they live in estimator.db-wal). VACUUM INTO writes a
// complete, self-contained copy, and is safe while the app is running.
//
//   npm run backup            → data/backup/estimator-manual-<timestamp>.db
const path = require('path');
const fs = require('fs');

function backup(db, label = 'manual') {
  const file = db.name;
  if (!file || file === ':memory:') return null;
  const dir = path.join(path.dirname(file), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out = path.join(dir, `${path.basename(file, '.db')}-${label}-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(out);
  return out;
}

module.exports = { backup };

if (require.main === module) {
  const { open } = require('./db');
  console.log(`Backup written to ${backup(open())}`);
}
