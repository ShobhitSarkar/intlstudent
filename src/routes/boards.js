'use strict';

const express = require('express');
const auth = require('../auth');
const { httpError, str, optStr, intParam } = require('../http');

const AUTHOR_COLUMNS = `
  usr.display_name  AS author_name,
  usr.role          AS author_role,
  usr.rep_status    AS author_rep_status,
  usr.university_id AS author_university_id,
  au.name           AS author_university_name`;

const AUTHOR_JOINS = `
  JOIN users usr ON usr.id = %s.user_id
  LEFT JOIN universities au ON au.id = usr.university_id`;

/**
 * Describe who wrote a post relative to the university whose board it's on, so readers
 * can tell official answers and current students apart from other prospective students.
 */
function authorInfo(row, boardUniversityId) {
  const same = row.author_university_id === boardUniversityId;
  const official = row.author_role === 'university_rep' && row.author_rep_status === 'approved' && same;
  const currentStudent = row.author_role === 'student' && same;
  let badge;
  if (official) badge = 'University representative';
  else if (currentStudent) badge = 'Current student';
  else if (row.author_role === 'university_rep' && row.author_rep_status !== 'approved') badge = 'Unverified representative';
  else if (row.author_role === 'student' || row.author_role === 'university_rep') badge = `${row.author_university_name}`;
  else if (row.author_role === 'admin') badge = 'Moderator';
  else badge = 'Prospective student';
  return { author_badge: badge, author_is_official: official, author_is_current_student: currentStudent };
}

function present(row, boardUniversityId) {
  // eslint-disable-next-line no-unused-vars
  const { author_rep_status, author_university_id, author_university_name, ...rest } = row;
  return { ...rest, hidden: Boolean(row.hidden), ...authorInfo(row, boardUniversityId) };
}

