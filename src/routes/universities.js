'use strict';

const express = require('express');
const auth = require('../auth');
const { tuple, tx, PLATFORM, directRelationSql } = require('../authz');
const { httpError, str, optStr, optNum, optUrl, intParam } = require('../http');

/**
 * Fields a university's approved representatives may edit on its profile.
 * `email_domain` is deliberately missing: it decides who can claim to be a student or
 * representative there, so only admins can change it.
 */
const EDITABLE_FIELDS = {
  name: (v) => str(v, { field: 'Name', max: 200 }),
  city: (v) => str(v, { field: 'City', max: 100 }),
  state_province: (v) => optStr(v, { field: 'State/province', max: 100 }),
  country: (v) => str(v, { field: 'Country', max: 100 }),
  description: (v) => optStr(v, { field: 'Description', max: 3000 }),
  website: (v) => optUrl(v, { field: 'Website' }),
  contact_email: (v) => optStr(v, { field: 'Contact email', max: 254 }),
  contact_phone: (v) => optStr(v, { field: 'Contact phone', max: 50 }),
  intl_tuition_amount: (v) => optNum(v, { field: 'Tuition' }),
  tuition_currency: (v) => {
    const s = optStr(v, { field: 'Currency', max: 3 });
    if (s !== null && !/^[A-Za-z]{3}$/.test(s)) throw httpError(400, 'Currency must be a 3-letter code such as USD.');
    return s && s.toUpperCase();
  },
  intl_tuition_usd: (v) => optNum(v, { field: 'Tuition in USD' }),
  tuition_notes: (v) => optStr(v, { field: 'Tuition notes', max: 500 }),
  brand_color: (v) => {
    const s = optStr(v, { field: 'Brand colour', max: 7 });
    if (s !== null && !/^#[0-9a-f]{6}$/i.test(s)) throw httpError(400, 'Brand colour must be a hex colour such as #1E3765.');
    return s && s.toUpperCase();
  },
  photo_url: (v) => {
    const s = optUrl(v, { field: 'Campus photo URL' });
    if (s !== null && !s.startsWith('https://')) throw httpError(400, 'Campus photo URL must start with https://');
    return s;
  },
};

/**
 * "University active": a verified representative of the university answered on its board
 * in the last 30 days. Shown instead of answer counts so students know the university responds.
 */
const ACTIVE_SQL = `EXISTS (
  SELECT 1 FROM answers a
  JOIN questions q ON q.id = a.question_id
  JOIN users r ON r.id = a.user_id
  WHERE q.university_id = u.id AND a.hidden = 0 AND a.moderation_status = 'approved'
    AND ${directRelationSql('university', 'u.id', 'representative', 'r.id')}
    AND a.created_at >= datetime('now', '-30 days'))`;
const ADMIN_ONLY_FIELDS = {
  email_domain: (v) => {
    const s = optStr(v, { field: 'Email domain', max: 100 });
    if (s !== null && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) throw httpError(400, 'Email domain should look like example.edu');
    return s && s.toLowerCase();
  },
};

module.exports = function universityRoutes(db, ctx) {
  const can = (user, id, permission) => ctx.authz.check('university', id, permission, user?.id);
  const router = express.Router();
  const getUni = db.prepare('SELECT * FROM universities WHERE id = ?');

  router.get('/', (req, res) => {
    const where = [];
    const params = [];

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const cols = ['u.name', 'u.city', 'u.state_province', 'u.country'];
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(...cols.map(() => like));
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
        `SELECT u.id, u.name, u.city, u.state_province, u.country, u.website, u.contact_email, u.contact_phone,
                u.intl_tuition_amount, u.tuition_currency, u.intl_tuition_usd, u.brand_color, u.photo_url,
                (SELECT COUNT(*) FROM questions q WHERE q.university_id = u.id AND q.hidden = 0 AND q.moderation_status = 'approved') AS question_count,
                ${ACTIVE_SQL} AS university_active
         FROM universities u
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${orderBy}
         LIMIT 200`
      )
      .all(...params);
    res.json({ universities: rows.map((r) => ({ ...r, university_active: Boolean(r.university_active) })) });
  });

  router.get('/countries', (_req, res) => {
    const rows = db.prepare('SELECT country, COUNT(*) AS count FROM universities GROUP BY country ORDER BY country').all();
    res.json({ countries: rows });
  });

  const activeStmt = db.prepare(`SELECT ${ACTIVE_SQL} AS active FROM universities u WHERE u.id = ?`);

  router.get('/:id', (req, res) => {
    const uni = getUni.get(intParam(req.params.id));
    if (!uni) throw httpError(404, 'University not found.');
    uni.university_active = Boolean(activeStmt.get(uni.id).active);
    const stats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM relation_tuples WHERE object_type = 'university' AND object_id = CAST(? AS TEXT) AND relation = 'student') AS current_students,
           (SELECT COUNT(*) FROM relation_tuples WHERE object_type = 'university' AND object_id = CAST(? AS TEXT) AND relation = 'considering') AS considering,
           (SELECT COUNT(*) FROM relation_tuples WHERE object_type = 'university' AND object_id = CAST(? AS TEXT) AND relation = 'representative') AS representatives`
      )
      .get(String(uni.id), String(uni.id), String(uni.id));
    res.json({
      university: { ...uni, ...stats },
      can_edit: can(req.user, uni.id, 'can_edit_profile'),
      can_edit_email_domain: can(req.user, uni.id, 'can_edit_email_domain'),
    });
  });

  // Admins add universities.
  router.post('/', auth.requireAuth, (req, res) => {
    if (!ctx.authz.check('platform', PLATFORM, 'admin', req.user.id)) throw httpError(403, 'Only admins can add universities.');
    const fields = { ...EDITABLE_FIELDS, ...ADMIN_ONLY_FIELDS };
    const values = {};
    for (const [col, parse] of Object.entries(fields)) values[col] = parse(req.body[col]);
    const cols = Object.keys(values);
    const id = tx(db, () => {
      const newId = Number(
        db.prepare(`INSERT INTO universities (${cols.join(', ')}, updated_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`)
          .run(...Object.values(values), req.user.id).lastInsertRowid
      );
      ctx.authz.write(tuple('university', newId, 'platform', 'platform', PLATFORM));
      return newId;
    });
    res.status(201).json({ university: getUni.get(id) });
  });

  // Representatives keep their university's profile up to date. Only fields present in the body change.
  router.patch('/:id', auth.requireAuth, (req, res) => {
    const uni = getUni.get(intParam(req.params.id));
    if (!uni) throw httpError(404, 'University not found.');
    if (!can(req.user, uni.id, 'can_edit_profile')) {
      throw httpError(403, 'Only verified representatives of this university can edit its profile.');
    }
    const allowed = can(req.user, uni.id, 'can_edit_email_domain') ? { ...EDITABLE_FIELDS, ...ADMIN_ONLY_FIELDS } : EDITABLE_FIELDS;
    const updates = {};
    for (const key of Object.keys(req.body || {})) {
      if (!(key in allowed)) {
        throw httpError(key in ADMIN_ONLY_FIELDS ? 403 : 400, `You can't change "${key}".`);
      }
      updates[key] = allowed[key](req.body[key]);
    }
    if (Object.keys(updates).length === 0) throw httpError(400, 'Nothing to update.');

    db.prepare(
      `UPDATE universities SET ${Object.keys(updates).map((k) => `${k} = ?`).join(', ')},
         updated_at = datetime('now'), updated_by = ?
       WHERE id = ?`
    ).run(...Object.values(updates), req.user.id, uni.id);
    res.json({ university: getUni.get(uni.id) });
  });

  return router;
};
