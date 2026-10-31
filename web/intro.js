// intro.js — what the site shows in the middle of the screen as it opens.
//
// A project may give its website an introduction, `[site.intro]` in
// blueprint.toml, which reaches the snapshot as `project.intro`:
//
//   "intro": { "body": "…Markdown…", "durationMs": 3000,
//              "background": "assets/page.jpg", "holdMs": 500, "stepMs": 1000,
//              "zoom": [ { "nodes": [{"id", "title", "kind"}], "arrows": [["a", "b"]] } ] }
//
// The body is rendered as any object's prose is (`renderBody`), so it may carry
// maths, `[slug]` references, pictures (`![…](assets/logo.png)`) and HTML of
// its own (a `<video>`, an `<svg>`, an `<iframe>`).  A relative address in it
// is resolved against the directory holding blueprint.json, which is where
// `blueprint site` puts the project's `[site] assets` as `assets/`.
//
// Without `zoom` it is drawn as one node in the middle of an empty screen,
// while the graph is laid out behind it.  After `durationMs` (default
// `DEFAULT_MS`) it fades and shrinks away, leaving the graph.
//
// With `zoom` it is a short film instead (`playZoom`).  The body is a title,
// large in the middle of the screen in the font of the top bar's title, over
// the faded `background`.  After `holdMs` the title flies into the top bar and
// becomes its title, while the top bar and the graph's tools fade in, and the
// view zooms: the background grows and fades, and out of the middle of the
// screen grows the first picture of `zoom`, boxes and arrows drawn as the
// graph draws them; it grows on and fades while the next one grows out of the
// middle, and so on, the last being the graph itself.  Every step takes
// `stepMs` and makes everything `ZOOM` times bigger, so the zoom keeps one
// speed throughout.  The title stays until the snapshot is in and the graph
// is drawn, so a large snapshot is waited for here rather than on a blank
// page: `blueprint site` writes the intro to intro.json as well, which
// index.html asks for beside the snapshot (`earlyIntro`).
//
// Either way a click, Escape, Enter or Space ends it at once; a link in it is
// still followed.
//
// Only on the way in: when the site is opened at its landing page, the bare
// graph.  A link to anything else (an object, the document, a graph with a
// selection) is something the reader asked for and opens straight on it, and
// `?intro=0` in the page's URL leaves the intro out anywhere.

export const DEFAULT_MS = 3000;
export const FADE_MS = 700; // the `.intro.leaving` transition in style.css
export const HOLD_MS = 500; // how long a zooming intro's title stays, at least
export const STEP_MS = 1000; // how long each step of the zoom takes
export const TITLE_IN_MS = 700; // the title growing in: `intro-title-in` in style.css
export const ZOOM = 10; // how much bigger each step of the zoom makes everything
export const PICTURE_MAX = 2; // the largest a picture is drawn, in units of the graph's
export const WAIT_MS = 15000; // how long the title waits for the graph once the snapshot is in

function positive(x, d) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** The pictures of a zooming intro, each `{nodes, arrows}`, every arrow between two of its nodes. */
function zoomOf(zoom) {
  if (!Array.isArray(zoom)) return [];
  const out = [];
  for (const layer of zoom) {
    const nodes = (layer && Array.isArray(layer.nodes) ? layer.nodes : [])
      .filter((n) => n && typeof n.title === 'string' && n.title)
      .map((n) => ({
        id: typeof n.id === 'string' && n.id ? n.id : n.title,
        title: n.title,
        kind: typeof n.kind === 'string' && n.kind ? n.kind : 'section',
      }));
    if (!nodes.length) continue;
    const ids = new Set(nodes.map((n) => n.id));
    const arrows = (Array.isArray(layer.arrows) ? layer.arrows : [])
      .filter((a) => Array.isArray(a) && a.length === 2 && ids.has(a[0]) && ids.has(a[1]));
    out.push({ nodes, arrows });
  }
  return out;
}

/**
 * The project's intro as `{body, durationMs, background, holdMs, stepMs,
 * zoom}`, or null when it has none.  `zoom` is empty for the single node.
 */
export function introOf(project) {
  const i = project && project.intro;
  if (!i || typeof i !== 'object' || typeof i.body !== 'string' || !i.body.trim()) return null;
  return {
    body: i.body,
    durationMs: positive(i.durationMs, DEFAULT_MS),
    background: typeof i.background === 'string' ? i.background : '',
    holdMs: positive(i.holdMs, HOLD_MS),
    stepMs: positive(i.stepMs, STEP_MS),
    zoom: zoomOf(i.zoom),
  };
}

