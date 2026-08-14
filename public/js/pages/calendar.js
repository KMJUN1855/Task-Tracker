/**
 * Calendar: a month grid showing which days had tracked work, and - for the
 * selected day - the pie chart first, then the per-task breakdown, then what
 * was finished that day and how far that landed from its due date.
 *
 * The month's daily stats already contain each day's by_task / by_category
 * split, so selecting a day costs one request (the finished list), not two.
 */
import { statsDaily, statsDay } from '../api.js';
import { formatCompact, formatDateTime } from '../format.js';
import { taskColor, categoryColor } from '../color.js';
import { renderPie, renderBreakdown } from '../pie.js';

export const title = 'Calendar';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODE_KEY = 'tt.calendar.mode'; // task | category
const VIEW_KEY = 'tt.calendar.view'; // 24h  | tracked

/** Filler colour for the part of the day that was never tracked. */
const UNTRACKED_COLOR = 'hsl(220 8% 28%)';

/** Local calendar day of a Date, as YYYY-MM-DD. */
const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

// Module state, so switching tabs and coming back keeps your place.
let viewMonth = null; // Date pinned to the 1st of the displayed month
let selectedDay = null;

const loadMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) === 'category' ? 'category' : 'task';
  } catch {
    return 'task';
  }
};

/** The spec's pie is the whole 00:00-24:00 day, so that is the default. */
const loadView = () => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tracked' ? 'tracked' : '24h';
  } catch {
    return '24h';
  }
};

const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode - the choice just won't persist */
  }
};

/**
 * What the 24-hour pie measures against.
 *
 * For a finished day that is the whole local day: normally 86400, but 23h or
 * 25h across a DST changeover - which Canada has and Korea does not, so it
 * matters for the move rather than being hypothetical.
 *
 * For today it is midnight-to-now, so the untracked share describes the day so
 * far instead of counting hours that have not happened yet. It advances
 * whenever the page re-renders (navigation, refresh, toggling a chip); there is
 * deliberately no per-second redraw of the chart.
 *
 * A day still in the future falls through to the full-day figure.
 */
function pieDenominatorSeconds(dayKeyString) {
  const [year, month, date] = dayKeyString.split('-').map(Number);
  const start = new Date(year, month - 1, date).getTime();
  const next = new Date(year, month - 1, date + 1).getTime();
  const now = Date.now();
  if (now >= start && now < next) return Math.max(1, Math.round((now - start) / 1000));
  return Math.round((next - start) / 1000);
}

/** True when the given local day is the one in progress. */
function isToday(dayKeyString) {
  const [year, month, date] = dayKeyString.split('-').map(Number);
  const start = new Date(year, month - 1, date).getTime();
  const next = new Date(year, month - 1, date + 1).getTime();
  const now = Date.now();
  return now >= start && now < next;
}

