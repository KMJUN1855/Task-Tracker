/**
 * Exercise: a stopwatch flow, separate from the standard task flow.
 *
 *   Start Total -> Start Set -> Stop Set (rest begins) -> Start Set -> ...
 *   -> Finish Total
 *
 * The next set never starts by itself; the rest alarm only tells you it is
 * time. Every clock is derived from absolute timestamps the server returned,
 * so nothing drifts if the phone sleeps mid-workout.
 */
import {
  activeWorkout,
  listWorkouts,
  listTypes,
  startWorkout,
  startSet,
  stopSet,
  finishWorkout,
  deleteWorkout,
} from '../api.js';
import { formatClock, formatCompact, formatDateTime } from '../format.js';
import { toast, openModal, field, input, textarea, modalActions } from '../modal.js';
import {
  support,
  notificationPermission,
  unlock,
  fireAlarm,
  requestWakeLock,
  releaseWakeLock,
  wakeLockActive,
} from '../alarm.js';

export const title = 'Exercise';

/** `0` means no alarm: the rest clock still runs, nothing ever fires. */
const NO_ALARM = 0;
const REST_PRESETS = [
  { seconds: 60, label: '1 min' },
  { seconds: 90, label: '1.5 min' },
  { seconds: 120, label: '2 min' },
  { seconds: 180, label: '3 min' },
  { seconds: 300, label: '5 min' },
  { seconds: NO_ALARM, label: 'No alarm', title: 'Keep timing the rest, but never sound an alarm' },
];
const REST_KEY = 'tt.exercise.rest';
const DEFAULT_REST = 90;

// Live view state. `workout` is the last server snapshot; every displayed
// duration is recomputed from its timestamps on each tick.
let workout = null;
let restSeconds = loadRest();
let alarmFiredForSetId = null;
let root = null;
let ctxRef = null;
let recentTypes = [];

/**
 * A type chosen but not yet used, because it only takes effect on the next
 * Start Set. `undefined` = nothing pending, so the previous set's type carries
 * forward. Persisted so a reload between choosing and starting does not lose it.
 */
const PENDING_KEY = 'tt.exercise.pendingType';

function loadPendingType(workoutId) {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return undefined;
    const stored = JSON.parse(raw);
    return stored.workoutId === workoutId ? stored.type : undefined;
  } catch {
    return undefined;
  }
}

function savePendingType(workoutId, type) {
  try {
    if (type === undefined) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify({ workoutId, type }));
  } catch {
    /* private mode - the pending type just won't survive a reload */
  }
}

const UNTYPED_LABEL = 'Untyped';
const typeLabel = (name) => (name === null || name === undefined ? UNTYPED_LABEL : name);

function loadRest() {
  try {
    const raw = localStorage.getItem(REST_KEY);
    // Check for a missing key before converting: Number(null) and Number('')
    // are both 0, which is now a real preset, so a bare Number() would turn
    // "never chosen" into "No alarm".
    if (raw === null || raw === '') return DEFAULT_REST;
    const stored = Number(raw);
    return REST_PRESETS.some((preset) => preset.seconds === stored) ? stored : DEFAULT_REST;
  } catch {
    return DEFAULT_REST;
  }
}

function saveRest(seconds) {
  try {
    localStorage.setItem(REST_KEY, String(seconds));
  } catch {
    /* private mode - the preset just won't persist */
  }
}

/* ------------------------------------------------------------ derivations */

const seconds = (fromIso, toIso = null) =>
  Math.max(0, (new Date(toIso ?? Date.now()).getTime() - new Date(fromIso).getTime()) / 1000);

/** The one set that is currently running, if any. */
const runningSet = () => workout?.sets.find((set) => set.is_running) ?? null;

/** The set we are resting after: the last one, once it has stopped. */
function restingSet() {
  if (!workout?.session?.is_running) return null;
  const sets = workout.sets;
  const last = sets[sets.length - 1];
  return last && !last.is_running ? last : null;
}

function liveState() {
  if (!workout || !workout.session?.is_running) return 'idle';
  if (runningSet()) return 'set';
  return restingSet() ? 'rest' : 'ready';
}

