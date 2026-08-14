/** App shell: hash router, the once-a-second tick, and shared state. */
import { listCategories, listTasks } from './api.js';
import { tickCards } from './task-card.js';
import { closeModal } from './modal.js';
import * as overview from './pages/overview.js';
import * as upcoming from './pages/upcoming.js';
import * as progress from './pages/progress.js';
import * as finished from './pages/finished.js';
import * as calendar from './pages/calendar.js';
import * as exercise from './pages/exercise.js';

const PAGES = { overview, upcoming, progress, finished, calendar, exercise };
const DEFAULT_PAGE = 'overview';

const view = document.getElementById('view');
const clock = document.getElementById('clock');
const refreshButton = document.getElementById('refresh');

const ctx = {
  categories: [],
  reload: () => renderCurrent(),
};

const currentPage = () => {
  const name = location.hash.replace(/^#\/?/, '');
  return PAGES[name] ? name : DEFAULT_PAGE;
};

function markActiveTab(name) {
  const tabs = document.querySelector('.tabs');
  let active = null;
  for (const link of document.querySelectorAll('.tabs a')) {
    const isActive = link.dataset.tab === name;
    if (isActive) {
      link.setAttribute('aria-current', 'page');
      active = link;
    } else {
      link.removeAttribute('aria-current');
    }
  }
  // Five tabs overflow a phone's width, so centre the active one rather than
  // leaving it off-screen. Set scrollLeft directly - scrollIntoView would drag
  // the whole page around too.
  if (active && tabs.scrollWidth > tabs.clientWidth) {
    tabs.scrollLeft = active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2;
  }
  document.title = `${PAGES[name].title} · Task Tracker`;
}

function showError(message) {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button';
  retry.textContent = 'Retry';
  retry.style.marginTop = '0.6rem';
  retry.addEventListener('click', () => renderCurrent());
  banner.append(document.createElement('br'), retry);
  view.replaceChildren(banner);
}

let renderToken = 0;

async function renderCurrent() {
  const name = currentPage();
  markActiveTab(name);
  const token = ++renderToken;

  try {
    if (ctx.categories.length === 0) ctx.categories = await listCategories();
    const result = await PAGES[name].render(view, ctx);
    if (token !== renderToken) return; // a newer render already won
    setBadge(name, result?.count);
    refreshBadges(name);
  } catch (error) {
    if (token !== renderToken) return;
    showError(error.message);
  }
}

/* ------------------------------------------------------------- badges */

function setBadge(name, count) {
  const badge = document.querySelector(`.badge[data-count="${name}"]`);
  if (!badge) return;
  // Finished grows without bound, so it carries no badge.
  badge.textContent = name === 'finished' || !count ? '' : String(count);
}

/** Keeps the two counts that matter fresh even while another tab is open. */
async function refreshBadges(skip) {
  const jobs = [];
  if (skip !== 'upcoming') {
    jobs.push(
      listTasks({ status: 'upcoming' }).then((tasks) => setBadge('upcoming', tasks.length)),
    );
  }
  if (skip !== 'progress') {
    jobs.push(
      listTasks({ status: 'in_progress,paused' }).then((tasks) =>
        setBadge('progress', tasks.length),
      ),
    );
  }
  await Promise.allSettled(jobs);
}

/* --------------------------------------------------------------- ticks */

// Cards recompute themselves from absolute timestamps, so this only redraws -
// it never accumulates anything.
setInterval(() => {
  tickCards();
  // A page may expose its own per-second work (the exercise stopwatch does).
  PAGES[currentPage()].tick?.();
  clock.textContent = new Date().toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}, 1000);

// Coming back to a phone that was asleep: the cards are already correct thanks
// to timestamp maths, but another device may have changed something.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderCurrent();
});

refreshButton.addEventListener('click', () => {
  refreshButton.classList.remove('spinning');
  void refreshButton.offsetWidth; // restart the animation
  refreshButton.classList.add('spinning');
  ctx.categories = [];
  renderCurrent();
});

window.addEventListener('hashchange', () => {
  closeModal();
  renderCurrent();
});

if (!location.hash) location.hash = `#/${DEFAULT_PAGE}`;
renderCurrent();
