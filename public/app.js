'use strict';

/* ------------------------------------------------------------------ helpers */

/** Build DOM nodes. Children may be strings (inserted as text, never as HTML), nodes, arrays or null. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function money(amount, currency) {
  if (amount === null || amount === undefined) return 'Not listed';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency || ''}`;
  }
}

function tuitionText(u) {
  if (u.intl_tuition_amount === null || u.intl_tuition_amount === undefined) return 'Tuition not listed';
  const local = money(u.intl_tuition_amount, u.tuition_currency);
  const usd = u.tuition_currency && u.tuition_currency !== 'USD' && u.intl_tuition_usd ? ` (≈ ${money(u.intl_tuition_usd, 'USD')})` : '';
  return `${local}/yr${usd}`;
}

function placeOf(u) {
  return [u.city, u.state_province, u.country].filter(Boolean).join(', ');
}

function when(sqlDate) {
  const d = new Date(`${sqlDate.replace(' ', 'T')}Z`);
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString();
}

function badgeFor(post) {
  const cls = post.author_is_official ? 'badge official' : post.author_is_current_student ? 'badge student' : 'badge';
  return h('span', { class: cls }, post.author_badge);
}

function roleLabel(p) {
  if (p.role === 'student') return h('span', { class: 'badge student' }, `Student at ${p.university_name}`);
  return h('span', { class: 'badge' }, 'Prospective student');
}

function errorBox(err) {
  return h('p', { class: 'error', role: 'alert' }, err.message || String(err));
}

/** Wire a form to an async submit handler, showing errors inline. */
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    form.querySelector('.error')?.remove();
    if (btn) btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (err) {
      form.prepend(errorBox(err));
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  return form;
}

function field(label, input) {
  return h('label', {}, h('span', {}, label), input);
}

const app = document.getElementById('app');
let me = null;
let pollTimer = null;

function render(...nodes) {
  app.replaceChildren(...nodes.flat().filter(Boolean));
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function needLogin() {
  render(
    h('div', { class: 'card empty' },
      h('p', {}, 'You need to log in to see this page.'),
      h('p', {}, h('a', { class: 'btn', href: `#/login?next=${encodeURIComponent(location.hash)}` }, 'Log in'), ' ',
        h('a', { class: 'btn secondary', href: '#/signup' }, 'Create an account')))
  );
}

/* ------------------------------------------------------------------ nav */

async function refreshMe() {
  me = (await api('/auth/me')).user;
  renderNav();
}

function renderNav() {
  const nav = document.getElementById('nav');
  const path = location.hash.split('?')[0] || '#/';
  const link = (href, label, count) =>
    h('a', { href, class: path === href || (href !== '#/' && path.startsWith(href)) ? 'active' : null }, label,
      count ? h('span', { class: 'count' }, count) : null);
  const items = [link('#/', 'Universities')];
  if (me) {
    if (me.role === 'prospective' || me.role === 'student') {
      items.push(link('#/network', 'Network'));
      items.push(link('#/connections', 'Messages', (me.pending_requests || 0) + (me.unread_messages || 0)));
    }
    if (me.role === 'university_rep' && me.rep_status === 'approved') {
      items.push(link(`#/u/${me.university_id}/moderation`, 'Moderation', me.open_reports));
    }
    if (me.role === 'admin') items.push(link('#/admin', 'Admin'));
    items.push(link('#/profile', me.display_name));
    items.push(h('button', { onclick: async () => { await api('/auth/logout', { method: 'POST' }); await refreshMe(); go('#/'); } }, 'Log out'));
  } else {
    items.push(link('#/login', 'Log in'), link('#/signup', 'Sign up'));
  }
  nav.replaceChildren(...items);
}

/* ------------------------------------------------------------------ universities */

async function pageUniversities(params) {
  const [{ universities }, { countries }] = await Promise.all([
    api(`/universities?${params}`),
    api('/universities/countries'),
  ]);
  const form = h('form', { class: 'filters card' },
    field('Search', h('input', { name: 'q', placeholder: 'Name, city or country', value: params.get('q') || '' })),
    field('Country', h('select', { name: 'country' },
      h('option', { value: '' }, 'All countries'),
      countries.map((c) => h('option', { value: c.country, selected: params.get('country') === c.country }, `${c.country} (${c.count})`)))),
    field('Max tuition (USD/yr)', h('input', { name: 'maxTuitionUsd', type: 'number', min: 0, step: 1000, value: params.get('maxTuitionUsd') || '' })),
    field('Sort by', h('select', { name: 'sort' },
      [['name', 'Name'], ['tuition_asc', 'Tuition: low to high'], ['tuition_desc', 'Tuition: high to low'], ['activity', 'Most discussed']]
        .map(([v, l]) => h('option', { value: v, selected: params.get('sort') === v }, l)))),
  );
  const apply = () => {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) p.set(k, v);
    go(`#/?${p}`);
  };
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });

  render(
    h('h1', {}, 'Find your university'),
    h('p', { class: 'muted' }, 'Compare international tuition, then ask current students and admissions teams your questions.'),
    form,
    h('p', { class: 'muted small' }, `${universities.length} universit${universities.length === 1 ? 'y' : 'ies'}`),
    universities.length
      ? h('div', { class: 'grid' }, universities.map((u) =>
          h('a', { class: 'card', href: `#/u/${u.id}` },
            h('h3', {}, u.name),
            h('p', { class: 'muted small' }, placeOf(u)),
            h('p', { class: 'tuition' }, tuitionText(u)),
            h('p', { class: 'small muted' }, `${u.question_count} question${u.question_count === 1 ? '' : 's'} on the board`))))
      : h('div', { class: 'empty card' }, 'No universities match those filters.')
  );
}

