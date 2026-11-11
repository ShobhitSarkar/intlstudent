'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');

const db = openDb();
// Demo data (including demo accounts with a known password) is for local development only.
if (process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO !== 'false') seedIfEmpty(db);

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => {
  console.log(`intlstudent running at http://localhost:${port}`);
});
