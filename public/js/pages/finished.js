/**
 * Finished: completed tasks, with the five sort options from the spec, all
 * reversible. Tasks that ran over max_time or past their due date keep the red
 * border and show the overage, exactly as on the Progress page.
 */
import { listTasks, reopenTask } from '../api.js';
import { renderList } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { toast } from '../modal.js';
import { openDetailsModal, openDeleteModal } from '../task-forms.js';
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
    (task) => ({
      color: colors.get(task.id),
      actions: [
        {
          label: 'Details',
          className: 'ghost',
          title: 'View the notes entered at finish time',
          onClick: (t) => openDetailsModal({ task: t, onSaved: ctx.reload }),
        },
        {
          label: '↩ Reopen',
          className: 'ghost',
          title: 'Undo the finish and move this task back to Progress',
          onClick: async (t, button) => {
            button.disabled = true;
            try {
              await reopenTask(t.id);
              toast('Reopened - moved back to Progress');
              await ctx.reload();
            } catch (error) {
              button.disabled = false;
              toast(error.message, true);
            }
          },
        },
        {
          label: 'Delete',
          className: 'danger',
          onClick: (t) => openDeleteModal({ task: t, onDeleted: ctx.reload }),
        },
      ],
    }),
    'Nothing finished yet.',
  );

  container.replaceChildren(toolbar, list);
  return { count: tasks.length };
}
