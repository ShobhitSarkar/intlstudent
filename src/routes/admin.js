'use strict';

const express = require('express');
const auth = require('../auth');
const { tuple, tx, PLATFORM } = require('../authz');
const { httpError, intParam } = require('../http');

module.exports = function adminRoutes(db, ctx) {
  const router = express.Router();
  router.use(auth.requireAuth, (req, _res, next) => {
    if (!ctx.authz.check('platform', PLATFORM, 'admin', req.user.id)) throw httpError(403, 'Admins only.');
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

  const getRep = (id) => db.prepare("SELECT id, university_id FROM users WHERE id = ? AND role = 'university_rep'").get(intParam(id));

  // Approving grants the representative relation on their university.
  router.post('/reps/:id/approve', (req, res) => {
    const rep = getRep(req.params.id);
    if (!rep) throw httpError(404, 'Representative not found.');
    tx(db, () => {
      db.prepare("UPDATE users SET rep_status = 'approved' WHERE id = ?").run(rep.id);
      ctx.authz.write(tuple('university', rep.university_id, 'representative', 'user', rep.id));
    });
    res.json({ ok: true });
  });

  // Rejecting (or revoking) turns the account into a regular prospective-student account.
  router.post('/reps/:id/reject', (req, res) => {
    const rep = getRep(req.params.id);
    if (!rep) throw httpError(404, 'Representative not found.');
    tx(db, () => {
      db.prepare("UPDATE users SET role = 'prospective', rep_status = NULL, university_id = NULL WHERE id = ?").run(rep.id);
      ctx.authz.delete(tuple('university', rep.university_id, 'representative', 'user', rep.id));
      ctx.authz.write(tuple('platform', PLATFORM, 'networker', 'user', rep.id));
    });
    res.json({ ok: true });
  });

  return router;
};