async function pageUniversity(id, params) {
  const filter = params.get('filter') || 'all';
  const [{ university: u, can_edit }, { questions }] = await Promise.all([
    api(`/universities/${id}`),
    api(`/universities/${id}/questions?${filter === 'all' ? '' : `filter=${filter}`}`),
  ]);

  const askForm = me
    ? onSubmit(
        h('form', { class: 'card stack' },
          h('h3', {}, 'Ask a question'),
          field('Title', h('input', { name: 'title', required: true, minlength: 5, maxlength: 200, placeholder: 'e.g. Do international students get scholarships?' })),
          field('Details', h('textarea', { name: 'body', required: true, maxlength: 5000 })),
          h('button', { type: 'submit' }, 'Post question')),
        async (data) => {
          const { question } = await api(`/universities/${id}/questions`, { method: 'POST', body: data });
          go(`#/q/${question.id}`);
        })
    : h('p', { class: 'notice' }, h('a', { href: `#/login?next=${encodeURIComponent(location.hash)}` }, 'Log in'), ' to ask a question.');

  const tab = (key, label) => h('a', { href: `#/u/${id}${key === 'all' ? '' : `?filter=${key}`}`, class: filter === key ? 'active' : null }, label);

  render(
    h('div', { class: 'spread' },
      h('div', {},
        h('h1', {}, u.name),
        h('p', { class: 'muted' }, placeOf(u))),
      h('div', { class: 'row' },
        can_edit ? h('a', { class: 'btn secondary', href: `#/u/${id}/edit` }, 'Edit profile') : null,
        can_edit ? h('a', { class: 'btn secondary', href: `#/u/${id}/moderation` }, 'Moderation') : null)),
    h('div', { class: 'card' },
      u.description ? h('p', { class: 'pre' }, u.description) : null,
      h('dl', { class: 'facts' },
        h('dt', {}, 'International tuition'), h('dd', { class: 'tuition' }, tuitionText(u)),
        u.tuition_notes ? [h('dt', {}, ''), h('dd', { class: 'small muted' }, u.tuition_notes)] : null,
        h('dt', {}, 'Website'), h('dd', {}, u.website ? h('a', { href: u.website, target: '_blank', rel: 'noopener noreferrer' }, u.website) : '—'),
        h('dt', {}, 'Contact email'), h('dd', {}, u.contact_email ? h('a', { href: `mailto:${u.contact_email}` }, u.contact_email) : '—'),
        h('dt', {}, 'Phone'), h('dd', {}, u.contact_phone || '—')),
      h('p', { class: 'small muted' }, `Profile last updated ${when(u.updated_at)}`)),
    h('div', { class: 'card spread' },
      h('div', {},
        h('h3', {}, 'Connect with people'),
        h('p', { class: 'small muted' },
          `${u.current_students} current student${u.current_students === 1 ? '' : 's'} and ${u.considering} prospective student${u.considering === 1 ? '' : 's'} on intlstudent.`)),
      h('a', { class: 'btn secondary', href: `#/network?universityId=${id}` }, 'See people')),
    h('h2', {}, 'Discussion board'),
    h('div', { class: 'tabs' }, tab('all', 'All'), tab('unanswered', 'Unanswered'), tab('official', 'Official answers')),
    questions.length
      ? questions.map((q) =>
          h('a', { class: `card${q.hidden ? ' hidden-post' : ''}`, href: `#/q/${q.id}` },
            h('div', { class: 'spread' },
              h('h3', {}, q.title),
              h('div', { class: 'row' },
                q.hidden ? h('span', { class: 'badge danger' }, 'Hidden') : null,
                q.has_official_answer ? h('span', { class: 'badge official' }, 'Official answer') : null,
                h('span', { class: 'badge' }, `${q.answer_count} answer${q.answer_count === 1 ? '' : 's'}`))),
            h('p', { class: 'small muted' }, `Asked by ${q.author_name} · ${when(q.created_at)}`)))
      : h('div', { class: 'empty card' }, filter === 'all' ? 'No questions yet. Be the first to ask!' : 'Nothing here yet.'),
    askForm
  );
}

