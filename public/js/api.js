/**
 * Thin fetch wrapper. Same-origin by default; set window.API_BASE before
 * loading the app to point at a separately hosted API (e.g. the frontend on
 * Cloudflare Pages, the API on Render).
 */
const BASE = window.API_BASE ?? '';

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Render's free tier sleeps after ~15 min idle; the first request after
    // that can take a few seconds or fail outright.
    throw new Error('Cannot reach the server. It may be waking up - try again.');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

export const listTasks = (params) => {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  return api.get(`/api/tasks?${query}`);
};

export const getTask = (id) => api.get(`/api/tasks/${id}`);
export const createTask = (body) => api.post('/api/tasks', body);
export const updateTask = (id, body) => api.patch(`/api/tasks/${id}`, body);
export const deleteTask = (id) => api.del(`/api/tasks/${id}`);
export const startTask = (id) => api.post(`/api/tasks/${id}/start`);
export const pauseTask = (id) => api.post(`/api/tasks/${id}/pause`);
export const resumeTask = (id) => api.post(`/api/tasks/${id}/resume`);
export const finishTask = (id, note) => api.post(`/api/tasks/${id}/finish`, { finish_note: note });
export const reopenTask = (id) => api.post(`/api/tasks/${id}/reopen`);
export const listCategories = () => api.get('/api/categories');

/** The browser's own timezone - applied at read time, never stored. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const statsDaily = (from, to) =>
  api.get(
    `/api/stats/daily?from=${from}&to=${to}&tz=${encodeURIComponent(localTimeZone())}`,
  );

export const statsDay = (day) =>
  api.get(`/api/stats/day/${day}?tz=${encodeURIComponent(localTimeZone())}`);

/* -------------------------------------------------------------- exercise */

export const activeWorkout = () => api.get('/api/exercise/active');
export const listWorkouts = (limit = 20) => api.get(`/api/exercise/workouts?limit=${limit}`);
export const startWorkout = (name) => api.post('/api/exercise/workouts', { name });
/**
 * Omitting typeName lets the server carry the previous set's type forward;
 * passing a string starts a new type, and passing null goes back to untyped.
 */
export const startSet = (id, typeName) =>
  api.post(
    `/api/exercise/workouts/${id}/sets/start`,
    typeName === undefined ? undefined : { type_name: typeName },
  );

export const listTypes = () => api.get('/api/exercise/types');
export const getWorkout = (id) => api.get(`/api/exercise/workouts/${id}`);

/* --------------------------------------------------------------------- ai */

export const aiStatus = () => api.get('/api/ai/status');
export const aiParseTasks = (text) =>
  api.post('/api/ai/parse-tasks', { text, tz: localTimeZone() });
export const stopSet = (id) => api.post(`/api/exercise/workouts/${id}/sets/stop`);
export const finishWorkout = (id, note) =>
  api.post(`/api/exercise/workouts/${id}/finish`, { finish_note: note });
export const deleteWorkout = (id) => api.del(`/api/exercise/workouts/${id}`);
