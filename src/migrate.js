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
 * EXISTS will not remove it from a database that already has the table, so it
 * has to be removed here.
 *
 * NOT with ALTER TABLE ... DROP COLUMN. That rewrites the stored CREATE TABLE
 * text by excising the column's tokens, and rest_after was the last column with
 * a trailing `--` comment after it, which leaves `end_time TEXT,` followed by a
 * comment and then `)` - a dangling comma, reported as "incomplete input".
 * (Nothing to do with Turso: it is the stored DDL text that decides this, and
 * plain SQLite fails identically on the same text.)
 *
 * Rebuilding the table is immune to how the original was written, and keeps
 * existing rows. The replacement DDL deliberately carries no inline comments,
 * so a future column drop cannot hit the same trap.
 */
async function dropLegacyRestAfter(log) {
  const columns = await all('PRAGMA table_info(exercise_sets)');
  if (!columns.some((column) => column.name === 'rest_after')) return;

  // The column should be entirely NULL - nothing ever wrote it. If that is
  // somehow untrue, keep the column rather than discard the values.
  const [{ populated }] = await all(
    'SELECT COUNT(*) AS populated FROM exercise_sets WHERE rest_after IS NOT NULL',
  );
  if (Number(populated) > 0) {
    log(`exercise_sets.rest_after holds ${populated} non-null value(s); leaving the column alone`);
    return;
  }

  const [{ total }] = await all('SELECT COUNT(*) AS total FROM exercise_sets');
  await db.batch(
    [
      `CREATE TABLE exercise_sets_new (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         set_index  INTEGER NOT NULL,
         start_time TEXT    NOT NULL,
         end_time   TEXT
       )`,
      `INSERT INTO exercise_sets_new (id, session_id, set_index, start_time, end_time)
         SELECT id, session_id, set_index, start_time, end_time FROM exercise_sets`,
      'DROP TABLE exercise_sets',
      'ALTER TABLE exercise_sets_new RENAME TO exercise_sets',
      // The index went with the old table; schema.sql already ran, so recreate it.
      'CREATE INDEX IF NOT EXISTS idx_exercise_sets_session ON exercise_sets(session_id)',
    ],
    'write',
  );
  log(`rebuilt exercise_sets without rest_after, ${total} row(s) preserved`);
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
