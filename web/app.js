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
 *   3. `[slug]` -> a cross reference ("Definition 1.2.1") linking to the
 *      object page
 * `known` is a Set of existing ids; unknown slugs get a `broken` class.
 * `refs` says how a reference reads and where it leads (see `linkifySlugs`);
 * left out, it is `pageReferences`, the numbering of the active collapse
 * order with links to object pages.
 */
export function renderBody(target, text, known, refs, { untrusted = false } = {}) {
  clear(target);
  const src = typeof text === 'string' ? text : '';
  if (!src.trim()) {
    target.appendChild(el('p.muted.small', 'No prose.'));
    return target;
  }
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      const { text, restore } = shieldMath(src);
      const html = restore(window.marked.parse(text, { gfm: true, breaks: false }));
      if (untrusted) setSanitizedHtml(target, html);
      else target.innerHTML = html;
    } catch (e) {
      target.innerHTML = '<pre>' + escapeHtml(src) + '</pre>';
    }
  } else {
    target.innerHTML = '<pre>' + escapeHtml(src) + '</pre>';
  }
  renderMath(target);
  linkifySlugs(target, known, refs === undefined ? pageReferences : refs);
  if (!untrusted) foldProofs(target);
  return target;
}

// ---------------------------------------------------------------------------
// untrusted markdown (comments)
// ---------------------------------------------------------------------------

// What a comment may contain once marked has turned it into HTML: the tags
// markdown itself produces, and of the attributes only a link's address.
// Everything else (scripts, styles, event handlers, images, iframes) goes.
const SAFE_TAGS = new Set(['P', 'BR', 'HR', 'EM', 'STRONG', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN']);

/**
 * Put `html` into `target` keeping only `SAFE_TAGS`.  The HTML is parsed in an
 * inert document, where nothing loads and no handler runs, and only what
 * survives is moved over.  Without a DOMParser the source is shown as text.
 */
function setSanitizedHtml(target, html) {
  if (typeof DOMParser !== 'function') {
    target.textContent = html.replace(/<[^>]*>/g, '');
    return;
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const clean = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1 || !SAFE_TAGS.has(c.tagName)) {
        // An unknown element keeps its text, never its markup.
        if (c.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(c.tagName)) {
          node.replaceChild(doc.createTextNode(c.textContent), c);
        } else {
          node.removeChild(c);
        }
        continue;
      }
      for (const a of [...c.attributes]) {
        const keep = c.tagName === 'A' && a.name === 'href' && /^(https?:|#|\/|\.)/i.test(a.value.trim());
        if (!keep) c.removeAttribute(a.name);
      }
      if (c.tagName === 'A') c.setAttribute('rel', 'nofollow noopener');
      clean(c);
    }
  };
  clean(doc.body);
  clear(target);
  for (const c of [...doc.body.childNodes]) target.appendChild(document.importNode(c, true));
}

// ---------------------------------------------------------------------------
// folding proofs
// ---------------------------------------------------------------------------

// A body's `## Proof` heading and everything after it, up to the next heading
// of the same level or above, becomes a disclosure: the heading is its
// summary, so a click on "Proof." folds or unfolds that one proof.  Whether
// proofs start folded is the reader's choice, kept in localStorage and offered
// by `proofToggle` on the pages that show proofs.
const PROOFS_KEY = 'blueprint.proofs';
let proofsFolded = readProofsFolded();

function readProofsFolded() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PROOFS_KEY) === 'folded';
  } catch (e) {
    return false;
  }
}

function isProofHeading(node) {
  if (!node || node.nodeType !== 1 || !/^H[1-6]$/.test(node.tagName)) return false;
  return /^proof\b/i.test(String(node.textContent || '').trim());
}