/* ----------------------------------------------------------------- render */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export async function render(container, ctx) {
  ctxRef = ctx;
  const [{ workout: active }, history, types] = await Promise.all([
    activeWorkout(),
    listWorkouts(10),
    listTypes().catch(() => []),
  ]);
  workout = active;
  recentTypes = types;
  if (!workout) alarmFiredForSetId = null;

  root = el('div', 'exercise');
  container.replaceChildren(root);

  if (workout) {
    requestWakeLock();
    renderActive(history);
  } else {
    releaseWakeLock();
    renderIdle(history);
  }
  return {};
}

function renderIdle(history) {
  const start = el('div', 'card start-card');
  start.append(el('h2', 'section-title', 'Start a workout'));

  const nameInput = input('text', '', 'Leg day (optional)');
  start.append(field('Name', nameInput));

  const button = el('button', 'button primary big-button', '▶ Start Total');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    // Must happen inside the tap: this is what arms audio and asks for
    // notification permission.
    await unlock();
    try {
      await startWorkout(nameInput.value.trim() || undefined);
      toast('Workout started');
      await ctxRef.reload();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });
  start.append(button);
  start.append(alarmStatusLine());
  root.append(start);

  root.append(el('h2', 'section-title', 'Recent workouts'));
  root.append(historyList(history));
}

