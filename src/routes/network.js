'use strict';

const express = require('express');
const auth = require('../auth');
const { tuple, tx, PLATFORM, directRelationSql } = require('../authz');
const { httpError, str, optStr, optNum, intParam } = require('../http');

// Only students take part in networking (the platform#networker relation); representatives
// talk through the boards.
const NETWORKER = (userIdSql) => directRelationSql('platform', `'${PLATFORM}'`, 'networker', userIdSql);
const PROFILE_ROLES = ['prospective', 'student'];
const MAX_PENDING_OUTGOING = 25;
const MAX_TARGET_UNIVERSITIES = 15;

module.exports = function networkRoutes(db, ctx) {
  const router = express.Router();
  router.use(['/me', '/people', '/connections'], auth.requireAuth);

  const targetsStmt = db.prepare(
    `SELECT un.id, un.name FROM user_target_universities t JOIN universities un ON un.id = t.university_id
     WHERE t.user_id = ? ORDER BY un.name`
  );

  /** Connection between the viewer and another user, as seen from the viewer's side. */
  const connectionStmt = db.prepare(
    `SELECT id, status, requester_id FROM connections
     WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`
  );
  function connectionWith(viewerId, otherId) {
    const c = connectionStmt.get(viewerId, otherId, otherId, viewerId);
    if (!c) return null;
    return { id: c.id, status: c.status, direction: c.requester_id === viewerId ? 'outgoing' : 'incoming' };
  }

  const PROFILE_COLUMNS = `u.id, u.display_name, u.role, u.university_id, un.name AS university_name,
    u.bio, u.home_country, u.home_city, u.program, u.intake, u.grad_year`;

  function profileCard(row, viewerId) {
    return { ...row, targets: targetsStmt.all(row.id), connection: connectionWith(viewerId, row.id) };
  }

  // ---- my own networking profile

  router.get('/me/profile', (req, res) => {
    const row = db
      .prepare(`SELECT ${PROFILE_COLUMNS} FROM users u LEFT JOIN universities un ON un.id = u.university_id WHERE u.id = ?`)
      .get(req.user.id);
    res.json({ profile: { ...row, targets: targetsStmt.all(req.user.id) } });
  });

  router.put('/me/profile', (req, res) => {
    const b = req.body || {};
    const displayName = str(b.displayName, { field: 'Display name', max: 60 });
    const values = [
      displayName,
      optStr(b.bio, { field: 'Bio', max: 1000 }),
      optStr(b.homeCountry, { field: 'Home country', max: 100 }),
      optStr(b.homeCity, { field: 'Home city', max: 100 }),
      optStr(b.program, { field: 'Program', max: 120 }),
      optStr(b.intake, { field: 'Intake', max: 40 }),
      optNum(b.gradYear, { field: 'Graduation year', max: 2100 }),
    ];

    let targetIds = null;
    if (b.targetUniversityIds !== undefined) {
      if (!Array.isArray(b.targetUniversityIds)) throw httpError(400, 'targetUniversityIds must be a list.');
      targetIds = [...new Set(b.targetUniversityIds.map(intParam).filter(Boolean))];
      if (targetIds.length > MAX_TARGET_UNIVERSITIES) {
        throw httpError(400, `You can list up to ${MAX_TARGET_UNIVERSITIES} universities you're considering.`);
      }
      const exists = db.prepare('SELECT 1 FROM universities WHERE id = ?');
      if (targetIds.some((id) => !exists.get(id))) throw httpError(400, 'Unknown university in your list.');
    }

    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE users SET display_name = ?, bio = ?, home_country = ?, home_city = ?, program = ?, intake = ?, grad_year = ?
         WHERE id = ?`
      ).run(...values, req.user.id);
      if (targetIds) {
        db.prepare('DELETE FROM user_target_universities WHERE user_id = ?').run(req.user.id);
        db.prepare("DELETE FROM relation_tuples WHERE object_type = 'university' AND relation = 'considering' AND subject_type = 'user' AND subject_id = ?")
          .run(String(req.user.id));
        const ins = db.prepare('INSERT INTO user_target_universities (user_id, university_id) VALUES (?, ?)');
        for (const id of targetIds) {
          ins.run(req.user.id, id);
          ctx.authz.write(tuple('university', id, 'considering', 'user', req.user.id));
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json({ ok: true });
  });

  // ---- people directory

  /**
   * Browse students to network with. Filters:
   *   universityId – people considering or attending this university
   *   homeCountry  – people from this country
   *   role         – 'prospective' or 'student'
   *   q            – text search over name, program and city
   * With no filters, people relevant to me come first: those considering or attending the
   * same universities I'm considering, then those from my home country.
   */
  router.get('/people', (req, res) => {
    const me = db.prepare('SELECT id, home_country, university_id FROM users WHERE id = ?').get(req.user.id);
    const where = [NETWORKER('u.id'), 'u.id <> ?'];
    const params = [me.id];

    const uniId = intParam(req.query.universityId);
    if (uniId) {
      where.push(
        '(u.university_id = ? OR EXISTS (SELECT 1 FROM user_target_universities t WHERE t.user_id = u.id AND t.university_id = ?))'
      );
      params.push(uniId, uniId);
    }
    if (typeof req.query.homeCountry === 'string' && req.query.homeCountry.trim()) {
      where.push('u.home_country = ? COLLATE NOCASE');
      params.push(req.query.homeCountry.trim());
    }
    if (PROFILE_ROLES.includes(req.query.role)) {
      where.push('u.role = ?');
      params.push(req.query.role);
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(u.display_name LIKE ? ESCAPE '\\' OR u.program LIKE ? ESCAPE '\\' OR u.home_city LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }

    // Relevance: shared universities (2 points each), same home country (1 point).
    const relevance = `(
      2 * (SELECT COUNT(*) FROM user_target_universities mine
           WHERE mine.user_id = ? AND (mine.university_id = u.university_id OR mine.university_id IN
             (SELECT t.university_id FROM user_target_universities t WHERE t.user_id = u.id)))
      + 2 * (u.university_id IS NULL AND ? IS NOT NULL AND EXISTS
             (SELECT 1 FROM user_target_universities t WHERE t.user_id = u.id AND t.university_id = ?))
      + (u.home_country IS NOT NULL AND u.home_country = ? COLLATE NOCASE)
    )`;
    const relevanceParams = [me.id, me.university_id, me.university_id, me.home_country];

    const rows = db
      .prepare(
        `SELECT ${PROFILE_COLUMNS}, ${relevance} AS relevance
         FROM users u LEFT JOIN universities un ON un.id = u.university_id
         WHERE ${where.join(' AND ')}
         ORDER BY relevance DESC, u.created_at DESC, u.id DESC
         LIMIT 100`
      )
      .all(...relevanceParams, ...params);
    res.json({ people: rows.map((r) => profileCard(r, me.id)) });
  });

  router.get('/people/:id', (req, res) => {
    const row = db
      .prepare(
        `SELECT ${PROFILE_COLUMNS} FROM users u LEFT JOIN universities un ON un.id = u.university_id
         WHERE u.id = ? AND ${NETWORKER('u.id')}`
      )
      .get(intParam(req.params.id));
    if (!row) throw httpError(404, 'Person not found.');
    res.json({ person: profileCard(row, req.user.id) });
  });

  // ---- connection requests

  function requireNetworkRole(req) {
    if (!ctx.authz.check('platform', PLATFORM, 'networker', req.user.id)) {
      throw httpError(403, 'Networking is for prospective and current students.');
    }
  }

  router.post('/connections', (req, res) => {
    requireNetworkRole(req);
    ctx.limiter.hit('connection', req.user.id);
    const otherId = intParam(req.body.userId);
    if (otherId === req.user.id) throw httpError(400, "You can't connect with yourself.");
    const other = otherId && db.prepare('SELECT id FROM users WHERE id = ?').get(otherId);
    if (!other || !ctx.authz.check('platform', PLATFORM, 'networker', other.id)) throw httpError(404, 'Person not found.');

    const existing = connectionWith(req.user.id, other.id);
    if (existing) {
      if (existing.status === 'accepted') throw httpError(409, "You're already connected.");
      if (existing.status === 'pending' && existing.direction === 'incoming') {
        throw httpError(409, 'They already sent you a request. Accept it from your requests list.');
      }
      if (existing.status === 'pending') throw httpError(409, 'Request already sent.');
      throw httpError(409, "This person isn't accepting requests from you.");
    }
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM connections WHERE requester_id = ? AND status = 'pending'")
      .get(req.user.id).n;
    if (pending >= MAX_PENDING_OUTGOING) {
      throw httpError(429, `You have ${pending} requests waiting for a reply. Wait for some answers before sending more.`);
    }

    const note = optStr(req.body.note, { field: 'Note', max: 300 });
    const id = tx(db, () => {
      const newId = Number(
        db.prepare('INSERT INTO connections (requester_id, addressee_id, note) VALUES (?, ?, ?)').run(req.user.id, other.id, note).lastInsertRowid
      );
      ctx.authz.write(tuple('connection', newId, 'requester', 'user', req.user.id), tuple('connection', newId, 'addressee', 'user', other.id));
      return newId;
    });
    res.status(201).json({ connection: { id, status: 'pending', direction: 'outgoing' } });
  });

  router.get('/connections', (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.id, c.status, c.note, c.created_at, c.requester_id,
                CASE WHEN c.requester_id = :me THEN c.addressee_id ELSE c.requester_id END AS other_id,
                (SELECT body FROM messages m WHERE m.connection_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
                (SELECT created_at FROM messages m WHERE m.connection_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at,
                (SELECT COUNT(*) FROM messages m WHERE m.connection_id = c.id AND m.sender_id <> :me AND m.read_at IS NULL) AS unread
         FROM connections c
         WHERE (c.requester_id = :me OR c.addressee_id = :me) AND c.status IN ('pending', 'accepted')
         ORDER BY COALESCE(last_message_at, c.created_at) DESC`
      )
      .all({ me: req.user.id });

    const personStmt = db.prepare(
      `SELECT ${PROFILE_COLUMNS} FROM users u LEFT JOIN universities un ON un.id = u.university_id WHERE u.id = ?`
    );
    const out = { incoming: [], outgoing: [], connected: [] };
    for (const r of rows) {
      const person = personStmt.get(r.other_id);
      const item = {
        id: r.id,
        note: r.note,
        created_at: r.created_at,
        person: { ...person, targets: targetsStmt.all(person.id) },
        last_message: r.last_message,
        last_message_at: r.last_message_at,
        unread: r.unread,
      };
      if (r.status === 'accepted') out.connected.push(item);
      else if (r.requester_id === req.user.id) out.outgoing.push(item);
      else out.incoming.push(item);
    }
    res.json(out);
  });

  function getConnection(req) {
    const c = db.prepare('SELECT * FROM connections WHERE id = ?').get(intParam(req.params.id));
    if (!c || !ctx.authz.check('connection', c.id, 'can_view', req.user.id)) {
      throw httpError(404, 'Connection not found.');
    }
    return c;
  }

  router.post('/connections/:id/respond', (req, res) => {
    const c = getConnection(req);
    if (!ctx.authz.check('connection', c.id, 'can_respond', req.user.id)) throw httpError(403, 'Only the person who received the request can respond.');
    if (c.status !== 'pending') throw httpError(409, 'This request has already been answered.');
    const status = req.body.accept === true ? 'accepted' : 'declined';
    tx(db, () => {
      db.prepare("UPDATE connections SET status = ?, responded_at = datetime('now') WHERE id = ?").run(status, c.id);
      // Accepting makes both people members, which is what allows messaging.
      if (status === 'accepted') {
        ctx.authz.write(tuple('connection', c.id, 'member', 'user', c.requester_id), tuple('connection', c.id, 'member', 'user', c.addressee_id));
      }
    });
    res.json({ connection: { id: c.id, status } });
  });

  // Withdraw a request you sent, or disconnect. A declined request can't be removed by the
  // person who sent it, so they can't simply send it again.
  router.delete('/connections/:id', (req, res) => {
    const c = getConnection(req);
    if (c.status === 'declined' && c.requester_id === req.user.id) throw httpError(404, 'Connection not found.');
    tx(db, () => {
      db.prepare('DELETE FROM connections WHERE id = ?').run(c.id);
      db.prepare("DELETE FROM relation_tuples WHERE object_type = 'connection' AND object_id = ?").run(String(c.id));
    });
    res.json({ ok: true });
  });

  // ---- messages (only between connected people)

  function getAcceptedConnection(req) {
    const c = getConnection(req);
    if (!ctx.authz.check('connection', c.id, 'can_message', req.user.id)) {
      throw httpError(403, 'You can message someone once they accept your connection request.');
    }
    return c;
  }

  router.get('/connections/:id/messages', (req, res) => {
    const c = getAcceptedConnection(req);
    const after = intParam(req.query.after) || 0;
    const messages = db
      .prepare(
        `SELECT m.id, m.sender_id, m.body, m.created_at, m.read_at
         FROM messages m WHERE m.connection_id = ? AND m.id > ?
         ORDER BY m.id ASC LIMIT 500`
      )
      .all(c.id, after);
    db.prepare(
      "UPDATE messages SET read_at = datetime('now') WHERE connection_id = ? AND sender_id <> ? AND read_at IS NULL"
    ).run(c.id, req.user.id);
    const otherId = c.requester_id === req.user.id ? c.addressee_id : c.requester_id;
    const person = db
      .prepare(`SELECT ${PROFILE_COLUMNS} FROM users u LEFT JOIN universities un ON un.id = u.university_id WHERE u.id = ?`)
      .get(otherId);
    res.json({ person, messages });
  });

  router.post('/connections/:id/messages', (req, res) => {
    const c = getAcceptedConnection(req);
    ctx.limiter.hit('message', req.user.id);
    const body = str(req.body.body, { field: 'Message', max: 2000 });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO messages (connection_id, sender_id, body) VALUES (?, ?, ?)')
      .run(c.id, req.user.id, body);
    const message = db.prepare('SELECT id, sender_id, body, created_at, read_at FROM messages WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ message });
  });

  return router;
};
