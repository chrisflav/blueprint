// graph.js — the quotient graph, laid out with ELK and drawn as hand-made SVG.
//
// The view state (collapse kind, expanded ids, filters, search, selection)
// lives in the URL hash query, so every graph is a shareable link.
//
// Size.  The default view is the fully collapsed one — a handful of chapters —
// and the reader expands into it, so the page normally lays out tens of nodes.
// A reader who asks for "Expand all" on a few-thousand-object blueprint gets
// what they asked for, and that costs seconds of ELK time, so:
//
//   * the graph handed to ELK carries no back-references into the model (see
//     `plainGraph`); the metadata is looked up again by id after layout;
//   * layout runs in a Web Worker built from a Blob URL whose whole program is
//     an `importScripts` of elkjs's own worker half, elk-worker.min.js, and is
//     driven from the page with `new ELK({workerFactory})` out of elk-api.js,
//     elkjs's 9 kB page half, so elkjs's own protocol runs on both sides and
//     the main thread keeps panning, zooming and responding while ELK thinks.
//     None of it is fetched until the graph is shown (`prepare` starts it as
//     soon as this module is in, beside the snapshot).  If the worker cannot
//     be created — a
//     Content-Security-Policy with a `worker-src` that forbids `blob:`, say —
//     or it fails, or it does not answer within a deadline, the layout falls
//     back to the main thread, which fetches the whole of elkjs,
//     elk.bundled.js, only then, and yields to the event loop between phases
//     so the status line is painted before the browser freezes;
//   * the status line says how many nodes are being laid out, and the
//     "Expand all" button says so up front.

import * as M from './model.js';

// ---------------------------------------------------------------------------
// persistent render state (survives route changes within the graph page)
// ---------------------------------------------------------------------------

let ui = null;          // {stage, svg, layer, side, ...} for the mounted page
let elk = null;         // main-thread ELK instance, used only as a fallback
let layoutToken = 0;    // guards against out-of-order async layouts
let prevPos = new Map(); // id -> {x, y} from the previous layout, for transitions
let lastSignature = null;

const NODE_H = 36;           // a leaf with a one-line title
const NODE_H2 = 46;          // ... and a progress bar
const LINE_H = 15;           // each further line of a wrapped title
const JUNCTION_R = 8;
const CHAR_W = 6.9;          // text width per character when nothing can measure it
const LEAF_TEXT_MAX = 220;   // a leaf's title wraps beyond this width
const LEAF_PAD = 26;         // either side of a leaf's title: clears the expander and the kind mark
const TEXT_SLACK = 1.04;     // canvas and SVG disagree on text width by a few per cent
const SECTION_TEXT_MAX = 420; // an expanded section's title wraps beyond this width
const SECTION_PAD_L = 26;    // left of a section's title: the expander
const SECTION_PAD_R = 30;    // right of it: the kind mark
const SECTION_HEAD = 34;     // the band above a section's children, for a one-line title

// Above this many nodes plus edges, layout quality is traded for speed: ELK's
// model-order pass and its full crossing-minimisation thoroughness together
// cost about four times the layout time on a graph of a few hundred nodes, and
// on a graph that large nobody can see the difference.  Below it, the layout is
// exactly what it always was.
const BIG_GRAPH = 120;

// ---------------------------------------------------------------------------
// state <-> URL
// ---------------------------------------------------------------------------

function readState(app) {
  const p = app.route.params;
  const m = app.model;
  const collapse = p.get('collapse') && m.kinds[p.get('collapse')] && m.kinds[p.get('collapse')].collapse
    ? p.get('collapse')
    : m.defaultCollapse || m.collapseKinds[0] || null;
  const split = (k) => (p.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    collapse,
    expand: split('expand'),
    ekinds: p.has('ekinds') ? split('ekinds') : null, // null = all
    // The statuses and progress bars, unless the reader hid the progress; a
    // status filter in the link then waits until they show it again.
    progress: app.showProgress,
    status: app.showProgress && p.has('status') ? split('status') : null, // null = all
    q: p.get('q') || '',
    sel: p.get('sel') || null,
    // Hide arcs implied by a longer path of their kind: on unless turned off,
    // since on a real blueprint those arcs are most of the ink.
    reduce: p.get('reduce') !== '0',
    // Draw a collapsed object's contents' arcs on it as well (DESIGN 3's
    // derived arcs): off unless asked for, so each object shows its own.
    inner: p.get('inner') === '1',
    // Draw the appendices (objects of a kind with `graph = "optional"`): on
    // unless the reader hides them.
    appendix: p.get('appendix') !== '0',
  };
}

/**
 * The model the graph draws (`M.graphModel`): the snapshot without what is
 * never drawn, and without the appendices and everything in them while those
 * are hidden.  Everything about the drawing is computed on it; what an object
 * *is* (its progress, its status) still comes from `app.model`.
 */
function drawnModel(app, st) {
  return M.graphModel(app.model, { hideOptional: !st.appendix });
}

const NONE = '__none__';

/**
 * The URL value for a checkbox filter: absent when everything is on (the
 * default), an explicit sentinel when everything is off — an empty list would
 * be written as "absent" and would wrongly mean "all".
 */
function filterValue(selected, all) {
  if (selected.size === 0) return [NONE];
  if (selected.size === all.length && all.every((x) => selected.has(x))) return null;
  return all.filter((x) => selected.has(x));
}

function writeState(app, patch, opts) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = Array.isArray(v) ? (v.length ? v.join(',') : null) : v;
  }
  app.setParams(out, opts);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function render(root, app) {
  const st = readState(app);
  if (!st.collapse) {
    app.clear(root);
    root.appendChild(app.el('div.error-box', app.el('h1', 'No collapsible kind'),
      app.el('p', 'The schema declares no kind with ', app.el('code', 'collapse = true'),
        ', so there is no view to draw.')));
    return;
  }

  if (!ui || !root.contains(ui.page)) mount(root, app);
  ui.app = app;
  ui.state = st;
  if (ui.legendProgress !== st.progress) {
    const fresh = legend(app, st.progress);
    ui.stage.replaceChild(fresh, ui.legend);
    ui.legend = fresh;
    ui.legendProgress = st.progress;
  }

  renderToolbar(app, st);
  ui.stage.classList.toggle('inner-arcs', st.inner);
  const view = M.makeView(drawnModel(app, st), st.collapse, st.expand);
  const quot = M.quotient(view);
  ui.view = view;
  ui.quot = quot;

  renderSide(app, st, view, quot);
  scheduleLayout(app, st, view, quot);
}

function mount(root, app) {
  const { el } = app;
  app.clear(root);
  const toolbar = el('div.toolbar');
  const stage = el('div.graph-stage');
  const side = el('aside.side');
  const page = el('div.graph-page', toolbar, stage, side);
  root.appendChild(page);

  const svg = app.svgEl('svg', { xmlns: 'http://www.w3.org/2000/svg' });
  svg.appendChild(defs(app));
  const layer = app.svgEl('g', { class: 'glayer' });
  svg.appendChild(layer);
  stage.appendChild(svg);
  stage.appendChild(el('div.graph-status', { id: 'graph-status' }));
  const key = legend(app, app.showProgress);
  stage.appendChild(key);
  // The way back up from the section the reader is in (`applyLevel`).
  const back = el('button.graph-back', {
    type: 'button', hidden: true,
    onpointerdown: (ev) => ev.stopPropagation(), // a press here is no pan
    onclick: () => { if (ui.entered) toggleExpand(app, ui.entered, ui.view); },
  });
  stage.appendChild(back);

  // `folded`: the side panel's listings the reader has opened (see `fold`).
  // `toolbarOpen`, `sideShown`: the reader's choices (`shownPref`).
  ui = { page, toolbar, stage, svg, layer, side, back, transform: { x: 40, y: 40, k: 1 }, fitted: false,
    folded: new Set(), entered: null, legend: key, legendProgress: app.showProgress,
    toolbarOpen: shownPref(TOOLS_KEY), sideShown: shownPref(SIDE_KEY) };
  page.classList.toggle('side-hidden', !ui.sideShown);
  installPanZoom(app);
  prevPos = new Map();
  lastSignature = null;
}

function defs(app) {
  const { svgEl } = app;
  const marker = (id, hollow) =>
    svgEl('marker', {
      id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    }, svgEl('path', {
      d: 'M 0 0.8 L 10 5 L 0 9.2 z',
      class: (hollow ? 'arrowhead hollow' : 'arrowhead') + (id.endsWith('-focus') ? ' focus' : ''),
    }));
  // The `-focus` pair is the accent-coloured head an edge of the selected node
  // switches to, so the arrow matches its highlighted stroke.
  return svgEl('defs', marker('bp-arrow', false), marker('bp-arrow-hollow', true),
    marker('bp-arrow-focus', false), marker('bp-arrow-hollow-focus', true));
}

/** The key to the drawing; the fills say the statuses, so without the progress there are none. */
function legend(app, progress) {
  const { el, svgEl } = app;
  const sample = (...children) => {
    const s = svgEl('svg', { width: 24, height: 10, viewBox: '0 0 24 10', class: 'lgsvg' });
    for (const c of children) s.appendChild(c);
    return s;
  };
  const line = (dash) => svgEl('line', {
    x1: 1, y1: 5, x2: dash === 'hollow' ? 17 : 23, y2: 5,
    stroke: 'currentColor', 'stroke-width': 1.6,
    'stroke-dasharray': dash === 'dashed' ? '4 3' : null,
  });
  const head = (hollow) => svgEl('path', {
    d: 'M 17 2 L 23 5 L 17 8 z',
    fill: hollow ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': 1,
  });
  const swatch = (s, text) =>
    el('div.row', el('span', { class: 'sw status-' + s }), el('span', text));
  const shape = (t, text) => el('div.row', el('span', { class: 'shp ' + t }), el('span', text));
  return el('div.legend',
    el('b', 'shapes'),
    shape('definition', 'definition'),
    shape('statement', 'theorem, proposition, lemma'),
    shape('remark', 'remark'),
    shape('section', 'section'),
    el('b', { style: { marginTop: '.3em' } }, 'lines'),
    el('div.row', sample(line(), head(false)), 'declared + derived'),
    el('div.row', sample(line('hollow'), head(true)), 'declared, unwitnessed'),
    // Only the contents of collapsed objects draw these (`arcs of contents`).
    el('div.row.lg-derived', sample(line('dashed'), head(false)), 'derived, undeclared'),
    progress ? [
      el('b', { style: { marginTop: '.3em' } }, 'fill'),
      swatch('proved', 'proved'),
      swatch('proved_with_axioms', 'extra axioms'),
      swatch('stated', 'stated'),
      swatch('missing', 'missing'),
      swatch('absent', 'absent'),
      swatch('none', 'no Lean ref'),
    ] : null);
}

// ---------------------------------------------------------------------------
// toolbar
// ---------------------------------------------------------------------------

// The graph opens on the graph alone: of the toolbar only Collapse all, the
// search and the zoom, the rest folded behind the Filters button, and no side
// panel beside it.  Whether the reader has unfolded either is theirs to keep,
// in localStorage, as the top bar keeps the progress (app.js).
const TOOLS_KEY = 'blueprint.graph.tools';
const SIDE_KEY = 'blueprint.graph.side';

/** Whether the reader asked for this to be shown: no, unless they did. */
function shownPref(key) {
  try {
    const store = layoutStore();
    return !!store && store.getItem(key) === 'shown';
  } catch (e) {
    return false;
  }
}

function savePref(key, shown) {
  try {
    const store = layoutStore();
    if (store) store.setItem(key, shown ? 'shown' : 'hidden');
  } catch (e) { /* private mode */ }
}

