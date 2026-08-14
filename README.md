# Task Tracker

Personal time/task tracking, reachable from both a computer and a phone browser.
Steps 1 and 2 of the implementation order are done: **server + DB schema + API**,
and the **Upcoming / Progress / Finished** pages.

* **Runtime** — Node.js 20+, Express, `@libsql/client`
* **Database** — SQLite dialect. The same schema and queries run on Turso
  (Phase A) and on a local `.db` file (Phase B).
* **Cost** — zero. Turso free tier, Render free tier, no paid dependency.

## The one thing that changes between phases

`DATABASE_URL`. Nothing else.

| Phase | `DATABASE_URL` | `DATABASE_AUTH_TOKEN` |
| --- | --- | --- |
| A — Turso (cloud) | `libsql://<db>-<org>.turso.io` | required |
| B — local file / Raspberry Pi | `file:./data/app.db` | leave empty |
| B — local server, Turso DB | `libsql://…` | required |

No application code differs between these. `src/db.js` is the only file that
reads the variable.

## Run it locally

```bash
cd task-tracker && npm install && cp .env.example .env && npm start
```

Defaults to `file:./data/app.db`, applies the schema, seeds the 10 default
categories, and serves on <http://localhost:3000>.

```bash
npm run smoke
```

53 end-to-end checks against a throwaway database: full lifecycle, session
editing, overtime detection, calendar aggregation, sort reversibility, and the
derived fields the browser depends on.

## Frontend

Plain ES modules in `public/` - no build step, no framework, no CDN, so what is
committed is exactly what runs. Mobile-first; the same layout widens on desktop.

| File | Role |
| --- | --- |
| `js/app.js` | hash router, one-second tick, tab badges |
| `js/task-card.js` | the shared card - live time, state colours, status pill |
| `js/task-forms.js` | new/edit, details, finish and delete dialogs |
| `js/format.js` | UTC → local rendering, `90m` / `1h30m` duration parsing |
| `js/color.js` | category hue + per-task lightness; golden-angle task hues |
| `js/pages/*.js` | Upcoming, Progress, Finished |

**The card recomputes, it never accumulates.** It keeps `closed_seconds` and
`open_session_start` from the API and derives elapsed time on every tick, so a
card left open on screen stays right, and so does one drawn after the phone
slept for an hour. The same maths decides live whether a running task has
crossed `max_time` and should turn red.

**Colour is never the only signal.** Every state colour is paired with an icon
and a word: ▶ Running (yellow), ⏸ Paused (blue), ⚠ Overtime (red, past
max_time), ⚠ Overdue (red, past the due date only), ○ Upcoming, ✓ Finished.
Category identity is separate from state: a dot carries the category's fixed
hue, with lightness varying per task inside that category, and the category name
is spelled out next to it.

**Pages**

* **Upcoming** — due-date order with a reverse toggle; overdue pinned to the top
  regardless; Expected/Max on every card; Start, Edit, Delete; New task form.
* **Progress** — started tasks only, running or paused, with the progress bar at
  `elapsed / max_time`; Pause/Resume, Details (edit notes), Finish (note modal).
  Several tasks can run at once.
* **Finished** — five sort options, each reversible: finished date, due date,
  start date, overtime by max time, overtime by due date. Overruns keep the red
  border and the overage figure. Details, Reopen, Delete.

## Deploy — Phase A

**1. Turso database — done.**
`task-tracker` in group `default`, region `aws-ap-northeast-1`, URL
`libsql://task-tracker-kmjun.aws-ap-northeast-1.turso.io`. The schema is applied
and the 10 default categories are seeded. Local `.env` holds the URL and token
and is gitignored. To rotate the token later:

```bash
turso db tokens invalidate task-tracker && turso db tokens create task-tracker
```

**2. Push this folder to a GitHub repo** (it is not a git repo yet):

```bash
cd "task-tracker" && git init && git add -A && git commit -m "Task tracker: server, schema, API"
```

**3. Render** — New → Web Service → connect the repo. `render.yaml` already
sets build (`npm ci`), start (`npm start`), health check (`/api/health`) and the
free plan. Add the two environment variables from step 1 in the dashboard:
`DATABASE_URL` and `DATABASE_AUTH_TOKEN`. The schema is applied automatically on
every boot, so there is no separate migration step.

The free instance sleeps after ~15 minutes idle and takes a few seconds to wake.
Because elapsed time is derived from stored timestamps, sleeping costs nothing —
the numbers are still exact on the next request.

## Data model

`categories` → `tasks` → `sessions` → `exercise_sets`. Full DDL with comments in
[src/schema.sql](src/schema.sql).

Two rules are enforced throughout:

