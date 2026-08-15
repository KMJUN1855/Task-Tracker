# Task Tracker — working notes

Personal time/task tracker. Live at <https://task-tracker-j0oq.onrender.com>,
repo `KMJUN1855/Task-Tracker` (private). Read `README.md` for the full design;
this file is only what you need before touching anything.

Node + Express + `@libsql/client`, Turso in the cloud. Frontend is plain ES
modules in `public/` — **no build step, no framework, no CDN**. What is
committed is exactly what runs.

## Invariants — breaking these silently corrupts data

- **Never store elapsed/accumulated time.** Only absolute `start_time` /
  `end_time` pairs in `sessions`; every duration is recomputed on read. Same for
  exercise rest, which is the gap between adjacent sets. Do not add a
  "seconds_total" column for performance.
- **All timestamps are UTC ISO-8601.** Timezone is applied only at display time
  (`tz` query param / browser locale). The user is relocating Korea → Canada, so
  this is load-bearing, and DST-aware day lengths matter in the calendar.
- **`DATABASE_URL` is the only difference between deployment phases.** Keep all
  DB specifics inside `src/db.js`.
- **Colour is never the only signal** — every state colour is paired with an
  icon and a word. Applies to new UI too.
- A workout spans *every* session of its task, not just the latest.

## Commands

```bash
npm start          # server (reads .env)
npm run smoke      # 89 end-to-end checks against a throwaway DB — run after ANY change
npm run migrate    # apply schema to whatever DATABASE_URL points at
npm run icons      # regenerate PWA PNGs from tools/make-icons.mjs
```

`npm run smoke` forces `GROQ_API_KEY=''` so it never spends API quota.

## Deploying

Push to `main` → Render auto-deploys in ~40s. It has been slower; do not
conclude a deploy failed without checking. `GET /api/ai/status` returns
`retries` and `provider`, which is a free way to tell which build is live
without spending an API call.

**Migrations run at boot and a throwing migration takes the whole service
down** (`start()` awaits it). Test migrations against the real Turso database,
not just a local file — the stored DDL differs and that difference has already
broken one deploy.

Known trap: `ALTER TABLE ... DROP COLUMN` rewrites the stored `CREATE TABLE`
text, so a trailing `--` comment on the last column leaves a dangling comma
("incomplete input"). `exercise_sets` therefore has no inline comments. Rebuild
the table instead of dropping a column.

## Env

`DATABASE_URL`, `DATABASE_AUTH_TOKEN` (Turso), `PORT`, `ALLOWED_ORIGINS`,
`GROQ_API_KEY`, `GROQ_MODEL`. Local values live in `.env` (gitignored); Render
has its own copy in the dashboard — **changing one means changing both**.

## Open issues

- **Start/Pause/Stop feel laggy on the Exercise page.** Every action awaits the
  API round trip and then `ctx.reload()`, which re-fetches and re-renders the
  whole page before the button responds. On the Render free tier (which sleeps
  after ~15 min) plus a Turso round trip, that is very visible. Fix direction:
  update the UI optimistically from the click and reconcile when the response
  lands, rather than blocking on it. Timestamps come from the server, so a
  rejected call must roll the UI back.
