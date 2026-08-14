import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, all, run, dbTarget } from './db.js';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * The 10 default categories. Hues evenly divide the HSL hue circle (360 / 10),
 * so every category is visually distinct; tasks inside a category vary only in
 * lightness. The user can add or remove categories later.
 */
const DEFAULT_CATEGORIES = [
  { name: 'School assignments', hue: 0 },
  { name: 'School coursework/study', hue: 36 },
  { name: 'School projects', hue: 72 },
  { name: 'School research', hue: 108 },
  { name: 'Exercise', hue: 144, is_exercise: 1 },
  { name: 'Side projects', hue: 180 },
  { name: 'Scholarships/applications', hue: 216 },
  { name: 'Relocation/admin', hue: 252 },
  { name: 'Lab outreach', hue: 288 },
  { name: 'Personal/other', hue: 324 },
];

/**
 * `exercise_sets.rest_after` was created in step 1 and never written to - rest
 * is derived from the gap between adjacent sets instead. CREATE TABLE IF NOT
 * EXISTS will not remove it from a database that already has the table, so drop
 * it here. Guarded on the table being empty, so it can never discard real data.
 */
async function dropLegacyRestAfter(log) {
  const columns = await all('PRAGMA table_info(exercise_sets)');
  if (!columns.some((column) => column.name === 'rest_after')) return;

  const [{ count }] = await all('SELECT COUNT(*) AS count FROM exercise_sets');
  if (Number(count) > 0) {
    log(`exercise_sets has ${count} rows; leaving the unused rest_after column in place`);
    return;
  }
  await run('ALTER TABLE exercise_sets DROP COLUMN rest_after');
  log('dropped unused exercise_sets.rest_after (rest is derived from timestamps)');
}

export async function migrate({ log = () => {} } = {}) {
  const schema = readFileSync(schemaPath, 'utf8');
  await db.executeMultiple(schema);
  log(`schema applied (${dbTarget})`);
  await dropLegacyRestAfter(log);

  // Seed only into a virgin database, so a category the user deleted on purpose
  // never comes back on the next deploy.
  const [{ count }] = await all('SELECT COUNT(*) AS count FROM categories');
  if (Number(count) === 0) {
    for (const [i, category] of DEFAULT_CATEGORIES.entries()) {
      await run(
        `INSERT INTO categories (name, hue, is_exercise, sort_order)
         VALUES (?, ?, ?, ?)`,
        [category.name, category.hue, category.is_exercise ?? 0, i],
      );
    }
    log(`seeded ${DEFAULT_CATEGORIES.length} default categories`);
  } else {
    log(`categories already present (${count}), skipping seed`);
  }
}

// Allow `npm run migrate` as a standalone command.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate({ log: (m) => console.log(`[migrate] ${m}`) });
  console.log('[migrate] done');
  process.exit(0);
}
