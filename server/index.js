const { open, DB_PATH } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');

const db = open();
if (!db.prepare('SELECT COUNT(*) n FROM cost_codes').get().n) {
  seed(db);
  console.log('Empty database — loaded MC Aquatic starter data and sample project.');
}

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => {
  console.log(`MC Aquatic Estimator running at http://localhost:${port}`);
  console.log(`Database: ${DB_PATH}`);
});
