/**
 * Colour assignment.
 *
 * Category view: every category owns a fixed hue (stored in the DB); tasks
 * inside a category are told apart by lightness only.
 * Task view: hues spread by the golden angle, which keeps up to ~20 concurrent
 * tasks visually distinct - the ceiling the spec designs for. (Used by the pie
 * chart in step 3; kept here so both views share one source of truth.)
 */

const GOLDEN_ANGLE = 137.508;

/** Lightness ladder walked by task order within a category. */
const LIGHTNESS = [62, 76, 48, 84, 40, 68, 55, 72];

export function categoryColor(hue, indexWithinCategory = 0) {
  if (hue === null || hue === undefined) return '#7b8494';
  const lightness = LIGHTNESS[indexWithinCategory % LIGHTNESS.length];
  return `hsl(${hue} 58% ${lightness}%)`;
}

export function taskColor(index) {
  return `hsl(${(index * GOLDEN_ANGLE) % 360} 62% 62%)`;
}

/**
 * Maps task id -> colour, giving each task a distinct lightness inside its own
 * category. Order is taken from the list as rendered, so the assignment is
 * stable for a given view.
 */
export function shadeByCategory(tasks) {
  const seen = new Map();
  const colors = new Map();
  for (const task of tasks) {
    const categoryId = task.category?.id ?? 'none';
    const index = seen.get(categoryId) ?? 0;
    seen.set(categoryId, index + 1);
    colors.set(task.id, categoryColor(task.category?.hue ?? null, index));
  }
  return colors;
}
