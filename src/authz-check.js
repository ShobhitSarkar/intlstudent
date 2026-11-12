'use strict';

/**
 * Check that the stored authorization tuples match what the data implies.
 * Usage: npm run authz:check            (report drift, exit 1 if any)
 *        npm run authz:check -- --fix   (also write missing tuples; extra ones are only reported)
 */
const { openDb } = require('./db');
const { diffTuples, backfillTuples } = require('./authz');

const db = openDb();
if (process.argv.includes('--fix')) backfillTuples(db);
const { missing, extra } = diffTuples(db);
for (const t of missing) console.log(`missing  ${t}`);
for (const t of extra) console.log(`extra    ${t}`);
if (missing.length || extra.length) {
  console.error(`Authorization tuples are out of sync: ${missing.length} missing, ${extra.length} extra.`);
  process.exit(1);
}
console.log('Authorization tuples are in sync.');
