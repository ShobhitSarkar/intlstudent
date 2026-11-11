'use strict';

// Usage: npm run make-admin -- someone@example.com
const { openDb } = require('./db');

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run make-admin -- <email of an existing account>');
  process.exit(1);
}
const { changes } = openDb()
  .prepare("UPDATE users SET role = 'admin', rep_status = NULL, university_id = NULL WHERE email = ?")
  .run(email);
console.log(changes ? `${email} is now an admin.` : `No account found for ${email}. Sign up first.`);
process.exit(changes ? 0 : 1);
