/**
 * End-to-end smoke test against a throwaway local database.
 * Run with: npm run smoke
 *
 * It walks the full lifecycle - create, start, pause, resume, finish, reopen -
 * plus session editing, overtime detection and the calendar/pie aggregation.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `task-tracker-smoke-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.DATABASE_AUTH_TOKEN = '';
process.env.PORT = '0';

const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');

await migrate();
const server = await new Promise((resolve) => {
  const s = createApp().listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` -> ${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const iso = (offsetSeconds) => new Date(Date.now() + offsetSeconds * 1000).toISOString();

/* --------------------------------------------------------------- health */

const health = await api('GET', '/api/health');
check('health returns ok', health.status === 200 && health.data.ok === true);

/* ----------------------------------------------------------- categories */

const categories = await api('GET', '/api/categories');
check('10 default categories seeded', categories.data.length === 10, `got ${categories.data.length}`);
check(
  'Exercise category is flagged',
  categories.data.some((c) => c.name === 'Exercise' && c.is_exercise === true),
);
check(
  'default hues are evenly spread',
  new Set(categories.data.map((c) => c.hue)).size === 10,
);

const created = await api('POST', '/api/categories', { name: 'Reading' });
check('create category', created.status === 201 && typeof created.data.hue === 'number');
const duplicate = await api('POST', '/api/categories', { name: 'Reading' });
check('duplicate category rejected', duplicate.status === 409);
const renamed = await api('PATCH', `/api/categories/${created.data.id}`, { name: 'Deep reading' });
check('rename category', renamed.data.name === 'Deep reading');
const removed = await api('DELETE', `/api/categories/${created.data.id}`);
check('delete unused category', removed.data.result === 'deleted');

const schoolWork = categories.data.find((c) => c.name === 'School assignments');

/* ---------------------------------------------------------------- tasks */

const bad = await api('POST', '/api/tasks', { name: '' });
check('empty name rejected', bad.status === 400);

const taskRes = await api('POST', '/api/tasks', {
  name: 'PHYS 381 problem set 4',
  category_id: schoolWork.id,
  due_date: iso(3600),
  expected_time: 5400,
  max_time: 7200,
});
const task = taskRes.data;
check('create task', taskRes.status === 201 && task.status === 'upcoming');
check('elapsed starts at zero', task.elapsed_seconds === 0);
check('category is embedded', task.category.name === 'School assignments');

const overdue = await api('POST', '/api/tasks', {
  name: 'Scholarship essay',
  due_date: iso(-7200),
  max_time: 60,
});
check('overdue task flagged', overdue.data.over_due === true && overdue.data.over_due_by_seconds > 7000);

const upcoming = await api('GET', '/api/tasks?status=upcoming&sort=due_date&pin_overdue=1');
check('overdue pinned to top of Upcoming', upcoming.data[0].id === overdue.data.id);

/* ------------------------------------------------------- state machine */

const started = await api('POST', `/api/tasks/${task.id}/start`);
check('start moves task to in_progress', started.data.status === 'in_progress');
check('start opens a session', started.data.is_running === true && started.data.session_count === 1);
check('display_state is running', started.data.display_state === 'running');

const doubleStart = await api('POST', `/api/tasks/${task.id}/start`);
check('double start rejected', doubleStart.status === 409);

const alsoStarted = await api('POST', `/api/tasks/${overdue.data.id}/start`);
check('multiple tasks can run at once', alsoStarted.data.is_running === true);

const paused = await api('POST', `/api/tasks/${task.id}/pause`);
check('pause closes the session', paused.data.status === 'paused' && paused.data.is_running === false);
check('display_state is paused', paused.data.display_state === 'paused');

const resumed = await api('POST', `/api/tasks/${task.id}/resume`);
check('resume opens a second session', resumed.data.session_count === 2 && resumed.data.is_running === true);

/* ------------------------------- elapsed time is recomputed, not stored */

// Backdate the first session by an hour: elapsed must follow immediately,
// because nothing anywhere caches an accumulated total.
const detail = await api('GET', `/api/tasks/${task.id}`);
const firstSession = detail.data.sessions[0];
const edited = await api('PATCH', `/api/sessions/${firstSession.id}`, {
  start_time: iso(-3600),
  end_time: iso(-1800),
});
check('edit a logged session', edited.status === 200 && edited.data.duration_seconds === 1800);

