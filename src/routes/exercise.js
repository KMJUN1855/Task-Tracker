import { Router } from 'express';
import { all, one, run } from '../db.js';
import {
  wrap,
  parseId,
  optionalString,
  optionalInt,
  badRequest,
  notFound,
  conflict,
} from '../http.js';
import { nowIso, secondsBetween } from '../time.js';
import { getTask } from '../tasks-query.js';

/**
 * The Exercise page's stopwatch flow, on top of the ordinary task model:
 *
 *   workout   = a task in the Exercise category
 *   Total time = that task's session
 *   each set   = an exercise_sets row hanging off the session
 *
 * So a workout still shows up on Overview and in the calendar totals with its
 * total time, and only the detail view knows about sets.
 *
 * Rest is never stored. The rest after a set is the gap to the next set's
 * start; for the last set it runs to the end of the session, or to "now" while
 * the workout is still going - which is exactly what the rest timer counts.
 */
const router = Router();

/* ------------------------------------------------------------------ shape */

function shapeSets(rows, sessionEnd) {
  return rows.map((row, index) => {
    const next = rows[index + 1];
    const isRunning = row.end_time === null;

    // Gap from this set's end to whatever came next.
    let restAfter = null;
    if (!isRunning) {
      const restUntil = next ? next.start_time : sessionEnd;
      restAfter = secondsBetween(row.end_time, restUntil ?? null);
    }

    return {
      id: Number(row.id),
      set_index: Number(row.set_index),
      type_name: row.type_name ?? null,
      start_time: row.start_time,
      end_time: row.end_time,
      is_running: isRunning,
      duration_seconds: secondsBetween(row.start_time, row.end_time),
      // Null while the set is still running; live while it is the last set of
      // an unfinished workout.
      rest_after_seconds: restAfter,
      rest_running: !isRunning && !next && !sessionEnd,
    };
  });
}

/**
 * Sets grouped into consecutive runs of the same type - the shape both the live
 * set log and the Details view render, so they cannot drift apart.
 *
 * Grouping is by consecutive run, not by name: alternating Squat / Bench / Squat
 * yields three groups, which is what actually happened. Merging by name would
 * hide the interleaving.
 */
function groupSetsByType(sets) {
  const groups = [];
  for (const set of sets) {
    const last = groups[groups.length - 1];
    if (last && last.type_name === set.type_name) {
      last.sets.push(set);
    } else {
      groups.push({ type_name: set.type_name, sets: [set] });
    }
  }
  return groups.map((group, index) => ({
    index: index + 1,
    type_name: group.type_name,
    set_count: group.sets.length,
    // Time under load for this exercise, and the rest taken within it.
    total_seconds: group.sets.reduce((sum, set) => sum + set.duration_seconds, 0),
    rest_seconds: group.sets.reduce((sum, set) => sum + (set.rest_after_seconds ?? 0), 0),
    sets: group.sets,
  }));
}

async function loadWorkout(taskId) {
  const task = await getTask(taskId);
  if (!task) return null;

  // A workout spans EVERY session of its task, not just the latest one. Pausing
  // a workout from the Progress page closes its session and resuming opens a
  // new one, so reading a single session would hide every set recorded before
  // the pause.
  const sessions = await all('SELECT * FROM sessions WHERE task_id = ? ORDER BY start_time', [
    taskId,
  ]);
  if (sessions.length === 0) {
    return {
      task,
      session: null,
      sets: [],
      type_groups: [],
      current_type: null,
      total_seconds: 0,
      set_seconds: 0,
    };
  }

  const open = sessions.find((session) => session.end_time === null);
  const latest = open ?? sessions[sessions.length - 1];

  const rows = await all(
    `SELECT es.* FROM exercise_sets es
       JOIN sessions s ON s.id = es.session_id
      WHERE s.task_id = ?
      ORDER BY es.start_time`,
    [taskId],
  );
  // Sets run to the end of the workout: the last session's end, or "now" while
  // one is still open.
  const workoutEnd = open ? null : sessions[sessions.length - 1].end_time;
  const sets = shapeSets(rows, workoutEnd);

  return {
    task,
    session: {
      id: Number(latest.id),
      start_time: sessions[0].start_time,
      end_time: latest.end_time,
      is_running: Boolean(open),
    },
    session_count: sessions.length,
    sets,
    type_groups: groupSetsByType(sets),
    // What the next set inherits if the user does not pick a new type.
    current_type: sets.length ? sets[sets.length - 1].type_name : null,
    // Total time is the task's tracked time - the sum of all its sessions,
    // which is what every other page shows for this task too.
    total_seconds: task.elapsed_seconds,
    set_seconds: sets.reduce((sum, set) => sum + set.duration_seconds, 0),
  };
}

