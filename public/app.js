'use strict';

/* ------------------------------------------------------------------ helpers */

/**
 * Build DOM nodes. Children may be strings (inserted as text, never as HTML), nodes, arrays or null.
 * `style` takes an object and is applied through the CSSOM, which the Content-Security-Policy allows.
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
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

/** Static, trusted SVG markup only (icons defined in this file). */
function icon(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}
const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  verified: '<svg class="verified" viewBox="0 0 24 24" role="img" aria-label="Verified university account"><path class="seal" d="M12 1.5l2.6 1.9 3.2-.2 1 3 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3-3.2-.2L12 22.5l-2.6-1.9-3.2.2-1-3L2.6 15.9l1-3.1-1-3.1 2.6-1.9 1-3 3.2.2z"/><path d="m7.8 12.3 2.8 2.8 5.6-5.8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

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
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Number(amount).toLocaleString()} ${currency || ''}`;
  }
}

/** Local-currency tuition, plus a USD figure when the local currency isn't USD. */
function fees(u) {
  if (u.intl_tuition_amount === null || u.intl_tuition_amount === undefined) return { local: 'Not listed', usd: '' };
  const local = money(u.intl_tuition_amount, u.tuition_currency);
  const usd = u.tuition_currency && u.tuition_currency !== 'USD' && u.intl_tuition_usd ? `≈ US${money(u.intl_tuition_usd, 'USD')} a year` : 'a year';
  return { local, usd };
}

function placeOf(u) {
  return [u.city, u.country].filter(Boolean).join(', ');
}

function when(sqlDate) {
  const d = new Date(`${sqlDate.replace(' ', 'T')}Z`);
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const n = Math.floor(s / 86400); return `${n} day${n === 1 ? '' : 's'} ago`; }
  return d.toLocaleDateString();
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Background for a university's photo slot: its campus photo if set, else its colour. */
function photoStyle(u) {
  const style = { backgroundColor: u.brand_color || '#8C6A54' };
  if (u.photo_url) style.backgroundImage = `url(${JSON.stringify(u.photo_url)})`;
  return style;
}

/** A stable warm colour per person, for initials where we have no photo. */
const PEOPLE_COLORS = ['#8C6A54', '#5C4033', '#A6826A', '#B35A2A', '#6E4B3A', '#94643F', '#7A5A48'];
function personColor(id) {
  return PEOPLE_COLORS[Math.abs(Number(id) || 0) % PEOPLE_COLORS.length];
}
function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function errorBox(err) {
  return h('p', { class: 'error', role: 'alert' }, err.message || String(err));
}

/** Wire a form to an async submit handler, showing errors inline. */
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    form.querySelector(':scope > .error')?.remove();
    if (btn) btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      form.prepend(errorBox(err));
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  return form;
}

function field(label, input) {
  return h('label', {}, h('span', { class: 'label' }, label), input);
}

function wrap(...children) {
  return h('div', { class: 'wrap' }, ...children);
}

const app = document.getElementById('app');
let me = null;
let pollTimer = null;
let config = { turnstileSiteKey: null };

/**
 * Fields every guest post and signup form carries: a hidden trap field bots fill in, the time
 * the form appeared, and (when configured) a Cloudflare Turnstile check.
 * Returns { nodes, values() }.
 */
function humanCheck() {
  const startedAt = Date.now();
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const trapWrap = h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', {}, 'Website', trap));
  let token = '';
  let box = null;
  if (config.turnstileSiteKey) {
    box = h('div', { class: 'turnstile' });
    loadTurnstile().then(() => window.turnstile.render(box, { sitekey: config.turnstileSiteKey, callback: (t) => { token = t; } }));
  }
  return {
    nodes: [trapWrap, box],
    values: () => ({ website: trap.value, startedAt, humanToken: token }),
  };
}

let turnstileLoading = null;
function loadTurnstile() {
  turnstileLoading ||= new Promise((resolve, reject) => {
    const script = h('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true });
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return turnstileLoading;
}

function render(...nodes) {
  app.replaceChildren(...nodes.flat().filter(Boolean));
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function loginLink(text = 'Log in') {
  return h('a', { class: 'linkline accent', href: `#/login?next=${encodeURIComponent(location.hash)}` }, text);
}

function needLogin() {
  render(wrap(
    h('section', { class: 'hero' },
      h('h1', { class: 'display' }, 'Log in to', h('br'), h('span', { class: 'accent' }, 'continue.')),
      h('div', { class: 'actions', style: { marginTop: '48px' } },
        h('a', { class: 'btn', href: `#/login?next=${encodeURIComponent(location.hash)}` }, 'Log in'),
        h('a', { class: 'textbtn accent', href: '#/signup' }, 'Create a profile →')))
  ));
}

/* ------------------------------------------------------------------ nav */

async function refreshMe() {
  me = (await api('/auth/me')).user;
  renderNav();
}

function renderNav() {
  const nav = document.getElementById('nav');
  const path = location.hash.split('?')[0] || '#/';
  const isActive = (href) =>
    href === '#/'
      ? path === '#/' || path === '#' || path.startsWith('#/q/') || (path.startsWith('#/u/') && !path.endsWith('/moderation'))
      : path.startsWith(href);
  const link = (href, label, count, cls) =>
    h('a', { href, class: [isActive(href) ? 'active' : '', cls || ''].join(' ').trim() || null }, label,
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
    items.push(h('button', { type: 'button', onclick: async () => { await api('/auth/logout', { method: 'POST' }); await refreshMe(); go('#/'); } }, 'Log out'));
  } else {
    items.push(link('#/login', 'Log in'), link('#/signup', 'Create profile →', 0, 'cta'));
  }
  nav.replaceChildren(...items);
}

