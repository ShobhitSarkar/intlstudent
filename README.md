# intlstudent

Helping international students choose a university and connect with the people who already go there.

## What it does

**For prospective students**
- **Find universities**: search by name, city or country, filter by country and maximum yearly tuition (compared in USD), and sort by tuition or by how active the board is. Each university page shows its location, website, contact email and phone, and international tuition in its own currency.
- **Discussion boards**: every university has a Q&A board. Anyone logged in can ask or answer. Every post shows who wrote it:
  - **University representative**: verified staff of that university. Their answers are shown first.
  - **Current student**: someone signed up with that university's email domain.
  - **Prospective student**: everyone else.

  The person who asked can mark the answer that helped them most. **Guests can ask without a profile, but only people with a profile can answer.**
- **Network**: students fill in a profile (home country and city, program, intake, and the universities they're considering). The directory suggests people who are considering the same universities or come from the same country, plus current students at those universities. You send a **connection request** with an optional note, and **direct messages** open only after the other person accepts.

**Keeping it human and safe**
- **Automatic moderator, always on:** every question and answer is checked before it appears (`src/moderation.js`). Clean posts publish straight away. Posts that look like harassment, scams aimed at students (paid "guaranteed admission", visa-agent fees, essay writing), spam, or (from guests) links and contact details are **held** for a person to approve or reject. It's rule-based for now and built so a trained classifier can be added alongside it.
- **Proof of a person:** guest questions and new profiles pass a human check (Cloudflare Turnstile, when configured) and bot traps (a hidden field and a minimum time to fill in the form).
- **Rate limits** on logging in, signing up, guest and member posts, reports, messages and connection requests.
- **Bot policy:** `/robots.txt` and `/agents.md` tell crawlers and AI agents they may read public pages but must never post, sign up or message. The checks above enforce it. `AGENTS.md` in the repo gives the same rule to coding agents working on this code.

**For universities**
- **Moderation**: verified representatives can hide posts on their own board (the author still sees their post along with the reason), endorse accurate answers from students, and work through a queue of posts users have reported.
- **Profile editing**: representatives keep their university's description, contacts and tuition up to date.

**Not built yet:** the events page, which is planned as a later add-on.

## Running it

Needs Node.js 22.13 or newer. There is no separate database: SQLite is built into Node.

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000. In development, sample universities and demo accounts are created on first run. Every demo account uses the password `password123`.

| Email                    | Role                                     |
| ------------------------ | ---------------------------------------- |
| `priya@example.com`      | Prospective student                      |
| `maria@utoronto.ca`      | Current student, University of Toronto   |
| `admissions@utoronto.ca` | University of Toronto representative     |
| `admin@intlstudent.test` | Site admin (approves representatives)    |

Run the API and authorization tests with:

```bash
npm test
```

Other checks (all run in CI):

```bash
npm run lint
```

```bash
npm run test:coverage
```

```bash
npm run authz:check
```

Run the browser tests (Playwright, drives the real app in Chromium; checks search, the question page, posting, messaging, and that mobile and dark mode fit the screen):

```bash
npx playwright-core install chromium
```

```bash
npm run test:e2e
```

Settings:

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DB_FILE` | Database file (default `data/intlstudent.db`) |
| `SEED_DEMO=false` | Skip the demo data (never created when `NODE_ENV=production`) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile keys for the human check. Without them the check is skipped in development and **guest questions and signups are refused in production** |
| `TRUST_PROXY` | Set (e.g. `1`) when running behind a proxy or load balancer, so rate limits see each visitor's real IP |

Existing databases are upgraded automatically on startup.

> **The tuition figures in the sample data are rough, illustrative numbers.** Replace them with real figures (or have each university's representatives update them) before anyone relies on them.

## Design

Minimal and bold: large tight type (Inter Tight for headings, Inter for text), brown ink with a burnt-orange accent, rounded shapes and generous space, with no boxed cards or badges. Light and dark mode follow the visitor's system setting, and every page works at phone width. Each university page uses that university's colour and campus photo (`brand_color` and `photo_url`, editable by its representatives); until a photo is added, the colour fills the space. Fonts are served from the app itself, so pages make no requests to font services.

A university shows as **University active** when one of its verified representatives has answered on its board in the last 30 days.

## How accounts and trust work

| Role                | How you get it                                                                | What you can do                                         |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| Prospective student | Anyone can sign up                                                            | Ask, answer, report posts, network                      |
| Current student     | Sign up with an email at the university's domain (e.g. `@utoronto.ca`)        | The above, with a "Current student" badge on that board |
| Representative      | University email address **and** approval by an admin                         | Official answers, moderation, editing the profile       |
| Admin               | `npm run make-admin -- you@example.com` on the server                         | Approve representatives, add universities, moderate everywhere |

Representatives need an admin's approval because students share the same email domain as staff. Only admins can change a university's verification email domain.

**How permissions are enforced:** relationship-based authorization in the style of Google's Zanzibar. Every grant is a tuple such as `university:1#representative@user:7`, and permissions like `can_moderate` are computed from tuples by a schema in `src/authz.js`. Tuples are written in the same transaction as the data they describe, and `npm run authz:check` (also run in CI and the tests) fails if they drift. Full model: [docs/authorization.md](docs/authorization.md).

## CI and merging

GitHub Actions (`.github/workflows/`) runs on every pull request and on `main`:

| Check | What it does |
| --- | --- |
| Lint | ESLint |
| API tests | API and authorization tests, failing below 90% line, 75% branch or 80% function coverage |
| Browser tests | Playwright against the real app in Chromium |
| Authorization tuples | Builds a database through the migrations and seed, then checks every tuple matches the data |
| Dependency audit | `npm audit` on production dependencies |
| CodeQL | GitHub's security analysis (also weekly) |

Dependabot opens weekly updates for npm packages and GitHub Actions.

**To require these checks before merging into `main`:** in the GitHub repo, go to Settings → Rules → Rulesets → New ruleset → Import a ruleset, and choose `.github/rulesets/protect-main.json`. It requires a pull request with every check passing and up to date with `main`, resolved review threads and linear history, and blocks force-pushes and deleting `main`. It requires 0 approvals so a solo maintainer can still merge; raise `required_approving_review_count` once there's a team.

## Project layout

```
src/
  server.js            starts the app
  app.js               Express setup, security headers, error handling
  db.js                SQLite schema
  auth.js              passwords (scrypt), sessions
  authz.js             authorization: tuple schema, check engine, drift detection
  http.js              input-validation helpers
  moderation.js        the automatic moderator
  protection.js        rate limits, human check, bot traps
  seed.js              sample data
  routes/
    auth.js            sign up, log in, current user
    universities.js    search, detail, profile editing
    boards.js          questions (members and guests), answers, reports, moderation
    network.js         profiles, directory, connection requests, messages
    admin.js           approving representatives
docs/authorization.md  the authorization model
.github/               CI workflows, CodeQL, Dependabot, branch ruleset
public/                single-page frontend (plain JavaScript, no build step)
test/api.test.js       API tests (node:test)
test/authz.test.js     authorization model tests
test/e2e/ui.test.js    browser tests (Playwright)
```

## Before a real launch

- **Backfill university data.** Collect and import real data (tuition, contacts, photos, colours) for every university, with a source and date for each figure. This is its own workstream, still to be planned.
- **Confirm email ownership.** Signups currently check the email *domain* but don't send a confirmation link, so someone could type an address that isn't theirs. Add email verification before trusting the "Current student" badge.
- **Real university data**, with a source and a date for every tuition figure.
- **Shared rate-limit storage** (e.g. Redis) once there's more than one server; limits are counted in memory today.
- **A trained classifier** alongside the rule-based moderator, and a maintained list of abusive terms.
- **Blocking and reporting people** in the network, not just posts.
- **Real-time messaging** with WebSockets or server-sent events. The chat currently checks for new messages every 5 seconds.
- **Notifications by email** for answers, connection requests and messages.
- **A hosted database** (e.g. Postgres) once you need more than one server.
- **Events page.**