function renderToolbar(app, st) {
  const { el, clear } = app;
  const m = drawnModel(app, st);
  const bar = clear(ui.toolbar);

  // Everything but Collapse all, the search and the zoom folds behind a
  // button (style.css): unfolded, on a wide screen the wrapper is `display:
  // contents` and the toolbar is the one row it always was, and on a phone it
  // is a second row.
  const filtered = !!(st.ekinds || st.status || !st.reduce || !st.appendix);
  bar.classList.toggle('open', !!ui.toolbarOpen);
  const toggle = bar.appendChild(el('button.tb-toggle', {
    type: 'button',
    class: filtered ? 'filtered' : null,
    'aria-expanded': ui.toolbarOpen ? 'true' : 'false',
    title: filtered ? 'some edges, statuses or appendices are filtered out' : null,
    onclick: () => {
      ui.toolbarOpen = !ui.toolbarOpen;
      savePref(TOOLS_KEY, ui.toolbarOpen);
      bar.classList.toggle('open', ui.toolbarOpen);
      toggle.setAttribute('aria-expanded', ui.toolbarOpen ? 'true' : 'false');
    },
  }, 'Filters'));
  bar.appendChild(el('div.group.tb-collapse',
    el('button', { onclick: () => writeState(app, { expand: [] }) }, 'Collapse all')));
  const filters = bar.appendChild(el('div.tb-filters'));

  // collapse kind
  const kindSel = el('select', {
    title: 'collapse kind driving the view',
    onchange: (e) => writeState(app, { collapse: e.target.value, expand: [], sel: null }),
  }, ...m.collapseKinds.map((k) => el('option', { value: k, selected: k === st.collapse }, k)));
  filters.appendChild(el('div.group', el('span.lbl', 'collapse'), kindSel));

  const order = M.collapseOrder(m, st.collapse);
  // Expanding everything is the one action that can put thousands of nodes on
  // screen, so the button says so rather than springing it on the reader.
  const whenExpanded = drawnNodeCount(m);
  const big = whenExpanded >= BIG_GRAPH;
  filters.appendChild(el('div.group',
    el('button', {
      onclick: () => writeState(app, { expand: [...order.expandable] }),
      title: `lay out all ${whenExpanded.toLocaleString()} objects at once`,
    }, big ? `Expand all (${whenExpanded.toLocaleString()})` : 'Expand all')));

  filters.appendChild(el('div.sep'));

  // edge kind filter
  const eks = M.edgeKinds(m).filter((k) => k !== st.collapse);
  const on = st.ekinds ? new Set(st.ekinds) : new Set(eks);
  filters.appendChild(el('div.group', el('span.lbl', 'edges'),
    ...eks.map((k) => el('label.chk',
      el('input', {
        type: 'checkbox', checked: on.has(k),
        onchange: (e) => {
          const next = new Set(on);
          if (e.target.checked) next.add(k); else next.delete(k);
          writeState(app, { ekinds: filterValue(next, eks) });
        },
      }), k))));

  // Transitive reduction of what is drawn (see `buildElk`): a group of its
  // own, since it is not a kind and is off when all the kinds are on.
  filters.appendChild(el('div.group.reduce',
    el('label.chk', { title: 'hide arcs already implied by a longer path of the same kind' },
      el('input', {
        type: 'checkbox', checked: st.reduce,
        onchange: (e) => writeState(app, { reduce: e.target.checked ? null : '0' }),
      }), 'hide implied'),
    el('label.chk', { title: 'also draw, on a collapsed object, the arcs of what is hidden inside it' },
      el('input', {
        type: 'checkbox', checked: st.inner,
        onchange: (e) => writeState(app, { inner: e.target.checked ? '1' : null }),
      }), 'arcs of contents'),
    // Only offered when there is an appendix to hide.
    hasAppendix(app.model)
      ? el('label.chk', { title: 'leave the appendices, and everything in them, out of the graph' },
        el('input', {
          type: 'checkbox', checked: !st.appendix,
          onchange: (e) => writeState(app, { appendix: e.target.checked ? '0' : null }),
        }), 'hide appendix')
      : null));

  // status filter
  if (st.progress) {
    filters.appendChild(el('div.sep'));
    const sOn = st.status ? new Set(st.status) : new Set(M.STATUSES);
    filters.appendChild(el('div.group', el('span.lbl', 'status'),
      ...M.STATUSES.map((s) => el('label.chk', { class: 'st-chip status-' + s, title: M.STATUS_LABEL[s] },
        el('input', {
          type: 'checkbox', checked: sOn.has(s),
          onchange: (e) => {
            const next = new Set(sOn);
            if (e.target.checked) next.add(s); else next.delete(s);
            writeState(app, { status: filterValue(next, M.STATUSES) });
          },
        }), s.replace('proved_with_axioms', 'axioms')))));
  }

  bar.appendChild(el('div.spacer'));

  const search = el('input', {
    type: 'search', placeholder: 'search id, title, body\u2026', value: st.q,
    oninput: (e) => {
      clearTimeout(ui.searchTimer);
      const v = e.target.value;
      ui.searchTimer = setTimeout(() => {
        writeState(app, { q: v || null }, { silent: true });
        ui.state.q = v;
        applyHighlight(app, v);
      }, 160);
    },
  });
  bar.appendChild(el('div.group.tb-search', search));
  bar.appendChild(el('div.group.tb-zoom',
    el('button', { onclick: () => fitToView(app) , title: 'fit the graph into the viewport' }, 'Fit'),
    el('button', { onclick: () => zoomBy(app, 1.25) }, '+'),
    el('button', { onclick: () => zoomBy(app, 1 / 1.25) }, '\u2212')));
  bar.appendChild(sideToggle(app));
}

/** Show or hide the side panel; on a phone it is a sheet of its own and this is not offered. */
function sideToggle(app) {
  const { el } = app;
  const label = () => (ui.sideShown ? 'Hide sidebar' : 'Show sidebar');
  const button = el('button.tb-side', {
    type: 'button',
    'aria-expanded': ui.sideShown ? 'true' : 'false',
    title: 'the details of the selected object, beside the graph',
    onclick: () => {
      ui.sideShown = !ui.sideShown;
      savePref(SIDE_KEY, ui.sideShown);
      // The stage widens or narrows on its right: keep what was in its middle there.
      const before = ui.stage.getBoundingClientRect().width;
      ui.page.classList.toggle('side-hidden', !ui.sideShown);
      const after = ui.stage.getBoundingClientRect().width;
      if (after !== before) {
        ui.transform.x += (after - before) / 2;
        applyTransform(false);
      }
      button.setAttribute('aria-expanded', ui.sideShown ? 'true' : 'false');
      button.textContent = label();
    },
  }, label());
  return button;
}

/** Is there anything the "hide appendix" checkbox would hide? */
function hasAppendix(m) {
  return m.objects.some((o) => M.graphHint(m, o.kind) === 'optional');
}

/** How many nodes the fully expanded view would draw: every object that is
 *  drawn as a box rather than as an arc. */
function drawnNodeCount(m) {
  let n = 0;
  for (const kind of M.nodeKinds(m)) n += M.objectsOfKind(m, kind).length;
  return n;
}

// ---------------------------------------------------------------------------
// ELK graph construction
// ---------------------------------------------------------------------------

// Titles are shown in full: a long one wraps onto more lines and its node grows,
// so the width of the text has to be known before ELK lays anything out.  The
// browser measures it in the labels' own font; without a canvas (the unit
// tests) it is estimated.
let measureCtx; // undefined until first asked, null when there is no canvas
function textWidth(text, section) {
  if (measureCtx === undefined) {
    measureCtx = null;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx && typeof ctx.measureText === 'function') {
        const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
        measureCtx = { ctx, leaf: `550 12px ${family}`, section: `550 12.5px ${family}` };
      }
    } catch (e) { /* no DOM: estimate */ }
  }
  if (!measureCtx) return text.length * CHAR_W * (section ? 12.5 / 12 : 1);
  measureCtx.ctx.font = section ? measureCtx.section : measureCtx.leaf;
  return measureCtx.ctx.measureText(text).width;
}

