/**
 * Formatting. Everything arrives from the API as a UTC ISO string and is
 * converted to the browser's local timezone here, at display time - the only
 * place a timezone is ever applied.
 */

/** "1:04:09" - stopwatch style, used for elapsed time. */
export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** "1h 30m" - compact, used for expected/max time and overages. */
export function formatCompact(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Parses a duration the way you would type it: "90m", "1h30m", "1.5h", "2h",
 * or a bare number meaning minutes. Returns seconds, or null if unparseable.
 */
export function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text) * 60);

  const pattern = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|d|day|days)/g;
  let seconds = 0;
  let matched = false;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matched = true;
    const value = parseFloat(match[1]);
    const unit = match[2][0];
    seconds += value * (unit === 'd' ? 86400 : unit === 'h' ? 3600 : 60);
  }
  return matched ? Math.round(seconds) : null;
}

/** "Aug 15, 14:00" in local time; adds the year when it is not the current one. */
export function formatDateTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 3h" / "2d ago" - relative to now, for due dates. */
export function formatRelative(iso) {
  if (!iso) return '';
  const deltaSeconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const [unit, size] =
    absolute < 3600 ? ['minute', 60] : absolute < 86400 ? ['hour', 3600] : ['day', 86400];
  const value = Math.round(deltaSeconds / size);
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit);
}

/** A datetime-local input value ("2026-08-15T14:00") for a UTC ISO string. */
export function toLocalInputValue(iso) {
  const date = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** datetime-local value (local wall clock) -> UTC ISO string. */
export function fromLocalInputValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
