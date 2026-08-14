import { Router } from 'express';
import { all } from '../db.js';
import { wrap, badRequest, parseTimeZone } from '../http.js';
import { dayKey, splitByDay, startOfDay, startOfNextDay } from '../time.js';

const router = Router();

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/stats/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=America/Edmonton
 *
 * Feeds the calendar page and the 00:00-24:00 pie chart. Sessions are clipped
 * at local midnight in the requested timezone, so a session that runs past
 * midnight is split across both days. Timestamps stay UTC in the database; the
 * timezone is applied here, at read time - which is what makes a move from
 * Korea to Canada a query parameter rather than a migration.
 */
router.get(
  '/daily',
  wrap(async (req, res) => {
    const timeZone = parseTimeZone(req.query.tz);
    const to = req.query.to || dayKey(new Date(), timeZone);
    const from = req.query.from || to;
    if (!DAY_PATTERN.test(from) || !DAY_PATTERN.test(to)) {
      throw badRequest('"from" and "to" must be YYYY-MM-DD calendar days');
    }
    if (from > to) throw badRequest('"from" must not be after "to"');

    const rangeStart = startOfDay(from, timeZone).toISOString();
    const rangeEnd = startOfNextDay(to, timeZone).toISOString();

    const rows = await all(
      `SELECT s.id, s.task_id, s.start_time, s.end_time,
              t.name AS task_name, t.category_id,
              c.name AS category_name, c.hue AS category_hue
         FROM sessions s
         JOIN tasks t ON t.id = s.task_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE s.start_time < ?
          AND (s.end_time IS NULL OR s.end_time > ?)
        ORDER BY s.start_time`,
      [rangeEnd, rangeStart],
    );

    const days = new Map();
    const dayBucket = (day) => {
      if (!days.has(day)) days.set(day, { day, total_seconds: 0, tasks: new Map(), categories: new Map() });
      return days.get(day);
    };

    const now = new Date().toISOString();
    for (const row of rows) {
      // Clip the session to the requested range before splitting it up. A
      // running session counts up to now, never into the future.
      const start = maxIso(row.start_time, rangeStart);
      const end = minIso(row.end_time ?? now, rangeEnd);
      if (new Date(end) <= new Date(start)) continue;
      for (const slice of splitByDay(start, end, timeZone)) {
        if (slice.day < from || slice.day > to || slice.seconds <= 0) continue;
        const bucket = dayBucket(slice.day);
        bucket.total_seconds += slice.seconds;

        const taskId = Number(row.task_id);
        const task = bucket.tasks.get(taskId) ?? {
          task_id: taskId,
          name: row.task_name,
          category_id: row.category_id === null ? null : Number(row.category_id),
          seconds: 0,
        };
        task.seconds += slice.seconds;
        bucket.tasks.set(taskId, task);

        const categoryId = row.category_id === null ? 0 : Number(row.category_id);
        const category = bucket.categories.get(categoryId) ?? {
          category_id: categoryId || null,
          name: row.category_name ?? 'Uncategorised',
          hue: row.category_hue === null || row.category_hue === undefined ? null : Number(row.category_hue),
          seconds: 0,
        };
        category.seconds += slice.seconds;
        bucket.categories.set(categoryId, category);
      }
    }

    // Emit every day in the range, including empty ones, so the calendar grid
    // does not have to fill gaps itself.
    const result = [];
    for (let day = from; day <= to; day = nextDayKey(day)) {
      const bucket = days.get(day);
      result.push({
        day,
        total_seconds: bucket ? bucket.total_seconds : 0,
        by_task: bucket ? byLargest([...bucket.tasks.values()]) : [],
        by_category: bucket ? byLargest([...bucket.categories.values()]) : [],
      });
    }

    res.json({
      timezone: timeZone,
      from,
      to,
      total_seconds: result.reduce((sum, day) => sum + day.total_seconds, 0),
      days: result,
    });
  }),
);

/**
 * GET /api/stats/day/:day?tz=... - detail for a single date: what was worked on,
 * how long, and how far each finish landed from its due date.
 */
router.get(
  '/day/:day',
  wrap(async (req, res) => {
    const timeZone = parseTimeZone(req.query.tz);
    const day = req.params.day;
    if (!DAY_PATTERN.test(day)) throw badRequest('Day must be YYYY-MM-DD');

    const dayStart = startOfDay(day, timeZone).toISOString();
    const dayEnd = startOfNextDay(day, timeZone).toISOString();

    const finished = await all(
      `SELECT t.id, t.name, t.due_date, t.finished_at, t.max_time, t.expected_time,
              t.finish_note, t.category_id, c.name AS category_name, c.hue AS category_hue
         FROM tasks t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.finished_at >= ? AND t.finished_at < ?
        ORDER BY t.finished_at`,
      [dayStart, dayEnd],
    );

    res.json({
      day,
      timezone: timeZone,
      finished: finished.map((row) => ({
        id: Number(row.id),
        name: row.name,
        category: row.category_id
          ? { id: Number(row.category_id), name: row.category_name, hue: Number(row.category_hue) }
          : null,
        due_date: row.due_date,
        finished_at: row.finished_at,
        max_time: row.max_time === null ? null : Number(row.max_time),
        expected_time: row.expected_time === null ? null : Number(row.expected_time),
        finish_note: row.finish_note,
        // Negative = finished early, positive = finished late.
        due_delta_seconds: row.due_date
          ? Math.round((new Date(row.finished_at) - new Date(row.due_date)) / 1000)
          : null,
      })),
    });
  }),
);

const byLargest = (list) => list.sort((a, b) => b.seconds - a.seconds);
const maxIso = (a, b) => (new Date(a) > new Date(b) ? a : b);
const minIso = (a, b) => (new Date(a) < new Date(b) ? a : b);

function nextDayKey(day) {
  const [year, month, date] = day.split('-').map(Number);
  return dayKey(new Date(Date.UTC(year, month - 1, date + 1)), 'UTC');
}

export default router;