const wrapped = new Map();
/** `text` broken at spaces into lines no wider than `max`, and the widest line. */
function wrapTitle(text, max, section) {
  const key = (section ? 's' : 'l') + text;
  let out = wrapped.get(key);
  if (out) return out;
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? cur + ' ' + word : word;
    if (cur && textWidth(next, section) > max) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  lines.push(cur); // a single word wider than `max` keeps a line of its own
  out = {
    lines,
    width: Math.ceil(TEXT_SLACK * Math.max(...lines.map((l) => textWidth(l, section)))),
    height: lines.length * LINE_H,
  };
  if (wrapped.size > 20000) wrapped.clear();
  wrapped.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// maths in titles
// ---------------------------------------------------------------------------

// A title such as "$2$-colimit" or "The Picard functor \(\operatorname{Pic}_{X/S}\)"
// is drawn by KaTeX, as HTML inside an SVG <foreignObject>.  The node has to be
// sized before ELK runs, and nothing but the browser knows how wide a formula
// comes out, so `measureMathTitles` renders every such title of the graph into
// one hidden container and reads the sizes back in a single reflow.  Only the
// titles with maths in them take this path — on the Weil blueprint about one in
// seventeen — and each is measured once and cached; the rest keep the canvas
// measurement above.
//
// The lines are broken here too, between words and never inside a formula:
// a title is cut into tokens at the spaces outside its formulas, so "$2$-colimit"
// is one token and "$\mathbf G_m$-torsors over $X$" three.  The drawn line is
// exactly the measured one (`white-space: nowrap`, the same classes), so the
// box the browser fills is the box ELK was told about.
//
// KaTeX's fonts are another matter: nothing asks for them until a formula is
// laid out, and the first measurement on a page is then taken in a fallback
// font.  `mathSettled` notices, waits for the fonts and measures again before
// ELK is asked for anything.
//
// Without KaTeX — the CDN did not answer, or the unit tests, which have no
// layout either — a title is plain text and shows its TeX source.  KaTeX is a
// `defer` script ahead of the `app.js` module in index.html, so by the time a
// graph is drawn it has either arrived or failed; there is no later moment at
// which to re-render.

const MATH_DELIMS = [['$$', '$$'], ['\\[', '\\]'], ['$', '$'], ['\\(', '\\)']];
const MATH_TEST = /\$|\\\(|\\\[/;

function hasMath(text) {
  return MATH_TEST.test(text);
}

/**
 * A title cut into tokens, each a list of parts `{tex}` or `{text}`.  An
 * opening delimiter without its closing one is ordinary text.
 */
export function mathTokens(text) {
  const parts = [];
  let i = 0;
  let plain = '';
  while (i < text.length) {
    let found = null;
    for (const [l, r] of MATH_DELIMS) {
      if (!text.startsWith(l, i)) continue;
      const end = text.indexOf(r, i + l.length);
      if (end > i + l.length) found = { tex: text.slice(i + l.length, end), next: end + r.length };
      break;
    }
    if (found) {
      if (plain) parts.push({ text: plain });
      plain = '';
      parts.push({ tex: found.tex, source: text.slice(i, found.next) });
      i = found.next;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) parts.push({ text: plain });

  // Spaces outside formulas separate tokens; everything else glues together.
  const tokens = [];
  let cur = [];
  const flush = () => { if (cur.length) tokens.push(cur); cur = []; };
  for (const p of parts) {
    if (p.tex !== undefined) { cur.push(p); continue; }
    const words = p.text.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      if (/^\s+$/.test(w)) flush();
      else cur.push({ text: w });
    }
  }
  flush();
  return tokens;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A token as HTML: KaTeX for its formulas, the source where KaTeX gives up. */
function tokenHtml(token, opts) {
  let html = '';
  for (const p of token) {
    if (p.tex === undefined) { html += escapeHtml(p.text); continue; }
    try {
      html += window.katex.renderToString(p.tex, opts);
    } catch (e) {
      // As elsewhere on the site: a formula the project's macros do not cover
      // is the blueprint's bug, so say so once and show the source.
      if (typeof console !== 'undefined' && console.warn) console.warn('KaTeX:', e && e.message ? e.message : e);
      html += escapeHtml(p.source);
    }
  }
  return html;
}

// ('s' | 'l') + title -> {math: true, provisional, lines (as HTML), width, height}
const mathWrapped = new Map();
let mathModel = null;          // the snapshot the cache was filled for (its macros)

/**
 * Measure, in one reflow, every title in `titles` ([text, section] pairs) that
 * has maths in it and is not measured yet, and cache its lines.  A no-op
 * without KaTeX or a document to measure in.
 */
function measureMathTitles(app, titles) {
  if (typeof window === 'undefined' || !window.katex || typeof window.katex.renderToString !== 'function') return;
  if (typeof document === 'undefined' || !document.body) return;
  if (mathModel !== app.model) { mathWrapped.clear(); mathModel = app.model; }
  const todo = new Map();
  for (const [text, section] of titles) {
    const key = (section ? 's' : 'l') + text;
    if (hasMath(text) && !mathWrapped.has(key) && !todo.has(key)) todo.set(key, { text, section });
  }
  if (!todo.size) return;

  const base = typeof app.katexOptions === 'function' ? app.katexOptions() : {};
  const opts = {
    macros: base.macros || {}, strict: base.strict, displayMode: false,
    throwOnError: true, output: 'html',
  };
  // Inside the graph stage when there is one, so the labels' own font applies.
  const host = (ui && ui.stage && ui.stage.isConnected) ? ui.stage : document.body;
  const box = document.createElement('div');
  box.className = 'gmath-measure';
  host.appendChild(box);
  try {
    // Pass 1: every token on its own, to break the lines.
    const jobs = [];
    for (const job of todo.values()) {
      const holder = document.createElement('div');
      holder.className = 'gmath' + (job.section ? ' section' : '');
      job.tokens = mathTokens(job.text).map((t) => tokenHtml(t, opts));
      holder.innerHTML = '<span class="gm-tok">&nbsp;</span>' +
        job.tokens.map((h) => '<span class="gm-tok">' + h + '</span>').join('');
      job.holder = holder;
      box.appendChild(holder);
      jobs.push(job);
    }
    for (const job of jobs) {
      const spans = job.holder.children;
      const w = [];
      for (let i = 0; i < spans.length; i += 1) w.push(spans[i].getBoundingClientRect().width);
      const space = w.shift();
      const max = job.section ? SECTION_TEXT_MAX : LEAF_TEXT_MAX;
      const lines = [];
      let cur = [], curW = 0;
      job.tokens.forEach((h, i) => {
        const next = cur.length ? curW + space + w[i] : w[i];
        if (cur.length && next > max) { lines.push(cur); cur = [h]; curW = w[i]; }
        else { cur.push(h); curW = next; }
      });
      if (cur.length) lines.push(cur);
      job.html = lines.map((l) => l.join(' '));
      job.ok = w.length > 0 && w.every((x) => x > 0);
    }
    // Pass 2: the lines as they will be drawn, for their real width and height.
    for (const job of jobs) {
      job.holder.innerHTML = job.html.map((h) => '<div class="gm-line">' + h + '</div>').join('');
    }
    // Laying these out is what asks for KaTeX's fonts, so the first titles
    // with maths on a page are measured in a fallback font; see `mathSettled`.
    const provisional = fontsLoading();
    for (const job of jobs) {
      const rows = [...job.holder.children].map((r) => r.getBoundingClientRect());
      const width = Math.max(...rows.map((r) => r.width));
      const height = rows.reduce((a, r) => a + r.height, 0);
      // Nothing laid out (a hidden page, a DOM without layout): plain text it is.
      if (!job.ok || !(width > 0) || !(height > 0)) continue;
      mathWrapped.set((job.section ? 's' : 'l') + job.text, {
        math: true,
        provisional,
        lines: job.html,
        width: Math.ceil(TEXT_SLACK * width) + 1,
        height: Math.max(LINE_H * rows.length, Math.ceil(height)),
      });
    }
  } catch (e) {
    // Leave whatever did not make it as plain text rather than break the graph.
    if (typeof console !== 'undefined' && console.warn) console.warn('measuring maths in titles failed:', e);
  } finally {
    box.remove();
  }
  if (mathWrapped.size > 20000) mathWrapped.clear();
}

function fontsLoading() {
  return typeof document !== 'undefined' && !!document.fonts && document.fonts.status === 'loading';
}

const FONT_WAIT_MS = 3000;

/**
 * Measure the titles with maths in them, and if that was done while KaTeX's
 * fonts were still arriving, a promise that waits for them (for at most
 * `FONT_WAIT_MS`) and measures again; `null` when there is nothing to wait
 * for, which is always the case for a graph without maths, so the plain path
 * never yields.  A size measured in the fallback font is a few pixels off,
 * enough for a formula to stick out of its box.
 */
function mathSettled(app, titles) {
  measureMathTitles(app, titles);
  const keys = titles.map(([text, section]) => (section ? 's' : 'l') + text);
  const early = keys.filter((k) => { const w = mathWrapped.get(k); return w && w.provisional; });
  if (!early.length) return null;
  return Promise.race([
    document.fonts.ready,
    new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
  ]).then(() => {
    for (const k of early) mathWrapped.delete(k);
    measureMathTitles(app, titles);
  });
}

/** [title, drawn expanded] of every object the view could draw as a box. */
function boxTitles(m, view) {
  const out = [];
  for (const id of new Set([...view.visible, ...view.expanded])) {
    const o = m.byId.get(id);
    if (o && (o.boundary.length === 0 || view.isExpanded(id))) out.push([M.titleOf(o), view.isExpanded(id)]);
  }
  return out;
}

/** The wrapped title of a node: KaTeX's lines when measured, plain text otherwise. */
function titleWrap(text, section) {
  return mathWrapped.get((section ? 's' : 'l') + text) ||
    wrapTitle(text, section ? SECTION_TEXT_MAX : LEAF_TEXT_MAX, section);
}

/** Size a leaf (or a section with nothing left inside) to its whole title. */
function sizeLeaf(node, expandable, section) {
  const { width, height } = node.bp.wrap;
  const pad = section ? SECTION_PAD_L + SECTION_PAD_R : 2 * LEAF_PAD + (expandable ? 10 : 0);
  const prog = node.bp.prog;
  node.width = Math.max(section ? 120 : 104, width + pad);
  node.height = (section || (prog && prog.total > 1) ? NODE_H2 : NODE_H) + height - LINE_H;
}

/**
 * Turn the quotient into an ELK graph.
 * Visible expanded objects become compound nodes containing their children;
 * leaves are ordinary nodes; grouped binary items become ELK edges; junction
 * items become small nodes with one ELK edge per end.
 */
export function buildElk(app, st, view, quot) {
  const m = view.model;
  const order = view.order;
  const enabledKinds = st.ekinds ? new Set(st.ekinds) : null;
  const enabledStatus = st.status ? new Set(st.status) : null;

  const keepObject = (id) => {
    if (!enabledStatus) return true;
    const s = M.statusOf(m, id);
    return s === null ? true : enabledStatus.has(s);
  };

  // --- containment tree ----------------------------------------------------
  // X is upward closed, so every expanded object's parents are expanded too.
  const containerOf = (id) => {
    for (const p of M.parentsOf(order, id)) if (view.isExpanded(p)) return p;
    return null;
  };

  const nodeIds = new Set();
  for (const id of view.visible) {
    const o = m.byId.get(id);
    if (!o) continue;
    // Visible objects with a boundary are drawn as arcs or junctions, not nodes.
    if (o.boundary.length > 0) continue;
    if (!keepObject(id)) continue;
    nodeIds.add(id);
  }
  for (const id of view.expanded) nodeIds.add(id); // compound containers

  const nodes = new Map(); // id -> elk node
  const mk = (id) => {
    const o = m.byId.get(id);
    const compound = view.isExpanded(id);
    const title = M.titleOf(o);
    const prog = st.progress ? M.progressMixOf(app.model, st.collapse, id) : null;
    const node = {
      id,
      bp: {
        kind: 'object', id, object: o, compound, title, prog,
        wrap: titleWrap(title, compound),
      },
      children: [],
      layoutOptions: {},
    };
    if (compound) {
      const { width, height } = node.bp.wrap;
      const head = SECTION_HEAD + height - LINE_H;
      node.layoutOptions['elk.padding'] = `[top=${head},left=16,bottom=16,right=16]`;
      node.layoutOptions['elk.spacing.nodeNode'] = '22';
      node.layoutOptions['elk.algorithm'] = 'layered';
      node.layoutOptions['elk.direction'] = 'DOWN';
      // Wide enough for the whole title.  ELK 0.9.3 transposes the minimum
      // size of a compound laid out DOWN, so the vector is (height, width).
      node.layoutOptions['elk.nodeSize.constraints'] = 'MINIMUM_SIZE';
      node.layoutOptions['elk.nodeSize.minimum'] =
        `(${head + 16}, ${width + SECTION_PAD_L + SECTION_PAD_R})`;
    } else {
      sizeLeaf(node, view.isExpandable(id), false);
    }
    return node;
  };

  // Titles with maths are measured by the browser, all of them in one go.
  measureMathTitles(app, [...nodeIds].map((id) => [M.titleOf(m.byId.get(id)), view.isExpanded(id)]));
  for (const id of nodeIds) nodes.set(id, mk(id));

  const rootChildren = [];
  for (const [id, node] of nodes) {
    const c = containerOf(id);
    if (c && nodes.has(c)) nodes.get(c).children.push(node);
    else rootChildren.push(node);
  }
  // A compound with no surviving children still needs a size.
  for (const node of nodes.values()) {
    if (node.bp.compound && node.children.length === 0) {
      sizeLeaf(node, true, true);
      delete node.children;
      delete node.layoutOptions['elk.nodeSize.constraints'];
      delete node.layoutOptions['elk.nodeSize.minimum'];
    }
  }

  // --- drawn entities ------------------------------------------------------
  // Each visible object's own arcs, unless the reader asked for the arcs of
  // the contents of collapsed objects too (`M.ownEdges`).
  const keepEntity = (e) => !enabledKinds || enabledKinds.has(e.kind);
  const shown = st.inner ? quot.edges : M.ownEdges(view, quot.edges);
  const kept = shown.filter(keepEntity);
  const contents = st.inner ? 0 : quot.edges.filter(keepEntity).length - kept.length;
  const junctionEntities = kept.filter((e) => e.type === 'junction');

  // An object drawn as a junction becomes a node of its own; the ELK id of an
  // end is "j:<id>" when that end is itself a junction.
  const junctionIds = new Set(junctionEntities.map((e) => e.members[0].id));
  const drawable = (id) => nodes.has(id) || junctionIds.has(id);
  const nodeKey = (id) => (nodes.has(id) ? id : 'j:' + id);

  // A junction needs at least two drawable ends; dropping one may drop another.
  for (let round = 0; round < 6; round += 1) {
    let changed = false;
    for (const e of junctionEntities) {
      const jid = e.members[0].id;
      if (!junctionIds.has(jid)) continue;
      const n = e.members[0].ends.filter((x) => drawable(x.id)).length;
      if (n < 2) { junctionIds.delete(jid); changed = true; }
    }
    if (!changed) break;
  }

  // --- implied arcs --------------------------------------------------------
  // With "hide implied" on, the reduction runs on exactly what is about to be
  // drawn: the quotient after the kind and status filters, with the drawable
  // ends.  An arc is never hidden in favour of a path through a node or a kind
  // the reader has filtered away.  A junction's spokes are paths (src end ->
  // junction -> tgt end, in the model's direction) but are never hidden
  // themselves; undirected arcs and spokes take no part.
  let implied = null;
  if (st.reduce) {
    const arcs = [];
    for (const e of kept) {
      if (e.type === 'junction') {
        const item = e.members[0];
        if (!junctionIds.has(item.id)) continue;
        for (const end of item.ends) {
          if (!drawable(end.id)) continue;
          const isSrc = end.roles.includes('src');
          const isTgt = end.roles.includes('tgt');
          if (isSrc === isTgt) continue; // neither, or both: no direction
          arcs.push(isSrc
            ? { id: null, kind: item.kind, src: end.id, tgt: item.id, keep: true }
            : { id: null, kind: item.kind, src: item.id, tgt: end.id, keep: true });
        }
      } else if (e.directed && drawable(e.src) && drawable(e.tgt)) {
        arcs.push({ id: e.id, kind: e.kind, src: e.src, tgt: e.tgt, keep: false });
      }
    }
    implied = M.transitiveReduction(arcs);
  }

  const edges = [];

  for (const e of kept) {
    if (e.type === 'junction') {
      const item = e.members[0];
      if (!junctionIds.has(item.id)) continue;
      const jid = 'j:' + item.id;
      const jnode = {
        id: jid,
        width: JUNCTION_R * 2,
        height: JUNCTION_R * 2,
        bp: { kind: 'junction', id: item.id, object: item.object, item },
      };
      // Junction nodes live at the root; ELK routes their edges across levels.
      rootChildren.push(jnode);
      nodes.set(jid, jnode);
      // Spokes run from the `src` end into the junction and out to the rest;
      // a reversed kind runs them from the `tgt` end instead.
      const inRole = M.isReversedKind(m, item.kind) ? 'tgt' : 'src';
      for (const end of item.ends) {
        if (!drawable(end.id)) continue;
        const isIn = end.roles.includes(inRole);
        edges.push({
          id: jid + '|' + end.id,
          sources: [isIn ? nodeKey(end.id) : jid],
          targets: [isIn ? jid : nodeKey(end.id)],
          bp: {
            kind: 'spoke',
            item,
            role: end.roles.join('/'),
            directed: end.roles.includes('src') || end.roles.includes('tgt'),
          },
        });
      }
    } else {
      if (!drawable(e.src) || !drawable(e.tgt)) continue;
      if (implied && implied.has(e.id)) continue;
      // The arrow head sits at the ELK target, and the layer order follows
      // ELK's direction, so a reversed kind swaps the two for both.
      const flip = e.directed && M.isReversedKind(m, e.kind);
      edges.push({
        id: e.id,
        sources: [nodeKey(flip ? e.tgt : e.src)],
        targets: [nodeKey(flip ? e.src : e.tgt)],
        bp: { kind: 'edge', entity: e },
      });
    }
  }

  const graph = {
    id: 'root',
    layoutOptions: layoutOptions(nodes.size + edges.length),
    children: rootChildren,
    edges,
  };
  const edgeMeta = new Map(edges.map((e) => [e.id, e.bp]));
  return { graph, nodes, edgeMeta, implied: implied ? implied.size : 0, contents };
}

/**
 * ELK's options for a graph of this size.  `BIG_GRAPH` and above drops the
 * model-order pass and the crossing-minimisation thoroughness; everything else
 * is the same drawing.
 */
export function layoutOptions(cost) {
  const opts = {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': '48',
    'elk.spacing.nodeNode': '30',
    'elk.spacing.edgeNode': '18',
    'elk.spacing.edgeEdge': '12',
    // Merged edges share a trunk, and a reader cannot follow any one of them
    // through it: every edge gets its own route instead.
    'elk.layered.mergeEdges': 'false',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.padding': '[top=24,left=24,bottom=24,right=24]',
  };
  if (cost >= BIG_GRAPH) {
    opts['elk.layered.considerModelOrder.strategy'] = 'NONE';
    opts['elk.layered.thoroughness'] = '1';
  }
  return opts;
}

/**
 * The same graph with the `bp` back-references removed: what actually goes to
 * the layouter, and what a worker can structured-clone.  Without this, ELK (and
 * `postMessage`) would walk the whole model through every node.
 */
export function plainGraph(graph) {
  const node = (n) => {
    const out = { id: n.id };
    if (n.width !== undefined) out.width = n.width;
    if (n.height !== undefined) out.height = n.height;
    if (n.layoutOptions) out.layoutOptions = n.layoutOptions;
    if (n.children) out.children = n.children.map(node);
    return out;
  };
  return {
    id: graph.id,
    layoutOptions: graph.layoutOptions,
    children: (graph.children || []).map(node),
    edges: (graph.edges || []).map((e) => ({
      id: e.id,
      sources: e.sources.slice(),
      targets: e.targets.slice(),
    })),
  };
}

// ---------------------------------------------------------------------------
// remembered layouts
// ---------------------------------------------------------------------------
//
// ELK is deterministic: the same graph in, the same layout out.  So a layout
// is remembered in localStorage under its exact input and the ELK that made
// it, and when that graph is asked for again — a reload, the next visit,
// collapsing back to a view seen before — it is drawn without ELK at all: no
// worker to wait for, no 1.6 MB layouter to compile, no first slow run.
// Being keyed by the whole input, it can only ever give what ELK would: a
// changed snapshot, view or measured title width is a different graph.
// Storage that is missing, full or refused is no cache, nothing worse.

const LAYOUT_PREFIX = 'blueprint.layout.';
const LAYOUT_INDEX = 'blueprint.layouts'; // their keys, least recently used first
const LAYOUT_KEEP = 12;
const LAYOUT_MAX_CHARS = 400000; // input and layout together: a few hundred nodes

function layoutStore() {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
  } catch (e) {
    return null; // a sandbox that throws on the very access
  }
}

/** FNV-1a over the text: only a name for the entry, which holds the input itself. */
function layoutName(inputText) {
  let h = 0x811c9dc5;
  for (let i = 0; i < inputText.length; i += 1) {
    h ^= inputText.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return LAYOUT_PREFIX + (h >>> 0).toString(36) + '.' + inputText.length.toString(36);
}

function layoutIndex(store) {
  try {
    const list = JSON.parse(store.getItem(LAYOUT_INDEX) || '[]');
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch (e) {
    return [];
  }
}

/** The layout ELK gave for exactly this input before, or null. */
export function rememberedLayout(inputText) {
  const store = layoutStore();
  if (!store) return null;
  try {
    const name = layoutName(inputText);
    const raw = store.getItem(name);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || entry.elk !== ELK_WORKER || entry.input !== inputText) return null;
    const laid = JSON.parse(entry.laid);
    const index = layoutIndex(store).filter((k) => k !== name);
    index.push(name);
    store.setItem(LAYOUT_INDEX, JSON.stringify(index));
    return laid && typeof laid === 'object' ? laid : null;
  } catch (e) {
    return null;
  }
}

/** Keep a layout ELK has just made, dropping the least recently used beyond `LAYOUT_KEEP`. */
export function rememberLayout(inputText, laidText) {
  const store = layoutStore();
  if (!store || inputText.length + laidText.length > LAYOUT_MAX_CHARS) return;
  const name = layoutName(inputText);
  const entry = JSON.stringify({ elk: ELK_WORKER, input: inputText, laid: laidText });
  const index = layoutIndex(store).filter((k) => k !== name);
  index.push(name);
  try {
    while (index.length > LAYOUT_KEEP) store.removeItem(index.shift());
    // Full: make room from the oldest, and give up when there is nothing left
    // of ours to drop.
    for (;;) {
      try {
        store.setItem(name, entry);
        break;
      } catch (e) {
        if (index.length <= 1) return;
        store.removeItem(index.shift());
      }
    }
    store.setItem(LAYOUT_INDEX, JSON.stringify(index));
  } catch (e) {
    /* storage refused: no cache */
  }
}

// ---------------------------------------------------------------------------
// layout + draw
// ---------------------------------------------------------------------------

function signatureOf(st) {
  return JSON.stringify([st.collapse, [...st.expand].sort(), st.ekinds, st.status, st.reduce, st.inner,
    st.appendix, st.progress]);
}

async function scheduleLayout(app, st, view, quot) {
  const status = ui.stage.querySelector('#graph-status');
  const sig = signatureOf(st);
  const structureChanged = sig !== lastSignature;
  lastSignature = sig;

  const token = ++layoutToken;
  // The first titles with maths on the page wait for KaTeX's fonts before
  // they are measured for good; a graph without maths goes straight on.
  const fonts = mathSettled(app, boxTitles(view.model, view));
  if (fonts) {
    ui.stage.classList.add('laying-out');
    await fonts;
    if (token !== layoutToken) return; // superseded while waiting
  }

  const { graph, nodes, edgeMeta, implied, contents } = buildElk(app, st, view, quot);
  const input = plainGraph(graph);
  const inputText = JSON.stringify(input);
  const remembered = rememberedLayout(inputText);

  if (!remembered) {
    const n = countNodes(graph);
    status.textContent = `laying out ${n.toLocaleString()} node${n === 1 ? '' : 's'}\u2026`;
    ui.stage.classList.add('laying-out');
  }

  clearLayoutError();
  try {
    const laid = remembered || await layoutGraph(input);
    if (token !== layoutToken) return; // superseded
    ui.stage.classList.remove('laying-out');
    // Before drawing, which may add to it; kept only once it has drawn.
    const laidText = remembered ? null : JSON.stringify(laid);
    draw(app, st, view, quot, laid, nodes, edgeMeta, structureChanged);
    if (laidText) rememberLayout(inputText, laidText);
    const nCount = countNodes(laid);
    status.textContent = `${nCount.toLocaleString()} nodes, ${(laid.edges || []).length} links \u2014 ` +
      (st.reduce ? `${implied} implied arc${implied === 1 ? '' : 's'} hidden \u2014 ` : '') +
      (contents ? `${contents} arc${contents === 1 ? '' : 's'} of contents hidden \u2014 ` : '') +
      `${view.expanded.size} expanded, collapse kind \u201c${st.collapse}\u201d`;
  } catch (e) {
    // Everything on this path is covered, the drawing included: a failure has
    // to leave a visible answer rather than "laying out N nodes…" for ever,
    // and has to leave the page able to try again.
    console.error(e);
    if (token !== layoutToken) return;
    ui.stage.classList.remove('laying-out');
    const msg = describe(e);
    status.textContent = 'layout failed: ' + msg;
    showLayoutError(app, msg, e);
    lastSignature = null; // the next attempt is a fresh one, not a redraw
  }
}

/**
 * A red line in the graph pane; the status line alone is easy to miss.  It
 * carries the top of the stack as well, because a message like "String
 * contains an invalid character" names a browser check, not the line that
 * tripped it, and the person reading the page is the only one who can see it.
 */
function showLayoutError(app, message, error) {
  clearLayoutError();
  if (!ui) return;
  const where = stackHead(error);
  ui.errorEl = app.el('div.graph-error',
    'Layout failed: ' + message + (where ? ` (at ${where})` : ''));
  ui.stage.appendChild(ui.errorEl);
}

/** The first few frames of an error's stack, trimmed to file:line. */
function stackHead(error) {
  const stack = error && typeof error.stack === 'string' ? error.stack : '';
  const frames = stack.split('\n')
    .map((l) => l.trim())
    .filter((l) => /\.(m?js)(\?[^:]*)?:\d+/.test(l))
    .map((l) => l.replace(/^at\s+/, '').replace(/^.*?@/, '').replace(/^.*\/([^/]+:\d+(?::\d+)?)\)?$/, '$1'))
    .slice(0, 3);
  return frames.join(' < ');
}

function clearLayoutError() {
  if (!ui || !ui.errorEl) return;
  if (ui.errorEl.parentNode) ui.errorEl.parentNode.removeChild(ui.errorEl);
  ui.errorEl = null;
}

function countNodes(n) {
  let c = 0;
  const walk = (x) => { for (const ch of x.children || []) { c += 1; walk(ch); } };
  walk(n);
  return c;
}

// ---------------------------------------------------------------------------
// running ELK: in a worker when the browser lets us, on the main thread if not
// ---------------------------------------------------------------------------

let workerElk = null;       // ELK driving a real Web Worker, or null
let workerHandle = null;    // that worker, so it can be terminated
let workerBroken = false;   // it could not be created, died, or timed out
const inFlight = new Set(); // layout requests the worker still owes an answer

// The watchdog.  A worker that neither answers nor raises an error would leave
// the page saying "laying out N nodes…" for ever, so every request carries a
// deadline: a fixed budget plus a little per node and edge.  Overridable
// through `window.BLUEPRINT_LAYOUT_DEADLINE_MS`, which is how the tests avoid
// waiting seconds for it.
const WATCHDOG_BASE_MS = 4000;
const WATCHDOG_PER_ITEM_MS = 2;

export function layoutDeadline(items) {
  const base = (typeof window !== 'undefined' && window.BLUEPRINT_LAYOUT_DEADLINE_MS)
    || WATCHDOG_BASE_MS;
  return Math.max(base, base + WATCHDOG_PER_ITEM_MS * items);
}

// elkjs, pinned.  The version lives here and only here: the page half, the
// worker half and the whole bundle must all be the same one.  The worker half
// is loaded by `importScripts`, which takes no integrity hash.
const ELK_CDN = 'https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/';
const ELK_API = {
  src: ELK_CDN + 'elk-api.js',
  integrity: 'sha384-ia1agyOe54zRe+J2Z07fmT5UL7g+pPm8rnefIG3Z7ej9s4sEJfVid71assPZygZP',
};
const ELK_BUNDLE = {
  src: ELK_CDN + 'elk.bundled.js',
  integrity: 'sha384-KO35c6PFq7tFxAEx6FtATwL9vOBOmCzQYr7GM0iTr3oO22s7Jc9OkclOH4AV7jwK',
};
export const ELK_WORKER = ELK_CDN + 'elk-worker.min.js';

let elkApiLoad = null;    // the Promise of elk-api.js, once asked for
let elkBundleLoad = null; // the Promise of elk.bundled.js, once asked for
// `window.ELK` is elk-api.js's, which drives a worker but cannot lay out on
// the main thread.  An `ELK` the page had before this module asked for one
// (a test's, or a site that loads the bundle itself) is taken to do both.
let elkApiOnly = false;

/** A classic script from the CDN, with its integrity hash. */
function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.setAttribute('src', src);
    tag.setAttribute('integrity', integrity);
    tag.setAttribute('crossorigin', 'anonymous');
    tag.setAttribute('referrerpolicy', 'no-referrer');
    tag.addEventListener('load', () => resolve());
    tag.addEventListener('error', () =>
      reject(new Error('ELK could not be loaded from the CDN; the graph needs it')));
    (document.head || document.documentElement).appendChild(tag);
  });
}

