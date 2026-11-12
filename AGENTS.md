# Notes for coding agents working on this repo

intlstudent helps prospective international students find universities, ask questions on per-university boards, and network with students. Read `README.md` for the full picture.

## Run and test

```bash
npm install
npm start            # http://localhost:3000, with demo data
npm test             # API tests (node:test, real in-memory SQLite, no mocks)
npm run test:e2e     # browser tests (Playwright); needs `npx playwright-core install chromium` once
```

Run both test suites before pushing. Add a test with every behaviour change.

## Rules that must hold

**Only people post.** Every route that creates content (questions, answers, reports, messages, connection requests, signups) must:

1. be rate limited with `ctx.limiter.hit(...)` (`src/protection.js`);
2. for anyone without a profile (guest questions) and for signups, pass `requireHuman(req, ctx.verifyHuman)`: the bot traps and the human check;
3. for questions and answers, go through `classify()` (`src/moderation.js`), saving flagged posts as `held` and raising an `auto` report so they reach the moderation queue.

Never add an endpoint, API key, or flag that lets automated clients skip these. Guests may ask questions but never answer them.

**Privacy.** Student profiles, the network, and messages are for logged-in users only. Never expose email addresses in API responses other than the user's own. Don't send user data to third parties without the owner's agreement.

**Who can do what.** Use `auth.canModerate()` and `auth.isApprovedRepOf()` for permissions. Only admins can change a university's verification email domain. Representatives act only on their own university.

## Code conventions

- Plain Node and Express; SQLite through `node:sqlite`; the frontend is plain JavaScript with no build step.
- Schema changes: update the DDL in `src/db.js` **and** add a numbered migration in `migrate()` so existing databases upgrade.
- Frontend: build DOM with `h()` (text is never parsed as HTML). Styles use the tokens in `public/styles.css`. The design is minimal and bold: no boxed cards, pills or badges; use type, spacing, thin rules and rounded shapes. Keep pages working at phone width and in dark mode.
- The Content-Security-Policy blocks inline scripts and inline `style` attributes; set styles through `h()`'s `style` object (CSSOM) or classes.