async function pageEditUniversity(id) {
  const { university: u, can_edit, can_edit_email_domain } = await api(`/universities/${id}`);
  if (!can_edit) return render(h('p', { class: 'error' }, 'Only verified representatives of this university can edit its profile.'));
  const input = (name, attrs = {}) => h('input', { name, value: u[name] ?? '', ...attrs });
  render(
    h('h1', {}, `Edit ${u.name}`),
    h('p', { class: 'muted' }, 'Keep your profile accurate. Prospective students see these details first.'),
    onSubmit(
      h('form', { class: 'card stack' },
        field('Name', input('name', { required: true })),
        h('div', { class: 'two-col' },
          field('City', input('city', { required: true })),
          field('State / province', input('state_province'))),
        field('Country', input('country', { required: true })),
        field('Description', h('textarea', { name: 'description', maxlength: 3000 }, u.description || '')),
        h('div', { class: 'two-col' },
          field('Website', input('website', { type: 'url', placeholder: 'https://' })),
          field('International office email', input('contact_email', { type: 'email' }))),
        field('Phone', input('contact_phone')),
        h('h3', {}, 'International tuition (per year)'),
        h('div', { class: 'two-col' },
          field('Amount', input('intl_tuition_amount', { type: 'number', min: 0 })),
          field('Currency (3-letter code)', input('tuition_currency', { maxlength: 3, placeholder: 'USD' }))),
        field('Same amount in USD (used for search filters)', input('intl_tuition_usd', { type: 'number', min: 0 })),
        field('Tuition notes', input('tuition_notes', { placeholder: 'e.g. Undergraduate, 2027–28, excludes fees' })),
        can_edit_email_domain ? field('Verification email domain (admins only)', input('email_domain', { placeholder: 'example.edu' })) : null,
        h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Save changes'), h('a', { href: `#/u/${id}` }, 'Cancel'))),
      async (data) => {
        await api(`/universities/${id}`, { method: 'PATCH', body: data });
        go(`#/u/${id}`);
      })
  );
}

/* ------------------------------------------------------------------ questions */

async function pageQuestion(id) {
  const { question: q } = await api(`/questions/${id}`);
  const isAsker = me && me.id === q.user_id;

  const act = async (path, body) => {
    try {
      await api(path, { method: 'POST', body });
      pageQuestion(id);
    } catch (err) {
      alert(err.message);
    }
  };
  const report = async (type, targetId) => {
    const reason = prompt('Why should moderators look at this post?');
    if (!reason) return;
    await act('/reports', { targetType: type, targetId, reason });
    alert("Thanks — the university's moderators will review it.");
  };
  const hideButton = (type, post) =>
    post.hidden
      ? h('button', { class: 'link', onclick: () => act(`/${type}s/${post.id}/hide`, { hidden: false }) }, 'Restore')
      : h('button', { class: 'link', onclick: () => {
          const reason = prompt('Reason for hiding (shown to the author):');
          if (reason !== null) act(`/${type}s/${post.id}/hide`, { hidden: true, reason });
        } }, 'Hide');

  const hiddenNote = (post) =>
    post.hidden ? h('p', { class: 'error small' }, `Hidden by a moderator${post.hidden_reason ? `: ${post.hidden_reason}` : ''}`) : null;

  const answerCard = (a) => {
    const accepted = a.id === q.accepted_answer_id;
    return h('div', { class: `card${a.author_is_official || a.endorsed ? ' official' : ''}${a.hidden ? ' hidden-post' : ''}` },
      h('div', { class: 'row' },
        h('strong', {}, a.author_name), badgeFor(a),
        a.endorsed && !a.author_is_official ? h('span', { class: 'badge official' }, '✓ Endorsed by the university') : null,
        accepted ? h('span', { class: 'badge student' }, '★ Accepted answer') : null,
        h('span', { class: 'muted small' }, when(a.created_at))),
      hiddenNote(a),
      h('p', { class: 'pre' }, a.body),
      h('div', { class: 'row small' },
        isAsker && !a.hidden
          ? h('button', { class: 'link', onclick: () => act(`/questions/${q.id}/accept`, { answerId: accepted ? null : a.id }) },
              accepted ? 'Unaccept' : 'Accept this answer')
          : null,
        q.can_moderate && !a.author_is_official
          ? h('button', { class: 'link', onclick: () => act(`/answers/${a.id}/endorse`, { endorsed: !a.endorsed }) },
              a.endorsed ? 'Remove endorsement' : 'Endorse')
          : null,
        q.can_moderate ? hideButton('answer', a) : null,
        me && me.id !== a.user_id && !q.can_moderate ? h('button', { class: 'link', onclick: () => report('answer', a.id) }, 'Report') : null));
  };

  render(
    h('p', { class: 'small' }, h('a', { href: `#/u/${q.university_id}` }, `← ${q.university_name}`)),
    h('div', { class: `card${q.hidden ? ' hidden-post' : ''}` },
      h('h1', {}, q.title),
      h('div', { class: 'row' }, h('strong', {}, q.author_name), badgeFor(q), h('span', { class: 'muted small' }, when(q.created_at))),
      hiddenNote(q),
      h('p', { class: 'pre' }, q.body),
      h('div', { class: 'row small' },
        q.can_moderate ? hideButton('question', q) : null,
        me && me.id !== q.user_id && !q.can_moderate ? h('button', { class: 'link', onclick: () => report('question', q.id) }, 'Report') : null)),
    h('h2', {}, `${q.answers.length} answer${q.answers.length === 1 ? '' : 's'}`),
    q.answers.length ? q.answers.map(answerCard) : h('p', { class: 'muted' }, 'No answers yet.'),
    q.hidden
      ? null
      : me
        ? onSubmit(
            h('form', { class: 'card stack' },
              h('h3', {}, 'Your answer'),
              h('textarea', { name: 'body', required: true, maxlength: 5000, 'aria-label': 'Your answer' }),
              h('button', { type: 'submit' }, 'Post answer')),
            async (data) => {
              await api(`/questions/${id}/answers`, { method: 'POST', body: data });
              pageQuestion(id);
            })
        : h('p', { class: 'notice' }, h('a', { href: `#/login?next=${encodeURIComponent(location.hash)}` }, 'Log in'), ' to answer.')
  );
}

/* ------------------------------------------------------------------ moderation */

async function pageModeration(id, params) {
  if (!me) return needLogin();
  const status = params.get('status') === 'resolved' ? 'resolved' : 'open';
  const [{ university: u }, { reports }] = await Promise.all([
    api(`/universities/${id}`),
    api(`/universities/${id}/reports?status=${status}`),
  ]);
  const act = async (path, body) => {
    try {
      await api(path, { method: 'POST', body });
      await refreshMe();
      pageModeration(id, params);
    } catch (err) {
      alert(err.message);
    }
  };
  render(
    h('p', { class: 'small' }, h('a', { href: `#/u/${id}` }, `← ${u.name}`)),
    h('h1', {}, 'Moderation queue'),
    h('p', { class: 'muted' }, 'Posts people have reported on your board. Hide posts that break the rules, or dismiss the report. You can also hide posts and endorse accurate answers straight from any question page.'),
    h('div', { class: 'tabs' },
      h('a', { href: `#/u/${id}/moderation`, class: status === 'open' ? 'active' : null }, 'Open'),
      h('a', { href: `#/u/${id}/moderation?status=resolved`, class: status === 'resolved' ? 'active' : null }, 'Resolved')),
    reports.length
      ? reports.map((r) =>
          h('div', { class: 'card' },
            h('div', { class: 'row' },
              h('span', { class: 'badge danger' }, `Reported ${r.target_type}`),
              r.hidden ? h('span', { class: 'badge' }, 'Hidden') : null,
              h('span', { class: 'small muted' }, `by ${r.reporter_name} · ${when(r.created_at)}`)),
            h('p', {}, h('strong', {}, 'Reason: '), r.reason),
            h('div', { class: 'card' },
              r.question_title ? h('h3', {}, r.question_title) : null,
              h('p', { class: 'small muted' }, `Written by ${r.author_name}`),
              h('p', { class: 'pre' }, r.content)),
            h('div', { class: 'row' },
              h('a', { href: `#/q/${r.question_id}` }, 'Open question'),
              status === 'open' && !r.hidden
                ? h('button', { class: 'danger', onclick: () => {
                    const reason = prompt('Reason for hiding (shown to the author):', r.reason);
                    if (reason !== null) act(`/${r.target_type}s/${r.target_id}/hide`, { hidden: true, reason });
                  } }, 'Hide post')
                : null,
              status === 'open' ? h('button', { class: 'secondary', onclick: () => act(`/reports/${r.id}/resolve`) }, 'Dismiss report') : null)))
      : h('div', { class: 'empty card' }, status === 'open' ? 'No open reports. 🎉' : 'No resolved reports yet.')
  );
}

/* ------------------------------------------------------------------ networking */

function personCard(p, { onChange } = {}) {
  const c = p.connection;
  let action;
  if (!c) {
    action = h('button', { onclick: () => requestConnection(p, onChange) }, 'Connect');
  } else if (c.status === 'accepted') {
    action = h('a', { class: 'btn', href: `#/chat/${c.id}` }, 'Message');
  } else if (c.status === 'pending' && c.direction === 'incoming') {
    action = h('a', { class: 'btn', href: '#/connections' }, 'Respond to request');
  } else if (c.status === 'pending') {
    action = h('span', { class: 'muted small' }, 'Request sent');
  } else {
    action = null;
  }
  return h('div', { class: 'card stack person' },
    h('div', {}, h('h3', {}, h('a', { href: `#/people/${p.id}` }, p.display_name)), roleLabel(p)),
    h('p', { class: 'small muted' },
      [p.home_city, p.home_country].filter(Boolean).join(', ') || null,
      p.program ? ` · ${p.program}` : null,
      p.intake ? ` · Starting ${p.intake}` : null,
      p.grad_year ? ` · Class of ${p.grad_year}` : null),
    p.bio ? h('p', { class: 'small pre' }, p.bio) : null,
    p.targets?.length ? h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Considering: '), p.targets.map((t) => t.name).join(', ')) : null,
    action ? h('div', { class: 'actions' }, action) : null);
}

async function requestConnection(p, onChange) {
  const note = prompt(`Add a short note to ${p.display_name} (optional):`, '');
  if (note === null) return;
  try {
    await api('/connections', { method: 'POST', body: { userId: p.id, note } });
    onChange?.();
  } catch (err) {
    alert(err.message);
  }
}

async function pageNetwork(params) {
  if (!me) return needLogin();
  const [{ people }, { universities }, profile] = await Promise.all([
    api(`/people?${params}`),
    api('/universities'),
    api('/me/profile'),
  ]);
  const p = profile.profile;
  const form = h('form', { class: 'filters card' },
    field('Search', h('input', { name: 'q', placeholder: 'Name, program or city', value: params.get('q') || '' })),
    field('University', h('select', { name: 'universityId' },
      h('option', { value: '' }, 'Any university'),
      universities.map((u) => h('option', { value: u.id, selected: params.get('universityId') === String(u.id) }, u.name)))),
    field('Home country', h('input', { name: 'homeCountry', placeholder: p.home_country || 'e.g. India', value: params.get('homeCountry') || '' })),
    field('Show', h('select', { name: 'role' },
      [['', 'Everyone'], ['prospective', 'Prospective students'], ['student', 'Current students']]
        .map(([v, l]) => h('option', { value: v, selected: (params.get('role') || '') === v }, l)))));
  const apply = () => {
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) q.set(k, v);
    go(`#/network?${q}`);
  };
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });

  const incomplete = me.role === 'prospective' ? !p.home_country || !p.targets.length : !p.home_country;
  render(
    h('h1', {}, 'Network'),
    h('p', { class: 'muted' }, 'Meet students considering the same universities, people from your home country, and current students who can tell you what it is really like. Send a request to connect; once they accept, you can message each other.'),
    incomplete
      ? h('p', { class: 'notice' }, h('a', { href: '#/profile' }, 'Complete your profile'),
          me.role === 'prospective' ? ' (home country and the universities you are considering)' : ' (your home country)',
          ' so we can suggest the right people.')
      : null,
    form,
    people.length
      ? h('div', { class: 'grid' }, people.map((x) => personCard(x, { onChange: () => pageNetwork(params) })))
      : h('div', { class: 'empty card' }, 'No one matches those filters yet.')
  );
}

