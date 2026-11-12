# Notes for coding agents working on this repo

intlstudent helps prospective international students find universities, ask questions on per-university boards, and network with students. Read `README.md` for the full picture.

## Run and test

```bash
npm install
npm start            # http://localhost:3000, with demo data
npm run lint
npm test             # API and authorization tests (node:test, real in-memory SQLite, no mocks)
npm run test:coverage
npm run test:e2e     # browser tests (Playwright); needs `npx playwright-core install chromium` once
npm run authz:check  # stored authorization tuples match the data
```

CI runs all of these on every pull request, and they're required to merge. Add a test with every behaviour change.

## Rules that must hold

**Only people post.** Every route that creates content (questions, answers, reports, messages, connection requests, signups) must:

1. be rate limited with `ctx.limiter.hit(...)` (`src/protection.js`);
2. for anyone without a profile (guest questions) and for signups, pass `requireHuman(req, ctx.verifyHuman)`: the bot traps and the human check;
3. for questions and answers, go through `classify()` (`src/moderation.js`), saving flagged posts as `held` and raising an `auto` report so they reach the moderation queue.

Never add an endpoint, API key, or flag that lets automated clients skip these. Guests may ask questions but never answer them.

**Privacy.** Student profiles, the network, and messages are for logged-in users only. Never expose email addresses in API responses other than the user's own. Don't send user data to third parties without the owner's agreement.

**Who can do what.** Authorization is Zanzibar-style relationship tuples (`src/authz.js`, explained in `docs/authorization.md`). Routes ask only for permissions: `ctx.authz.check(type, id, 'can_…', userId)`. Never check `users.role` to decide access.
- To add a permission, add it to `MODEL` and to the DSL in `docs/authorization.md`, with tests in `test/authz.test.js`.
- Any data change that grants or revokes access must write or delete its tuples **in the same `tx()`**, and `expectedTuples()` must derive the same tuples from the data, or `authz:check` fails.
- Only admins can change a university's verification email domain. Representatives act only on their own university.

## Code conventions

- Plain Node and Express; SQLite through `node:sqlite`; the frontend is plain JavaScript with no build step.
- Schema changes: update the DDL in `src/db.js` **and** add a numbered migration in `migrate()` so existing databases upgrade.
- Frontend: build DOM with `h()` (text is never parsed as HTML). Styles use the tokens in `public/styles.css`. The design is minimal and bold: no boxed cards, pills or badges; use type, spacing, thin rules and rounded shapes. Keep pages working at phone width and in dark mode.
- The Content-Security-Policy blocks inline scripts and inline `style` attributes; set styles through `h()`'s `style` object (CSSOM) or classes.
