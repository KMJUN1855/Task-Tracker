import { all } from './db.js';
import { secondsBetween } from './time.js';

/**
 * Every task row is returned with its derived time fields already computed, so
 * the UI never has to reduce sessions itself. Closed sessions are summed in
 * SQL; the open session (if any) is added in JS against "now", which is what
 * keeps the numbers correct after the app has been closed for a while.
 */
const TASK_SELECT = `
  SELECT
    t.*,
    c.name AS category_name,
    c.hue  AS category_hue,
    c.is_exercise AS category_is_exercise,
    (SELECT COALESCE(SUM((julianday(s.end_time) - julianday(s.start_time)) * 86400), 0)
       FROM sessions s
      WHERE s.task_id = t.id AND s.end_time IS NOT NULL) AS closed_seconds,
    (SELECT s.start_time FROM sessions s
      WHERE s.task_id = t.id AND s.end_time IS NULL LIMIT 1) AS open_session_start,
    (SELECT MIN(s.start_time) FROM sessions s WHERE s.task_id = t.id) AS started_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.task_id = t.id) AS session_count
  FROM tasks t
  LEFT JOIN categories c ON c.id = t.category_id
`;

/** Adds the derived fields the UI colour/label rules are built on. */
export function decorateTask(row) {
  const closed = Math.round(Number(row.closed_seconds) || 0);
  const openStart = row.open_session_start || null;
  const elapsed = closed + (openStart ? secondsBetween(openStart) : 0);

  const isRunning = row.status === 'in_progress' && Boolean(openStart);
  const maxTime = row.max_time ?? null;
  const overMaxBy = maxTime ? Math.max(0, elapsed - maxTime) : 0;

  // Due-date overage is measured at completion for finished tasks, and against
  // "now" for anything still open.
  let overDueBy = 0;
  if (row.due_date) {
    const reference = row.status === 'finished' ? row.finished_at : null;
    overDueBy = secondsBetween(row.due_date, reference); // clamped at 0
  }

  return {
    id: Number(row.id),
    name: row.name,
    category_id: row.category_id === null ? null : Number(row.category_id),
    category: row.category_id
      ? {
          id: Number(row.category_id),
          name: row.category_name,
          hue: Number(row.category_hue),
          is_exercise: Boolean(row.category_is_exercise),
        }
      : null,
    created_at: row.created_at,
    due_date: row.due_date,
    expected_time: row.expected_time === null ? null : Number(row.expected_time),
    max_time: maxTime === null ? null : Number(maxTime),
    status: row.status,
    finish_note: row.finish_note,
    finished_at: row.finished_at,
    started_at: row.started_at,
    session_count: Number(row.session_count),

    // Derived - never stored.
    elapsed_seconds: elapsed,
    is_running: isRunning,
    open_session_start: openStart,
    progress: maxTime ? elapsed / maxTime : null,
    over_max: overMaxBy > 0,
    over_max_by_seconds: overMaxBy,
    over_due: overDueBy > 0,
    over_due_by_seconds: overDueBy,
    // "running" | "paused" | "upcoming" | "finished", paired in the UI with a
    // text label and icon so colour is never the only signal.
    display_state: isRunning ? 'running' : row.status === 'in_progress' ? 'paused' : row.status,
  };
}

/**
 * @param {object} filter
 *   status      - single status or array of statuses
 *   categoryId  - restrict to one category
 *   dueBefore / dueAfter        - ISO bounds on due_date
 *   finishedAfter / finishedBefore - ISO bounds on finished_at
 *   search      - substring of the name
 */
export async function queryTasks(filter = {}) {
  const where = [];
  const args = [];

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`t.status IN (${statuses.map(() => '?').join(', ')})`);
    args.push(...statuses);
  }
  if (filter.categoryId) {
    where.push('t.category_id = ?');
    args.push(filter.categoryId);
  }
  if (filter.dueAfter) {
    where.push('t.due_date >= ?');
    args.push(filter.dueAfter);
  }
  if (filter.dueBefore) {
    where.push('t.due_date <= ?');
    args.push(filter.dueBefore);
  }
  if (filter.finishedAfter) {
    where.push('t.finished_at >= ?');
    args.push(filter.finishedAfter);
  }
  if (filter.finishedBefore) {
    where.push('t.finished_at <= ?');
    args.push(filter.finishedBefore);
  }
  if (filter.search) {
    where.push('LOWER(t.name) LIKE ?');
    args.push(`%${String(filter.search).toLowerCase()}%`);
  }

  const sql = `${TASK_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const rows = await all(sql, args);
  return rows.map(decorateTask);
}

export async function getTask(id) {
  const rows = await all(`${TASK_SELECT} WHERE t.id = ?`, [id]);
  return rows.length ? decorateTask(rows[0]) : null;
}

/* ------------------------------------------------------------------ sorting */

const NULLS_LAST = Number.MAX_SAFE_INTEGER;
const time = (iso) => (iso ? new Date(iso).getTime() : NULLS_LAST);

const SORTERS = {
  due_date: (a, b) => time(a.due_date) - time(b.due_date),
  finished_at: (a, b) => time(a.finished_at) - time(b.finished_at),
  started_at: (a, b) => time(a.started_at) - time(b.started_at),
  created_at: (a, b) => time(a.created_at) - time(b.created_at),
  name: (a, b) => a.name.localeCompare(b.name),
  elapsed: (a, b) => a.elapsed_seconds - b.elapsed_seconds,
  // "Overtime" sorts: largest overage first is the natural reading, so these
  // are descending by default and the order flag flips them like the others.
  overtime_max: (a, b) => b.over_max_by_seconds - a.over_max_by_seconds,
  overtime_due: (a, b) => b.over_due_by_seconds - a.over_due_by_seconds,
};

export const SORT_KEYS = Object.keys(SORTERS);

/**
 * Sorts in place and applies the "overdue items are always pinned to the top,
 * whatever the sort order" rule used by the Upcoming page.
 */
export function sortTasks(tasks, { sort = 'due_date', order = 'asc', pinOverdue = false } = {}) {
  const sorter = SORTERS[sort] || SORTERS.due_date;
  const direction = order === 'desc' ? -1 : 1;
  const sorted = [...tasks].sort((a, b) => sorter(a, b) * direction);
  if (!pinOverdue) return sorted;
  const overdue = sorted.filter((t) => t.over_due || t.over_max);
  const rest = sorted.filter((t) => !(t.over_due || t.over_max));
  return [...overdue, ...rest];
}
