/** Small helpers shared by every route module. */

/** An error carrying an HTTP status; thrown by routes, rendered by errorHandler. */
export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);

/** Wraps an async route handler so rejected promises reach the error handler. */
export const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  // A deliberate HttpError - an upstream refusing us, a rate limit - is not a
  // crash, so it gets one line. Anything unexpected keeps its stack.
  if (err instanceof HttpError) {
    if (status >= 500) console.warn(`[${status}] ${req.method} ${req.originalUrl}: ${err.message}`);
  } else if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(err.details ? { details: err.details } : {}),
  });
}

/* ---------------------------------------------------------------- parsing */

export function requireString(body, field, { max = 500 } = {}) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${field}" is required and must be a non-empty string`);
  }
  if (value.length > max) {
    throw badRequest(`"${field}" must be at most ${max} characters`);
  }
  return value.trim();
}

export function optionalString(body, field, { max = 20000 } = {}) {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string or null`);
  if (value.length > max) throw badRequest(`"${field}" must be at most ${max} characters`);
  return value.trim();
}

/** Non-negative integer (durations in seconds, ids, ...). */
export function optionalInt(body, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw badRequest(`"${field}" must be an integer`);
  }
  if (num < min || num > max) {
    throw badRequest(`"${field}" must be between ${min} and ${max}`);
  }
  return num;
}

/** Accepts anything Date can parse; stores UTC ISO. */
export function optionalDate(body, field) {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${field}" must be a valid date`);
  return date.toISOString();
}

export function parseId(raw, label = 'id') {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`Invalid ${label}`);
  return id;
}

/** Validates a timezone name, falling back to UTC. */
export function parseTimeZone(raw) {
  const tz = raw || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw badRequest(`Unknown timezone "${raw}"`);
  }
}
