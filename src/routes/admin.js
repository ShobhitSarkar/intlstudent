'use strict';

const express = require('express');
const auth = require('../auth');
const { httpError, intParam } = require('../http');

module.exports = function adminRoutes(db) {
  const router = express.Router();
  router.use(auth.requireAuth, (req, _res, next) => {
    if (req.user.role !== 'admin') throw httpError(403, 'Admins only.');
    next();
  });

  // Representatives waiting for approval (or all of them with ?status=approved).
  router.get('/reps', (req, res) => {
    const status = req.query.status === 'approved' ? 'approved' : 'pending';
    const reps = db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.rep_status, u.created_at, u.university_id, un.name AS university_name
         FROM users u JOIN universities un ON un.id = u.university_id
         WHERE u.role = 'university_rep' AND u.rep_status = ?
         ORDER BY u.created_at ASC`
      )
      .all(status);
    res.json({ reps });
  });

  router.post('/reps/:id/approve', (req, res) => {
    const { changes } = db
      .prepare("UPDATE users SET rep_status = 'approved' WHERE id = ? AND role = 'university_rep'")
      .run(intParam(req.params.id));
    if (!changes) throw httpError(404, 'Representative not found.');
    res.json({ ok: true });
  });

  // Rejecting (or revoking) turns the account into a regular prospective-student account.
  router.post('/reps/:id/reject', (req, res) => {
    const { changes } = db
      .prepare(
        "UPDATE users SET role = 'prospective', rep_status = NULL, university_id = NULL WHERE id = ? AND role = 'university_rep'"
      )
      .run(intParam(req.params.id));
    if (!changes) throw httpError(404, 'Representative not found.');
    res.json({ ok: true });
  });

  return router;
};
