/**
 * Card actions, defined once and reused by the dedicated pages and by the
 * matching sections of the Overview page - so a task behaves identically
 * wherever it is shown.
 */
import { startTask, pauseTask, resumeTask, reopenTask } from './api.js';
import { toast } from './modal.js';
import { computeLive } from './task-card.js';
import {
  openTaskFormModal,
  openDetailsModal,
  openFinishModal,
  openDeleteModal,
} from './task-forms.js';

/** Runs an API call from a button, locking it and surfacing failures. */
async function run(button, operation, message, ctx) {
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

export const startAction = (ctx) => ({
  label: '▶ Start',
  className: 'primary',
  title: 'Start tracking - moves this task to Progress',
  onClick: (task, button) => run(button, () => startTask(task.id), 'Started - moved to Progress', ctx),
});

export const editAction = (ctx) => ({
  label: 'Edit',
  className: 'ghost',
  onClick: (task) => openTaskFormModal({ task, categories: ctx.categories, onSaved: ctx.reload }),
});

export const deleteAction = (ctx) => ({
  label: 'Delete',
  className: 'danger',
  onClick: (task) => openDeleteModal({ task, onDeleted: ctx.reload }),
});

export const detailsAction = (ctx) => ({
  label: 'Details',
  className: 'ghost',
  title: 'View or edit what was done, how, and any special reason',
  onClick: (task) => openDetailsModal({ task, onSaved: ctx.reload }),
});

export const finishAction = (ctx) => ({
  label: '✓ Finish',
  className: '',
  title: 'End the task and write the finish note',
  onClick: (task) => openFinishModal({ task, onFinished: ctx.reload }),
});

export const reopenAction = (ctx) => ({
  label: '↩ Reopen',
  className: 'ghost',
  title: 'Undo the finish and move this task back to Progress',
  onClick: (task, button) =>
    run(button, () => reopenTask(task.id), 'Reopened - moved back to Progress', ctx),
});

/** Pause or Resume, depending on whether a session is currently open. */
export const toggleAction = (ctx, task) =>
  computeLive(task).isRunning
    ? {
        label: '⏸ Pause',
        className: 'ghost',
        title: 'Stop tracking; the chart freezes',
        onClick: (t, button) => run(button, () => pauseTask(t.id), 'Paused', ctx),
      }
    : {
        label: '▶ Resume',
        className: 'primary',
        title: 'Start tracking again',
        onClick: (t, button) => run(button, () => resumeTask(t.id), 'Resumed', ctx),
      };

/* The three action sets, as used by both the dedicated pages and Overview. */

export const upcomingActions = (ctx) => [startAction(ctx), editAction(ctx), deleteAction(ctx)];

export const progressActions = (ctx, task) => [
  toggleAction(ctx, task),
  detailsAction(ctx),
  finishAction(ctx),
];

export const finishedActions = (ctx) => [detailsAction(ctx), reopenAction(ctx), deleteAction(ctx)];
