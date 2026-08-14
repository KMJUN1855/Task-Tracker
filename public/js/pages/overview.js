/**
 * Overview: running/paused on top, upcoming in the middle, finished at the
 * bottom. Every section reuses the card, colours and actions of its dedicated
 * page, so Start here behaves exactly as Start there - the task jumps to the
 * Progress section above and leaves the Upcoming one.
 */
import { listTasks } from '../api.js';
import { renderList } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { upcomingActions, finishedActions } from '../task-actions.js';
import { openTaskFormModal } from '../task-forms.js';
import { PROGRESS_QUERY, renderProgressList, progressSummary } from './progress.js';
import { primaryButton } from './controls.js';

export const title = 'Overview';

/** How many finished tasks to show before pointing at the Finished page. */
const FINISHED_PREVIEW = 8;

const RANGES = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All' },
];

const STORE_KEY = 'tt.overview.range';

function loadRange() {
  try {
    return localStorage.getItem(STORE_KEY) || 'all';
  } catch {
    return 'all';
  }
}

/** End of the current local week (Sunday-start) or month, as a UTC ISO string. */
function rangeEnd(range) {
  if (range === 'all') return undefined;
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (range === 'week') end.setDate(end.getDate() + (6 - end.getDay()));
  else end.setMonth(end.getMonth() + 1, 0);
  return end.toISOString();
}

function sectionTitle(text, action) {
  const row = document.createElement('div');
  row.className = 'section-head';
  const heading = document.createElement('h2');
  heading.className = 'section-title';
  heading.textContent = text;
  row.append(heading);
  if (action) row.append(action);
  return row;
}

export async function render(container, ctx) {
  const range = loadRange();

  const [inProgress, upcoming, finished] = await Promise.all([
    listTasks(PROGRESS_QUERY),
    listTasks({
      status: 'upcoming',
      sort: 'due_date',
      order: 'asc',
      pin_overdue: '1',
      due_before: rangeEnd(range),
    }),
    listTasks({ status: 'finished', sort: 'finished_at', order: 'desc' }),
  ]);

  const fragment = document.createDocumentFragment();

  /* ------------------------------------------------------------ progress */
  const progressNote = document.createElement('span');
  progressNote.className = 'toolbar-note';
  progressNote.textContent = progressSummary(inProgress);
  fragment.append(sectionTitle('In progress', progressNote));

  const progressList = document.createElement('div');
  renderProgressList(progressList, inProgress, ctx);
  fragment.append(progressList);

  /* ------------------------------------------------------------ upcoming */
  fragment.append(
    sectionTitle(
      'Upcoming',
      primaryButton('+ New task', () =>
        openTaskFormModal({ categories: ctx.categories, onSaved: ctx.reload }),
      ),
    ),
  );

  const filters = document.createElement('div');
  filters.className = 'chips';
  for (const option of RANGES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${option.value === range ? ' active' : ''}`;
    chip.textContent = option.label;
    if (option.value === range) chip.setAttribute('aria-pressed', 'true');
    chip.addEventListener('click', () => {
      try {
        localStorage.setItem(STORE_KEY, option.value);
      } catch {
        /* private mode - the filter just won't persist */
      }
      ctx.reload();
    });
    filters.append(chip);
  }
  fragment.append(filters);

  const upcomingList = document.createElement('div');
  const upcomingColors = shadeByCategory(upcoming);
  renderList(
    upcomingList,
    upcoming,
    (task) => ({ color: upcomingColors.get(task.id), actions: upcomingActions(ctx) }),
    range === 'all'
      ? 'Nothing upcoming. Add a task to get started.'
      : `Nothing due ${range === 'week' ? 'this week' : 'this month'}.`,
  );
  fragment.append(upcomingList);

  /* ------------------------------------------------------------ finished */
  const shown = finished.slice(0, FINISHED_PREVIEW);
  let viewAll = null;
  if (finished.length > shown.length) {
    viewAll = document.createElement('a');
    viewAll.className = 'button ghost';
    viewAll.href = '#/finished';
    viewAll.textContent = `View all ${finished.length}`;
  }
  fragment.append(sectionTitle('Finished', viewAll));

  const finishedList = document.createElement('div');
  const finishedColors = shadeByCategory(shown);
  renderList(
    finishedList,
    shown,
    (task) => ({ color: finishedColors.get(task.id), actions: finishedActions(ctx) }),
    'Nothing finished yet.',
  );
  fragment.append(finishedList);

  container.replaceChildren(fragment);
  return { count: inProgress.length };
}