function renderActive(history) {
  const state = liveState();

  const card = el('div', 'card workout-card');
  card.classList.add(`state-${state}`);

  const head = el('div', 'card-head');
  head.append(el('h2', 'card-title', workout.task.name));
  const pill = el('span', 'status-pill running', '▶ In progress');
  head.append(pill);
  card.append(head);

  // Total time, then the current set time larger beneath it - the spec's
  // layout.
  const totalRow = el('div', 'total-row');
  totalRow.append(el('span', 'total-label', 'Total'));
  const total = el('span', 'total-time');
  total.dataset.role = 'total';
  totalRow.append(total);
  card.append(totalRow);

  const big = el('div', 'big-time');
  big.dataset.role = 'big';
  card.append(big);

  const caption = el('div', 'big-caption');
  caption.dataset.role = 'caption';
  card.append(caption);

  const restBar = el('div', 'rest-bar');
  const restFill = el('i');
  restFill.dataset.role = 'rest-fill';
  restBar.append(restFill);
  restBar.dataset.role = 'rest-bar';
  card.append(restBar);

  /* --------------------------------------------------- current exercise */
  // Which type the next set will be filed under, and how to change it.
  const pending = loadPendingType(workout.task.id);
  const effectiveType = pending !== undefined ? pending : workout.current_type;

  const typeRow = el('div', 'type-row');
  const typeName = el('span', 'type-name', typeLabel(effectiveType));
  if (effectiveType === null || effectiveType === undefined) typeRow.classList.add('untyped');
  typeRow.append(el('span', 'type-label', 'Exercise'), typeName);
  if (pending !== undefined && pending !== workout.current_type) {
    typeRow.append(el('span', 'type-pending', 'starts next set'));
  }
  const changeButton = el('button', 'button ghost type-change', 'Start new type');
  changeButton.type = 'button';
  changeButton.addEventListener('click', () => openTypePicker(effectiveType));
  typeRow.append(changeButton);
  card.append(typeRow);

  /* ------------------------------------------------------------- actions */
  const actions = el('div', 'actions');

  if (state === 'set') {
    actions.append(
      actionButton('■ Stop Set', 'primary', async () => {
        await stopSet(workout.task.id);
        toast('Set recorded - rest started');
        await ctxRef.reload();
      }),
    );
  } else {
    actions.append(
      actionButton('▶ Start Set', 'primary', async () => {
        await unlock();
        // Omitting the type lets the server carry the previous one forward.
        const chosen = loadPendingType(workout.task.id);
        await startSet(workout.task.id, chosen);
        savePendingType(workout.task.id, undefined);
        await ctxRef.reload();
      }),
    );
  }

  actions.append(
    actionButton('✓ Finish Total', '', () => {
      openModal('Finish workout', (body, close) => {
        const summary = el('div');
        summary.append(detailRow('Total time', formatCompact(seconds(workout.session.start_time))));
        summary.append(detailRow('Sets', String(workout.sets.length)));
        if (workout.sets.length) {
          summary.append(
            detailRow(
              'Time under load',
              formatCompact(workout.sets.reduce((sum, set) => sum + set.duration_seconds, 0)),
            ),
          );
        }
        body.append(summary);

        const noteInput = textarea('', 'How it went, what you lifted, anything unusual.');
        body.append(field('Notes', noteInput));
        body.append(
          modalActions(
            'Finish workout',
            async () => {
              await finishWorkout(workout.task.id, noteInput.value);
              close();
              toast('Workout finished');
              await releaseWakeLock();
              await ctxRef.reload();
            },
            close,
          ),
        );
      });
    }),
  );
  card.append(actions);

  /* ------------------------------------------------------- rest presets */
  const restLabel = el('div', 'hint', 'Rest alarm');
  card.append(restLabel);

  const presets = el('div', 'chips');
  for (const preset of REST_PRESETS) {
    const chip = el('button', `chip${preset.seconds === restSeconds ? ' active' : ''}`, preset.label);
    chip.type = 'button';
    if (preset.title) chip.title = preset.title;
    chip.setAttribute('aria-pressed', String(preset.seconds === restSeconds));
    chip.addEventListener('click', async () => {
      restSeconds = preset.seconds;
      saveRest(preset.seconds);
      await unlock();
      alarmFiredForSetId = null; // a new target may already be met, or not yet
      ctxRef.reload();
    });
    presets.append(chip);
  }
  card.append(presets);
  // Listing sound/vibration channels would be misleading when nothing will
  // fire, so say that instead.
  card.append(restSeconds === NO_ALARM ? noAlarmLine() : alarmStatusLine());

  root.append(card);

  /* ------------------------------------------------------------ set log */
  root.append(el('h2', 'section-title', `Sets (${workout.sets.length})`));
  root.append(setList(workout));

  /* -------------------------------------------------------- type picker */
  function openTypePicker(current) {
    openModal('Start new type', (body, close) => {
      const nameInput = input('text', '', 'Squat, Bench Press, …');

      const apply = async (value) => {
        const next = value === null ? null : value.trim();
        if (next !== null && next === '') throw new Error('Enter a name, or choose Untyped.');
        savePendingType(workout.task.id, next);
        close();
        toast(
          next === null
            ? 'Next set will be untyped'
            : `Next set: ${next}`,
        );
        await ctxRef.reload();
      };

      if (recentTypes.length) {
        const label = el('div', 'hint', 'Recently used');
        const chips = el('div', 'chips');
        for (const type of recentTypes.slice(0, 12)) {
          const chip = el('button', `chip${type.type_name === current ? ' active' : ''}`, type.type_name);
          chip.type = 'button';
          chip.addEventListener('click', () => {
            apply(type.type_name).catch((error) => toast(error.message, true));
          });
          chips.append(chip);
        }
        body.append(label, chips);
      }

      body.append(field('New type', nameInput));
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          apply(nameInput.value).catch((error) => toast(error.message, true));
        }
      });

      const untyped = el('button', 'button ghost', 'Untyped');
      untyped.type = 'button';
      untyped.title = 'File the next sets under no exercise name';
      untyped.addEventListener('click', () => {
        apply(null).catch((error) => toast(error.message, true));
      });
      body.append(untyped);

      body.append(modalActions('Use this type', () => apply(nameInput.value), close));
    });
  }

  root.append(el('h2', 'section-title', 'Recent workouts'));
  root.append(historyList(history));

  tick(); // paint the clocks immediately rather than after a second
}

function actionButton(label, className, handler) {
  const button = el('button', `button ${className}`.trim(), label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });
  return button;
}

function detailRow(label, value) {
  const row = el('div', 'detail-row');
  row.append(el('span', null, label), el('span', null, value));
  return row;
}

/**
 * The set log, grouped into consecutive runs of the same exercise. Used by both
 * the live workout and the Details view, so the two always match.
 * Sets are numbered within their group, which is how you read a workout.
 */