async function pagePerson(id) {
  if (!me) return needLogin();
  const { person } = await api(`/people/${id}`);
  render(
    h('p', { class: 'small' }, h('a', { href: '#/network' }, '← Network')),
    personCard(person, { onChange: () => pagePerson(id) })
  );
}

async function pageConnections() {
  if (!me) return needLogin();
  const { incoming, outgoing, connected } = await api('/connections');
  const respond = async (id, accept) => {
    try {
      await api(`/connections/${id}/respond`, { method: 'POST', body: { accept } });
      await refreshMe();
      pageConnections();
    } catch (err) {
      alert(err.message);
    }
  };
  const withdraw = async (id) => {
    await api(`/connections/${id}`, { method: 'DELETE' });
    pageConnections();
  };
  render(
    h('h1', {}, 'Messages'),
    incoming.length ? h('h2', {}, `Requests (${incoming.length})`) : null,
    incoming.map((c) =>
      h('div', { class: 'card stack' },
        h('div', { class: 'spread' },
          h('div', {}, h('h3', {}, h('a', { href: `#/people/${c.person.id}` }, c.person.display_name)), roleLabel(c.person)),
          h('div', { class: 'row' },
            h('button', { onclick: () => respond(c.id, true) }, 'Accept'),
            h('button', { class: 'secondary', onclick: () => respond(c.id, false) }, 'Decline'))),
        c.note ? h('p', { class: 'pre' }, `“${c.note}”`) : null,
        h('p', { class: 'small muted' },
          [c.person.home_city, c.person.home_country].filter(Boolean).join(', '),
          c.person.targets.length ? ` · Considering ${c.person.targets.map((t) => t.name).join(', ')}` : '')),
    ),
    h('h2', {}, 'Conversations'),
    connected.length
      ? connected.map((c) =>
          h('a', { class: 'card spread', href: `#/chat/${c.id}` },
            h('div', {},
              h('h3', {}, c.person.display_name, c.unread ? h('span', { class: 'count' }, c.unread) : null),
              h('p', { class: 'small muted' }, c.last_message ? c.last_message.slice(0, 120) : 'No messages yet. Say hello!')),
            h('span', { class: 'small muted' }, c.last_message_at ? when(c.last_message_at) : '')))
      : h('div', { class: 'empty card' }, 'No connections yet. ', h('a', { href: '#/network' }, 'Find people to connect with.')),
    outgoing.length ? h('h2', {}, 'Sent requests') : null,
    outgoing.map((c) =>
      h('div', { class: 'card spread' },
        h('div', {}, h('strong', {}, c.person.display_name), ' ', h('span', { class: 'small muted' }, `sent ${when(c.created_at)}`)),
        h('button', { class: 'secondary', onclick: () => withdraw(c.id) }, 'Withdraw')))
  );
}

