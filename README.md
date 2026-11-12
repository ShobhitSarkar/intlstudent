# intlstudent

Helping international students choose a university and connect with the people who already go there.

## What it does

**For prospective students**
- **Find universities**: search by name, city or country, filter by country and maximum yearly tuition (compared in USD), and sort by tuition or by how active the board is. Each university page shows its location, website, contact email and phone, and international tuition in its own currency.
- **Discussion boards**: every university has a Q&A board. Anyone logged in can ask or answer. Every post shows who wrote it:
  - **University representative**: verified staff of that university. Their answers are shown first.
  - **Current student**: someone signed up with that university's email domain.
  - **Prospective student**: everyone else.

  The person who asked can mark the answer that helped them most.
- **Network**: students fill in a profile (home country and city, program, intake, and the universities they're considering). The directory suggests people who are considering the same universities or come from the same country, plus current students at those universities. You send a **connection request** with an optional note, and **direct messages** open only after the other person accepts.

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

Run the API tests with:

```bash
npm test
```

Run the browser tests (Playwright, drives the real app in Chromium; checks search, the question page, posting, messaging, and that mobile and dark mode fit the screen):

```bash
npx playwright-core install chromium
```

```bash
npm run test:e2e
```

Settings, all optional: `PORT` (default 3000), `DB_FILE` (default `data/intlstudent.db`), and `SEED_DEMO=false` to skip the demo data. Demo data is never created when `NODE_ENV=production`.

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

## Project layout

```
src/
  server.js            starts the app
  app.js               Express setup, security headers, error handling
  db.js                SQLite schema
  auth.js              passwords (scrypt), sessions, permission checks
  http.js              input-validation helpers
  seed.js              sample data
  routes/
    auth.js            sign up, log in, current user
    universities.js    search, detail, profile editing
    boards.js          questions, answers, reports, moderation
    network.js         profiles, directory, connection requests, messages
    admin.js           approving representatives
public/                single-page frontend (plain JavaScript, no build step)
test/api.test.js       API tests (node:test)
test/e2e/ui.test.js    browser tests (Playwright)
```

## Before a real launch

- **Confirm email ownership.** Signups currently check the email *domain* but don't send a confirmation link, so someone could type an address that isn't theirs. Add email verification before trusting the "Current student" badge.
- **Real university data**, with a source and a date for every tuition figure.
- **Rate limiting** on login, signup, posting and connection requests (outgoing requests are already capped at 25 pending).
- **Blocking and reporting people** in the network, not just posts.
- **Real-time messaging** with WebSockets or server-sent events. The chat currently checks for new messages every 5 seconds.
- **Notifications by email** for answers, connection requests and messages.
- **A hosted database** (e.g. Postgres) once you need more than one server.
- **Events page.**
