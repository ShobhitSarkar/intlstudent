'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seedIfEmpty, DEMO_PASSWORD } = require('../src/seed');

let server;
let base;
let db;

before(async () => {
  db = openDb(':memory:');
  seedIfEmpty(db, { log: false });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

/** Minimal client that keeps its own session cookie. */
function client() {
  let cookie = '';
  async function call(method, path, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    login: (email) => call('POST', '/auth/login', { email, password: DEMO_PASSWORD }),
  };
}

const uniId = (name) => db.prepare('SELECT id FROM universities WHERE name = ?').get(name).id;

// ---------------------------------------------------------------- universities

test('lists, searches, filters and sorts universities', async () => {
  const c = client();
  const all = await c.get('/universities');
  assert.equal(all.status, 200);
  assert.ok(all.body.universities.length >= 10);

  const canada = await c.get('/universities?country=Canada');
  assert.ok(canada.body.universities.every((u) => u.country === 'Canada'));

  const search = await c.get('/universities?q=toronto');
  assert.deepEqual(search.body.universities.map((u) => u.name), ['University of Toronto']);

  const cheap = await c.get('/universities?maxTuitionUsd=30000&sort=tuition_asc');
  const fees = cheap.body.universities.map((u) => u.intl_tuition_usd);
  assert.ok(fees.every((f) => f <= 30000));
  assert.deepEqual(fees, [...fees].sort((a, b) => a - b));

  // LIKE wildcards are treated literally
  assert.equal((await c.get('/universities?q=%25')).body.universities.length, 0);
});

test('university detail includes contact info and community stats', async () => {
  const { body } = await client().get(`/universities/${uniId('University of Toronto')}`);
  assert.equal(body.university.website, 'https://www.utoronto.ca');
  assert.equal(body.university.current_students, 1);
  assert.ok(body.university.considering >= 2);
  assert.equal(body.can_edit, false);
});

// ---------------------------------------------------------------- signup rules

test('student and rep signups require a university email; reps start unverified', async () => {
  const c = client();
  const toronto = uniId('University of Toronto');
  const bad = await c.post('/auth/signup', {
    email: 'someone@gmail.com', password: 'longpassword', displayName: 'X', role: 'student', universityId: toronto,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /utoronto\.ca/);

  const ok = await c.post('/auth/signup', {
    email: 'newstudent@mail.utoronto.ca', password: 'longpassword', displayName: 'New', role: 'student', universityId: toronto,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'student');

  const rep = client();
  const r = await rep.post('/auth/signup', {
    email: 'staff@utoronto.ca', password: 'longpassword', displayName: 'Staff', role: 'university_rep', universityId: toronto,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.rep_status, 'pending');
  // An unverified rep can't edit the profile yet...
  assert.equal((await rep.patch(`/universities/${toronto}`, { description: 'hi' })).status, 403);

  // ...until an admin approves them.
  const admin = client();
  await admin.login('admin@intlstudent.test');
  const pending = await admin.get('/admin/reps');
  const me = pending.body.reps.find((x) => x.email === 'staff@utoronto.ca');
  assert.ok(me);
  assert.equal((await admin.post(`/admin/reps/${me.id}/approve`)).status, 200);
  assert.equal((await rep.patch(`/universities/${toronto}`, { description: 'Welcome!' })).status, 200);
});

test('rejects duplicate emails, weak passwords and non-JSON posts', async () => {
  const c = client();
  assert.equal((await c.post('/auth/signup', { email: 'priya@example.com', password: 'longpassword', displayName: 'P' })).status, 409);
  assert.equal((await c.post('/auth/signup', { email: 'a@b.co', password: 'short', displayName: 'P' })).status, 400);
  const form = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=x',
  });
  assert.equal(form.status, 415);
});

// ---------------------------------------------------------------- university profile editing

test('representatives edit their own university only, and not the email domain', async () => {
  const rep = client();
  await rep.login('admissions@utoronto.ca');
  const toronto = uniId('University of Toronto');

  const res = await rep.patch(`/universities/${toronto}`, {
    intl_tuition_amount: 64000, tuition_currency: 'cad', intl_tuition_usd: 47000, contact_phone: '+1 416 000 0000',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.university.intl_tuition_amount, 64000);
  assert.equal(res.body.university.tuition_currency, 'CAD');

  assert.equal((await rep.patch(`/universities/${toronto}`, { email_domain: 'gmail.com' })).status, 403);
  assert.equal((await rep.patch(`/universities/${toronto}`, { website: 'javascript:alert(1)' })).status, 400);
  assert.equal((await rep.patch(`/universities/${uniId('McGill University')}`, { description: 'x' })).status, 403);

  const student = client();
  await student.login('maria@utoronto.ca');
  assert.equal((await student.patch(`/universities/${toronto}`, { description: 'x' })).status, 403);
});

// ---------------------------------------------------------------- discussion boards

test('ask and answer; badges distinguish reps, current students and prospects', async () => {
  const toronto = uniId('University of Toronto');
  const prospect = client();
  await prospect.login('priya@example.com');
  const asked = await prospect.post(`/universities/${toronto}/questions`, {
    title: 'Are there scholarships for international students?', body: 'Merit or need-based?',
  });
  assert.equal(asked.status, 201);
  const qid = asked.body.question.id;

  const student = client();
  await student.login('maria@utoronto.ca');
  await student.post(`/questions/${qid}/answers`, { body: 'I got an entrance scholarship.' });
  const rep = client();
  await rep.login('admissions@utoronto.ca');
  await rep.post(`/questions/${qid}/answers`, { body: 'Yes, see our awards page.' });
  const other = client();
  await other.login('arjun@example.com');
  await other.post(`/questions/${qid}/answers`, { body: 'Following!' });

  const { body } = await client().get(`/questions/${qid}`);
  const badges = Object.fromEntries(body.question.answers.map((a) => [a.author_name, a.author_badge]));
  assert.equal(badges.Maria, 'Current student');
  assert.equal(badges['U of T International Admissions'], 'University representative');
  assert.equal(badges.Arjun, 'Prospective student');
  // The official answer is shown first.
  assert.equal(body.question.answers[0].author_is_official, true);
  assert.equal(body.question.answers.some((a) => 'email' in a), false);

  // Only the asker can accept an answer.
  const answerId = body.question.answers.find((a) => a.author_name === 'Maria').id;
  assert.equal((await other.post(`/questions/${qid}/accept`, { answerId })).status, 403);
  assert.equal((await prospect.post(`/questions/${qid}/accept`, { answerId })).body.question.accepted_answer_id, answerId);

  const official = await client().get(`/universities/${toronto}/questions?filter=official`);
  assert.ok(official.body.questions.some((q) => q.id === qid));
});

test('must be logged in to post', async () => {
  const res = await client().post(`/universities/${uniId('UNSW Sydney')}/questions`, { title: 'Hello there', body: 'x' });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------- moderation

test('reports, hiding and endorsing are limited to the board’s verified reps', async () => {
  const toronto = uniId('University of Toronto');
  const troll = client();
  await troll.login('chen@example.com');
  const q = (await troll.post(`/universities/${toronto}/questions`, { title: 'Buy cheap essays here', body: 'spam link' })).body.question;

  const reporter = client();
  await reporter.login('arjun@example.com');
  assert.equal((await reporter.post('/reports', { targetType: 'question', targetId: q.id, reason: 'Spam' })).status, 201);

  // Another university's... well, a student, can't moderate.
  const student = client();
  await student.login('maria@utoronto.ca');
  assert.equal((await student.post(`/questions/${q.id}/hide`, { reason: 'x' })).status, 403);
  assert.equal((await student.get(`/universities/${toronto}/reports`)).status, 403);

  const rep = client();
  await rep.login('admissions@utoronto.ca');
  const queue = await rep.get(`/universities/${toronto}/reports`);
  assert.ok(queue.body.reports.some((r) => r.target_id === q.id && r.reason === 'Spam'));

  assert.equal((await rep.post(`/questions/${q.id}/hide`, { reason: 'Spam' })).status, 200);
  // Hidden from the public, still visible to its author with the reason.
  assert.equal((await client().get(`/questions/${q.id}`)).status, 404);
  const list = await client().get(`/universities/${toronto}/questions`);
  assert.ok(!list.body.questions.some((x) => x.id === q.id));
  const own = await troll.get(`/questions/${q.id}`);
  assert.equal(own.body.question.hidden, true);
  assert.equal(own.body.question.hidden_reason, 'Spam');
  // Hiding resolved the report.
  assert.ok(!(await rep.get(`/universities/${toronto}/reports`)).body.reports.some((r) => r.target_id === q.id));

  // Endorse a student's answer.
  const qid = db.prepare("SELECT id FROM questions WHERE title LIKE 'Is first-year residence%'").get().id;
  const mariaAnswer = db.prepare('SELECT a.id FROM answers a JOIN users u ON u.id = a.user_id WHERE a.question_id = ? AND u.display_name = ?').get(qid, 'Maria').id;
  const endorsed = await rep.post(`/answers/${mariaAnswer}/endorse`, {});
  assert.equal(endorsed.body.question.answers.find((a) => a.id === mariaAnswer).endorsed, true);

  // The Toronto rep can't moderate Iowa State's board.
  const iowaQ = db.prepare('SELECT id FROM questions WHERE university_id = ?').get(uniId('Iowa State University')).id;
  assert.equal((await rep.post(`/questions/${iowaQ}/hide`, {})).status, 403);
});

// ---------------------------------------------------------------- networking

test('directory ranks people with shared universities and home country first', async () => {
  const priya = client();
  await priya.login('priya@example.com');
  const { body } = await priya.get('/people');
  const names = body.people.map((p) => p.display_name);
  assert.equal(names[0], 'Arjun'); // shares Toronto + UBC and is from India
  assert.ok(!names.includes('Priya'));
  assert.ok(!names.includes('U of T International Admissions')); // reps aren't in the directory
  assert.ok(body.people.every((p) => !('email' in p)));

  const atToronto = await priya.get(`/people?universityId=${uniId('University of Toronto')}`);
  assert.ok(atToronto.body.people.some((p) => p.display_name === 'Maria'));
  assert.ok(!atToronto.body.people.some((p) => p.display_name === 'Chen'));

  assert.equal((await client().get('/people')).status, 401);
});

test('connection requests gate messaging', async () => {
  const chen = client();
  await chen.login('chen@example.com');
  const rahulId = db.prepare("SELECT id FROM users WHERE email = 'rahul@iastate.edu'").get().id;

  const req = await chen.post('/connections', { userId: rahulId, note: 'Hi!' });
  assert.equal(req.status, 201);
  const cid = req.body.connection.id;
  assert.equal((await chen.post('/connections', { userId: rahulId })).status, 409);

  // No messaging before acceptance.
  assert.equal((await chen.post(`/connections/${cid}/messages`, { body: 'hello?' })).status, 403);
  // The requester can't accept their own request.
  assert.equal((await chen.post(`/connections/${cid}/respond`, { accept: true })).status, 403);

  const rahul = client();
  await rahul.login('rahul@iastate.edu');
  const inbox = await rahul.get('/connections');
  assert.ok(inbox.body.incoming.some((c) => c.id === cid && c.note === 'Hi!'));
  assert.equal((await rahul.post(`/connections/${cid}/respond`, { accept: true })).status, 200);

  assert.equal((await chen.post(`/connections/${cid}/messages`, { body: 'Thanks for accepting!' })).status, 201);
  assert.equal((await rahul.get('/auth/me')).body.user.unread_messages, 1);
  const thread = await rahul.get(`/connections/${cid}/messages`);
  assert.equal(thread.body.messages.at(-1).body, 'Thanks for accepting!');
  assert.equal((await rahul.get('/auth/me')).body.user.unread_messages, 0);

  // Outsiders can't read the conversation.
  const outsider = client();
  await outsider.login('arjun@example.com');
  assert.equal((await outsider.get(`/connections/${cid}/messages`)).status, 404);
});

test('declined requests cannot be re-sent', async () => {
  const maria = client();
  await maria.login('maria@utoronto.ca');
  const arjunId = db.prepare("SELECT id FROM users WHERE email = 'arjun@example.com'").get().id;
  const cid = (await maria.post('/connections', { userId: arjunId })).body.connection.id;

  const arjun = client();
  await arjun.login('arjun@example.com');
  await arjun.post(`/connections/${cid}/respond`, { accept: false });

  assert.equal((await maria.del(`/connections/${cid}`)).status, 404);
  assert.equal((await maria.post('/connections', { userId: arjunId })).status, 409);
});

test('profile updates, including universities being considered', async () => {
  const chen = client();
  await chen.login('chen@example.com');
  const ids = [uniId('UNSW Sydney'), uniId('University of Melbourne')];
  const res = await chen.put('/me/profile', {
    displayName: 'Chen W.', homeCountry: 'China', homeCity: 'Shanghai', program: 'Commerce', intake: 'Fall 2027',
    targetUniversityIds: ids,
  });
  assert.equal(res.status, 200);
  const { body } = await chen.get('/me/profile');
  assert.equal(body.profile.display_name, 'Chen W.');
  assert.deepEqual(body.profile.targets.map((t) => t.id).sort(), ids.sort());
  assert.equal((await chen.put('/me/profile', { displayName: 'C', targetUniversityIds: [99999] })).status, 400);
});
