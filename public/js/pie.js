/**
 * Pie chart, hand-drawn as SVG - no chart library, nothing loaded from a CDN.
 *
 * Each slice carries a fill pattern as well as a colour, so the breakdown is
 * still readable without colour vision, and the legend repeats every value as
 * text.
 */
import { formatCompact } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/** Six repeating motifs, cycled alongside the colours. */
const PATTERNS = [
  null, // solid
  { d: 'M0,4 l8,-8 M-2,2 l4,-4 M6,10 l4,-4', type: 'stroke' },
  { d: 'M0,0 l8,8 M-2,6 l4,4 M6,-2 l4,4', type: 'stroke' },
  { d: 'M2,2 m-1.4,0 a1.4,1.4 0 1,0 2.8,0 a1.4,1.4 0 1,0 -2.8,0', type: 'fill' },
  { d: 'M4,0 v8', type: 'stroke' },
  { d: 'M0,4 h8', type: 'stroke' },
];

function patternDefs(count) {
  const defs = svgEl('defs');
  for (let i = 0; i < count; i += 1) {
    const motif = PATTERNS[i % PATTERNS.length];
    if (!motif) continue;
    const pattern = svgEl('pattern', {
      id: `pie-pattern-${i}`,
      width: 8,
      height: 8,
      patternUnits: 'userSpaceOnUse',
    });
    pattern.append(
      svgEl('path', {
        d: motif.d,
        ...(motif.type === 'stroke'
          ? { stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 1.6, fill: 'none' }
          : { fill: 'rgba(0,0,0,0.5)' }),
      }),
    );
    defs.append(pattern);
  }
  return defs;
}

function arcPath(cx, cy, r, startAngle, endAngle) {
  const point = (angle) => [
    cx + r * Math.cos((angle - 90) * (Math.PI / 180)),
    cy + r * Math.sin((angle - 90) * (Math.PI / 180)),
  ];
  const [x1, y1] = point(startAngle);
  const [x2, y2] = point(endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

/**
 * @param slices [{ label, seconds, color }] - order is preserved
 * @returns a figure element containing the chart and its legend
 */
export function renderPie(slices, { size = 220, title = 'Time distribution' } = {}) {
  const figure = document.createElement('figure');
  figure.className = 'pie-figure';

  const total = slices.reduce((sum, slice) => sum + slice.seconds, 0);
  if (total <= 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No time tracked on this day.';
    figure.append(empty);
    return figure;
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'pie',
    role: 'img',
    'aria-label': `${title}: ${slices
      .map((s) => `${s.label} ${formatCompact(s.seconds)}`)
      .join(', ')}`,
  });
  svg.append(patternDefs(slices.length));

  let angle = 0;
  slices.forEach((slice, index) => {
    const sweep = (slice.seconds / total) * 360;
    // A lone slice cannot be drawn as an arc - 360 degrees would collapse to a
    // zero-length path - so it becomes a full circle instead.
    const shape =
      sweep >= 359.99
        ? () => svgEl('circle', { cx, cy, r })
        : () => svgEl('path', { d: arcPath(cx, cy, r, angle, angle + sweep) });

    const base = shape();
    base.setAttribute('fill', slice.color);
    base.setAttribute('stroke', 'var(--surface)');
    base.setAttribute('stroke-width', '1.5');
    svg.append(base);

    if (PATTERNS[index % PATTERNS.length]) {
      const overlay = shape();
      overlay.setAttribute('fill', `url(#pie-pattern-${index})`);
      overlay.setAttribute('stroke', 'none');
      overlay.setAttribute('pointer-events', 'none');
      svg.append(overlay);
    }

    const label = svgEl('title');
    label.textContent = `${slice.label}: ${formatCompact(slice.seconds)}`;
    base.append(label);

    angle += sweep;
  });

  figure.append(svg);

  const legend = document.createElement('ul');
  legend.className = 'pie-legend';
  slices.forEach((slice, index) => {
    const item = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = `pie-swatch pattern-${index % PATTERNS.length}`;
    swatch.style.background = slice.color;
    swatch.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'pie-label';
    name.textContent = slice.label;

    const value = document.createElement('span');
    value.className = 'pie-value';
    value.textContent = `${formatCompact(slice.seconds)} · ${Math.round(
      (slice.seconds / total) * 100,
    )}%`;

    item.append(swatch, name, value);
    legend.append(item);
  });
  figure.append(legend);

  return figure;
}

/** Horizontal bars under the pie: the per-task time breakdown. */
export function renderBreakdown(slices) {
  const wrap = document.createElement('div');
  wrap.className = 'breakdown';
  const max = Math.max(...slices.map((slice) => slice.seconds), 1);

  for (const slice of slices) {
    const row = document.createElement('div');
    row.className = 'breakdown-row';

    const head = document.createElement('div');
    head.className = 'breakdown-head';
    const name = document.createElement('span');
    name.textContent = slice.label;
    const time = document.createElement('b');
    time.textContent = formatCompact(slice.seconds);
    head.append(name, time);

    const bar = document.createElement('div');
    bar.className = 'breakdown-bar';
    const fill = document.createElement('i');
    fill.style.width = `${(slice.seconds / max) * 100}%`;
    fill.style.background = slice.color;
    bar.append(fill);

    row.append(head, bar);
    wrap.append(row);
  }
  return wrap;
}