/**
 * The intro as index.html fetched it from intro.json before any script had
 * arrived: `{title, intro}` as a project, or null when the site has none (or
 * the page did not ask, not being the landing page).
 */
export async function earlyIntro() {
  const early = typeof window !== 'undefined' ? window.blueprintIntro : null;
  if (!early || typeof early.then !== 'function') return null;
  try {
    const j = await early;
    return j && typeof j === 'object' && introOf(j) ? j : null;
  } catch (e) {
    return null;
  }
}

/**
 * Settles once marked, which renders the intro's Markdown, has run: the
 * deferred scripts run only after `document.readyState` is `interactive`, so
 * that alone does not say they have.  At most `ms` later in any case.
 */
export function proseReady(ms = 2000) {
  if (typeof window === 'undefined' || window.marked) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('DOMContentLoaded', done);
      window.removeEventListener('load', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    document.addEventListener('DOMContentLoaded', done);
    window.addEventListener('load', done);
  });
}

/** Let the page show again what index.html hid while it asked for intro.json. */
export function introDecided() {
  if (typeof document !== 'undefined') document.documentElement.classList.remove('intro-pending');
}

/** Whether a page opened at `route`, with `search` as its query, opens on the intro. */
export function wantsIntro(project, route, search) {
  if (!introOf(project)) return false;
  try {
    if (new URLSearchParams(search || '').get('intro') === '0') return false;
  } catch (e) { /* no URLSearchParams: keep the intro */ }
  return !!route && route.view === 'graph' && route.raw === '/graph';
}

// Addresses that are already complete: with a scheme (`https:`, `data:`,
// `mailto:`), protocol- or root-relative, or a fragment (`#/object/…`).
const COMPLETE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** `url` resolved against `base`, unless it is complete already. */
export function resolveUrl(url, base) {
  const u = String(url == null ? '' : url).trim();
  if (!u || !base || COMPLETE_URL.test(u)) return url;
  try {
    return new URL(u, base).href;
  } catch (e) {
    return url;
  }
}

const URL_ATTRS = [
  ['img', 'src'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'],
  ['source', 'src'], ['track', 'src'], ['iframe', 'src'], ['embed', 'src'],
  ['object', 'data'], ['a', 'href'],
];

function resolveUrls(root, base) {
  for (const [tag, attr] of URL_ATTRS) {
    for (const node of root.querySelectorAll(tag)) {
      const v = node.getAttribute(attr);
      if (v !== null) node.setAttribute(attr, resolveUrl(v, base));
    }
  }
}

/**
 * Put the project's intro over the page, and take it away again after its
 * duration.  Returns `{layer, leave}`, `leave()` ending it early, or null when
 * the project has no intro.
 */
export function showIntro(app, { host = document.body, project = app.model && app.model.project } = {}) {
  const intro = introOf(project);
  introDecided();
  if (!intro || !host) return null;
  if (intro.zoom.length) return playZoom(app, intro, { host });
  const { el } = app;

  const body = el('div.intro-body');
  app.renderBody(body, intro.body, app.knownIds());
  if (app.baseUrl) resolveUrls(body, app.baseUrl);
  const node = el('div.intro-node', body,
    el('div.intro-timer', { 'aria-hidden': 'true', style: { animationDuration: intro.durationMs + 'ms' } }));
  const layer = el('div.intro', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Introduction', tabindex: '-1',
  }, node, el('button.intro-skip', { type: 'button' }, 'Skip'));

  let left = false;
  const timer = setTimeout(leave, intro.durationMs);
  function onKey(ev) {
    if (ev.key !== 'Escape' && ev.key !== 'Enter' && ev.key !== ' ') return;
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    leave();
  }
  function leave() {
    if (left) return;
    left = true;
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    // From here on the layer lets the pointer through to the graph, while it
    // fades; then it goes.
    layer.classList.add('leaving');
    setTimeout(() => { if (layer.parentNode) layer.parentNode.removeChild(layer); }, FADE_MS);
  }
  // The skip button is inside the layer, so this is its click too.
  layer.addEventListener('click', leave);
  window.addEventListener('keydown', onKey, true);

  host.appendChild(layer);
  try { layer.focus({ preventScroll: true }); } catch (e) { /* an old browser */ }
  return { layer, leave, loaded() {} };
}

// ---------------------------------------------------------------------------
// the zoom
// ---------------------------------------------------------------------------

/**
 * How far the zoom has got after `t` of its `steps` steps: one step per unit
 * of `t`, except that the first step starts from rest and the last comes to
 * rest, each joining the steady part at its speed.  Clamped to [0, steps].
 */