/* ------------------------------------------------------------------ home */

async function pageUniversities(params) {
  const sort = params.get('sort') || 'tuition_asc';
  const q = params.get('q') || '';
  const { universities } = await api(`/universities?${new URLSearchParams({ q, sort })}`);
  const homeLink = (extra) => `#/?${new URLSearchParams({ ...(q ? { q } : {}), sort, ...extra })}`;

  const input = h('input', { name: 'q', value: q, placeholder: 'Search a university, city or country', 'aria-label': 'Search universities', autocomplete: 'off' });
  const form = h('form', { role: 'search', class: 'search' }, icon(ICONS.search), input, h('button', { type: 'submit' }, 'Search →'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    go(`#/?${new URLSearchParams({ ...(value ? { q: value } : {}), sort })}`);
  });

  const sortSelect = h('select', { class: 'inline-select', 'aria-label': 'Sort universities' },
    [['tuition_asc', 'tuition, lowest first'], ['tuition_desc', 'tuition, highest first'], ['name', 'name'], ['activity', 'most discussed']]
      .map(([v, l]) => h('option', { value: v, selected: sort === v }, l)));
  sortSelect.addEventListener('change', () => go(homeLink({ sort: sortSelect.value })));

  render(wrap(
    h('section', { class: 'hero' },
      h('h1', { class: 'display' }, 'Pick a university.', h('br'), h('span', { class: 'accent' }, 'Ask the people'), ' who go there.')),
    form,
    h('div', { class: 'results-head' },
      h('h2', { class: 'eyebrow' }, q ? `${plural(universities.length, 'result')} for “${q}”` : plural(universities.length, 'university', 'universities')),
      h('span', { class: 'muted small' }, 'Sorted by ', sortSelect)),
    universities.length
      ? h('div', { class: 'uni-grid' }, universities.map(uniCard))
      : h('p', { class: 'empty' }, 'No universities match that search. Try a city or country.')
  ));
}

function uniCard(u) {
  const f = fees(u);
  return h('a', { class: 'uni-card', href: `#/u/${u.id}` },
    h('span', { class: 'photo', role: 'img', 'aria-label': `${u.name} campus`, style: photoStyle(u) }),
    h('span', { class: 'card-line' }, h('span', { class: 'card-title' }, u.name), h('span', { class: 'card-fee' }, f.local)),
    h('span', { class: 'card-line card-meta' }, h('span', {}, placeOf(u)), h('span', { class: 'nowrap' }, f.usd)),
    u.university_active ? h('span', { class: 'card-meta active-flag' }, 'University active') : null);
}

/* ------------------------------------------------------------------ university */