const openSession = (taskId) =>
  one('SELECT * FROM sessions WHERE task_id = ? AND end_time IS NULL', [taskId]);

const openSet = (sessionId) =>
  one('SELECT * FROM exercise_sets WHERE session_id = ? AND end_time IS NULL', [sessionId]);

async function exerciseCategoryId() {
  const row = await one(
    'SELECT id FROM categories WHERE is_exercise = 1 AND archived_at IS NULL ORDER BY id LIMIT 1',
  );
  return row ? Number(row.id) : null;
}

/* --------------------------------------------------------------- endpoints */

/** GET /api/exercise/active - the workout in progress, if there is one. */
router.get(
  '/active',
  wrap(async (req, res) => {
    const row = await one(
      `SELECT t.id FROM tasks t
         JOIN sessions s ON s.task_id = t.id AND s.end_time IS NULL
         JOIN categories c ON c.id = t.category_id
        WHERE c.is_exercise = 1 AND t.status != 'finished'
        ORDER BY s.start_time DESC LIMIT 1`,
    );
    res.json({ workout: row ? await loadWorkout(Number(row.id)) : null });
  }),
);

/** GET /api/exercise/workouts - finished workouts, most recent first. */
router.get(
  '/workouts',
  wrap(async (req, res) => {
    const limit = optionalInt(req.query, 'limit', { min: 1, max: 200 }) ?? 20;
    const rows = await all(
      `SELECT t.id FROM tasks t JOIN categories c ON c.id = t.category_id
        WHERE c.is_exercise = 1 AND t.status = 'finished'
        ORDER BY t.finished_at DESC LIMIT ?`,
      [limit],
    );
    res.json(await Promise.all(rows.map((row) => loadWorkout(Number(row.id)))));
  }),
);

/**
 * POST /api/exercise/workouts  { name?, category_id? }
 * "Start Total" - creates the workout task and opens its session.
 */
router.post(
  '/workouts',
  wrap(async (req, res) => {
    const body = req.body ?? {};

    const active = await one(
      `SELECT t.id FROM tasks t
         JOIN sessions s ON s.task_id = t.id AND s.end_time IS NULL
         JOIN categories c ON c.id = t.category_id
        WHERE c.is_exercise = 1 AND t.status != 'finished' LIMIT 1`,
    );
    if (active) throw conflict('A workout is already in progress');

    const categoryId = optionalInt(body, 'category_id', { min: 1 }) ?? (await exerciseCategoryId());
    if (!categoryId) {
      throw badRequest(
        'No Exercise category exists. Create one (is_exercise: true) or pass category_id.',
      );
    }

    const name = optionalString(body, 'name', { max: 300 }) || defaultWorkoutName();
    const startedAt = nowIso();

    const { lastInsertRowid } = await run(
      `INSERT INTO tasks (name, category_id, created_at, status) VALUES (?, ?, ?, 'in_progress')`,
      [name, categoryId, startedAt],
    );
    await run('INSERT INTO sessions (task_id, start_time) VALUES (?, ?)', [
      lastInsertRowid,
      startedAt,
    ]);
    res.status(201).json(await loadWorkout(lastInsertRowid));
  }),
);

/** GET /api/exercise/workouts/:id */
router.get(
  '/workouts/:id',
  wrap(async (req, res) => {
    const workout = await loadWorkout(parseId(req.params.id));
    if (!workout) throw notFound('Workout not found');
    res.json(workout);
  }),
);

/**
 * POST /api/exercise/workouts/:id/sets/start  { type_name? }
 * "Start Set". Omitting type_name carries the previous set's type forward, so
 * a run of sets on the same exercise needs no repeated input; passing one
 * starts a new type from this set on. Pass null to go back to untyped.
 */
