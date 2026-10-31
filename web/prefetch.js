// prefetch.js — what the reader may open next, fetched while they read.
//
// Once the page on screen is drawn and the browser has nothing else to do,
// the files the other pages need are fetched, so that opening one of them
// later finds its code, and the graph its ELK, already here.  It must never
// cost the reader anything, so:
//
//   * it starts only once the page is drawn — the graph laid out — and the
//     browser reports idle time, and each file waits for idle time again;
//   * one file at a time, at the lowest fetch priority;
//   * opening another page pauses it before that page is even looked up: a
//     large download in flight is aborted (`big`), so it cannot share the
//     line with the page asked for, and a small one is left to finish; it
//     goes on once the new page is drawn and the browser is idle again;
//   * not at all for a reader who asked to save data, or on a 2G connection.
//
// What to fetch is the caller's (app.js): a list of tasks, each
// `{ name, run(signal) -> Promise, needed() -> boolean, big }`, run in order.
// A task whose file has meanwhile been loaded for real is not `needed` and is
// skipped; an aborted one is run again later; one that fails is not.

const IDLE_FALLBACK_MS = 500; // where there is no requestIdleCallback (Safari)
const TASK_DEADLINE_MS = 30000; // a file that neither loads nor fails stops holding the line

let tasks = [];
const finished = new Set(); // names done, or failed for good
let paused = true; // until the first page is drawn
let current = null; // { task, controller } in flight
let idleHandle = null;
let enabled = false;
let awaitingLoad = false; // a `load` listener is in place

/** Whether this reader's connection should be left alone. */
export function saveData() {
  const c = typeof navigator !== 'undefined' && navigator.connection;
  return !!(c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || ''))));
}

/** Hand over the tasks; nothing runs until `resumePrefetch`. */
export function setupPrefetch(list) {
  tasks = list.slice();
  finished.clear();
  enabled = !saveData();
  paused = true;
  current = null;
  cancelIdle();
}

/** A page is about to be opened: stop starting files, and drop a large one in flight. */
export function pausePrefetch() {
  paused = true;
  cancelIdle();
  if (current && current.task.big) current.controller.abort();
}

/** The page on screen is drawn: go on when the browser is idle. */
export function resumePrefetch() {
  paused = false;
  schedule();
}

/** The names of the tasks still to run, for the tests. */
export function pendingPrefetch() {
  return tasks.filter((t) => !finished.has(t.name)).map((t) => t.name);
}

function schedule() {
  if (!enabled || paused || current || idleHandle !== null) return;
  if (!pageLoaded()) {
    if (!awaitingLoad) {
      awaitingLoad = true;
      window.addEventListener('load', () => { awaitingLoad = false; schedule(); }, { once: true });
    }
    return;
  }
  idleHandle = whenIdle(step);
}

function step() {
  idleHandle = null;
  if (paused || current) return;
  const task = tasks.find((t) => !finished.has(t.name) && t.needed());
  if (!task) return;
  const controller = new AbortController();
  current = { task, controller };
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, TASK_DEADLINE_MS); });
  Promise.race([Promise.resolve().then(() => task.run(controller.signal)), deadline])
    .then(() => { finished.add(task.name); },
      () => { if (!controller.signal.aborted) finished.add(task.name); })
    .then(() => {
      clearTimeout(timer);
      if (current && current.task === task) current = null;
      schedule();
    });
}

/** The page's own resources are in (`load`), so nothing of ours goes before them. */
function pageLoaded() {
  return typeof document !== 'undefined' && document.readyState === 'complete';
}

function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') return { idle: requestIdleCallback(() => fn()) };
  return { timer: setTimeout(fn, IDLE_FALLBACK_MS) };
}

function cancelIdle() {
  if (idleHandle === null) return;
  if (idleHandle.idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle.idle);
  if (idleHandle.timer !== undefined) clearTimeout(idleHandle.timer);
  idleHandle = null;
}

// ---------------------------------------------------------------------------
// the two ways a file is fetched
// ---------------------------------------------------------------------------

/**
 * A file into the browser's HTTP cache, read to the end so that it is kept,
 * at the lowest priority.  CORS, without credentials: what the CDN answers,
 * and what a later script tag or a worker's `importScripts` finds again.
 */
export async function prefetchFile(url, signal) {
  const res = await fetch(url, { priority: 'low', mode: 'cors', credentials: 'omit', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await res.arrayBuffer();
}

/**
 * One of the site's own modules into the module map, the way index.html
 * preloads the page it opens on, but at the lowest priority: a later
 * `import()` then neither fetches nor waits for it.
 */
export function prefetchModule(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'modulepreload');
    link.setAttribute('fetchpriority', 'low');
    link.setAttribute('href', href);
    link.addEventListener('load', () => resolve());
    link.addEventListener('error', () => reject(new Error('could not preload ' + href)));
    (document.head || document.documentElement).appendChild(link);
  });
}
