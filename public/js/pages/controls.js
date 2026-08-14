/** Sort controls shared by the pages. Every sort is reversible. */

const STORE_PREFIX = 'tt.sort.';

export function loadSort(page, fallback) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + page);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export function saveSort(page, state) {
  try {
    localStorage.setItem(STORE_PREFIX + page, JSON.stringify(state));
  } catch {
    /* private mode - sorting just won't persist */
  }
}

/**
 * @param options  [{value,label}] - omit for a fixed single sort (Upcoming)
 * @param state    {sort, order}
 * @param onChange called with the new state
 */
export function sortControls({ page, options, state, onChange, fixedLabel }) {
  const wrap = document.createElement('div');
  wrap.className = 'toolbar';

  const label = document.createElement('label');
  label.textContent = 'Sort';
  wrap.append(label);

  if (options) {
    const selectEl = document.createElement('select');
    selectEl.style.width = 'auto';
    for (const option of options) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.value === state.sort) opt.selected = true;
      selectEl.append(opt);
    }
    selectEl.addEventListener('change', () => {
      const next = { ...state, sort: selectEl.value };
      // Overage sorts read most naturally largest-first.
      next.order = selectEl.value.startsWith('overtime') ? 'desc' : 'asc';
      saveSort(page, next);
      onChange(next);
    });
    wrap.append(selectEl);
  } else {
    const fixed = document.createElement('span');
    fixed.textContent = fixedLabel;
    fixed.style.fontSize = '0.9rem';
    wrap.append(fixed);
  }

  const reverse = document.createElement('button');
  reverse.type = 'button';
  reverse.className = 'button ghost';
  const ascending = state.order !== 'desc';
  reverse.textContent = ascending ? '↑ Ascending' : '↓ Descending';
  reverse.title = 'Reverse sort order';
  reverse.addEventListener('click', () => {
    const next = { ...state, order: ascending ? 'desc' : 'asc' };
    saveSort(page, next);
    onChange(next);
  });
  wrap.append(reverse);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  wrap.append(spacer);

  return wrap;
}

export function primaryButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button primary';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
