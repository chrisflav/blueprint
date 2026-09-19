// web/test/app.test.mjs
//
// The parts of the site that need a DOM: the KaTeX options every page renders
// with, the document view's lazy rendering, and the graph's ELK worker.
//
//   nix-shell -p nodejs_22 --run "node web/test/app.test.mjs"
//
// No browser, no network: `dom-shim.mjs` supplies just enough DOM, and marked,
// KaTeX and ELK are stand-ins that record what they were asked to do.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { setupDom, fakeMarked, fakeKatex } from './dom-shim.mjs';
import { generate } from './gen-large.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..');
const sample = JSON.parse(fs.readFileSync(path.join(webDir, 'sample', 'blueprint.json'), 'utf8'));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, message: (e && e.stack) || String(e) });
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected true');
}
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

// ---------------------------------------------------------------------------
// boot the app on the sample snapshot
// ---------------------------------------------------------------------------

const dom = setupDom({
  ids: ['app', 'banner', 'project-title', 'topbar-aside', 'tabs'],
  base: webDir,
  snapshot: sample,
});

// index.html's pinned ELK tag: graph.js reads the worker's script URL off it.
const elkTag = dom.document.createElement('script');
elkTag.setAttribute('src', 'https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js');
dom.document.documentElement.appendChild(elkTag);

global.window.marked = fakeMarked();
const katex = fakeKatex();
global.window.renderMathInElement = katex;

global.location.hash = '#/object/def-compact';
const app = (await import(path.join(webDir, 'app.js'))).default;
await tick(20);

const root = dom.document.getElementById('app');
const go = async (hash) => {
  global.location.hash = hash;
  global.window.dispatch('hashchange', {});
  await tick(5);
};

// ---------------------------------------------------------------------------
// 1. KaTeX options
// ---------------------------------------------------------------------------

await check('the app loaded the snapshot', () => {
  ok(app.model, 'no model');
  eq(app.model.objects.length, 53, 'object count');
});

await check('every route renders without falling over', async () => {
  for (const hash of ['#/graph', '#/document', '#/progress', '#/checks',
    '#/object/thm-tychonoff', '#/object/does-not-exist', '#/nonsense']) {
    await go(hash);
    if (hash === '#/object/does-not-exist') {
      eq(root.querySelectorAll('.error-box').length, 1, 'a missing object says so');
    } else {
      eq(root.querySelectorAll('.error-box').length, 0, `${hash} threw`);
    }
    ok(root.childNodes.length > 0, `${hash} rendered nothing`);
  }
  await go('#/object/def-compact');
});

await check('auto-render is given the project macros, on the object page', () => {
  ok(katex.calls.length > 0, 'KaTeX was never called');
  const { options } = katex.calls[katex.calls.length - 1];
  eq(options.macros['\\Opens'], '\\mathrm{Open}', 'a plain macro');
  eq(options.macros['\\cover'], '\\mathcal{#1}', 'a macro with an argument');
});

await check('every failure mode is off and both delimiter styles are on', () => {
  const { options } = katex.calls[katex.calls.length - 1];
  eq(options.throwOnError, false, 'throwOnError');
  eq(typeof options.errorCallback, 'function', 'errorCallback');
  const pairs = options.delimiters.map((d) => d.left + d.right);
  for (const want of ['$$$$', '\\[\\]', '$$', '\\(\\)']) {
    ok(pairs.includes(want), `delimiter ${want} is missing`);
  }
  const display = new Map(options.delimiters.map((d) => [d.left, d.display]));
  eq(display.get('\\['), true, '\\[ is display maths');
  eq(display.get('\\('), false, '\\( is inline maths');
  ok(options.delimiters.findIndex((d) => d.left === '$$') <
     options.delimiters.findIndex((d) => d.left === '$'),
  '$$ must be tried before $');
});

await check('the same options reach the document view', async () => {
  katex.reset();
  await go('#/document');
  // The prose is rendered when it comes into view; in the shim nothing scrolls,
  // so say so explicitly.
  dom.observers.flush();
  ok(katex.calls.length > 0, 'the document rendered no bodies');
  for (const { options } of katex.calls) {
    eq(options.macros['\\Opens'], '\\mathrm{Open}', 'macros on every call');
  }
});

await check('the same options reach the graph side panel', async () => {
  katex.reset();
  await go('#/graph?sel=def-compact');
  ok(katex.calls.length > 0, 'the side panel rendered no prose');
  eq(katex.calls[0].options.macros['\\cover'], '\\mathcal{#1}', 'macros in the side panel');
});

