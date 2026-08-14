import { Router } from 'express';
import { all, one, run } from '../db.js';
import {
  wrap,
  parseId,
  requireString,
  optionalString,
  optionalInt,
  optionalDate,
  badRequest,
  notFound,
  conflict,
} from '../http.js';
import { nowIso } from '../time.js';
import { queryTasks, getTask, sortTasks, SORT_KEYS } from '../tasks-query.js';

const router = Router();

const STATUSES = ['upcoming', 'in_progress', 'paused', 'finished'];

/**
 * GET /api/tasks
 *   ?status=upcoming            (repeatable or comma separated)
 *   ?category_id=3
 *   ?due_before= / ?due_after= / ?finished_after= / ?finished_before=
 *   ?search=text
 *   ?sort=due_date|finished_at|started_at|created_at|name|elapsed|overtime_max|overtime_due
 *   ?order=asc|desc             (every sort is reversible)
 *   ?pin_overdue=1              (Upcoming page: overdue always on top)
 *   ?include=sessions
 */
router.get(
  '/',
  wrap(async (req, res) => {
    const statuses = parseStatuses(req.query.status);
    const sort = req.query.sort || 'due_date';
    if (!SORT_KEYS.includes(sort)) {
      throw badRequest(`Unknown sort "${sort}". Allowed: ${SORT_KEYS.join(', ')}`);
    }

    const tasks = await queryTasks({
      status: statuses,
      categoryId: req.query.category_id ? parseId(req.query.category_id, 'category_id') : undefined,
      dueBefore: req.query.due_before,
      dueAfter: req.query.due_after,
      finishedAfter: req.query.finished_after,
      finishedBefore: req.query.finished_before,
      search: req.query.search,
    });

    const sorted = sortTasks(tasks, {
      sort,
      order: req.query.order === 'desc' ? 'desc' : 'asc',
      pinOverdue: req.query.pin_overdue === '1',
    });

    if (req.query.include === 'sessions') await attachSessions(sorted);
    res.json(sorted);
  }),
);

/** GET /api/tasks/:id - always includes the session log. */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const task = await getTask(parseId(req.params.id));
    if (!task) throw notFound('Task not found');
    await attachSessions([task]);
    res.json(task);
  }),
);

/** POST /api/tasks  { name, category_id?, due_date?, expected_time?, max_time?, status? } */
router.post(
  '/',
  wrap(async (req, res) => {
    const name = requireString(req.body, 'name', { max: 300 });
    const categoryId = optionalInt(req.body, 'category_id', { min: 1 }) ?? null;
    if (categoryId) await assertCategoryExists(categoryId);

    const status = req.body.status ?? 'upcoming';
    if (!STATUSES.includes(status)) throw badRequest(`"status" must be one of ${STATUSES.join(', ')}`);
    if (status === 'finished') throw badRequest('Create the task first, then finish it via POST /api/tasks/:id/finish');

    const dueDate = optionalDate(req.body, 'due_date') ?? null;
    const expected = optionalInt(req.body, 'expected_time', { min: 0 }) ?? null;
    const maxTime = optionalInt(req.body, 'max_time', { min: 0 }) ?? null;

    const createdAt = optionalDate(req.body, 'created_at') || nowIso();

    const { lastInsertRowid } = await run(
      `INSERT INTO tasks (name, category_id, created_at, due_date, expected_time, max_time, status, finish_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        categoryId,
        createdAt,
        dueDate,
        expected,
        maxTime,
        status === 'in_progress' ? 'upcoming' : status,
        optionalString(req.body, 'finish_note') ?? null,
      ],
    );

    // Convenience: creating a task directly as in_progress starts it right away.
    if (status === 'in_progress') await startTask(lastInsertRowid);

    res.status(201).json(await getTask(lastInsertRowid));
  }),
);

/** PATCH /api/tasks/:id - edit fields; status changes go through the actions below. */
router.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const current = await one('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!current) throw notFound('Task not found');

    const updates = {};
    if (req.body.name !== undefined) updates.name = requireString(req.body, 'name', { max: 300 });
    if (req.body.category_id !== undefined) {
      const categoryId = optionalInt(req.body, 'category_id', { min: 1 });
      if (categoryId) await assertCategoryExists(categoryId);
      updates.category_id = categoryId ?? null;
    }
    const dueDate = optionalDate(req.body, 'due_date');
    if (dueDate !== undefined) updates.due_date = dueDate;
    const expected = optionalInt(req.body, 'expected_time', { min: 0 });
    if (expected !== undefined) updates.expected_time = expected;
    const maxTime = optionalInt(req.body, 'max_time', { min: 0 });
    if (maxTime !== undefined) updates.max_time = maxTime;
    const note = optionalString(req.body, 'finish_note');
    if (note !== undefined) updates.finish_note = note;

    if (req.body.status !== undefined) {
      throw badRequest('Use /start, /pause, /resume, /finish or /reopen to change status');
    }
    const fields = Object.keys(updates);
    if (fields.length === 0) throw badRequest('No updatable fields provided');

    await run(`UPDATE tasks SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, [
      ...fields.map((f) => updates[f]),
      id,
    ]);
    res.json(await getTask(id));
  }),
);