router.post(
  '/workouts/:id/sets/start',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const session = await openSession(id);
    if (!session) throw conflict('This workout is not running');
    if (await openSet(session.id)) throw conflict('A set is already running');

    // Look across the whole task, not just this session: a pause/resume from
    // the Progress page starts a new session mid-workout, and the type should
    // still carry forward and the numbering keep climbing.
    const previous = await one(
      `SELECT es.type_name FROM exercise_sets es
         JOIN sessions s ON s.id = es.session_id
        WHERE s.task_id = ?
        ORDER BY es.start_time DESC LIMIT 1`,
      [id],
    );
    const body = req.body ?? {};
    const provided = optionalString(body, 'type_name', { max: 100 });
    const typeName = provided === undefined ? (previous?.type_name ?? null) : provided;

    const [{ highest }] = await all(
      `SELECT COALESCE(MAX(es.set_index), 0) AS highest FROM exercise_sets es
         JOIN sessions s ON s.id = es.session_id
        WHERE s.task_id = ?`,
      [id],
    );
    await run(
      'INSERT INTO exercise_sets (session_id, set_index, start_time, type_name) VALUES (?, ?, ?, ?)',
      [session.id, Number(highest) + 1, nowIso(), typeName],
    );
    res.json(await loadWorkout(id));
  }),
);

/**
 * GET /api/exercise/types - type names used recently, most recent first, to
 * populate the picker so common lifts need typing only once.
 */
router.get(
  '/types',
  wrap(async (req, res) => {
    const limit = optionalInt(req.query, 'limit', { min: 1, max: 100 }) ?? 25;
    const rows = await all(
      `SELECT es.type_name, MAX(es.start_time) AS last_used
         FROM exercise_sets es
        WHERE es.type_name IS NOT NULL AND TRIM(es.type_name) != ''
        GROUP BY es.type_name
        ORDER BY last_used DESC
        LIMIT ?`,
      [limit],
    );
    res.json(rows.map((row) => ({ type_name: row.type_name, last_used: row.last_used })));
  }),
);

/**
 * POST /api/exercise/workouts/:id/sets/stop - "Stop Set".
 * Rest starts implicitly: it is the gap from this end_time onwards, so there is
 * nothing to record. The next set does not start on its own.
 */
router.post(
  '/workouts/:id/sets/stop',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const session = await openSession(id);
    if (!session) throw conflict('This workout is not running');

    const current = await openSet(session.id);
    if (!current) throw conflict('No set is running');

    await run('UPDATE exercise_sets SET end_time = ? WHERE id = ?', [nowIso(), current.id]);
    res.json(await loadWorkout(id));
  }),
);

/** POST /api/exercise/workouts/:id/finish  { finish_note? } - "Finish Total". */
router.post(
  '/workouts/:id/finish',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const task = await one('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Workout not found');
    if (task.status === 'finished') throw conflict('Workout is already finished');

    const finishedAt = nowIso();
    const session = await openSession(id);
    if (session) {
      // A set still running is closed at the same instant, so the totals agree.
      const current = await openSet(session.id);
      if (current) await run('UPDATE exercise_sets SET end_time = ? WHERE id = ?', [finishedAt, current.id]);
      await run('UPDATE sessions SET end_time = ? WHERE id = ?', [finishedAt, session.id]);
    }

    const note = optionalString(req.body ?? {}, 'finish_note');
    await run('UPDATE tasks SET status = ?, finished_at = ?, finish_note = ? WHERE id = ?', [
      'finished',
      finishedAt,
      note === undefined ? task.finish_note : note,
      id,
    ]);
    res.json(await loadWorkout(id));
  }),
);

/** DELETE /api/exercise/workouts/:id - drop a mis-started workout; sets cascade. */
router.delete(
  '/workouts/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const { rowsAffected } = await run('DELETE FROM tasks WHERE id = ?', [id]);
    if (!rowsAffected) throw notFound('Workout not found');
    res.json({ result: 'deleted', id });
  }),
);

function defaultWorkoutName() {
  // Stored in UTC like everything else; the UI renames it if the user wants.
  return `Workout ${new Date().toISOString().slice(0, 10)}`;
}

export default router;