function setList(data) {
  if (data.sets.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'big', '—'));
    empty.append(document.createTextNode('No sets yet. Press Start Set to begin one.'));
    return empty;
  }

  const wrap = el('div', 'type-groups');
  for (const group of data.type_groups ?? [{ type_name: null, sets: data.sets, set_count: data.sets.length, total_seconds: 0 }]) {
    const block = el('div', 'type-group');

    const header = el('div', 'type-group-head');
    const name = el('span', 'type-group-name', typeLabel(group.type_name));
    if (group.type_name === null) name.classList.add('untyped');
    header.append(name);
    header.append(
      el(
        'span',
        'type-group-meta',
        `${group.set_count} set${group.set_count === 1 ? '' : 's'} · ${formatCompact(group.total_seconds)}`,
      ),
    );
    block.append(header);

    const list = el('div', 'set-list');
    group.sets.forEach((set, indexInGroup) => {
      const row = el('div', 'set-row');
      if (set.is_running) row.classList.add('running');
      row.append(el('span', 'set-index', `#${indexInGroup + 1}`));

      const duration = el('span', 'set-duration');
      if (set.is_running) {
        duration.dataset.role = 'live-set';
        duration.dataset.start = set.start_time;
      } else {
        duration.textContent = formatClock(set.duration_seconds);
      }
      row.append(duration);

      const rest = el('span', 'set-rest');
      if (set.rest_running) {
        rest.dataset.role = 'live-rest';
        rest.dataset.start = set.end_time;
      } else if (set.rest_after_seconds !== null) {
        rest.textContent = `rest ${formatCompact(set.rest_after_seconds)}`;
      } else {
        rest.textContent = 'running';
      }
      row.append(rest);
      list.append(row);
    });
    block.append(list);
    wrap.append(block);
  }
  return wrap;
}

function historyList(history) {
  if (history.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'big', '—'));
    empty.append(document.createTextNode('No finished workouts yet.'));
    return empty;
  }

  const list = el('div', 'card-list');
  for (const item of history) {
    const card = el('div', 'card is-finished');
    const head = el('div', 'card-head');
    head.append(el('h3', 'card-title', item.task.name));
    head.append(el('span', 'status-pill finished', '✓ Finished'));
    card.append(head);

    const meta = el('div', 'meta');
    const add = (label, value) => {
      const span = el('span');
      span.append(document.createTextNode(`${label} `));
      span.append(el('b', null, value));
      meta.append(span);
    };
    // Overview-level summary is the total only; the sets are in Details.
    add('Total', formatCompact(item.total_seconds));
    add('Sets', String(item.sets.length));
    if (item.set_seconds) add('Under load', formatCompact(item.set_seconds));
    if (item.task.finished_at) add('Finished', formatDateTime(item.task.finished_at));
    card.append(meta);

    // Which exercises this workout covered, in order, de-duplicated.
    const names = [...new Set((item.type_groups ?? []).map((g) => typeLabel(g.type_name)))];
    if (names.length) card.append(el('div', 'type-summary', names.join(' · ')));

    if (item.task.finish_note) card.append(el('div', 'note-preview', item.task.finish_note));

    const actions = el('div', 'actions');
    actions.append(
      actionButton('Details', 'ghost', () => {
        openModal(item.task.name, (body, close) => {
          body.append(detailRow('Total time', formatCompact(item.total_seconds)));
          body.append(detailRow('Sets', String(item.sets.length)));
          body.append(detailRow('Time under load', formatCompact(item.set_seconds)));
          if (item.task.finished_at) {
            body.append(detailRow('Finished', formatDateTime(item.task.finished_at)));
          }
          body.append(el('h3', 'section-title', 'Per-set breakdown'));
          body.append(setList(item));
          if (item.task.finish_note) body.append(el('div', 'note-preview', item.task.finish_note));

          const closeRow = el('div', 'modal-actions');
          const done = el('button', 'button primary', 'Close');
          done.type = 'button';
          done.addEventListener('click', close);
          closeRow.append(done);
          body.append(closeRow);
        });
      }),
    );
    actions.append(
      actionButton('Delete', 'danger', async () => {
        await deleteWorkout(item.task.id);
        toast('Workout deleted');
        await ctxRef.reload();
      }),
    );
    card.append(actions);
    list.append(card);
  }
  return list;
}

