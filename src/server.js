'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');

const db = openDb();
seedIfEmpty(db);

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => {
  console.log(`intlstudent running at http://localhost:${port}`);
});
