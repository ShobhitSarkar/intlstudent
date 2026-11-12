'use strict';

/**
 * Authorization, Zanzibar style.
 *
 * Every grant is a relationship tuple:   object#relation@subject
 *
 *   university:1#representative@user:7      user 7 is a verified representative of university 1
 *   question:12#board@university:1          question 12 is on university 1's board
 *   platform:main#admin@user:1              user 1 is a site admin
 *
 * Permissions are never stored. They're computed from tuples by the MODEL below: a relation is
 * either granted directly by a tuple, or rewritten in terms of other relations, either on the
 * same object ("computed") or on a related object ("from" a parent, a.k.a. tuple-to-userset).
 * `check()` answers "does user U have permission P on object O?".
 *
 * The model is written to map one-to-one onto OpenFGA / SpiceDB schemas (see
 * docs/authorization.md), so the tuples can move to a dedicated service later unchanged.
 *
 * Keeping tuples correct:
 *   - Domain writes and their tuple writes happen in the same database transaction (see `tx`).
 *   - `expectedTuples()` re-derives every tuple from the domain data, and `diffTuples()`
 *     compares it with what's stored. Tests and CI (`npm run authz:check`) fail on any drift.
 */

const PLATFORM = 'main';

/**
 * The authorization model.
 *   direct:   [subject types]       – the relation can be granted by a tuple
 *   union:    [rewrite, …]          – any of: { computed: 'rel' } | { from: 'tupleset', relation: 'rel' }
 * A relation may have `direct`, `union`, or both.
 */
const MODEL = {
  user: {},

  platform: {
    admin: { direct: ['user'] },
    // Prospective and current students take part in networking; staff and admins don't.
    networker: { direct: ['user'] },
    can_moderate_all: { union: [{ computed: 'admin' }] },
  },

  university: {
    platform: { direct: ['platform'] },
    representative: { direct: ['user'] }, // verified by an admin
    student: { direct: ['user'] }, // verified by university email domain
    considering: { direct: ['user'] }, // prospective students who listed it
    moderator: { union: [{ computed: 'representative' }, { from: 'platform', relation: 'admin' }] },
    can_moderate: { union: [{ computed: 'moderator' }] },
    can_edit_profile: { union: [{ computed: 'moderator' }] },
    can_edit_email_domain: { union: [{ from: 'platform', relation: 'admin' }] },
  },

  question: {
    board: { direct: ['university'] },
    author: { direct: ['user'] }, // absent for guest questions
    can_moderate: { union: [{ from: 'board', relation: 'can_moderate' }] },
    // Who can see it while it's hidden or waiting for review.
    can_view_unpublished: { union: [{ computed: 'author' }, { computed: 'can_moderate' }] },
    can_accept_answer: { union: [{ computed: 'author' }] },
  },

  answer: {
    question: { direct: ['question'] },
    author: { direct: ['user'] },
    can_moderate: { union: [{ from: 'question', relation: 'can_moderate' }] },
    can_view_unpublished: { union: [{ computed: 'author' }, { computed: 'can_moderate' }] },
  },

  connection: {
    requester: { direct: ['user'] },
    addressee: { direct: ['user'] },
    member: { direct: ['user'] }, // both people, once the request is accepted
    can_view: { union: [{ computed: 'requester' }, { computed: 'addressee' }] },
    can_respond: { union: [{ computed: 'addressee' }] },
    can_message: { union: [{ computed: 'member' }] },
  },
};

const MAX_DEPTH = 25;

/** Validate a tuple against the model before it's written. */
function validate(t) {
  const def = MODEL[t.objectType]?.[t.relation];
  if (!def || !def.direct) throw new Error(`authz: ${t.objectType}#${t.relation} can't be granted directly`);
  if (!def.direct.includes(t.subjectType)) throw new Error(`authz: ${t.objectType}#${t.relation} doesn't accept ${t.subjectType}`);
}

/** Shorthand: tuple('university', 1, 'representative', 'user', 7). */
function tuple(objectType, objectId, relation, subjectType, subjectId, subjectRelation = '') {
  return { objectType, objectId: String(objectId), relation, subjectType, subjectId: String(subjectId), subjectRelation };
}

const key = (t) => `${t.objectType}:${t.objectId}#${t.relation}@${t.subjectType}:${t.subjectId}${t.subjectRelation ? `#${t.subjectRelation}` : ''}`;