async function pageUniversity(id, params) {
  const filter = params.get('filter') || 'all';
  const [{ university: u, can_edit }, { questions }] = await Promise.all([
    api(`/universities/${id}`),
    api(`/universities/${id}/questions${filter === 'all' ? '' : `?filter=${filter}`}`),
  ]);
  const f = fees(u);
  const tab = (key, label) => h('a', { href: `#/u/${id}${key === 'all' ? '' : `?filter=${key}`}`, class: filter === key ? 'active' : null }, label);

  const askForm = me
    ? onSubmit(
        h('form', { class: 'ask stack' },
          h('h3', { class: 'heading-sm' }, 'Ask something.'),
          h('label', {}, h('span', { class: 'sr-only' }, 'Your question'),
            h('input', { name: 'title', required: true, minlength: 5, maxlength: 200, placeholder: 'Can international students work in first year?', style: { fontSize: '20px', fontWeight: '600', padding: '18px 22px', borderRadius: '20px' } })),
          h('label', {}, h('span', { class: 'sr-only' }, 'Details'),
            h('textarea', { name: 'body', required: true, maxlength: 5000, placeholder: 'Add details', style: { borderRadius: '20px', padding: '18px 22px' } })),
          h('div', { class: 'form-actions' },
            h('span', { class: 'muted small' }, `Posting as ${me.display_name}`),
            h('button', { type: 'submit', class: 'btn' }, 'Post question →'))),
        async (data) => {
          const { question } = await api(`/universities/${id}/questions`, { method: 'POST', body: data });
          go(`#/q/${question.id}`);
        })
    : guestAskForm(id);

  const peopleCount = [
    u.current_students ? plural(u.current_students, 'current student') : null,
    u.considering ? `${u.considering} considering` : null,
  ].filter(Boolean).join(', ');

  render(
    h('figure', { class: 'cover', style: photoStyle(u) },
      h('div', { class: 'wrap' },
        h('a', { href: '#/' }, '← All universities'),
        h('h1', { class: 'display' }, u.name),
        h('p', {}, placeOf(u), u.university_active ? '  ·  University active' : ''),
        can_edit ? h('div', { class: 'cover-actions' },
          h('a', { class: 'btn', href: `#/u/${id}/edit` }, 'Edit profile'),
          h('a', { class: 'btn', href: `#/u/${id}/moderation` }, 'Moderation')) : null)),
    wrap(h('div', { class: 'split' },
      h('aside', { 'aria-label': 'Key facts' },
        h('div', { class: 'fact' },
          h('span', { class: 'eyebrow' }, 'International tuition'),
          h('span', { class: 'fact-big' }, f.local),
          h('span', { class: 'muted small' }, [f.usd, u.tuition_notes].filter(Boolean).join('  ·  '))),
        h('div', { class: 'fact' },
          h('span', { class: 'eyebrow' }, 'International office'),
          u.contact_email ? h('a', { class: 'linkline', href: `mailto:${u.contact_email}` }, u.contact_email) : h('span', { class: 'muted' }, 'Not listed yet'),
          u.contact_phone ? h('span', { class: 'muted small' }, u.contact_phone) : null,
          u.website ? h('a', { class: 'muted small', href: u.website, target: '_blank', rel: 'noopener noreferrer' }, `${new URL(u.website).hostname.replace(/^www\./, '')} ↗`) : null),
        h('div', { class: 'fact' },
          h('span', { class: 'eyebrow' }, 'People here'),
          h('a', { class: 'accent small', href: `#/network?universityId=${id}`, style: { fontWeight: '600' } },
            peopleCount ? `${peopleCount} →` : 'Find people heading here →'))),
      h('section', { 'aria-labelledby': 'board' },
        u.description ? h('p', { class: 'desc pre' }, u.description) : null,
        h('div', { class: 'board-head' }, h('h2', { id: 'board', class: 'heading' }, 'Questions')),
        h('nav', { class: 'tabs', 'aria-label': 'Filter questions' }, tab('all', 'All'), tab('official', 'Answered by the university'), tab('unanswered', 'Unanswered')),
        questions.length
          ? h('div', { class: 'qlist' }, questions.map((q) =>
              h('a', { class: 'qrow', href: `#/q/${q.id}` },
                h('span', { class: 'qtitle' }, q.title),
                h('span', { class: `qcount${q.answer_count ? '' : ' zero'}` }, q.answer_count),
                h('span', { class: 'qmeta' }, `${q.author_name}, ${q.author_badge.toLowerCase()}  ·  ${when(q.created_at)}`,
                  q.has_official_answer ? h('span', { class: 'accent', style: { fontWeight: '600' } }, '  ·  Answered by the university') : null,
                  q.hidden ? h('span', { style: { color: 'var(--danger)' } }, '  ·  Hidden') : null,
                  q.moderation_status === 'held' ? h('span', { style: { color: 'var(--danger)' } }, '  ·  Waiting for review') : null,
                  q.moderation_status === 'rejected' ? h('span', { style: { color: 'var(--danger)' } }, '  ·  Not published') : null),
                h('span', { class: 'muted small', style: { textAlign: 'right' } }, q.answer_count === 1 ? 'answer' : 'answers'))))
          : h('p', { class: 'empty' }, filter === 'all' ? 'No questions yet. Be the first to ask.' : 'Nothing here yet.'),
        askForm)))
  );
}