* **Elapsed time is never stored.** Only absolute `start_time` / `end_time`
  pairs. Every read recomputes `now − start` for the open session and sums the
  closed ones, so time that passed while the app was closed is automatically
  correct.
* **All timestamps are UTC ISO-8601 strings.** Local time is applied only at
  read time, via the `tz` query parameter on the stats endpoints. Moving from
  Korea to Canada changes a query parameter, not the data.

A partial unique index guarantees at most one *open* session per task, while any
number of *different* tasks may run at the same time.

`exercise_sets` is created now but unused until step 4: a workout is an ordinary
task in the Exercise category, its session is the Total time, and each set hangs
off that session — so the generic elapsed-time rules keep working untouched.

## API

Every task response carries its derived fields, so the UI never reduces sessions
itself:

```jsonc
{
  "id": 1, "name": "PHYS 381 problem set 4", "status": "in_progress",
  "category": { "id": 1, "name": "School assignments", "hue": 0 },
  "due_date": "2026-08-15T03:00:00.000Z",
  "expected_time": 5400, "max_time": 7200,   // seconds
  "elapsed_seconds": 1834,                    // recomputed, never stored
  "is_running": true, "open_session_start": "2026-08-14T02:40:00.000Z",
  "progress": 0.25,                           // elapsed / max_time
  "over_max": false, "over_max_by_seconds": 0,
  "over_due": false, "over_due_by_seconds": 0,
  "display_state": "running"                  // running | paused | upcoming | finished
}
```

`display_state` exists so the UI can print a text label next to the colour —
colour is never the only signal (accessibility requirement).

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | liveness + which DB target is in use |
| GET | `/api/categories` | `?include_archived=1` |
| POST | `/api/categories` | `{name, hue?, is_exercise?}`; hue auto-picked furthest from existing ones |
| PATCH | `/api/categories/:id` | `{name?, hue?, sort_order?, archived?}` |
| DELETE | `/api/categories/:id` | archives if tasks still reference it; `?force=1` to really delete |
| GET | `/api/tasks` | filters + sorting, see below |
| GET | `/api/tasks/:id` | always includes the session log |
| POST | `/api/tasks` | `{name, category_id?, due_date?, expected_time?, max_time?}` |
| PATCH | `/api/tasks/:id` | edit fields (status is not editable here) |
| DELETE | `/api/tasks/:id` | sessions cascade |
| POST | `/api/tasks/:id/start` | → `in_progress`, opens a session |
| POST | `/api/tasks/:id/resume` | same operation from `paused` |
| POST | `/api/tasks/:id/pause` | closes the session, freezes the chart |
| POST | `/api/tasks/:id/finish` | `{finish_note?}` → `finished`, stamps `finished_at` |
| POST | `/api/tasks/:id/reopen` | undo a finish |
| GET | `/api/sessions` | `?task_id=` `?from=` `?to=` `?running=1` |
| POST | `/api/sessions` | manual entry — work done away from the app |
| PATCH | `/api/sessions/:id` | fix a forgotten stop |
| DELETE | `/api/sessions/:id` | drop a mistaken interval |
| GET | `/api/stats/daily` | `?from=YYYY-MM-DD&to=…&tz=…` — calendar + pie data |
| GET | `/api/stats/day/:day` | `?tz=…` — what was finished that day, and how far from due |

**Task list query** — `?status=` (comma separated), `?category_id=`,
`?due_before=` / `?due_after=`, `?finished_after=` / `?finished_before=`,
`?search=`, `?include=sessions`, and:

* `?sort=` `due_date` · `finished_at` · `started_at` · `created_at` · `name` ·
  `elapsed` · `overtime_max` · `overtime_due` — the exact set the Upcoming and
  Finished pages need
* `?order=asc|desc` — every sort is reversible
* `?pin_overdue=1` — overdue items pinned to the top regardless of sort order
  (the Upcoming page rule)

`/api/stats/daily` clips sessions at local midnight in the requested timezone,
so a session running past midnight is split across both days, and returns
`by_task` and `by_category` breakdowns — the two pie-chart modes — plus empty
days so the calendar grid needs no gap filling.

## Page → endpoint map

| Page | Call |
| --- | --- |
| Upcoming | `GET /api/tasks?status=upcoming&sort=due_date&pin_overdue=1` |
| Progress | `GET /api/tasks?status=in_progress,paused` |
| Finished | `GET /api/tasks?status=finished&sort=overtime_max&order=desc` |
| Overview | the three calls above, `?due_before=` for the week/month filter |
| Calendar | `GET /api/stats/daily?from=&to=&tz=` then `GET /api/stats/day/:day?tz=` |

## Next steps

3. Overview + Calendar + pie chart
4. Exercise page (stopwatch; `exercise_sets` table and its endpoints)
5. Phase B — local server or Raspberry Pi + Tailscale, verify phone access
