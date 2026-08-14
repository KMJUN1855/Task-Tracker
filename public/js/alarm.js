/**
 * Rest alarm.
 *
 * What a browser page can and cannot do here is worth stating plainly, because
 * it decides the design:
 *
 *  - A page that is backgrounded gets its timers throttled, and one whose tab
 *    is frozen or whose phone screen is locked may not run JavaScript at all.
 *    iOS suspends the page almost immediately on lock; Android is more
 *    forgiving but still throttles.
 *  - There is no way for a plain web page to schedule an alarm the operating
 *    system will fire later. A Service Worker cannot hold a timer across
 *    suspension either; the only reliable wake-up is a server Push, which needs
 *    a push subscription and a server awake to send it - neither of which this
 *    free-tier, single-user setup has (Render sleeps after ~15 minutes idle).
 *
 * So the design is: keep the screen on while a workout is running, which side-
 * steps the whole problem, and make everything else degrade honestly.
 *
 *  1. Screen Wake Lock while a workout is active - the real fix. The screen
 *     stays on, the page stays alive, the alarm fires on time.
 *  2. The deadline is an absolute timestamp, never a countdown integer. If the
 *     page is suspended and resumed, the remaining time is still right, and an
 *     alarm that came due while away fires the moment the page is back, saying
 *     how late it is.
 *  3. Sound via Web Audio, unlocked on a user gesture, plus vibration and a
 *     notification - each used only if the platform actually offers it.
 */

let audioContext = null;
let unlocked = false;
let wakeLock = null;
let wakeLockWanted = false;

export const support = {
  audio: typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function',
  vibrate: typeof navigator.vibrate === 'function',
  notification: typeof window.Notification === 'function',
  wakeLock: 'wakeLock' in navigator,
};

export const notificationPermission = () =>
  support.notification ? Notification.permission : 'unsupported';

/**
 * Arms the audio context. Must run inside a real user gesture - browsers refuse
 * to create or resume audio otherwise. Safe to call repeatedly.
 */
export async function unlockAudio() {
  if (support.audio && !audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctor();
  }
  if (audioContext && audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch {
      /* nothing else to try */
    }
  }
  // A silent one-sample blip; on iOS this is what actually arms the context.
  if (audioContext && !unlocked) {
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
    unlocked = true;
  }
}

/**
 * Audio plus the notification permission prompt. Only called from the workout
 * buttons - asking for notifications on a stray tap elsewhere in the app would
 * be intrusive, and browsers penalise prompts with no obvious cause.
 */
export async function unlock() {
  await unlockAudio();
  if (support.notification && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      /* user dismissed it; sound and vibration still work */
    }
  }
}

/** Three rising beeps - audible without being startling in a quiet gym. */
export function beep() {
  if (!audioContext) return false;
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

  const now = audioContext.currentTime;
  [0, 0.28, 0.56].forEach((offset, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 660 + index * 220;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.24);
  });
  return true;
}

export function vibrate() {
  if (!support.vibrate) return false;
  try {
    return navigator.vibrate([200, 100, 200, 100, 400]);
  } catch {
    return false;
  }
}

/** Only useful while the page still runs; it cannot wake a suspended page. */
export function notify(title, body) {
  if (!support.notification || Notification.permission !== 'granted') return false;
  try {
    const notification = new Notification(title, { body, tag: 'tt-rest', renotify: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** Fires every channel available. Returns what actually happened. */
export function fireAlarm({ title = 'Rest is over', body = 'Start your next set.' } = {}) {
  return {
    sound: beep(),
    vibration: vibrate(),
    notification: document.visibilityState === 'hidden' ? notify(title, body) : false,
  };
}

/**
 * Audio cannot exist before the user has interacted with the page, so a page
 * loaded fresh into an already-overdue rest has no way to make a sound. Arm at
 * the first interaction anywhere, whatever it was, so that window is as small
 * as possible. (The visual state is always there regardless.)
 */
function armOnFirstGesture() {
  const handler = () => {
    unlockAudio(); // audio only - the notification prompt stays on the workout buttons
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
  };
  window.addEventListener('pointerdown', handler, { passive: true });
  window.addEventListener('keydown', handler);
}
armOnFirstGesture();

/* -------------------------------------------------------------- wake lock */

export async function requestWakeLock() {
  wakeLockWanted = true;
  if (!support.wakeLock || wakeLock) return Boolean(wakeLock);
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch {
    // Denied, or the tab is not visible. Retried on the next visibility change.
    wakeLock = null;
    return false;
  }
}

export async function releaseWakeLock() {
  wakeLockWanted = false;
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch {
    /* already gone */
  }
  wakeLock = null;
}

export const wakeLockActive = () => Boolean(wakeLock);

// The OS drops the lock whenever the tab is hidden, so take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLockWanted && !wakeLock) {
    requestWakeLock();
  }
});