/** Guests can ask (not answer). Their question is checked automatically before it appears. */
function guestAskForm(id) {
  const human = humanCheck();
  const form = h('form', { class: 'ask stack' },
    h('h3', { class: 'heading-sm' }, 'Ask something.'),
    h('p', { class: 'muted' }, 'No profile needed to ask. To answer questions, ', loginLink('log in'), ' or ', h('a', { class: 'linkline accent', href: '#/signup' }, 'create a profile'), '.'),
    h('label', {}, h('span', { class: 'sr-only' }, 'Your question'),
      h('input', { name: 'title', required: true, minlength: 5, maxlength: 200, placeholder: 'Can international students work in first year?', style: { fontSize: '20px', fontWeight: '600', padding: '18px 22px', borderRadius: '20px' } })),
    h('label', {}, h('span', { class: 'sr-only' }, 'Details'),
      h('textarea', { name: 'body', required: true, maxlength: 5000, placeholder: 'Add details', style: { borderRadius: '20px', padding: '18px 22px' } })),
    human.nodes,
    h('div', { class: 'form-actions' },
      h('label', { class: 'muted small', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, 'Post as',
        h('input', { name: 'guestName', maxlength: 40, placeholder: 'Guest', style: { width: '180px', padding: '10px 14px', borderRadius: '12px' } })),
      h('button', { type: 'submit', class: 'btn' }, 'Post question →')));
  return onSubmit(form, async (data) => {
    const res = await api(`/universities/${id}/questions`, { method: 'POST', body: { ...data, ...human.values() } });
    if (res.status === 'held') {
      form.replaceChildren(h('h3', { class: 'heading-sm' }, 'Thanks.'), h('p', { class: 'lead' }, res.message));
    } else {
      go(`#/q/${res.question.id}`);
    }
  });
}

async function pageEditUniversity(id) {
  const { university: u, can_edit, can_edit_email_domain } = await api(`/universities/${id}`);
  if (!can_edit) return render(wrap(h('p', { class: 'error', style: { marginTop: '64px' } }, 'Only verified representatives of this university can edit its profile.')));
  const input = (name, attrs = {}) => h('input', { name, value: u[name] ?? '', ...attrs });
  render(wrap(
    h('section', { class: 'hero' }, h('h1', { class: 'display-md' }, `Edit ${u.name}`)),
    onSubmit(
      h('form', { class: 'stack', style: { maxWidth: '760px' } },
        field('Name', input('name', { required: true })),
        h('div', { class: 'two-col' }, field('City', input('city', { required: true })), field('State / province', input('state_province'))),
        field('Country', input('country', { required: true })),
        field('Description', h('textarea', { name: 'description', maxlength: 3000 }, u.description || '')),
        h('div', { class: 'two-col' },
          field('Website', input('website', { type: 'url', placeholder: 'https://' })),
          field('International office email', input('contact_email', { type: 'email' }))),
        field('Phone', input('contact_phone')),
        h('div', { class: 'two-col' },
          field('Tuition per year', input('intl_tuition_amount', { type: 'number', min: 0 })),
          field('Currency (3-letter code)', input('tuition_currency', { maxlength: 3, placeholder: 'USD' }))),
        field('Same amount in USD (used for sorting)', input('intl_tuition_usd', { type: 'number', min: 0 })),
        field('Tuition notes', input('tuition_notes', { placeholder: 'e.g. Undergraduate, 2027–28' })),
        h('div', { class: 'two-col' },
          field('Campus photo URL', input('photo_url', { type: 'url', placeholder: 'https://' })),
          field('University colour', input('brand_color', { placeholder: '#1E3765', maxlength: 7 }))),
        can_edit_email_domain ? field('Verification email domain (admins only)', input('email_domain', { placeholder: 'example.edu' })) : null,
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn' }, 'Save changes'), h('a', { class: 'textbtn', href: `#/u/${id}` }, 'Cancel'))),
      async (data) => {
        await api(`/universities/${id}`, { method: 'PATCH', body: data });
        go(`#/u/${id}`);
      })
  ));
}

/* ------------------------------------------------------------------ question */

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
    alert("Thanks. The university's moderators will review it.");
  };
  const hideButton = (type, post) =>
    post.hidden
      ? h('button', { class: 'textbtn', type: 'button', onclick: () => act(`/${type}s/${post.id}/hide`, { hidden: false }) }, 'Restore')
      : h('button', { class: 'textbtn', type: 'button', onclick: () => {
          const reason = prompt('Reason for hiding (shown to the author):');
          if (reason !== null) act(`/${type}s/${post.id}/hide`, { hidden: true, reason });
        } }, 'Hide');
  const hiddenNote = (post) => {
    if (post.hidden) return h('p', { class: 'hidden-note' }, `Hidden by a moderator${post.hidden_reason ? `: ${post.hidden_reason}` : ''}`);
    if (post.moderation_status === 'held') {
      return h('p', { class: 'hidden-note' }, q.can_moderate
        ? `Held by the automatic check${post.moderation_reason ? `: ${post.moderation_reason}` : ''}. Only moderators and the author can see it.`
        : 'Waiting for a quick check by a moderator. Only you can see it for now.');
    }
    if (post.moderation_status === 'rejected') return h('p', { class: 'hidden-note' }, 'Not published by a moderator.');
    return null;
  };
  const reviewButtons = (type, post) =>
    q.can_moderate && post.moderation_status !== 'approved'
      ? [h('button', { class: 'textbtn accent', type: 'button', onclick: () => act(`/${type}s/${post.id}/review`, { approve: true }) }, 'Approve'),
         post.moderation_status === 'held' ? h('button', { class: 'textbtn', type: 'button', onclick: () => act(`/${type}s/${post.id}/review`, { approve: false }) }, 'Reject') : null]
      : null;

  const byline = (post) => {
    if (post.author_is_official) {
      return h('div', { class: 'byline' }, h('span', { class: 'name' }, q.university_name), icon(ICONS.verified),
        h('span', {}, `${post.author_name}  ·  ${when(post.created_at)}`));
    }
    const label = post.author_is_current_student ? h('span', { class: 'student' }, 'Current student') : h('span', {}, post.author_badge);
    return h('div', { class: 'byline' }, h('span', { class: 'name' }, post.author_name), label, h('span', {}, `·  ${when(post.created_at)}`));
  };

  const answer = (a) => {
    const accepted = a.id === q.accepted_answer_id;
    const notes = [
      accepted ? `★ ${q.author_name} found this most helpful` : null,
      a.endorsed && !a.author_is_official ? 'Confirmed by the university' : null,
    ].filter(Boolean);
    const pending = a.hidden || a.moderation_status !== 'approved';
    return h('article', { class: `answer${a.author_is_official ? ' official' : ''}${pending ? ' is-hidden' : ''}` },
      byline(a),
      hiddenNote(a),
      h('p', { class: 'body pre' }, a.body),
      h('div', { class: 'answer-foot' },
        notes.length ? h('span', {}, notes.join('  ·  ')) : null,
        isAsker && !a.hidden ? h('button', { class: 'textbtn accent', type: 'button', onclick: () => act(`/questions/${q.id}/accept`, { answerId: accepted ? null : a.id }) }, accepted ? 'Unmark' : 'Mark as most helpful') : null,
        q.can_moderate && !a.author_is_official ? h('button', { class: 'textbtn', type: 'button', onclick: () => act(`/answers/${a.id}/endorse`, { endorsed: !a.endorsed }) }, a.endorsed ? 'Remove confirmation' : 'Confirm as accurate') : null,
        reviewButtons('answer', a),
        q.can_moderate ? hideButton('answer', a) : null,
        me && me.id !== a.user_id && !q.can_moderate ? h('button', { class: 'textbtn', type: 'button', onclick: () => report('answer', a.id) }, 'Report') : null));
  };

  render(wrap(h('div', { class: 'thread' },
    h('a', { class: 'back', href: `#/u/${q.university_id}` }, `← ${q.university_name}`),
    h('article', { class: `question${q.hidden || q.moderation_status !== 'approved' ? ' is-hidden' : ''}` },
      h('h1', { class: 'display-md' }, q.title),
      h('p', { class: 'lead pre' }, q.body),
      h('p', { class: 'muted', style: { marginTop: '20px', fontSize: '15px' } }, `${q.author_name}, ${q.author_badge.toLowerCase()}  ·  ${when(q.created_at)}`),
      hiddenNote(q),
      h('div', { class: 'answer-foot' },
        reviewButtons('question', q),
        q.can_moderate ? hideButton('question', q) : null,
        me && me.id !== q.user_id && !q.can_moderate ? h('button', { class: 'textbtn', type: 'button', onclick: () => report('question', q.id) }, 'Report') : null)),
    h('h2', { class: 'eyebrow', style: { marginBottom: '8px' } }, plural(q.answers.length, 'answer')),
    q.answers.length ? q.answers.map(answer) : h('p', { class: 'empty', style: { borderTop: '1px solid var(--rule)' } }, 'No answers yet.'),
    q.hidden || q.moderation_status !== 'approved' ? null
      : me
        ? onSubmit(
            h('form', { class: 'reply stack' },
              h('label', {}, h('span', { class: 'heading-sm', style: { display: 'block', marginBottom: '18px', fontFamily: 'var(--display)' } }, 'Your answer.'),
                h('textarea', { name: 'body', required: true, maxlength: 5000, placeholder: 'Share what you know. Be kind and specific.', style: { borderRadius: '20px', padding: '20px 24px', fontSize: '18px' } })),
              h('div', { class: 'form-actions' },
                h('span', { class: 'muted small' }, `Posting as ${me.display_name}`),
                h('button', { type: 'submit', class: 'btn' }, 'Post answer →'))),
            async (data) => {
              await api(`/questions/${id}/answers`, { method: 'POST', body: data });
              pageQuestion(id);
            })
        : h('div', { class: 'reply stack' }, h('h3', { class: 'heading-sm' }, 'Your answer.'),
            h('p', { class: 'muted' }, 'Answers come from people with a profile, so readers know who is replying. ', loginLink(), ' or ', h('a', { class: 'linkline accent', href: '#/signup' }, 'create a profile'), '.'))
  )));
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
  render(wrap(
    h('a', { class: 'back', href: `#/u/${id}` }, `← ${u.name}`),
    h('section', { class: 'hero', style: { paddingTop: '40px' } },
      h('h1', { class: 'display-md' }, 'Moderation'),
      h('p', { class: 'lead', style: { marginTop: '24px', maxWidth: '640px' } }, 'Posts the automatic check held for review, and posts people reported. You can also hide posts and confirm accurate answers from any question page.')),
    h('nav', { class: 'tabs', 'aria-label': 'Report status' },
      h('a', { href: `#/u/${id}/moderation`, class: status === 'open' ? 'active' : null }, 'Open'),
      h('a', { href: `#/u/${id}/moderation?status=resolved`, class: status === 'resolved' ? 'active' : null }, 'Resolved')),
    h('div', { style: { marginTop: '32px' } },
      reports.length
        ? reports.map((r) =>
            h('div', { class: 'mod-item' },
              h('p', { class: 'muted small' }, r.source === 'auto'
                ? `${r.target_type === 'question' ? 'Question' : 'Answer'} held by the automatic check · ${when(r.created_at)}`
                : `Reported ${r.target_type} · by ${r.reporter_name} · ${when(r.created_at)}${r.hidden ? ' · hidden' : ''}`),
              h('p', {}, h('strong', {}, r.source === 'auto' ? 'Flagged for: ' : 'Reason: '), r.reason),
              h('div', { class: 'quote' },
                r.question_title ? h('h3', { style: { fontSize: '20px', marginBottom: '6px' } }, r.question_title) : null,
                h('p', { class: 'pre' }, r.content),
                h('p', { class: 'muted small', style: { marginTop: '8px' } }, `Written by ${r.author_name}`)),
              h('div', { class: 'actions' },
                h('a', { class: 'linkline', href: `#/q/${r.question_id}` }, 'Open question'),
                status === 'open' && r.moderation_status === 'held'
                  ? [h('button', { class: 'btn', type: 'button', onclick: () => act(`/${r.target_type}s/${r.target_id}/review`, { approve: true }) }, 'Approve'),
                     h('button', { class: 'btn light', type: 'button', onclick: () => act(`/${r.target_type}s/${r.target_id}/review`, { approve: false }) }, 'Reject')]
                  : null,
                status === 'open' && !r.hidden && r.moderation_status !== 'held'
                  ? h('button', { class: 'btn danger', type: 'button', onclick: () => {
                      const reason = prompt('Reason for hiding (shown to the author):', r.reason);
                      if (reason !== null) act(`/${r.target_type}s/${r.target_id}/hide`, { hidden: true, reason });
                    } }, 'Hide post')
                  : null,
                status === 'open' && r.moderation_status !== 'held' ? h('button', { class: 'btn light', type: 'button', onclick: () => act(`/reports/${r.id}/resolve`) }, 'Dismiss report') : null)))
        : h('p', { class: 'empty' }, status === 'open' ? 'Nothing to review.' : 'No resolved reports yet.'))
  ));
}