await check('one broken formula does not take the page with it', async () => {
  const boom = (rootNode, options) => {
    boom.calls.push({ root: rootNode, options });
    throw new Error('KaTeX exploded');
  };
  boom.calls = [];
  global.window.renderMathInElement = boom;
  try {
    await go('#/object/def-compact');
    ok(boom.calls.length > 0, 'KaTeX was not called');
    ok(root.querySelectorAll('.body-prose').length > 0, 'the prose element is gone');
    eq(root.querySelectorAll('.error-box').length, 0, 'the page fell over');
    ok(root.querySelectorAll('.objlink').length > 0, 'the [slug] pass did not run');
  } finally {
    global.window.renderMathInElement = katex;
  }
});

await check('a snapshot without macros gets an empty macro table', async () => {
  const before = app.katexOptions().macros;
  eq(before['\\Opens'], '\\mathrm{Open}', 'the sample has macros');
  await app.showSnapshot({ sha: 'x', date: '2026-01-01', file: 'sample/real/blueprint.json' });
  await tick(5);
  const after = app.katexOptions().macros;
  eq(typeof after, 'object', 'still an object');
  eq(after['\\Opens'], undefined, 'the previous snapshot’s macros leaked into it');
  eq(after['\\cover'], undefined, 'the previous snapshot’s macros leaked into it');
  await app.showSnapshot(null);
  await tick(5);
  eq(app.katexOptions().macros['\\Opens'], '\\mathrm{Open}', 'back to the current snapshot');
});

// ---------------------------------------------------------------------------
// 2. the document view renders lazily
// ---------------------------------------------------------------------------

const documentPage = await import(path.join(webDir, 'document.js'));
const modelMod = await import(path.join(webDir, 'model.js'));

// A blueprint too big to render eagerly, but small enough for a unit test.
const big = JSON.parse(JSON.stringify(generate({
  chapters: 3, sectionsPerChapter: 3, subsectionsPerSection: 2,
  definitions: 90, lemmas: 60, theorems: 40, propositions: 10, usesEdges: 120,
})));

const withBigSnapshot = async (fn) => {
  const keep = { snapshot: app.snapshot, model: app.model, route: app.route };
  app.snapshot = big;
  app.model = modelMod.buildModel(big);
  try {
    await fn();
  } finally {
    app.snapshot = keep.snapshot;
    app.model = keep.model;
    app.route = keep.route;
  }
};

const settle = async (flow) => {
  let last = -1;
  for (let i = 0; i < 200 && last !== flow.childNodes.length; i += 1) {
    last = flow.childNodes.length;
    await tick(0);
  }
};

await check('the document view defers headings and prose', async () => {
  await withBigSnapshot(async () => {
    app.route = { view: 'document', id: null, params: new URLSearchParams(), raw: '/document' };
    katex.reset();
    documentPage.render(root, app);

    const first = root.querySelectorAll('.doc-entry').length;
    ok(first > 0, 'nothing was rendered at all');
    ok(first <= 40, `the first paint built ${first} sections, not a screenful`);
    eq(katex.calls.length, 0, 'no prose should be rendered before it is scrolled to');
    ok(dom.observers.pending() > 0, 'nothing was handed to the observer');

    const flow = root.querySelectorAll('.doc-layout')[0].children[1];
    await settle(flow);
    const all = root.querySelectorAll('.doc-entry').length;
    ok(all > first, `the rest of the document never arrived (${all})`);
    eq(katex.calls.length, 0, 'still no prose, only headings');

    // Now the reader scrolls through all of it.
    const rendered = dom.observers.flush();
    ok(rendered > 100, `only ${rendered} bodies were rendered on scroll`);
    ok(katex.calls.length > 100, `only ${katex.calls.length} KaTeX passes`);
    eq(dom.observers.pending(), 0, 'everything was handed over exactly once');
  });
});

await check('a focused section is built even when it is far down', async () => {
  await withBigSnapshot(async () => {
    const order = modelMod.collapseOrder(app.model, 'refines');
    const entries = modelMod.readingOrder(app.model, 'refines')
      .filter((e) => e.object && e.object.kind !== 'refines' &&
        ((e.object.body && e.object.body.trim()) || modelMod.childrenOf(order, e.id).length));
    const target = entries[entries.length - 1].id;
    app.route = {
      view: 'document', id: null,
      params: new URLSearchParams({ focus: target }), raw: '/document',
    };
    documentPage.render(root, app);
    const anchor = 'doc-' + String(target).replace(/[^A-Za-z0-9_-]/g, '_');
    const flow = root.querySelectorAll('.doc-layout')[0].children[1];
    ok(flow.childNodes.length < 60, 'the focus was reached by building everything at once');
    await settle(flow);
    ok(dom.document.getElementById(anchor), `the focused section ${target} was never built`);
  });
});

