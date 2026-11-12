'use strict';

const express = require('express');
const auth = require('../auth');
const { httpError, str, intParam } = require('../http');
const { requireHuman } = require('../protection');

const SIGNUP_ROLES = ['prospective', 'student', 'university_rep'];

module.exports = function authRoutes(db, ctx) {
  const router = express.Router();

  router.post('/signup', async (req, res) => {
    ctx.limiter.hit('signup', req.ip);
    await requireHuman(req, ctx.verifyHuman);
    const email = str(req.body.email, { field: 'Email', max: 254 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Please enter a valid email address.');
    const password = str(req.body.password, { field: 'Password', min: 8, max: 200 });
    const displayName = str(req.body.displayName, { field: 'Display name', max: 60 });
    const role = req.body.role || 'prospective';
    if (!SIGNUP_ROLES.includes(role)) throw httpError(400, 'Invalid role.');

    let universityId = null;
    let repStatus = null;
    if (role !== 'prospective') {
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
      // Students share the email domain with staff, so representatives also need an admin's approval.
      if (role === 'university_rep') repStatus = 'pending';
    }

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw httpError(409, 'An account with that email already exists.');
    }

    const { lastInsertRowid } = db
      .prepare(
        'INSERT INTO users (email, display_name, password_hash, role, university_id, rep_status) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(email, displayName, auth.hashPassword(password), role, universityId, repStatus);
    const session = auth.createSession(db, Number(lastInsertRowid));
    auth.setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ user: currentUser(db, Number(lastInsertRowid)) });
  });

  router.post('/login', (req, res) => {
    const email = str(req.body.email, { field: 'Email', max: 254 }).toLowerCase();
    const password = str(req.body.password, { field: 'Password', max: 200 });
    ctx.limiter.hit('loginIp', req.ip);
    ctx.limiter.hit('login', `${req.ip}:${email}`);
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw httpError(401, 'Incorrect email or password.');
    }
    const session = auth.createSession(db, user.id);
    auth.setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user: currentUser(db, user.id) });
  });

  router.post('/logout', (req, res) => {
    auth.destroySession(db, req.sessionToken);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ? currentUser(db, req.user.id) : null });
  });

  return router;
};

/** The logged-in user, plus counts for the badges in the navigation bar. */
function currentUser(db, id) {
  const user = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.rep_status, u.university_id, un.name AS university_name
       FROM users u LEFT JOIN universities un ON un.id = u.university_id WHERE u.id = ?`
    )
    .get(id);
  if (!user) return null;

  user.pending_requests = db
    .prepare("SELECT COUNT(*) AS n FROM connections WHERE addressee_id = ? AND status = 'pending'")
    .get(id).n;
  user.unread_messages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m JOIN connections c ON c.id = m.connection_id
       WHERE (c.requester_id = ? OR c.addressee_id = ?) AND m.sender_id <> ? AND m.read_at IS NULL`
    )
    .get(id, id, id).n;

  const moderates = user.role === 'admin' || (user.role === 'university_rep' && user.rep_status === 'approved');
  user.open_reports = moderates
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM reports WHERE status = 'open' ${user.role === 'admin' ? '' : 'AND university_id = ?'}`
        )
        .get(...(user.role === 'admin' ? [] : [user.university_id])).n
    : 0;
  return user;
}

module.exports.currentUser = currentUser;