/** An `ELK` that can drive a worker: elk-api.js, unless one is there. */
function elkForWorker() {
  if (window.ELK) return Promise.resolve();
  if (!elkApiLoad) {
    elkApiLoad = loadScript(ELK_API).then(() => { if (!elkBundleLoad) elkApiOnly = true; });
    elkApiLoad.catch(() => { elkApiLoad = null; }); // try again next layout
  }
  return elkApiLoad;
}

/** An `ELK` that lays out on the main thread: elk.bundled.js. */
function elkForMainThread() {
  if (window.ELK && !elkApiOnly) return Promise.resolve();
  if (!elkBundleLoad) {
    elkBundleLoad = loadScript(ELK_BUNDLE).then(() => { elkApiOnly = false; });
    elkBundleLoad.catch(() => { elkBundleLoad = null; });
  }
  return elkBundleLoad;
}

function workersAllowed() {
  return typeof Worker === 'function' && typeof Blob === 'function' &&
    typeof URL !== 'undefined' && !!URL.createObjectURL;
}

/**
 * Called by app.js as soon as this module is loaded, before the snapshot has
 * arrived: fetch ELK and start its worker, so that they download beside the
 * data rather than after it.
 */
export function prepare() {
  ensureWorkerElk().catch(() => { /* the first layout says what went wrong */ });
}

