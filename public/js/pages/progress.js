/**
 * Progress: tasks that have been started - running (yellow) or paused (blue),
 * turning red once max_time or the due date is passed. Several tasks may run at
 * the same time.
 */
import { listTasks } from '../api.js';
import { renderList, computeLive } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { progressActions } from '../task-actions.js';

export const title = 'Progress';

/** Shared with the Overview page's top section. */
export const PROGRESS_QUERY = {
  status: 'in_progress,paused',
  sort: 'due_date',
  order: 'asc',
  pin_overdue: '1',
};

export function renderProgressList(container, tasks, ctx) {
  const colors = shadeByCategory(tasks);
  renderList(
    container,
    tasks,
    (task) => ({ color: colors.get(task.id), actions: progressActions(ctx, task) }),
    'Nothing in progress. Start a task from the Upcoming page.',
  );
}

export function progressSummary(tasks) {
  const running = tasks.filter((task) => computeLive(task).isRunning).length;
  return tasks.length === 0 ? '' : `${running} running · ${tasks.length - running} paused`;
}

export async function render(container, ctx) {
  const tasks = await listTasks(PROGRESS_QUERY);

  const summary = document.createElement('div');
  summary.className = 'toolbar';
  const label = document.createElement('span');
  label.className = 'toolbar-note';
  label.textContent = progressSummary(tasks);
  summary.append(label);

  const list = document.createElement('div');
  renderProgressList(list, tasks, ctx);

  container.replaceChildren(summary, list);
  return { count: tasks.length };
}
