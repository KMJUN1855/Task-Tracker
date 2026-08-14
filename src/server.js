import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dbTarget } from './db.js';
import { migrate } from './migrate.js';
import { errorHandler, notFound } from './http.js';
import categoriesRouter from './routes/categories.js';
import tasksRouter from './routes/tasks.js';
import sessionsRouter from './routes/sessions.js';
import statsRouter from './routes/stats.js';
import exerciseRouter from './routes/exercise.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  // The frontend may be served from this same service or from Cloudflare Pages,
  // so cross-origin calls have to work. ALLOWED_ORIGINS (comma separated) locks
  // it down; unset means any origin, which is fine for a single-user app.
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors(allowed.length ? { origin: allowed } : {}));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, db: dbTarget, time: new Date().toISOString() });
  });

  app.use('/api/categories', categoriesRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/stats', statsRouter);
  app.use('/api/exercise', exerciseRouter);

  app.use('/api', (req, res, next) => next(notFound(`No such endpoint: ${req.method} ${req.originalUrl}`)));

  // Static frontend (built in step 2). Harmless while public/ holds a placeholder.
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.use(errorHandler);
  return app;
}

export async function start() {
  await migrate({ log: (m) => console.log(`[migrate] ${m}`) });
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[server] listening on http://localhost:${port} (db: ${dbTarget})`);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}