export function zoomProgress(t, steps) {
  const u = Math.max(0, Math.min(steps, t));
  const out = (x) => x + x * x - x * x * x; // speed 1 down to 0
  const into = (x) => 1 - out(1 - x); // speed 0 up to 1
  if (steps <= 1) return u * u * (3 - 2 * u);
  if (u < 1) return into(u);
  if (u > steps - 1) return steps - 1 + out(u - (steps - 1));
  return u;
}

/**
 * Each of the `count` layers of the zoom at progress `p` (`zoomProgress`), as
 * `{scale, opacity}`.  Layer 0 is the background and the last is the graph;
 * layer i is at rest, at scale 1 and fully shown, at p = i.  On its way in it
 * grows from 1/zoom and fades in, on its way out it grows on to zoom and
 * fades out, so every layer grows by the same factor in the same time.  The
 * first has no way in and the last no way out.
 */
export function zoomLayers(p, count, zoom = ZOOM) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let d = p - i;
    if (i === 0 && d < 0) d = 0;
    if (i === count - 1 && d > 0) d = 0;
    const opacity = d <= -1 || d >= 1 ? 0 : d <= 0 ? 1 - d * d : (1 - d) * (1 - d);
    out.push({ scale: Math.pow(zoom, d), opacity });
  }
  return out;
}

/** The directory the snapshot is read from, which the intro's addresses are relative to. */
function snapshotBase(app) {
  if (app.baseUrl) return app.baseUrl;
  try {
    return new URL('.', new URL(app.dataUrlOriginal || 'blueprint.json', location.href)).href;
  } catch (e) {
    return null;
  }
}

/**
 * The zooming intro: see the top of this file.  Returns `{layer, leave,
 * loaded}`: `leave()` ends it at once, and `loaded()` says the snapshot is in,
 * from when on the title waits at most `WAIT_MS` for the graph.
 */
