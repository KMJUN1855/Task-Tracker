/**
 * Upcoming: tasks that have not been started.
 * Sorted by due date with a reverse toggle; overdue items get the red treatment
 * and stay pinned to the top whatever the order.
 */
import { listTasks, startTask } from '../api.js';
import { renderList } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { toast } from '../modal.js';
import { openTaskFormModal, openDeleteModal } from '../task-forms.js';
import { loadSort, sortControls, primaryButton } from './controls.js';

export const title = 'Upcoming';

export async function render(container, ctx) {
  const state = loadSort('upcoming', { sort: 'due_date', order: 'asc' });

  const tasks = await listTasks({
    status: 'upcoming',
    sort: state.sort,
    order: state.order,
    pin_overdue: '1',
  });

  const toolbar = sortControls({
    page: 'upcoming',
    state,
    fixedLabel: 'by due date',
    onChange: ctx.reload,
  });
  toolbar.append(primaryButton('+ New task', () =>
    openTaskFormModal({ categories: ctx.categories, onSaved: ctx.reload }),
  ));

  const list = document.createElement('div');
  const colors = shadeByCategory(tasks);

  renderList(
    list,
    tasks,
    (task) => ({
      color: colors.get(task.id),
      actions: [
        {
          label: '▶ Start',
          className: 'primary',
          title: 'Start tracking - moves this task to Progress',
          onClick: async (t, button) => {
            button.disabled = true;
            try {
              await startTask(t.id);
              toast('Started - moved to Progress');
              await ctx.reload();
            } catch (error) {
              button.disabled = false;
              toast(error.message, true);
            }
          },
        },
        {
          label: 'Edit',
          className: 'ghost',
          onClick: (t) =>
            openTaskFormModal({ task: t, categories: ctx.categories, onSaved: ctx.reload }),
        },
        {
          label: 'Delete',
          className: 'danger',
          onClick: (t) => openDeleteModal({ task: t, onDeleted: ctx.reload }),
        },
      ],
    }),
    'Nothing upcoming. Add a task to get started.',
  );

  container.replaceChildren(toolbar, list);
  return { count: tasks.length };
}
