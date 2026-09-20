// app.js — data loading, hash routing and the helpers shared by the views.
//
// Everything DOM-ish that more than one page needs lives here and is handed to
// the page modules in the `app` context object, so the page modules never have
// to import each other.

import * as model from './model.js';
import * as graphPage from './graph.js';
import * as objectPage from './object.js';
import * as documentPage from './document.js';
import * as progressPage from './progress.js';
import * as checksPage from './checks.js';

const PAGES = {
  graph: graphPage,
  object: objectPage,
  document: documentPage,
  progress: progressPage,
  checks: checksPage,
};

const DEFAULT_DATA = './blueprint.json';
const SAMPLE_DATA = './sample/blueprint.json';

// ---------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------

/**
 * el('div.foo#bar', {attrs}, children...) -> HTMLElement
 * Children may be nodes, strings, arrays, null or false.
 */
export function el(spec, attrs, ...children) {
  let tag = 'div';
  const classes = [];
  let id = null;
  const m = String(spec).match(/^([a-zA-Z0-9-]*)((?:[.#][^.#]+)*)$/);
  if (m) {
    if (m[1]) tag = m[1];
    for (const part of m[2].match(/[.#][^.#]+/g) || []) {
      if (part[0] === '.') classes.push(part.slice(1));
      else id = part.slice(1);
    }
  } else {
    tag = spec;
  }
  const node = document.createElement(tag);
  if (classes.length) node.className = classes.join(' ');
  if (id) node.id = id;
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = node.className ? node.className + ' ' + v : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(node, c);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

export function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  // A string, node or array in the attributes slot is the first child, as in
  // `el`. Without this, `svgEl('title', text)` walks the string's characters
  // as attributes named 0, 1, 2, …, which browsers before the 2025 DOM name
  // relaxation reject with an InvalidCharacterError.
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// markdown + KaTeX
// ---------------------------------------------------------------------------

// Both the TeX-ish and the LaTeX-ish delimiters, display forms first so that
// `$$` is not mistaken for two empty inline formulas.
const KATEX_DELIMS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '$', right: '$', display: false },
  { left: '\\(', right: '\\)', display: false },
];

// `project.katexMacros` from the snapshot: macro name (with its backslash) to
// KaTeX definition, for instance {"\\Fbar": "\\overline{\\mathbf F}_q"}.  A
// copy is kept per loaded snapshot rather than the snapshot's own object,
// because KaTeX rewrites the values it is given into its internal form.
//
// A plain object, never `Object.create(null)`: KaTeX's macro expander calls
// `hasOwnProperty` on the object it is handed, and a prototype-less one made
// every render on the site throw (silently, inside `renderMath`) the moment a
// snapshot declared macros at all.
let katexMacros = {};

function setKatexMacros(project) {
  const declared = project && project.katexMacros;
  katexMacros = declared && typeof declared === 'object' && !Array.isArray(declared)
    ? Object.assign({}, declared)
    : {};
}

const SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE', 'TEXTAREA']);
const SLUG_PATTERN = '\\[([A-Za-z0-9][A-Za-z0-9._~/-]*)\\](?!\\()';
const SLUG_RE = new RegExp(SLUG_PATTERN, 'g');
// A separate non-global copy: `test` on a /g/ regex advances lastIndex and
// would then miss matches in the next string it is asked about.
const SLUG_TEST = new RegExp(SLUG_PATTERN);

/**
 * Render a markdown body into `target`:
 *   1. marked -> HTML
 *   2. KaTeX auto-render (so maths is out of the way)
 *   3. `[slug]` -> link to the object page
 * `known` is a Set of existing ids; unknown slugs get a `broken` class.
 */
export function renderBody(target, text, known) {
  clear(target);
  const src = typeof text === 'string' ? text : '';
  if (!src.trim()) {
    target.appendChild(el('p.muted.small', 'No prose.'));
    return target;
  }
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      const { text, restore } = shieldMath(src);
      target.innerHTML = restore(window.marked.parse(text, { gfm: true, breaks: false }));
    } catch (e) {
      target.innerHTML = '<pre>' + escapeHtml(src) + '</pre>';
    }
  } else {
    target.innerHTML = '<pre>' + escapeHtml(src) + '</pre>';
  }
  renderMath(target);
  linkifySlugs(target, known);
  return target;
}

/**
 * Markdown and TeX disagree about `_`, `*`, `\` and blank lines: marked turns
 * `\varpi_E^n` into emphasis and a display formula into two paragraphs
 * before KaTeX ever sees them.  So every maths span is lifted out first and
 * put back, HTML-escaped, after marked has run.  Recognised, in this order:
 * `$$…$$`, `\[…\]`, `\(…\)`, `$…$` (no newline inside, not followed by a
 * digit, so prices survive); fenced and inline code are left to marked.
 */
const MATH_RE = /(```[\s\S]*?```|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s|\d)(?:[^$\n\\]|\\.)+?\$)/g;

export function shieldMath(src) {
  const spans = [];
  const text = src.replace(MATH_RE, (whole, code, math) => {
    if (code !== undefined) return whole;
    spans.push(math);
    // A token marked leaves alone: no markdown characters, no letters it
    // could join to a word.
    return `⁣MATH${spans.length - 1}⁣`;
  });
  const restore = (html) =>
    html.replace(/⁣MATH(\d+)⁣/g, (_, i) => escapeHtml(spans[Number(i)]));
  return { text, restore };
}

/**
 * The options every call to KaTeX auto-render gets, anywhere on the site.
 * Exported so the tests can look at them without a browser.
 *
 * `throwOnError: false` plus `errorCallback` is what keeps one broken formula
 * from taking a page with it: KaTeX leaves that formula as red source text and
 * carries on with the rest of the element.
 */
export function katexOptions() {
  return {
    delimiters: KATEX_DELIMS,
    macros: katexMacros,
    throwOnError: false,
    errorCallback: (msg) => {
      // A formula the project's macros do not cover is a blueprint bug, not a
      // site bug: say so once in the console and leave the source on the page.
      if (typeof console !== 'undefined' && console.warn) console.warn('KaTeX:', msg);
    },
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
  };
}

export function renderMath(root) {
  if (typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(root, katexOptions());
  } catch (e) {
    // The raw text stays on the page, but a failure here is a site bug and
    // must not be silent: it once hid every formula on every page.
    if (typeof console !== 'undefined' && console.error) console.error('KaTeX auto-render failed:', e);
  }
}

/** Replace `[slug]` in text nodes by object links, skipping code and maths. */
export function linkifySlugs(root, known) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
        if (p.nodeType !== 1) continue;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.classList && (p.classList.contains('katex') || p.classList.contains('katex-display'))) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return SLUG_TEST.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  for (const node of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    SLUG_RE.lastIndex = 0;
    let m;
    while ((m = SLUG_RE.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const slug = m[1];
      const ok = !known || known.has(slug);
      frag.appendChild(
        el(
          'a',
          {
            class: 'objlink' + (ok ? '' : ' broken'),
            href: ok ? objectHref(slug) : '#/checks?code=bad-link',
            title: ok ? slug : `${slug} does not resolve to an object`,
          },
          slug,
        ),
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// ---------------------------------------------------------------------------
// shared bits of UI
// ---------------------------------------------------------------------------

export function objectHref(id, params) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return '#/object/' + encodeURIComponent(id) + q;
}

export function objLink(m, id, extra) {
  const o = m.byId.get(id);
  if (!o) return el('span.muted', { title: 'unknown object' }, id);
  return el('a.objlink', { href: objectHref(id), title: id }, model.titleOf(o), extra);
}

export function statusBadge(status, opts = {}) {
  const s = status || 'none';
  const label = status ? model.STATUS_LABEL[status] || status : opts.noneLabel || 'no Lean ref';
  return el('span', { class: 'badge status-' + s, title: 'derived status: ' + label },
    el('span.dot'), label);
}

export function kindBadge(kind) {
  return el('span.badge.kind', kind);
}

export function levelBadge(level) {
  return el('span', { class: 'badge level-' + level }, level);
}

export function progressBar(p, opts = {}) {
  if (!p || !p.total) return el('span.muted.small', '—');
  const pct = Math.round((100 * p.proved) / p.total);
  return el('span.bar-row', { style: opts.style || {} },
    el('span.bar', { title: `${p.proved} of ${p.total} proved` }, el('span', { style: { width: pct + '%' } })),
    el('span.num', `${p.proved}/${p.total}`));
}

/** Heading with the standard badges, used by several pages. */
export function objectHeadBadges(m, o) {
  const st = model.statusOf(m, o.id);
  return [kindBadge(o.kind), st === null ? null : statusBadge(st)];
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function parseHash() {
  let h = String(location.hash || '').replace(/^#/, '');
  if (!h || h === '/') h = '/graph';
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const query = qi >= 0 ? h.slice(qi + 1) : '';
  const segs = path.replace(/^\/+/, '').split('/');
  const view = segs[0] || 'graph';
  let id = null;
  if (segs.length > 1) {
    const raw = segs.slice(1).join('/');
    try {
      id = decodeURIComponent(raw);
    } catch (e) {
      id = raw;
    }
  }
  return { view: PAGES[view] ? view : 'graph', id, params: new URLSearchParams(query), raw: h };
}

function buildHash(view, id, params) {
  const q = params ? params.toString() : '';
  return '#/' + view + (id ? '/' + encodeURIComponent(id) : '') + (q ? '?' + q : '');
}

let suppressRoute = 0;

// ---------------------------------------------------------------------------
// the application object handed to every page
// ---------------------------------------------------------------------------

const app = {
  // data
  snapshot: null,
  model: null,
  dataUrl: null,
  baseUrl: null,
  history: null, // {snapshots:[...]} from data/index.json, or null
  viewingSha: null, // non-null while a historical snapshot is displayed

  // routing
  route: null,

  // helpers (re-exported so pages only import ./app.js)
  el,
  svgEl,
  clear,
  renderBody,
  renderMath,
  katexOptions,
  linkifySlugs,
  objLink,
  objectHref,
  statusBadge,
  kindBadge,
  levelBadge,
  progressBar,
  objectHeadBadges,

  /** Navigate to a route. */
  go(view, id, params) {
    location.hash = buildHash(view, id, params);
  },

  /**
   * Update the query part of the current route.
   * `silent` rewrites the URL without re-running the router, for pages that
   * patch their own DOM (the graph does this for selection and hover).
   */
  setParams(updates, { silent = false, replace = true } = {}) {
    const params = new URLSearchParams(app.route.params);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === undefined || v === '') params.delete(k);
      else params.set(k, String(v));
    }
    const hash = buildHash(app.route.view, app.route.id, params);
    if (hash === '#' + app.route.raw) return;
    app.route = { ...app.route, params, raw: hash.slice(1) };
    if (replace) {
      // replaceState does not fire hashchange, so nothing to suppress.
      history.replaceState(null, '', hash);
      if (!silent) render();
    } else {
      if (silent) suppressRoute += 1;
      location.hash = hash; // fires hashchange
    }
  },

  /** Load a different snapshot file (time slider). */
  async showSnapshot(entry) {
    if (!entry) {
      await loadInto(app.dataUrlOriginal, { sha: null });
    } else {
      const url = new URL(entry.file, app.baseUrl).href;
      await loadInto(url, { sha: entry.sha, keepBase: true, entry });
    }
    render();
  },

  /** Known object ids, for `[slug]` link resolution. */
  knownIds() {
    return app.model ? new Set(app.model.byId.keys()) : new Set();
  },
};

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function loadInto(url, { sha = null, keepBase = false, entry = null } = {}) {
  const snapshot = await fetchJson(url);
  if (!snapshot || !Array.isArray(snapshot.objects)) {
    throw new Error(`${url} is not a blueprint snapshot (no "objects" array)`);
  }
  app.snapshot = snapshot;
  app.model = model.buildModel(snapshot);
  setKatexMacros(app.model.project);
  app.dataUrl = url;
  if (!keepBase) app.baseUrl = new URL('.', new URL(url, location.href)).href;
  app.viewingSha = sha;
  app.viewingEntry = entry;
  updateChrome();
}

async function loadHistory() {
  if (!app.baseUrl) return;
  try {
    const idx = await fetchJson(new URL('data/index.json', app.baseUrl).href);
    if (idx && Array.isArray(idx.snapshots) && idx.snapshots.length) {
      idx.snapshots = idx.snapshots
        .slice()
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      app.history = idx;
    } else {
      app.history = null;
    }
  } catch (e) {
    app.history = null; // no history index: the slider stays hidden
  }
}

function dataUrlFromQuery() {
  const q = new URLSearchParams(location.search);
  return q.get('data') || DEFAULT_DATA;
}

// ---------------------------------------------------------------------------
// chrome: title, tabs, banner
// ---------------------------------------------------------------------------

function updateChrome() {
  const title = (app.model && (app.model.project.title || app.model.project.name)) || 'Blueprint';
  document.getElementById('project-title').textContent = title;
  document.title = title;

  const aside = document.getElementById('topbar-aside');
  clear(aside);
  if (app.model) {
    const { counts, total } = model.statusCounts(app.model);
    const pct = total ? Math.round((100 * counts.proved) / total) : 0;
    aside.appendChild(
      el('a.row', { href: '#/progress', title: `${counts.proved} of ${total} countable objects proved` },
        el('span.bar', { style: { width: '70px' } }, el('span', { style: { width: pct + '%' } })),
        el('span.small', `${pct}%`)));
    const errs = app.model.checks.filter((c) => c.level === 'error').length;
    if (errs) {
      aside.appendChild(el('a', { href: '#/checks?level=error' }, levelBadge('error'), ' ' + errs));
    }
  }

  const banner = document.getElementById('banner');
  clear(banner);
  if (app.viewingSha) {
    const e = app.viewingEntry || {};
    banner.hidden = false;
    banner.className = 'banner warn';
    append(banner, [
      el('strong', 'Viewing snapshot ' + String(app.viewingSha).slice(0, 10)),
      el('span.small.muted', e.date ? '· ' + e.date : ''),
      el('button', { onclick: () => app.showSnapshot(null) }, 'Back to current'),
    ]);
  } else {
    banner.hidden = true;
  }
}

function updateTabs(view) {
  for (const a of document.querySelectorAll('#tabs a')) {
    a.classList.toggle('active', a.dataset.view === view || (view === 'object' && a.dataset.view === 'document'));
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const root = document.getElementById('app');

function render() {
  app.route = parseHash();
  updateTabs(app.route.view);
  const page = PAGES[app.route.view] || PAGES.graph;
  try {
    page.render(root, app);
  } catch (e) {
    console.error(e);
    clear(root);
    root.appendChild(
      el('div.error-box',
        el('h1', 'Something went wrong rendering this page'),
        el('div.detail', String((e && e.stack) || e)),
        el('button', { onclick: () => location.reload() }, 'Reload')));
  }
}

function showLoadError(err, url) {
  clear(root);
  const sampleHref = new URL(location.pathname, location.href).href + '?data=' + encodeURIComponent(SAMPLE_DATA);
  root.appendChild(
    el('div.error-box',
      el('h1', 'No blueprint data'),
      el('p', 'The site could not load a snapshot from:'),
      el('div.detail', url),
      el('div.detail', String(err && err.message ? err.message : err)),
      el('p',
        'Serve a ', el('code', 'blueprint.json'),
        ' next to ', el('code', 'index.html'),
        ' (for instance with ', el('code', 'lake exe blueprint build -o web/blueprint.json'),
        '), or point the page at one with ', el('code', '?data=<url>'), '.'),
      el('p', el('a', { href: sampleHref }, 'Load the bundled sample blueprint instead →'))));
  document.getElementById('banner').hidden = true;
}

async function boot() {
  const url = dataUrlFromQuery();
  app.dataUrlOriginal = url;
  try {
    await loadInto(url);
  } catch (err) {
    showLoadError(err, new URL(url, location.href).href);
    return;
  }
  await loadHistory();
  window.addEventListener('hashchange', () => {
    if (suppressRoute > 0) {
      suppressRoute -= 1;
      app.route = parseHash();
      return;
    }
    render();
  });
  render();
}

boot();

export default app;
