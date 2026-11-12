# Authorization

intlstudent uses relationship-based access control in the style of Google's Zanzibar. Every grant is stored as a **relationship tuple**, and every permission is **computed** from tuples by a schema. Nothing in the routes checks roles directly.

- Engine and schema: `src/authz.js`
- Tuples: the `relation_tuples` table
- Drift check: `npm run authz:check` (also run in CI and in the test suite)

## Tuples

A tuple says *subject has relation on object*:

```
object_type:object_id#relation@subject_type:subject_id[#subject_relation]
```

| Example | Meaning |
| --- | --- |
| `platform:main#admin@user:1` | user 1 is a site admin |
| `platform:main#networker@user:2` | user 2 takes part in networking (prospective and current students) |
| `university:1#platform@platform:main` | university 1 belongs to the platform (so platform admins inherit power over it) |
| `university:1#representative@user:7` | user 7 is a **verified** representative of university 1 (written when an admin approves them) |
| `university:1#student@user:5` | user 5 is a current student there (verified by their university email domain) |
| `university:1#considering@user:2` | user 2 is considering university 1 |
| `question:12#board@university:1` | question 12 is on university 1's board |
| `question:12#author@user:2` | user 2 asked question 12 (guest questions have no author tuple) |
| `answer:30#question@question:12` | answer 30 belongs to question 12 |
| `answer:30#author@user:5` | user 5 wrote answer 30 |
| `connection:4#requester@user:2`, `connection:4#addressee@user:3` | a connection request from 2 to 3 |
| `connection:4#member@user:2`, `…#member@user:3` | the request was accepted |

Subjects can also be **usersets** (`group:9#member`), meaning "everyone with that relation". The app doesn't use them yet, but the engine supports them for teams and groups later.

## Schema

This is the model in OpenFGA's DSL. It maps one-to-one onto `MODEL` in `src/authz.js`, and onto SpiceDB, so the tuples could move to a dedicated authorization service without changes.

```
model
  schema 1.1

type user

type platform
  relations
    define admin: [user]
    define networker: [user]
    define can_moderate_all: admin

type university
  relations
    define platform: [platform]
    define representative: [user]
    define student: [user]
    define considering: [user]
    define moderator: representative or admin from platform
    define can_moderate: moderator
    define can_edit_profile: moderator
    define can_edit_email_domain: admin from platform

type question
  relations
    define board: [university]
    define author: [user]
    define can_moderate: can_moderate from board
    define can_view_unpublished: author or can_moderate
    define can_accept_answer: author

type answer
  relations
    define question: [question]
    define author: [user]
    define can_moderate: can_moderate from question
    define can_view_unpublished: author or can_moderate

type connection
  relations
    define requester: [user]
    define addressee: [user]
    define member: [user]
    define can_view: requester or addressee
    define can_respond: addressee
    define can_message: member
```

Relations starting with `can_` are permissions. The routes only ever ask for permissions, never for the underlying relations, so who-can-do-what can change in one place.

## What stays outside the tuples

Zanzibar models relationships, not state. A few rules depend on the state of a record and stay in the route code, next to the permission check:

- a connection request can only be answered while it is `pending`;
- hidden or held posts are public only once approved (`can_view_unpublished` decides who sees them before that);
- guests can ask but never answer (an answer always needs a signed-in author).

## Keeping tuples correct

1. **Same transaction.** Every change that grants or revokes access writes its tuples in the same database transaction as the data change (`tx()` in `src/authz.js`): signing up, approving or rejecting a representative, creating a university, asking, answering, connecting, accepting, disconnecting, and updating the universities you're considering.
2. **Validated writes.** `authz.write()` refuses tuples the schema doesn't allow (for example, granting a computed permission directly, or a user as a question's board).
3. **Derivable, then checked.** `expectedTuples()` re-derives every tuple from the domain tables. `diffTuples()` compares that with what's stored:
   - the API test suite ends by asserting there's no drift after every operation it ran;
   - `npm run authz:check` reports drift on a real database (and `-- --fix` writes missing tuples);
   - CI runs it against a freshly seeded database.
4. **Migrations backfill.** When the tuple table was introduced (schema version 3), existing databases were backfilled from their data on startup.

## Performance

`check()` walks the schema with a few indexed lookups per step and guards against cycles. For list pages, calling it per row would be wasteful, so a few queries use `directRelationSql()` to join the tuples table directly. That helper refuses relations that aren't direct-only, so the shortcut can't silently skip a rewrite rule. If traffic grows, the usual next steps are caching checks per request, or moving to OpenFGA or SpiceDB with the same schema and tuples.