/** DELETE /api/tasks/:id - sessions cascade. */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const { rowsAffected } = await run('DELETE FROM tasks WHERE id = ?', [id]);
    if (!rowsAffected) throw notFound('Task not found');
    res.json({ result: 'deleted', id });
  }),
);

/* --------------------------------------------------------- state machine */

/**
 * POST /api/tasks/:id/start - upcoming -> in_progress, opens a session.
 * /resume is the same operation from the paused state; both are accepted for
 * either state so the UI can stay simple. Several tasks may run at once.
 */
router.post(
  ['/:id/start', '/:id/resume'],
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const task = await one('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Task not found');
    if (task.status === 'finished') throw conflict('Task is finished; reopen it first');

    const open = await openSession(id);
    if (open) throw conflict('Task is already running');

    await startTask(id, optionalDate(req.body ?? {}, 'start_time'));
    res.json(await getTask(id));
  }),
);

/** POST /api/tasks/:id/pause - closes the open session, freezes the chart. */
router.post(
  '/:id/pause',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const task = await one('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Task not found');
    if (task.status === 'finished') throw conflict('Task is finished');
    if (task.status === 'upcoming') throw conflict('Task has not been started');

    await closeOpenSession(id, optionalDate(req.body ?? {}, 'end_time'));
    await run('UPDATE tasks SET status = ? WHERE id = ?', ['paused', id]);
    res.json(await getTask(id));
  }),
);

/**
 * POST /api/tasks/:id/finish  { finish_note?, finished_at? }
 * Closes any open session and moves the task to Finished.
 */
router.post(
  '/:id/finish',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const task = await one('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Task not found');
    if (task.status === 'finished') throw conflict('Task is already finished');

    const finishedAt = optionalDate(req.body ?? {}, 'finished_at') || nowIso();
    await closeOpenSession(id, finishedAt);

    const note = optionalString(req.body ?? {}, 'finish_note');
    await run('UPDATE tasks SET status = ?, finished_at = ?, finish_note = ? WHERE id = ?', [
      'finished',
      finishedAt,
      note === undefined ? task.finish_note : note,
      id,
    ]);
    res.json(await getTask(id));
  }),
);

/** POST /api/tasks/:id/reopen - undo a finish; back to paused (or upcoming if never started). */
router.post(
  '/:id/reopen',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const task = await one('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Task not found');
    if (task.status !== 'finished') throw conflict('Task is not finished');

    const [{ count }] = await all('SELECT COUNT(*) AS count FROM sessions WHERE task_id = ?', [id]);
    await run('UPDATE tasks SET status = ?, finished_at = NULL WHERE id = ?', [
      Number(count) > 0 ? 'paused' : 'upcoming',
      id,
    ]);
    res.json(await getTask(id));
  }),
);

/* ----------------------------------------------------------------- helpers */

function parseStatuses(raw) {
  if (!raw) return undefined;
  const list = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => String(value).split(','));
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  for (const status of cleaned) {
    if (!STATUSES.includes(status)) {
      throw badRequest(`Unknown status "${status}". Allowed: ${STATUSES.join(', ')}`);
    }
  }
  return cleaned.length ? cleaned : undefined;
}

async function assertCategoryExists(id) {
  const row = await one('SELECT id FROM categories WHERE id = ?', [id]);
  if (!row) throw badRequest(`Category ${id} does not exist`);
}

const openSession = (taskId) =>
  one('SELECT * FROM sessions WHERE task_id = ? AND end_time IS NULL', [taskId]);

async function startTask(taskId, startTime = null) {
  await run('INSERT INTO sessions (task_id, start_time) VALUES (?, ?)', [
    taskId,
    startTime || nowIso(),
  ]);
  await run('UPDATE tasks SET status = ? WHERE id = ?', ['in_progress', taskId]);
}

async function closeOpenSession(taskId, endTime = null) {
  const open = await openSession(taskId);
  if (!open) return;
  let end = endTime || nowIso();
  // A clock skew or a backdated finish must never produce a negative interval.
  if (new Date(end) < new Date(open.start_time)) end = open.start_time;
  await run('UPDATE sessions SET end_time = ? WHERE id = ?', [end, open.id]);
  // An exercise set hangs off the session, so pausing or finishing a workout
  // from an ordinary task page has to close a set left running - otherwise it
  // stays open forever and counts up against a session that already ended.
  await run(
    'UPDATE exercise_sets SET end_time = ? WHERE session_id = ? AND end_time IS NULL',
    [end, open.id],
  );
}

/** Attaches the raw session log to already-decorated tasks. */
async function attachSessions(tasks) {
  if (tasks.length === 0) return;
  const ids = tasks.map((t) => t.id);
  const rows = await all(
    `SELECT * FROM sessions WHERE task_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY start_time`,
    ids,
  );
  const byTask = new Map(ids.map((id) => [id, []]));
  for (const row of rows) {
    byTask.get(Number(row.task_id)).push({
      id: Number(row.id),
      task_id: Number(row.task_id),
      start_time: row.start_time,
      end_time: row.end_time,
    });
  }
  for (const task of tasks) task.sessions = byTask.get(task.id) ?? [];
}

export default router;