const afterEdit = await api('GET', `/api/tasks/${task.id}`);
check(
  'elapsed recomputed from session timestamps',
  afterEdit.data.elapsed_seconds >= 1795 && afterEdit.data.elapsed_seconds <= 1810,
  `got ${afterEdit.data.elapsed_seconds}`,
);

const manual = await api('POST', '/api/sessions', {
  task_id: task.id,
  start_time: iso(-86400 * 2),
  end_time: iso(-86400 * 2 + 900),
});
check('manual session entry', manual.status === 201 && manual.data.duration_seconds === 900);

const backwards = await api('POST', '/api/sessions', {
  task_id: task.id,
  start_time: iso(0),
  end_time: iso(-60),
});
check('backwards interval rejected', backwards.status === 400);

/* ------------------------------------------------------------- overtime */

const overtimeTask = await api('POST', '/api/tasks', { name: 'Long lab writeup', max_time: 600 });
await api('POST', '/api/sessions', {
  task_id: overtimeTask.data.id,
  start_time: iso(-3600),
  end_time: iso(-1200),
});
const overtime = await api('GET', `/api/tasks/${overtimeTask.data.id}`);
check(
  'max_time overage detected',
  overtime.data.over_max === true && overtime.data.over_max_by_seconds === 1800,
  `got ${overtime.data.over_max_by_seconds}`,
);
check('progress ratio exceeds 1', overtime.data.progress > 1);

/* --------------------------------------------------------------- finish */

const finished = await api('POST', `/api/tasks/${task.id}/finish`, {
  finish_note: 'Solved 1-5; stuck on the rotational-inertia integral, asked in office hours.',
});
check('finish sets status and timestamp', finished.data.status === 'finished' && !!finished.data.finished_at);
check('finish stores the note', finished.data.finish_note.startsWith('Solved 1-5'));
check('finish closes the running session', finished.data.is_running === false);

const finishedList = await api('GET', '/api/tasks?status=finished&sort=finished_at&order=desc');
check('finished list', finishedList.data.length === 1 && finishedList.data[0].id === task.id);

const progressList = await api('GET', '/api/tasks?status=in_progress,paused');
check(
  'finished task left the Progress list',
  progressList.data.every((t) => t.id !== task.id),
);

const reopened = await api('POST', `/api/tasks/${task.id}/reopen`);
check('reopen returns to paused', reopened.data.status === 'paused' && reopened.data.finished_at === null);
await api('POST', `/api/tasks/${task.id}/finish`, { finish_note: 'Done.' });

/* -------------------------------------------------- calendar aggregation */

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const daily = await api('GET', `/api/stats/daily?from=${today}&to=${today}&tz=Asia/Seoul`);
check('daily stats respond', daily.status === 200 && daily.data.days.length === 1);
check('daily stats split by task', daily.data.days[0].by_task.length >= 1);
check('daily stats split by category', daily.data.days[0].by_category.length >= 1);
check(
  'day totals equal the sum of their tasks',
  daily.data.days[0].total_seconds ===
    daily.data.days[0].by_task.reduce((sum, t) => sum + t.seconds, 0),
);

const dayDetail = await api('GET', `/api/stats/day/${today}?tz=Asia/Seoul`);
check('day detail lists finished tasks', dayDetail.data.finished.some((t) => t.id === task.id));
check(
  'day detail reports distance from the due date',
  typeof dayDetail.data.finished.find((t) => t.id === task.id).due_delta_seconds === 'number',
);

const badTz = await api('GET', '/api/stats/daily?tz=Mars/Olympus');
check('unknown timezone rejected', badTz.status === 400);

/* --------------------------------------------------------------- delete */

const deleted = await api('DELETE', `/api/tasks/${overtimeTask.data.id}`);
check('delete task', deleted.data.result === 'deleted');
const gone = await api('GET', `/api/tasks/${overtimeTask.data.id}`);
check('deleted task is gone', gone.status === 404);
const orphanSessions = await api('GET', `/api/sessions?task_id=${overtimeTask.data.id}`);
check('its sessions cascaded away', orphanSessions.data.length === 0);

const missing = await api('GET', '/api/tasks/999999');
check('unknown task 404s', missing.status === 404);

/* ---------------------------------------------------------------- done */

server.close();
rmSync(dbPath, { force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
