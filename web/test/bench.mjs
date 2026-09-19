// web/test/bench.mjs — the performance harness for a blueprint of the size the
// real project has (see gen-large.mjs).
//
//   nix-shell -p nodejs_22 --run "node web/test/bench.mjs"
//
// It measures, on a ~8,100-object snapshot (3,300 nodes, 3,300 refines edges,
// 1,500 uses edges):
//
//   * buildModel / indexing;
//   * quotient() at the fully collapsed view, at "all chapters expanded", and
//     at the fully expanded view;
//   * ELK layout for the collapsed and chapters-expanded views;
//   * the document view's render cost in the DOM shim;
//   * search.
//
// ELK is not vendored.  Point the harness at a copy of elk.bundled.js:
//
//   curl -sLo /tmp/elk.bundled.js https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js
//   nix-shell -p nodejs_22 --run "node web/test/bench.mjs --elk=/tmp/elk.bundled.js"
//
// or set BLUEPRINT_ELK.  Without it the layout rows are skipped and everything
// else still runs.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-large.mjs';
import { setupDom, fakeMarked, fakeKatex } from './dom-shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..');
const require = createRequire(import.meta.url);

const argElk = (process.argv.find((a) => a.startsWith('--elk=')) || '').slice(6);
const ELK_PATH = argElk || process.env.BLUEPRINT_ELK || '';

// --- timing -----------------------------------------------------------------

const rows = [];

function time(label, fn, { repeat = 1, detail = null } = {}) {
  let out;
  const t0 = performance.now();
  for (let i = 0; i < repeat; i += 1) out = fn();
  const ms = (performance.now() - t0) / repeat;
  rows.push({ label, ms, detail: typeof detail === 'function' ? detail(out) : detail });
  return out;
}

async function timeAsync(label, fn, { detail = null } = {}) {
  const t0 = performance.now();
  const out = await fn();
  const ms = performance.now() - t0;
  rows.push({ label, ms, detail: typeof detail === 'function' ? detail(out) : detail });
  return out;
}

function report() {
  const w = Math.max(...rows.map((r) => r.label.length));
  process.stdout.write('\n');
  for (const r of rows) {
    const ms = r.ms === null ? '  skipped' : `${r.ms.toFixed(1).padStart(8)} ms`;
    process.stdout.write(`  ${r.label.padEnd(w)}  ${ms}${r.detail ? '   ' + r.detail : ''}\n`);
  }
  process.stdout.write('\n');
}

// --- the snapshot -----------------------------------------------------------

const snapshot = time('generate the snapshot', () => generate(), {
  detail: (s) => `${s.objects.length} objects`,
});

// The app parses JSON off the wire, so do that too rather than handing the
// pages the generator's own object graph.
const json = JSON.stringify(snapshot);
const parsed = time('JSON.parse', () => JSON.parse(json), {
  detail: () => `${(json.length / 1e6).toFixed(1)} MB`,
});

// --- 1. indexing ------------------------------------------------------------

const M = await import(path.join(webDir, 'model.js'));

const model = time('buildModel (indexing)', () => M.buildModel(parsed), {
  detail: (m) => `${m.objects.length} objects, ${m.byKind.size} kinds`,
});
const order = time('collapseOrder("refines")', () => M.collapseOrder(model, 'refines'), {
  detail: (o) => `${o.expandable.size} expandable`,
});

const chapters = [...order.roots].filter((id) => order.expandable.has(id));
const everything = [...order.expandable];

// --- 2. views and the quotient ---------------------------------------------

const VIEWS = [
  ['collapsed', []],
  ['chapters expanded', chapters],
  ['everything expanded', everything],
];

const views = new Map();
for (const [label, expand] of VIEWS) {
  const v = time(`makeView (${label})`, () => M.makeView(model, 'refines', expand), {
    detail: (x) => `${x.visible.size} visible, ${x.expanded.size} expanded`,
  });
  views.set(label, v);
  time(`quotient (${label})`, () => M.quotient(v), {
    detail: (q) => `${q.items.length} items, ${q.edges.length} drawn`,
  });
}

// A fresh view each time: this is what expand/collapse actually costs, and it
// is where a stale cache would hide.
time('expand one chapter, from scratch', () => {
  const v = M.makeView(model, 'refines', []);
  const v2 = v.expand(chapters[0]);
  return M.quotient(v2);
}, { repeat: 3, detail: (q) => `${q.edges.length} drawn` });

// --- 3. search ---------------------------------------------------------------

// Three different costs: the very first search (which has to lowercase every
// body), any later search, and re-asking the same question.
time('search: first query', () => M.searchIds(model, 'compact'), {
  detail: (s) => `${s.size} hits`,
});
let qn = 0;
time('search: another query', () => M.searchIds(model, `space${qn += 1}`), {
  repeat: 5,
  detail: () => 'a query not seen before, each time',
});
time('search: the same query again', () => M.searchIds(model, 'compact'), {
  repeat: 20,
  detail: (s) => `${s.size} hits`,
});

