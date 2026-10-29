// intro.js — what the site shows in the middle of the screen as it opens.
//
// A project may give its website an introduction, `[site.intro]` in
// blueprint.toml, which reaches the snapshot as `project.intro`:
//
//   "intro": { "body": "…Markdown…", "durationMs": 3000 }
//
// The body is rendered as any object's prose is (`renderBody`), so it may carry
// maths, `[slug]` references, pictures (`![…](assets/logo.png)`) and HTML of
// its own (a `<video>`, an `<svg>`, an `<iframe>`).  A relative address in it
// is resolved against the directory holding blueprint.json, which is where
// `blueprint site` puts the project's `[site] assets` as `assets/`.
//
// It is drawn as one node in the middle of an empty screen, while the graph is
// laid out behind it.  After `durationMs` (default `DEFAULT_MS`) it fades and
// shrinks away, leaving the graph.  A click, Escape, Enter or Space ends it at
// once; a link in it is still followed.
//
// Only on the way in: when the site is opened at its landing page, the bare
// graph.  A link to anything else (an object, the document, a graph with a
// selection) is something the reader asked for and opens straight on it, and
// `?intro=0` in the page's URL leaves the intro out anywhere.

export const DEFAULT_MS = 3000;
export const FADE_MS = 700; // the `.intro.leaving` transition in style.css

/** The project's intro as `{body, durationMs}`, or null when it has none. */
export function introOf(project) {
  const i = project && project.intro;
  if (!i || typeof i !== 'object' || typeof i.body !== 'string' || !i.body.trim()) return null;
  const ms = Number(i.durationMs);
  return { body: i.body, durationMs: Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_MS };
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
export function showIntro(app, { host = document.body } = {}) {
  const intro = introOf(app.model && app.model.project);
  if (!intro || !host) return null;
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
  return { layer, leave };
}
