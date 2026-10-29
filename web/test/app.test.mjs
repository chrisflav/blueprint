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
  ids: ['app', 'banner', 'project-title', 'topbar-aside', 'tabs',
    'gsearch-input', 'gsearch-panel', 'gsearch-results', 'gsearch-foot', 'export-pdf'],
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
const { shieldMath, THEMES, applyTheme, currentTheme, currentShowProgress } = await import(path.join(webDir, 'app.js'));

await check('math shielding preserves wrapped formulas and numeric starts', () => {
  for (const formula of [
    '$\\gamma_{p,K}=c^{-1}\\circ\\gamma_{p,Rq^{!}K}\\circ\nLp^{*}(\\gamma_{q,K})(c)[2c]$',
    '$0=[0]$',
    '$2x_1*x_2 < 3$',
    '$H^0(Z,Rz^{!}K)[2c]=\nH^{2c}_{z(Z)}(E,K)$',
    '\\[A[n]\\]',
  ]) {
    const src = `Before ${formula}, see [def-compact].`;
    const { text, restore } = shieldMath(src);
    ok(!text.includes(formula), 'formula was not shielded');
    ok(!text.includes('[2c]'), 'a shift escaped the math span');
    eq(restore(text), `Before ${formula.replace(/</g, '&lt;')}, see [def-compact].`, 'round trip');
    eq((text.match(/MATH\d+/g) || []).length, 1, 'one complete math span');
  }
  const code = '`$A[n]$`\n\n```tex\n$B[2]$\n```';
  eq(shieldMath(code).text, code, 'code remains with Markdown');
});

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
  eq(app.model.objects.length, 55, 'object count');
});

await check('the progress starts hidden until the reader shows it', () => {
  eq(app.showProgress, false, 'shown to a reader who has not asked for it');
  eq(dom.document.documentElement.getAttribute('data-progress'), 'hidden', 'the Progress tab is not hidden');
  const toggle = dom.document.getElementById('topbar-aside').querySelector('button.progress-toggle');
  eq(toggle && toggle.textContent, 'Show progress', 'the top bar offers to show it');
  const store = new Map();
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  try {
    eq(currentShowProgress(), false, 'no choice: hidden');
    store.set('blueprint.progress', 'shown');
    eq(currentShowProgress(), true, 'the reader showed it');
    store.set('blueprint.progress', 'hidden');
    eq(currentShowProgress(), false, 'the reader hid it');
  } finally {
    delete global.localStorage;
  }
});

// The rest of the suite covers the progress too: show it.
app.setShowProgress(true);
await tick(5);

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
  await go('#/document?depth=1');
  // The prose is rendered when it comes into view; in the shim nothing scrolls,
  // so say so explicitly.
  dom.observers.flush();
  ok(katex.calls.length > 0, 'the document rendered no bodies');
  for (const { options } of katex.calls) {
    eq(options.macros['\\Opens'], '\\mathrm{Open}', 'macros on every call');
  }
});

await check('a proof is set after its statement, with no number of its own', async () => {
  await go('#/document/sec-applications');
  const proofs = root.querySelectorAll('.proof');
  eq(proofs.length, 1, 'one proof on the page');
  eq(proofs[0].getAttribute('id'), 'doc-proof_thm-heine-borel', 'its anchor');
  eq(proofs[0].querySelector('.proof-word').textContent, 'Proof.', 'the lead word');
  eq(proofs[0].querySelector('.proof-end').textContent, '\u220e', 'the end mark');
  await go('#/object/' + encodeURIComponent('proof/thm-heine-borel'));
  eq(root.querySelectorAll('.error-box').length, 0, 'the proof has an object page');
});

await check('every theme has its stylesheet, and picking one loads it', async () => {
  for (const t of THEMES) {
    if (t.id) ok(fs.existsSync(path.join(webDir, 'themes', t.id + '.css')), `themes/${t.id}.css is missing`);
  }
  applyTheme('outline');
  eq(dom.document.getElementById('theme-css').getAttribute('href'), 'themes/outline.css', 'the theme is loaded');
  eq(dom.document.documentElement.getAttribute('data-sidebar'), 'outline', 'and asks for its sidebar');
  await go('#/document/sec-applications');
  ok(root.querySelector('nav.toc.toc-outline'), 'the document draws the outline sidebar');
  ok(root.querySelector('nav.toc-outline li.current'), 'with this page marked');
  applyTheme('article');
  eq(dom.document.documentElement.getAttribute('data-sidebar'), null, 'another theme drops the sidebar');
  applyTheme('');
  eq(dom.document.getElementById('theme-css'), null, 'the default loads no theme');
  applyTheme('no-such-theme');
  eq(dom.document.getElementById('theme-css'), null, 'an unknown theme is the default');
});