// --- 4. ELK layout -----------------------------------------------------------

function countNodes(n) {
  let c = 0;
  const walk = (x) => { for (const ch of x.children || []) { c += 1; walk(ch); } };
  walk(n);
  return c;
}

const graphMod = await import(path.join(webDir, 'graph.js'));

let elk = null;
if (ELK_PATH && fs.existsSync(ELK_PATH)) {
  const mod = require(path.resolve(ELK_PATH));
  const ELK = mod.default || mod;
  elk = new ELK();
} else {
  rows.push({ label: 'ELK layout', ms: null, detail: 'no elk.bundled.js (see the header)' });
}

const LAYOUTS = ['collapsed', 'chapters expanded', 'everything expanded'];
for (const label of LAYOUTS) {
  const view = views.get(label);
  const st = { collapse: 'refines', expand: [...view.expanded], ekinds: null, status: null, q: '', sel: null };
  const built = time(`buildElk (${label})`, () => graphMod.buildElk({ model }, st, view, M.quotient(view)), {
    detail: (b) => `${countNodes(b.graph)} nodes, ${b.graph.edges.length} links`,
  });
  // What graph.js posts to the worker: the same graph without the `bp`
  // back-references into the model.
  const plain = time(`plainGraph (${label})`, () => graphMod.plainGraph(built.graph), {
    detail: (g) => `${(JSON.stringify(g).length / 1000) | 0} kB to the worker`,
  });
  if (!elk) continue;
  if (label === 'everything expanded' && !process.env.BLUEPRINT_BENCH_FULL) {
    rows.push({
      label: `ELK layout (${label})`,
      ms: null,
      detail: `${countNodes(built.graph)} nodes — set BLUEPRINT_BENCH_FULL=1 (slow)`,
    });
    continue;
  }
  // eslint-disable-next-line no-await-in-loop
  await timeAsync(`ELK layout (${label})`, () => elk.layout(plain), {
    detail: (l) => `${Math.round(l.width)}x${Math.round(l.height)}`,
  });
}

// --- 5. the document view ----------------------------------------------------

const dom = setupDom({ ids: ['app', 'banner', 'project-title', 'topbar-aside', 'tabs'], base: webDir, snapshot: parsed });
global.window.marked = fakeMarked();
global.window.renderMathInElement = fakeKatex();
global.location.hash = '#/graph';

const app = (await import(path.join(webDir, 'app.js'))).default;
await new Promise((r) => setTimeout(r, 50));
if (!app.model) throw new Error('the app did not load the snapshot');

const documentPage = await import(path.join(webDir, 'document.js'));
const root = global.document.getElementById('app');

app.route = { view: 'document', id: null, params: new URLSearchParams(), raw: '/document' };
global.window.renderMathInElement.reset();

time('document view: first render', () => documentPage.render(root, app), {
  detail: () => `${root.querySelectorAll('.doc-entry').length} sections on screen, ` +
    `${global.window.renderMathInElement.calls.length} bodies rendered, ` +
    `${dom.observers.pending()} deferred`,
});

// The chunked append runs a frame at a time; wait for it to settle.  Counting
// the flow's own children is O(1), unlike a querySelectorAll over the page.
const flow = root.querySelectorAll('.doc-layout')[0].children[1];
await timeAsync('document view: the rest of the headings', async () => {
  let last = -1;
  for (let i = 0; i < 500 && last !== flow.childNodes.length; i += 1) {
    last = flow.childNodes.length;
    await new Promise((r) => setTimeout(r, 0));
  }
}, {
  detail: () => `${flow.childNodes.length - 2} sections, ` +
    `${global.window.renderMathInElement.calls.length} bodies rendered`,
});

await timeAsync('document view: scroll through all of it', async () => {
  dom.observers.flush();
  await new Promise((r) => setTimeout(r, 50));
}, {
  detail: () => `${global.window.renderMathInElement.calls.length} bodies rendered in total`,
});

// --- 6. the other pages -------------------------------------------------------

const objectPage = await import(path.join(webDir, 'object.js'));
const progressPage = await import(path.join(webDir, 'progress.js'));
const checksPage = await import(path.join(webDir, 'checks.js'));

const someId = model.objects.find((o) => o.kind === 'theorem').id;
app.route = { view: 'object', id: someId, params: new URLSearchParams(), raw: '/object' };
time('object page', () => objectPage.render(root, app), { repeat: 3, detail: someId });

app.route = { view: 'progress', id: null, params: new URLSearchParams(), raw: '/progress' };
time('progress page', () => progressPage.render(root, app), {
  detail: () => `${root.querySelectorAll('tr').length} table rows`,
});

app.route = { view: 'checks', id: null, params: new URLSearchParams(), raw: '/checks' };
time('checks page', () => checksPage.render(root, app), {
  detail: () => `${model.checks.length} checks`,
});

report();
