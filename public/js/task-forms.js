/** The dialogs shared by the Upcoming, Progress and Finished pages. */
import { createTask, updateTask, deleteTask, finishTask, getWorkout } from './api.js';
import { renderSetLog } from './exercise-sets.js';
import {
  formatCompact,
  formatDateTime,
  parseDuration,
  toLocalInputValue,
  fromLocalInputValue,
} from './format.js';
import { openModal, field, input, textarea, select, modalActions, toast } from './modal.js';
import { computeLive } from './task-card.js';

const DURATION_HINT = 'e.g. 90m, 1h30m, 1.5h - a bare number means minutes';

function durationValue(node, label) {
  const raw = node.value.trim();
  if (!raw) return null;
  const seconds = parseDuration(raw);
  if (seconds === null) throw new Error(`Could not read ${label} "${raw}". ${DURATION_HINT}`);
  return seconds;
}

/** New task / edit task. `task` null = create. */
export function openTaskFormModal({ task = null, categories, onSaved }) {
  const isEdit = Boolean(task);
  openModal(isEdit ? 'Edit task' : 'New task', (body, close) => {
    const nameInput = input('text', task?.name ?? '', 'What needs doing?');

    const categoryOptions = [
      { value: '', label: 'No category' },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ];
    const categorySelect = select(categoryOptions, task?.category_id ?? '');

    const dueInput = input('datetime-local', task?.due_date ? toLocalInputValue(task.due_date) : '');
    const expectedInput = input(
      'text',
      task?.expected_time ? formatCompact(task.expected_time) : '',
      '1h30m',
    );
    const maxInput = input('text', task?.max_time ? formatCompact(task.max_time) : '', '2h');

    const row = document.createElement('div');
    row.className = 'field-row';
    row.append(field('Expected time', expectedInput), field('Max time', maxInput));

    body.append(
      field('Name', nameInput),
      field('Category', categorySelect),
      field('Due date', dueInput, 'Shown in your local timezone; stored as UTC'),
      row,
    );
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = DURATION_HINT;
    body.append(hint);

    body.append(
      modalActions(
        isEdit ? 'Save' : 'Create',
        async () => {
          const name = nameInput.value.trim();
          if (!name) throw new Error('Name is required.');

          const payload = {
            name,
            category_id: categorySelect.value ? Number(categorySelect.value) : null,
            due_date: fromLocalInputValue(dueInput.value),
            expected_time: durationValue(expectedInput, 'expected time'),
            max_time: durationValue(maxInput, 'max time'),
          };

          if (isEdit) await updateTask(task.id, payload);
          else await createTask(payload);

          close();
          toast(isEdit ? 'Task updated' : 'Task created');
          await onSaved();
        },
        close,
      ),
    );
  });
}

/**
 * Details: what was done, how, and any special reason. Editable while the task
 * is in progress, and still editable after finishing so a note can be corrected.
 */
export function openDetailsModal({ task, onSaved }) {
  openModal('Details', (body, close) => {
    const live = computeLive(task);

    const summary = document.createElement('div');
    const row = (label, value, isOver = false) => {
      const line = document.createElement('div');
      line.className = 'detail-row';
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('span');
      right.textContent = value;
      if (isOver) right.className = 'over-text';
      line.append(left, right);
      summary.append(line);
    };

    row('Status', task.status.replace('_', ' '));
    if (task.category) row('Category', task.category.name);
    row('Time taken', formatCompact(live.elapsed));
    if (task.expected_time) row('Expected', formatCompact(task.expected_time));
    if (task.max_time) row('Max time', formatCompact(task.max_time));
    if (live.overMaxBy > 0) row('Max time exceeded by', `+${formatCompact(live.overMaxBy)}`, true);
    if (task.due_date) row('Due', formatDateTime(task.due_date));
    if (live.overDueBy > 0) row('Due date exceeded by', `+${formatCompact(live.overDueBy)}`, true);
    if (task.started_at) row('First started', formatDateTime(task.started_at));
    if (task.finished_at) row('Finished', formatDateTime(task.finished_at));
    row('Sessions', String(task.session_count));
    body.append(summary);

    // A workout is an ordinary task, so it lands here like any other - but the
    // interesting part is its sets, not its note. Detected by the category's
    // is_exercise flag rather than the name, so renaming the category is safe.
    if (task.category?.is_exercise) {
      body.append(exerciseSection(task));
    }

    // Notes are read-only until you ask to edit them. Opening Details should
    // never put you in a text field you did not ask for, and closing without
    // pressing Edit must leave the note exactly as it was.
    const original = task.finish_note ?? '';

    const notesLabel = document.createElement('div');
    notesLabel.className = 'field-label';
    notesLabel.textContent = 'Notes';

    const slot = document.createElement('div');
    // Plain container: each mode supplies its own .modal-actions row inside it.
    const buttons = document.createElement('div');
    body.append(notesLabel, slot, buttons);

    const showReadOnly = () => {
      const view = document.createElement('div');
      view.className = 'note-view';
      if (original.trim()) {
        view.textContent = original;
      } else {
        view.classList.add('note-empty');
        view.textContent = 'No notes yet.';
      }
      slot.replaceChildren(view);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button';
      edit.textContent = '✎ Edit notes';
      edit.addEventListener('click', showEditor);

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'button ghost';
      closeButton.textContent = 'Close';
      closeButton.addEventListener('click', close);

      const row = document.createElement('div');
      row.className = 'modal-actions';
      row.append(closeButton, edit);
      buttons.replaceChildren(row);
    };

    const showEditor = () => {
      const noteInput = textarea(original, 'What was done, how, and any special reason.');
      slot.replaceChildren(noteInput);
      // Focusing here is wanted - the user just asked to edit.
      noteInput.focus();
      noteInput.setSelectionRange(noteInput.value.length, noteInput.value.length);

      buttons.replaceChildren(
        modalActions(
          'Save notes',
          async () => {
            await updateTask(task.id, { finish_note: noteInput.value });
            close();
            toast('Notes saved');
            await onSaved();
          },
          // Cancel discards the edit and returns to the read-only view.
          showReadOnly,
        ),
      );
    };

    showReadOnly();
  });
}