/* ------------------------------------------------------------------ network */

function personCard(p, { onChange } = {}) {
  const c = p.connection;
  let action = null;
  if (!c) action = h('button', { class: 'textbtn linkline', type: 'button', style: { color: 'var(--ink)', fontSize: '16px' }, onclick: () => requestConnection(p, onChange) }, 'Connect →');
  else if (c.status === 'accepted') action = h('a', { class: 'linkline', href: `#/chat/${c.id}` }, 'Message →');
  else if (c.status === 'pending' && c.direction === 'incoming') action = h('a', { class: 'linkline', href: '#/connections' }, 'Respond →');
  else if (c.status === 'pending') action = h('span', { class: 'muted small' }, 'Request sent');

  const role = p.role === 'student' ? `Studies at ${p.university_name}` : p.intake ? `Starting ${p.intake}` : 'Prospective student';
  const from = [p.home_city, p.home_country].filter(Boolean).join(', ');
  return h('article', { class: 'person' },
    h('a', { href: `#/people/${p.id}`, class: 'portrait', style: { backgroundColor: personColor(p.id) }, 'aria-label': `${p.display_name}'s profile` }, initial(p.display_name)),
    h('h3', {}, h('a', { href: `#/people/${p.id}` }, p.display_name)),
    h('span', { class: 'role' }, role),
    p.bio ? h('p', { class: 'small pre', style: { color: 'var(--ink-soft)' } }, p.bio) : null,
    h('span', { class: 'why' }, [from ? `From ${from}` : null, p.program].filter(Boolean).join('  ·  ')),
    p.targets?.length ? h('span', { class: 'why' }, `Considering ${p.targets.map((t) => t.name).join(', ')}`) : null,
    action ? h('div', { class: 'action' }, action) : null);
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

function requestRow(c, respond) {
  return h('section', { class: 'request', 'aria-label': `Connection request from ${c.person.display_name}` },
    h('div', { class: 'person-row' },
      h('span', { class: 'avatar', 'aria-hidden': 'true', style: { backgroundColor: personColor(c.person.id) } }, initial(c.person.display_name)),
      h('div', {},
        h('p', { style: { fontFamily: 'var(--display)', fontWeight: '700', fontSize: '22px', letterSpacing: '-0.02em' } },
          h('a', { href: `#/people/${c.person.id}` }, c.person.display_name), ' wants to connect'),
        c.note ? h('p', { class: 'pre', style: { color: 'var(--ink-soft)' } }, `“${c.note}”`) : null)),
    h('div', { class: 'actions' },
      h('button', { class: 'textbtn', type: 'button', onclick: () => respond(c.id, false) }, 'Decline'),
      h('button', { class: 'btn', type: 'button', onclick: () => respond(c.id, true) }, 'Accept')));
}

async function pageNetwork(params) {
  if (!me) return needLogin();
  const [{ people }, { universities }, { incoming }] = await Promise.all([
    api(`/people?${params}`),
    api('/universities?sort=name'),
    api('/connections'),
  ]);

  const role = h('select', { class: 'inline-select', name: 'role', 'aria-label': 'Who to show' },
    [['', 'everyone'], ['prospective', 'prospective students'], ['student', 'current students']].map(([v, l]) => h('option', { value: v, selected: (params.get('role') || '') === v }, l)));
  const uni = h('select', { class: 'inline-select', name: 'universityId', 'aria-label': 'University' },
    h('option', { value: '' }, 'any university'),
    universities.map((u) => h('option', { value: u.id, selected: params.get('universityId') === String(u.id) }, u.name)));
  const country = h('input', { class: 'inline-select', name: 'homeCountry', placeholder: 'anywhere', value: params.get('homeCountry') || '', 'aria-label': 'Home country' });
  const apply = () => {
    const p = new URLSearchParams();
    for (const el of [role, uni, country]) if (el.value.trim()) p.set(el.name, el.value.trim());
    go(`#/network?${p}`);
  };
  role.addEventListener('change', apply);
  uni.addEventListener('change', apply);
  country.addEventListener('change', apply);

  const respond = async (cid, accept) => {
    await api(`/connections/${cid}/respond`, { method: 'POST', body: { accept } });
    await refreshMe();
    pageNetwork(params);
  };

  render(wrap(
    h('section', { class: 'hero' },
      h('h1', { class: 'display' }, 'People going', h('br'), 'where ', h('span', { class: 'accent' }, "you're going."))),
    incoming.map((c) => requestRow(c, respond)),
    h('div', { class: 'filters-line' }, 'Showing', role, 'at', uni, 'from', country),
    people.length
      ? h('div', { class: 'people' }, people.map((x) => personCard(x, { onChange: () => pageNetwork(params) })))
      : h('p', { class: 'empty' }, 'No one matches those filters yet.')
  ));
}

async function pagePerson(id) {
  if (!me) return needLogin();
  const { person } = await api(`/people/${id}`);
  render(wrap(
    h('a', { class: 'back', href: '#/network' }, '← Network'),
    h('div', { style: { maxWidth: '360px', marginTop: '40px' } }, personCard(person, { onChange: () => pagePerson(id) }))
  ));
}

async function pageConnections() {
  if (!me) return needLogin();
  const { incoming, outgoing, connected } = await api('/connections');
  const respond = async (cid, accept) => {
    await api(`/connections/${cid}/respond`, { method: 'POST', body: { accept } });
    await refreshMe();
    pageConnections();
  };
  const withdraw = async (cid) => {
    await api(`/connections/${cid}`, { method: 'DELETE' });
    pageConnections();
  };
  render(wrap(
    h('section', { class: 'hero' }, h('h1', { class: 'display' }, 'Messages')),
    incoming.map((c) => requestRow(c, respond)),
    h('h2', { class: 'eyebrow', style: { margin: '72px 0 8px' } }, 'Conversations'),
    connected.length
      ? h('div', {}, connected.map((c) =>
          h('a', { class: 'convo', href: `#/chat/${c.id}` },
            h('div', { class: 'person-row' },
              h('span', { class: 'avatar', 'aria-hidden': 'true', style: { backgroundColor: personColor(c.person.id), width: '52px', height: '52px', fontSize: '20px' } }, initial(c.person.display_name)),
              h('div', { style: { minWidth: 0 } },
                h('h3', {}, c.person.display_name, c.unread ? h('span', { class: 'count' }, c.unread) : null),
                h('p', { class: 'muted small' }, c.last_message ? c.last_message.slice(0, 120) : 'No messages yet. Say hello.'))),
            h('span', { class: 'muted small' }, c.last_message_at ? when(c.last_message_at) : ''))))
      : h('p', { class: 'empty' }, 'No connections yet. ', h('a', { class: 'linkline accent', href: '#/network' }, 'Find people to connect with')),
    outgoing.length ? h('h2', { class: 'eyebrow', style: { margin: '72px 0 8px' } }, 'Sent requests') : null,
    outgoing.map((c) =>
      h('div', { class: 'convo' },
        h('span', {}, h('strong', {}, c.person.display_name), h('span', { class: 'muted small' }, `  ·  sent ${when(c.created_at)}`)),
        h('button', { class: 'textbtn', type: 'button', onclick: () => withdraw(c.id) }, 'Withdraw')))
  ));
}

async function pageChat(id) {
  if (!me) return needLogin();
  let lastId = 0;
  const list = h('div', { class: 'chat', 'aria-live': 'polite' });
  const append = (msgs) => {
    for (const m of msgs) {
      list.append(h('div', { class: `msg${m.sender_id === me.id ? ' mine' : ''}` }, h('div', { class: 'pre' }, m.body), h('div', { class: 'when' }, when(m.created_at))));
      lastId = Math.max(lastId, m.id);
    }
    if (msgs.length) list.scrollTop = list.scrollHeight;
  };
  const { person, messages } = await api(`/connections/${id}/messages`);
  const form = onSubmit(
    h('form', { class: 'chat-form' },
      h('textarea', { name: 'body', required: true, maxlength: 2000, placeholder: `Message ${person.display_name}`, 'aria-label': 'Message' }),
      h('button', { type: 'submit', class: 'btn' }, 'Send')),
    async (data) => {
      await api(`/connections/${id}/messages`, { method: 'POST', body: data });
      form.reset();
      append((await api(`/connections/${id}/messages?after=${lastId}`)).messages);
    });
  form.querySelector('textarea').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  render(wrap(h('div', { class: 'thread' },
    h('a', { class: 'back', href: '#/connections' }, '← Messages'),
    h('h1', { class: 'display-md', style: { marginTop: '24px' } }, h('a', { href: `#/people/${person.id}` }, person.display_name)),
    h('p', { class: 'accent', style: { fontWeight: '600', marginTop: '8px' } }, person.role === 'student' ? `Studies at ${person.university_name}` : 'Prospective student'),
    list,
    form)));
  append(messages);
  refreshMe();
  // Check for new messages every few seconds while the chat is open.
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
  const [{ profile: p }, { universities }] = await Promise.all([api('/me/profile'), api('/universities?sort=name')]);
  const isStudentLike = me.role === 'prospective' || me.role === 'student';
  const targetIds = new Set(p.targets.map((t) => t.id));
  const input = (name, attrs = {}) => h('input', { name, value: p[name] ?? '', ...attrs });
  const who =
    me.role === 'student' ? `Current student at ${me.university_name}.`
      : me.role === 'university_rep' ? `Representative of ${me.university_name}${me.rep_status === 'approved' ? '.' : ', waiting for an admin to verify your account.'}`
        : me.role === 'admin' ? 'Site admin.' : 'Prospective student.';

  render(wrap(
    h('section', { class: 'hero' },
      h('h1', { class: 'display-md' }, 'Your profile'),
      h('p', { class: 'lead', style: { marginTop: '20px' } }, who, isStudentLike ? ' Other students see this on the Network page.' : '')),
    onSubmit(
      h('form', { class: 'stack', style: { maxWidth: '760px' } },
        field('Display name', h('input', { name: 'displayName', value: p.display_name, required: true, maxlength: 60 })),
        isStudentLike ? [
          field('About you', h('textarea', { name: 'bio', maxlength: 1000, placeholder: 'What are you studying, or hoping to study? What can you help others with?' }, p.bio || '')),
          h('div', { class: 'two-col' }, field('Home country', input('home_country', { placeholder: 'India' })), field('Home city', input('home_city', { placeholder: 'Pune' }))),
          field('Program', input('program', { placeholder: 'BSc Computer Science' })),
          me.role === 'prospective'
            ? field('When do you plan to start?', input('intake', { placeholder: 'Fall 2027' }))
            : field('Graduation year', input('grad_year', { type: 'number', min: 1990, max: 2100 })),
          me.role === 'prospective'
            ? h('fieldset', { style: { marginTop: '16px' } },
                h('legend', {}, 'Universities you are considering'),
                h('div', { class: 'checks' }, universities.map((u) =>
                  h('label', {}, h('input', { type: 'checkbox', name: 'target', value: u.id, checked: targetIds.has(u.id) }), u.name))))
            : null,
        ] : null,
        h('div', { class: 'actions', style: { marginTop: '16px' } }, h('button', { type: 'submit', class: 'btn' }, 'Save profile'))),
      async (_data, form) => {
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
        form.querySelector('.notice')?.remove();
        form.append(h('p', { class: 'notice', role: 'status' }, 'Saved.'));
      })
  ));
}

/* ------------------------------------------------------------------ auth */

function pageLogin(params) {
  const next = params.get('next') || '#/';
  render(wrap(
    h('section', { class: 'hero' }, h('h1', { class: 'display' }, 'Welcome', h('br'), h('span', { class: 'accent' }, 'back.'))),
    onSubmit(
      h('form', { class: 'stack form-narrow' },
        field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        h('div', { class: 'form-actions' },
          h('a', { class: 'textbtn accent', href: '#/signup' }, 'New here? Create a profile →'),
          h('button', { type: 'submit', class: 'btn' }, 'Log in'))),
      async (data) => {
        await api('/auth/login', { method: 'POST', body: data });
        await refreshMe();
        go(next.startsWith('#/') ? next : '#/');
      })
  ));
}

async function pageSignup() {
  const { universities } = await api('/universities?sort=name');
  const uniField = field('Your university', h('select', { name: 'universityId' },
    h('option', { value: '' }, 'Choose…'),
    universities.map((u) => h('option', { value: u.id }, u.name))));
  const hint = h('p', { class: 'muted small' });
  const human = humanCheck();
  const form = h('form', { class: 'stack form-narrow' },
    field('I am a…', h('select', { name: 'role' },
      h('option', { value: 'prospective' }, 'Prospective student'),
      h('option', { value: 'student' }, 'Current student at a university'),
      h('option', { value: 'university_rep' }, 'University staff (admissions / international office)'))),
    uniField,
    hint,
    field('Display name', h('input', { name: 'displayName', required: true, maxlength: 60 })),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('Password (at least 8 characters)', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    human.nodes,
    h('div', { class: 'form-actions' },
      h('a', { class: 'textbtn', href: '#/login' }, 'Already have a profile? Log in'),
      h('button', { type: 'submit', class: 'btn' }, 'Create profile')));
  const sync = () => {
    const role = form.role.value;
    uniField.hidden = role === 'prospective';
    hint.hidden = role === 'prospective';
    hint.textContent = role === 'student'
      ? 'Use your university email address so we can confirm you study there.'
      : 'Use your university email address. An admin verifies staff accounts before they can answer officially or edit the profile.';
  };
  form.role.addEventListener('change', sync);
  sync();
  render(wrap(
    h('section', { class: 'hero' }, h('h1', { class: 'display' }, 'Create your', h('br'), h('span', { class: 'accent' }, 'profile.'))),
    onSubmit(form, async (data) => {
      if (data.role === 'prospective') delete data.universityId;
      await api('/auth/signup', { method: 'POST', body: { ...data, ...human.values() } });
      await refreshMe();
      go('#/profile');
    })
  ));
}

/* ------------------------------------------------------------------ admin */

async function pageAdmin() {
  if (!me || me.role !== 'admin') return render(wrap(h('p', { class: 'error', style: { marginTop: '64px' } }, 'Admins only.')));
  const [{ reps }, { reports }] = await Promise.all([api('/admin/reps'), api('/reports')]);
  const act = async (path) => {
    await api(path, { method: 'POST' });
    pageAdmin();
  };
  render(wrap(
    h('section', { class: 'hero' },
      h('h1', { class: 'display-md' }, 'Verify representatives'),
      h('p', { class: 'lead', style: { marginTop: '20px', maxWidth: '640px' } }, 'Check that each person really works for the university (for example by contacting its international office) before approving.')),
    reps.length
      ? reps.map((r) =>
          h('div', { class: 'convo' },
            h('div', {}, h('h3', {}, r.display_name), h('p', { class: 'muted small' }, `${r.email}  ·  ${r.university_name}  ·  signed up ${when(r.created_at)}`)),
            h('div', { class: 'actions' },
              h('button', { class: 'textbtn', type: 'button', onclick: () => act(`/admin/reps/${r.id}/reject`) }, 'Reject'),
              h('button', { class: 'btn', type: 'button', onclick: () => act(`/admin/reps/${r.id}/approve`) }, 'Approve'))))
      : h('p', { class: 'empty' }, 'No one is waiting.'),
    h('h2', { class: 'heading-sm', style: { marginTop: '120px' } }, 'Moderation across all universities'),
    h('p', { class: 'muted', style: { marginTop: '12px' } }, 'Includes boards that have no representative yet.'),
    h('div', { style: { marginTop: '24px' } },
      reports.length
        ? reports.map((r) =>
            h('a', { class: 'convo', href: `#/u/${r.university_id}/moderation` },
              h('div', {}, h('h3', {}, r.question_title || (r.content || '').slice(0, 80)),
                h('p', { class: 'muted small' }, `${r.university_name}  ·  ${r.source === 'auto' ? `held automatically: ${r.reason}` : `reported: ${r.reason}`}`)),
              h('span', { class: 'muted small' }, when(r.created_at))))
        : h('p', { class: 'empty' }, 'Nothing to review.'))
  ));
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
        else render(wrap(h('div', { style: { marginTop: '64px' } }, errorBox(err))));
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  render(wrap(h('section', { class: 'hero' }, h('h1', { class: 'display-md' }, 'Page not found.'), h('p', { style: { marginTop: '24px' } }, h('a', { class: 'linkline accent', href: '#/' }, 'Go home')))));
}

window.addEventListener('hashchange', route);
Promise.all([
  refreshMe().catch(() => {}),
  api('/config').then((c) => { config = c; }).catch(() => {}),
]).finally(route);
