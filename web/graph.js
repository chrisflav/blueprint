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
//     an `importScripts` of elkjs's own worker half, elk-worker.min.js, pinned
//     to the same version as the elk.bundled.js in index.html and driven from
//     the page with `new ELK({workerFactory})`, so elkjs's own protocol runs
//     on both sides and the main thread keeps panning, zooming and responding
//     while ELK thinks.  If the worker cannot be created — a
//     Content-Security-Policy with a `worker-src` that forbids `blob:`, say —
//     or it fails, or it does not answer within a deadline, the layout falls
//     back to the main thread and yields to the event loop between phases so
//     the status line is painted before the browser freezes;
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

const NODE_H = 36;
const NODE_H2 = 46;
const JUNCTION_R = 8;
const CHAR_W = 6.9;

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
    status: p.has('status') ? split('status') : null, // null = all
    q: p.get('q') || '',
    sel: p.get('sel') || null,
  };
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

  renderToolbar(app, st);
  const view = M.makeView(app.model, st.collapse, st.expand);
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
  stage.appendChild(legend(app));

  ui = { page, toolbar, stage, svg, layer, side, transform: { x: 40, y: 40, k: 1 }, fitted: false };
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
      class: hollow ? 'arrowhead hollow' : 'arrowhead',
    }));
  return svgEl('defs', marker('bp-arrow', false), marker('bp-arrow-hollow', true));
}

function legend(app) {
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
  return el('div.legend',
    el('b', 'lines'),
    el('div.row', sample(line(), head(false)), 'declared + derived'),
    el('div.row', sample(line('hollow'), head(true)), 'declared, unwitnessed'),
    el('div.row', sample(line('dashed'), head(false)), 'derived, undeclared'),
    el('b', { style: { marginTop: '.3em' } }, 'fill'),
    swatch('proved', 'proved'),
    swatch('proved_with_axioms', 'extra axioms'),
    swatch('stated', 'stated'),
    swatch('missing', 'missing'),
    swatch('absent', 'absent'),
    swatch('none', 'no Lean ref'));
}

// ---------------------------------------------------------------------------
// toolbar
// ---------------------------------------------------------------------------