/** Wrap every proof among the top-level blocks of a rendered body. */
export function foldProofs(target) {
  const blocks = [...target.childNodes];
  for (let i = 0; i < blocks.length; i += 1) {
    const h = blocks[i];
    if (!isProofHeading(h)) continue;
    const level = Number(h.tagName[1]);
    const body = el('div.proof-body');
    let j = i + 1;
    for (; j < blocks.length; j += 1) {
      const n = blocks[j];
      if (n.nodeType === 1 && /^H[1-6]$/.test(n.tagName) && Number(n.tagName[1]) <= level) break;
      body.appendChild(n);
    }
    const details = el('details.proof', { open: !proofsFolded });
    target.insertBefore(details, h);
    details.appendChild(el('summary.proof-head', h));
    details.appendChild(body);
    i = j - 1;
  }
  return target;
}

/** Fold or unfold every proof, now and on every page from here on. */
export function setProofsFolded(folded) {
  proofsFolded = !!folded;
  try { localStorage.setItem(PROOFS_KEY, proofsFolded ? 'folded' : 'shown'); } catch (e) { /* private mode */ }
  for (const d of document.querySelectorAll('details.proof')) d.open = !proofsFolded;
  for (const b of document.querySelectorAll('button.proof-toggle')) setToggleLabel(b);
}

function setToggleLabel(button) {
  button.textContent = proofsFolded ? 'Unfold proofs' : 'Fold proofs';
  button.setAttribute('aria-pressed', proofsFolded ? 'true' : 'false');
  button.title = proofsFolded
    ? 'Show every proof on the site; a single proof opens with a click on its heading'
    : 'Hide every proof on the site, leaving the statements';
}

/** The button that folds and unfolds every proof. */
export function proofToggle() {
  const b = el('button.proof-toggle', { type: 'button', onclick: () => setProofsFolded(!proofsFolded) });
  setToggleLabel(b);
  return b;
}

/**
 * Cross references outside the document view — object pages, the graph's side
 * panel — read as the document numbers them, along the collapse order the
 * route has chosen (the graph's `collapse=`) or else the default one, so the
 * number a reader sees is the one they will find in the document.  They still
 * lead to the object page: that is the page these views link objects to, and
 * the document is one click further on from there.
 */
function pageReferences(slug) {
  const m = app.model;
  if (!m) return null;
  const wanted = app.route && app.route.params.get('collapse');
  const kind = wanted && m.kinds[wanted] && m.kinds[wanted].collapse
    ? wanted
    : m.defaultCollapse || m.collapseKinds[0];
  if (!kind) return null;
  const ref = model.referenceOf(model.documentOutline(m, kind), slug);
  return ref && { ...ref, href: objectHref(slug) };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The words prose names a reference with, besides the schema's own kind words:
// a blueprint imported from LaTeX says "Thm [x]" and "Proposition [x]" whatever
// the kind of `x` turned out to be, and "Thm Theorem 2.3" or "Theorem Section
// 2.3" is worse than letting the author's word stand, which is what
// `Theorem~\ref{…}` gave in the paper.
const REFERENCE_WORDS = [
  'theorem', 'thm', 'lemma', 'lem', 'proposition', 'prop', 'corollary', 'cor',
  'definition', 'def', 'defn', 'remark', 'rem', 'example', 'exercise',
  'construction', 'conjecture', 'claim', 'notation', 'observation',
  'assumption', 'hypothesis', 'axiom', 'section', 'sec', 'chapter', 'chap',
  'appendix', 'equation', 'eq',
];

// One pattern per snapshot: "<word>[s][.] " at the end of the text before the
// reference, the word whole (`\p{L}`, so "dilemma [x]" does not count).
let namingFor = null;
let namingRe = null;

function namesReference(before) {
  const m = app.model;
  if (namingFor !== m) {
    const words = new Set(REFERENCE_WORDS);
    for (const k of Object.keys((m && m.kinds) || {})) words.add(model.kindWord(k).toLowerCase());
    const alt = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    namingRe = new RegExp('(?:^|[^\\p{L}])(?:' + alt + ')s?\\.?\\s+$', 'iu');
    namingFor = m;
  }
  return namingRe.test(before);
}

/**
 * Markdown and TeX disagree about `_`, `*`, `\` and blank lines: marked turns
 * `\varpi_E^n` into emphasis and a display formula into two paragraphs
 * before KaTeX ever sees them.  So every maths span is lifted out first and
 * put back, HTML-escaped, after marked has run.  Recognised, in this order:
 * `$$…$$`, `\[…\]`, `\(…\)`, `$…$`; fenced and inline code are left
 * to marked. Inline formulas may wrap across source lines and start with
 * digits (e.g. `$0=[0]$`), just as they may in KaTeX auto-render.
 */
const MATH_RE = /(```[\s\S]*?```|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)(?:[^$\\]|\\[\s\S])+?\$)/g;

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
/**
 * LaTeX commands the corpora use that KaTeX lacks, defined as macros so the
 * project's own macro files can keep them. A project's declaration of the
 * same name wins. `\ensuremath` is the identity because auto-render only ever
 * hands KaTeX maths.
 */