/**
 * The set breakdown for a workout, loaded on demand. Returns immediately with a
 * placeholder and fills itself in, so the modal never waits on the request.
 */
function exerciseSection(task) {
  const section = document.createElement('div');
  const heading = document.createElement('h3');
  heading.className = 'section-title';
  heading.textContent = 'Workout';
  const slot = document.createElement('div');
  slot.className = 'hint';
  slot.textContent = 'Loading sets…';
  section.append(heading, slot);

  getWorkout(task.id)
    .then((workout) => {
      const parts = document.createDocumentFragment();

      const row = (label, value) => {
        const line = document.createElement('div');
        line.className = 'detail-row';
        const left = document.createElement('span');
        left.textContent = label;
        const right = document.createElement('span');
        right.textContent = value;
        line.append(left, right);
        parts.append(line);
      };
      row('Sets', String(workout.sets.length));
      row('Time under load', formatCompact(workout.set_seconds ?? 0));

      const names = [...new Set((workout.type_groups ?? []).map((g) => g.type_name ?? 'Untyped'))];
      if (names.length) row('Exercises', names.join(' · '));

      parts.append(renderSetLog(workout, { emptyMessage: 'No sets were recorded.' }));
      slot.replaceWith(parts);
    })
    .catch((error) => {
      slot.classList.add('form-error');
      slot.textContent = `Could not load the sets: ${error.message}`;
    });

  return section;
}

/** Finish: the detail-entry modal that moves a task out of Progress. */
export function openFinishModal({ task, onFinished }) {
  openModal(`Finish "${task.name}"`, (body, close) => {
    const live = computeLive(task);

    const summary = document.createElement('div');
    const line = document.createElement('div');
    line.className = 'detail-row';
    const left = document.createElement('span');
    left.textContent = 'Time taken';
    const right = document.createElement('span');
    right.textContent = formatCompact(live.elapsed);
    line.append(left, right);
    summary.append(line);

    if (live.overMaxBy > 0) {
      const over = document.createElement('div');
      over.className = 'detail-row';
      const l = document.createElement('span');
      l.textContent = 'Max time exceeded by';
      const r = document.createElement('span');
      r.className = 'over-text';
      r.textContent = `+${formatCompact(live.overMaxBy)}`;
      over.append(l, r);
      summary.append(over);
    }
    body.append(summary);

    const noteInput = textarea(
      task.finish_note ?? '',
      'What was done, how, and any special reason.',
    );
    body.append(field('Finish note', noteInput));

    body.append(
      modalActions(
        'Finish task',
        async () => {
          await finishTask(task.id, noteInput.value);
          close();
          toast('Task finished');
          await onFinished();
        },
        close,
      ),
    );
  });
}

/** Delete confirmation - the session history goes with it, so make that plain. */
export function openDeleteModal({ task, onDeleted }) {
  openModal('Delete task', (body, close) => {
    const message = document.createElement('p');
    message.textContent =
      task.session_count > 0
        ? `Delete "${task.name}" and its ${task.session_count} logged session${
            task.session_count === 1 ? '' : 's'
          }? This cannot be undone.`
        : `Delete "${task.name}"? This cannot be undone.`;
    body.append(message);

    body.append(
      modalActions(
        'Delete',
        async () => {
          await deleteTask(task.id);
          close();
          toast('Task deleted');
          await onDeleted();
        },
        close,
      ),
    );
    body.querySelector('.button.primary').classList.add('danger');
  });
}
