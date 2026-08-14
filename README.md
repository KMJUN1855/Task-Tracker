# Task Tracker

Personal time/task tracking, reachable from both a computer and a phone browser.
Steps 1–4 of the implementation order are done: **server + DB schema + API**, the
**Upcoming / Progress / Finished** pages, **Overview + Calendar + pie chart**, and
the **Exercise** stopwatch. Only the Phase B move to a local server is left.

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

83 end-to-end checks against a throwaway database: full lifecycle, session
editing, overtime detection, calendar aggregation, sort reversibility, the
exercise stopwatch flow, and the derived fields the browser depends on.

## Frontend

Plain ES modules in `public/` - no build step, no framework, no CDN, so what is
committed is exactly what runs. Mobile-first; the same layout widens on desktop.

| File | Role |
| --- | --- |
| `js/app.js` | hash router, one-second tick, tab badges |
| `js/task-card.js` | the shared card - live time, state colours, status pill |
| `js/task-actions.js` | the action sets, so a task behaves the same on every page |
| `js/task-forms.js` | new/edit, details, finish and delete dialogs |
| `js/pie.js` | SVG pie chart + breakdown bars, hand-drawn, patterned |
| `js/exercise-sets.js` | the grouped set log, shared by the Exercise page and Details |
| `js/alarm.js` | rest alarm: wake lock, Web Audio, vibration, notifications |
| `js/format.js` | UTC → local rendering, `90m` / `1h30m` duration parsing |
| `js/color.js` | category hue + per-task lightness; golden-angle task hues |
| `js/pages/*.js` | Overview, Upcoming, Progress, Finished, Calendar, Exercise |

**The card recomputes, it never accumulates.** It keeps `closed_seconds` and
`open_session_start` from the API and derives elapsed time on every tick, so a
card left open on screen stays right, and so does one drawn after the phone
slept for an hour. The same maths decides live whether a running task has
crossed `max_time` and should turn red.

**Colour is never the only signal.** Every state colour is paired with an icon
and a word: ▶ Running (yellow), ⏸ Paused (blue), ⚠ Overtime (red, past
max_time), ⚠ Overdue (red, past the due date only), ○ Upcoming, ✓ Finished.
Pie slices additionally carry a repeating fill pattern, echoed in the legend
swatches, and the chart exposes the whole breakdown as text via `aria-label`.
Category identity is separate from state: a dot carries the category's fixed
hue, with lightness varying per task inside that category, and the category name
is spelled out next to it.

**Pages**

* **Upcoming** — due-date order with a reverse toggle; overdue pinned to the top
  regardless; Expected/Max on every card; Start, Edit, Delete; New task form.
* **Progress** — started tasks only, running or paused, with the progress bar at
  `elapsed / max_time`; Pause/Resume, Details, Finish (note modal). Several tasks
  can run at once.
* **Finished** — five sort options, each reversible: finished date, due date,
  start date, overtime by max time, overtime by due date. Overruns keep the red
  border and the overage figure. Details, Reopen, Delete.
* **Overview** — in progress on top, upcoming in the middle (filtered to this
  week / this month / all), finished at the bottom. Each section imports the
  actions of its dedicated page from `task-actions.js`, so Start here moves the
  task into the Progress section above and out of Upcoming, exactly as it does
  there.
* **Calendar** — a month grid where each day shows a meter and the hours
  tracked; picking a day gives the pie chart first, then the per-task
  breakdown bars, then what was finished that day and how far before or after
  its due date that landed.

* **Exercise** — the stopwatch flow, separate from the standard task flow:
  Start Total → Start Set → Stop Set (rest begins) → Start Set → … → Finish
  Total. Total time sits above the current set/rest clock, which is the largest
  thing on the page. The current exercise is shown next to Start Set, with
  **Start new type** to switch — type a name or pick a recent one; the change
  applies to the next set, and the set log groups by exercise. Rest presets are
  1 / 1.5 / 2 / 3 / 5 min plus **No alarm**, which keeps timing and recording the
  rest but counts up silently and never fires. The next set never starts by
  itself — the alarm only says it is time. See the alarm section below for what
  that alarm can and cannot do.

### The calendar pie

Two independent switches:

* **Scale** — *24-hour* (the default) measures against the whole 00:00–24:00
  day, so each task takes only the share it actually used and the remainder
  becomes a flat grey **Untracked** slice. *Tracked time* takes only the time
  logged that day as 100%, with no Untracked slice.