function renderToolbar(app, st) {
  const { el, clear } = app;
  const m = app.model;
  const bar = clear(ui.toolbar);

  // collapse kind
  const kindSel = el('select', {
    title: 'collapse kind driving the view',
    onchange: (e) => writeState(app, { collapse: e.target.value, expand: [], sel: null }),
  }, ...m.collapseKinds.map((k) => el('option', { value: k, selected: k === st.collapse }, k)));
  bar.appendChild(el('div.group', el('span.lbl', 'collapse'), kindSel));

  const order = M.collapseOrder(m, st.collapse);
  // Expanding everything is the one action that can put thousands of nodes on
  // screen, so the button says so rather than springing it on the reader.
  const whenExpanded = drawnNodeCount(m);
  const big = whenExpanded >= BIG_GRAPH;
  bar.appendChild(el('div.group',
    el('button', {
      onclick: () => writeState(app, { expand: [...order.expandable] }),
      title: `lay out all ${whenExpanded.toLocaleString()} objects at once`,
    }, big ? `Expand all (${whenExpanded.toLocaleString()})` : 'Expand all'),
    el('button', { onclick: () => writeState(app, { expand: [] }) }, 'Collapse all')));

  bar.appendChild(el('div.sep'));

  // edge kind filter
  const eks = M.edgeKinds(m).filter((k) => k !== st.collapse);
  const on = st.ekinds ? new Set(st.ekinds) : new Set(eks);
  bar.appendChild(el('div.group', el('span.lbl', 'edges'),
    ...eks.map((k) => el('label.chk',
      el('input', {
        type: 'checkbox', checked: on.has(k),
        onchange: (e) => {
          const next = new Set(on);
          if (e.target.checked) next.add(k); else next.delete(k);
          writeState(app, { ekinds: filterValue(next, eks) });
        },
      }), k))));

  bar.appendChild(el('div.sep'));

  // status filter
  const sOn = st.status ? new Set(st.status) : new Set(M.STATUSES);
  bar.appendChild(el('div.group', el('span.lbl', 'status'),
    ...M.STATUSES.map((s) => el('label.chk', { class: 'st-chip status-' + s, title: M.STATUS_LABEL[s] },
      el('input', {
        type: 'checkbox', checked: sOn.has(s),
        onchange: (e) => {
          const next = new Set(sOn);
          if (e.target.checked) next.add(s); else next.delete(s);
          writeState(app, { status: filterValue(next, M.STATUSES) });
        },
      }), s.replace('proved_with_axioms', 'axioms')))));

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
  bar.appendChild(el('div.group', search));
  bar.appendChild(el('div.group',
    el('button', { onclick: () => fitToView(app) , title: 'fit the graph into the viewport' }, 'Fit'),
    el('button', { onclick: () => zoomBy(app, 1.25) }, '+'),
    el('button', { onclick: () => zoomBy(app, 1 / 1.25) }, '\u2212')));
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

function labelWidth(text, min, max) {
  return Math.max(min, Math.min(max, Math.round(text.length * CHAR_W) + 26));
}

/**
 * Turn the quotient into an ELK graph.
 * Visible expanded objects become compound nodes containing their children;
 * leaves are ordinary nodes; grouped binary items become ELK edges; junction
 * items become small nodes with one ELK edge per end.
 */
export function buildElk(app, st, view, quot) {
  const m = app.model;
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
    const prog = M.progressOf(m, st.collapse, id);
    const node = {
      id,
      bp: { kind: 'object', id, object: o, compound, title, prog },
      children: [],
      layoutOptions: {},
    };
    if (compound) {
      node.layoutOptions['elk.padding'] = '[top=34,left=16,bottom=16,right=16]';
      node.layoutOptions['elk.spacing.nodeNode'] = '22';
      node.layoutOptions['elk.algorithm'] = 'layered';
      node.layoutOptions['elk.direction'] = 'DOWN';
    } else {
      node.width = labelWidth(title, 104, 230);
      node.height = prog && prog.total > 1 ? NODE_H2 : NODE_H;
    }
    return node;
  };

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
      node.width = labelWidth(node.bp.title, 120, 230);
      node.height = NODE_H2;
      delete node.children;
    }
  }

  // --- drawn entities ------------------------------------------------------
  const keepEntity = (e) => !enabledKinds || enabledKinds.has(e.kind);
  const kept = quot.edges.filter(keepEntity);
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
      for (const end of item.ends) {
        if (!drawable(end.id)) continue;
        const isSrc = end.roles.includes('src');
        edges.push({
          id: jid + '|' + end.id,
          sources: [isSrc ? nodeKey(end.id) : jid],
          targets: [isSrc ? jid : nodeKey(end.id)],
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
      edges.push({
        id: e.id,
        sources: [nodeKey(e.src)],
        targets: [nodeKey(e.tgt)],
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
  return { graph, nodes, edgeMeta };
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
    'elk.layered.mergeEdges': 'true',
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
// layout + draw
// ---------------------------------------------------------------------------

function signatureOf(st) {
  return JSON.stringify([st.collapse, [...st.expand].sort(), st.ekinds, st.status]);
}

async function scheduleLayout(app, st, view, quot) {
  const status = ui.stage.querySelector('#graph-status');
  if (!window.ELK && !elkScriptUrl()) {
    status.textContent = 'ELK could not be loaded from the CDN; the graph needs it.';
    return;
  }

  const sig = signatureOf(st);
  const structureChanged = sig !== lastSignature;
  lastSignature = sig;

  const { graph, nodes, edgeMeta } = buildElk(app, st, view, quot);
  const token = ++layoutToken;

  const n = countNodes(graph);
  status.textContent = `laying out ${n.toLocaleString()} node${n === 1 ? '' : 's'}\u2026`;
  ui.stage.classList.add('laying-out');

  clearLayoutError();
  try {
    const laid = await layoutGraph(plainGraph(graph));
    if (token !== layoutToken) return; // superseded
    ui.stage.classList.remove('laying-out');
    draw(app, st, view, quot, laid, nodes, edgeMeta, structureChanged);
    const nCount = countNodes(laid);
    status.textContent = `${nCount.toLocaleString()} nodes, ${(laid.edges || []).length} links \u2014 ` +
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
    showLayoutError(app, msg);
    lastSignature = null; // the next attempt is a fresh one, not a redraw
  }
}

/** A red line in the graph pane; the status line alone is easy to miss. */
function showLayoutError(app, message) {
  clearLayoutError();
  if (!ui) return;
  ui.errorEl = app.el('div.graph-error', 'Layout failed: ' + message);
  ui.stage.appendChild(ui.errorEl);
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

/** The pinned elk.bundled.js URL, taken from the tag index.html already has. */
function elkScriptUrl() {
  if (typeof document === 'undefined' || !document.querySelector) return null;
  const tag = document.querySelector('script[src*="elk"]');
  return tag ? tag.getAttribute('src') : null;
}

/**
 * elk-worker.min.js beside it on the same CDN: the same pinned version, the
 * file name swapped, so the version still lives in exactly one place —
 * index.html's script tag.
 */
function elkWorkerUrl() {
  const url = elkScriptUrl();
  if (!url) return null;
  try {
    return new URL('elk-worker.min.js', new URL(url, location.href)).href;
  } catch (e) {
    return null;
  }
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
function ensureWorkerElk() {
  if (workerElk || workerBroken) return workerElk;
  // The CDN bundle may simply not have arrived yet; that is not a verdict on
  // workers, so it is worth asking again next time.
  if (!window.ELK) return null;
  const src = elkWorkerUrl();
  if (!src || typeof Worker !== 'function' || typeof Blob !== 'function' ||
      typeof URL === 'undefined' || !URL.createObjectURL) {
    workerBroken = true;
    return null;
  }
  const source = `importScripts(${JSON.stringify(src)});\n`;
  let objectUrl = null;
  try {
    objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    workerElk = new window.ELK({
      workerFactory: () => {
        const w = new Worker(objectUrl);
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

function layoutGraph(graph) {
  const inst = ensureWorkerElk();
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
      gCompounds.appendChild(drawNode(app, box, meta, st, view));
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
    gEdges.appendChild(drawEdge(app, meta, pts, a, b));
  }

  // --- transitions ---------------------------------------------------------
  if (animate) {
    layer.classList.remove('no-anim');
    for (const [id, box] of abs) {
      const g = layer.querySelector(`[data-nid="${cssEscape(id)}"]`);
      if (!g) continue;
      const prev = prevPos.get(id);
      if (prev && (prev.x !== box.x || prev.y !== box.y)) {
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

  ui.bbox = bboxOf(abs);
  if (!ui.fitted) { fitToView(app); ui.fitted = true; } else applyTransform();
  applyHighlight(app, st.q);
  applySelection(app, st.sel);
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// --- node shapes -----------------------------------------------------------

const KIND_RX = { section: 4, theorem: 16, definition: 3, lemma: 10 };

function drawNode(app, box, meta, st, view) {
  const { svgEl } = app;
  const m = app.model;
  const o = meta.object;
  const status = M.statusOf(m, o.id);
  const rx = KIND_RX[o.kind] !== undefined ? KIND_RX[o.kind] : 8;
  const g = svgEl('g', {
    class: 'gnode' + (meta.compound ? ' compound' : '') + ' kind-' + o.kind +
      ' status-' + (status || 'none'),
    transform: `translate(${box.x},${box.y})`,
    'data-nid': box.node.id,
    'data-id': o.id,
    tabindex: 0,
  });
  g.appendChild(svgEl('rect', {
    class: 'shape', x: 0, y: 0, width: box.w, height: box.h, rx, ry: rx,
  }));

  const title = M.titleOf(o);
  const maxChars = Math.max(6, Math.floor((box.w - 20) / CHAR_W));
  const shown = title.length > maxChars ? title.slice(0, maxChars - 1) + '\u2026' : title;
  const ty = meta.compound ? 21 : box.h / 2 + (meta.prog && meta.prog.total > 1 ? -4 : 4);
  g.appendChild(svgEl('text', {
    class: 'label', x: meta.compound ? 12 : box.w / 2, y: ty,
    'text-anchor': meta.compound ? 'start' : 'middle',
  }, shown));

  g.appendChild(svgEl('text', {
    class: 'kindmark', x: box.w - 6, y: 12, 'text-anchor': 'end',
  }, o.kind.slice(0, 3)));

  const prog = meta.prog;
  if (prog && prog.total > 1 && !meta.compound) {
    const w = box.w - 24;
    const frac = prog.total ? prog.proved / prog.total : 0;
    g.appendChild(svgEl('rect', { class: 'ptrack', x: 12, y: box.h - 14, width: w, height: 5, rx: 2.5 }));
    g.appendChild(svgEl('rect', { class: 'pfill', x: 12, y: box.h - 14, width: Math.max(0, w * frac), height: 5, rx: 2.5 }));
  }
  if (view.isExpandable(o.id)) {
    g.appendChild(svgEl('text', { class: 'expander', x: 8, y: meta.compound ? 21 : box.h / 2 + 4 },
      view.isExpanded(o.id) ? '\u2212' : '+'));
    if (!meta.compound) g.querySelector('.label').setAttribute('x', box.w / 2 + 5);
  }

  const title2 = `${o.id}\n${o.kind}` + (status ? `\nstatus: ${M.STATUS_LABEL[status]}` : '') +
    (prog ? `\nprogress: ${prog.proved}/${prog.total}` : '');
  g.appendChild(svgEl('title', title2));
  wireNode(app, g, o.id, view);
  return g;
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

function wireNode(app, g, id, view) {
  g.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (panSuppressClick) return; // the click that ends a pan
    select(app, id);
  });
  g.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
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
        `${kind}: ${entity.src} \u2192 ${entity.tgt}`,
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
}

function toggleExpand(app, id, view) {
  if (!view.isExpandable(id)) return;
  const next = view.isExpanded(id)
    ? M.collapse(view.order, view.expanded, id)
    : M.expand(view.order, view.expanded, id);
  writeState(app, { expand: [...next], sel: id });
}

function applySelection(app, id) {
  for (const g of ui.layer.querySelectorAll('.gnode.selected')) g.classList.remove('selected');
  if (!id) return;
  for (const g of ui.layer.querySelectorAll(`.gnode[data-id="${cssEscape(id)}"]`)) {
    g.classList.add('selected');
  }
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

  stage.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = {
      x: ev.clientX, y: ev.clientY,
      tx: ui.transform.x, ty: ui.transform.y,
      moved: false,
      // Pointer capture retargets later events to the stage, so remember what
      // was actually under the pointer when the drag started.
      target: ev.target,
    };
    try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    stage.classList.add('panning');
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    ui.transform.x = drag.tx + dx;
    ui.transform.y = drag.ty + dy;
    applyTransform(true);
  });
  const end = (ev) => {
    if (!drag) return;
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
  const m = app.model;
  const side = clear(ui.side);
  const id = st.sel;
  const o = id ? m.byId.get(id) : null;

  if (!o) {
    side.appendChild(el('h2', 'Nothing selected'));
    side.appendChild(el('p.hint',
      'Click a node to inspect it, double-click (or press Enter) to expand or collapse it. ',
      'Drag to pan, scroll to zoom.'));
    side.appendChild(el('section',
      el('h3', 'This view'),
      el('ul',
        el('li', el('b', String(view.visible.size)), ' visible objects'),
        el('li', el('b', String(quot.items.length)), ' drawn relations'),
        el('li', el('b', String([...quot.internal.values()].reduce((a, b) => a + b.length, 0))),
          ' relations hidden inside collapsed objects'),
        el('li', el('b', String(quot.edges.filter((e) => e.synthetic).length)),
          ' synthesised derived-only arcs'))));
    return;
  }

  const status = M.statusOf(m, id);
  side.appendChild(el('h2', M.titleOf(o)));
  side.appendChild(el('div.meta', app.kindBadge(o.kind), status === null ? null : app.statusBadge(status)));
  side.appendChild(el('div.obj-id', id));

  const prog = M.progressOf(m, st.collapse, id);
  if (prog) {
    side.appendChild(el('section', el('h3', 'Progress (' + st.collapse + ')'), app.progressBar(prog)));
  }

  if (view.isExpandable(id)) {
    side.appendChild(el('section',
      el('button', { onclick: () => toggleExpand(app, id, view) },
        view.isExpanded(id) ? 'Collapse' : 'Expand',
        ' (', String(M.childrenOf(view.order, id).length), ' children)')));
  }

  if (o.boundary.length) {
    side.appendChild(el('section', el('h3', 'Boundary'),
      el('ul.objlist', ...o.boundary.map((b) =>
        el('li', el('span.role', b.role), app.objLink(m, b.id))))));
  }

  const inc = M.incidentTo(m, id);
  if (inc.length) {
    side.appendChild(el('section', el('h3', `Incident objects (${inc.length})`),
      el('ul.objlist', ...inc.slice(0, 14).map((r) =>
        el('li', el('span.role', r.role), app.objLink(m, r.object.id),
          el('span.chip', r.object.kind))),
      inc.length > 14 ? el('li.muted.small', `+${inc.length - 14} more`) : null)));
  }

  const hidden = quot.internal.get(id);
  if (hidden && hidden.length) {
    side.appendChild(el('section', el('h3', `Hidden inside (${hidden.length})`),
      el('p.hint', 'Relations whose ends all collapse into this object.'),
      el('ul.objlist', ...hidden.slice(0, 10).map((h) => el('li', app.objLink(m, h))))));
  }

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

  side.appendChild(el('section',
    el('a', { href: app.objectHref(id) }, 'Open object page \u2192')));
}

function excerpt(body, n) {
  if (body.length <= n) return body;
  const cut = body.slice(0, n);
  const at = cut.lastIndexOf('\n\n');
  return (at > n * 0.4 ? cut.slice(0, at) : cut) + '\n\n\u2026';
}