/**
 * ELK in elkjs's own worker mode.
 *
 * elkjs comes in two halves that talk to each other over a fixed protocol
 * (`{id, cmd: 'register' | 'layout', …}` out, `{id, data}` or `{id, error}`
 * back): `elk-api`, the `ELK` class on the page, and `elk-worker.min.js`, the
 * layouter, which installs that protocol on `self.onmessage` as soon as it is
 * loaded in a worker.  So the worker's whole program is one `importScripts` of
 * elk-worker.min.js, and the page drives it with `new ELK({workerFactory})`.
 *
 * Do *not* load elk.bundled.js in the worker and run a protocol of our own on
 * top: the bundle contains the worker half too, and in a worker context (no
 * `document`, a `self`) that half claims `self.onmessage` for elkjs's protocol
 * and exports no fake worker, so `new ELK()` inside the worker throws and
 * every message in any other protocol is dropped without an answer — the page
 * then waits for a reply that never comes.
 *
 * The worker is still built from a Blob, so the deployment stays a directory
 * of static files: no worker script to serve, and no build step.  The site is
 * served without a Content-Security-Policy, so `blob:` workers and the
 * cross-origin `importScripts` are both allowed; where a CSP forbids either,
 * construction throws and we lay out on the main thread instead.
 */
async function ensureWorkerElk() {
  if (workerElk || workerBroken) return workerElk;
  if (!workersAllowed()) {
    workerBroken = true;
    return null;
  }
  // elk-api.js not arriving is not a verdict on workers: the main thread
  // tries the bundle and reports, and the next layout asks again.
  try {
    await elkForWorker();
  } catch (e) {
    return null;
  }
  if (workerElk || workerBroken) return workerElk; // made while this waited
  const source = `importScripts(${JSON.stringify(ELK_WORKER)});\n`;
  let objectUrl = null;
  try {
    objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    workerElk = new window.ELK({
      workerFactory: () => {
        const w = earlyWorker() || new Worker(objectUrl);
        workerHandle = w;
        // The worker could not even start (a blocked import, most likely).
        w.onerror = (ev) => breakWorker((ev && ev.message) || 'the ELK worker failed');
        return w;
      },
    });
  } catch (e) {
    // Most likely `new Worker` itself: a CSP that forbids `blob:` workers.
    workerBroken = true;
    workerElk = null;
    try { if (workerHandle) workerHandle.terminate(); } catch (e2) { /* never started */ }
    workerHandle = null;
    if (objectUrl && URL.revokeObjectURL) URL.revokeObjectURL(objectUrl);
    return null;
  }
  return workerElk;
}

/**
 * The worker index.html starts for a page opened on the graph, before any
 * module has loaded: the same one-line program as the one built above, begun
 * half a second sooner, its 430 kB download beside the snapshot's.  Taken
 * once, and only if it imports this very file; a worker that already failed,
 * or that a stale index.html pointed elsewhere, is dropped for a fresh one.
 */
function earlyWorker() {
  const early = typeof window !== 'undefined' ? window.blueprintElkWorker : null;
  if (!early) return null;
  window.blueprintElkWorker = null;
  if (early.worker && early.src === ELK_WORKER && !early.failed) return early.worker;
  try { if (early.worker) early.worker.terminate(); } catch (e) { /* never started */ }
  return null;
}

/**
 * Give up on the worker: terminate it, never make another, and let every
 * request it still owes an answer finish on the main thread.
 */
function breakWorker(reason) {
  workerBroken = true;
  const inst = workerElk;
  const w = workerHandle;
  workerElk = null;
  workerHandle = null;
  try {
    if (inst && typeof inst.terminateWorker === 'function') inst.terminateWorker();
    else if (w && w.terminate) w.terminate();
  } catch (e) { /* already gone */ }
  const waiting = [...inFlight];
  inFlight.clear();
  for (const req of waiting) req.fail(reason);
}

function describe(reason) {
  if (!reason) return 'unknown error';
  return reason.message ? reason.message : String(reason);
}

async function layoutGraph(graph) {
  // A worker already running is used at once, so the request is posted
  // before this returns; only the first layout waits for ELK to arrive.
  const inst = workerElk || workerBroken ? workerElk : await ensureWorkerElk();
  if (!inst) return layoutOnMainThread(graph);
  const deadline = layoutDeadline(countNodes(graph) + (graph.edges || []).length);
  return new Promise((resolve, reject) => {
    let done = false;
    const req = {
      timer: null,
      fail(reason) {
        if (done) return;
        done = true;
        clearTimeout(req.timer);
        inFlight.delete(req);
        console.warn('ELK worker layout failed (' + describe(reason) +
          '); laying out on the main thread instead');
        layoutOnMainThread(graph).then(resolve, reject);
      },
      settle(laid) {
        if (done) return;
        done = true;
        clearTimeout(req.timer);
        inFlight.delete(req);
        resolve(laid);
      },
    };
    inFlight.add(req);
    req.timer = setTimeout(() => {
      breakWorker(`no answer within ${deadline} ms`);
    }, deadline);
    let p;
    try {
      p = inst.layout(graph);
    } catch (e) {
      p = Promise.reject(e);
    }
    // A rejection means the worker cannot be trusted with this graph — and we
    // cannot tell "this graph is bad" from "this worker is bad" — so drop the
    // worker and let the main thread say what went wrong.
    Promise.resolve(p).then((laid) => req.settle(laid), (err) => breakWorker(err));
  });
}

/**
 * The fallback: elk.bundled.js's in-thread mode, which lays out inside a fake
 * worker on the main thread.  ELK is effectively synchronous here, so the best
 * we can do is let the browser paint the "laying out N nodes" status before we
 * take the thread away, and let it paint again before we draw.
 */
async function layoutOnMainThread(graph) {
  await elkForMainThread();
  if (!window.ELK) throw new Error('ELK could not be loaded from the CDN; the graph needs it');
  if (!elk) elk = new window.ELK();
  await nextFrame();
  const laid = await elk.layout(graph);
  await nextFrame();
  return laid;
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Absolute positions, nesting depth and the chain of containers for every
 * laid-out node.  The chain is needed because ELK reports an edge's route
 * relative to the lowest common ancestor of its endpoints, not to the root.
 */
function absolutePositions(laid) {
  const abs = new Map();
  const chain = new Map(); // node id -> [container ids, outermost first]
  const walk = (parent, ox, oy, depth, path) => {
    for (const ch of parent.children || []) {
      const x = ox + (ch.x || 0);
      const y = oy + (ch.y || 0);
      abs.set(ch.id, { x, y, w: ch.width || 0, h: ch.height || 0, node: ch, depth });
      chain.set(ch.id, path);
      walk(ch, x, y, depth + 1, path.concat([ch.id]));
    }
  };
  walk(laid, 0, 0, 0, []);
  return { abs, chain };
}

/** Absolute offset of the container ELK put this edge's coordinates in. */
function edgeOffset(abs, chain, srcId, tgtId) {
  const a = chain.get(srcId) || [];
  const b = chain.get(tgtId) || [];
  let lca = null;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) break;
    lca = a[i];
  }
  if (!lca) return { x: 0, y: 0 };
  const box = abs.get(lca);
  return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
}