await check('without an IntersectionObserver everything renders at once', async () => {
  const keep = global.IntersectionObserver;
  global.IntersectionObserver = undefined;
  try {
    await withBigSnapshot(async () => {
      app.route = { view: 'document', id: null, params: new URLSearchParams(), raw: '/document' };
      katex.reset();
      documentPage.render(root, app);
      ok(katex.calls.length > 0, 'the fallback rendered no prose');
    });
  } finally {
    global.IntersectionObserver = keep;
  }
});

// ---------------------------------------------------------------------------
// 3. the graph lays out in a worker
// ---------------------------------------------------------------------------

/** A stand-in layouter: boxes in a column, edges as straight segments. */
function fakeLayout(graph) {
  let y = 0;
  const place = (n) => {
    n.x = 0;
    n.y = y;
    n.width = n.width || 120;
    n.height = n.height || 40;
    y += n.height + 10;
    for (const c of n.children || []) place(c);
  };
  for (const c of graph.children || []) place(c);
  for (const e of graph.edges || []) {
    e.sections = [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 0 } }];
  }
  graph.width = 400;
  graph.height = Math.max(1, y);
  return graph;
}

function hasBp(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'bp')) return true;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    if (hasBp(v)) return true;
  }
  return false;
}

const statusText = () => root.querySelectorAll('.graph-status')[0].textContent;

await check('the graph lays out in a Blob worker that imports the pinned ELK', async () => {
  global.window.ELK = function FakeELK() {
    return { layout: async (g) => fakeLayout(g) };
  };
  await go('#/graph');

  // One worker for the page, reused for every layout.
  eq(dom.workers.created.length, 1, 'expected exactly one worker');
  const w = dom.workers.created[0];
  ok(String(w.url).startsWith('blob:'), `the worker came from ${w.url}, not a blob`);
  ok(w.source.includes('importScripts('), 'the worker does not import anything');
  ok(w.source.includes('elkjs@0.9.3/lib/elk.bundled.js'),
    'the worker does not import the pinned ELK from index.html');
  ok(w.source.includes('elk.layout('), 'the worker does not lay anything out');

  ok(w.messages.length > 0, 'nothing was posted to the worker');
  const { id, graph } = w.messages[w.messages.length - 1];
  ok(typeof id === 'number', 'the request carries no id');
  ok(!hasBp(graph), 'the model back-references were posted to the worker');
  ok(graph.children.length > 0, 'an empty graph was posted');

  ok(/laying out \d+ nodes?/.test(statusText()), `status was "${statusText()}"`);
  eq(root.querySelectorAll('.gnode').length, 0, 'the graph was drawn before ELK answered');

  w.reply({ id, laid: fakeLayout(JSON.parse(JSON.stringify(graph))) });
  await tick(5);

  ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn from the worker’s answer');
  ok(/nodes, \d+ links/.test(statusText()), `status stayed at "${statusText()}"`);
});

await check('node and edge metadata survives the round trip through the worker', async () => {
  // The worker answers with a plain graph, so everything the drawing needs has
  // to be looked up again by id.  These are the bits that would go missing.
  const nodes = root.querySelectorAll('.gnode');
  ok(nodes.length > 0, 'no nodes');
  for (const n of nodes) {
    ok(n.getAttribute('data-id'), 'a node without an object id');
    ok(app.model.byId.has(n.getAttribute('data-id')), 'a node whose id is not in the model');
  }
  ok(nodes.some((n) => n.classList.contains('kind-section')), 'no section node was drawn');
  const edges = root.querySelectorAll('.gedge');
  ok(edges.length > 0, 'no edges were drawn');
  ok(edges.some((e) => e.classList.contains('kind-uses')), 'no uses edge kept its kind');
});

await check('a blocked worker falls back to laying out on the main thread', async () => {
  dom.workers.enabled = false;
  dom.workers.created.length = 0;
  let mainThreadLayouts = 0;
  global.window.ELK = function FakeELK() {
    return {
      layout: async (g) => { mainThreadLayouts += 1; return fakeLayout(g); },
    };
  };
  try {
    // A fresh module instance, so the worker is attempted again from scratch.
    const graphPage = await import(path.join(webDir, 'graph.js') + '?fallback');
    app.route = { view: 'graph', id: null, params: new URLSearchParams(), raw: '/graph' };
    graphPage.render(root, app);
    await tick(30);
    eq(dom.workers.created.length, 0, 'a worker was created even though they are blocked');
    ok(mainThreadLayouts > 0, 'the main-thread fallback never ran');
    ok(root.querySelectorAll('.gnode').length > 0, 'the fallback drew nothing');
  } finally {
    dom.workers.enabled = true;
  }
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