function noAlarmLine() {
  return el(
    'div',
    'hint alarm-status',
    'Alarm off. Rest is still timed and recorded - nothing will sound, so start the next set whenever you are ready.',
  );
}

/** An honest one-liner about what the alarm can actually do on this device. */
function alarmStatusLine() {
  const line = el('div', 'hint alarm-status');
  const channels = [];
  if (support.audio) channels.push('sound');
  if (support.vibrate) channels.push('vibration');
  if (support.notification && notificationPermission() === 'granted') channels.push('notification');

  const parts = [];
  parts.push(channels.length ? `Alarm: ${channels.join(' + ')}` : 'Alarm: no channel available');
  if (support.wakeLock) {
    parts.push(wakeLockActive() ? 'screen kept awake' : 'screen wake lock available');
  } else {
    parts.push('no screen wake lock on this browser');
  }
  line.textContent = `${parts.join(' · ')}.`;

  const caveat = el('div', 'hint');
  caveat.textContent =
    'If the screen locks or you switch apps, the browser may suspend this page and the alarm can be late - it fires as soon as you come back, showing how late it was.';
  const wrap = el('div');
  wrap.append(line, caveat);
  return wrap;
}

/* ------------------------------------------------------------------- tick */

/** Called once a second by the app shell while this page is mounted. */
export function tick() {
  if (!root?.isConnected || !workout?.session) return;

  const total = root.querySelector('[data-role="total"]');
  if (total) total.textContent = formatClock(seconds(workout.session.start_time));

  const big = root.querySelector('[data-role="big"]');
  const caption = root.querySelector('[data-role="caption"]');
  const restBar = root.querySelector('[data-role="rest-bar"]');
  const restFill = root.querySelector('[data-role="rest-fill"]');
  if (!big) return;

  const current = runningSet();
  const resting = restingSet();

  if (current) {
    big.textContent = formatClock(seconds(current.start_time));
    big.className = 'big-time running';
    caption.textContent = `Set ${current.set_index} in progress`;
    restBar.hidden = true;
  } else if (resting) {
    const rested = seconds(resting.end_time);

    if (restSeconds === NO_ALARM) {
      // No target: the rest is still timed for the record, it simply counts up
      // and nothing ever fires. No bar either - there is nothing to fill.
      big.textContent = formatClock(rested);
      big.className = 'big-time resting';
      caption.textContent = `Resting after set ${resting.set_index} - no alarm, start when ready`;
      restBar.hidden = true;
    } else {
      const remaining = restSeconds - rested;
      const over = remaining <= 0;

      big.textContent = over ? `+${formatClock(-remaining)}` : formatClock(remaining);
      big.className = `big-time ${over ? 'over' : 'resting'}`;
      caption.textContent = over
        ? `Rest over by ${formatCompact(-remaining)} - press Start Set when ready`
        : `Resting after set ${resting.set_index}`;

      restBar.hidden = false;
      restFill.style.width = `${Math.min(100, (rested / restSeconds) * 100)}%`;
      restFill.className = over ? 'over' : '';

      // Fire once per set. If the page was suspended past the deadline, this is
      // reached on the first tick after it resumes - late, but never skipped.
      if (over && alarmFiredForSetId !== resting.id) {
        alarmFiredForSetId = resting.id;
        const lateBy = -remaining;
        fireAlarm({
          title: 'Rest is over',
          body:
            lateBy > 3 ? `Due ${formatCompact(lateBy)} ago - start your next set.` : 'Start your next set.',
        });
      }
    }
  } else {
    big.textContent = '--:--';
    big.className = 'big-time';
    caption.textContent = 'Press Start Set to begin the first set';
    restBar.hidden = true;
  }

  for (const node of root.querySelectorAll('[data-role="live-set"]')) {
    node.textContent = formatClock(seconds(node.dataset.start));
  }
  for (const node of root.querySelectorAll('[data-role="live-rest"]')) {
    node.textContent = `rest ${formatCompact(seconds(node.dataset.start))}`;
  }
}