function draw(app, st, view, quot, laid, nodes, edgeMeta, animate) {
  const { svgEl, clear } = app;
  const layer = clear(ui.layer);
  const { abs, chain } = absolutePositions(laid);

  // Three layers: compound containers behind, then the edges, then the leaves,
  // so a hierarchical edge is never hidden by the box it passes through.
  const gCompounds = svgEl('g', { class: 'compounds' });
  const gEdges = svgEl('g', { class: 'edges' });
  const gNodes = svgEl('g', { class: 'nodes' });
  layer.appendChild(gCompounds);
  layer.appendChild(gEdges);
  layer.appendChild(gNodes);

  // --- nodes, shallowest first so compounds sit behind their children ------
  // What ELK sends back is a plain graph, so the model-side metadata is looked
  // up again by id from what `buildElk` kept.
  const ordered = [...abs.entries()].sort((a, b) => a[1].depth - b[1].depth);
  for (const [id, box] of ordered) {
    const source = nodes.get(id);
    const meta = source && source.bp;
    if (!meta) continue;
    if (meta.kind === 'junction') {
      gNodes.appendChild(drawJunction(app, box, meta, view));
    } else if (meta.compound) {
      const g = drawNode(app, box, meta, st, view);
      gCompounds.appendChild(g);
      gNodes.appendChild(drawTitleStrip(app, box, g, meta, view));
    } else {
      gNodes.appendChild(drawNode(app, box, meta, st, view));
    }
  }

  // --- edges ---------------------------------------------------------------
  for (const e of laid.edges || []) {
    const meta = edgeMeta.get(e.id);
    if (!meta) continue;
    const srcId = e.sources[0];
    const tgtId = e.targets[0];
    const a = abs.get(srcId);
    const b = abs.get(tgtId);
    if (!a || !b) continue;
    const pts = pathPoints(e, a, b, edgeOffset(abs, chain, srcId, tgtId));
    const g = drawEdge(app, meta, pts, a, b);
    g.dataset.src = srcId;
    g.dataset.tgt = tgtId;
    gEdges.appendChild(g);
  }

  // --- transitions ---------------------------------------------------------
  if (animate) {
    layer.classList.remove('no-anim');
    for (const [id, box] of abs) {
      const prev = prevPos.get(id);
      if (!prev || (prev.x === box.x && prev.y === box.y)) continue;
      // a compound has two groups: its box, and its title strip
      for (const g of layer.querySelectorAll(`[data-nid="${cssEscape(id)}"]`)) {
        g.setAttribute('transform', `translate(${prev.x},${prev.y})`);
        g.dataset.target = `translate(${box.x},${box.y})`;
      }
    }
    requestAnimationFrame(() => {
      for (const g of layer.querySelectorAll('[data-target]')) {
        g.setAttribute('transform', g.dataset.target);
        delete g.dataset.target;
      }
    });
    gEdges.classList.add('fade-in');
    requestAnimationFrame(() => gEdges.classList.remove('fade-in'));
  }
  prevPos = new Map([...abs].map(([id, b]) => [id, { x: b.x, y: b.y }]));
  ui.chain = chain;

  ui.bbox = bboxOf(abs);
  if (!ui.fitted) { fitToView(app); ui.fitted = true; } else applyTransform();
  applyLevel(app, view);
  applyHighlight(app, st.q);
  applySelection(app, st.sel);
  // For the intro (intro.js), which zooms into the graph once it is drawn.
  ui.stage.classList.add('drawn');
  if (typeof ui.stage.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    ui.stage.dispatchEvent(new CustomEvent('graphdrawn', { bubbles: true }));
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// --- node shapes -----------------------------------------------------------

// Colour says the status, so the type is told by shape: a definition is a
// sharp box, a theorem, proposition, lemma or corollary a stadium, a remark a
// note with a folded corner, and a section a double frame; see `M.nodeType`.
const FOLD = 9;          // the folded corner of a remark
const FRAME_GAP = 3;     // the gap between a section's two frames
const STADIUM_R = 18;    // a statement's end radius: a full half-circle on a one-line
                         // leaf, no deeper than LEAF_PAD into a taller one's title

function nodeShape(svgEl, shape, w, h, compound) {
  if (shape === 'remark') {
    const f = Math.min(FOLD, w / 2, h / 2);
    return [
      svgEl('path', { class: 'shape', d: `M0,0 H${w - f} L${w},${f} V${h} H0 Z` }),
      svgEl('path', { class: 'fold', d: `M${w - f},0 V${f} H${w}` }),
    ];
  }
  if (shape === 'section') {
    return [
      svgEl('rect', { class: 'shape', x: 0, y: 0, width: w, height: h, rx: 5, ry: 5 }),
      svgEl('rect', {
        class: 'frame2', x: FRAME_GAP, y: FRAME_GAP,
        width: Math.max(0, w - 2 * FRAME_GAP), height: Math.max(0, h - 2 * FRAME_GAP), rx: 3, ry: 3,
      }),
    ];
  }
  // A stadium's ends would swallow a container's title, so an open
  // (compound) statement only rounds its corners well.
  const rx = shape === 'definition' ? 1.5
    : shape === 'statement' ? (compound ? 16 : Math.min(h / 2, STADIUM_R))
      : 8;
  return [svgEl('rect', { class: 'shape', x: 0, y: 0, width: w, height: h, rx, ry: rx })];
}

function drawNode(app, box, meta, st, view) {
  const { svgEl } = app;
  const m = app.model;
  const o = meta.object;
  const status = st.progress ? M.statusOf(m, o.id) : null;
  const type = M.nodeType(m, o);
  const g = svgEl('g', {
    class: 'gnode' + (meta.compound ? ' compound' : '') + ' kind-' + o.kind +
      ' type-' + type.shape + ' status-' + (status || 'none'),
    transform: `translate(${box.x},${box.y})`,
    'data-nid': box.node.id,
    'data-id': o.id,
    tabindex: 0,
  });
  for (const s of nodeShape(svgEl, type.shape, box.w, box.h, meta.compound)) g.appendChild(s);

  // The whole title, on the lines `buildElk` sized the node for: a section's
  // at the top left after the expander, a leaf's centred above its progress bar.
  const wrap = meta.wrap || { lines: [M.titleOf(o)], width: 0, height: LINE_H };
  const lines = wrap.lines;
  const expandable = view.isExpandable(o.id);
  const bar = !meta.compound && meta.prog && meta.prog.total > 1 ? 10 : 0;
  const tx = meta.compound ? SECTION_PAD_L - 4 : box.w / 2 + (expandable ? 5 : 0);
  // The top of the block of lines; a plain line's baseline sits 11.5px below.
  const top = meta.compound ? 21 - LINE_H / 2 - 4 : (box.h - bar) / 2 - wrap.height / 2;
  if (wrap.math) {
    // KaTeX's HTML, on the lines `measureMathTitles` measured.  The events go
    // to the shape underneath, so hovering, clicking and the tooltip behave
    // as on any other node.
    const fo = svgEl('foreignObject', {
      class: 'label math',
      x: meta.compound ? tx : tx - wrap.width / 2, y: top,
      width: wrap.width, height: wrap.height,
    });
    fo.appendChild(app.el('div', {
      class: 'gmath' + (meta.compound ? ' section' : ''),
      html: lines.map((h) => '<div class="gm-line">' + h + '</div>').join(''),
    }));
    g.appendChild(fo);
  } else {
    const ty = top + LINE_H / 2 + 4;
    g.appendChild(svgEl('text', {
      class: 'label', 'text-anchor': meta.compound ? 'start' : 'middle',
    }, ...lines.map((line, i) => svgEl('tspan', { x: tx, y: ty + i * LINE_H }, line))));
  }

  g.appendChild(svgEl('text', {
    // Clear of a remark's folded corner and a statement's round end.
    class: 'kindmark', y: 12, 'text-anchor': 'end',
    x: box.w - (type.shape === 'remark' ? 6 + FOLD : type.shape === 'statement' && !meta.compound ? 11 : 6),
  }, type.mark));

  const prog = meta.prog;
  if (prog && prog.total > 1 && !meta.compound) {
    const w = box.w - 24;
    g.appendChild(svgEl('rect', { class: 'ptrack', x: 12, y: box.h - 14, width: w, height: 5, rx: 2.5 }));
    if (prog.mix) {
      // One segment per status, as the progress page's status mix.
      let x = 12;
      for (const s of M.STATUS_BAR_ORDER) {
        const n = prog.mix[s];
        if (!n) continue;
        const sw = (w * n) / prog.total;
        g.appendChild(svgEl('rect', { x, y: box.h - 14, width: sw, height: 5, style: `fill: var(--st-${s})` }));
        x += sw;
      }
    } else {
      const frac = prog.total ? prog.proved / prog.total : 0;
      g.appendChild(svgEl('rect', { class: 'pfill', x: 12, y: box.h - 14, width: Math.max(0, w * frac), height: 5, rx: 2.5 }));
    }
  }
  if (expandable) {
    g.appendChild(svgEl('text', { class: 'expander', x: 8, y: meta.compound ? 21 : (box.h - bar) / 2 + 4 },
      view.isExpanded(o.id) ? '\u2212' : '+'));
  }

  // A drawn formula cannot be copied or read back as TeX, so the tooltip has
  // the source of such a title first.
  const title2 = (wrap.math ? M.titleOf(o) + '\n' : '') +
    `${o.id}\n${o.kind}` + (status ? `\nstatus: ${M.STATUS_LABEL[status]}` : '') +
    (prog ? `\nprogress: ${prog.proved}/${prog.total}` : '') +
    (prog && prog.mix ? M.STATUS_BAR_ORDER.filter((s) => prog.mix[s] && s !== 'proved')
      .map((s) => `\n  ${M.STATUS_LABEL[s]}: ${prog.mix[s]}`).join('') : '');
  g.appendChild(svgEl('title', title2));
  wireNode(app, g, o.id, view);
  return g;
}

// --- pictures of the intro ---------------------------------------------------

// The intro (intro.js) zooms through a few small pictures on its way to the
// graph: `{nodes: [{id, title, kind}], arrows: [[from, to]]}`.  They are laid
// out by ELK with the graph's own options and drawn with its own shapes and
// classes, so that a box in them is a box of the graph: a node of a section
// kind as a collapsed section, with its expander, and every other as an
// object of its kind.  Nothing in them is a link.

/**
 * One picture as an `<svg>` whose viewBox is the drawing, and that box as
 * `{x, y, w, h}`.  Layouts are remembered as the graph's are.
 */
export async function sketch(app, layer) {
  const { svgEl } = app;
  const types = { _types: new Map() };
  const nodes = (layer.nodes || []).map((n) => {
    const type = M.nodeType(types, { id: n.id, kind: n.kind || 'section' });
    const expandable = type.shape === 'section';
    const node = { id: n.id, bp: { wrap: titleWrap(n.title, false), prog: null } };
    sizeLeaf(node, expandable, false);
    return { ...n, type, expandable, node };
  });
  const graph = {
    id: 'root',
    layoutOptions: layoutOptions(0),
    children: nodes.map((n) => ({ id: n.id, width: n.node.width, height: n.node.height })),
    edges: (layer.arrows || []).map(([a, b], i) => ({ id: 'a' + i, sources: [a], targets: [b] })),
  };
  const inputText = JSON.stringify(graph);
  let laid = rememberedLayout(inputText);
  if (!laid) {
    laid = await layoutGraph(graph);
    rememberLayout(inputText, JSON.stringify(laid));
  }
  const { abs } = absolutePositions(laid);
  const box = bboxOf(abs);
  const pad = 4; // the stroke, outside the boxes
  const svg = svgEl('svg', {
    xmlns: 'http://www.w3.org/2000/svg', class: 'sketch',
    viewBox: `${box.x - pad} ${box.y - pad} ${box.w + 2 * pad} ${box.h + 2 * pad}`,
    width: box.w + 2 * pad, height: box.h + 2 * pad,
  });
  // Arrowheads of its own: an id shared with the graph's would resolve to
  // the graph's, which the intro keeps hidden.
  const head = svgEl('marker', {
    id: 'bp-sketch-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
  }, svgEl('path', { d: 'M 0 0.8 L 10 5 L 0 9.2 z', class: 'arrowhead' }));
  svg.appendChild(svgEl('defs', head));
  const gEdges = svgEl('g', { class: 'edges' });
  const gNodes = svgEl('g', { class: 'nodes' });
  svg.appendChild(gEdges);
  svg.appendChild(gNodes);
  for (const e of laid.edges || []) {
    const a = abs.get(e.sources[0]);
    const b = abs.get(e.targets[0]);
    if (!a || !b) continue;
    const pts = pathPoints(e, a, b, { x: 0, y: 0 });
    gEdges.appendChild(svgEl('g', { class: 'gedge kind-uses' },
      svgEl('path', { d: pathD(pts), 'marker-end': 'url(#bp-sketch-arrow)' })));
  }
  for (const n of nodes) {
    const b = abs.get(n.id);
    if (b) gNodes.appendChild(sketchNode(app, b, n));
  }
  return { svg, box: { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad } };
}

/** A box of a picture, drawn as `drawNode` draws a leaf without progress. */
function sketchNode(app, box, n) {
  const { svgEl } = app;
  const { type, expandable } = n;
  const g = svgEl('g', {
    class: 'gnode kind-' + (n.kind || 'section') + ' type-' + type.shape + ' status-none',
    transform: `translate(${box.x},${box.y})`,
  });
  for (const s of nodeShape(svgEl, type.shape, box.w, box.h, false)) g.appendChild(s);
  const wrap = n.node.bp.wrap;
  const tx = box.w / 2 + (expandable ? 5 : 0);
  const ty = box.h / 2 - wrap.height / 2 + LINE_H / 2 + 4;
  g.appendChild(svgEl('text', { class: 'label', 'text-anchor': 'middle' },
    ...wrap.lines.map((line, i) => svgEl('tspan', { x: tx, y: ty + i * LINE_H }, line))));
  g.appendChild(svgEl('text', {
    class: 'kindmark', y: 12, 'text-anchor': 'end',
    x: box.w - (type.shape === 'remark' ? 6 + FOLD : type.shape === 'statement' ? 11 : 6),
  }, type.mark));
  if (expandable) g.appendChild(svgEl('text', { class: 'expander', x: 8, y: box.h / 2 + 4 }, '+'));
  return g;
}

/**
 * The title strip of a compound, drawn above the edges.  Arcs into an expanded
 * box cross its title, and without this their hit paths would take the clicks
 * meant for it.  It acts as the compound `g` does, and hovers it.
 */
function drawTitleStrip(app, box, g, meta, view) {
  const id = meta.object.id;
  const height = SECTION_HEAD - 4 + meta.wrap.height - LINE_H;
  const strip = app.svgEl('g', {
    class: 'gtitle',
    transform: `translate(${box.x},${box.y})`,
    'data-nid': box.node.id,
  });
  strip.appendChild(app.svgEl('rect', { class: 'title-hit', x: 0, y: 0, width: box.w, height }));
  wireNode(app, strip, id, view);
  strip.addEventListener('mouseenter', () => hover(g, true));
  strip.addEventListener('mouseleave', () => hover(g, false));
  return strip;
}

function drawJunction(app, box, meta, view) {
  const { svgEl } = app;
  const o = meta.object;
  const g = svgEl('g', {
    class: 'gnode junction kind-' + o.kind,
    transform: `translate(${box.x},${box.y})`,
    'data-nid': box.node.id,
    'data-id': o.id,
    tabindex: 0,
  });
  g.appendChild(svgEl('circle', {
    class: 'shape junction-dot', cx: box.w / 2, cy: box.h / 2, r: JUNCTION_R - 1,
  }));
  g.appendChild(svgEl('title', `${o.id}\n${o.kind} (${meta.item.ends.length} ends)`));
  wireNode(app, g, o.id, view);
  return g;
}

// A finger has no dependable `dblclick`: iOS never sends one, Android only
// sometimes, and either may zoom the page instead.  So for touch the second tap
// on the same node within `DOUBLE_TAP_MS` is the double-click, counted here,
// and the browser's own `dblclick` after a touch is ignored.  Mouse and pen
// keep the browser's.
const DOUBLE_TAP_MS = 350;
let lastPointerType = 'mouse'; // of the latest press on the stage
let lastTap = null;            // {id, t} of the latest single touch tap

function wireNode(app, g, id, view) {
  g.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (panSuppressClick) return; // the click that ends a pan
    if (lastPointerType === 'touch') {
      const now = Date.now();
      if (lastTap && lastTap.id === id && now - lastTap.t <= DOUBLE_TAP_MS) {
        lastTap = null;
        toggleExpand(app, id, view);
        return;
      }
      lastTap = { id, t: now };
    }
    select(app, id);
  });
  g.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    if (lastPointerType === 'touch') return; // counted in `click` above
    toggleExpand(app, id, view);
  });
  g.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); toggleExpand(app, id, view); }
    if (ev.key === ' ') { ev.preventDefault(); select(app, id); }
  });
  g.addEventListener('mouseenter', () => hover(g, true));
  g.addEventListener('mouseleave', () => hover(g, false));
}