* **Grouping** — *By task* (golden-angle hues) or *By category* (the
  categories' fixed hues).

What the 24-hour circle measures against:

* **A past day** — the real length of that local day, so 23h or 25h across a
  DST changeover rather than a flat 86400. Relevant in Canada, not in Korea.
* **Today** — midnight to now, so the untracked share describes the day so far
  instead of counting hours that have not happened yet. It advances on any
  re-render (navigating, refreshing, toggling a chip); the chart is deliberately
  not redrawn every second.
* **A future day** — the full day again.

A caption under the pie states the figure, so the reading never depends on a
tooltip a phone would not show. Tasks may run concurrently, so tracked time can
exceed the window being measured; there is simply no Untracked slice then. The
breakdown bars below the pie stay a per-task chart and never list Untracked.

The month's daily stats already carry each day's by-task and by-category split,
so selecting a day costs one request, not two. Sessions that run past midnight
are cut at local midnight by the API and counted against both days.

## Deploy — Phase A

**1. Turso database — done.**
`task-tracker` in group `default`, region `aws-ap-northeast-1`, URL
`libsql://task-tracker-kmjun.aws-ap-northeast-1.turso.io`. The schema is applied
and the 10 default categories are seeded. Local `.env` holds the URL and token
and is gitignored. To rotate the token later:

```bash
turso db tokens invalidate task-tracker && turso db tokens create task-tracker
```

**2. GitHub — done.** `KMJUN1855/Task-Tracker` (private).

**3. Render — done.** Live at <https://task-tracker-j0oq.onrender.com>, deploying
automatically on every push to `main`. `render.yaml` sets build (`npm ci`), start
(`npm start`), health check (`/api/health`) and the free plan;
`DATABASE_URL` and `DATABASE_AUTH_TOKEN` are set in the dashboard. The schema is
applied on every boot, so there is no separate migration step — but note that a
migration that throws takes the whole service down with it, since `start()` waits
on it. Test migrations against the real Turso database, not just a local file:
the stored DDL differs, and that difference has already broken one deploy.

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

A workout is an ordinary task in the Exercise category, its session is the Total
time, and each `exercise_sets` row hangs off that session — so a workout still
appears on Overview and in the calendar totals like any other task, and only the
detail view knows about sets. **Rest is not stored**: the rest after a set is the
gap to the next set's start (or to the end of the session), derived on read like
every other duration here.

**Details opens read-only.** Notes are shown as text, and only ✎ Edit notes turns
them into a field — opening Details should never drop you into a text box you did
not ask for. Cancel discards the edit, and closing without editing writes
nothing. Only Save notes issues a request.

A workout spans **every** session of its task, not just the latest. Pausing one
from the Progress page closes its session and resuming opens a new one, so
reading a single session would hide every set recorded before the pause. Its
Total time is the task's tracked time, which is what the other pages show for it
too. Because a workout is an ordinary task, its Details modal on Progress /
Finished / Overview renders the same grouped set log as the Exercise page —
keyed off the category's `is_exercise` flag, not its name, so renaming the
category is safe.

`exercise_sets.type_name` records which exercise a set belongs to. It carries
forward from the previous set unless you start a new type, so a run of sets on
one lift needs naming only once, and `NULL` simply reads as untyped. The API
returns `type_groups` — sets collected into **consecutive runs** of the same
name — so the live log and the Details view render from one shape and cannot
drift. Grouping is by run rather than by name on purpose: alternating
Squat / Bench / Squat gives three groups, which is what actually happened;
merging by name would hide the interleaving.

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
| GET | `/api/exercise/active` | the workout in progress, or `null` |
| GET | `/api/exercise/workouts` | finished workouts, `?limit=` |
| POST | `/api/exercise/workouts` | `{name?}` — Start Total |
| GET | `/api/exercise/types` | type names used recently, for the picker |
| POST | `/api/exercise/workouts/:id/sets/start` | `{type_name?}` — Start Set; omit to carry the previous type forward, `null` for untyped |
| POST | `/api/exercise/workouts/:id/sets/stop` | Stop Set; rest begins implicitly |
| POST | `/api/exercise/workouts/:id/finish` | `{finish_note?}` — Finish Total |
| DELETE | `/api/exercise/workouts/:id` | drop a mis-started workout |

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
| Calendar | `GET /api/stats/daily?from=&to=&tz=` per month, then `GET /api/stats/day/:day?tz=` per selected day |

## The rest alarm, and what a browser can actually do

Worth being exact about, because it shapes the design.

**A web page cannot schedule an alarm the operating system will fire later.**
Verified rather than assumed: the Notification Triggers API (`showTrigger` +
`TimestampTrigger`), the one API that would have allowed it from the client, is
absent (`'showTrigger' in Notification.prototype === false`). A Service Worker
cannot hold a timer across suspension either. The only reliable wake-up is a
server Push — which needs a server that is awake, and the Render free instance
sleeps after ~15 minutes idle.

So the design is:

1. **Screen Wake Lock while a workout is running** — the actual fix. The screen
   stays on, the page stays alive, the alarm fires on time. Re-acquired on every
   return to visibility, since the OS drops it whenever the tab is hidden.
2. **The deadline is an absolute timestamp**, never a countdown integer. If the
   page is suspended and resumed, the remaining time is still right, and an
   alarm that came due while away fires on the first tick back — the caption
   says how late it is (`Rest over by 4m`).
3. **Sound + vibration + notification**, each used only where the platform
   offers it. The page states which channels are live rather than implying it
   works everywhere.

Known limits, in order of how likely you are to hit them:

* If the screen locks or you switch apps and the browser suspends the page, the
  alarm **is late** — it fires when you come back. On iOS this happens almost
  immediately on lock; Android throttles but is more forgiving.
* Audio cannot exist before the user has interacted with the page, so a page
  loaded fresh into an already-overdue rest has no sound until the first tap.
  Any tap anywhere arms it (audio only — the notification prompt stays on the
  workout buttons, where the intent is obvious). The visual state is always
  there regardless.
* Notifications only appear while the page is still running; they cannot wake a
  suspended one.

In practice: keep the phone unlocked on the Exercise page and the wake lock
handles it. For a fully reliable background alarm you want your phone's own
clock app — no browser can promise this.

## Next steps

5. Phase B — local server or Raspberry Pi + Tailscale, verify phone access
