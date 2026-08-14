/** Shared modal + toast. One dialog element is reused for every form. */

const backdrop = document.getElementById('modal-backdrop');
const dialog = document.getElementById('modal');
const titleEl = document.getElementById('modal-title');
const bodyEl = document.getElementById('modal-body');
const toastEl = document.getElementById('toast');

let closeCurrent = null;
let lastFocused = null;

export function openModal(title, buildBody) {
  closeModal();
  lastFocused = document.activeElement;
  titleEl.textContent = title;
  bodyEl.replaceChildren();
  backdrop.hidden = false;

  const close = () => closeModal();
  buildBody(bodyEl, close);

  const firstField = bodyEl.querySelector('input, textarea, select, button');
  firstField?.focus();
  closeCurrent = close;
}

export function closeModal() {
  if (backdrop.hidden) return;
  backdrop.hidden = true;
  // Clear the title too, so a closed dialog leaves nothing behind in the DOM.
  titleEl.textContent = '';
  bodyEl.replaceChildren();
  closeCurrent = null;
  lastFocused?.focus?.();
}

backdrop.addEventListener('click', (event) => {
  if (event.target === backdrop) closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !backdrop.hidden) closeModal();
});

// Keep tab focus inside the dialog while it is open.
dialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusables = dialog.querySelectorAll(
    'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

let toastTimer = null;
export function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast${isError ? ' error' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, isError ? 5000 : 2500);
}

/* ------------------------------------------------------- form building */

export function field(labelText, control, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  label.htmlFor = id;
  control.id = id;
  wrap.append(label, control);
  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'hint';
    hintEl.textContent = hint;
    wrap.append(hintEl);
  }
  return wrap;
}

export function input(type, value = '', placeholder = '') {
  const node = document.createElement('input');
  node.type = type;
  node.value = value ?? '';
  node.placeholder = placeholder;
  return node;
}

export function textarea(value = '', placeholder = '') {
  const node = document.createElement('textarea');
  node.value = value ?? '';
  node.placeholder = placeholder;
  return node;
}

export function select(options, value) {
  const node = document.createElement('select');
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = String(option.value);
    opt.textContent = option.label;
    if (String(option.value) === String(value)) opt.selected = true;
    node.append(opt);
  }
  return node;
}

/**
 * Submit / cancel row. `onSubmit` may be async; the button locks while it runs
 * and errors land in the inline error line instead of a browser alert.
 */
export function modalActions(submitLabel, onSubmit, onCancel) {
  const errorLine = document.createElement('div');
  errorLine.className = 'form-error';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', onCancel);

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'button primary';
  submit.textContent = submitLabel;
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    errorLine.textContent = '';
    try {
      await onSubmit();
    } catch (error) {
      errorLine.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  actions.append(cancel, submit);
  const fragment = document.createDocumentFragment();
  fragment.append(errorLine, actions);
  return fragment;
}