function hover(g, on) {
  g.classList.toggle('hovered', on);
}

// --- edge geometry ---------------------------------------------------------

/**
 * ELK reports an edge's route relative to the lowest common ancestor of its
 * endpoints, so `off` shifts it back into root coordinates.  The result is
 * checked against the endpoint boxes and falls back to a straight line when it
 * does not line up, so a coordinate-space surprise degrades rather than breaks.
 */
function pathPoints(edge, a, b, off) {
  const sec = edge.sections && edge.sections[0];
  if (sec && sec.startPoint && sec.endPoint) {
    const shift = (p) => ({ x: p.x + off.x, y: p.y + off.y });
    const pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint].map(shift);
    if (nearBox(pts[0], a) && nearBox(pts[pts.length - 1], b)) return pts;
  }
  return [center(a), center(b)];
}

function center(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function nearBox(p, box, tol = 26) {
  return p.x >= box.x - tol && p.x <= box.x + box.w + tol &&
         p.y >= box.y - tol && p.y <= box.y + box.h + tol;
}

function pathD(pts) {
  let d = `M ${round(pts[0].x)} ${round(pts[0].y)}`;
  for (let i = 1; i < pts.length; i += 1) d += ` L ${round(pts[i].x)} ${round(pts[i].y)}`;
  return d;
}

function round(n) { return Math.round(n * 10) / 10; }

/** The point half way along a polyline, for edge labels. */
function midpoint(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) total += dist(pts[i - 1], pts[i]);
  let want = total / 2;
  for (let i = 1; i < pts.length; i += 1) {
    const d = dist(pts[i - 1], pts[i]);
    if (want <= d || i === pts.length - 1) {
      const f = d ? want / d : 0;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
               y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
    }
    want -= d;
  }
  return pts[0];
}

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

function drawEdge(app, meta, pts, a, b) {
  const { svgEl } = app;
  const isSpoke = meta.kind === 'spoke';
  const entity = meta.entity;
  const state = entity ? entity.state : null;
  const kind = isSpoke ? meta.item.kind : entity.kind;
  const elaborable = entity ? entity.elaborable !== false : true;
  const classes = ['gedge', 'kind-' + kind];
  if (state) classes.push('state-' + state);
  if (entity && entity.synthetic) classes.push('synthetic');
  if (isSpoke) classes.push('spoke');

  const g = svgEl('g', {
    class: classes.join(' '),
    'data-id': isSpoke ? meta.item.id : (entity.members[0] ? entity.members[0].id : entity.id),
  });

  const hollow = state === 'declared-only' && elaborable;
  const directed = isSpoke ? meta.directed : (entity.directed !== false);
  const path = svgEl('path', {
    d: pathD(pts),
    'marker-end': directed ? (hollow ? 'url(#bp-arrow-hollow)' : 'url(#bp-arrow)') : null,
  });
  g.appendChild(path);

  // a wide invisible path makes the edge easy to hit with the mouse
  const hit = svgEl('path', { class: 'hit', d: pathD(pts) });
  g.appendChild(hit);

  let label = null;
  if (isSpoke) label = meta.role;
  else if (entity.members.length > 1) label = '\u00d7' + entity.members.length;
  if (label) {
    const mid = midpoint(pts);
    g.appendChild(svgEl('text', { class: 'elabel', x: round(mid.x) + 4, y: round(mid.y) - 3 }, label));
  }

  const names = isSpoke
    ? `${meta.item.id}\nrole: ${meta.role}`
    : [
        entity.directed !== false && M.isReversedKind(app.model, kind)
          ? `${kind}: ${entity.tgt} \u2192 ${entity.src}`
          : `${kind}: ${entity.src} \u2192 ${entity.tgt}`,
        state ? `consistency: ${state}` : null,
        entity.members.length
          ? 'from: ' + entity.members.map((x) => x.id).join(', ')
          : 'no declared object: derived from ' +
            ((entity.consistency && entity.consistency.derived) || []).join(', '),
      ].filter(Boolean).join('\n');
  g.appendChild(svgEl('title', names));

  g.addEventListener('mouseenter', () => g.classList.add('hovered'));
  g.addEventListener('mouseleave', () => g.classList.remove('hovered'));
  g.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (panSuppressClick) return;
    const id = g.dataset.id;
    if (ui.app.model.byId.has(id)) select(ui.app, id);
  });
  return g;
}

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

function select(app, id) {
  ui.state.sel = id;
  writeState(app, { sel: id }, { silent: true });
  applySelection(app, id);
  renderSide(app, ui.state, ui.view, ui.quot);
  if (id) keepClearOfSheet(id);
}

/**
 * On a phone the side panel is a sheet over the bottom of the graph, and the
 * node just tapped is often under it: pan the graph up until its top is in
 * sight above the sheet, but never past the top of the stage.
 */
function keepClearOfSheet(id) {
  if (typeof getComputedStyle !== 'function' || getComputedStyle(ui.side).position !== 'absolute') return;
  const g = ui.layer.querySelector(`.gnode[data-id="${cssEscape(id)}"]`);
  if (!g) return;
  const r = g.getBoundingClientRect();
  const sheet = ui.side.getBoundingClientRect();
  const stage = ui.stage.getBoundingClientRect();
  if (!sheet.height) return;
  // A section's box can be most of the graph; its title strip is what counts.
  const bottom = Math.min(r.bottom, r.top + 48);
  const dy = Math.min(bottom + 12 - sheet.top, r.top - stage.top - 12);
  if (dy <= 0) return;
  ui.transform.y -= dy;
  applyTransform(false);
}

/**
 * The section the reader is in: the innermost open section, when the open
 * sections nest one inside the next, as they do when each was opened from
 * inside the last.  Null with nothing open, or with sections open side by
 * side (Expand all): then there is no one level to be in.
 */
export function enteredSection(view) {
  const open = [...view.expanded];
  for (const id of open) {
    const above = new Set(M.expandableAncestorsOf(view.order, id));
    if (open.every((o) => o === id || above.has(o))) return id;
  }
  return null;
}

/**
 * Entering a section leaves the level it was opened from behind: everything
 * drawn outside the section is blurred, faded and out of reach until the
 * reader goes back up, with the stage's Back button or the section's own −.
 */
function applyLevel(app, view) {
  const id = enteredSection(view);
  const here = id !== null && ui.chain && ui.chain.has(id) ? id : null;
  ui.entered = here;
  const inside = (nid) => nid === here || (ui.chain.get(nid) || []).includes(here);
  ui.layer.classList.toggle('entered', here !== null);
  for (const sel of ['.gnode', '.gtitle']) {
    for (const g of ui.layer.querySelectorAll(sel)) {
      const out = here !== null && !inside(g.dataset.nid);
      g.classList.toggle('outside', out);
      if (sel === '.gnode') g.setAttribute('tabindex', out ? -1 : 0);
    }
  }
  for (const g of ui.layer.querySelectorAll('.gedge')) {
    g.classList.toggle('outside', here !== null && !(inside(g.dataset.src) && inside(g.dataset.tgt)));
  }

  ui.back.hidden = here === null;
  if (here === null) return;
  // The level above: the open section around this one, or the top.
  const around = (ui.chain.get(here) || []).at(-1);
  const o = around && app.model.byId.get(around);
  ui.back.textContent = '\u2191 Back to ' + (o ? M.titleOf(o) : 'the top level');
  ui.back.title = 'close ' + M.titleOf(app.model.byId.get(here)) + ' and go back up a level';
}

function toggleExpand(app, id, view) {
  if (!view.isExpandable(id)) return;
  const next = view.isExpanded(id)
    ? M.collapse(view.order, view.expanded, id)
    : M.expand(view.order, view.expanded, id);
  writeState(app, { expand: [...next], sel: id });
}

function applySelection(app, id) {
  for (const g of ui.layer.querySelectorAll('.gnode')) {
    g.classList.remove('selected');
    g.classList.remove('focus');
  }
  for (const g of ui.layer.querySelectorAll('.gtitle')) g.classList.remove('focus');
  for (const g of ui.layer.querySelectorAll('.gedge')) {
    g.classList.remove('focus');
    focusArrowhead(g, false);
  }
  ui.layer.classList.remove('focusing');
  if (!id) return;
  const own = new Set();
  for (const g of ui.layer.querySelectorAll(`.gnode[data-id="${cssEscape(id)}"]`)) {
    g.classList.add('selected');
    own.add(g.dataset.nid);
  }
  if (!own.size) return;
  applyFocus(own);
}

/**
 * Bring the selected node's neighbourhood forward and fade the rest: its
 * edges, the nodes at their far ends, and the containers around all of these
 * (fading a section's box would wash out a highlighted node inside it).  An
 * open section counts its children as its own, and a relation drawn as a
 * junction passes the highlight on to its other spokes, so the objects it
 * relates the selection to light up too.
 */
function applyFocus(own) {
  const chain = ui.chain || new Map();
  const inside = (nid) => (chain.get(nid) || []).some((c) => own.has(c));
  const focus = new Set();
  const lit = [];
  const edges = [...ui.layer.querySelectorAll('.gedge')];
  const junctions = new Set([...ui.layer.querySelectorAll('.gnode.junction')].map((g) => g.dataset.nid));
  const reach = (from) => {
    const far = [];
    for (const g of edges) {
      const { src, tgt } = g.dataset;
      const hit = from(src) ? tgt : from(tgt) ? src : null;
      if (hit === null || g.classList.contains('focus')) continue;
      g.classList.add('focus');
      lit.push(g);
      focus.add(src); focus.add(tgt);
      far.push(hit);
    }
    return far;
  };
  const near = reach((nid) => own.has(nid) || inside(nid));
  const hubs = new Set(near.filter((nid) => junctions.has(nid) && !own.has(nid)));
  if (hubs.size) reach((nid) => hubs.has(nid));

  for (const nid of [...focus, ...own]) {
    focus.add(nid);
    for (const c of chain.get(nid) || []) focus.add(c);
  }
  for (const sel of ['.gnode', '.gtitle']) {
    for (const g of ui.layer.querySelectorAll(sel)) {
      const nid = g.dataset.nid;
      if (focus.has(nid) || own.has(nid) || inside(nid)) g.classList.add('focus');
    }
  }
  for (const g of lit) focusArrowhead(g, true);
  ui.layer.classList.add('focusing');
}

/** Give a highlighted edge the accent-coloured head of `defs`, or take it back. */
function focusArrowhead(g, on) {
  const p = g.querySelector('path'); // the drawn path; the wide hit path comes after it
  const mk = p && p.getAttribute('marker-end');
  if (!mk) return;
  const base = mk.replace(/-focus\)$/, ')');
  p.setAttribute('marker-end', on ? base.replace(/\)$/, '-focus)') : base);
}

