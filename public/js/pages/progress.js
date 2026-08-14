/**
 * Progress: tasks that have been started - running (yellow) or paused (blue),
 * turning red once max_time or the due date is passed. Several tasks may run at
 * the same time.
 */
import { listTasks, pauseTask, resumeTask } from '../api.js';
import { renderList, computeLive } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { toast } from '../modal.js';
import { openDetailsModal, openFinishModal } from '../task-forms.js';

export const title = 'Progress';

export async function render(container, ctx) {
  const tasks = await listTasks({
    status: 'in_progress,paused',
    sort: 'due_date',
    order: 'asc',
    pin_overdue: '1',
  });

  const runningCount = tasks.filter((task) => computeLive(task).isRunning).length;

  const summary = document.createElement('div');
  summary.className = 'toolbar';
  const label = document.createElement('span');
  label.style.fontSize = '0.9rem';
  label.style.color = 'var(--text-dim)';
  label.textContent =
    tasks.length === 0
      ? ''
      : `${runningCount} running · ${tasks.length - runningCount} paused`;
  summary.append(label);

  const list = document.createElement('div');
  const colors = shadeByCategory(tasks);

  renderList(
    list,
    tasks,
    (task) => {
      const live = computeLive(task);
      const toggle = live.isRunning
        ? {
            label: '⏸ Pause',
            className: 'ghost',
            title: 'Stop tracking; the chart freezes',
            onClick: (t, button) => act(button, () => pauseTask(t.id), 'Paused', ctx),
          }
        : {
            label: '▶ Resume',
            className: 'primary',
            title: 'Start tracking again',
            onClick: (t, button) => act(button, () => resumeTask(t.id), 'Resumed', ctx),
          };

      return {
        color: colors.get(task.id),
        actions: [
          toggle,
          {
            label: 'Details',
            className: 'ghost',
            title: 'View or edit what was done, how, and any special reason',
            onClick: (t) => openDetailsModal({ task: t, onSaved: ctx.reload }),
          },
          {
            label: '✓ Finish',
            className: '',
            title: 'End the task and write the finish note',
            onClick: (t) => openFinishModal({ task: t, onFinished: ctx.reload }),
          },
        ],
      };
    },
    'Nothing in progress. Start a task from the Upcoming page.',
  );

  container.replaceChildren(summary, list);
  return { count: tasks.length };
}

async function act(button, operation, message, ctx) {
  button.disabled = true;
  try {
    await operation();
    toast(message);
    await ctx.reload();
  } catch (error) {
    button.disabled = false;
    toast(error.message, true);
  }
}