async function pageChat(id) {
  if (!me) return needLogin();
  let lastId = 0;
  const list = h('div', { class: 'chat', 'aria-live': 'polite' });
  const append = (msgs) => {
    for (const m of msgs) {
      list.append(h('div', { class: `msg${m.sender_id === me.id ? ' mine' : ''}` },
        h('div', { class: 'pre' }, m.body), h('div', { class: 'small muted' }, when(m.created_at))));
      lastId = Math.max(lastId, m.id);
    }
    if (msgs.length) list.scrollTop = list.scrollHeight;
  };
  const { person, messages } = await api(`/connections/${id}/messages`);
  const form = onSubmit(
    h('form', { class: 'chat-form' },
      h('textarea', { name: 'body', required: true, maxlength: 2000, placeholder: `Message ${person.display_name}`, 'aria-label': 'Message' }),
      h('button', { type: 'submit' }, 'Send')),
    async (data) => {
      await api(`/connections/${id}/messages`, { method: 'POST', body: data });
      form.reset();
      append((await api(`/connections/${id}/messages?after=${lastId}`)).messages);
    });
  form.querySelector('textarea').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  render(
    h('p', { class: 'small' }, h('a', { href: '#/connections' }, '← Messages')),
    h('div', { class: 'row' }, h('h1', {}, h('a', { href: `#/people/${person.id}` }, person.display_name)), roleLabel(person)),
    h('div', { class: 'card' }, list, form)
  );
  append(messages);
  refreshMe();
  // Simple polling for new messages while the chat is open.
  pollTimer = setInterval(async () => {
    try {
      append((await api(`/connections/${id}/messages?after=${lastId}`)).messages);
    } catch {
      /* ignore transient errors */
    }
  }, 5000);
}

