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
    'gsearch-input', 'gsearch-panel', 'gsearch-results', 'gsearch-foot'],
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

await check('the top page lists the top level, one level deep', async () => {
  await go('#/document');
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
  // the top page.
  await go('#/document?collapse=refines&focus=sec-main');
  eq(app.route.id, null, 'a chapter is on the top page');
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
  for (const expand of [[], ['sec-main'], [...M.collapseOrder(model, 'refines').expandable]]) {
    const view = M.makeView(model, 'refines', expand);
    const base = { collapse: 'refines', expand, ekinds: null, status: null, q: '', sel: null };
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
  // Collapsed, three arcs go.  The junction for the prose edge
  // uses/thm-tychonoff/lem-ultrafilter has a uses-arc to sec-main and one to
  // sec-foundations, which sec-main uses.  And sec-main -> sec-foundations and
  // sec-applications -> sec-foundations are each also drawn through a junction
  // (a uses edge that something else attaches to): src end -> junction -> tgt
  // end is a path, so the plain arc beside it is implied, and the junction,
  // with its spokes, stays.
  const view = M.makeView(model, 'refines', []);
  const st = { collapse: 'refines', expand: [], ekinds: null, status: null, q: '', sel: null, reduce: true };
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

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