await check('the project names the style a reader without a pick sees', () => {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  try {
    eq(currentTheme(), '', 'no project, no pick: the default');
    eq(currentTheme({ theme: 'outline' }), 'outline', 'the project chooses the style');
    eq(currentTheme({ theme: 'no-such-theme' }), '', 'an unknown project style is the default');
    store.set('blueprint.theme', 'article');
    eq(currentTheme({ theme: 'outline' }), 'article', 'the reader\'s pick wins');
    store.set('blueprint.theme', '');
    eq(currentTheme({ theme: 'outline' }), '', 'also when the reader picked the default');
    global.location.search = '?theme=pretext';
    eq(currentTheme({ theme: 'outline' }), 'pretext', 'and ?theme= wins over both');
  } finally {
    delete global.localStorage;
    global.location.search = '';
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
// 1b. the progress listing's filters, and the search box in the top bar
// ---------------------------------------------------------------------------

const modelMod1 = await import(path.join(webDir, 'model.js'));

/** Call the listeners the page attached, as the browser would. */
function fire(node, type, ev = {}) {
  const event = { target: node, key: undefined, preventDefault() { this.defaultPrevented = true; }, ...ev };
  for (const fn of node._listeners.get(type) || []) fn(event);
  return event;
}
const listingRows = () => {
  const t = root.querySelectorAll('table.grid')[1];
  return t.querySelectorAll('tbody tr').filter((tr) => !tr.querySelector('td.muted[colspan]'));
};
const hashParams = () => new URLSearchParams(String(global.location.hash).split('?')[1] || '');

await check('the progress listing reads its filters from the link', async () => {
  await go('#/progress?status=stated');
  eq(listingRows().length, 3, 'three stated objects');
  eq(root.querySelector('.listing-count').textContent, '3 of 13 objects', 'the count');
  const [kindSel, statusSel, underSel] = root.querySelectorAll('.listing-filters select');
  ok(statusSel.querySelectorAll('option').some((o) => o.attributes.has('selected') && o.getAttribute('value') === 'stated'),
    'the status control shows the filter from the link');
  ok(kindSel && underSel, 'kind and under controls');
  await go('#/progress?status=bogus&kind=nope&under=nothing');
  eq(listingRows().length, 13, 'filters naming nothing in this snapshot filter by nothing');
});

await check('the progress filters combine, update the table in place and write the link', async () => {
  await go('#/progress');
  const page = root.firstChild;
  const tbody = root.querySelectorAll('table.grid')[1].querySelector('tbody');
  eq(root.querySelector('.listing-count').textContent, '13 objects', 'unfiltered count');
  const [kindSel, statusSel, underSel] = root.querySelectorAll('.listing-filters select');

  kindSel.value = 'lemma';
  fire(kindSel, 'change');
  eq(listingRows().length, 6, 'six lemmas');
  statusSel.value = 'stated';
  fire(statusSel, 'change');
  eq(listingRows().length, 2, 'two stated lemmas');
  underSel.value = 'uses/thm-tychonoff/lem-ultrafilter';
  fire(underSel, 'change');
  eq(listingRows().length, 2, 'both under the prose edge');

  const search = root.querySelector('.listing-search');
  search.value = 'limit-point';
  fire(search, 'input');
  eq(listingRows().length, 2, 'typing is debounced');
  await tick(220);
  eq(listingRows().length, 1, 'all four filters at once');
  eq(root.querySelector('.listing-count').textContent, '1 of 13 objects', 'the count follows');

  const p = hashParams();
  eq(p.get('kind'), 'lemma', 'kind in the link');
  eq(p.get('status'), 'stated', 'status in the link');
  eq(p.get('under'), 'uses/thm-tychonoff/lem-ultrafilter', 'under in the link');
  eq(p.get('q'), 'limit-point', 'q in the link');
  eq(root.firstChild, page, 'the page was not rebuilt');
  eq(root.querySelectorAll('table.grid')[1].querySelector('tbody'), tbody, 'the same table body');

  statusSel.value = 'missing';
  fire(statusSel, 'change');
  eq(listingRows().length, 0, 'nothing left');
  ok(/No countable object/.test(root.querySelectorAll('table.grid')[1].textContent), 'says so');

  const clearBtn = root.querySelectorAll('.listing-filters button')[0];
  fire(clearBtn, 'click');
  eq(listingRows().length, 13, 'Clear shows everything again');
  eq(String(global.location.hash), '#/progress', 'and empties the query');
});

await check('Show all works over the filtered rows', async () => {
  const big = generate({ seed: 3 });
  const bigModel = modelMod1.buildModel(big);
  const saved = { model: app.model, snapshot: app.snapshot };
  app.model = bigModel;
  app.snapshot = big;
  try {
    await go('#/progress?x=1');
    const all = modelMod1.countableObjects(bigModel).length;
    ok(all > 300, `the generated snapshot has ${all} countable objects`);
    eq(listingRows().length, 300, 'the first 300');
    const kinds = [...new Set(modelMod1.countableObjects(bigModel).map((o) => o.kind))];
    const kind = kinds.find((k) => modelMod1.countableObjects(bigModel).filter((o) => o.kind === k).length > 300) || kinds[0];
    const n = modelMod1.countableObjects(bigModel).filter((o) => o.kind === kind).length;
    const kindSel = root.querySelectorAll('.listing-filters select')[0];
    kindSel.value = kind;
    fire(kindSel, 'change');
    eq(listingRows().length, Math.min(300, n), 'still capped after filtering');
    const btn = root.querySelectorAll('button').find((b) => /^Show all/.test(b.textContent));
    if (n > 300) {
      ok(btn, 'a Show all button');
      eq(btn.textContent, `Show all ${n}`, 'it counts the filtered rows');
      fire(btn, 'click');
      eq(listingRows().length, n, 'Show all adds the filtered rest, not everything');
    } else {
      ok(!btn, 'no Show all when the filtered rows fit');
    }
  } finally {
    app.model = saved.model;
    app.snapshot = saved.snapshot;
  }
});

const gs = {
  input: dom.document.getElementById('gsearch-input'),
  panel: dom.document.getElementById('gsearch-panel'),
  list: dom.document.getElementById('gsearch-results'),
  foot: dom.document.getElementById('gsearch-foot'),
};
const gsItems = () => gs.list.querySelectorAll('.gsearch-item');

await check('the top-bar search finds objects and leaves out bare sugar edges', async () => {
  await go('#/progress');
  gs.panel.hidden = true;
  gs.input.value = 'tychonoff';
  fire(gs.input, 'input');
  ok(gs.panel.hidden, 'debounced');
  await tick(150);
  ok(!gs.panel.hidden, 'the list opened');
  eq(gs.input.getAttribute('aria-expanded'), 'true', 'aria-expanded');
  const hrefs = gsItems().map((a) => a.getAttribute('href'));
  eq(hrefs[0], '#/object/thm-tychonoff', 'the exact id first');
  ok(!hrefs.some((h) => /refines%2F|uses%2Fthm-tychonoff%2Fdef-compact/.test(h)), `no bare sugar edges in ${hrefs}`);
  ok(hrefs.includes('#/object/' + encodeURIComponent('uses/thm-tychonoff/lem-ultrafilter')),
    'a sugar edge with prose of its own is kept');
  ok(/match/.test(gs.foot.textContent), `the foot counts: ${gs.foot.textContent}`);
  eq(gsItems()[0].getAttribute('aria-selected'), 'true', 'the first result is active');

  gs.input.value = 'heineBorel';
  fire(gs.input, 'input');
  await tick(150);
  eq(gsItems()[0].getAttribute('href'), '#/object/thm-heine-borel', 'found by Lean name');
  ok(/heineBorel/.test(gsItems()[0].querySelector('.gsearch-lean').textContent), 'and says which');

  gs.input.value = 'zzzzzz';
  fire(gs.input, 'input');
  await tick(150);
  eq(gsItems().length, 0, 'no results');
  eq(gs.foot.textContent, 'No object matches.', 'says so');
});

await check('the top-bar search: arrows, Enter, Escape', async () => {
  gs.input.value = 'compact';
  fire(gs.input, 'input');
  await tick(150);
  const n = gsItems().length;
  ok(n >= 3, 'several results');
  fire(gs.input, 'keydown', { key: 'ArrowDown' });
  eq(gsItems()[1].getAttribute('aria-selected'), 'true', 'down moves to the second');
  eq(gs.input.getAttribute('aria-activedescendant'), gsItems()[1].id, 'aria-activedescendant');
  fire(gs.input, 'keydown', { key: 'ArrowUp' });
  fire(gs.input, 'keydown', { key: 'ArrowUp' });
  eq(gsItems()[n - 1].getAttribute('aria-selected'), 'true', 'up from the first wraps to the last');
  const want = gsItems()[n - 1].getAttribute('href');
  const ev = fire(gs.input, 'keydown', { key: 'Enter' });
  ok(ev.defaultPrevented, 'Enter is taken');
  await tick(5);
  eq(String(global.location.hash), want, 'Enter goes to the active result');
  eq(gs.input.value, '', 'and empties the box');
  ok(gs.panel.hidden, 'and closes the list');

  // Enter straight after typing acts on the new query, not the old list.
  gs.input.value = 'heine';
  fire(gs.input, 'input');
  fire(gs.input, 'keydown', { key: 'Enter' });
  await tick(5);
  eq(String(global.location.hash), '#/object/thm-heine-borel', 'Enter before the debounce fired');

  gs.input.value = 'compact';
  fire(gs.input, 'input');
  await tick(150);
  fire(gs.input, 'keydown', { key: 'Escape' });
  ok(gs.panel.hidden, 'Escape closes the list');
  eq(gs.input.value, 'compact', 'and keeps the query');
  gs.input.value = '';
  await go('#/object/def-compact');
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

// The whole document on one page, which is what the lazy machinery is for.
const allLevels = () => new URLSearchParams({ depth: 'all' });
const docFlow = () => root.querySelectorAll('.doc-flow')[0];

await check('the document view defers headings and prose', async () => {
  await withBigSnapshot(async () => {
    app.route = { view: 'document', id: null, params: allLevels(), raw: '/document?depth=all' };
    katex.reset();
    documentPage.render(root, app);

    const first = root.querySelectorAll('.doc-entry').length;
    ok(first > 0, 'nothing was rendered at all');
    ok(first <= 40, `the first paint built ${first} sections, not a screenful`);
    // Heads render their titles' maths eagerly (cheap); the bodies are the
    // expensive part and must stay empty until scrolled to.
    const filled = [...root.querySelectorAll('.body-prose')].filter((p) => p.childNodes.length).length;
    eq(filled, 0, 'no prose should be rendered before it is scrolled to');
    ok(dom.observers.pending() > 0, 'nothing was handed to the observer');

    const flow = docFlow();
    await settle(flow);
    const all = root.querySelectorAll('.doc-entry').length;
    ok(all > first, `the rest of the document never arrived (${all})`);
    const filledLater = [...root.querySelectorAll('.body-prose')].filter((p) => p.childNodes.length).length;
    eq(filledLater, 0, 'still no prose, only headings');
    const headingPasses = katex.calls.length; // titles' maths, cheap

    // Now the reader scrolls through all of it.
    const rendered = dom.observers.flush();
    ok(rendered > 100, `only ${rendered} bodies were rendered on scroll`);
    ok(katex.calls.length - headingPasses > 100, `only ${katex.calls.length - headingPasses} KaTeX passes on bodies`);
    eq(dom.observers.pending(), 0, 'everything was handed over exactly once');
  });
});

await check('a focused section is built even when it is far down', async () => {
  await withBigSnapshot(async () => {
    const entries = modelMod.documentOutline(app.model, 'refines').entries.filter((e) => !e.duplicate);
    const target = entries[entries.length - 1].id;
    app.route = {
      view: 'document', id: null,
      params: new URLSearchParams({ depth: 'all', focus: target }), raw: '/document',
    };
    documentPage.render(root, app);
    const anchor = 'doc-' + String(target).replace(/[^A-Za-z0-9_-]/g, '_');
    const flow = docFlow();
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
      app.route = { view: 'document', id: null, params: allLevels(), raw: '/document?depth=all' };
      katex.reset();
      documentPage.render(root, app);
      ok(katex.calls.length > 0, 'the fallback rendered no prose');
    });
  } finally {
    global.IntersectionObserver = keep;
  }
});

// ---------------------------------------------------------------------------
// 2b. the document is split into pages along the collapse order
// ---------------------------------------------------------------------------

const entryIds = () => [...root.querySelectorAll('.doc-entry')].map((s) => s.id);
const hrefs = (sel) => [...root.querySelectorAll(sel)].map((a) => a.getAttribute('href'));

await check('the top page is the contents: a row per top-level entry, nothing written out', async () => {
  await go('#/document');
  const out = modelMod.documentOutline(app.model, 'refines');
  eq(root.querySelectorAll('.doc-entry').length, 0, 'no entry is written out');
  eq(root.querySelectorAll('.doc-contents li').length, out.roots.length, 'one row per top-level entry');
  ok(hrefs('.doc-contents a').includes('#/document/sec-main?collapse=refines'), 'a chapter leads to its page');
  // A top-level entry with nothing under it is read on its own page.
  const leaf = out.roots.find((e) => !e.children.length);
  ok(hrefs('.doc-contents a').includes('#/document/' + encodeURIComponent(leaf.id) + '?collapse=refines'),
    'a top-level leaf leads to its own page');
  eq(root.querySelectorAll('.doc-layout').length, 0, 'no sidebar beside the contents');
  eq(root.querySelectorAll('.proof-toggle').length, 0, 'no proofs to fold');
  eq(root.querySelectorAll('.doc-crumbs').length, 0, 'no breadcrumbs at the top');
  const select = root.querySelectorAll('.doc-controls select')[1];
  eq(select.querySelectorAll('option[selected]')[0].getAttribute('value'), 'contents', 'the depth control says contents');
  // A row's page is the chapter's own, and its breadcrumbs lead back here.
  await go('#/document/sec-main');
  ok(hrefs('.doc-crumbs a').includes('#/document?collapse=refines'), 'the chapter page leads back to the contents');
  await go('#/document/' + encodeURIComponent(leaf.id));
  eq(root.querySelectorAll('.doc-entry.page-head').length, 1, 'the leaf has a page of its own');
});

await check('depth=1 on the top page writes out the top level, one level deep', async () => {
  await go('#/document?depth=1');
  const out = modelMod.documentOutline(app.model, 'refines');
  eq(root.querySelectorAll('.doc-entry').length, out.roots.length, 'one entry per top-level object');
  ok(entryIds().includes('doc-sec-main'), 'a chapter is on it');
  ok(!entryIds().includes('doc-thm-tychonoff'), 'its contents are not');
  // Each chapter leads on to its own page, by its number and by a "Read" line.
  ok(hrefs('.doc-open a').includes('#/document/sec-main?collapse=refines'), 'a link to the chapter page');
  ok(hrefs('.doc-entry .head a.num').includes('#/document/sec-main?collapse=refines'), 'the number links there too');
  eq(root.querySelectorAll('.doc-crumbs').length, 0, 'no breadcrumbs at the top');
  eq(root.querySelectorAll('.doc-pager').length, 0, 'no siblings at the top');
});

await check('depth=2 inlines a second level', async () => {
  await go('#/document?depth=2');
  ok(entryIds().includes('doc-sec-main-induction'), 'sections are written out');
  ok(!entryIds().includes('doc-lem-finite-subcover'), 'their contents are not');
  ok(hrefs('.doc-open a').includes('#/document/sec-main-induction?collapse=refines&depth=2'),
    'the depth travels with the links');
  const select = root.querySelectorAll('.doc-controls select')[1];
  eq(select.querySelectorAll('option[selected]')[0].getAttribute('value'), '2', 'the depth control shows it');
});

await check('a chapter page: breadcrumbs, its entries, its siblings', async () => {
  await go('#/document/sec-main');
  eq(app.route.id, 'sec-main', 'routed');
  eq(entryIds().join(' '), 'doc-sec-main doc-sec-main-induction doc-thm-tychonoff', 'the page and one level below');
  eq(root.querySelectorAll('.doc-entry.page-head .head h1').length, 1, 'the page entry is the title');
  ok(hrefs('.doc-crumbs a').includes('#/document?collapse=refines'), 'breadcrumbs lead to the top');
  eq(root.querySelectorAll('.doc-pager').length, 2, 'neighbours above and below');
  const pager = root.querySelectorAll('.doc-pager')[0];
  eq(pager.querySelectorAll('a.prev')[0].getAttribute('href'), '#/document/sec-foundations?collapse=refines', 'previous chapter');
  eq(pager.querySelectorAll('a.next')[0].getAttribute('href'), '#/document/sec-applications?collapse=refines', 'next chapter');
  eq(pager.querySelectorAll('a.up')[0].getAttribute('href'), '#/document?collapse=refines', 'up to the top');
});

await check('a nested page has the whole chain in its breadcrumbs', async () => {
  await go('#/document/sec-main-induction');
  ok(hrefs('.doc-crumbs a').includes('#/document/sec-main?collapse=refines'), 'the chapter is in the chain');
  const text = root.querySelectorAll('.doc-crumbs')[0].textContent;
  ok(/2\.1/.test(text), `the page's own number is in the breadcrumbs: ${text}`);
  ok(entryIds().includes('doc-lem-finite-subcover'), 'its statements are written out');
});

await check('an old ?focus= link opens the page the entry is read on', async () => {
  await go('#/document?focus=lem-finite-subcover');
  eq(app.route.id, 'sec-main-induction', 'redirected to the section page');
  eq(global.location.hash, '#/document/sec-main-induction?collapse=refines&focus=lem-finite-subcover', 'the URL says so');
  ok(dom.document.getElementById('doc-lem-finite-subcover'), 'and the entry is on it');
  // A focus the page does show is scrolled to where it is: a chapter is on
  // the top page written out, and on its own page from the contents.
  await go('#/document?collapse=refines&depth=1&focus=sec-main');
  eq(app.route.id, null, 'a chapter is on the top page written out');
  await go('#/document?collapse=refines&focus=sec-main');
  eq(app.route.id, 'sec-main', 'the contents send it to its own page');
  // A focus the current page does show stays where it is.
  await go('#/document/sec-main?depth=2&focus=lem-diagonal');
  eq(app.route.id, 'sec-main', 'no redirect when the page shows it');
  // A step is read with its source, which here is on the top page too.
  await go('#/document/sec-foundations?focus=' + encodeURIComponent('uses/sec-main/sec-foundations'));
  eq(app.route.id, 'sec-main', 'a step opens its source page');
  ok(dom.document.getElementById('doc-uses_sec-main_sec-foundations'), 'the step block is anchored');
});

await check('a repeated object points at where it is written out', async () => {
  await go('#/document/sec-applications');
  const dup = root.querySelectorAll('.doc-entry.dup');
  eq(dup.length, 1, 'lem-diagonal is repeated here');
  eq(dup[0].id, '', 'the repetition does not take the anchor');
  ok(/2\.1\.2/.test(dup[0].textContent), 'it carries the number of the first occurrence');
  ok([...dup[0].querySelectorAll('a')].some((a) =>
    a.getAttribute('href') === '#/document/sec-main-induction?collapse=refines&focus=lem-diagonal'), 'and links to it');
});

await check('a page the document does not have says so', async () => {
  await go('#/document/no-such-object');
  eq(root.querySelectorAll('.error-box').length, 1, 'an unknown id');
  await go('#/document/' + encodeURIComponent('refines/def-compact/sec-foundations'));
  eq(root.querySelectorAll('.error-box h1')[0].textContent, 'Not in the document', 'an object with no page');
  await go('#/document');
});

// ---------------------------------------------------------------------------
// 2c. `[slug]` reads as a cross reference
// ---------------------------------------------------------------------------

const refLinks = () => [...root.querySelectorAll('.body-prose a.objlink')].map((a) => ({
  text: a.textContent, href: a.getAttribute('href'), title: a.getAttribute('title'),
  broken: a.classList.contains('broken'),
}));
const refTo = (slug) => refLinks().find((r) => r.title === slug);

await check('on an object page a reference reads "Definition 1.2" and opens the object', async () => {
  await go('#/object/def-compact');
  const r = refTo('def-filter');
  ok(r, `no link for [def-filter]: ${JSON.stringify(refLinks())}`);
  eq(r.text, 'Definition 1.2', 'the document number');
  eq(r.href, '#/object/def-filter', 'the link target is unchanged');
  // An unknown slug is a broken link exactly as before.
  await go('#/object/thm-stone-cech');
  const b = refLinks().find((x) => x.broken);
  eq(b.text, 'def-uniformity', 'a broken link keeps its slug');
  eq(b.href, '#/checks?code=bad-link', 'and its target');
});

await check('a reference to an object the document does not number keeps its slug', async () => {
  // A step (read as part of its source) and a collapse edge (structure); no
  // body in the sample refers to either, so the body is made up here.
  const div = dom.document.createElement('div');
  app.renderBody(div, 'see [uses/sec-main/sec-foundations] and [refines/def-compact/sec-foundations]', app.knownIds());
  const texts = [...div.querySelectorAll('a.objlink')].map((a) => a.textContent);
  eq(texts.join(' | '), 'uses/sec-main/sec-foundations | refines/def-compact/sec-foundations', 'slugs');
});

await check('the word already in the prose is not repeated', async () => {
  const div = dom.document.createElement('div');
  app.renderBody(div, 'By Lemma [lem-ultrafilter], by lemma [lem-ultrafilter], a dilemma [lem-ultrafilter].', app.knownIds());
  const texts = [...div.querySelectorAll('a.objlink')].map((a) => a.textContent);
  eq(texts.join(' | '), '1.5 | 1.5 | Lemma 1.5', 'only the number after the word, whole words only');
});

await check('a word the prose names a reference with stands, whatever the kind', async () => {
  const div = dom.document.createElement('div');
  app.renderBody(div, 'Thm [lem-ultrafilter], Props. [lem-ultrafilter], definition [lem-ultrafilter], ' +
    'the theorem [lem-ultrafilter], using [lem-ultrafilter], athm [lem-ultrafilter].', app.knownIds());
  const texts = [...div.querySelectorAll('a.objlink')].map((a) => a.textContent);
  eq(texts.join(' | '), '1.5 | 1.5 | 1.5 | 1.5 | Lemma 1.5 | Lemma 1.5',
    'abbreviations, plurals, other kind words; ordinary words still get the kind word');
});

await check('the graph numbers along its own collapse order', async () => {
  const div = dom.document.createElement('div');
  await go('#/graph?collapse=instance_of&sel=def-compact');
  app.renderBody(div, '[thm-heine-borel]', app.knownIds());
  eq(div.querySelectorAll('a')[0].textContent, 'Theorem 6.1', 'instance_of numbers');
  await go('#/graph?sel=def-compact');
  app.renderBody(div, '[thm-heine-borel]', app.knownIds());
  eq(div.querySelectorAll('a')[0].textContent, 'Theorem 3.1', 'the default order');
});

await check('in the document a reference leads to where the entry is written out', async () => {
  await go('#/document/sec-foundations');
  dom.observers.flush();
  // def-compact refers to def-filter, on the same page.
  const same = refTo('def-filter');
  eq(same.text, 'Definition 1.2', 'numbered');
  eq(same.href, '#/document/sec-foundations?collapse=refines&focus=def-filter', 'this page, scrolled to it');
  // sec-foundations' own prose refers to thm-tychonoff, read on sec-main's page.
  const other = refTo('thm-tychonoff');
  eq(other.text, 'Theorem 2.2', 'numbered');
  eq(other.href, '#/document/sec-main?collapse=refines&focus=thm-tychonoff', 'the page it is read on');
  // A section's own page.
  await go('#/document/sec-main?depth=2');
  dom.observers.flush();
  const sec = refTo('sec-main-induction');
  eq(sec.text, 'Section 2.1', 'a section');
  eq(sec.href, '#/document/sec-main?collapse=refines&depth=2&focus=sec-main-induction', 'on this page at depth 2');
  // Along the other order the numbers and pages are that order's.
  await go('#/document?collapse=instance_of&depth=all');
  dom.observers.flush();
  const inst = refLinks().find((r) => r.title === 'def-filter');
  eq(inst.text, 'Definition 7', 'instance_of numbering in the document');
  await go('#/document');
});

// ---------------------------------------------------------------------------
// 2d. the graph's side panel puts what the object says first
// ---------------------------------------------------------------------------

/** The side panel's sections, each named by its heading or summary. */
const sideSections = () => [...root.querySelectorAll('aside.side section')].map((s) => {
  const h = s.querySelector('h3') || s.querySelector('summary');
  return h ? h.textContent : s.textContent;
});

await check('the side panel reads prose first and folds the long listings', async () => {
  // sec-foundations, collapsed, has prose, incident objects and relations
  // hidden inside it.
  await go('#/graph?sel=sec-foundations');
  const names = sideSections();
  const at = (re) => names.findIndex((n) => re.test(n));
  ok(at(/^Prose$/) >= 0, `no prose in ${JSON.stringify(names)}`);
  ok(at(/^Incident objects \(6\)$/) > at(/^Prose$/), `incident objects before the prose: ${JSON.stringify(names)}`);
  ok(at(/^Hidden inside \(3\)$/) > at(/^Incident objects/), `hidden inside before the incidents: ${JSON.stringify(names)}`);
  const folds = root.querySelectorAll('aside.side section.fold details');
  eq(folds.length, 2, 'the two listings are disclosures');
  for (const d of folds) ok(!d.hasAttribute('open'), `${d.querySelector('summary').textContent} starts open`);
  eq(folds[0].querySelectorAll('ul.objlist li').length, 6, 'the incident rows are there, only shut');
});

await check('an opened listing stays open while the panel is rebuilt', async () => {
  await go('#/graph?sel=sec-foundations');
  const incident = () => root.querySelector('aside.side section.fold details');
  const d = incident();
  fire(d, 'toggle', { target: { open: true } });
  // Another route change rebuilds the panel; the listing is open on the next
  // selection too, and shut again once the reader shuts it.
  await go('#/graph?sel=sec-main');
  ok(incident().hasAttribute('open'), 'the incident listing snapped shut');
  fire(incident(), 'toggle', { target: { open: false } });
  await go('#/graph?sel=sec-foundations');
  ok(!incident().hasAttribute('open'), 'the incident listing stayed open after it was shut');
});

// ---------------------------------------------------------------------------
// 2e. a link to an object previews it while the pointer rests on it
// ---------------------------------------------------------------------------

const preview = await import(path.join(webDir, 'preview.js'));
const M = modelMod;
const SHOWN = 360; // past preview.js's SHOW_MS
const GONE = 300; // past its HIDE_MS
const cards = () => preview.openPreviews();
const refLink = (slug) => [...root.querySelectorAll('.body-prose a.objlink')]
  .find((a) => a.getAttribute('data-ref') === slug || a.getAttribute('title') === slug);

await check('which links preview, and what', async () => {
  await go('#/object/def-compact');
  const m = app.model;
  eq(preview.previewTarget(m, refLink('def-filter')), 'def-filter', 'a [slug] reference');
  const div = dom.document.createElement('div');
  div.appendChild(app.objLink(m, 'sec-main'));
  eq(preview.previewTarget(m, div.querySelector('a')), 'sec-main', 'a title in a listing');
  app.renderBody(div, '[no-such-object]', app.knownIds());
  eq(preview.previewTarget(m, div.querySelector('a.broken')), null, 'a broken reference');
  const h = dom.document.createElement('h2');
  h.appendChild(app.objLink(m, 'sec-main'));
  eq(preview.previewTarget(m, h.querySelector('a')), null, 'a heading: the object is written out under it');
  eq(preview.previewTarget(m, app.el('a', { href: '#/graph' }, 'Graph')), null, 'a link to a page');
});

await check('resting on a reference opens its card; moving off closes it', async () => {
  await go('#/object/def-compact');
  const a = refLink('def-filter');
  preview.hover(a);
  eq(a.getAttribute('title'), null, 'the tooltip would cover the card');
  await tick(SHOWN);
  eq(cards().length, 1, 'one card');
  const card = cards()[0].card;
  eq(card.getAttribute('data-preview'), 'def-filter', 'the card of the referenced object');
  eq(card.querySelector('.preview-lead').textContent, 'Definition 1.2', 'it reads as the reference does');
  eq(card.querySelector('.preview-title').textContent, M.titleOf(app.model.byId.get('def-filter')), 'its title');
  ok(card.querySelector('.preview-body').textContent.length > 20, 'its prose');
  eq(card.querySelector('.preview-open').getAttribute('href'), '#/object/def-filter', 'a way on to its page');
  ok(card.parentNode === dom.document.body, 'the card is on the page');

  // Through the gap into the card: it stays.
  preview.hover(root);
  await tick(50);
  preview.hover(card.querySelector('.preview-body'));
  await tick(GONE);
  eq(cards().length, 1, 'the card closed on the way into it');
  eq(a.getAttribute('title'), 'def-filter', 'the tooltip is back once the pointer is off the link');

  // Elsewhere for a moment: it goes.
  preview.hover(root);
  await tick(GONE);
  eq(cards().length, 0, 'the card outlived the pointer');
  ok(card.parentNode === null, 'and left its element behind');
});

await check('a link passed over on the way elsewhere opens nothing', async () => {
  await go('#/object/def-compact');
  preview.hover(refLink('def-filter'));
  await tick(100);
  preview.hover(root);
  await tick(SHOWN);
  eq(cards().length, 0, 'a card opened');
});

await check('a reference inside a card opens a card of its own', async () => {
  await go('#/object/def-compact');
  preview.hover(refLink('def-filter'));
  await tick(SHOWN);
  const outer = cards()[0].card;
  // def-filter's prose refers back to def-compact.
  const inner = [...outer.querySelectorAll('a.objlink')].find((x) => x.getAttribute('title') === 'def-compact');
  ok(inner, 'no reference in the card');
  preview.hover(inner);
  await tick(SHOWN);
  eq(cards().map((c) => c.id).join(' > '), 'def-filter > def-compact', 'the chain of cards');
  // Back into the outer card: the inner one goes, the outer one stays.
  preview.hover(outer.querySelector('.preview-head'));
  await tick(GONE);
  eq(cards().map((c) => c.id).join(' > '), 'def-filter', 'after moving back');
  // A change of route closes them all.
  await go('#/object/def-filter');
  eq(cards().length, 0, 'cards outlived their page');
});

await check('a card says what an edge joins, and leaves the Lean names out', async () => {
  const edge = app.model.objects.find((o) => o.kind === 'uses');
  const card = preview.previewCard(app, edge.id);
  const ends = card.querySelectorAll('.preview-ends a.objlink');
  eq(ends.length, edge.boundary.length, 'one link per end');
  const text = preview.previewCard(app, 'def-filter').textContent;
  ok(!text.includes('Compact.Filter') && !text.includes('Compact.Ultrafilter'), `Lean names in the card: ${text}`);
});

/** The Lean marks in the document's headings, by the object they are of. */
const leanMarks = () => new Map(root.querySelectorAll('.doc-entry .head button.lean-mark')
  .map((b) => [b.getAttribute('data-lean'), b]));

await check('the document marks each heading with Lean names, and only those', async () => {
  await go('#/document/sec-foundations?collapse=refines');
  const marks = leanMarks();
  ok(marks.size > 0, 'no Lean mark on the page');
  for (const [id, b] of marks) {
    const n = M.leanNamesOf(app.model.byId.get(id)).length;
    ok(n > 0, `${id} has no Lean names but a mark`);
    eq(b.textContent, n > 1 ? 'Lean' + n : 'Lean', `the mark of ${id} counts its names`);
  }
  // Every heading of an object with Lean names on the page has one.
  for (const h of root.querySelectorAll('.doc-entry .head')) {
    const a = h.querySelector('a.objlink');
    const id = a && decodeURIComponent(a.getAttribute('href').replace('#/object/', ''));
    if (id && M.leanNamesOf(app.model.byId.get(id)).length) ok(h.querySelector('button.lean-mark'), `no mark on ${id}`);
  }
  eq(marks.get('def-filter').textContent, 'Lean2', 'two names');
});

await check('resting on the Lean mark opens a card of its Lean declarations', async () => {
  await go('#/document/sec-foundations?collapse=refines');
  const mark = leanMarks().get('def-filter');
  preview.hover(mark);
  await tick(SHOWN);
  eq(cards().length, 1, 'one card');
  const card = cards()[0].card;
  ok(card.classList.contains('lean-card'), 'the Lean card, not the statement');
  const names = card.querySelectorAll('ul.lean-names li');
  eq(names.length, 2, 'one row per name');
  eq(names.map((li) => li.querySelector('code').textContent).join(' '), 'Compact.Filter Compact.Ultrafilter', 'the names');
  eq(names[0].querySelector('a').getAttribute('href'),
    'https://example.github.io/compact/docs/Compact.html#Compact.Filter', 'linked to the documentation');
  eq(card.querySelector('.preview-lead').textContent, 'Lean declarations (2)', 'the head counts them');
  preview.hover(root);
  await tick(GONE);
  eq(cards().length, 0, 'the card outlived the pointer');
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

/**
 * A stand-in for elkjs's `ELK` class, speaking elk-api's protocol: given a
 * `workerFactory` it drives the worker with `{id, cmd}` messages and resolves
 * on `{id, data}` / rejects on `{id, error}`; given nothing it lays out
 * in-thread, which is what elk.bundled.js does on the main thread.
 */
function installFakeELK() {
  const state = { mainThreadLayouts: 0, instances: [] };
  global.window.ELK = function FakeELK(cfg = {}) {
    const inst = { cfg, resolvers: new Map(), seq: 0 };
    state.instances.push(inst);
    if (!cfg.workerFactory) {
      inst.mode = 'main';
      inst.layout = async (g) => { state.mainThreadLayouts += 1; return fakeLayout(g); };
      return inst;
    }
    inst.mode = 'worker';
    const w = cfg.workerFactory();
    inst.worker = w;
    w.onmessage = (ev) => {
      const msg = (ev && ev.data) || {};
      const r = inst.resolvers.get(msg.id);
      if (!r) return;
      inst.resolvers.delete(msg.id);
      if (msg.error) r.reject(new Error(String(msg.error)));
      else r.resolve(msg.data);
    };
    const post = (msg) => new Promise((resolve, reject) => {
      msg.id = inst.seq;
      inst.seq += 1;
      inst.resolvers.set(msg.id, { resolve, reject });
      w.postMessage(msg);
    });
    // elk-api registers its algorithms as soon as it is constructed.
    post({ cmd: 'register', algorithms: ['layered'] }).catch(() => {});
    inst.layout = (graph, opts = {}) =>
      post({ cmd: 'layout', graph, layoutOptions: opts.layoutOptions || {}, options: {} });
    inst.terminateWorker = () => w.terminate();
    return inst;
  };
  return state;
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
const layingOut = () => root.querySelectorAll('.graph-stage')[0].classList.contains('laying-out');
const errorLine = () => root.querySelectorAll('.graph-error')[0] || null;
const lastLayoutMessage = (w) =>
  [...w.messages].reverse().find((m) => m.cmd === 'layout') || null;

/** A fresh graph.js, so the worker is attempted again from scratch. */
const freshGraph = async (tag) => {
  const mod = await import(path.join(webDir, 'graph.js') + '?' + tag);
  app.route = { view: 'graph', id: null, params: new URLSearchParams(), raw: '/graph' };
  return mod;
};

const graphMod = await import(path.join(webDir, 'graph.js'));

await check('the watchdog deadline grows with the graph', () => {
  eq(graphMod.layoutDeadline(0), 4000, 'the floor');
  eq(graphMod.layoutDeadline(1), 4002, 'one node');
  eq(graphMod.layoutDeadline(1000), 6000, 'a thousand nodes and edges');
});

await check('a title with maths breaks at spaces outside its formulas only', () => {
  const show = (t) => graphMod.mathTokens(t)
    .map((tok) => tok.map((p) => (p.tex !== undefined ? `<${p.tex}>` : p.text)).join(''));
  eq(JSON.stringify(show('$2$-colimit')), JSON.stringify(['<2>-colimit']), 'glued to its word');
  eq(JSON.stringify(show('The functor $\\operatorname{Pic}_{X/S} \\to G$ here')),
    JSON.stringify(['The', 'functor', '<\\operatorname{Pic}_{X/S} \\to G>', 'here']), 'a formula with spaces is one token');
  eq(JSON.stringify(show('Base case: \\(|I| = 1\\)')), JSON.stringify(['Base', 'case:', '<|I| = 1>']), '\\( \\)');
  eq(JSON.stringify(show('$$a b$$ and \\[c\\]')), JSON.stringify(['<a b>', 'and', '<c>']), 'display delimiters');
  eq(JSON.stringify(show('costs $5')), JSON.stringify(['costs', '$5']), 'an unclosed $ is text');
});

await check('without KaTeX a title with maths is laid out as its source text', () => {
  const M = modelMod;
  const model = app.model;
  const expand = [...M.collapseOrder(model, 'refines').expandable];
  const view = M.makeView(model, 'refines', expand);
  const st = { collapse: 'refines', expand, ekinds: null, status: null, q: '', sel: null };
  const { nodes } = graphMod.buildElk({ model }, st, view, M.quotient(view));
  const n = nodes.get('thm-heine-borel');
  ok(n && !n.bp.wrap.math, 'drawn as plain text');
  eq(n.bp.wrap.lines.join(' '), M.titleOf(model.byId.get('thm-heine-borel')), 'the whole source');
  eq(n.height, 36 + (n.bp.wrap.lines.length - 1) * 15, 'sized by its lines');
});

await check('a reversed kind is laid out and drawn tgt -> src, the rest src -> tgt', async () => {
  const M = modelMod;
  const model = app.model;
  const expand = [...M.collapseOrder(model, 'refines').expandable];
  const view = M.makeView(model, 'refines', expand);
  const st = { collapse: 'refines', expand, ekinds: null, status: null, q: '', sel: null };
  const { graph } = graphMod.buildElk({ model }, st, view, M.quotient(view));
  const arcs = graph.edges.filter((e) => e.bp.kind === 'edge' && e.bp.entity.directed);
  const uses = arcs.filter((e) => e.bp.entity.kind === 'uses');
  const others = arcs.filter((e) => e.bp.entity.kind !== 'uses');
  const end = (k) => k.replace(/^j:/, ''); // an edge between edges ends at junctions
  ok(uses.length > 0 && others.length > 0, 'the sample has both');
  for (const e of uses) {
    eq(end(e.sources[0]), e.bp.entity.tgt, `${e.id} starts at the dependency`);
    eq(end(e.targets[0]), e.bp.entity.src, `${e.id} ends at its user`);
  }
  for (const e of others) eq(end(e.sources[0]), e.bp.entity.src, `${e.id} starts at src`);
});

await check('"hide implied" drops exactly the implied arcs from the ELK graph, and no spoke', async () => {
  const M = modelMod;
  const model = app.model;
  const ids = (g) => g.edges.map((e) => e.id);
  for (const [expand, inner] of [[], ['sec-main'], [...M.collapseOrder(model, 'refines').expandable]]
    .flatMap((x) => [[x, false], [x, true]])) {
    const view = M.makeView(model, 'refines', expand);
    const base = { collapse: 'refines', expand, ekinds: null, status: null, q: '', sel: null, inner };
    const full = graphMod.buildElk({ model }, { ...base, reduce: false }, view, M.quotient(view));
    const red = graphMod.buildElk({ model }, { ...base, reduce: true }, view, M.quotient(view));
    eq(full.implied, 0, 'nothing is hidden with the option off');
    const gone = ids(full.graph).filter((id) => !ids(red.graph).includes(id));
    eq(gone.length, red.implied, `${expand.length} expanded: the count matches what went`);
    eq(ids(red.graph).filter((id) => !ids(full.graph).includes(id)).length, 0, 'nothing new appears');
    for (const id of gone) {
      const meta = full.edgeMeta.get(id);
      eq(meta.kind, 'edge', `${id} is an arc, not a spoke`);
    }
    // The nodes are untouched: the option is about arcs only.
    eq(red.nodes.size, full.nodes.size, 'the same nodes');
  }
  // Collapsed, with the arcs of contents drawn, three arcs go.  The junction for the prose edge
  // uses/thm-tychonoff/lem-ultrafilter has a uses-arc to sec-main and one to
  // sec-foundations, which sec-main uses.  And sec-main -> sec-foundations and
  // sec-applications -> sec-foundations are each also drawn through a junction
  // (a uses edge that something else attaches to): src end -> junction -> tgt
  // end is a path, so the plain arc beside it is implied, and the junction,
  // with its spokes, stays.
  const view = M.makeView(model, 'refines', []);
  const st = { collapse: 'refines', expand: [], ekinds: null, status: null, q: '', sel: null, reduce: true, inner: true };
  const { graph, implied } = graphMod.buildElk({ model }, st, view, M.quotient(view));
  eq(implied, 3, 'implied arcs when collapsed');
  const drawnArc = (s, t) => graph.edges.some((e) => e.bp.kind === 'edge' &&
    e.bp.entity.src === s && e.bp.entity.tgt === t && e.bp.entity.kind === 'uses');
  for (const s of ['uses/thm-tychonoff/lem-ultrafilter', 'sec-main', 'sec-applications']) {
    ok(!drawnArc(s, 'sec-foundations'), `${s} -> sec-foundations is not drawn`);
  }
  // The cycle between sec-main and sec-applications is left alone.
  ok(drawnArc('sec-main', 'sec-applications') && drawnArc('sec-applications', 'sec-main'), 'the cycle');
  ok(graph.edges.some((e) => e.id === 'j:uses/thm-tychonoff/def-compact|sec-foundations'), 'a spoke stays');
  // With uses filtered out there is nothing of that kind left to reduce.
  const off = graphMod.buildElk({ model }, { ...st, ekinds: ['instance_of', 'generalises', 'commutes'] },
    view, M.quotient(view));
  eq(off.implied, 0, 'a filtered kind implies nothing');
});

await check('by default a collapsed section draws its own arcs, not its contents\'', () => {
  const model = app.model;
  const view = M.makeView(model, 'refines', []);
  const st = { collapse: 'refines', expand: [], ekinds: null, status: null, q: '', sel: null, reduce: false, inner: false };
  const own = graphMod.buildElk({ model }, st, view, M.quotient(view));
  const all = graphMod.buildElk({ model }, { ...st, inner: true }, view, M.quotient(view));
  const arcs = (g) => g.graph.edges.filter((e) => e.bp.kind === 'edge')
    .map((e) => `${e.bp.entity.src}->${e.bp.entity.tgt}`).sort();
  eq(arcs(own).join(' '), 'sec-applications->sec-main sec-main->sec-applications sec-main->sec-foundations',
    'only the arcs declared between the sections');
  ok(arcs(all).includes('sec-applications->sec-foundations'), 'the contents\' arc is there with the option on');
  // Nothing on an own arc counts the contents: one member, no "×n".
  for (const e of own.graph.edges) if (e.bp.kind === 'edge') eq(e.bp.entity.members.length, 1, `${e.id} members`);
  ok(own.contents > 0, 'the arcs of contents are counted for the status line');
  eq(all.contents, 0, 'and none are hidden with the option on');
  eq(own.nodes.size < all.nodes.size, true, 'junctions among contents go with them');
  // The prose edge with lemmas of its own is still there to be expanded.
  ok(own.nodes.has('j:uses/thm-tychonoff/lem-ultrafilter'), 'the way into the prose edge\'s lemmas');
});

await check('"arcs of contents" is a checkbox written to the URL', async () => {
  await go('#/graph?collapse=refines');
  const box = [...root.querySelectorAll('.toolbar label.chk')].find((l) => l.textContent === 'arcs of contents');
  ok(box, 'no checkbox');
  const input = box.querySelector('input');
  ok(!input.hasAttribute('checked'), 'on by default');
  fire(input, 'change', { target: { checked: true } });
  await tick(5);
  ok(/[?&]inner=1(&|$)/.test(global.location.hash), `not in the URL: ${global.location.hash}`);
  await go('#/graph?collapse=refines');
});

await check('"hide appendix" is offered only when there is an appendix to hide', async () => {
  await go('#/graph?collapse=refines');
  const labels = [...root.querySelectorAll('.toolbar label.chk')].map((l) => l.textContent);
  ok(labels.includes('arcs of contents'), 'the toolbar was not drawn');
  ok(!labels.includes('hide appendix'), 'offered on a snapshot without an appendix');
});

await check('Hide progress takes the statuses, bars and Progress tab away; Show brings them back', async () => {
  const aside = dom.document.getElementById('topbar-aside');
  const toggle = () => aside.querySelector('button.progress-toggle');
  const html = dom.document.documentElement;
  const badges = () => root.querySelectorAll('span.badge').filter((b) => /\bstatus-/.test(b.className));
  await go('#/object/thm-tychonoff');
  eq(toggle().textContent, 'Hide progress', 'the button offers to hide');
  ok(aside.querySelector('a.row'), 'the top bar shows the progress figure');
  ok(badges().length > 0, 'an object page shows its status');
  ok(root.querySelectorAll('.bar').length > 0, 'and its progress');
  await go('#/document?collapse=refines');
  ok(root.querySelectorAll('.doc-contents .bar').length > 0, 'the contents show progress bars');
  await go('#/document?collapse=refines&depth=1');
  ok(root.querySelectorAll('.doc-progress').length > 0, 'the document shows progress bars');

  fire(toggle(), 'click');
  await tick(5);
  try {
    eq(app.showProgress, false, 'the progress is hidden');
    eq(html.getAttribute('data-progress'), 'hidden', 'for the stylesheet too, which drops the tab');
    eq(toggle().textContent, 'Show progress', 'the button offers to show');
    eq(aside.querySelector('a.row'), null, 'no progress figure in the top bar');
    eq(root.querySelectorAll('.doc-progress').length, 0, 'no progress bars in the document');
    await go('#/document?collapse=refines');
    eq(root.querySelectorAll('.doc-contents .bar').length, 0, 'nor in the contents');
    await go('#/object/thm-tychonoff');
    eq(badges().length, 0, 'no status on an object page');
    eq(root.querySelectorAll('.bar').length, 0, 'nor progress');
    await go('#/graph?collapse=refines&status=proved');
    const lbls = root.querySelectorAll('.toolbar span.lbl').map((l) => l.textContent);
    ok(lbls.includes('edges') && !lbls.includes('status'), 'the graph offers no status filter');
    ok(!root.querySelector('.legend').textContent.includes('no Lean ref'), 'and its key no fills');
    await go('#/progress');
    ok(root.querySelector('button'), 'the Progress page offers to show the progress');
    eq(root.querySelectorAll('table').length, 0, 'and shows none');
  } finally {
    fire(toggle(), 'click');
    await tick(5);
  }
  eq(app.showProgress, true, 'shown again');
  eq(html.getAttribute('data-progress'), null, 'the tab is back');
  ok(root.querySelectorAll('table').length > 0, 'the Progress page is drawn again');
  await go('#/graph?collapse=refines');
  ok(root.querySelector('.legend').textContent.includes('no Lean ref'), 'the graph key has its fills again');
});

await check('a hidden appendix leaves the ELK graph with its contents and arcs; a hidden object always does', () => {
  const node = (id, kind) => ({ id, kind, boundary: [], attrs: {}, body: '', depth: 0 });
  const edge = (kind, src, tgt) => ({ id: `${kind}/${src}/${tgt}`, kind, attrs: {}, body: '', depth: 1,
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }] });
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  const m = M.buildModel({
    version: 1,
    schema: { defaultCollapse: 'refines', kinds: {
      section: { boundary: {} }, appendix: { boundary: {}, graph: 'optional' },
      hidden: { boundary: {}, graph: 'never' }, lemma: { boundary: {}, countable: true },
      refines: { ...binary, collapse: true }, uses: binary } },
    objects: [node('main', 'section'), node('a', 'lemma'), node('note', 'hidden'),
      node('app', 'appendix'), node('b', 'lemma'),
      edge('refines', 'a', 'main'), edge('refines', 'note', 'main'), edge('refines', 'b', 'app'),
      edge('uses', 'a', 'b'), edge('uses', 'a', 'note')],
    derived: {},
  });
  const st = { collapse: 'refines', expand: ['main', 'app'], ekinds: null, status: null, q: '', sel: null,
    reduce: false, inner: false };
  const drawn = (hideOptional) => {
    const view = M.makeView(M.graphModel(m, { hideOptional }), 'refines', st.expand);
    const { nodes, graph } = graphMod.buildElk({ model: m }, { ...st, appendix: !hideOptional }, view, M.quotient(view));
    return { nodes: [...nodes.keys()].sort(), edges: graph.edges.map((e) => e.id) };
  };
  const shown = drawn(false);
  eq(shown.nodes.join(), 'a,app,b,main', 'shown: the appendix and its lemma, never the hidden note');
  eq(shown.edges.length, 1, 'shown: the use of the appendix\'s lemma is drawn');
  const hidden = drawn(true);
  eq(hidden.nodes.join(), 'a,main', 'hidden: the appendix goes with its lemma');
  eq(hidden.edges.length, 0, 'hidden: and so does the arc to it');
});

const elkState = installFakeELK();

await check('the graph lays out in a Blob worker that imports elkjs’s worker half', async () => {
  dom.workers.created.length = 0;
  await go('#/graph');

  // One worker for the page, reused for every layout.
  eq(dom.workers.created.length, 1, 'expected exactly one worker');
  const w = dom.workers.created[0];
  ok(String(w.url).startsWith('blob:'), `the worker came from ${w.url}, not a blob`);
  ok(w.source.includes('importScripts('), 'the worker does not import anything');
  ok(w.source.includes('elkjs@0.9.3/lib/elk-worker.min.js'),
    `the worker imports ${w.source}, not the pinned elk-worker.min.js`);
  ok(!w.source.includes('elk.bundled.js'),
    'the worker loads the bundle, whose own protocol would collide with elkjs’s');
  // Nothing but the import: elkjs installs its own protocol on both sides.
  eq(w.source.replace(/\s+/g, ' ').trim(),
    `importScripts("https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk-worker.min.js");`,
    'the worker runs a program of its own on top of elkjs');

  // The page drives it through ELK itself, not a protocol of ours.
  const inst = elkState.instances[elkState.instances.length - 1];
  eq(inst.mode, 'worker', 'ELK was not constructed with a workerFactory');
  eq(typeof inst.cfg.workerFactory, 'function', 'workerFactory');
  ok(inst.worker === w, 'the factory did not make the Blob worker');

  ok(w.messages.length > 0, 'nothing was posted to the worker');
  ok(w.messages.some((m) => m.cmd === 'register'), 'the algorithms were never registered');
  const req = lastLayoutMessage(w);
  ok(req, 'no layout was requested');
  ok(typeof req.id === 'number', 'the request carries no id');
  ok(!hasBp(req.graph), 'the model back-references were posted to the worker');
  ok(req.graph.children.length > 0, 'an empty graph was posted');

  ok(/laying out \d+ nodes?/.test(statusText()), `status was "${statusText()}"`);
  eq(root.querySelectorAll('.gnode').length, 0, 'the graph was drawn before ELK answered');

  w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
  await tick(5);

  ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn from the worker’s answer');
  ok(/nodes, \d+ links/.test(statusText()), `status stayed at "${statusText()}"`);
  ok(!layingOut(), 'the stage is still marked as laying out');
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

await check('clicking a node brings its edges and their far ends forward and fades the rest', async () => {
  const layer = root.querySelector('g.glayer');
  const edges = root.querySelectorAll('.gedge');
  const nodeAt = (nid) => root.querySelectorAll('.gnode').find((n) => n.dataset.nid === nid);
  // a leaf with an edge, so that something is lit and something is not
  const e0 = edges.find((e) => nodeAt(e.dataset.src) && !nodeAt(e.dataset.src).classList.contains('compound'));
  ok(e0, 'no edge starts at a drawn leaf');
  const g = nodeAt(e0.dataset.src);
  const nid = g.dataset.nid;
  fire(g, 'click', { stopPropagation() {} });
  ok(layer.classList.contains('focusing'), 'the layer is not marked as focusing');
  ok(g.classList.contains('selected') && g.classList.contains('focus'), 'the clicked node is not singled out');
  for (const e of edges) {
    const mine = e.dataset.src === nid || e.dataset.tgt === nid;
    if (mine) ok(e.classList.contains('focus'), `${e.dataset.src} -> ${e.dataset.tgt} is not lit`);
    const far = e.dataset.src === nid ? e.dataset.tgt : e.dataset.tgt === nid ? e.dataset.src : null;
    if (far && nodeAt(far)) ok(nodeAt(far).classList.contains('focus'), `the far end ${far} faded`);
  }
  ok(edges.some((e) => !e.classList.contains('focus')), 'every edge is lit');
  const head = e0.querySelector('path').getAttribute('marker-end');
  ok(!head || head.endsWith('-focus)'), `the lit edge kept its plain head ${head}`);

  // A click on empty stage selects nothing and puts everything back.
  const stage = root.querySelector('div.graph-stage');
  const svg = stage.querySelector('svg');
  const press = { button: 0, pointerId: 1, clientX: 5, clientY: 5, target: svg };
  fire(stage, 'pointerdown', press);
  fire(stage, 'pointerup', press);
  ok(!layer.classList.contains('focusing'), 'the layer still fades the rest');
  ok(!g.classList.contains('selected'), 'the node is still selected');
  ok(edges.every((e) => !e.classList.contains('focus')), 'an edge is still lit');
  const back = e0.querySelector('path').getAttribute('marker-end');
  ok(!back || !back.endsWith('-focus)'), `the edge kept the accent head ${back}`);
});

await check('the section entered is the innermost of a nest of open ones, and none when they sit side by side', () => {
  const view = (expand) => M.makeView(app.model, 'refines', expand);
  eq(graphMod.enteredSection(view([])), null, 'nothing open');
  eq(graphMod.enteredSection(view(['sec-main'])), 'sec-main', 'one open');
  eq(graphMod.enteredSection(view(['sec-main', 'sec-main-induction'])), 'sec-main-induction', 'the innermost');
  eq(graphMod.enteredSection(view(['sec-main', 'sec-foundations'])), null, 'two side by side');
});

await check('inside a section the level it was opened from is unreadable until the reader goes back up', async () => {
  const w = dom.workers.created[dom.workers.created.length - 1];
  const layout = async (hash) => {
    await go(hash);
    const req = lastLayoutMessage(w);
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
  };
  const layer = root.querySelector('g.glayer');
  const back = root.querySelector('button.graph-back');
  const nodeAt = (nid) => root.querySelectorAll('.gnode').find((n) => n.dataset.nid === nid);
  const outside = (sel) => root.querySelectorAll(sel).filter((g) => g.classList.contains('outside'));

  await layout('#/graph?collapse=refines&expand=sec-main');
  ok(layer.classList.contains('entered'), 'the layer is not marked as entered');
  ok(!nodeAt('sec-main').classList.contains('outside'), 'the section itself is unreadable');
  ok(!nodeAt('thm-tychonoff').classList.contains('outside'), 'what is inside it is unreadable');
  ok(nodeAt('sec-foundations').classList.contains('outside'), 'the level it was opened from is readable');
  eq(nodeAt('sec-foundations').getAttribute('tabindex'), '-1', 'and still reached with Tab');
  for (const e of root.querySelectorAll('.gedge')) {
    const inside = (nid) => nid === 'sec-main' || nid === 'thm-tychonoff' || nid === 'sec-main-induction';
    eq(e.classList.contains('outside'), !(inside(e.dataset.src) && inside(e.dataset.tgt)),
      `${e.dataset.src} -> ${e.dataset.tgt}`);
  }
  eq(back.hidden, false, 'no way back');
  eq(back.textContent, '↑ Back to the top level', 'the way back');

  await layout('#/graph?collapse=refines&expand=sec-main,sec-main-induction');
  ok(nodeAt('sec-main').classList.contains('outside'), 'one level down, the section above is unreadable');
  ok(!nodeAt('lem-finite-subcover').classList.contains('outside'), 'and the new level readable');
  ok(back.textContent.endsWith('Back to ' + M.titleOf(app.model.byId.get('sec-main'))), back.textContent);

  fire(back, 'click');
  const req = lastLayoutMessage(w);
  w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
  await tick(5);
  eq(new URLSearchParams(app.route.params).get('expand'), 'sec-main', 'Back closes the section');
  ok(!nodeAt('sec-main').classList.contains('outside'), 'the level above is readable again');

  await layout('#/graph?collapse=refines');
  ok(!layer.classList.contains('entered'), 'at the top nothing is entered');
  eq(outside('.gnode').length + outside('.gtitle').length + outside('.gedge').length, 0, 'and nothing unreadable');
  eq(back.hidden, true, 'nor a way back');
});

await check('a blocked worker falls back to laying out on the main thread', async () => {
  dom.workers.enabled = false;
  dom.workers.created.length = 0;
  const state = installFakeELK();
  try {
    const graphPage = await freshGraph('blocked');
    graphPage.render(root, app);
    await tick(30);
    eq(dom.workers.created.length, 0, 'a worker was created even though they are blocked');
    ok(state.mainThreadLayouts > 0, 'the main-thread fallback never ran');
    eq(state.instances[state.instances.length - 1].mode, 'main', 'not the in-thread ELK');
    ok(root.querySelectorAll('.gnode').length > 0, 'the fallback drew nothing');
  } finally {
    dom.workers.enabled = true;
  }
});

await check('a worker that never answers is killed and the layout moves to the main thread', async () => {
  dom.workers.created.length = 0;
  const state = installFakeELK();
  global.window.BLUEPRINT_LAYOUT_DEADLINE_MS = 25;
  try {
    const graphPage = await freshGraph('watchdog');
    graphPage.render(root, app);
    await tick(5);
    eq(dom.workers.created.length, 1, 'no worker was made');
    const w = dom.workers.created[0];
    ok(lastLayoutMessage(w), 'no layout was requested of the worker');
    eq(state.mainThreadLayouts, 0, 'the main thread was used before the deadline');
    ok(/laying out \d+ nodes?/.test(statusText()), `status was "${statusText()}"`);

    // …and the worker says nothing, ever.
    await tick(120);
    ok(w.terminated, 'the silent worker was left running');
    ok(state.mainThreadLayouts > 0, 'the watchdog did not fall back to the main thread');
    ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn after the fallback');
    ok(/nodes, \d+ links/.test(statusText()), `status stayed at "${statusText()}"`);
    ok(!layingOut(), 'the stage is still marked as laying out');
    ok(!errorLine(), `an error was shown anyway: "${errorLine() && errorLine().textContent}"`);

    // Every later layout goes straight to the main thread.
    const before = state.mainThreadLayouts;
    graphPage.render(root, app);
    await tick(30);
    eq(dom.workers.created.length, 1, 'a second worker was made after one had died');
    ok(state.mainThreadLayouts > before, 'the second layout went nowhere');
  } finally {
    delete global.window.BLUEPRINT_LAYOUT_DEADLINE_MS;
  }
});

await check('a worker that answers with an error falls back to the main thread', async () => {
  dom.workers.created.length = 0;
  const state = installFakeELK();
  const graphPage = await freshGraph('worker-error');
  graphPage.render(root, app);
  await tick(5);
  eq(dom.workers.created.length, 1, 'no worker was made');
  const w = dom.workers.created[0];
  const req = lastLayoutMessage(w);
  ok(req, 'no layout was requested of the worker');
  w.reply({ id: req.id, error: 'elkjs fell over' });
  await tick(30);
  ok(w.terminated, 'the failing worker was left running');
  ok(state.mainThreadLayouts > 0, 'the rejection did not fall back to the main thread');
  ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn after the fallback');
  ok(/nodes, \d+ links/.test(statusText()), `status stayed at "${statusText()}"`);
  ok(!layingOut(), 'the stage is still marked as laying out');
});

await check('a failure after the layout says so, and the next attempt still works', async () => {
  dom.workers.created.length = 0;
  installFakeELK();
  const graphPage = await freshGraph('draw-error');
  graphPage.render(root, app);
  await tick(5);
  const w = dom.workers.created[0];
  const bad = lastLayoutMessage(w);
  ok(bad, 'no layout was requested of the worker');

  // A well-formed reply that the drawing cannot survive: the failure happens
  // after the promise resolves, which used to leave "laying out…" on screen.
  w.reply({ id: bad.id, data: null });
  await tick(20);
  ok(!layingOut(), 'the stage is still marked as laying out');
  ok(!/laying out/.test(statusText()), `status stayed at "${statusText()}"`);
  ok(/layout failed/.test(statusText()), `status was "${statusText()}"`);
  const line = errorLine();
  ok(line, 'no visible error in the graph pane');
  ok(line.textContent.length > 'Layout failed: '.length, 'the error line says nothing');

  // A second attempt: the same worker, a usable answer.
  graphPage.render(root, app);
  await tick(5);
  const good = lastLayoutMessage(w);
  ok(good && good.id !== bad.id, 'the retry never reached the worker');
  w.reply({ id: good.id, data: fakeLayout(JSON.parse(JSON.stringify(good.graph))) });
  await tick(20);
  ok(root.querySelectorAll('.gnode').length > 0, 'the retry drew nothing');
  ok(/nodes, \d+ links/.test(statusText()), `status stayed at "${statusText()}"`);
  ok(!errorLine(), 'the error line outlived the failure');
});

// --- the real thing, when a copy of elkjs is at hand -------------------------
// Everything above stubs ELK out.  This one runs the actual elk-worker.min.js
// in a node worker thread behind a tiny `self`/`importScripts` shim and drives
// it with the actual `ELK` class out of elk.bundled.js — the same two halves
// the page pairs, so a protocol mismatch like the one this replaced would fail
// here.  elkjs is not vendored, so point the test at a copy:
//
//   curl -sLo /tmp/elk.bundled.js    https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js
//   curl -sLo /tmp/elk-worker.min.js https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk-worker.min.js
//   node web/test/app.test.mjs --elk=/tmp/elk.bundled.js
//
// (or set BLUEPRINT_ELK).  Without it this check is skipped.
const elkArg = (process.argv.find((a) => a.startsWith('--elk=')) || '').slice(6);
const ELK_PATH = elkArg || process.env.BLUEPRINT_ELK || '';
const ELK_WORKER_PATH = process.env.BLUEPRINT_ELK_WORKER ||
  (ELK_PATH ? path.join(path.dirname(path.resolve(ELK_PATH)), 'elk-worker.min.js') : '');

if (ELK_PATH && fs.existsSync(ELK_PATH) && fs.existsSync(ELK_WORKER_PATH)) {
  await check('the real elk-worker.min.js answers the real ELK class', async () => {
    const { Worker: NodeWorker } = await import('node:worker_threads');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const ELK = require(path.resolve(ELK_PATH));

    // What a browser worker gives elk-worker.min.js: a `self`, a
    // `postMessage`, an `importScripts`, and no `document`.
    // `eval: true` runs this in the worker's global scope, where
    // elk-worker.min.js is about to declare a few hundred names of its own, so
    // the shim keeps its own bindings inside a function.
    const host = `
      (function () {
        const { parentPort, workerData } = require('worker_threads');
        const nodeFs = require('fs'), nodeVm = require('vm');
        globalThis.self = globalThis;
        globalThis.postMessage = (m) => parentPort.postMessage(m);
        globalThis.importScripts = function (...urls) {
          for (const u of urls) nodeVm.runInThisContext(nodeFs.readFileSync(u, 'utf8'), { filename: u });
        };
        globalThis.importScripts(workerData.path);
        parentPort.on('message', (m) => {
          if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data: m });
        });
      })();
    `;
    const nodeWorker = new NodeWorker(host, {
      eval: true, workerData: { path: path.resolve(ELK_WORKER_PATH) },
    });
    // elk-api only needs postMessage, onmessage and terminate.
    const adapter = {
      postMessage: (m) => nodeWorker.postMessage(m),
      terminate: () => nodeWorker.terminate(),
    };
    nodeWorker.on('message', (m) => { if (adapter.onmessage) adapter.onmessage({ data: m }); });
    try {
      const elk = new ELK({ workerFactory: () => adapter });
      ok(elk.knownLayoutAlgorithms, 'not the ELK class');
      const graph = graphMod.plainGraph({
        id: 'root',
        layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN' },
        children: [
          { id: 'a', width: 60, height: 30, bp: { back: 'reference' } },
          { id: 'b', width: 60, height: 30 },
        ],
        edges: [{ id: 'e1', sources: ['a'], targets: ['b'] }],
      });
      const laid = await elk.layout(graph);
      eq(laid.children.length, 2, 'the layouter lost a node');
      ok(laid.width > 0 && laid.height > 0, 'the graph got no size');
      const [a, b] = laid.children;
      ok(typeof a.x === 'number' && typeof b.y === 'number', 'nodes got no coordinates');
      ok(b.y > a.y, 'the layered layout did not stack the edge’s ends');
      const algorithms = await elk.knownLayoutAlgorithms();
      ok(algorithms.some((x) => /layered/.test(x.id || x.name || '')), 'no algorithms registered');
    } finally {
      await nodeWorker.terminate();
    }
  });
} else {
  console.log('  - skipped the real elk-worker.min.js check (no --elk=<elk.bundled.js>)');
}

// ---------------------------------------------------------------------------
// the Export PDF button and its dialog (pdf.js)
// ---------------------------------------------------------------------------

{
  const pdf = await import(path.join(webDir, 'pdf.js'));
  const body = dom.document.body;
  const dialogEl = () => body.querySelector('.export-dialog');
  const fire = (node, type, ev = {}) => { for (const fn of (node && node._listeners.get(type)) || []) fn({ target: node, preventDefault() {}, ...ev }); };
  const until = async (fn, what) => {
    for (let i = 0; i < 200; i += 1) { const v = fn(); if (v) return v; await tick(5); }
    throw new Error('timed out waiting for ' + what);
  };
  const statusText = () => (body.querySelector('.export-status') || { textContent: '' }).textContent;
  const routes = dom.net.routes;
  const hash = await app.snapshotHash;
  const exportsDir = 'data/exports/' + hash.slice(0, 16) + '/';
  const fresh = () => { pdf.resetExportState(); routes.length = 0; dom.net.fetches.length = 0; };

  await check('the top bar has a text-labelled Export PDF button, live once the snapshot is in', () => {
    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    ok(/<button[^>]*id="export-pdf"[\s\S]*?<span>Export PDF<\/span>[\s\S]*?<\/button>/.test(html), 'a <button> with its words, in the top bar');
    const b = dom.document.getElementById('export-pdf');
    eq(b.disabled, false, 'enabled after boot');
    ok((b._listeners.get('click') || []).length === 1, 'and wired');
    eq(hash.length, 64, 'the snapshot was fingerprinted');
  });

  await check('on a document page the dialog offers that part, and the whole blueprint', async () => {
    fresh();
    await go('#/document/sec-main');
    ok(root.querySelector('.doc-controls .export-inline'), 'the page has its own Export PDF button');
    await pdf.openExport();
    const d = dialogEl();
    ok(d, 'the dialog opened');
    eq(d.getAttribute('role'), 'dialog', 'a dialog');
    eq(d.getAttribute('aria-modal'), 'true', 'modal');
    const part = d.querySelector('input[value="part"]');
    ok(part && part.hasAttribute('checked'), 'this part is chosen');
    const titles = d.querySelectorAll('.export-part-title').map((x) => x.textContent);
    eq(titles[0], 'Section 2 ' + M_title('sec-main'), 'named by its number and title, not its id');
    ok(d.querySelector('input[value="whole"]'), 'the whole blueprint is one choice away');
    ok(/Section 2 .*all levels: \d+ entries/.test(d.querySelector('.export-summary').textContent), 'it says what the export holds');
    const depths = d.querySelector('select.export-depth').querySelectorAll('option').map((o) => o.getAttribute('value'));
    eq(depths[0], 'all', 'all levels first, and chosen');
    ok(depths.includes('1'), 'and fewer');
    fire(d.querySelector('input[value="whole"]'), 'change');
    ok(/The whole blueprint, all levels/.test(dialogEl().querySelector('.export-summary').textContent), 'switching to the whole blueprint says so');
    pdf.closeExport();
    eq(dialogEl(), null, 'closed');
  });

  await check('at the top of the document, and from an object page, the defaults follow the reader', async () => {
    fresh();
    await go('#/document');
    await pdf.openExport();
    ok(dialogEl().querySelector('input[value="whole"]').hasAttribute('checked'), 'the top of the document: the whole blueprint');
    eq(dialogEl().querySelector('input[value="part"]'), null, 'with no part to offer');
    pdf.closeExport();
    await go('#/object/lem-diagonal');
    await pdf.openExport();
    const d = dialogEl();
    ok(d.querySelector('input[value="part"]').hasAttribute('checked'), 'an object page: a part');
    ok(/Section 2\.1/.test(d.querySelector('.export-part-title').textContent), 'the part the lemma is read in');
    ok(/where Lemma 2\.1\.2 is read/.test(d.querySelector('.export-why').textContent), 'and why');
    pdf.closeExport();
  });

  const pdfBytes = new TextEncoder().encode('%PDF-1.5\nfake but shaped like one\n%%EOF\n');
  const entry = (extra = {}) => ({ collapse: 'refines', scope: 'sec-main', depth: 'all', appendices: true, status: 'ok',
    pdf: 'aaaa.pdf', tex: 'aaaa.tex', fileName: 'compact-2-main', pages: 3, warnings: [], ...extra });
  const manifest = (entries, sha = hash) => JSON.stringify({ version: 1, generator: 'blueprint-pdf/1', snapshot: { sha256: sha }, exports: entries });
  const exportTo = async (hashRoute) => {
    await go(hashRoute);
    await pdf.openExport();
    fire(dialogEl().querySelector('.export-go'), 'click');
    await until(() => body.querySelector('.export-done') || body.querySelector('.export-error'), 'the export to finish');
  };

  await check('a PDF prepared for this snapshot is fetched, checked and offered with its TeX', async () => {
    fresh();
    routes.push((u) => (u.endsWith(exportsDir + 'manifest.json') ? [200, manifest([entry()])] : null));
    routes.push((u) => (u.endsWith(exportsDir + 'aaaa.pdf') ? [200, pdfBytes, 'application/pdf'] : null));
    await exportTo('#/document/sec-main');
    ok(/The PDF is ready: 3 pages/.test(statusText()), statusText());
    const a = body.querySelector('a.export-download');
    eq(a.getAttribute('download'), 'compact-2-main.pdf', 'downloaded under its name');
    ok(/^blob:/.test(a.getAttribute('href')), 'from the bytes that were checked');
    ok(body.querySelectorAll('.export-links a').some((x) => x.getAttribute('download') === 'compact-2-main.tex'), 'the TeX source next to it');
    eq(dom.net.fetches.filter((f) => /api\/export/.test(f.url) && f.init.method === 'POST').length, 0, 'nothing was made: a static site has no server to ask');
    pdf.closeExport();
  });

  await check('an HTML page where the PDF should be is an error, not a download', async () => {
    fresh();
    routes.push((u) => (u.endsWith(exportsDir + 'manifest.json') ? [200, manifest([entry()])] : null));
    routes.push((u) => (u.endsWith(exportsDir + 'aaaa.pdf') ? [200, '<!doctype html><title>404</title>', 'text/html'] : null));
    await exportTo('#/document/sec-main');
    ok(/not a PDF/.test(statusText()), statusText());
    eq(body.querySelector('a.export-download'), null, 'nothing to download');
    pdf.closeExport();
  });

  await check('a manifest of other bytes, another part or no PDF at all: the reader is told, and gets the TeX', async () => {
    fresh();
    // Prepared, but for another revision of the snapshot, and for another part.
    routes.push((u) => (u.endsWith(exportsDir + 'manifest.json') ? [200, manifest([entry()], 'f'.repeat(64))] : null));
    await exportTo('#/document/sec-main');
    ok(/No PDFs were prepared for this site/.test(statusText()), 'another snapshot\'s manifest is not used: ' + statusText());
    pdf.closeExport();
    fresh();
    routes.push((u) => (u.endsWith(exportsDir + 'manifest.json') ? [200, manifest([entry({ scope: 'sec-foundations' })])] : null));
    await exportTo('#/document/sec-main');
    ok(/No PDF was prepared for this choice/.test(statusText()), statusText());
    const button = body.querySelectorAll('.export-status button').find((b) => /TeX source/.test(b.textContent));
    ok(button, 'the TeX source is still offered');
    const before = dom.workers.blobs.size;
    fire(button, 'click');
    await until(() => dom.workers.blobs.size > before, 'the TeX to be written');
    const tex = [...dom.workers.blobs.values()].pop().text;
    ok(tex.startsWith('% Generated by the blueprint tool') && tex.includes('\\begin{document}'), 'a whole LaTeX document, written in the page');
    ok(tex.includes('Section 2: ') && !tex.includes('% object: sec-foundations'), 'of the part that was chosen');
    pdf.closeExport();
  });

  await check('a failed build says why and links its log', async () => {
    fresh();
    routes.push((u) => (u.endsWith(exportsDir + 'manifest.json')
      ? [200, manifest([entry({ status: 'failed', pdf: undefined, error: 'LaTeX error in thm-x (line 80): Undefined control sequence.', log: 'aaaa.log' })])] : null));
    await exportTo('#/document/sec-main');
    ok(/failed when the site was built: LaTeX error in thm-x/.test(statusText()), statusText());
    ok(body.querySelectorAll('.export-error a').some((a) => /aaaa\.log$/.test(a.getAttribute('href'))), 'the log is linked');
    pdf.closeExport();
  });

  await check('with the local server, the PDF of exactly this snapshot and part is made once', async () => {
    fresh();
    const posts = [];
    routes.push((u, init) => {
      if (!u.endsWith('api/export')) return null;
      if (!init.method) return [200, { available: true, reason: null }];
      posts.push(JSON.parse(init.body));
      return [200, { ok: true, base: exportsDir, sha256: hash, entry: entry({ pdf: 'bbbb.pdf', fileName: 'made' }) }];
    });
    routes.push((u) => (u.endsWith(exportsDir + 'bbbb.pdf') ? [200, pdfBytes, 'application/pdf'] : null));
    // What a session before left in the store is not used without asking:
    // the server says whether it is still what the export makes.
    routes.push((u) => (u.endsWith(exportsDir + 'manifest.json') ? [200, manifest([entry({ pdf: 'old.pdf', fileName: 'old' })])] : null));
    await go('#/document/sec-main');
    await pdf.openExport();
    const goButton = dialogEl().querySelector('.export-go');
    fire(goButton, 'click');
    fire(goButton, 'click'); // an impatient second click
    await until(() => body.querySelector('.export-done') || body.querySelector('.export-error'), 'the export');
    eq(posts.length, 1, 'one request, however many clicks');
    same_(posts[0], { snapshot: 'blueprint.json', sha256: hash, collapse: 'refines', scope: 'sec-main', depth: 'all', appendices: true }, 'the request');
    eq(body.querySelector('a.export-download').getAttribute('download'), 'made.pdf', 'and its PDF offered');
    pdf.closeExport();
  });

  await check('a server that cannot make it says why', async () => {
    fresh();
    routes.push((u, init) => {
      if (!u.endsWith('api/export')) return null;
      if (!init.method) return [200, { available: false, reason: 'TeX (pdflatex) is not installed on the machine serving the site' }];
      throw new Error('must not be asked to make one');
    });
    await exportTo('#/document/sec-main');
    ok(/local server cannot make one: TeX \(pdflatex\) is not installed/.test(statusText()), statusText());
    pdf.closeExport();
    fresh();
    routes.push((u, init) => {
      if (!u.endsWith('api/export')) return null;
      if (!init.method) return [200, { available: true }];
      return [422, { ok: false, error: 'LaTeX error in thm-x: Undefined control sequence.', entry: entry({ status: 'failed', log: 'cccc.log', pdf: undefined }), base: exportsDir }];
    });
    await exportTo('#/document/sec-main');
    ok(/LaTeX error in thm-x/.test(statusText()), statusText());
    ok(body.querySelectorAll('.export-error a').some((a) => /cccc\.log$/.test(a.getAttribute('href'))), 'with the log');
    pdf.closeExport();
    fresh();
  });

  function M_title(id) { return app.model.byId.get(id).attrs.title || id; }
  function same_(a, b, what) { eq(JSON.stringify(a), JSON.stringify(b), what); }
}

// ---------------------------------------------------------------------------
// the project's intro
// ---------------------------------------------------------------------------

const intro = await import(path.join(webDir, 'intro.js'));

await check('a project has an intro only with a body, and a duration by default', () => {
  eq(intro.introOf({}), null, 'no intro');
  eq(intro.introOf({ intro: { body: '  \n' } }), null, 'an empty body is none');
  eq(intro.introOf({ intro: 'Welcome' }), null, 'a bare string is not the shape');
  const d = intro.introOf({ intro: { body: 'Welcome' } });
  eq(d.body, 'Welcome', 'the body');
  eq(d.durationMs, intro.DEFAULT_MS, 'the default duration');
  eq(intro.introOf({ intro: { body: 'x', durationMs: 4500 } }).durationMs, 4500, 'its own duration');
  eq(intro.introOf({ intro: { body: 'x', durationMs: -1 } }).durationMs, intro.DEFAULT_MS, 'a nonsense one is the default');
});

await check('the intro is shown on the landing page only, and ?intro=0 leaves it out', () => {
  const p = { intro: { body: 'Welcome' } };
  const at = (raw) => ({ view: raw.startsWith('/graph') ? 'graph' : raw.slice(1).split('/')[0], raw });
  ok(intro.wantsIntro(p, at('/graph'), ''), 'the bare graph is the landing page');
  ok(!intro.wantsIntro(p, at('/graph?sel=thm-tychonoff'), ''), 'a link into the graph opens on it');
  ok(!intro.wantsIntro(p, at('/object/def-compact'), ''), 'a link to an object opens on it');
  ok(!intro.wantsIntro(p, at('/document'), ''), 'and so does one to the document');
  ok(!intro.wantsIntro(p, at('/graph'), '?intro=0'), '?intro=0');
  ok(intro.wantsIntro(p, at('/graph'), '?theme=outline'), 'another parameter keeps it');
  ok(!intro.wantsIntro({}, at('/graph'), ''), 'a project without one');
});

await check('a relative address in the intro is resolved against the snapshot', () => {
  const base = 'https://example.org/site/data/';
  eq(intro.resolveUrl('assets/logo.png', base), 'https://example.org/site/data/assets/logo.png', 'relative');
  eq(intro.resolveUrl('./a.mp4', base), 'https://example.org/site/data/a.mp4', 'dot relative');
  for (const done of ['https://x.org/a.png', 'data:image/png;base64,AAAA', '/root.png',
    '//cdn.org/a.png', '#/object/def-compact', 'mailto:a@b.c']) {
    eq(intro.resolveUrl(done, base), done, `${done} is complete`);
  }
  eq(intro.resolveUrl('a.png', null), 'a.png', 'no base');
});

await check('the intro is drawn over the page, and goes by itself', async () => {
  const host = dom.document.createElement('div');
  const project = app.model.project;
  app.model.project = { ...project, intro: { body: 'Welcome to the **blueprint**.', durationMs: 10 } };
  try {
    const shown = intro.showIntro(app, { host });
    ok(shown, 'nothing shown');
    const layer = host.querySelector('.intro');
    ok(layer, 'no layer');
    eq(layer.getAttribute('role'), 'dialog', 'it is a dialog');
    ok(layer.querySelector('.intro-node .intro-body').textContent.includes('Welcome'), 'the body is rendered');
    ok(layer.querySelector('button.intro-skip'), 'a skip button');
    eq(layer.querySelector('.intro-timer').style.animationDuration, '10ms', 'the timer runs its duration');
    await tick(30);
    ok(layer.classList.contains('leaving'), 'it did not start to leave');
    ok(host.querySelector('.intro'), 'it is still there while it fades');
    await tick(intro.FADE_MS + 50);
    eq(host.querySelector('.intro'), null, 'it is gone after the fade');
  } finally {
    app.model.project = project;
  }
});

await check('a click or a key ends the intro at once', async () => {
  const host = dom.document.createElement('div');
  const project = app.model.project;
  app.model.project = { ...project, intro: { body: 'Welcome', durationMs: 60000 } };
  try {
    const a = intro.showIntro(app, { host });
    fire(a.layer, 'click');
    ok(a.layer.classList.contains('leaving'), 'a click');
    const b = intro.showIntro(app, { host });
    global.window.dispatch('keydown', { key: 'a' });
    ok(!b.layer.classList.contains('leaving'), 'any other key is the page\'s');
    let prevented = false;
    global.window.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
    ok(b.layer.classList.contains('leaving'), 'Escape');
    ok(prevented, 'Escape is taken from the page');
    app.model.project = { ...project };
    eq(intro.showIntro(app, { host }), null, 'no intro, nothing shown');
  } finally {
    app.model.project = project;
  }
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