function playZoom(app, intro, { host }) {
  const { el } = app;
  const root = document.documentElement;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const zoom = reduced ? 1 : ZOOM;
  const step = intro.stepMs;
  const base = snapshotBase(app);

  const backdrop = el('div.intro-backdrop');
  const bg = intro.background
    ? el('div.intro-bg', el('img', { src: resolveUrl(intro.background, base), alt: '', decoding: 'async' }))
    : null;
  const layer = el('div.intro.zoom', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Introduction', tabindex: '-1',
  }, backdrop, bg);
  const words = el('div.intro-words');
  if (window.marked) {
    app.renderBody(words, intro.body, app.knownIds());
    if (base) resolveUrls(words, base);
  } else {
    // No Markdown to be had: the words, without the marks of a heading.
    words.textContent = intro.body.replace(/^\s*#+\s*/gm, '').trim();
  }
  const title = el('div.intro-title', el('div.intro-line', words), el('div.intro-wait', { 'aria-hidden': 'true' }));
  const skip = el('button.intro-skip.zoom', { type: 'button' }, 'Skip');
  // The title is set in the top bar's, which it becomes.
  const brandText = document.getElementById('project-title');
  if (brandText) {
    try {
      const cs = getComputedStyle(brandText);
      title.style.fontFamily = cs.fontFamily;
      title.style.fontWeight = cs.fontWeight;
    } catch (e) { /* the stylesheet's own */ }
  }
  root.style.setProperty('--intro-step', step + 'ms');
  root.classList.add('intro-playing');
  host.appendChild(layer);
  host.appendChild(title);
  host.appendChild(skip);
  try { layer.focus({ preventScroll: true }); } catch (e) { /* an old browser */ }

  const t0 = performance.now();
  const holdUntil = t0 + TITLE_IN_MS + intro.holdMs;
  let left = false;
  let started = false;
  let pictures = null;
  let drawn = !!document.querySelector('.graph-stage.drawn');
  let giveUp = null;
  const timers = [];
  const later = (f, ms) => timers.push(setTimeout(f, Math.max(0, ms)));

  import('./graph.js')
    .then((g) => Promise.all(intro.zoom.map((l) => g.sketch(app, l))))
    .catch((e) => {
      console.warn('the intro could not draw its pictures (' + (e && e.message ? e.message : e) + ')');
      return [];
    })
    .then((p) => { pictures = p; maybeStart(); });
  function onDrawn() { drawn = true; maybeStart(); }
  document.addEventListener('graphdrawn', onDrawn);
  later(maybeStart, holdUntil - performance.now());
  // A snapshot slow to arrive: say so under the title.
  later(() => { if (!started) title.classList.add('waiting'); }, TITLE_IN_MS + intro.holdMs + 600);

  function maybeStart() {
    if (left || started || !drawn || !pictures || performance.now() < holdUntil - 5) return;
    started = true;
    clearTimeout(giveUp);
    title.classList.remove('waiting');
    requestAnimationFrame(run);
  }

  function run() {
    if (left) return;
    const stage = document.querySelector('.graph-stage');
    const graphSvg = stage && stage.querySelector(':scope > svg');
    const r = stage ? stage.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    // Every layer grows out of, and into, the middle of the graph's stage.
    const layers = [];
    if (bg) bg.style.transformOrigin = `${cx}px ${cy}px`;
    layers.push(bg);
    for (const pic of pictures) {
      const k = Math.min(PICTURE_MAX, (r.width - 80) / pic.box.w, (r.height - 80) / pic.box.h);
      pic.svg.setAttribute('width', Math.max(1, pic.box.w * k));
      pic.svg.setAttribute('height', Math.max(1, pic.box.h * k));
      const holder = el('div.intro-pic', { style: { left: cx + 'px', top: cy + 'px' } }, pic.svg);
      holder.dataset.center = 'yes';
      layer.appendChild(holder);
      layers.push(holder);
    }
    if (graphSvg) graphSvg.style.transformOrigin = `${cx - r.left}px ${cy - r.top}px`;
    layers.push(graphSvg);

    // The title flies into the top bar and turns into its title there, while
    // the top bar and the graph's tools fade in.
    const line = title.querySelector('.intro-line');
    if (brandText && line && !reduced && typeof line.animate === 'function') {
      const from = line.getBoundingClientRect();
      const to = brandText.getBoundingClientRect();
      const fromSize = parseFloat(getComputedStyle(line).fontSize) || 1;
      const toSize = parseFloat(getComputedStyle(brandText).fontSize) || fromSize;
      const s = toSize / fromSize;
      const dx = to.left - from.left;
      const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
      line.style.transformOrigin = '0 50%';
      line.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }],
        { duration: step, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'forwards' });
      line.animate([{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }],
        { duration: step, fill: 'forwards' });
    } else if (line) {
      line.style.transition = `opacity ${step / 2}ms ease`;
      line.style.opacity = '0';
    }
    root.classList.add('intro-chrome');
    later(() => root.classList.add('intro-landed'), step * 0.7);

    const count = layers.length;
    const z0 = performance.now();
    const frame = (now) => {
      if (left) return;
      const p = zoomProgress((now - z0) / step, count - 1);
      const at = zoomLayers(p, count, zoom);
      for (let i = 0; i < count; i += 1) {
        const node = layers[i];
        if (!node) continue;
        const centred = node.dataset && node.dataset.center ? 'translate(-50%, -50%) ' : '';
        node.style.transform = `${centred}scale(${at[i].scale})`;
        node.style.opacity = String(at[i].opacity);
        node.style.visibility = at[i].opacity > 0 ? 'visible' : 'hidden';
      }
      backdrop.style.opacity = String(Math.max(0, 1 - p));
      if (p >= count - 1) finish();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // The last frame is the page as it is without the intro, so it can go at once.
  function finish() {
    if (left) return;
    end();
    remove(layer, title, skip);
  }

  // A reader who has seen enough: the intro fades out over whatever is there.
  function leave() {
    if (left) return;
    end();
    for (const n of [layer, title, skip]) n.classList.add('leaving');
    setTimeout(() => remove(layer, title, skip), 320);
  }

  function end() {
    left = true;
    for (const t of timers) clearTimeout(t);
    clearTimeout(giveUp);
    document.removeEventListener('graphdrawn', onDrawn);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', leave);
    const graphSvg = document.querySelector('.graph-stage > svg');
    if (graphSvg) for (const k of ['transform', 'transformOrigin', 'opacity', 'visibility']) graphSvg.style[k] = '';
    root.classList.remove('intro-playing', 'intro-chrome', 'intro-landed');
    root.style.removeProperty('--intro-step');
  }

  function remove(...nodes) {
    for (const n of nodes) if (n.parentNode) n.parentNode.removeChild(n);
  }

  function onKey(ev) {
    if (ev.key !== 'Escape' && ev.key !== 'Enter' && ev.key !== ' ') return;
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    leave();
  }
  layer.addEventListener('click', leave);
  title.addEventListener('click', leave);
  skip.addEventListener('click', leave);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', leave);

  return {
    layer,
    leave,
    loaded() {
      if (!left && !started && !giveUp) giveUp = setTimeout(leave, WAIT_MS);
    },
  };
}