/* ------------------------------------------------------------------ profile */

async function pageProfile() {
  if (!me) return needLogin();
  const [{ profile: p }, { universities }] = await Promise.all([api('/me/profile'), api('/universities')]);
  const isStudentLike = me.role === 'prospective' || me.role === 'student';
  const targetIds = new Set(p.targets.map((t) => t.id));
  const input = (name, attrs = {}) => h('input', { name, value: p[name] ?? '', ...attrs });

  render(
    h('h1', {}, 'Your profile'),
    h('p', { class: 'muted' },
      me.role === 'student' ? `Current student at ${me.university_name}.`
        : me.role === 'university_rep'
          ? `Representative of ${me.university_name}${me.rep_status === 'approved' ? '' : ' — waiting for an admin to verify your account'}.`
          : me.role === 'admin' ? 'Site admin.' : 'Prospective student.',
      isStudentLike ? ' Other students see this profile on the Network page.' : null),
    onSubmit(
      h('form', { class: 'card stack' },
        field('Display name', h('input', { name: 'displayName', value: p.display_name, required: true, maxlength: 60 })),
        isStudentLike ? [
          field('About you', h('textarea', { name: 'bio', maxlength: 1000, placeholder: 'What are you studying or hoping to study? What can you help others with?' }, p.bio || '')),
          h('div', { class: 'two-col' },
            field('Home country', input('home_country', { placeholder: 'e.g. India' })),
            field('Home city', input('home_city', { placeholder: 'e.g. Pune' }))),
          field('Program', input('program', { placeholder: 'e.g. BSc Computer Science' })),
          me.role === 'prospective'
            ? field('When do you plan to start?', input('intake', { placeholder: 'e.g. Fall 2027' }))
            : field('Graduation year', input('grad_year', { type: 'number', min: 1990, max: 2100 })),
          me.role === 'prospective'
            ? h('fieldset', { class: 'card' },
                h('legend', {}, 'Universities you are considering'),
                h('div', { class: 'grid' }, universities.map((u) =>
                  h('label', { class: 'row small' },
                    h('input', { type: 'checkbox', name: 'target', value: u.id, checked: targetIds.has(u.id), class: 'checkbox' }),
                    u.name))))
            : null,
        ] : null,
        h('button', { type: 'submit' }, 'Save profile')),
      async () => {
        const form = app.querySelector('form');
        const fd = new FormData(form);
        await api('/me/profile', {
          method: 'PUT',
          body: {
            displayName: fd.get('displayName'),
            bio: fd.get('bio'),
            homeCountry: fd.get('home_country'),
            homeCity: fd.get('home_city'),
            program: fd.get('program'),
            intake: fd.get('intake'),
            gradYear: fd.get('grad_year'),
            targetUniversityIds: me.role === 'prospective' ? fd.getAll('target').map(Number) : undefined,
          },
        });
        await refreshMe();
        form.before(h('p', { class: 'notice' }, 'Saved.'));
        setTimeout(() => app.querySelector('.notice')?.remove(), 2500);
      })
  );
}

