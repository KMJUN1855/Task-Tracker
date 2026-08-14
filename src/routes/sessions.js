import { Router } from 'express';
import { all, one, run } from '../db.js';
import { wrap, parseId, optionalInt, optionalDate, badRequest, notFound, conflict } from '../http.js';
import { nowIso, secondsBetween } from '../time.js';

const router = Router();

const shape = (row) => ({
  id: Number(row.id),
  task_id: Number(row.task_id),
  start_time: row.start_time,
  end_time: row.end_time,
  is_running: row.end_time === null,
  // Recomputed on every read; a running session counts up to "now".
  duration_seconds: secondsBetween(row.start_time, row.end_time),
  ...(row.task_name === undefined ? {} : { task_name: row.task_name }),
});

/**
 * GET /api/sessions
 *   ?task_id=1     - the log of one task
 *   ?from= / ?to=  - every session overlapping the ISO range (calendar queries)
 *   ?running=1     - only sessions that are currently open
 */
router.get(
  '/',
  wrap(async (req, res) => {
    const where = [];
    const args = [];

    if (req.query.task_id) {
      where.push('s.task_id = ?');
      args.push(parseId(req.query.task_id, 'task_id'));
    }
    if (req.query.running === '1') where.push('s.end_time IS NULL');
    if (req.query.from) {
      // Overlap, not containment: an open session (end_time NULL) is still running.
      where.push('(s.end_time IS NULL OR s.end_time >= ?)');
      args.push(isoOrThrow(req.query.from, 'from'));
    }
    if (req.query.to) {
      where.push('s.start_time <= ?');
      args.push(isoOrThrow(req.query.to, 'to'));
    }

    const rows = await all(
      `SELECT s.*, t.name AS task_name
         FROM sessions s JOIN tasks t ON t.id = s.task_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.start_time DESC`,
      args,
    );
    res.json(rows.map(shape));
  }),
);

/**
 * POST /api/sessions  { task_id, start_time?, end_time? }
 * Manual entry - for logging work done away from the app, or fixing a forgotten
 * stop. Omitting end_time opens a running session.
 */
router.post(
  '/',
  wrap(async (req, res) => {
    const taskId = optionalInt(req.body, 'task_id', { min: 1 });
    if (!taskId) throw badRequest('"task_id" is required');
    const task = await one('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) throw badRequest(`Task ${taskId} does not exist`);

    const startTime = optionalDate(req.body, 'start_time') || nowIso();
    const endTime = optionalDate(req.body, 'end_time') ?? null;
    assertOrder(startTime, endTime);

    if (endTime === null) {
      const open = await one('SELECT id FROM sessions WHERE task_id = ? AND end_time IS NULL', [taskId]);
      if (open) throw conflict('Task already has a running session');
    }

    const { lastInsertRowid } = await run(
      'INSERT INTO sessions (task_id, start_time, end_time) VALUES (?, ?, ?)',
      [taskId, startTime, endTime],
    );
    res.status(201).json(shape(await one('SELECT * FROM sessions WHERE id = ?', [lastInsertRowid])));
  }),
);

/** PATCH /api/sessions/:id  { start_time?, end_time? } - correct a logged interval. */
router.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const current = await one('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!current) throw notFound('Session not found');

    const startTime = optionalDate(req.body, 'start_time');
    const endTime = optionalDate(req.body, 'end_time');
    if (startTime === undefined && endTime === undefined) {
      throw badRequest('Provide "start_time" and/or "end_time"');
    }
    if (startTime === null) throw badRequest('"start_time" cannot be null');

    const nextStart = startTime ?? current.start_time;
    const nextEnd = endTime === undefined ? current.end_time : endTime;
    assertOrder(nextStart, nextEnd);

    if (nextEnd === null && current.end_time !== null) {
      const open = await one(
        'SELECT id FROM sessions WHERE task_id = ? AND end_time IS NULL AND id != ?',
        [current.task_id, id],
      );
      if (open) throw conflict('Task already has a running session');
    }

    await run('UPDATE sessions SET start_time = ?, end_time = ? WHERE id = ?', [
      nextStart,
      nextEnd,
      id,
    ]);
    res.json(shape(await one('SELECT * FROM sessions WHERE id = ?', [id])));
  }),
);

/** DELETE /api/sessions/:id - drop a mistaken interval. */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const { rowsAffected } = await run('DELETE FROM sessions WHERE id = ?', [id]);
    if (!rowsAffected) throw notFound('Session not found');
    res.json({ result: 'deleted', id });
  }),
);

function assertOrder(startTime, endTime) {
  if (endTime && new Date(endTime) < new Date(startTime)) {
    throw badRequest('"end_time" must not be before "start_time"');
  }
}

function isoOrThrow(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${field}" must be a valid date`);
  return date.toISOString();
}

export default router;
