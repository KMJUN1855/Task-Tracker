import { Router } from 'express';
import { all, one, run } from '../db.js';
import {
  wrap,
  parseId,
  requireString,
  optionalInt,
  badRequest,
  notFound,
  conflict,
} from '../http.js';
import { nowIso } from '../time.js';

const router = Router();

const shape = (row) => ({
  id: Number(row.id),
  name: row.name,
  hue: Number(row.hue),
  is_exercise: Boolean(row.is_exercise),
  sort_order: Number(row.sort_order),
  archived_at: row.archived_at,
  task_count: row.task_count === undefined ? undefined : Number(row.task_count),
});

/** GET /api/categories?include_archived=1 */
router.get(
  '/',
  wrap(async (req, res) => {
    const includeArchived = req.query.include_archived === '1';
    const rows = await all(
      `SELECT c.*, (SELECT COUNT(*) FROM tasks t WHERE t.category_id = c.id) AS task_count
         FROM categories c
        ${includeArchived ? '' : 'WHERE c.archived_at IS NULL'}
        ORDER BY c.sort_order, c.id`,
    );
    res.json(rows.map(shape));
  }),
);

/** POST /api/categories  { name, hue?, is_exercise?, sort_order? } */
router.post(
  '/',
  wrap(async (req, res) => {
    const name = requireString(req.body, 'name', { max: 100 });
    let hue = optionalInt(req.body, 'hue', { min: 0, max: 359 });
    const sortOrder = optionalInt(req.body, 'sort_order') ?? 999;
    const isExercise = req.body.is_exercise ? 1 : 0;

    const existing = await one('SELECT id FROM categories WHERE name = ?', [name]);
    if (existing) throw conflict(`A category named "${name}" already exists`);

    if (hue === undefined || hue === null) {
      // Pick the hue furthest from the ones already in use, keeping categories
      // visually separated as the list grows.
      const used = (await all('SELECT hue FROM categories')).map((r) => Number(r.hue));
      hue = furthestHue(used);
    }

    const { lastInsertRowid } = await run(
      'INSERT INTO categories (name, hue, is_exercise, sort_order) VALUES (?, ?, ?, ?)',
      [name, hue, isExercise, sortOrder],
    );
    const row = await one('SELECT * FROM categories WHERE id = ?', [lastInsertRowid]);
    res.status(201).json(shape(row));
  }),
);

/** PATCH /api/categories/:id  { name?, hue?, sort_order?, archived? } */
router.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const current = await one('SELECT * FROM categories WHERE id = ?', [id]);
    if (!current) throw notFound('Category not found');

    const updates = {};
    if (req.body.name !== undefined) updates.name = requireString(req.body, 'name', { max: 100 });
    const hue = optionalInt(req.body, 'hue', { min: 0, max: 359 });
    if (hue !== undefined && hue !== null) updates.hue = hue;
    const sortOrder = optionalInt(req.body, 'sort_order');
    if (sortOrder !== undefined && sortOrder !== null) updates.sort_order = sortOrder;
    if (req.body.is_exercise !== undefined) updates.is_exercise = req.body.is_exercise ? 1 : 0;
    if (req.body.archived !== undefined) updates.archived_at = req.body.archived ? nowIso() : null;

    const fields = Object.keys(updates);
    if (fields.length === 0) throw badRequest('No updatable fields provided');

    await run(
      `UPDATE categories SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...fields.map((f) => updates[f]), id],
    );
    res.json(shape(await one('SELECT * FROM categories WHERE id = ?', [id])));
  }),
);

/**
 * DELETE /api/categories/:id
 * A category still referenced by tasks is archived instead of deleted, so the
 * history of those tasks keeps its colour. ?force=1 deletes it and leaves those
 * tasks uncategorised.
 */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const current = await one('SELECT * FROM categories WHERE id = ?', [id]);
    if (!current) throw notFound('Category not found');

    const [{ count }] = await all('SELECT COUNT(*) AS count FROM tasks WHERE category_id = ?', [id]);
    const inUse = Number(count) > 0;

    if (inUse && req.query.force !== '1') {
      await run('UPDATE categories SET archived_at = ? WHERE id = ?', [nowIso(), id]);
      return res.json({ result: 'archived', task_count: Number(count) });
    }
    await run('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ result: 'deleted', task_count: Number(count) });
  }),
);

/** Hue that maximises the minimum distance to the hues already taken. */
function furthestHue(used) {
  if (used.length === 0) return 0;
  let best = 0;
  let bestDistance = -1;
  for (let hue = 0; hue < 360; hue += 1) {
    const distance = Math.min(...used.map((u) => Math.min(Math.abs(hue - u), 360 - Math.abs(hue - u))));
    if (distance > bestDistance) {
      bestDistance = distance;
      best = hue;
    }
  }
  return best;
}

export default router;
