'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS universities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  city                TEXT    NOT NULL,
  state_province      TEXT,
  country             TEXT    NOT NULL,
  website             TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  -- Email domain used to check that current students / staff really belong here.
  email_domain        TEXT,
  -- Tuition for international undergraduates, in the university's own currency.
  intl_tuition_amount INTEGER,
  tuition_currency    TEXT,
  -- Same figure converted to USD so universities can be filtered and sorted together.
  intl_tuition_usd    INTEGER,
  tuition_notes       TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'prospective'
                CHECK (role IN ('prospective', 'student', 'university_rep', 'admin')),
  university_id INTEGER REFERENCES universities(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id      INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT    NOT NULL,
  body               TEXT    NOT NULL,
  accepted_answer_id INTEGER,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_university ON questions(university_id, created_at);
CREATE INDEX IF NOT EXISTS idx_answers_question     ON answers(question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_universities_country ON universities(country);
`;

/**
 * Open (and create if needed) the SQLite database.
 * Pass ':memory:' for an in-memory database (used by tests).
 */
function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'intlstudent.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
