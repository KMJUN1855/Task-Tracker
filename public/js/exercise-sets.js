/**
 * The grouped set log.
 *
 * Shared so the Exercise page and the Details modal on Progress / Finished /
 * Overview render a workout identically - one renderer, one shape
 * (`type_groups` from the API), no chance of the two drifting apart.
 */
import { formatClock, formatCompact } from './format.js';

export const UNTYPED_LABEL = 'Untyped';
export const typeLabel = (name) => (name === null || name === undefined ? UNTYPED_LABEL : name);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const liveSeconds = (fromIso) =>
  Math.max(0, (Date.now() - new Date(fromIso).getTime()) / 1000);

/**
 * @param data a workout payload: { sets, type_groups }
 * @param options.emptyMessage shown when there are no sets
 *
 * Sets are numbered within their group, which is how a workout reads. Running
 * sets and the running rest are tagged for the Exercise page's per-second tick,
 * and also given a correct value up front so they are never blank where nothing
 * ticks - such as inside this modal on another page.
 */
export function renderSetLog(data, { emptyMessage = 'No sets recorded.' } = {}) {
  const sets = data?.sets ?? [];
  if (sets.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'big', '—'));
    empty.append(document.createTextNode(emptyMessage));
    return empty;
  }

  const groups = data.type_groups ?? [
    {
      type_name: null,
      sets,
      set_count: sets.length,
      total_seconds: sets.reduce((sum, set) => sum + set.duration_seconds, 0),
    },
  ];

  const wrap = el('div', 'type-groups');
  for (const group of groups) {
    const block = el('div', 'type-group');

    const header = el('div', 'type-group-head');
    const name = el('span', 'type-group-name', typeLabel(group.type_name));
    if (group.type_name === null) name.classList.add('untyped');
    header.append(name);
    header.append(
      el(
        'span',
        'type-group-meta',
        `${group.set_count} set${group.set_count === 1 ? '' : 's'} · ${formatCompact(group.total_seconds)}`,
      ),
    );
    block.append(header);

    const list = el('div', 'set-list');
    group.sets.forEach((set, indexInGroup) => {
      const row = el('div', 'set-row');
      if (set.is_running) row.classList.add('running');
      row.append(el('span', 'set-index', `#${indexInGroup + 1}`));

      const duration = el('span', 'set-duration');
      if (set.is_running) {
        duration.dataset.role = 'live-set';
        duration.dataset.start = set.start_time;
        duration.textContent = formatClock(liveSeconds(set.start_time));
      } else {
        duration.textContent = formatClock(set.duration_seconds);
      }
      row.append(duration);

      const rest = el('span', 'set-rest');
      if (set.rest_running) {
        rest.dataset.role = 'live-rest';
        rest.dataset.start = set.end_time;
        rest.textContent = `rest ${formatCompact(liveSeconds(set.end_time))}`;
      } else if (set.rest_after_seconds !== null) {
        rest.textContent = `rest ${formatCompact(set.rest_after_seconds)}`;
      } else {
        rest.textContent = 'running';
      }
      row.append(rest);
      list.append(row);
    });
    block.append(list);
    wrap.append(block);
  }
  return wrap;
}
