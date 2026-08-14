/**
 * Upcoming: tasks that have not been started.
 * Sorted by due date with a reverse toggle; overdue items get the red treatment
 * and stay pinned to the top whatever the order.
 */
import { listTasks, aiStatus } from '../api.js';
import { renderList } from '../task-card.js';
import { shadeByCategory } from '../color.js';
import { upcomingActions } from '../task-actions.js';
import { openTaskFormModal } from '../task-forms.js';
import { openAiBulkModal } from '../ai-bulk.js';
import { loadSort, sortControls, primaryButton } from './controls.js';

// Asked once per page load; if the server has no key the button never appears.
let aiEnabled = null;

export const title = 'Upcoming';

export async function render(container, ctx) {
  const state = loadSort('upcoming', { sort: 'due_date', order: 'asc' });

  const [tasks] = await Promise.all([
    listTasks({
      status: 'upcoming',
      sort: state.sort,
      order: state.order,
      pin_overdue: '1',
    }),
    // Never let the AI check break the page: if it fails, the feature is off.
    aiEnabled === null
      ? aiStatus()
          .then((status) => {
            aiEnabled = status.configured;
          })
          .catch(() => {
            aiEnabled = false;
          })
      : Promise.resolve(),
  ]);

  const toolbar = sortControls({
    page: 'upcoming',
    state,
    fixedLabel: 'by due date',
    onChange: ctx.reload,
  });
  if (aiEnabled) {
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'button';
    bulk.textContent = '✨ AI bulk add';
    bulk.title = 'Paste notes and turn them into tasks, with a review step';
    bulk.addEventListener('click', () =>
      openAiBulkModal({ categories: ctx.categories, onCreated: ctx.reload }),
    );
    toolbar.append(bulk);
  }

  toolbar.append(primaryButton('+ New task', () =>
    openTaskFormModal({ categories: ctx.categories, onSaved: ctx.reload }),
  ));

  const list = document.createElement('div');
  const colors = shadeByCategory(tasks);

  renderList(
    list,
    tasks,
    (task) => ({ color: colors.get(task.id), actions: upcomingActions(ctx) }),
    'Nothing upcoming. Add a task to get started.',
  );

  container.replaceChildren(toolbar, list);
  return { count: tasks.length };
}
