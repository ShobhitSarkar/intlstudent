'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');

const ROLES_WITH_AFFILIATION = new Set(['student', 'university_rep']);

/** Small helpers for validating request bodies. */
function str(value, { field, min = 1, max = 5000 }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min) throw httpError(400, `${field} is required${min > 1 ? ` (at least ${min} characters)` : ''}.`);
  if (s.length > max) throw httpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

function optStr(value, { field, max = 500 }) {
  if (value === undefined || value === null || value === '') return null;
  return str(value, { field, max });
}

function intParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Describe who wrote a post relative to the university whose board it's on,
 * so readers can tell official answers and current students apart from other prospects.
 */
function authorBadge(row, boardUniversityId) {
  const sameUniversity = row.author_university_id === boardUniversityId;
  if (row.author_role === 'university_rep' && sameUniversity) return 'University representative';
  if (row.author_role === 'student' && sameUniversity) return 'Current student';
  if (row.author_role === 'student' || row.author_role === 'university_rep') {
    return `Affiliated with ${row.author_university_name}`;
  }
  if (row.author_role === 'admin') return 'Moderator';
  return 'Prospective student';
}

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(auth.loadUser(db));

  // Mutating API requests must be JSON. Combined with SameSite=Lax cookies this blocks
  // cross-site form posts (a basic CSRF defence).
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be sent as application/json.' });
    }
    next();
  });

  // ---------------------------------------------------------------- auth

  app.post('/api/auth/signup', (req, res) => {
    const email = str(req.body.email, { field: 'Email', max: 254 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Please enter a valid email address.');
    const password = str(req.body.password, { field: 'Password', min: 8, max: 200 });
    const displayName = str(req.body.displayName, { field: 'Display name', max: 60 });
    const role = req.body.role || 'prospective';
    if (!['prospective', 'student', 'university_rep'].includes(role)) throw httpError(400, 'Invalid role.');

    let universityId = null;
    if (ROLES_WITH_AFFILIATION.has(role)) {
      universityId = intParam(req.body.universityId);
      const uni = universityId && db.prepare('SELECT id, name, email_domain FROM universities WHERE id = ?').get(universityId);
      if (!uni) throw httpError(400, 'Choose the university you belong to.');
      // Only people with an email address at the university can claim to be a student or
      // representative there. (Confirming they own that address is a TODO — see README.)
      if (!auth.emailMatchesDomain(email, uni.email_domain)) {
        throw httpError(
          400,
          uni.email_domain
            ? `To sign up as a ${role === 'student' ? 'current student' : 'representative'} of ${uni.name}, use your @${uni.email_domain} email address.`
            : `${uni.name} isn't set up for verified accounts yet.`
        );
      }
    }

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw httpError(409, 'An account with that email already exists.');
    }

    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, display_name, password_hash, role, university_id) VALUES (?, ?, ?, ?, ?)')
      .run(email, displayName, auth.hashPassword(password), role, universityId);
    const session = auth.createSession(db, Number(lastInsertRowid));
    auth.setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ user: publicUser(db, Number(lastInsertRowid)) });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = str(req.body.email, { field: 'Email', max: 254 }).toLowerCase();
    const password = str(req.body.password, { field: 'Password', max: 200 });
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw httpError(401, 'Incorrect email or password.');
    }
    const session = auth.createSession(db, user.id);
    auth.setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user: publicUser(db, user.id) });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.destroySession(db, req.sessionToken);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user });
  });

  // -------------------------------------------------------- universities

  app.get('/api/universities', (req, res) => {
    const where = [];
    const params = [];

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      where.push("(u.name LIKE ? ESCAPE '\\' OR u.city LIKE ? ESCAPE '\\' OR u.state_province LIKE ? ESCAPE '\\' OR u.country LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, like, like);
    }
    if (typeof req.query.country === 'string' && req.query.country) {
      where.push('u.country = ?');
      params.push(req.query.country);
    }
    const maxTuition = Number(req.query.maxTuitionUsd);
    if (req.query.maxTuitionUsd && Number.isFinite(maxTuition)) {
      where.push('u.intl_tuition_usd IS NOT NULL AND u.intl_tuition_usd <= ?');
      params.push(maxTuition);
    }

    const sorts = {
      name: 'u.name COLLATE NOCASE ASC',
      tuition_asc: 'u.intl_tuition_usd IS NULL, u.intl_tuition_usd ASC',
      tuition_desc: 'u.intl_tuition_usd IS NULL, u.intl_tuition_usd DESC',
      activity: 'question_count DESC, u.name COLLATE NOCASE ASC',
    };
    const orderBy = sorts[req.query.sort] || sorts.name;

    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM questions q WHERE q.university_id = u.id) AS question_count
         FROM universities u
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${orderBy}
         LIMIT 200`
      )
      .all(...params);
    res.json({ universities: rows });
  });

  app.get('/api/countries', (_req, res) => {
    const rows = db.prepare('SELECT country, COUNT(*) AS count FROM universities GROUP BY country ORDER BY country').all();
    res.json({ countries: rows });
  });

  app.get('/api/universities/:id', (req, res) => {
    const uni = db.prepare('SELECT * FROM universities WHERE id = ?').get(intParam(req.params.id));
    if (!uni) throw httpError(404, 'University not found.');
    res.json({ university: uni });
  });

  app.post('/api/universities', auth.requireAuth, (req, res) => {
    if (req.user.role !== 'admin') throw httpError(403, 'Only admins can add universities.');
    const b = req.body;
    const amount = b.intlTuitionAmount === undefined || b.intlTuitionAmount === null ? null : Number(b.intlTuitionAmount);
    const usd = b.intlTuitionUsd === undefined || b.intlTuitionUsd === null ? null : Number(b.intlTuitionUsd);
    if ((amount !== null && !Number.isFinite(amount)) || (usd !== null && !Number.isFinite(usd))) {
      throw httpError(400, 'Tuition must be a number.');
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO universities
           (name, city, state_province, country, website, contact_email, contact_phone, email_domain,
            intl_tuition_amount, tuition_currency, intl_tuition_usd, tuition_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        str(b.name, { field: 'Name', max: 200 }),
        str(b.city, { field: 'City', max: 100 }),
        optStr(b.stateProvince, { field: 'State/province', max: 100 }),
        str(b.country, { field: 'Country', max: 100 }),
        optStr(b.website, { field: 'Website' }),
        optStr(b.contactEmail, { field: 'Contact email' }),
        optStr(b.contactPhone, { field: 'Contact phone', max: 50 }),
        optStr(b.emailDomain, { field: 'Email domain', max: 100 }),
        amount === null ? null : Math.round(amount),
        optStr(b.tuitionCurrency, { field: 'Currency', max: 3 }),
        usd === null ? null : Math.round(usd),
        optStr(b.tuitionNotes, { field: 'Tuition notes' })
      );
    const uni = db.prepare('SELECT * FROM universities WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ university: uni });
  });

  // ----------------------------------------------------- discussion board

  const AUTHOR_COLUMNS = `
    usr.display_name AS author_name,
    usr.role         AS author_role,
    usr.university_id AS author_university_id,
    au.name          AS author_university_name`;

  app.get('/api/universities/:id/questions', (req, res) => {
    const uniId = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM universities WHERE id = ?').get(uniId)) throw httpError(404, 'University not found.');

    const filter = req.query.filter;
    const where = ['q.university_id = ?'];
    if (filter === 'unanswered') where.push('NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id)');

    const rows = db
      .prepare(
        `SELECT q.id, q.title, q.body, q.created_at, q.accepted_answer_id, ${AUTHOR_COLUMNS},
                (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) AS answer_count,
                EXISTS (
                  SELECT 1 FROM answers a JOIN users ua ON ua.id = a.user_id
                  WHERE a.question_id = q.id AND ua.role = 'university_rep' AND ua.university_id = q.university_id
                ) AS has_official_answer
         FROM questions q
         JOIN users usr ON usr.id = q.user_id
         LEFT JOIN universities au ON au.id = usr.university_id
         WHERE ${where.join(' AND ')}
         ORDER BY q.created_at DESC, q.id DESC
         LIMIT 200`
      )
      .all(uniId);

    res.json({
      questions: rows.map((r) => ({
        ...withBadge(r, uniId),
        has_official_answer: Boolean(r.has_official_answer),
      })),
    });
  });

  app.post('/api/universities/:id/questions', auth.requireAuth, (req, res) => {
    const uniId = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM universities WHERE id = ?').get(uniId)) throw httpError(404, 'University not found.');
    const title = str(req.body.title, { field: 'Title', min: 5, max: 200 });
    const body = str(req.body.body, { field: 'Question details', max: 5000 });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO questions (university_id, user_id, title, body) VALUES (?, ?, ?, ?)')
      .run(uniId, req.user.id, title, body);
    res.status(201).json({ question: loadQuestion(Number(lastInsertRowid)) });
  });

  app.get('/api/questions/:id', (req, res) => {
    const question = loadQuestion(intParam(req.params.id));
    if (!question) throw httpError(404, 'Question not found.');
    res.json({ question });
  });

  app.post('/api/questions/:id/answers', auth.requireAuth, (req, res) => {
    const qid = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM questions WHERE id = ?').get(qid)) throw httpError(404, 'Question not found.');
    const body = str(req.body.body, { field: 'Answer', max: 5000 });
    db.prepare('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)').run(qid, req.user.id, body);
    res.status(201).json({ question: loadQuestion(qid) });
  });

  // The person who asked can mark the answer that helped them most.
  app.post('/api/questions/:id/accept', auth.requireAuth, (req, res) => {
    const qid = intParam(req.params.id);
    const q = db.prepare('SELECT id, user_id FROM questions WHERE id = ?').get(qid);
    if (!q) throw httpError(404, 'Question not found.');
    if (q.user_id !== req.user.id) throw httpError(403, 'Only the person who asked can accept an answer.');
    const answerId = req.body.answerId === null ? null : intParam(req.body.answerId);
    if (answerId !== null && !db.prepare('SELECT 1 FROM answers WHERE id = ? AND question_id = ?').get(answerId, qid)) {
      throw httpError(400, 'That answer does not belong to this question.');
    }
    db.prepare('UPDATE questions SET accepted_answer_id = ? WHERE id = ?').run(answerId, qid);
    res.json({ question: loadQuestion(qid) });
  });

  function loadQuestion(id) {
    const q = db
      .prepare(
        `SELECT q.id, q.university_id, q.user_id, q.title, q.body, q.created_at, q.accepted_answer_id,
                un.name AS university_name, ${AUTHOR_COLUMNS}
         FROM questions q
         JOIN universities un ON un.id = q.university_id
         JOIN users usr ON usr.id = q.user_id
         LEFT JOIN universities au ON au.id = usr.university_id
         WHERE q.id = ?`
      )
      .get(id);
    if (!q) return null;
    const answers = db
      .prepare(
        `SELECT a.id, a.body, a.created_at, a.user_id, ${AUTHOR_COLUMNS}
         FROM answers a
         JOIN users usr ON usr.id = a.user_id
         LEFT JOIN universities au ON au.id = usr.university_id
         WHERE a.question_id = ?
         ORDER BY a.created_at ASC, a.id ASC`
      )
      .all(id)
      .map((a) => withBadge(a, q.university_id));
    return { ...withBadge(q, q.university_id), answers };
  }

  // ------------------------------------------------------------- static

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

function withBadge(row, boardUniversityId) {
  const { author_university_id, author_university_name, author_role, ...rest } = row;
  return {
    ...rest,
    author_role,
    author_badge: authorBadge(row, boardUniversityId),
    // Highlight posts from people who actually belong to this university.
    author_is_affiliated:
      ROLES_WITH_AFFILIATION.has(author_role) && author_university_id === boardUniversityId,
    author_is_official: author_role === 'university_rep' && author_university_id === boardUniversityId,
  };
}

function publicUser(db, id) {
  return db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.university_id, un.name AS university_name
       FROM users u LEFT JOIN universities un ON un.id = u.university_id WHERE u.id = ?`
    )
    .get(id);
}

module.exports = { createApp };