module.exports = function boardRoutes(db) {
  const router = express.Router();

  // ---- questions on a university's board

  router.get('/universities/:id/questions', (req, res) => {
    const uniId = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM universities WHERE id = ?').get(uniId)) throw httpError(404, 'University not found.');
    const isMod = auth.canModerate(req.user, uniId);

    const where = ['q.university_id = ?'];
    const params = [uniId];
    // Hidden questions are only listed for moderators and for the person who asked.
    if (!isMod) {
      where.push('(q.hidden = 0 OR q.user_id = ?)');
      params.push(req.user?.id ?? -1);
    }
    if (req.query.filter === 'unanswered') {
      where.push('NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.hidden = 0)');
    }
    if (req.query.filter === 'official') {
      where.push(`EXISTS (
        SELECT 1 FROM answers a JOIN users ua ON ua.id = a.user_id
        WHERE a.question_id = q.id AND a.hidden = 0
          AND ((ua.role = 'university_rep' AND ua.rep_status = 'approved' AND ua.university_id = q.university_id)
               OR a.endorsed_by IS NOT NULL))`);
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(q.title LIKE ? ESCAPE '\\' OR q.body LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }

    const rows = db
      .prepare(
        `SELECT q.id, q.title, q.body, q.created_at, q.accepted_answer_id, q.hidden, ${AUTHOR_COLUMNS},
                (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id AND a.hidden = 0) AS answer_count,
                EXISTS (
                  SELECT 1 FROM answers a JOIN users ua ON ua.id = a.user_id
                  WHERE a.question_id = q.id AND a.hidden = 0
                    AND ((ua.role = 'university_rep' AND ua.rep_status = 'approved' AND ua.university_id = q.university_id)
                         OR a.endorsed_by IS NOT NULL)
                ) AS has_official_answer
         FROM questions q
         ${AUTHOR_JOINS.replace('%s', 'q')}
         WHERE ${where.join(' AND ')}
         ORDER BY q.created_at DESC, q.id DESC
         LIMIT 200`
      )
      .all(...params);

    res.json({
      questions: rows.map((r) => ({ ...present(r, uniId), has_official_answer: Boolean(r.has_official_answer) })),
      can_moderate: isMod,
    });
  });

  router.post('/universities/:id/questions', auth.requireAuth, (req, res) => {
    const uniId = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM universities WHERE id = ?').get(uniId)) throw httpError(404, 'University not found.');
    const title = str(req.body.title, { field: 'Title', min: 5, max: 200 });
    const body = str(req.body.body, { field: 'Question details', max: 5000 });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO questions (university_id, user_id, title, body) VALUES (?, ?, ?, ?)')
      .run(uniId, req.user.id, title, body);
    res.status(201).json({ question: loadQuestion(Number(lastInsertRowid), req.user) });
  });

  router.get('/questions/:id', (req, res) => {
    const question = loadQuestion(intParam(req.params.id), req.user);
    if (!question) throw httpError(404, 'Question not found.');
    res.json({ question });
  });

  // ---- answers

  router.post('/questions/:id/answers', auth.requireAuth, (req, res) => {
    const q = db.prepare('SELECT id, hidden, user_id, university_id FROM questions WHERE id = ?').get(intParam(req.params.id));
    if (!q || (q.hidden && !auth.canModerate(req.user, q.university_id) && q.user_id !== req.user.id)) {
      throw httpError(404, 'Question not found.');
    }
    if (q.hidden) throw httpError(403, 'This question has been hidden by a moderator and is closed to new answers.');
    const body = str(req.body.body, { field: 'Answer', max: 5000 });
    db.prepare('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)').run(q.id, req.user.id, body);
    res.status(201).json({ question: loadQuestion(q.id, req.user) });
  });

  // The person who asked can mark the answer that helped them most (or clear it with null).
  router.post('/questions/:id/accept', auth.requireAuth, (req, res) => {
    const q = db.prepare('SELECT id, user_id FROM questions WHERE id = ?').get(intParam(req.params.id));
    if (!q) throw httpError(404, 'Question not found.');
    if (q.user_id !== req.user.id) throw httpError(403, 'Only the person who asked can accept an answer.');
    const answerId = req.body.answerId === null ? null : intParam(req.body.answerId);
    if (
      answerId !== null &&
      !db.prepare('SELECT 1 FROM answers WHERE id = ? AND question_id = ? AND hidden = 0').get(answerId, q.id)
    ) {
      throw httpError(400, 'That answer does not belong to this question.');
    }
    db.prepare('UPDATE questions SET accepted_answer_id = ? WHERE id = ?').run(answerId, q.id);
    res.json({ question: loadQuestion(q.id, req.user) });
  });

  // ---- moderation

  /** Look up a question or answer and the university board it belongs to. */
  function findTarget(type, id) {
    if (type === 'question') {
      return db.prepare("SELECT id, university_id, user_id, 'question' AS type FROM questions WHERE id = ?").get(id);
    }
    if (type === 'answer') {
      return db
        .prepare(
          `SELECT a.id, q.university_id, a.user_id, a.question_id, 'answer' AS type
           FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.id = ?`
        )
        .get(id);
    }
    return null;
  }

  function requireModerator(req, target) {
    if (!target) throw httpError(404, 'Post not found.');
    if (!auth.canModerate(req.user, target.university_id)) {
      throw httpError(403, "Only this university's verified representatives can moderate its board.");
    }
  }

  // Any logged-in user can flag a post for the university's moderators.
  router.post('/reports', auth.requireAuth, (req, res) => {
    const type = req.body.targetType;
    const target = findTarget(type, intParam(req.body.targetId));
    if (!target) throw httpError(404, 'Post not found.');
    const reason = str(req.body.reason, { field: 'Reason', max: 500 });
    const existing = db
      .prepare("SELECT id FROM reports WHERE target_type = ? AND target_id = ? AND reporter_id = ?")
      .get(type, target.id, req.user.id);
    if (existing) {
      db.prepare("UPDATE reports SET reason = ?, status = 'open', resolved_by = NULL WHERE id = ?").run(reason, existing.id);
    } else {
      db.prepare(
        'INSERT INTO reports (target_type, target_id, university_id, reporter_id, reason) VALUES (?, ?, ?, ?, ?)'
      ).run(type, target.id, target.university_id, req.user.id, reason);
    }
    res.status(201).json({ ok: true });
  });

  for (const type of ['question', 'answer']) {
    const table = `${type}s`;

    // Hide or restore a post. Hidden posts disappear for everyone except moderators and their author.
    router.post(`/${table}/:id/hide`, auth.requireAuth, (req, res) => {
      const target = findTarget(type, intParam(req.params.id));
      requireModerator(req, target);
      const hidden = req.body.hidden !== false;
      const reason = hidden ? optStr(req.body.reason, { field: 'Reason', max: 500 }) : null;
      db.prepare(`UPDATE ${table} SET hidden = ?, hidden_reason = ?, hidden_by = ? WHERE id = ?`).run(
        hidden ? 1 : 0,
        reason,
        hidden ? req.user.id : null,
        target.id
      );
      if (hidden) {
        db.prepare(
          "UPDATE reports SET status = 'resolved', resolved_by = ? WHERE target_type = ? AND target_id = ? AND status = 'open'"
        ).run(req.user.id, type, target.id);
        if (type === 'answer') {
          db.prepare('UPDATE questions SET accepted_answer_id = NULL WHERE id = ? AND accepted_answer_id = ?').run(
            target.question_id,
            target.id
          );
        }
      }
      res.json({ question: loadQuestion(type === 'question' ? target.id : target.question_id, req.user) });
    });
  }

  // A representative vouches that an answer (e.g. from a current student) is accurate.
  router.post('/answers/:id/endorse', auth.requireAuth, (req, res) => {
    const target = findTarget('answer', intParam(req.params.id));
    requireModerator(req, target);
    const endorsed = req.body.endorsed !== false;
    db.prepare('UPDATE answers SET endorsed_by = ? WHERE id = ?').run(endorsed ? req.user.id : null, target.id);
    res.json({ question: loadQuestion(target.question_id, req.user) });
  });

  // Moderation queue for a university: open reports with the reported content.
  router.get('/universities/:id/reports', auth.requireAuth, (req, res) => {
    const uniId = intParam(req.params.id);
    if (!auth.canModerate(req.user, uniId)) throw httpError(403, "Only this university's verified representatives can see reports.");
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    const rows = db
      .prepare(
        `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
                rep.display_name AS reporter_name,
                CASE r.target_type WHEN 'question' THEN q.title ELSE NULL END AS question_title,
                CASE r.target_type WHEN 'question' THEN q.body ELSE a.body END AS content,
                CASE r.target_type WHEN 'question' THEN q.hidden ELSE a.hidden END AS hidden,
                CASE r.target_type WHEN 'question' THEN q.id ELSE a.question_id END AS question_id,
                author.display_name AS author_name
         FROM reports r
         JOIN users rep ON rep.id = r.reporter_id
         LEFT JOIN questions q ON r.target_type = 'question' AND q.id = r.target_id
         LEFT JOIN answers a   ON r.target_type = 'answer'   AND a.id = r.target_id
         LEFT JOIN users author ON author.id = COALESCE(q.user_id, a.user_id)
         WHERE r.university_id = ? AND r.status = ?
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 200`
      )
      .all(uniId, status);
    res.json({ reports: rows.map((r) => ({ ...r, hidden: Boolean(r.hidden) })) });
  });

  // Dismiss a report without hiding the post.
  router.post('/reports/:id/resolve', auth.requireAuth, (req, res) => {
    const report = db.prepare('SELECT id, university_id FROM reports WHERE id = ?').get(intParam(req.params.id));
    if (!report) throw httpError(404, 'Report not found.');
    if (!auth.canModerate(req.user, report.university_id)) throw httpError(403, 'Not allowed.');
    db.prepare("UPDATE reports SET status = 'resolved', resolved_by = ? WHERE id = ?").run(req.user.id, report.id);
    res.json({ ok: true });
  });

  // ---- loading a full question

  function loadQuestion(id, viewer) {
    const q = db
      .prepare(
        `SELECT q.id, q.university_id, q.user_id, q.title, q.body, q.created_at, q.accepted_answer_id,
                q.hidden, q.hidden_reason, un.name AS university_name, ${AUTHOR_COLUMNS}
         FROM questions q
         JOIN universities un ON un.id = q.university_id
         ${AUTHOR_JOINS.replace('%s', 'q')}
         WHERE q.id = ?`
      )
      .get(id);
    if (!q) return null;
    const isMod = auth.canModerate(viewer, q.university_id);
    const viewerId = viewer?.id ?? -1;
    if (q.hidden && !isMod && q.user_id !== viewerId) return null;

    const answers = db
      .prepare(
        `SELECT a.id, a.body, a.created_at, a.user_id, a.hidden, a.hidden_reason,
                a.endorsed_by IS NOT NULL AS endorsed, ${AUTHOR_COLUMNS}
         FROM answers a
         ${AUTHOR_JOINS.replace('%s', 'a')}
         WHERE a.question_id = ? ${isMod ? '' : 'AND (a.hidden = 0 OR a.user_id = ?)'}
         ORDER BY a.created_at ASC, a.id ASC`
      )
      .all(...(isMod ? [id] : [id, viewerId]))
      .map((a) => ({ ...present(a, q.university_id), endorsed: Boolean(a.endorsed) }));

    // Official and endorsed answers first, then the accepted one, then oldest first.
    answers.sort((x, y) => rank(y, q) - rank(x, q));

    return { ...present(q, q.university_id), answers, can_moderate: isMod };
  }

  function rank(a, q) {
    return (a.author_is_official || a.endorsed ? 2 : 0) + (a.id === q.accepted_answer_id ? 1 : 0);
  }

  return router;
};
