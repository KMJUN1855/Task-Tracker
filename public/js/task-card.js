/**
 * The task card, shared by every page.
 *
 * The card never stores an accumulated time. It keeps the absolute timestamps
 * the API returned (closed_seconds + open_session_start) and recomputes elapsed
 * time on every tick, so a card left open on screen stays correct, and so does
 * one rendered after the phone was asleep for an hour.
 */
import { formatClock, formatCompact, formatDateTime, formatRelative } from './format.js';

/** element -> task, for the once-a-second tick. Entries drop out on detach. */
const liveCards = new Map();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Live state, derived purely from timestamps. */
export function computeLive(task) {
  const elapsed =
    (task.closed_seconds ?? 0) +
    (task.open_session_start
      ? Math.max(0, (Date.now() - new Date(task.open_session_start).getTime()) / 1000)
      : 0);

  const overMaxBy = task.max_time ? Math.max(0, elapsed - task.max_time) : 0;

  // For a finished task the due comparison is frozen at its finish time.
  const dueReference =
    task.status === 'finished' && task.finished_at ? new Date(task.finished_at).getTime() : Date.now();
  const overDueBy = task.due_date
    ? Math.max(0, (dueReference - new Date(task.due_date).getTime()) / 1000)
    : 0;

  const isRunning = Boolean(task.open_session_start) && task.status === 'in_progress';
  const over = overMaxBy > 0 || overDueBy > 0;

  let state = 'upcoming';
  if (task.status === 'finished') state = 'finished';
  else if (isRunning) state = 'running';
  else if (task.status === 'in_progress' || task.status === 'paused') state = 'paused';

  return {
    elapsed,
    overMaxBy,
    overDueBy,
    over,
    isRunning,
    state,
    progress: task.max_time ? Math.min(1, elapsed / task.max_time) : null,
  };
}

const STATUS_LABEL = {
  running: ['▶', 'Running'],
  paused: ['⏸', 'Paused'],
  upcoming: ['○', 'Upcoming'],
  finished: ['✓', 'Finished'],
  over: ['⚠', 'Overtime'], // past max_time
  overdue: ['⚠', 'Overdue'], // past the due date, still within max_time
};

/**
 * @param task     decorated task from the API
 * @param options  { color, actions: [{label, className, onClick, title}] }
 */
export function renderTaskCard(task, options = {}) {
  const card = el('article', 'card');
  card.dataset.taskId = String(task.id);

  const head = el('div', 'card-head');
  if (task.category) {
    const dot = el('span', 'cat-dot');
    dot.style.background = options.color ?? `hsl(${task.category.hue} 58% 62%)`;
    dot.title = task.category.name;
    // The dot is decorative; the category name is spelled out in .meta below.
    dot.setAttribute('aria-hidden', 'true');
    head.append(dot);
  }
  head.append(el('h3', 'card-title', task.name));
  const pill = el('span', 'status-pill');
  head.append(pill);
  card.append(head);

  const elapsed = el('div', 'elapsed');
  const progress = el('div', 'progress');
  progress.append(el('i'));
  if (task.status !== 'upcoming') {
    card.append(elapsed);
    if (task.max_time) card.append(progress);
  }

  const meta = el('div', 'meta');
  card.append(meta);

  if (task.finish_note) {
    const note = el('div', 'note-preview', task.finish_note);
    card.append(note);
  }

  if (options.actions?.length) {
    const actions = el('div', 'actions');
    for (const action of options.actions) {
      const button = el('button', `button ${action.className ?? ''}`.trim(), action.label);
      button.type = 'button';
      if (action.title) button.title = action.title;
      button.addEventListener('click', () => action.onClick(task, button));
      actions.append(button);
    }
    card.append(actions);
  }

  liveCards.set(card, { task, nodes: { pill, elapsed, progress, meta } });
  updateCard(card, task, { pill, elapsed, progress, meta });
  return card;
}

function updateCard(card, task, nodes) {
  const live = computeLive(task);

  card.classList.toggle('is-running', live.state === 'running' && !live.over);
  card.classList.toggle('is-paused', live.state === 'paused' && !live.over);
  card.classList.toggle('is-finished', live.state === 'finished' && !live.over);
  card.classList.toggle('is-over', live.over);

  // Status pill: icon + word, so the state never depends on colour alone.
  // "Overtime" means the max time is blown; "Overdue" means only the due date
  // has passed - a task that was never started can be the latter but not the
  // former.
  const key = live.overMaxBy > 0 ? 'over' : live.overDueBy > 0 ? 'overdue' : live.state;
  const [icon, label] = STATUS_LABEL[key];
  nodes.pill.textContent = `${icon} ${label}`;
  nodes.pill.className = `status-pill ${key}`;

  const tone = live.over ? 'over' : live.state;
  nodes.elapsed.textContent = formatClock(live.elapsed);
  nodes.elapsed.className = `elapsed ${tone}`;
  nodes.elapsed.title = 'Time tracked so far';

  if (task.max_time) {
    nodes.progress.className = `progress ${tone}`;
    nodes.progress.firstChild.style.width = `${(live.progress ?? 0) * 100}%`;
  }

  nodes.meta.replaceChildren(...metaParts(task, live));
}

function metaParts(task, live) {
  const parts = [];
  const add = (label, value, className) => {
    const span = el('span', className);
    span.append(document.createTextNode(`${label} `));
    span.append(el('b', null, value));
    parts.push(span);
  };

  if (task.category) add('Category', task.category.name);
  if (task.expected_time) add('Expected', formatCompact(task.expected_time));
  if (task.max_time) add('Max', formatCompact(task.max_time));

  if (task.due_date) {
    const when = `${formatDateTime(task.due_date)}${
      task.status === 'finished' ? '' : ` (${formatRelative(task.due_date)})`
    }`;
    add('Due', when);
  }
  if (task.status === 'finished' && task.finished_at) {
    add('Finished', formatDateTime(task.finished_at));
  }

  // Spec wording: "Max time: +(overage)" / "Due date: +(overage)".
  if (live.overMaxBy > 0) add('⚠ Max time:', `+${formatCompact(live.overMaxBy)}`, 'over-text');
  if (live.overDueBy > 0) add('⚠ Due date:', `+${formatCompact(live.overDueBy)}`, 'over-text');

  return parts;
}

/** Called once a second by the app shell. */
export function tickCards() {
  for (const [card, entry] of liveCards) {
    if (!card.isConnected) {
      liveCards.delete(card);
      continue;
    }
    updateCard(card, entry.task, entry.nodes);
  }
}

/** Renders a list into a container, or an empty-state message. */
export function renderList(container, tasks, buildOptions, emptyMessage) {
  container.replaceChildren();
  if (tasks.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'big', '—'));
    empty.append(document.createTextNode(emptyMessage));
    container.append(empty);
    return;
  }
  const list = el('div', 'card-list');
  for (const task of tasks) list.append(renderTaskCard(task, buildOptions(task)));
  container.append(list);
}