/** A row of chips bound to a localStorage key. */
function chipRow(options, current, onPick, label) {
  const row = document.createElement('div');
  row.className = 'chips';
  row.setAttribute('role', 'group');
  if (label) row.setAttribute('aria-label', label);
  for (const option of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${option.value === current ? ' active' : ''}`;
    chip.textContent = option.label;
    if (option.title) chip.title = option.title;
    chip.setAttribute('aria-pressed', String(option.value === current));
    chip.addEventListener('click', () => onPick(option.value));
    row.append(chip);
  }
  return row;
}

export async function render(container, ctx) {
  const today = new Date();
  if (!viewMonth) viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  if (!selectedDay) selectedDay = dayKey(today);

  const monthStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const monthEnd = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);

  const stats = await statsDaily(dayKey(monthStart), dayKey(monthEnd));
  const byDay = new Map(stats.days.map((day) => [day.day, day]));

  // Keep the selection inside the month being viewed.
  if (!byDay.has(selectedDay)) {
    selectedDay = byDay.has(dayKey(today)) ? dayKey(today) : dayKey(monthStart);
  }

  const fragment = document.createDocumentFragment();
  fragment.append(monthHeader(monthStart, stats, ctx));
  fragment.append(monthGrid(monthStart, monthEnd, byDay, today, ctx));

  const detail = document.createElement('div');
  detail.id = 'day-detail';
  fragment.append(detail);

  container.replaceChildren(fragment);
  await renderDayDetail(detail, byDay.get(selectedDay));
  return {};
}

function monthHeader(monthStart, stats, ctx) {
  const bar = document.createElement('div');
  bar.className = 'toolbar month-bar';

  const step = (delta, label, symbol) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ghost';
    button.textContent = symbol;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      viewMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + delta, 1);
      ctx.reload();
    });
    return button;
  };

  const label = document.createElement('span');
  label.className = 'month-label';
  label.textContent = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const total = document.createElement('span');
  total.className = 'toolbar-note';
  total.textContent =
    stats.total_seconds > 0 ? `${formatCompact(stats.total_seconds)} tracked` : 'nothing tracked';

  const todayButton = document.createElement('button');
  todayButton.type = 'button';
  todayButton.className = 'button ghost';
  todayButton.textContent = 'Today';
  todayButton.addEventListener('click', () => {
    const now = new Date();
    viewMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    selectedDay = dayKey(now);
    ctx.reload();
  });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  bar.append(step(-1, 'Previous month', '‹'), label, step(1, 'Next month', '›'), spacer, total, todayButton);
  return bar;
}

function monthGrid(monthStart, monthEnd, byDay, today, ctx) {
  const grid = document.createElement('div');
  grid.className = 'cal-grid';
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Days worked this month');

  for (const name of WEEKDAYS) {
    const head = document.createElement('div');
    head.className = 'cal-head';
    head.textContent = name;
    grid.append(head);
  }

  // Blank cells so the 1st lands under the right weekday.
  for (let i = 0; i < monthStart.getDay(); i += 1) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell empty-cell';
    grid.append(blank);
  }

  const busiest = Math.max(...[...byDay.values()].map((day) => day.total_seconds), 1);
  const todayKey = dayKey(today);

  for (let date = 1; date <= monthEnd.getDate(); date += 1) {
    const key = dayKey(new Date(monthStart.getFullYear(), monthStart.getMonth(), date));
    const day = byDay.get(key);
    const seconds = day?.total_seconds ?? 0;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell';
    if (key === selectedDay) cell.classList.add('selected');
    if (key === todayKey) cell.classList.add('today');
    if (seconds > 0) cell.classList.add('worked');
    cell.setAttribute('aria-pressed', String(key === selectedDay));
    // Text, not just colour: the tooltip and label spell the amount out.
    cell.title = seconds > 0 ? `${key}: ${formatCompact(seconds)} tracked` : `${key}: nothing tracked`;
    cell.setAttribute(
      'aria-label',
      seconds > 0 ? `${key}, ${formatCompact(seconds)} tracked` : `${key}, nothing tracked`,
    );

    const number = document.createElement('span');
    number.className = 'cal-date';
    number.textContent = String(date);
    cell.append(number);

    const meter = document.createElement('span');
    meter.className = 'cal-meter';
    const fill = document.createElement('i');
    fill.style.width = seconds > 0 ? `${Math.max(12, (seconds / busiest) * 100)}%` : '0';
    meter.append(fill);
    cell.append(meter);

    const amount = document.createElement('span');
    amount.className = 'cal-amount';
    amount.textContent = seconds > 0 ? formatCompact(seconds) : '';
    cell.append(amount);

    cell.addEventListener('click', () => {
      selectedDay = key;
      ctx.reload();
    });
    grid.append(cell);
  }

  return grid;
}

async function renderDayDetail(container, day) {
  const heading = document.createElement('h2');
  heading.className = 'section-title';
  const readable = new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const tracked = day?.total_seconds ?? 0;
  heading.textContent = `${readable} · ${tracked > 0 ? `${formatCompact(tracked)} tracked` : 'nothing tracked'}`;
  container.replaceChildren(heading);

  const mode = loadMode();
  const view = loadView();
  const rerender = () => renderDayDetail(container, day);

  // Two independent switches: what the whole pie represents, and how the
  // tracked time inside it is grouped.
  container.append(
    chipRow(
      [
        {
          value: '24h',
          label: '24-hour',
          title: isToday(selectedDay)
            ? 'Midnight to now, including untracked time'
            : 'The whole day, 00:00-24:00, including untracked time',
        },
        { value: 'tracked', label: 'Tracked time', title: 'Only the time actually tracked on this day' },
      ],
      view,
      (value) => {
        remember(VIEW_KEY, value);
        rerender();
      },
      'Pie chart scale',
    ),
  );
  container.append(
    chipRow(
      [
        { value: 'task', label: 'By task' },
        { value: 'category', label: 'By category' },
      ],
      mode,
      (value) => {
        remember(MODE_KEY, value);
        rerender();
      },
      'Pie chart grouping',
    ),
  );

  // Pie first, then the breakdown below it - the order the spec asks for.
  const entries =
    mode === 'category'
      ? (day?.by_category ?? []).map((entry) => ({
          label: entry.name,
          seconds: entry.seconds,
          color: categoryColor(entry.hue),
        }))
      : (day?.by_task ?? []).map((entry, index) => ({
          label: entry.name,
          seconds: entry.seconds,
          color: taskColor(index),
        }));

  const slices = [...entries];
  let denominator = null;
  if (view === '24h') {
    // Tasks may run concurrently, so tracked time can legitimately exceed the
    // window being measured; there is simply no untracked remainder then.
    denominator = pieDenominatorSeconds(selectedDay);
    const untracked = denominator - entries.reduce((sum, entry) => sum + entry.seconds, 0);
    if (untracked > 0) {
      slices.push({
        label: 'Untracked',
        seconds: untracked,
        color: UNTRACKED_COLOR,
        pattern: false, // absence of data, not a category of it
      });
    }
  }

  const live = view === '24h' && isToday(selectedDay);
  container.append(
    renderPie(slices, {
      title:
        view === '24h'
          ? `Time on ${selectedDay}, ${live ? 'midnight to now' : 'whole day'}`
          : `Tracked time on ${selectedDay}`,
    }),
  );

  // Say what the whole circle stands for, so the reading is unambiguous
  // without needing a tooltip - which a phone would not show anyway.
  if (denominator !== null) {
    const caption = document.createElement('div');
    caption.className = 'hint pie-caption';
    // A whole day reads better as "24h" (or 23h/25h across a DST change) than
    // as formatCompact's "1d".
    const wholeHours = denominator / 3600;
    caption.textContent = live
      ? `Whole circle = ${formatCompact(denominator)} elapsed since midnight`
      : `Whole circle = ${
          Number.isInteger(wholeHours) ? `${wholeHours}h` : formatCompact(denominator)
        }, the full day`;
    container.append(caption);
  }

  // The breakdown below stays a per-task chart, so it never lists "Untracked".
  if (entries.length > 0) container.append(renderBreakdown(entries));

  const finishedHeading = document.createElement('h3');
  finishedHeading.className = 'section-title';
  finishedHeading.textContent = 'Finished this day';
  container.append(finishedHeading);

  const list = document.createElement('div');
  list.className = 'day-finished';
  container.append(list);

  try {
    const detail = await statsDay(selectedDay);
    if (detail.finished.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing was finished on this day.';
      list.append(empty);
      return;
    }
    for (const task of detail.finished) list.append(finishedRow(task));
  } catch (error) {
    const failure = document.createElement('div');
    failure.className = 'error-banner';
    failure.textContent = error.message;
    list.append(failure);
  }
}

function finishedRow(task) {
  const row = document.createElement('div');
  row.className = 'card';
  if (task.due_delta_seconds > 0) row.classList.add('is-over');
  else row.classList.add('is-finished');

  const head = document.createElement('div');
  head.className = 'card-head';
  if (task.category) {
    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = categoryColor(task.category.hue);
    dot.setAttribute('aria-hidden', 'true');
    head.append(dot);
  }
  const name = document.createElement('h4');
  name.className = 'card-title';
  name.textContent = task.name;
  head.append(name);
  row.append(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const add = (label, value, className) => {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.append(document.createTextNode(`${label} `));
    const bold = document.createElement('b');
    bold.textContent = value;
    span.append(bold);
    meta.append(span);
  };

  add('Finished', formatDateTime(task.finished_at));
  if (task.due_date) {
    // Spec: how many hours before/after the due date it was finished.
    const delta = task.due_delta_seconds;
    if (delta > 0) add('⚠ After due by', formatCompact(delta), 'over-text');
    else add('Before due by', formatCompact(-delta));
  }
  row.append(meta);

  if (task.finish_note) {
    const note = document.createElement('div');
    note.className = 'note-preview';
    note.textContent = task.finish_note;
    row.append(note);
  }
  return row;
}