/* ------------------------------------------------------------------ auth pages */

function pageLogin(params) {
  const next = params.get('next') || '#/';
  render(
    h('h1', {}, 'Log in'),
    onSubmit(
      h('form', { class: 'card stack' },
        field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        h('button', { type: 'submit' }, 'Log in'),
        h('p', { class: 'small muted' }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account'))),
      async (data) => {
        await api('/auth/login', { method: 'POST', body: data });
        await refreshMe();
        go(next.startsWith('#/') ? next : '#/');
      })
  );
}

async function pageSignup() {
  const { universities } = await api('/universities');
  const uniField = field('Your university', h('select', { name: 'universityId' },
    h('option', { value: '' }, 'Choose…'),
    universities.map((u) => h('option', { value: u.id }, u.name))));
  const hint = h('p', { class: 'small muted' });
  const form = h('form', { class: 'card stack' },
    field('I am a…', h('select', { name: 'role' },
      h('option', { value: 'prospective' }, 'Prospective student'),
      h('option', { value: 'student' }, 'Current student at a university'),
      h('option', { value: 'university_rep' }, 'University staff (admissions / international office)'))),
    uniField,
    hint,
    field('Display name', h('input', { name: 'displayName', required: true, maxlength: 60 })),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('Password (at least 8 characters)', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('button', { type: 'submit' }, 'Create account'));
  const sync = () => {
    const role = form.role.value;
    uniField.hidden = role === 'prospective';
    hint.textContent =
      role === 'student' ? 'Use your university email address so we can confirm you study there.'
        : role === 'university_rep' ? 'Use your university email address. An admin will verify your account before you can post official answers or edit the profile.'
          : '';
  };
  form.role.addEventListener('change', sync);
  sync();
  render(
    h('h1', {}, 'Create an account'),
    onSubmit(form, async (data) => {
      if (data.role === 'prospective') delete data.universityId;
      await api('/auth/signup', { method: 'POST', body: data });
      await refreshMe();
      go('#/profile');
    })
  );
}

/* ------------------------------------------------------------------ admin */

async function pageAdmin() {
  if (!me || me.role !== 'admin') return render(h('p', { class: 'error' }, 'Admins only.'));
  const { reps } = await api('/admin/reps');
  const act = async (path) => {
    await api(path, { method: 'POST' });
    pageAdmin();
  };
  render(
    h('h1', {}, 'Admin'),
    h('h2', {}, 'University representatives waiting for verification'),
    h('p', { class: 'muted small' }, 'Check that each person really works for the university (for example by contacting its international office) before approving.'),
    reps.length
      ? reps.map((r) =>
          h('div', { class: 'card spread' },
            h('div', {}, h('strong', {}, r.display_name), h('p', { class: 'small muted' }, `${r.email} · ${r.university_name} · signed up ${when(r.created_at)}`)),
            h('div', { class: 'row' },
              h('button', { onclick: () => act(`/admin/reps/${r.id}/approve`) }, 'Approve'),
              h('button', { class: 'danger', onclick: () => act(`/admin/reps/${r.id}/reject`) }, 'Reject'))))
      : h('div', { class: 'empty card' }, 'No one is waiting.')
  );
}

/* ------------------------------------------------------------------ router */

const routes = [
  [/^#?\/?$/, (_m, p) => pageUniversities(p)],
  [/^#\/u\/(\d+)$/, (m, p) => pageUniversity(m[1], p)],
  [/^#\/u\/(\d+)\/edit$/, (m) => pageEditUniversity(m[1])],
  [/^#\/u\/(\d+)\/moderation$/, (m, p) => pageModeration(m[1], p)],
  [/^#\/q\/(\d+)$/, (m) => pageQuestion(m[1])],
  [/^#\/network$/, (_m, p) => pageNetwork(p)],
  [/^#\/people\/(\d+)$/, (m) => pagePerson(m[1])],
  [/^#\/connections$/, () => pageConnections()],
  [/^#\/chat\/(\d+)$/, (m) => pageChat(m[1])],
  [/^#\/profile$/, () => pageProfile()],
  [/^#\/login$/, (_m, p) => pageLogin(p)],
  [/^#\/signup$/, () => pageSignup()],
  [/^#\/admin$/, () => pageAdmin()],
];

async function route() {
  clearInterval(pollTimer);
  const [path, query = ''] = (location.hash || '#/').split('?');
  const params = new URLSearchParams(query);
  renderNav();
  for (const [re, handler] of routes) {
    const m = path.match(re);
    if (m) {
      try {
        await handler(m, params);
      } catch (err) {
        if (err.status === 401) needLogin();
        else render(errorBox(err));
      }
      app.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  render(h('div', { class: 'empty card' }, 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
}

window.addEventListener('hashchange', route);
refreshMe().catch(() => {}).finally(route);
