'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Moderation states for posts: 'approved' posts are public; 'held' posts wait for a person to
// review them (only the author and moderators can see them); 'rejected' posts stay hidden.
const MODERATION_STATUS = "TEXT NOT NULL DEFAULT 'approved' CHECK (moderation_status IN ('approved', 'held', 'rejected'))";

/** Questions: user_id is NULL for guest questions, which may carry a guest_name. */
const QUESTIONS_DDL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id      INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_name         TEXT,
  title              TEXT    NOT NULL,
  body               TEXT    NOT NULL,
  accepted_answer_id INTEGER,
  moderation_status  ${MODERATION_STATUS},
  moderation_reason  TEXT,
  hidden             INTEGER NOT NULL DEFAULT 0,
  hidden_reason      TEXT,
  hidden_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);`;

/** Answers always come from someone with a profile; guests can only ask. */
const ANSWERS_DDL = `CREATE TABLE IF NOT EXISTS answers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id       INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              TEXT    NOT NULL,
  -- A university representative can confirm an answer as accurate.
  endorsed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderation_status ${MODERATION_STATUS},
  moderation_reason TEXT,
  hidden            INTEGER NOT NULL DEFAULT 0,
  hidden_reason     TEXT,
  hidden_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);`;

/** Reports: reporter_id is NULL when the automatic moderator raised it. */
const REPORTS_DDL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT    NOT NULL CHECK (target_type IN ('question', 'answer')),
  target_id     INTEGER NOT NULL,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  reporter_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  source        TEXT    NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'auto')),
  reason        TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (target_type, target_id, reporter_id)
);`;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS universities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  city                TEXT    NOT NULL,
  state_province      TEXT,
  country             TEXT    NOT NULL,
  description         TEXT,
  website             TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  -- Email domain used to check that current students / staff really belong here.
  -- Only admins can change it, because it controls who can claim an affiliation.
  email_domain        TEXT,
  -- Tuition for international undergraduates, in the university's own currency.
  intl_tuition_amount INTEGER,
  tuition_currency    TEXT,
  -- Same figure converted to USD so universities can be filtered and sorted together.
  intl_tuition_usd    INTEGER,
  tuition_notes       TEXT,
  -- Branding: the university's colour (hex) and a campus photo URL for its page and card.
  brand_color         TEXT,
  photo_url           TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'prospective'
                CHECK (role IN ('prospective', 'student', 'university_rep', 'admin')),
  -- The university a current student attends / a representative works for.
  university_id INTEGER REFERENCES universities(id) ON DELETE SET NULL,
  -- University representatives must be approved by an admin before they get any powers.
  rep_status    TEXT    CHECK (rep_status IN ('pending', 'approved')),
  -- Networking profile
  bio           TEXT,
  home_country  TEXT,
  home_city     TEXT,
  program       TEXT,     -- e.g. "MS Computer Science"
  intake        TEXT,     -- prospective: when they plan to start, e.g. "Fall 2027"
  grad_year     INTEGER,  -- current students
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Universities a prospective student is considering (shown on their profile and used for matching).
CREATE TABLE IF NOT EXISTS user_target_universities (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, university_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- ------------------------------------------------------------ discussion boards

${QUESTIONS_DDL('questions')}

${ANSWERS_DDL}

-- Posts flagged by people (source 'user') or by the automatic moderator (source 'auto').
-- Open ones form the university's moderation queue.
${REPORTS_DDL('reports')}

-- ------------------------------------------------------------------ networking

-- One row per pair of people. Messaging is only possible once status = 'accepted'.
CREATE TABLE IF NOT EXISTS connections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  CHECK (requester_id <> addressee_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT    NOT NULL,
  read_at       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_university ON questions(university_id, created_at);
CREATE INDEX IF NOT EXISTS idx_answers_question     ON answers(question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_universities_country ON universities(country);
CREATE INDEX IF NOT EXISTS idx_reports_university   ON reports(university_id, status);
CREATE INDEX IF NOT EXISTS idx_connections_requester ON connections(requester_id);
CREATE INDEX IF NOT EXISTS idx_connections_addressee ON connections(addressee_id);
CREATE INDEX IF NOT EXISTS idx_messages_connection  ON messages(connection_id, created_at);
CREATE INDEX IF NOT EXISTS idx_targets_university   ON user_target_universities(university_id);
`;

const LATEST_VERSION = 2;

/**
 * Open (and create if needed) the SQLite database.
 * Pass ':memory:' for an in-memory database (used by tests).
 */
function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'intlstudent.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'universities'").get();
  if (fresh) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION}`);
  } else {
    migrate(db);
    db.exec(SCHEMA); // creates any tables or indexes that are new since the database was made
  }
  return db;
}

const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

/** Bring an existing database up to the latest schema, one version at a time. */
function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;

  if (version < 1) {
    // v1: university branding.
    for (const col of ['brand_color', 'photo_url']) {
      if (!hasColumn(db, 'universities', col)) db.exec(`ALTER TABLE universities ADD COLUMN ${col} TEXT`);
    }
    db.exec('PRAGMA user_version = 1');
    version = 1;
  }

  if (version < 2) {
    // v2: guest questions (nullable user_id), automatic moderation, reports raised by the moderator.
    // SQLite can't relax NOT NULL in place, so questions and reports are rebuilt.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(QUESTIONS_DDL('questions_v2'));
      db.exec(`INSERT INTO questions_v2 (id, university_id, user_id, title, body, accepted_answer_id, hidden, hidden_reason, hidden_by, created_at)
               SELECT id, university_id, user_id, title, body, accepted_answer_id, hidden, hidden_reason, hidden_by, created_at FROM questions`);
      db.exec('DROP TABLE questions');
      db.exec('ALTER TABLE questions_v2 RENAME TO questions');

      db.exec(REPORTS_DDL('reports_v2'));
      db.exec(`INSERT INTO reports_v2 (id, target_type, target_id, university_id, reporter_id, reason, status, resolved_by, created_at)
               SELECT id, target_type, target_id, university_id, reporter_id, reason, status, resolved_by, created_at FROM reports`);
      db.exec('DROP TABLE reports');
      db.exec('ALTER TABLE reports_v2 RENAME TO reports');

      if (!hasColumn(db, 'answers', 'moderation_status')) db.exec(`ALTER TABLE answers ADD COLUMN moderation_status ${MODERATION_STATUS}`);
      if (!hasColumn(db, 'answers', 'moderation_reason')) db.exec('ALTER TABLE answers ADD COLUMN moderation_reason TEXT');
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

module.exports = { openDb, LATEST_VERSION };