const COMPAT_MACROS = {
  '\\ensuremath': '#1',
  // `\lhook\joinrel\longrightarrow` is how LaTeX spells a long hook arrow.
  // KaTeX has no bare hook glyph, so the macro looks ahead, consumes the
  // rest of the idiom and produces the extensible hook arrow stretched to
  // the length of `\longrightarrow`; a bare `\lhook` is a plain hook arrow.
  '\\lhook': (ctx) => {
    const t1 = ctx.future();
    if (!t1 || t1.text !== '\\joinrel') return '\\hookrightarrow';
    ctx.popToken();
    const t2 = ctx.future();
    if (t2 && t2.text === '\\longrightarrow') { ctx.popToken(); return '\\xhookrightarrow{\\hphantom{xx}}'; }
    if (t2 && t2.text === '\\rightarrow') { ctx.popToken(); return '\\hookrightarrow'; }
    return '\\hookrightarrow';
  },
  '\\joinrel': '\\mathrel{}',
  '\\bm': '\\boldsymbol{#1}',
  '\\mathbbm': '\\mathbb{#1}',
};

export function katexOptions() {
  return {
    delimiters: KATEX_DELIMS,
    macros: Object.assign({}, COMPAT_MACROS, katexMacros),
    throwOnError: false,
    // `\mathrm{ét}` is fine to render; KaTeX only warns that real LaTeX
    // would want \text for the accent. Everything else strict still warns.
    strict: (code) => (code === 'unicodeTextInMathMode' ? 'ignore' : 'warn'),
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

/**
 * Replace `[slug]` in text nodes by links, skipping code and maths.
 *
 * A reference reads the way a paper's does, "Definition 1.2.1": `refs(slug)`
 * returns `{word, number, href}` for an object the document numbers, and
 * `null` for one it does not, which keeps its slug as the link text.  When the
 * prose already says the word ("by Lemma [lem-x]"), or any word a reference is
 * named with ("Thm [x]", "Props. [x]", any kind of the schema), only the number
 * is added, so it does not read "Lemma Lemma 2.3" or "Thm Theorem 2.3".  The slug is the link's tooltip
 * either way, and an unknown slug is a broken link exactly as before.  Without
 * `refs` every link text is the slug.  Explicit link text, `[text](…)`, is
 * markdown's and never reaches this pass.
 */
export function linkifySlugs(root, known, refs) {
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
      const ref = ok && refs ? refs(slug) : null;
      let label = slug;
      if (ref) {
        // "Lemma [x]" and "Thm [x]" already have their word.
        const said = new RegExp('(?:^|[^\\p{L}])' + escapeRegExp(ref.word) + '\\s+$', 'iu');
        const before = text.slice(0, m.index);
        label = said.test(before) || namesReference(before) ? ref.number : ref.word + ' ' + ref.number;
      }
      frag.appendChild(
        el(
          'a',
          {
            class: 'objlink' + (ok ? '' : ' broken') + (ref ? ' ref' : ''),
            href: ok ? (ref && ref.href) || objectHref(slug) : '#/checks?code=bad-link',
            title: ok ? slug : `${slug} does not resolve to an object`,
            'data-ref': ref ? slug : null,
          },
          label,
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
  if (p.mix) {
    // One segment per status, as the progress page's status mix.
    const parts = model.STATUS_BAR_ORDER.filter((s) => p.mix[s]);
    const title = `${p.proved} of ${p.total} proved\n` +
      parts.map((s) => `${model.STATUS_LABEL[s]}: ${p.mix[s]}`).join('\n');
    return el('span.bar-row', { style: opts.style || {} },
      el('span.bar.mix', { title }, ...parts.map((s) => el('span', {
        style: { width: (100 * p.mix[s]) / p.total + '%', background: `var(--st-${s})` },
      }))),
      el('span.num', `${p.proved}/${p.total}`));
  }
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
  proofToggle,
  katexOptions,
  linkifySlugs,
  objLink,
  objectHref,
  statusBadge,
  kindBadge,
  levelBadge,
  progressBar,
  objectHeadBadges,

  /**
   * Navigate to a route.  `replace` swaps the current history entry instead of
   * pushing one, for a page that redirects an old-style link to where it now
   * lives: Back must not land on the link again and be redirected again.
   */
  go(view, id, params, { replace = false } = {}) {
    const hash = buildHash(view, id, params);
    if (replace) {
      history.replaceState(null, '', hash);
      render();
    } else {
      location.hash = hash;
    }
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

// ---------------------------------------------------------------------------
// the search box in the top bar
// ---------------------------------------------------------------------------

// It finds any object of the blueprint by id, title, Lean name or body and
// goes to its page.  The matcher is `model.search`, the one the graph's
// highlight and the progress listing use too, over the index it builds once
// per snapshot; what is left per keystroke is one pass over that index, a few
// milliseconds on a real blueprint, after a short debounce.
//
// Bare sugar edges are left out: every `uses/a/b` id matches whatever `a`
// matches, and a real blueprint has several per statement, so they would push
// the statements themselves off the list.  An edge with a title or prose of
// its own is something to find, sugar or not, and is kept.
const GLOBAL_RESULTS = 12;
const GLOBAL_DEBOUNCE_MS = 100;

const gsearch = { input: null, panel: null, list: null, foot: null, timer: null, hits: [], active: -1 };

function setupGlobalSearch() {
  const input = document.getElementById('gsearch-input');
  const panel = document.getElementById('gsearch-panel');
  const list = document.getElementById('gsearch-results');
  const foot = document.getElementById('gsearch-foot');
  if (!input || !panel || !list || !foot) return;
  Object.assign(gsearch, { input, panel, list, foot });

  input.addEventListener('input', () => {
    clearTimeout(gsearch.timer);
    gsearch.timer = setTimeout(runGlobalSearch, GLOBAL_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', onGlobalSearchKey);
  input.addEventListener('focus', () => { if (input.value.trim()) runGlobalSearch(); });
  input.addEventListener('blur', () => closeGlobalSearch());
  // Keep the focus in the box while a result is clicked: a blur on mousedown
  // would close the list before the click arrived.
  panel.addEventListener('mousedown', (ev) => ev.preventDefault());

  // `/` from anywhere that is not itself taking text.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented) return;
    if (takesText(ev.target)) return;
    ev.preventDefault();
    input.focus();
    if (typeof input.select === 'function') input.select();
  });
}

// A focused checkbox or slider does not take a `/` (the graph's filters keep
// the focus after a click), so only the kinds of input that do are excluded.
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

function takesText(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.tagName === 'INPUT') return !NON_TEXT_INPUTS.has(String(node.type || 'text').toLowerCase());
  return node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || !!node.isContentEditable;
}

/** Search for what is in the box now and show the list. Exported for tests. */
export function runGlobalSearch() {
  clearTimeout(gsearch.timer);
  gsearch.timer = null;
  const m = app.model;
  const q = gsearch.input ? gsearch.input.value : '';
  if (!m || !q.trim()) { closeGlobalSearch(); return; }
  const accept = (o) => !(m.kinds[o.kind] && m.kinds[o.kind].sugar)
    || !!(o.attrs.title || o.body.trim());
  const hits = model.search(m, q, Infinity, { accept });
  gsearch.hits = hits.slice(0, GLOBAL_RESULTS).map((h) => h.object);
  gsearch.active = gsearch.hits.length ? 0 : -1;
  drawGlobalResults(q.trim().toLowerCase(), hits.length);
}

function drawGlobalResults(q, total) {
  const { input, panel, list, foot } = gsearch;
  const m = app.model;
  clear(list);
  gsearch.hits.forEach((o, i) => {
    const st = model.statusOf(m, o.id);
    // Say which Lean name matched when that is why the object is listed: the
    // title alone would not show it.
    const lean = model.leanNamesOf(o).find((n) => n.toLowerCase().includes(q));
    list.appendChild(el('a.gsearch-item', {
      id: 'gsearch-opt-' + i, role: 'option', href: objectHref(o.id),
      'aria-selected': 'false',
      onmousemove: () => { if (gsearch.active !== i) setGlobalActive(i); },
      onclick: (ev) => {
        // A modified click opens a tab and leaves this one as it is.
        if (ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        goToResult(i);
      },
    },
    el('span.gsearch-title', model.titleOf(o)),
    el('span.gsearch-meta',
      kindBadge(o.kind),
      st === null ? null : statusBadge(st),
      el('span.gsearch-id', o.id),
      lean ? el('span.gsearch-lean', lean) : null)));
  });
  const shown = gsearch.hits.length;
  foot.textContent = !total ? 'No object matches.'
    : total > shown ? `${shown} of ${total} matches; keep typing to narrow them down.`
      : `${total} ${total === 1 ? 'match' : 'matches'}.`;
  panel.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  setGlobalActive(gsearch.active);
  renderMath(list); // titles carry maths
}

function setGlobalActive(i) {
  gsearch.active = i;
  const items = gsearch.list.querySelectorAll('.gsearch-item');
  items.forEach((a, k) => {
    a.classList.toggle('active', k === i);
    a.setAttribute('aria-selected', k === i ? 'true' : 'false');
  });
  if (i >= 0 && items[i]) {
    gsearch.input.setAttribute('aria-activedescendant', items[i].id);
    if (typeof items[i].scrollIntoView === 'function') items[i].scrollIntoView({ block: 'nearest' });
  } else {
    gsearch.input.removeAttribute('aria-activedescendant');
  }
}

function closeGlobalSearch() {
  if (!gsearch.panel) return;
  clearTimeout(gsearch.timer);
  gsearch.timer = null;
  gsearch.panel.hidden = true;
  gsearch.input.setAttribute('aria-expanded', 'false');
  gsearch.input.removeAttribute('aria-activedescendant');
}

function goToResult(i) {
  const o = gsearch.hits[i];
  if (!o) return;
  gsearch.input.value = '';
  closeGlobalSearch();
  gsearch.input.blur();
  location.hash = objectHref(o.id);
}

function onGlobalSearchKey(ev) {
  const open = !gsearch.panel.hidden;
  const n = gsearch.hits.length;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!open || gsearch.timer) { runGlobalSearch(); return; }
    if (!n) return;
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    setGlobalActive((gsearch.active + step + n) % n);
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    // Enter straight after typing must not act on the list from before the
    // last keystrokes: search now, then go.
    if (!open || gsearch.timer) runGlobalSearch();
    goToResult(gsearch.active);
  } else if (ev.key === 'Escape') {
    // Close the list first; a second Escape gives the keyboard back to the page.
    ev.preventDefault();
    if (open) closeGlobalSearch();
    else gsearch.input.blur();
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

// The page the reader was last on, so that moving to a *different* one starts
// at the top.  Without this, leaving a document scrolled 30,000px down and
// clicking "Progress" landed a third of the way down the progress page, which
// is neither where the reader asked to be nor anywhere obvious.  Changes that
// only rewrite the query of the page you are already on — the graph's
// selection, a checks filter, `?focus=` — leave the scroll position alone, and
// a page that scrolls somewhere itself still wins, because it does so from
// `render` below and in the frame after it.
let lastPageKey = null;

function render() {
  app.route = parseHash();
  closeGlobalSearch(); // back, forward, a link: the list is about the page left behind
  updateTabs(app.route.view);
  const pageKey = app.route.view + ' ' + (app.route.id || '');
  if (pageKey !== lastPageKey) {
    lastPageKey = pageKey;
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }
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
  setupGlobalSearch();
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
