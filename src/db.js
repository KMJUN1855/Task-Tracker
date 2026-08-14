import './env.js';
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The DB connection string is the ONLY thing that changes between deployment
 * phases:
 *   Phase A (Turso):  DATABASE_URL=libsql://<db>-<org>.turso.io  + DATABASE_AUTH_TOKEN
 *   Phase B (local):  DATABASE_URL=file:./data/app.db            (no token)
 * Application code below is identical in both cases.
 */
const url = process.env.DATABASE_URL || 'file:./data/app.db';
const authToken = process.env.DATABASE_AUTH_TOKEN || undefined;

// A local file: URL needs its directory to exist before libsql opens it.
if (url.startsWith('file:')) {
  const path = resolve(url.slice('file:'.length));
  mkdirSync(dirname(path), { recursive: true });
}

export const db = createClient({ url, authToken });

export const dbTarget = url.startsWith('file:') ? 'local-file' : 'remote-libsql';

/** Run a statement and return its rows as plain objects. */
export async function all(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows.map((row) => ({ ...row }));
}

/** Run a statement and return the first row, or null. */
export async function one(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

/** Run a statement for its side effect; returns { rowsAffected, lastInsertRowid }. */
export async function run(sql, args = []) {
  const result = await db.execute({ sql, args });
  return {
    rowsAffected: result.rowsAffected,
    lastInsertRowid:
      result.lastInsertRowid === undefined || result.lastInsertRowid === null
        ? null
        : Number(result.lastInsertRowid),
  };
}
