/**
 * AI bulk add: paste notes, review what the model made of them, then create.
 *
 * Nothing reaches the database until "Create" is pressed - the parse endpoint
 * only returns suggestions, and every field here is editable first.
 */
import { aiParseTasks, createTask } from './api.js';
import { openModal, field, textarea, modalActions, toast } from './modal.js';
import { fromLocalInputValue } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const PLACEHOLDER = `Paste anything - bullets and indentation are fine:

PHYS 381
  - problem set 4, due Friday
  - read chapter 7
Scholarship
  - NSERC application draft by the 20th
Book dentist appointment`;

/** A YYYY-MM-DD suggestion becomes 23:59 local on that day - a deadline. */
function toLocalInput(dateOnly) {
  return dateOnly ? `${dateOnly}T23:59` : '';
}

export function openAiBulkModal({ categories, onCreated }) {
  openModal('AI bulk add', (body, close) => {
    const input = textarea('', PLACEHOLDER);
    input.rows = 10;
    body.append(field('Paste your notes', input));

    const hint = el(
      'div',
      'hint',
      'The AI only suggests - you review and edit everything before anything is created.',
    );
    body.append(hint);

    const errorLine = el('div', 'form-error');
    body.append(errorLine);

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'button ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', close);

    const analyse = el('button', 'button primary', 'Analyse with AI');
    analyse.type = 'button';
    analyse.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) {
        errorLine.textContent = 'Paste some text first.';
        return;
      }
      analyse.disabled = true;
      cancel.disabled = true;
      analyse.textContent = 'Analysing…';
      errorLine.textContent = '';
      try {
        const result = await aiParseTasks(text);
        showPreview(body, close, result.items, categories, onCreated);
      } catch (error) {
        // A rate limit or an outage stops here and nothing else is touched.
        errorLine.textContent = error.message;
        analyse.disabled = false;
        cancel.disabled = false;
        analyse.textContent = 'Analyse with AI';
      }
    });

    actions.append(cancel, analyse);
    body.append(actions);
    input.focus();
  });
}

/* ---------------------------------------------------------------- preview */

function showPreview(body, close, items, categories, onCreated) {
  body.replaceChildren();

  const summary = el('div', 'hint', `${items.length} task${items.length === 1 ? '' : 's'} found. Untick anything you do not want, and edit the rest.`);
  body.append(summary);

  const selectRow = el('div', 'chips');
  const selectAll = el('button', 'chip', 'Select all');
  selectAll.type = 'button';
  const selectNone = el('button', 'chip', 'Select none');
  selectNone.type = 'button';
  selectRow.append(selectAll, selectNone);
  body.append(selectRow);

  const list = el('div', 'ai-list');
  const rows = items.map((item, index) => buildRow(item, index, categories, () => updateCount()));
  for (const row of rows) list.append(row.element);
  body.append(list);

  selectAll.addEventListener('click', () => {
    for (const row of rows) row.checkbox.checked = true;
    updateCount();
  });
  selectNone.addEventListener('click', () => {
    for (const row of rows) row.checkbox.checked = false;
    updateCount();
  });

  const errorLine = el('div', 'form-error');
  body.append(errorLine);

  const actions = el('div', 'modal-actions');
  const back = el('button', 'button ghost', 'Cancel');
  back.type = 'button';
  back.addEventListener('click', close);

  const create = el('button', 'button primary', 'Create');
  create.type = 'button';
  actions.append(back, create);
  body.append(actions);

  function selected() {
    return rows.filter((row) => row.checkbox.checked);
  }
  function updateCount() {
    const count = selected().length;
    create.textContent = count === 1 ? 'Create 1 task' : `Create ${count} tasks`;
    create.disabled = count === 0;
  }
  updateCount();

  create.addEventListener('click', async () => {
    const chosen = selected();
    const missing = chosen.find((row) => !row.nameInput.value.trim());
    if (missing) {
      errorLine.textContent = 'Every selected task needs a name.';
      missing.nameInput.focus();
      return;
    }

    create.disabled = true;
    back.disabled = true;
    errorLine.textContent = '';
    create.textContent = 'Creating…';

    // Created one by one through the ordinary task endpoint - no special
    // bulk path, so these are identical to hand-made tasks.
    const failures = [];
    let made = 0;
    for (const row of chosen) {
      try {
        await createTask({
          name: row.nameInput.value.trim(),
          category_id: row.categorySelect.value ? Number(row.categorySelect.value) : null,
          due_date: fromLocalInputValue(row.dueInput.value),
        });
        made += 1;
      } catch (error) {
        failures.push(`${row.nameInput.value.trim()}: ${error.message}`);
      }
    }

    if (failures.length) {
      // Partial success is reported honestly rather than silently swallowed.
      errorLine.textContent = `Created ${made}, failed ${failures.length}. ${failures[0]}`;
      create.disabled = false;
      back.disabled = false;
      updateCount();
      await onCreated();
      return;
    }

    close();
    toast(`Created ${made} task${made === 1 ? '' : 's'}`);
    await onCreated();
  });
}

function buildRow(item, index, categories, onToggle) {
  const element = el('div', 'ai-row');

  const head = el('div', 'ai-row-head');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.className = 'ai-check';
  checkbox.id = `ai-row-${index}`;
  checkbox.addEventListener('change', onToggle);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = item.name;
  nameInput.className = 'ai-name';
  nameInput.setAttribute('aria-label', 'Task name');

  head.append(checkbox, nameInput);
  element.append(head);

  const fields = el('div', 'ai-row-fields');

  const categorySelect = document.createElement('select');
  categorySelect.setAttribute('aria-label', 'Category');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No category';
  categorySelect.append(none);
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = String(category.id);
    option.textContent = category.name;
    if (category.id === item.category_id) option.selected = true;
    categorySelect.append(option);
  }

  const dueInput = document.createElement('input');
  dueInput.type = 'datetime-local';
  dueInput.value = toLocalInput(item.due_date);
  dueInput.setAttribute('aria-label', 'Due date');

  fields.append(categorySelect, dueInput);
  element.append(fields);

  // Say when the AI had nothing to go on, rather than implying it chose.
  const notes = [];
  if (!item.category_id) notes.push('no category suggested');
  if (!item.due_date) notes.push('no date found in the text');
  if (notes.length) element.append(el('div', 'ai-row-note', notes.join(' · ')));

  return { element, checkbox, nameInput, categorySelect, dueInput };
}
