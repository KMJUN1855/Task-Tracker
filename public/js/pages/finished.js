/**
 * Finished: completed tasks, with the five sort options from the spec, all
 * reversible. Tasks that ran over max_time or past their due date keep the red
 * border and show the overage, exactly as on the Progress page.
 */
import { listTasks } from '../api.js';
import { renderList } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { finishedActions } from '../task-actions.js';
import { loadSort, sortControls } from './controls.js';

export const title = 'Finished';

const SORT_OPTIONS = [
  { value: 'finished_at', label: 'Finished date' },
  { value: 'due_date', label: 'Due date' },
  { value: 'started_at', label: 'Start date' },
  { value: 'overtime_max', label: 'Overtime (max)' },
  { value: 'overtime_due', label: 'Overtime (due)' },
];

export async function render(container, ctx) {
  const state = loadSort('finished', { sort: 'finished_at', order: 'desc' });

  const tasks = await listTasks({
    status: 'finished',
    sort: state.sort,
    order: state.order,
  });

  const toolbar = sortControls({
    page: 'finished',
    options: SORT_OPTIONS,
    state,
    onChange: ctx.reload,
  });

  const list = document.createElement('div');
  const colors = shadeByCategory(tasks);

  renderList(
    list,
    tasks,
    (task) => ({ color: colors.get(task.id), actions: finishedActions(ctx) }),
    'Nothing finished yet.',
  );

  container.replaceChildren(toolbar, list);
  return { count: tasks.length };
}