function applyHighlight(app, q) {
  const hasQ = !!(q && q.trim());
  const ids = hasQ ? M.searchIds(app.model, q) : null;
  ui.layer.classList.toggle('searching', hasQ);
  for (const g of ui.layer.querySelectorAll('.gnode')) {
    const hit = hasQ && ids.has(g.dataset.id);
    g.classList.toggle('match', !!hit);
    g.classList.toggle('dim', hasQ && !hit);
  }
  for (const g of ui.layer.querySelectorAll('.gedge')) {
    g.classList.toggle('dim', hasQ);
  }
}

// --- pan / zoom ------------------------------------------------------------

function applyTransform(instant) {
  const t = ui.transform;
  ui.layer.classList.toggle('no-anim', !!instant);
  ui.layer.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
}

function zoomBy(app, f, cx, cy) {
  const t = ui.transform;
  const rect = ui.stage.getBoundingClientRect();
  const px = cx === undefined ? rect.width / 2 : cx;
  const py = cy === undefined ? rect.height / 2 : cy;
  const k = Math.max(0.08, Math.min(4, t.k * f));
  t.x = px - ((px - t.x) * k) / t.k;
  t.y = py - ((py - t.y) * k) / t.k;
  t.k = k;
  applyTransform(true);
}

function bboxOf(abs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of abs.values()) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function fitToView(app) {
  const bb = ui.bbox;
  if (!bb) return;
  const rect = ui.stage.getBoundingClientRect();
  const pad = 40;
  const k = Math.max(0.08, Math.min(1.6,
    Math.min((rect.width - pad * 2) / bb.w, (rect.height - pad * 2) / bb.h)));
  ui.transform = {
    k,
    x: (rect.width - bb.w * k) / 2 - bb.x * k,
    y: (rect.height - bb.h * k) / 2 - bb.y * k,
  };
  applyTransform(false);
}

let resizeHooked = false;
let panSuppressClick = false;

function installPanZoom(app) {
  const stage = ui.stage;
  let drag = null;

  if (!resizeHooked) {
    resizeHooked = true;
    window.addEventListener('resize', () => {
      if (ui && ui.bbox && ui.stage.isConnected) applyTransform(true);
    });
  }

  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = stage.getBoundingClientRect();
    const f = Math.pow(0.999, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1));
    zoomBy(app, f, ev.clientX - rect.left, ev.clientY - rect.top);
  }, { passive: false });

  // Every finger on the stage, so that two of them pinch: the graph point
  // under their midpoint stays under it while their spread sets the scale.  A
  // mouse is only ever one pointer, so on a desktop this is the drag below.
  const down = new Map(); // pointerId -> {x, y}, client coordinates
  let pinch = null;

  const startDrag = (ev, moved) => {
    drag = {
      x: ev.clientX, y: ev.clientY,
      tx: ui.transform.x, ty: ui.transform.y,
      moved,
      // Remember what was under the pointer when the press started: once a
      // pan begins, pointer capture retargets later events to the stage.
      target: ev.target,
    };
  };
  const startPinch = () => {
    const [a, b] = [...down.values()];
    const rect = stage.getBoundingClientRect();
    const t = ui.transform;
    const mx = (a.x + b.x) / 2 - rect.left;
    const my = (a.y + b.y) / 2 - rect.top;
    pinch = {
      d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      k: t.k,
      gx: (mx - t.x) / t.k, // the graph point under the midpoint
      gy: (my - t.y) / t.k,
    };
    drag = null;
    stage.classList.add('panning');
    for (const id of down.keys()) {
      try { stage.setPointerCapture(id); } catch (e) { /* ignore */ }
    }
  };

  stage.addEventListener('pointerdown', (ev) => {
    lastPointerType = ev.pointerType || 'mouse';
    if (ev.button !== 0) return;
    // Only fingers pinch.  A mouse released off the stage never reports it,
    // and must not count as a first finger next time.
    if (ev.pointerType !== 'touch') { down.clear(); pinch = null; }
    down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (down.size === 2) { startPinch(); return; }
    if (down.size > 2) return;
    startDrag(ev, false);
    // No pointer capture yet. Capturing on the press would make the browser
    // dispatch the eventual `click` and `dblclick` to the stage instead of the
    // node under the pointer, and nothing on a node would ever be selectable.
    // The stage captures only once the pointer has actually moved, below.
  });
  stage.addEventListener('pointermove', (ev) => {
    if (down.has(ev.pointerId)) down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch) {
      if (down.size < 2) return;
      const [a, b] = [...down.values()];
      const rect = stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - rect.left;
      const my = (a.y + b.y) / 2 - rect.top;
      const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const k = Math.max(0.08, Math.min(4, pinch.k * d / pinch.d));
      ui.transform = { k, x: mx - pinch.gx * k, y: my - pinch.gy * k };
      applyTransform(true);
      return;
    }
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= 3) return;
      drag.moved = true;
      try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      stage.classList.add('panning');
    }
    ui.transform.x = drag.tx + dx;
    ui.transform.y = drag.ty + dy;
    applyTransform(true);
  });
  const end = (ev) => {
    down.delete(ev.pointerId);
    try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    if (pinch) {
      if (down.size >= 2) { startPinch(); return; }
      pinch = null;
      if (down.size === 1) {
        // The finger left behind pans on from where it is; lifting it is the
        // end of a gesture, not a tap.
        const [id, p] = [...down.entries()][0];
        startDrag({ clientX: p.x, clientY: p.y, target: stage }, true);
        try { stage.setPointerCapture(id); } catch (e) { /* ignore */ }
        return;
      }
      stage.classList.remove('panning');
      panSuppressClick = true;
      setTimeout(() => { panSuppressClick = false; }, 0);
      return;
    }
    if (!drag || down.size) return;
    const { moved, target } = drag;
    drag = null;
    stage.classList.remove('panning');
    try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    if (moved) {
      // Swallow the click that a drag would otherwise deliver to a node.
      panSuppressClick = true;
      setTimeout(() => { panSuppressClick = false; }, 0);
    } else if (target === ui.svg || target === stage) {
      select(ui.app, null);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// side panel
// ---------------------------------------------------------------------------

function renderSide(app, st, view, quot) {
  const { el, clear } = app;
  const m = view.model;
  const side = clear(ui.side);
  const id = st.sel;
  const o = id ? m.byId.get(id) : null;

  // On a phone the panel is a sheet over the bottom of the graph (style.css):
  // gone while nothing is selected, and shrunk to its title and the expand
  // button when the reader minimises it.  On a wide screen the bar is hidden
  // and these classes do nothing.
  side.classList.toggle('unselected', !o);
  side.classList.toggle('min', !!(o && ui.sheetMin));

  if (!o) {
    side.appendChild(el('h2', 'Nothing selected'));
    side.appendChild(el('p.hint',
      'Click a node to inspect it, double-click (or press Enter) to expand or collapse it. ',
      'Drag to pan, scroll to zoom.'));
    // What is drawn: each object's own arcs, or the whole quotient with the
    // arcs of contents (see `buildElk`).
    const drawn = (st.inner ? quot.edges : M.ownEdges(view, quot.edges))
      .reduce((a, e) => a + e.members.length, 0);
    side.appendChild(el('section',
      el('h3', 'This view'),
      el('ul',
        el('li', el('b', String(view.visible.size)), ' visible objects'),
        el('li', el('b', String(drawn)), ' drawn relations'),
        el('li', el('b', String([...quot.internal.values()].reduce((a, b) => a + b.length, 0))),
          ' relations hidden inside collapsed objects'),
        st.inner
          ? el('li', el('b', String(quot.edges.filter((e) => e.synthetic).length)),
            ' synthesised derived-only arcs')
          : el('li', el('b', String(quot.items.length - drawn)),
            ' relations of contents not drawn (', el('i', 'arcs of contents'), ')'))));
    return;
  }

  side.appendChild(el('div.sheet-bar',
    el('button.sheet-grip', {
      type: 'button',
      'aria-expanded': ui.sheetMin ? 'false' : 'true',
      title: ui.sheetMin ? 'show the details' : 'minimise the details',
      onclick: () => { ui.sheetMin = !ui.sheetMin; renderSide(app, ui.state, ui.view, ui.quot); },
    }, el('span.grip-mark', { 'aria-hidden': 'true' }), ui.sheetMin ? 'Details \u25b4' : 'Details \u25be'),
    el('button.sheet-close', {
      type: 'button', title: 'deselect', 'aria-label': 'Close',
      onclick: () => select(app, null),
    }, '\u2715')));

  const status = M.badgeStatusOf(m, id);
  const heading = side.appendChild(el('h2', M.titleOf(o)));
  side.appendChild(el('div.meta', app.kindBadge(o.kind), status === null ? null : app.statusBadge(status)));
  side.appendChild(el('div.obj-id', id));

  const prog = st.progress ? M.progressMixOf(app.model, st.collapse, id) : null;
  if (prog) {
    side.appendChild(el('section', el('h3', 'Progress (' + st.collapse + ')'), app.progressBar(prog)));
  }

  if (view.isExpandable(id)) {
    side.appendChild(el('section.sheet-keep',
      el('button', { onclick: () => toggleExpand(app, id, view) },
        view.isExpanded(id) ? 'Collapse' : 'Expand',
        ' (', String(M.childrenOf(view.order, id).length), ' children)')));
  }

  // What the object says comes first, then what is wrong with it; only then
  // its neighbourhood, which on a real project easily runs to dozens of rows.
  if (o.body && o.body.trim()) {
    const box = el('div.excerpt.body-prose');
    side.appendChild(el('section', el('h3', 'Prose'), box));
    app.renderBody(box, excerpt(o.body, 700), app.knownIds());
  }

  const checks = M.checksFor(m, id);
  if (checks.length) {
    side.appendChild(el('section', el('h3', 'Checks'),
      el('ul', ...checks.map((c) =>
        el('li', app.levelBadge(c.level), ' ', el('span.small', c.message))))));
  }

  // A relation's boundary is what the relation is, and only a few rows long,
  // so it stays open.
  if (o.boundary.length) {
    side.appendChild(el('section', el('h3', 'Boundary'),
      el('ul.objlist', ...o.boundary.map((b) =>
        el('li', el('span.role', b.role), app.objLink(m, b.id))))));
  }

  const inc = M.incidentTo(m, id);
  if (inc.length) {
    side.appendChild(fold(el, 'incident', `Incident objects (${inc.length})`,
      el('ul.objlist', ...inc.slice(0, 14).map((r) =>
        el('li', el('span.role', r.role), app.objLink(m, r.object.id),
          el('span.chip', r.object.kind))),
      inc.length > 14 ? el('li.muted.small', `+${inc.length - 14} more`) : null)));
  }

  const hidden = quot.internal.get(id);
  if (hidden && hidden.length) {
    side.appendChild(fold(el, 'hidden', `Hidden inside (${hidden.length})`,
      el('p.hint', 'Relations whose ends all collapse into this object.'),
      el('ul.objlist', ...hidden.slice(0, 10).map((h) => el('li', app.objLink(m, h))),
        hidden.length > 10 ? el('li.muted.small', `+${hidden.length - 10} more`) : null)));
  }

  side.appendChild(el('section',
    el('a', { href: app.objectHref(id) }, 'Open object page \u2192')));

  // Titles carry maths, the heading's and the listed objects' alike.  After
  // the prose, which `renderBody` has rendered already.
  app.renderMath(heading);
  for (const list of side.querySelectorAll('ul.objlist')) app.renderMath(list);
}

// A listing behind a disclosure: shut until the reader opens it, the count in
// the summary saying what is there. The panel is rebuilt on every route change
// (a checkbox, an expand, the next selection), so whether it is open is kept in
// `ui.folded` under `key` rather than snapping shut each time.
function fold(el, key, title, ...children) {
  return el('section.fold',
    el('details', {
      open: ui.folded.has(key),
      ontoggle: (ev) => {
        if (ev.target.open) ui.folded.add(key);
        else ui.folded.delete(key);
      },
    }, el('summary', title), ...children));
}

function excerpt(body, n) {
  if (body.length <= n) return body;
  const cut = body.slice(0, n);
  const at = cut.lastIndexOf('\n\n');
  return (at > n * 0.4 ? cut.slice(0, at) : cut) + '\n\n\u2026';
}
