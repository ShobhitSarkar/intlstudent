'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { seedIfEmpty } = require('../src/seed');
const { createAuthz, tuple, MODEL, diffTuples, PLATFORM } = require('../src/authz');

function setup() {
  const db = openDb(':memory:');
  seedIfEmpty(db, { log: false });
  const authz = createAuthz(db);
  const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const uniId = (name) => db.prepare('SELECT id FROM universities WHERE name = ?').get(name).id;
  return { db, authz, userId, uniId };
}

test('seeded data has exactly the tuples the data implies', () => {
  const { db } = setup();
  assert.deepEqual(diffTuples(db), { missing: [], extra: [] });
});

test('representatives moderate only their own university; admins moderate all', () => {
  const { authz, userId, uniId } = setup();
  const rep = userId('admissions@utoronto.ca');
  const admin = userId('admin@intlstudent.test');
  const toronto = uniId('University of Toronto');
  const mcgill = uniId('McGill University');
  assert.equal(authz.check('university', toronto, 'can_moderate', rep), true);
  assert.equal(authz.check('university', mcgill, 'can_moderate', rep), false);
  assert.equal(authz.check('university', mcgill, 'can_moderate', admin), true); // via platform#admin
  assert.equal(authz.check('university', toronto, 'can_edit_email_domain', rep), false);
  assert.equal(authz.check('university', toronto, 'can_edit_email_domain', admin), true);
  assert.equal(authz.listObjects('university', 'can_moderate', rep).length, 1);
  assert.equal(authz.listObjects('university', 'can_moderate', admin).length, 12);
});

test('moderation flows down from the university to its questions and answers', () => {
  const { db, authz, userId } = setup();
  const rep = userId('admissions@utoronto.ca');
  const priya = userId('priya@example.com');
  const maria = userId('maria@utoronto.ca');
  const q = db.prepare("SELECT id FROM questions WHERE title LIKE 'Is first-year residence%'").get().id;
  const a = db.prepare('SELECT id FROM answers WHERE question_id = ? AND user_id = ?').get(q, maria).id;
  assert.equal(authz.check('question', q, 'can_moderate', rep), true);
  assert.equal(authz.check('answer', a, 'can_moderate', rep), true); // answer → question → board → university
  assert.equal(authz.check('question', q, 'can_moderate', priya), false);
  assert.equal(authz.check('question', q, 'can_accept_answer', priya), true); // she asked it
  assert.equal(authz.check('question', q, 'can_view_unpublished', priya), true);
  assert.equal(authz.check('answer', a, 'can_view_unpublished', maria), true);
  assert.equal(authz.check('question', q, 'can_view_unpublished', maria), false);
});

test('messaging needs an accepted connection', () => {
  const { db, authz, userId } = setup();
  const priya = userId('priya@example.com');
  const arjun = userId('arjun@example.com');
  const pending = db.prepare("SELECT id FROM connections WHERE status = 'pending'").get().id;
  assert.equal(authz.check('connection', pending, 'can_view', priya), true);
  assert.equal(authz.check('connection', pending, 'can_respond', priya), true); // she received it
  assert.equal(authz.check('connection', pending, 'can_respond', arjun), false);
  assert.equal(authz.check('connection', pending, 'can_message', arjun), false);
  authz.write(tuple('connection', pending, 'member', 'user', priya), tuple('connection', pending, 'member', 'user', arjun));
  assert.equal(authz.check('connection', pending, 'can_message', arjun), true);
});

test('only students take part in networking', () => {
  const { authz, userId } = setup();
  assert.equal(authz.check('platform', PLATFORM, 'networker', userId('priya@example.com')), true);
  assert.equal(authz.check('platform', PLATFORM, 'networker', userId('maria@utoronto.ca')), true);
  assert.equal(authz.check('platform', PLATFORM, 'networker', userId('admissions@utoronto.ca')), false);
  assert.equal(authz.check('platform', PLATFORM, 'networker', null), false); // anonymous
});

test('tuples are validated against the model', () => {
  const { authz } = setup();
  assert.throws(() => authz.write(tuple('university', 1, 'can_moderate', 'user', 5)), /can't be granted directly/);
  assert.throws(() => authz.write(tuple('question', 1, 'board', 'user', 5)), /doesn't accept user/);
  assert.throws(() => authz.check('university', 1, 'no_such_relation', 5), /unknown relation/);
});

test('usersets: a relation can be granted to everyone holding another relation', () => {
  const { authz, userId, uniId } = setup();
  // e.g. "every admin is also a representative of Toronto": university:T#representative@platform:main#admin
  // (not used by the app today; the engine supports it for groups and teams later)
  MODEL.university.representative.direct.push('platform');
  try {
    const toronto = uniId('University of Toronto');
    const admin = userId('admin@intlstudent.test');
    authz.write(tuple('university', toronto, 'representative', 'platform', PLATFORM, 'admin'));
    assert.equal(authz.check('university', toronto, 'representative', admin), true);
  } finally {
    MODEL.university.representative.direct.pop();
  }
});
