'use strict';

const express = require('express');
const auth = require('../auth');
const { httpError, str, intParam } = require('../http');
const { requireHuman } = require('../protection');
const { tuple, tx, PLATFORM } = require('../authz');

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

    const passwordHash = auth.hashPassword(password);
    const userId = tx(db, () => {
      const id = Number(
        db.prepare('INSERT INTO users (email, display_name, password_hash, role, university_id, rep_status) VALUES (?, ?, ?, ?, ?, ?)')
          .run(email, displayName, passwordHash, role, universityId, repStatus).lastInsertRowid
      );
      // Grants: students network; current students are verified by their email domain.
      // Representatives get nothing until an admin approves them.
      if (role !== 'university_rep') ctx.authz.write(tuple('platform', PLATFORM, 'networker', 'user', id));
      if (role === 'student') ctx.authz.write(tuple('university', universityId, 'student', 'user', id));
      return id;
    });
    const session = auth.createSession(db, userId);
    auth.setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ user: currentUser(db, ctx.authz, userId) });
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
    res.json({ user: currentUser(db, ctx.authz, user.id) });
  });

  router.post('/logout', (req, res) => {
    auth.destroySession(db, req.sessionToken);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ? currentUser(db, ctx.authz, req.user.id) : null });
  });

  return router;
};

/** The logged-in user, what they're allowed to do, and counts for the navigation bar. */
function currentUser(db, authz, id) {
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

  user.is_admin = authz.check('platform', PLATFORM, 'admin', id);
  user.can_network = authz.check('platform', PLATFORM, 'networker', id);
  // Universities whose boards this user moderates (every university, for admins).
  user.moderates = authz.listObjects('university', 'can_moderate', id);
  user.open_reports = user.moderates.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open' AND university_id IN (${user.moderates.map(() => '?').join(',')})`)
        .get(...user.moderates).n
    : 0;
  return user;
}

module.exports.currentUser = currentUser;
