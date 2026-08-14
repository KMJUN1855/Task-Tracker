/**
 * Time helpers.
 *
 * Two rules apply everywhere in this project:
 *  1. Storage is always UTC ISO-8601; local time exists only at display time.
 *  2. Elapsed time is never stored - it is recomputed from absolute timestamps
 *     on every read, so time that passed while the app was closed is correct
 *     for free.
 */

/** Current instant as a UTC ISO string. */
export function nowIso() {
  return new Date().toISOString();
}

/** Normalise any accepted date input to a UTC ISO string, or null. */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Seconds between two ISO timestamps (b defaults to now). */
export function secondsBetween(startIso, endIso = null) {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}

/**
 * Offset of a timezone at a given instant, in milliseconds
 * (local wall-clock minus UTC). Handles DST because it is evaluated per instant.
 */
export function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Local calendar day of an instant, as "YYYY-MM-DD" in the given timezone. */
export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The instant at which the given local calendar day starts, as a Date (UTC). */
export function startOfDay(dayKeyString, timeZone) {
  const [year, month, day] = dayKeyString.split('-').map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Guess with the offset at the naive instant, then correct once - enough for
  // every real timezone, including DST transition days.
  let guess = new Date(naive - tzOffsetMs(new Date(naive), timeZone));
  guess = new Date(naive - tzOffsetMs(guess, timeZone));
  return guess;
}

/** The instant at which the local calendar day after `dayKeyString` starts. */
export function startOfNextDay(dayKeyString, timeZone) {
  const [year, month, day] = dayKeyString.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return startOfDay(dayKey(next, 'UTC'), timeZone);
}

/**
 * Split an interval into per-local-day slices.
 * Returns [{ day: 'YYYY-MM-DD', seconds }] - the basis for the calendar page
 * and the 00:00-24:00 pie chart.
 */
export function splitByDay(startIso, endIso, timeZone) {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : new Date();
  if (end <= start) return [];

  const slices = [];
  let cursor = start;
  // Guard against a pathological range; a personal task will never span years.
  for (let i = 0; i < 10000 && cursor < end; i += 1) {
    const day = dayKey(cursor, timeZone);
    const boundary = startOfNextDay(day, timeZone);
    const sliceEnd = boundary < end ? boundary : end;
    slices.push({ day, seconds: Math.round((sliceEnd - cursor) / 1000) });
    cursor = sliceEnd;
  }
  return slices;
}