/** Run `fn` in a transaction (nested calls join the outer one). */
function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createAuthz(db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const remove = db.prepare(
    `DELETE FROM relation_tuples WHERE object_type = ? AND object_id = ? AND relation = ? AND subject_type = ? AND subject_id = ? AND subject_relation = ?`
  );
  const subjectsOf = db.prepare(
    'SELECT subject_type, subject_id, subject_relation FROM relation_tuples WHERE object_type = ? AND object_id = ? AND relation = ?'
  );
  const objectsOfType = db.prepare('SELECT DISTINCT object_id FROM relation_tuples WHERE object_type = ?');

  const write = (...tuples) => tuples.flat().forEach((t) => { validate(t); insert.run(t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation); });
  const del = (...tuples) => tuples.flat().forEach((t) => remove.run(t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation));

  /** Does user `userId` have `relation` on objectType:objectId? */
  function check(objectType, objectId, relation, userId) {
    if (userId === null || userId === undefined) return false;
    return evaluate(objectType, String(objectId), relation, String(userId), 0, new Set());
  }

  function evaluate(objectType, objectId, relation, userId, depth, seen) {
    const def = MODEL[objectType]?.[relation];
    if (!def) throw new Error(`authz: unknown relation ${objectType}#${relation}`);
    const k = `${objectType}:${objectId}#${relation}`;
    if (depth > MAX_DEPTH || seen.has(k)) return false;
    seen.add(k);

    if (def.direct) {
      for (const s of subjectsOf.all(objectType, objectId, relation)) {
        if (s.subject_type === 'user' && s.subject_id === userId && !s.subject_relation) return true;
        // Userset subjects (e.g. group:5#member) are followed recursively.
        if (s.subject_relation && evaluate(s.subject_type, s.subject_id, s.subject_relation, userId, depth + 1, seen)) return true;
      }
    }
    for (const rw of def.union || []) {
      if (rw.computed && evaluate(objectType, objectId, rw.computed, userId, depth + 1, seen)) return true;
      if (rw.from) {
        for (const parent of subjectsOf.all(objectType, objectId, rw.from)) {
          if (evaluate(parent.subject_type, parent.subject_id, rw.relation, userId, depth + 1, seen)) return true;
        }
      }
    }
    return false;
  }

  /** Every object of `objectType` on which the user has `relation` (IDs as numbers). */
  function listObjects(objectType, relation, userId) {
    if (userId === null || userId === undefined) return [];
    return objectsOfType.all(objectType).map((r) => r.object_id).filter((id) => check(objectType, id, relation, userId)).map(Number);
  }

  return { check, listObjects, write, delete: del };
}

/**
 * Re-derive every tuple from the domain tables. Used to backfill, and to detect drift
 * between what the app wrote and what the data says it should have written.
 */
function expectedTuples(db) {
  const out = [];
  const add = (...a) => out.push(tuple(...a));
  for (const u of db.prepare('SELECT id, role, rep_status, university_id FROM users').all()) {
    if (u.role === 'admin') add('platform', PLATFORM, 'admin', 'user', u.id);
    if (u.role === 'prospective' || u.role === 'student') add('platform', PLATFORM, 'networker', 'user', u.id);
    if (u.role === 'student' && u.university_id) add('university', u.university_id, 'student', 'user', u.id);
    if (u.role === 'university_rep' && u.rep_status === 'approved' && u.university_id) add('university', u.university_id, 'representative', 'user', u.id);
  }
  for (const un of db.prepare('SELECT id FROM universities').all()) add('university', un.id, 'platform', 'platform', PLATFORM);
  for (const t of db.prepare('SELECT user_id, university_id FROM user_target_universities').all()) add('university', t.university_id, 'considering', 'user', t.user_id);
  for (const q of db.prepare('SELECT id, university_id, user_id FROM questions').all()) {
    add('question', q.id, 'board', 'university', q.university_id);
    if (q.user_id !== null) add('question', q.id, 'author', 'user', q.user_id);
  }
  for (const a of db.prepare('SELECT id, question_id, user_id FROM answers').all()) {
    add('answer', a.id, 'question', 'question', a.question_id);
    add('answer', a.id, 'author', 'user', a.user_id);
  }
  for (const c of db.prepare('SELECT id, requester_id, addressee_id, status FROM connections').all()) {
    add('connection', c.id, 'requester', 'user', c.requester_id);
    add('connection', c.id, 'addressee', 'user', c.addressee_id);
    if (c.status === 'accepted') {
      add('connection', c.id, 'member', 'user', c.requester_id);
      add('connection', c.id, 'member', 'user', c.addressee_id);
    }
  }
  return out;
}

/** Compare stored tuples with the ones the domain data implies. */
function diffTuples(db) {
  const expected = new Map(expectedTuples(db).map((t) => [key(t), t]));
  const stored = new Map(
    db.prepare('SELECT object_type, object_id, relation, subject_type, subject_id, subject_relation FROM relation_tuples').all()
      .map((r) => tuple(r.object_type, r.object_id, r.relation, r.subject_type, r.subject_id, r.subject_relation))
      .map((t) => [key(t), t])
  );
  return {
    missing: [...expected.keys()].filter((k) => !stored.has(k)),
    extra: [...stored.keys()].filter((k) => !expected.has(k)),
  };
}

/** Write any missing tuples (idempotent). */
function backfillTuples(db) {
  const authz = createAuthz(db);
  tx(db, () => authz.write(expectedTuples(db)));
}

/**
 * SQL for "this user has this DIRECT relation on that object", for list queries where calling
 * check() per row would be wasteful. Only use it for relations that are direct-only.
 */
function directRelationSql(objectType, objectIdSql, relation, userIdSql) {
  if (MODEL[objectType]?.[relation]?.union) throw new Error(`authz: ${objectType}#${relation} isn't direct-only`);
  return `EXISTS (SELECT 1 FROM relation_tuples rt
    WHERE rt.object_type = '${objectType}' AND rt.object_id = CAST(${objectIdSql} AS TEXT) AND rt.relation = '${relation}'
      AND rt.subject_type = 'user' AND rt.subject_id = CAST(${userIdSql} AS TEXT) AND rt.subject_relation = '')`;
}

module.exports = { MODEL, PLATFORM, createAuthz, tuple, tx, expectedTuples, diffTuples, backfillTuples, directRelationSql };
