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
    'gsearch', 'gsearch-input', 'export-pdf'],
  base: webDir,
  snapshot: sample,
});

global.window.marked = fakeMarked();
const katex = fakeKatex();
global.window.renderMathInElement = katex;

// What index.html's inline script does before any module has loaded: ask for
// the snapshot, and leave the request for app.js to pick up.
global.window.blueprintSnapshot = { url: './blueprint.json', response: global.fetch('./blueprint.json') };
dom.net.fetches.length = 0;

global.location.hash = '#/object/def-compact';
const app = (await import(path.join(webDir, 'app.js'))).default;
await tick(20);
await app.rendered;

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
  eq(dom.document.documentElement.getAttribute('data-progress'), 'hidden', 'the page is not marked as hiding it');
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

await check('the snapshot came from the request index.html started, not a second one', () => {
  const again = dom.net.fetches.filter((f) => /blueprint\.json$/.test(f.url));
  eq(again.length, 0, `app.js fetched the snapshot itself: ${JSON.stringify(again.map((f) => f.url))}`);
  eq(global.window.blueprintSnapshot, null, 'the early request was not marked as taken');
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

await check('there is no Checks page: no tab, an old link opens the graph, nothing about checks in the top bar', async () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  ok(!/data-view="checks"/.test(html), 'index.html still has a Checks tab');
  ok(!fs.existsSync(path.join(webDir, 'checks.js')), 'checks.js is still there');
  await go('#/checks?level=error');
  ok(root.querySelector('.graph-page'), '#/checks did not fall back to the graph');
  const aside = dom.document.getElementById('topbar-aside');
  ok(!aside.querySelectorAll('a').some((a) => /checks/.test(a.getAttribute('href') || '')), 'the top bar links to the checks');
  await go('#/object/lem-diagonal');
  ok(!root.querySelectorAll('h3').some((h) => /Checks/.test(h.textContent)), 'the object page lists its checks');
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
  ok(!proofs[0].querySelector('summary a'), 'not a link: a click on it folds or unfolds the proof');
  eq(proofs[0].querySelector('.proof-end').textContent, '\u220e', 'the end mark');
  ok(!proofs[0].hasAttribute('open'), 'folded by default');
  await go('#/object/thm-heine-borel');
  const onObject = root.querySelector('details.proof');
  ok(onObject && onObject.querySelector('summary .proof-word') && !onObject.querySelector('summary a'),
    "the statement's page folds its proof on a click too");
  await go('#/object/' + encodeURIComponent('proof/thm-heine-borel'));
  eq(root.querySelectorAll('.error-box').length, 0, 'the proof has an object page');
});

await check('a proof moved to another section is read there, named by what it proves', async () => {
  const MM = await import(path.join(webDir, 'model.js'));
  const m = app.model;
  const p = m.byId.get('proof/thm-heine-borel');
  const file = p.source.file;
  const reset = () => { m._outlines.clear(); m._positions.clear(); m._proofPlacement.clear(); };
  p.source = { ...p.source, file: 'blueprint/main/thm-heine-borel.proof.md' };
  reset();
  try {
    await go('#/document/sec-applications');
    eq(root.querySelectorAll('.proof').length, 0, 'no longer with its statement');
    ok(root.querySelector('#doc-thm-heine-borel'), 'which is still there');
    await go('#/document/sec-main');
    const proof = root.querySelector('#doc-proof_thm-heine-borel');
    ok(proof && proof.classList.contains('proof'), 'read in the section of its file');
    const num = MM.documentOutline(m, 'refines').byId.get('thm-heine-borel').number;
    eq(proof.querySelector('.proof-word').textContent, `Proof of Theorem ${num}.`, 'named by what it proves');
    ok(!proof.hasAttribute('open'), 'folded, as every proof');
    eq(root.querySelectorAll('nav.toc a[data-id="proof/thm-heine-borel"]').length, 0, 'not in the sidebar');
  } finally {
    p.source = { ...p.source, file };
    reset();
  }
});

await check('every theme has its stylesheet, and picking one loads it', async () => {
  for (const t of THEMES) {
    if (t.id) ok(fs.existsSync(path.join(webDir, 'themes', t.id + '.css')), `themes/${t.id}.css is missing`);
  }
  applyTheme('outline');
  eq(dom.document.getElementById('theme-css').getAttribute('href'), 'themes/outline.css', 'the theme is loaded');
  eq(dom.document.documentElement.getAttribute('data-sidebar'), 'outline', 'and asks for its sidebar');
  await go('#/document/sec-applications');
  ok(root.querySelector('nav.toc.toc-outline'), 'the document marks its sidebar for the outline style');
  ok(root.querySelector('nav.toc-outline ul.toc-levels'), 'the contents one level at a time, as in every style');
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
// 1b. the progress listing's filters, the search box in the top bar and the search page
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
  form: dom.document.getElementById('gsearch'),
  input: dom.document.getElementById('gsearch-input'),
};
const { pageNumbers } = await import(path.join(webDir, 'search.js'));
const searchCount = () => (root.querySelector('h2.search-count') || {}).textContent;
const searchItems = (cls = 'match') => root.querySelectorAll('ul.search-tree li.' + cls);
const itemHref = (li) => li.querySelector('span.preview-title a').getAttribute('href');

await check('the top-bar box asks the search page, or opens the object an id names', async () => {
  await go('#/progress');
  gs.input.value = 'compact';
  const ev = fire(gs.form, 'submit');
  ok(ev.defaultPrevented, 'the form is not sent anywhere');
  global.window.dispatch('hashchange', {});
  await tick(20);
  await app.rendered;
  eq(String(global.location.hash), '#/search?query=compact', 'the search page');
  ok(/^\d+ results/.test(searchCount()), `results counted: ${searchCount()}`);
  eq(root.querySelector('#search-query').value, 'compact', "the page's box says the query");
  eq(gs.input.value, 'compact', "and so does the top bar's");

  gs.input.value = 'compactness';
  fire(gs.input, 'input');
  eq(root.querySelector('#search-query').value, 'compactness', 'typing in one box types in the other');
  root.querySelector('#search-query').value = 'net';
  fire(root.querySelector('#search-query'), 'input');
  eq(gs.input.value, 'net', 'both ways');

  gs.input.value = ' thm-tychonoff ';
  fire(gs.form, 'submit');
  global.window.dispatch('hashchange', {});
  await tick(5);
  eq(String(global.location.hash), '#/object/thm-tychonoff', 'an id goes to its object');
  eq(gs.input.value, '', "and leaves the search page's query behind");

  await go('#/search?query=lem-diagonal');
  await app.rendered;
  eq(String(global.location.hash), '#/object/lem-diagonal', 'so does a search page link to an id');
});

await check('the search page lists the results in document order, as a tree', async () => {
  await go('#/search?query=compact');
  await app.rendered;
  const want = modelMod1.fullTextSearch(app.model, 'compact');
  eq(searchCount(), `${want.length} results (now showing results 1\u2013${Math.min(10, want.length)})`, 'the count');
  const hits = searchItems();
  eq(hits.length, Math.min(10, want.length), 'ten to a page');
  eq(itemHref(hits[0]), '#/document/sec-foundations?collapse=refines&focus=def-compact', 'Definition 1.1 first, in its section');
  eq(hits[0].querySelector('span.preview-title').textContent, 'Definition 1.1: Compact space', 'its line');
  // Its section is there, as context, with the definition under it.
  const top = root.querySelector('ul.search-tree').children[0];
  ok(top.classList.contains('kind-section') && !top.classList.contains('match'), 'the section is context');
  eq(top.querySelector('span.preview-title').textContent, 'Section 1: Foundations', "the section's line");
  // A proof is filed under its statement.
  await go('#/search?query=compact&perpage=all');
  await app.rendered;
  const proof = searchItems().find((li) => li.classList.contains('kind-proof'));
  ok(proof, 'the proof is listed');
  ok(proof.parentNode.parentNode.classList.contains('kind-theorem'), 'under the theorem it proves');
  eq(itemHref(proof), '#/document/sec-applications?collapse=refines&focus=thm-heine-borel', 'and leads to that theorem');
  eq(searchItems().length, want.length, 'all of them on one page');

  // An unquoted hyphenated word: the Stacks project's hint, and the word
  // written as one is found too.
  await go('#/search?query=heine-borel');
  await app.rendered;
  const hint = root.querySelector('p.search-alternative');
  ok(hint && /If the keyword heine-borel is not giving you the results you expect/.test(hint.textContent), 'the hint');
  eq(new URLSearchParams(hint.querySelector('a').getAttribute('href').split('?')[1]).get('query'), '"heine-borel"',
    'it links to the phrase');
  await go('#/search?query=heineborel');
  await app.rendered;
  ok(searchItems().some((li) => li.classList.contains('kind-theorem')), 'heineborel finds heine-borel');
  ok(!root.querySelector('p.search-alternative'), 'with no hint');
});

await check('the search page: magnifier, folding, statements only, no results', async () => {
  await go('#/search?query=compact');
  await app.rendered;
  const li = searchItems()[0];
  const lens = li.querySelector('button.previewable');
  ok(lens, 'a statement has a magnifier');
  const preview = li.querySelector('div.search-preview');
  ok(preview.hidden, 'its statement starts hidden');
  fire(lens, 'click');
  ok(!preview.hidden && li.querySelector('span.preview-title').hidden, 'the statement in place of the line');
  ok(/^Definition 1\.1 \(Compact space\)\. /.test(preview.textContent), `run in: ${preview.textContent.slice(0, 60)}`);
  eq(lens.getAttribute('aria-expanded'), 'true', 'aria-expanded');
  fire(lens, 'click');
  ok(preview.hidden && !li.querySelector('span.preview-title').hidden, 'and back');
  ok(!root.querySelector('ul.search-tree li.kind-section.match button.previewable'), 'a section has none');

  const parent = root.querySelector('ul.search-tree li.has-children');
  fire(parent.querySelector('button.thumb'), 'click');
  ok(parent.classList.contains('collapsed') && parent.querySelector('ul').hidden, 'a triangle folds');
  const expand = root.querySelectorAll('.search-expand button');
  fire(expand[0], 'click');
  ok(parent.classList.contains('expanded') && !parent.querySelector('ul').hidden, 'Expand all');
  fire(expand[1], 'click');
  ok(root.querySelectorAll('ul.search-tree li.has-children').every((x) => x.classList.contains('collapsed')), 'Collapse all');

  const radio = root.querySelector('#search-radius-statements');
  ok(radio && !radio.checked, 'all objects by default');
  radio.checked = true;
  root.querySelector('#search-radius-all').checked = false;
  fire(radio, 'change');
  global.window.dispatch('hashchange', {});
  await tick(5);
  await app.rendered;
  eq(hashParams().get('radius'), 'statements', 'a choice searches again');
  ok(searchItems().every((x) => !x.classList.contains('kind-proof') && !x.classList.contains('kind-section')), 'statements alone');
  ok(root.querySelector('#search-radius-statements').checked, 'and says so');

  await go('#/search?query=zzzzzz');
  await app.rendered;
  eq(searchCount(), 'No results', 'says so');
  eq(searchItems().length, 0, 'lists nothing');

  await go('#/search');
  await app.rendered;
  ok(!searchCount(), 'no count without a query');
  ok(root.querySelector('.search-tips'), 'the tips are there');
});

await check('the search leads into the document; text is found as its section', async () => {
  const node = (id, kind, order, attrs = {}, body = '') =>
    ({ id, kind, boundary: [], attrs: { order, ...attrs }, body, depth: 0 });
  const refines = (src, tgt) => ({ id: `refines/${src}/${tgt}`, kind: 'refines', attrs: {}, body: '', depth: 1,
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }] });
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  const snapshot = {
    version: 1,
    project: { name: 'search' },
    schema: { defaultCollapse: 'refines', kinds: {
      chapter: { boundary: {} }, section: { boundary: {} }, hidden: { boundary: {}, graph: 'never' },
      lemma: { boundary: {}, countable: true }, refines: { ...binary, collapse: true } } },
    objects: [
      node('top', 'hidden', 1, {}, 'A banana before every chapter.'),
      node('ch', 'chapter', 2, { title: 'Fruit' }),
      node('sec', 'section', 3, { title: 'Bananas' }),
      node('note-1', 'hidden', 4, {}, 'The banana opens the section.'),
      node('lem', 'lemma', 5, { title: 'Apples' }, 'Every apple is round.'),
      node('note-2', 'hidden', 6, {}, 'A banana again, between two lemmas.'),
      node('empty', 'section', 7, { title: 'Cherries' }),
      refines('sec', 'ch'), refines('note-1', 'sec'), refines('lem', 'sec'), refines('note-2', 'sec'),
      refines('empty', 'ch')],
    derived: {},
  };
  const saved = { model: app.model, snapshot: app.snapshot };
  app.snapshot = snapshot;
  app.model = modelMod1.buildModel(snapshot);
  try {
    await go('#/search?query=banana');
    await app.rendered;
    eq(searchCount(), '2 results (now showing results 1–2)', 'the section once for its two texts, and the top text');
    const hits = searchItems();
    eq(hits.map((li) => li.querySelector('span.preview-title').textContent).join(' | '), 'Text | Section 1.1: Bananas',
      'no line says Text for the text inside a section');
    eq(itemHref(hits[1]), '#/document/sec?collapse=refines', 'a section leads to its own page');
    eq(itemHref(hits[0]), '#/document?collapse=refines&focus=top', 'text under no heading to its place');

    await go('#/search?query=apple');
    await app.rendered;
    const lem = searchItems()[0];
    eq(itemHref(lem), '#/document/sec?collapse=refines&focus=lem', "a lemma to its section's page, scrolled to it");
    eq(itemHref(root.querySelector('ul.search-tree li.kind-chapter')), '#/document/ch?collapse=refines',
      'the chapter above it, as context, to its own page');
    fire(lem.querySelector('button.previewable'), 'click');
    eq(lem.querySelector('a.environment-identifier').getAttribute('href'), '#/document/sec?collapse=refines&focus=lem',
      "the magnifier's statement too");

    await go('#/search?query=bananas');
    await app.rendered;
    await go(itemHref(searchItems()[0]));
    await app.rendered;
    eq(root.querySelector('section.doc-entry').id, 'doc-sec', "the section's link opens the page it heads");

    await go('#/search?query=cherries');
    await app.rendered;
    eq(itemHref(searchItems()[0]), '#/object/empty', 'what the document leaves out, to its object page');
  } finally {
    app.model = saved.model;
    app.snapshot = saved.snapshot;
  }
});

await check('the search page pages its results as the Stacks project does', async () => {
  eq(pageNumbers(1, 3).join(' '), '1 2 3', 'few pages: all');
  eq(pageNumbers(1, 43).map((n) => n || '…').join(' '), '1 2 3 4 5 … 43', 'the first');
  eq(pageNumbers(20, 43).map((n) => n || '…').join(' '), '1 … 19 20 21 … 43', 'the middle');
  eq(pageNumbers(42, 43).map((n) => n || '…').join(' '), '1 … 39 40 41 42 43', 'the end');
  const saved = { model: app.model, snapshot: app.snapshot };
  app.snapshot = generate({ seed: 3 });
  app.model = modelMod1.buildModel(app.snapshot);
  try {
    const n = modelMod1.fullTextSearch(app.model, 'flat').length;
    ok(n > 20, `enough results to page: ${n}`);
    await go('#/search?query=flat&page=2');
    await app.rendered;
    eq(searchCount(), `${n} results (now showing results 11\u201320)`, 'the second page');
    const pager = root.querySelector('nav.search-pager');
    ok(pager, 'pages');
    eq(pager.querySelector('li.active a').textContent, '2', 'the current one');
    ok(!pager.querySelector('li.search-prev').classList.contains('inactive'), 'a way back');
    eq(new URLSearchParams(pager.querySelector('li.search-next a').getAttribute('href').split('?')[1]).get('page'), '3', 'and on');
    const per = root.querySelectorAll('nav.search-perpage a').map((a) => a.textContent);
    eq(per.join(' '), '10 50 \u221e', 'results per page');
    await go('#/search?query=flat&page=999&perpage=50');
    await app.rendered;
    const last = Math.ceil(n / 50);
    eq(root.querySelector('nav.search-pager li.active a').textContent, String(last), 'a page past the end is the last');
    ok(root.querySelector('nav.search-pager li.search-next').classList.contains('inactive'), 'with nowhere further');
  } finally {
    app.model = saved.model;
    app.snapshot = saved.snapshot;
  }
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

await check('the top page writes out the top level; the contents are a page of their own', async () => {
  await go('#/document');
  const out = modelMod.documentOutline(app.model, 'refines');
  eq(root.querySelectorAll('.doc-entry').length, out.roots.length, 'the top level is written out');
  ok(!entryIds().includes('doc-sec-main-induction'), 'and nothing below it');
  eq(root.querySelectorAll('.contents-tree, .doc-contents').length, 0, 'no contents list on it');
  eq(root.querySelectorAll('.doc-layout').length, 1, 'the sidebar beside it');
  eq(root.querySelectorAll('.doc-controls, .doc-controls select, .proof-toggle, .export-inline').length, 0,
    'no line of controls: order, depth, Fold proofs, Export PDF');
  // An old link that said the depth reads the same.
  await go('#/document?collapse=refines&focus=sec-main');
  eq(root.querySelectorAll('.doc-entry').length, out.roots.length, 'depth=1 is the same page');
  // A chapter's own page leads back here by its breadcrumbs.
  await go('#/document/sec-main');
  ok(hrefs('.doc-crumbs a').includes('#/document?collapse=refines'), 'the chapter page leads back to the top');
  const leaf = out.roots.find((e) => !e.children.length);
  await go('#/document/' + encodeURIComponent(leaf.id));
  eq(root.querySelectorAll('.doc-entry.page-head').length, 1, 'the leaf has a page of its own');
});

await check('the contents page: the headings only, a triangle unfolding each, every row a link to its place', async () => {
  await go('#/contents');
  const out = modelMod.documentOutline(app.model, 'refines');
  const tree = root.querySelector('ol.contents-tree');
  ok(tree, 'a tree');
  eq(root.querySelectorAll('.doc-entry').length, 0, 'nothing written out');
  const rows = () => root.querySelectorAll('.contents-tree li');
  // A row's own parts, not those of the rows below it.
  const own = (li, sel) => li.children[0].querySelector(sel);
  const subOf = (li) => li.children.find((c) => c.tagName === 'OL') || null;
  // What a row leads to: the entry scrolled to, or the page it heads.
  const targetOf = (href) => new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('focus') ||
    decodeURIComponent((/^#\/document\/([^?]+)/.exec(href) || [])[1] || '');
  const row = (id) => rows().find((li) => targetOf(own(li, 'a.contents-link').getAttribute('href')) === id);
  const heading = (e) => modelMod.isContentsEntry(e);
  const listed = out.roots.filter(heading);
  eq(tree.children.length, listed.length, 'a row per top-level heading, folded');
  ok(listed.length < out.roots.filter((e) => !e.text).length, 'the fixture has a top-level entry that is not a heading');
  for (const e of out.roots.filter((x) => !x.text && !heading(x))) eq(row(e.id), undefined, `a row for ${e.id}, not a heading`);
  // Every row leads to the page it heads: a chapter to its own page.
  ok(hrefs('.contents-tree a').includes('#/document/sec-main?collapse=refines'), 'a chapter leads to its own page');
  const main = row('sec-main');
  const toggle = () => own(row('sec-main'), 'button.contents-toggle');
  ok(toggle(), 'a triangle beside an entry with entries below it');
  eq(toggle().getAttribute('aria-expanded'), 'false', 'folded');
  const leaf = listed.find((e) => !e.children.some(heading));
  ok(row(leaf.id).querySelector('.contents-toggle.none'), 'none beside a heading with no heading below it');
  eq(main.querySelectorAll('ol').length, 0, 'its entries are not built yet');

  fire(toggle(), 'click');
  eq(toggle().getAttribute('aria-expanded'), 'true', 'a click unfolds it');
  const sub = subOf(row('sec-main'));
  const kids = out.byId.get('sec-main').children.filter(heading);
  eq(sub.children.length, kids.length, 'a row per heading below it');
  eq(row('thm-tychonoff'), undefined, 'no row for a statement beside them');
  // A section below it leads to its own page; the statements under it have no
  // rows, so it has nothing to unfold.
  const section = kids.find((c) => c.children.length);
  ok(hrefs('.contents-tree a').includes('#/document/' + encodeURIComponent(section.id) + '?collapse=refines'),
    'a section below it leads to its own page');
  ok(section.children.some((c) => !c.text && !heading(c)), 'the fixture section has statements under it');
  ok(row(section.id).querySelector('.contents-toggle.none'), 'with only statements under it, nothing to unfold');
  eq(root.querySelectorAll('.contents-tree .kindword').length, 0, 'no statement anywhere in the tree');

  // What was unfolded stays so on the way back.
  await go('#/document');
  await go('#/contents');
  eq(toggle().getAttribute('aria-expanded'), 'true', 'still unfolded on coming back');
  fire(toggle(), 'click');
  eq(toggle().getAttribute('aria-expanded'), 'false', 'a second click folds it');
  eq(row('sec-main').querySelectorAll('ol').length, 0, 'and its entries go');
  eq(root.querySelectorAll('.doc-controls, button.contents-all, select').length, 0, 'no line of controls above the tree');
});

await check('depth=1 on the top page writes out the top level, one level deep', async () => {
  await go('#/document?depth=1');
  const out = modelMod.documentOutline(app.model, 'refines');
  eq(root.querySelectorAll('.doc-entry').length, out.roots.length, 'one entry per top-level object');
  ok(entryIds().includes('doc-sec-main'), 'a chapter is on it');
  ok(!entryIds().includes('doc-thm-tychonoff'), 'its contents are not');
  // Each chapter leads on to its own page by a "Show details" link in its head.
  ok(hrefs('.doc-entry .head a.doc-open').includes('#/document/sec-main?collapse=refines'), 'a link to the chapter page');
  // Its heading is one link, to its level: the top level, this page.
  const head = root.querySelector('#doc-sec-main .head');
  eq(head.querySelectorAll('a.doc-title').length, 1, 'the heading is one link');
  eq(head.querySelectorAll('a.num, a.objlink').length, 0, 'not a number and a title apart');
  const title = head.querySelector('a.doc-title');
  ok(title.querySelector('.num') && title.querySelector('.doc-title-text'), 'number and title inside it');
  eq(title.getAttribute('href'), '#/document?collapse=refines&focus=sec-main', 'to the top level');
  eq(head.querySelector('a.doc-object').getAttribute('href'), app.objectHref('sec-main'), 'the object page beside it');
  eq(root.querySelectorAll('.doc-crumbs').length, 0, 'no breadcrumbs at the top');
  eq(root.querySelectorAll('.doc-pager').length, 0, 'no siblings at the top');
});

await check('every page of the document ends with the comments of its entry, the top page with its own', async () => {
  const routes = dom.net.routes;
  const asked = () => dom.net.fetches.map((f) => f.url).filter((u) => u.startsWith('api/comments/')).join(' ');
  routes.push((u) => u === 'api/comments/sec-main'
    ? [200, JSON.stringify({ comments: [{ n: 1, name: 'Ada', body: 'On **this** chapter.', date: '2026-11-02T08:00:00+00:00' }] }), 'application/json']
    : u.startsWith('api/comments/') ? [200, '{"comments": []}', 'application/json'] : null);
  try {
    dom.net.fetches.length = 0;
    await go('#/document/sec-main');
    const panel = root.querySelector('.doc-layout .comments');
    ok(panel, 'no comment section on a chapter page');
    eq(asked(), 'api/comments/sec-main', 'the thread of the page\'s own entry');
    eq(panel.querySelector('h3').textContent, 'Comments (1)', 'its heading counts the comments');
    eq(panel.querySelectorAll('article.comment').length, 1, 'the comment is listed');
    ok(panel.querySelector('form.comment-form textarea') && panel.querySelector('form.comment-form button[type=submit]'),
      'the form of the object page');
    const kids = [...panel.parentNode.children];
    eq(kids[kids.length - 1], panel, 'it is the last thing on the page');
    ok(kids.indexOf(panel) > kids.indexOf(root.querySelector('.doc-layout .doc-flow')), 'after the entries');

    dom.net.fetches.length = 0;
    await go('#/object/sec-main');
    eq(asked(), 'api/comments/sec-main', 'the object page shows the same thread');
    eq(root.querySelector('.comments h3').textContent, 'Comments (1)', 'with the same comment');

    dom.net.fetches.length = 0;
    await go('#/document');
    ok(root.querySelector('.doc-layout .comments'), 'no comment section on the top page');
    eq(asked(), 'api/comments/' + encodeURIComponent(':document'), 'the top page has a thread of its own');
    eq(root.querySelector('.comments h3').textContent, 'Comments (0)', 'empty so far');
  } finally {
    routes.length = 0;
  }
});

await check('a comment has a title, is public or private, and goes to the comment server alone, which says where it keeps them', async () => {
  const comments = await import(path.join(webDir, 'comments.js'));
  const routes = dom.net.routes;
  const posts = [];
  let zulip = null; // what the server says of where the comments go
  const listed = [{ n: 1, name: 'Ada', body: 'On **this** chapter.', date: '2026-11-02T08:00:00+00:00' }];
  const reply = (extra) => [200, JSON.stringify({ comments: listed, maxBody: zulip ? 9000 : 20000, ...(zulip ? { zulip } : {}), ...extra }), 'application/json'];
  routes.push((u, init) => {
    if (u === 'comments-config.json') return [404, 'no', 'text/plain'];
    if (u !== 'api/comments/sec-main') return null;
    if (init && init.method === 'POST') {
      const p = JSON.parse(init.body);
      posts.push(p);
      if (p.visibility === 'public') {
        listed.push({ n: listed.length + 1, name: p.name, title: p.title, body: p.body, date: '2026-11-02T09:00:00+00:00',
          ...(zulip ? { topic: p.title } : {}) });
      }
      return reply({ shown: p.visibility === 'public' });
    }
    return reply({});
  });
  comments.resetCommentsConfig();
  const submit = async (panel, body, vis) => {
    const [isPublic, isPrivate] = panel.querySelectorAll('input[type=radio]');
    panel.querySelector('input[name=name]').value = 'Ada';
    panel.querySelector('input[name=title]').value = '  On  ' + body;
    panel.querySelector('textarea').value = body;
    isPublic.checked = vis === 'public'; isPrivate.checked = vis === 'private';
    fire(panel.querySelector('form'), 'submit');
    await tick(5);
  };
  try {
    // The comment files: public or private all the same.
    dom.net.fetches.length = 0;
    await go('#/object/sec-main');
    await tick(5);
    let panel = root.querySelector('.comments');
    eq(panel.querySelector('.comment-visibility').hidden, false, 'public or private can be chosen');
    ok(panel.querySelector('.comment-visibility').textContent.includes('not shown here'), 'and what private means');
    eq(panel.querySelector('textarea').getAttribute('maxlength'), '20000', 'as long as the server takes');
    ok(panel.querySelector('input[name=title]'), 'a title is asked for');
    eq(panel.querySelector('input[name=title]').getAttribute('maxlength'), '60', 'as long as a Zulip topic');
    panel.querySelector('input[name=name]').value = 'Ada';
    panel.querySelector('input[name=title]').value = '';
    panel.querySelector('textarea').value = 'No title.';
    fire(panel.querySelector('form'), 'submit');
    await tick(5);
    eq(posts.length, 0, 'not without a title');
    await submit(panel, 'Only for the authors.', 'private');
    eq(posts.length, 1, 'posted');
    eq(posts[0].title, 'On Only for the authors.', 'with its title, on one line');
    eq(posts[0].visibility, 'private', 'as private');
    ok(/#\/object\/sec-main$/.test(posts[0].page), 'with the page it was written on');
    eq(panel.querySelector('.comment-note').textContent, 'Posted (private: not shown here).', 'and said so');
    eq(panel.querySelector('h3').textContent, 'Comments (1)', 'not shown');
    await submit(panel, 'A public one.', 'public');
    eq(posts[1].visibility, 'public', 'a public one');
    eq(panel.querySelector('h3').textContent, 'Comments (2)', 'shown');
    eq(panel.querySelectorAll('.comment-title')[0].textContent, 'On A public one.', 'with its title');

    // On Zulip: the server says where, and nothing of the bot reaches the page.
    zulip = { site: 'https://zulip.example', channel: 'blueprint comment', topic: 'sec-main', streamId: 7 };
    dom.net.fetches.length = 0;
    await go('#/object/sec-main');
    await tick(5);
    panel = root.querySelector('.comments');
    eq(dom.net.fetches.filter((f) => !f.url.startsWith('api/comments/') && f.url !== 'comments-config.json'
      && /zulip/.test(f.url)).length, 0, 'the page never calls Zulip');
    eq(panel.querySelector('textarea').getAttribute('maxlength'), '9000', 'a comment fits a Zulip message');
    eq(panel.querySelector('form a[target=_blank]').getAttribute('href'),
      'https://zulip.example/#narrow/channel/7-blueprint.20comment', 'a link to the channel');
    ok(panel.querySelector('form').textContent.includes('a topic of its own'), 'each comment a topic of its own');
    await submit(panel, 'Seen on Zulip.', 'public');
    const titles = panel.querySelectorAll('a.comment-title');
    eq(titles.length ? titles[titles.length - 1].getAttribute('href') : null,
      'https://zulip.example/#narrow/channel/7-blueprint.20comment/topic/On.20Seen.20on.20Zulip.2E',
      'a comment\'s title leads to its own topic');
    ok(panel.querySelector('.comment-visibility').textContent.includes('posted to Zulip only'), 'private means Zulip only');
    await submit(panel, 'A private one.', 'private');
    eq(panel.querySelector('.comment-note').textContent, 'Posted to Zulip (private: not shown here).', 'and said so');
    ok(!Object.keys(comments).some((k) => /zulip|topic|headLine/i.test(k)), 'the page has no Zulip code of its own');
  } finally {
    routes.length = 0;
    comments.resetCommentsConfig();
  }
});

await check('a site served elsewhere sends its comments to the server comments-config.json names', async () => {
  const comments = await import(path.join(webDir, 'comments.js'));
  const routes = dom.net.routes;
  routes.push((u) => u === 'comments-config.json'
    ? [200, JSON.stringify({ server: 'https://comments.example', zulip: { site: 'https://zulip.example', channel: 'c' } }), 'application/json']
    : u.startsWith('https://comments.example/api/comments/') ? [200, '{"comments": []}', 'application/json'] : null);
  comments.resetCommentsConfig();
  try {
    dom.net.fetches.length = 0;
    await go('#/object/sec-main');
    await tick(5);
    eq(dom.net.fetches.map((f) => f.url).filter((u) => u.includes('api/comments/')).join(' '),
      'https://comments.example/api/comments/sec-main', 'asked there');
    eq(root.querySelector('.comments h3').textContent, 'Comments (0)', 'and answered');
  } finally {
    routes.length = 0;
    comments.resetCommentsConfig();
  }
});

await check('hide_content takes an entry off its parent\'s page, and leads every link to its own', async () => {
  const o = app.model.byId.get('sec-main');
  const before = o.attrs;
  o.attrs = { ...(o.attrs || {}), hide_content: true };
  try {
    await go('#/document');
    ok(!entryIds().includes('doc-sec-main'), 'chapter 2 is still on the top page');
    ok(entryIds().includes('doc-sec-foundations') && entryIds().includes('doc-sec-applications'), 'the other chapters are');
    ok(root.querySelector('nav.toc a[data-id="sec-main"]'), 'the sidebar no longer lists it');
    eq(root.querySelector('nav.toc a[data-id="sec-main"]').getAttribute('href'), '#/document/sec-main?collapse=refines',
      'the sidebar leads to its own page');
    await go('#/document?depth=2');
    ok(!entryIds().includes('doc-sec-main') && entryIds().includes('doc-sec-main-induction'), 'two levels: its children stay');
    await go('#/document/sec-main');
    eq(entryIds()[0], 'doc-sec-main', 'its own page heads with it');
    ok(root.querySelector('#doc-sec-main .prose'), 'with its prose');
    // An old link to it on the top page goes to its own page.
    await go('#/document?focus=sec-main');
    eq(location.hash, '#/document/sec-main?collapse=refines&focus=sec-main', 'a focus on it goes to its own page');
    await go('#/contents?collapse=refines');
    const link = root.querySelectorAll('a.contents-link').find((a) => a.getAttribute('href') === '#/document/sec-main?collapse=refines');
    ok(link, 'it left the contents, or its row does not lead to its own page');
    ok(/^2(?![.\d])/.test(link.textContent.trim()), `with its number: ${JSON.stringify(link.textContent)}`);
  } finally {
    o.attrs = before;
    await go('#/document');
  }
});

await check('serial: a chapter with no number reads by its title, and the next one closes up', async () => {
  const o = app.model.byId.get('sec-main');
  const before = o.attrs;
  o.attrs = { ...(o.attrs || {}), serial: false };
  app.model._outlines.clear(); // numbers are memoised with the outline
  try {
    await go('#/document');
    const head = root.querySelector('#doc-sec-main .head a.doc-title');
    eq(head.querySelectorAll('.num').length, 0, 'no number, not even an empty one, in its heading');
    eq(head.textContent.trim(), modelMod.titleOf(o), 'its heading is its title');
    ok(/Show details\s+\S/.test(root.querySelector('#doc-sec-main a.doc-open').textContent), 'the link on names it');
    eq(root.querySelector('#doc-sec-applications .head .num').textContent, '2', 'the next chapter closes up');
    // Inside it: its own series.
    await go('#/document/sec-main');
    eq(root.querySelector('#doc-sec-main-induction .head .num').textContent, '1', 'a section inside it');
    eq(root.querySelector('#doc-thm-tychonoff .head .num').textContent, '3', 'a statement inside it');
    const crumb = root.querySelector('.doc-crumbs .here').textContent;
    eq(crumb, modelMod.titleOf(o), 'its breadcrumb is its title, with no number before it');
    await go('#/contents?collapse=refines');
    const link = root.querySelectorAll('a.contents-link').find((a) => a.getAttribute('href') === '#/document/sec-main?collapse=refines');
    eq(link.querySelector('.num').textContent, '', 'its contents row has no number');
  } finally {
    o.attrs = before;
    app.model._outlines.clear();
    await go('#/document');
  }
});

await check('depth=2 inlines a second level', async () => {
  await go('#/document?depth=2');
  ok(entryIds().includes('doc-sec-main-induction'), 'sections are written out');
  ok(!entryIds().includes('doc-lem-finite-subcover'), 'their contents are not');
  ok(hrefs('a.doc-open').includes('#/document/sec-main-induction?collapse=refines&depth=2'),
    'the depth travels with the links');
});

await check('a chapter page: breadcrumbs, its entries, its siblings', async () => {
  await go('#/document/sec-main');
  eq(app.route.id, 'sec-main', 'routed');
  eq(entryIds().join(' '), 'doc-sec-main doc-sec-main-induction doc-thm-tychonoff', 'the page and one level below');
  eq(root.querySelectorAll('.doc-entry.page-head .head h1').length, 1, 'the page entry is the title');
  // Every heading stays on the page it is on, scrolled to itself: the
  // chapter's own title too.
  const level = (id) => root.querySelector('#doc-' + id + ' .head a.doc-title').getAttribute('href');
  eq(level('sec-main'), '#/document/sec-main?collapse=refines&focus=sec-main', 'the page title stays on its page');
  eq(level('sec-main-induction'), '#/document/sec-main?collapse=refines&focus=sec-main-induction', 'a section too');
  await go('#/document/sec-main-induction');
  eq(level('lem-finite-subcover'), '#/document/sec-main-induction?collapse=refines&focus=lem-finite-subcover',
    'a lemma on its section\'s page');
  eq(level('sec-main-induction'), '#/document/sec-main-induction?collapse=refines&focus=sec-main-induction',
    'and the section, on its own page');
  await go('#/document/sec-main?depth=2');
  eq(level('lem-finite-subcover'), '#/document/sec-main?collapse=refines&depth=2&focus=lem-finite-subcover',
    'a lemma written out deeper stays on this page');
  await go('#/document/sec-main');
  ok(hrefs('.doc-crumbs a').includes('#/document?collapse=refines'), 'breadcrumbs lead to the top');
  eq(root.querySelectorAll('.doc-pager').length, 2, 'neighbours above and below');
  const pager = root.querySelectorAll('.doc-pager')[0];
  eq(pager.querySelectorAll('a.prev')[0].getAttribute('href'), '#/document/sec-foundations?collapse=refines', 'previous chapter');
  eq(pager.querySelectorAll('a.next')[0].getAttribute('href'), '#/document/sec-applications?collapse=refines', 'next chapter');
  eq(pager.querySelectorAll('a.up')[0].getAttribute('href'), '#/document?collapse=refines', 'up to the top');
});

await check('a click on any title stays on the page, scrolled to it', async () => {
  const click = (a) => fire(root.querySelector('.doc-flow'), 'click', { target: a, button: 0 });
  const title = (sel) => root.querySelector(sel + ' .head a.doc-title');
  await go('#/document/sec-main');
  for (const id of ['sec-main-induction', 'thm-tychonoff', 'sec-main']) {
    const ev = click(title('#doc-' + id));
    ok(ev.defaultPrevented, `${id}: the click left the page`);
    eq(app.route.id, 'sec-main', `${id}: still the chapter's page`);
    eq(hashParams().get('focus'), id, `${id}: the link says where`);
  }
  // A repeated entry's title stays too, on its repeat.
  await go('#/document/sec-applications');
  const dup = root.querySelector('section.doc-entry.dup');
  ok(dup, 'no repeated entry on the page');
  const ev = click(dup.querySelector('.head a.doc-title'));
  ok(ev.defaultPrevented, 'the repeated entry\'s title left the page');
  eq(app.route.id, 'sec-applications', 'still its page');
  // A ctrl-click opens this page at it in a new tab.
  await go('#/document/sec-main');
  ok(!fire(root.querySelector('.doc-flow'), 'click', { target: title('#doc-thm-tychonoff'), button: 0, ctrlKey: true }).defaultPrevented,
    'a ctrl-click is the browser\'s');
});

await check('the sidebar lists the headings of the level the page writes out, the entry gone to opened', async () => {
  const own = (li) => li.querySelector('a');
  const id = (li) => own(li).getAttribute('data-id');
  const ups = () => root.querySelectorAll('nav.toc li.toc-up').map(id);
  const entries = () => root.querySelectorAll('nav.toc li.toc-entry');
  const link = (x) => entries().concat(root.querySelectorAll('nav.toc li.toc-up')).map(own)
    .find((a) => a.getAttribute('data-id') === x);
  const opened = () => entries().filter((li) => li.classList.contains('open')).map(id);
  const out = modelMod.documentOutline(app.model, 'refines');
  const chapters = out.roots.filter((e) => modelMod.isContentsEntry(e) && !e.duplicate).map((e) => e.id).join(' ');
  // A chapter from a reference: the page is the chapters, the sidebar the
  // chapters with this one opened on its sections.
  await go('#/document?collapse=refines&focus=sec-main');
  eq(ups().length, 0, 'no chain at the top level');
  eq(entries().filter((li) => !li.parentNode.parentNode.classList.contains('open')).map(id).join(' '), chapters,
    'the chapters, and no relation or statement of the top level');
  eq(opened().join(' '), 'sec-main', 'the chapter gone to opened');
  ok(link('sec-main-induction'), 'on its sections');
  eq(link('thm-tychonoff'), undefined, 'not on its statements');
  // Every entry leads to the page it heads, as the contents do: another
  // chapter to its own page, even from the page that writes it out.
  eq(link('sec-foundations').getAttribute('href'), '#/document/sec-foundations?collapse=refines', 'a chapter leads to its page');
  let ev = fire(link('sec-foundations'), 'click');
  ok(!ev.defaultPrevented, 'and is followed, not scrolled to');
  eq(link('sec-main-induction').getAttribute('href'), '#/document/sec-main-induction?collapse=refines',
    'a section leads to its own page');
  ev = fire(link('sec-main-induction'), 'click');
  ok(!ev.defaultPrevented, 'which is another page: followed');
  // On the chapter's page: its sections, not its statements; the page's own
  // entry scrolls to the top.
  await go('#/document/sec-main');
  eq(ups().join(' '), 'sec-main', 'the chapter as a heading');
  eq(entries().map(id).join(' '), 'sec-main-induction', 'over its one section');
  ev = fire(link('sec-main'), 'click');
  ok(ev.defaultPrevented, 'the page\'s own entry scrolls, it does not route');
  // A statement gone to opens nothing of its own: the heading it is under.
  await go('#/document/sec-main?collapse=refines&focus=thm-tychonoff');
  eq(opened().length, 0, 'a statement of the page: nothing opened');
  await go('#/document/sec-main?collapse=refines&depth=2&focus=lem-finite-subcover');
  eq(opened().join(' '), 'sec-main-induction', 'a statement of a section written out: that section opened');
  await go('#/document/sec-main?collapse=refines&focus=sec-main-induction');
  eq(entryIds().join(' '), 'doc-sec-main doc-sec-main-induction doc-thm-tychonoff', 'the page writes out the sections');
  eq(ups().join(' '), 'sec-main', 'the sidebar: the chapter as a heading');
  eq(opened().join(' '), 'sec-main-induction', 'over the section gone to, opened');
  eq(link('lem-finite-subcover'), undefined, 'its statements not listed');
  eq(link('sec-foundations'), undefined, 'the other chapters gone');
  // The chain leads to the pages its entries head.
  eq(link('sec-main').getAttribute('href'), '#/document/sec-main?collapse=refines', 'the heading leads to its page');
  // A section with only statements under it is read among its siblings.
  await go('#/document/sec-main-induction');
  eq(ups().join(' '), 'sec-main', 'a section page with no section under it: the chain above it');
  eq(opened().join(' '), 'sec-main-induction', 'the section itself opened among its siblings');
  eq(link('lem-finite-subcover'), undefined, 'and no statement listed');
});

await check('in the Outline style the sidebar is the contents unfolded down to the page, the page\'s own entry folding', async () => {
  applyTheme('outline');
  try {
    const id = (li) => li.querySelector('a').getAttribute('data-id');
    const link = (x) => root.querySelector('nav.toc a[data-id="' + x + '"]');
    const top = () => root.querySelector('nav.toc ul.toc-levels').children.map(id).join(' ');
    const out = modelMod.documentOutline(app.model, 'refines');
    const listed = (es) => es.filter((e) => modelMod.isContentsEntry(e) && !e.duplicate).map((e) => e.id).join(' ');
    const under = (x) => listed(out.byId.get(x).children);
    const listedUnder = (x) => {
      const ul = link(x).parentNode.querySelector('ul');
      return ul ? ul.children.map(id).join(' ') : '';
    };
    await go('#/document/sec-main-induction');
    ok(root.querySelector('nav.toc.toc-outline'), 'the outline sidebar');
    eq(top(), listed(out.roots), 'every chapter listed, and nothing else of the top level');
    eq(listedUnder('sec-main'), under('sec-main'), 'the chapter unfolded on every one of its sections');
    eq(listedUnder('sec-main-induction'), '', 'the section, with only statements under it, has nothing to unfold');
    eq(listedUnder('sec-foundations'), '', 'another chapter left folded');
    eq(root.querySelectorAll('nav.toc a[data-id="lem-finite-subcover"], nav.toc a[data-id="thm-tychonoff"]').length, 0,
      'no statement listed');
    // A click on the page's own entry folds its sections away, another
    // unfolds them; it stays on the page.
    await go('#/document/sec-main');
    eq(listedUnder('sec-main'), under('sec-main'), 'the chapter\'s page: the chapter unfolded');
    let ev = fire(link('sec-main'), 'click');
    ok(ev.defaultPrevented, 'the page\'s own entry does not route');
    eq(listedUnder('sec-main'), '', 'folded by a click');
    ok(link('sec-main').parentNode.classList.contains('shut'), 'and marked so');
    eq(top(), listed(out.roots), 'the rest stays as it was');
    fire(link('sec-main'), 'click');
    eq(listedUnder('sec-main'), under('sec-main'), 'unfolded by another');
    // Another chapter leads to its page, as before.
    ev = fire(link('sec-foundations'), 'click');
    ok(!ev.defaultPrevented, 'another chapter is another page: followed');
  } finally {
    applyTheme('');
  }
});

await check('a nested page has the whole chain in its breadcrumbs', async () => {
  await go('#/document/sec-main-induction');
  ok(hrefs('.doc-crumbs a').includes('#/document/sec-main?collapse=refines'), 'the chapter is in the chain');
  const text = root.querySelectorAll('.doc-crumbs')[0].textContent;
  ok(/2\.1/.test(text), `the page's own number is in the breadcrumbs: ${text}`);
  ok(entryIds().includes('doc-lem-finite-subcover'), 'its statements are written out');
});

await check('an old ?focus= link opens the level the entry is on', async () => {
  await go('#/document?focus=lem-finite-subcover');
  eq(app.route.id, 'sec-main-induction', 'redirected to the section page');
  eq(global.location.hash, '#/document/sec-main-induction?collapse=refines&focus=lem-finite-subcover', 'the URL says so');
  ok(dom.document.getElementById('doc-lem-finite-subcover'), 'and the entry is on it');
  // A focus the page does show is scrolled to where it is: a chapter is on
  // the top page written out, and the contents send it there too.
  await go('#/document?collapse=refines&focus=sec-main');
  eq(app.route.id, null, 'a chapter is on the top page written out');
  await go('#/document?collapse=refines&focus=sec-main');
  eq(app.route.id, null, 'the contents send it to its level');
  eq(global.location.hash, '#/document?collapse=refines&focus=sec-main', 'the top level written out');
  // A section on another chapter's page goes to its chapter's page, not its own.
  await go('#/document/sec-foundations?focus=sec-main-induction');
  eq(app.route.id, 'sec-main', 'a section opens the page with its siblings');
  // A focus the current page does show stays where it is.
  await go('#/document/sec-main?depth=2&focus=lem-diagonal');
  eq(app.route.id, 'sec-main', 'no redirect when the page shows it');
  // A step is read with its source, on its source's level: here the top.
  await go('#/document/sec-foundations?focus=' + encodeURIComponent('uses/sec-main/sec-foundations'));
  eq(app.route.id, null, 'a step opens its source\'s level');
  ok(dom.document.getElementById('doc-uses_sec-main_sec-foundations'), 'the step block is anchored');
});

await check('a repeated object points at where it is written out', async () => {
  await go('#/document/sec-applications');
  const dup = root.querySelectorAll('.doc-entry.dup');
  eq(dup.length, 1, 'lem-diagonal is repeated here');
  eq(dup[0].id, '', 'the repetition does not take the anchor');
  ok(/Lemma 2\.2\b/.test(dup[0].textContent), 'it carries the number of the first occurrence');
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

await check('a citation reads as a paper sets it, "[Del74, Exp. X]", each label a link to its entry', async () => {
  const saved = { model: app.model, snapshot: app.snapshot };
  const snap = JSON.parse(JSON.stringify(app.snapshot));
  const add = (o) => snap.objects.push({ boundary: [], attrs: {}, body: '', depth: 0, ...o });
  add({ id: 'sec-refs', kind: 'section', attrs: { title: 'References', order: 99 } });
  for (const [id, attrs] of [
    ['del74', { author: ['P. Deligne'], title: 'La conjecture de Weil. I', journal: 'Publ. Math. IHÉS', volume: '43', year: '1974' }],
    ['del80', { author: ['P. Deligne'], title: 'La conjecture de Weil. II', journal: 'Publ. Math. IHÉS', volume: '52', year: '1980' }],
    ['sga4', { label: 'SGA4', title: 'Théorie des topos', year: '1972' }],
  ]) {
    add({ id, kind: 'reference', attrs });
    add({ id: `refines/${id}/sec-refs`, kind: 'refines', depth: 1, boundary: [{ role: 'src', id }, { role: 'tgt', id: 'sec-refs' }] });
  }
  app.snapshot = snap;
  app.model = modelMod1.buildModel(snap);
  try {
    const div = dom.document.createElement('div');
    app.renderBody(div, 'As [del74] and [del74, del80] show, see [sga4, Thm. $x$, *Cor.* 4.3]; but [m, n] and [def-compact, 2] stay.', app.knownIds());
    // `[id]` is linked in the text, after marked and KaTeX.
    const single = div.querySelectorAll('.cite');
    eq(single.map((c) => c.textContent).join(' | '), '[Del74]', 'a single citation');
    eq(single[0].querySelector('a.cite-label').getAttribute('href'), '#/document/sec-refs?collapse=refines&focus=del74', 'to the entry, on its page');
    eq(single[0].querySelector('a.cite-label').getAttribute('data-ref'), 'del74', 'with a preview on hover');
    // `[a, b]` and `[a, locator]` become HTML before marked runs, so that a
    // locator with maths or emphasis is still one citation; the shim keeps
    // the markup marked was given as the element's HTML.
    const html = div.innerHTML;
    ok(html.includes('<span class="cite">&#91;<a class="objlink ref cite-label" href="#/document/sec-refs?collapse=refines&amp;focus=del74" title="del74" data-ref="del74">Del74</a>, ' +
      '<a class="objlink ref cite-label" href="#/document/sec-refs?collapse=refines&amp;focus=del80" title="del80" data-ref="del80">Del80</a>&#93;</span>'), `several at once: ${html}`);
    ok(html.includes('data-ref="sga4">SGA4</a>, Thm. $x$, *Cor.* 4.3&#93;</span>'), 'a locator, its Markdown left to marked');
    ok(html.includes('but [m, n] and [def-compact, 2] stay'), 'brackets that cite nothing stay text');
    const code = dom.document.createElement('div');
    app.renderBody(code, 'Code: `` a ` [del74, x] ``, and\n\n~~~\n[del74, y]\n~~~\n\n    [del74, z]\n\nand a link [see [del74, w]](https://e.org).', app.knownIds());
    ok(!code.innerHTML.includes('cite-label'), `no citation is made in code or in a link's text: ${code.innerHTML}`);
    eq(div.querySelectorAll('a.objlink.broken').length, 0, 'and are not broken links');
    await go('#/document/sec-refs');
    await app.rendered;
    const items = root.querySelectorAll('.doc-entry.is-reference');
    eq(items.map((i) => i.querySelector('.bib-label').textContent).join(' '), '[Del74] [Del80] [SGA4]', 'the bibliography, by label');
    eq(items[0].getAttribute('id'), 'doc-del74', 'each entry an anchor');
  } finally {
    app.model = saved.model;
    app.snapshot = saved.snapshot;
  }
  await go('#/object/def-compact');
});

await check('on an object page a reference reads "Definition 1.2" and leads to its level in the document', async () => {
  await go('#/object/def-compact');
  const r = refTo('def-filter');
  ok(r, `no link for [def-filter]: ${JSON.stringify(refLinks())}`);
  eq(r.text, 'Definition 1.2', 'the document number');
  eq(r.href, '#/document/sec-foundations?collapse=refines&focus=def-filter', 'the page it is read on, scrolled to it');
  const div = dom.document.createElement('div');
  app.renderBody(div, '[sec-main-induction], [sec-main] and [refines/def-compact/sec-foundations]', app.knownIds());
  const [sec, chapter, edge] = div.querySelectorAll('a.objlink');
  eq(sec.getAttribute('href'), '#/document/sec-main?collapse=refines&focus=sec-main-induction',
    'a section: its chapter\'s page, with its siblings');
  eq(chapter.getAttribute('href'), '#/document?collapse=refines&focus=sec-main',
    'a chapter: the top level written out');
  eq(edge.getAttribute('href'), '#/object/' + encodeURIComponent('refines/def-compact/sec-foundations'),
    'what the document does not number: its object page');
  // "In the document" on an object page leads to its level too.
  const inDoc = () => root.querySelectorAll('a').find((a) => a.textContent === 'In the document →').getAttribute('href');
  await go('#/object/sec-main-induction');
  eq(inDoc(), '#/document/sec-main?collapse=refines&focus=sec-main-induction', 'a section, in the document');
  await go('#/object/sec-main');
  eq(inDoc(), '#/document?collapse=refines&focus=sec-main', 'a chapter, in the document');
  await go('#/object/def-compact');
  // An unknown slug is a broken link exactly as before.
  await go('#/object/thm-stone-cech');
  const b = refLinks().find((x) => x.broken);
  eq(b.text, 'def-uniformity', 'a broken link keeps its slug');
  eq(b.href, null, 'and leads nowhere: there is no Checks page to send it to');
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
  eq(div.querySelectorAll('a')[0].textContent, 'Theorem 6', 'instance_of numbers');
  await go('#/graph?sel=def-compact');
  app.renderBody(div, '[thm-heine-borel]', app.knownIds());
  eq(div.querySelectorAll('a')[0].textContent, 'Theorem 3.1', 'the default order');
});

await check('in the graph a reference enters the level of what it names and selects it', async () => {
  await go('#/graph?collapse=refines&reduce=0&sel=def-compact');
  const div = dom.document.createElement('div');
  app.renderBody(div, '[thm-tychonoff] and [sec-main-induction]', app.knownIds());
  const [thm, sec] = div.querySelectorAll('a.objlink').map((a) => new URLSearchParams(a.getAttribute('href').split('?')[1]));
  eq(div.querySelectorAll('a.objlink')[0].getAttribute('href').split('?')[0], '#/graph', 'stays in the graph');
  eq(thm.get('expand'), 'sec-main', 'a statement: the sections above it opened');
  eq(thm.get('sel'), 'thm-tychonoff', 'and it selected');
  eq(thm.get('reduce'), '0', 'the rest of the view kept');
  eq(sec.get('expand'), 'sec-main,sec-main-induction', 'a section: opened too, so the reader is in it');
  await go('#/document');
});

await check('in the document a reference leads to the level of the entry', async () => {
  await go('#/document/sec-foundations');
  dom.observers.flush();
  // def-compact refers to def-filter, on the same page.
  const same = refTo('def-filter');
  eq(same.text, 'Definition 1.2', 'numbered');
  eq(same.href, '#/document/sec-foundations?collapse=refines&focus=def-filter', 'this page, scrolled to it');
  // sec-foundations' own prose refers to thm-tychonoff, read on sec-main's page.
  const other = refTo('thm-tychonoff');
  eq(other.text, 'Theorem 2.3', 'numbered');
  eq(other.href, '#/document/sec-main?collapse=refines&focus=thm-tychonoff', 'the page it is read on');
  // A section: its chapter's page, with its siblings, never its own.
  await go('#/document/sec-main?depth=2');
  dom.observers.flush();
  const sec = refTo('sec-main-induction');
  eq(sec.text, 'Section 2.1', 'a section');
  eq(sec.href, '#/document/sec-main?collapse=refines&depth=2&focus=sec-main-induction',
    'the page with its siblings, here this one');
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

await check('the side panel reads prose first and folds it and the long listings', async () => {
  // sec-foundations, collapsed, has prose, incident objects and relations
  // hidden inside it.
  await go('#/graph?sel=sec-foundations');
  const names = sideSections();
  const at = (re) => names.findIndex((n) => re.test(n));
  ok(at(/^Prose$/) >= 0, `no prose in ${JSON.stringify(names)}`);
  ok(at(/^Incident objects \(6\)$/) > at(/^Prose$/), `incident objects before the prose: ${JSON.stringify(names)}`);
  ok(at(/^Hidden inside \(3\)$/) > at(/^Incident objects/), `hidden inside before the incidents: ${JSON.stringify(names)}`);
  const folds = root.querySelectorAll('aside.side section.fold');
  eq(folds.map((f) => f.getAttribute('data-fold')).join(' '), 'prose incident hidden', 'the prose and the two listings are disclosures');
  const [prose, ...listings] = folds.map((f) => f.querySelector('details'));
  ok(!prose.hasAttribute('open'), 'the prose starts open');
  ok(prose.querySelector('.excerpt.body-prose'), 'the prose is inside its disclosure');
  for (const d of listings) ok(!d.hasAttribute('open'), `${d.querySelector('summary').textContent} starts open`);
  eq(listings[0].querySelectorAll('ul.objlist li').length, 6, 'the incident rows are there, only shut');
});

await check('the side panel heads with the title, a link into the document, and the kind, and no id', async () => {
  await go('#/graph?sel=sec-foundations');
  const head = root.querySelector('aside.side .side-head');
  ok(head, 'no heading row');
  eq(head.getAttribute('data-id'), 'sec-foundations', 'the row names the object it is for');
  const o = app.model.byId.get('sec-foundations');
  const a = head.querySelector('h2 a.side-title');
  ok(a, 'the title is not a link');
  eq(a.textContent, modelMod.titleOf(o), 'the title');
  eq(a.getAttribute('href'), '#/document?collapse=refines&focus=sec-foundations',
    'a chapter: the top level of the document, scrolled to it');
  eq(root.querySelectorAll('aside.side a').filter((x) => /Open in document/.test(x.textContent)).length, 0,
    'the old "Open in document" link is still there');
  const kind = head.querySelector('.badge.kind');
  ok(kind, 'no kind beside the title');
  eq(kind.textContent, app.kindBadge(o.kind).textContent, 'the kind');
  eq(root.querySelectorAll('aside.side .meta .badge.kind').length, 0, 'the kind is written twice');
  await go('#/graph?sel=sec-main-induction&expand=sec-main');
  eq(root.querySelector('aside.side .side-head a.side-title').getAttribute('href'),
    '#/document/sec-main?collapse=refines&focus=sec-main-induction', 'a section: its chapter\'s page, with its siblings');
  await go('#/graph?sel=sec-foundations');
  eq(root.querySelector('aside.side .obj-id'), null, 'the id is still shown under the title');
  const top = [head, root.querySelector('aside.side .meta')].filter(Boolean).map((n) => n.textContent).join(' ');
  ok(!top.includes('sec-foundations'), `the id is written at the top of the panel: ${JSON.stringify(top)}`);
});

await check('an opened listing stays open while the panel is rebuilt', async () => {
  await go('#/graph?sel=sec-foundations');
  const incident = () => root.querySelector('aside.side section.fold[data-fold="incident"] details');
  const d = incident();
  fire(d, 'toggle', { target: { open: true } });
  // Another route change rebuilds the panel; the listing is open on the next
  // selection too, and shut again once the reader shuts it.
  await go('#/graph?sel=sec-main');
  ok(incident().hasAttribute('open'), 'the incident listing snapped shut');
  fire(incident(), 'toggle', { target: { open: false } });
  await go('#/graph?sel=sec-foundations');
  ok(!incident().hasAttribute('open'), 'the incident listing stayed open after it was shut');
  // The prose, which starts folded, stays open once the reader opens it.
  const prose = () => root.querySelector('aside.side section.fold[data-fold="prose"] details');
  ok(!prose().hasAttribute('open'), 'the prose starts open');
  fire(prose(), 'toggle', { target: { open: true } });
  await go('#/graph?sel=sec-main');
  ok(prose().hasAttribute('open'), 'the opened prose folded again on the next selection');
  fire(prose(), 'toggle', { target: { open: false } });
  await go('#/graph?sel=sec-foundations');
  ok(!prose().hasAttribute('open'), 'the prose stayed open after it was folded');
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

/** The document's "object" links that show Lean names, by the object they are of. */
const leanLinks = () => new Map(root.querySelectorAll('.doc-entry .head a.doc-object[data-lean]')
  .map((b) => [b.getAttribute('data-lean'), b]));

await check('the document has no Lean mark: the object link of a heading with Lean names shows them', async () => {
  await go('#/document/sec-foundations?collapse=refines');
  eq(root.querySelectorAll('.doc-entry .head .lean-mark').length, 0, 'a Lean mark beside a heading');
  const links = leanLinks();
  ok(links.size > 0, 'no object link showing Lean names on the page');
  for (const h of root.querySelectorAll('.doc-entry .head')) {
    const a = h.querySelector('a.doc-object');
    if (!a) continue;
    const id = decodeURIComponent(a.getAttribute('href').replace('#/object/', ''));
    const n = M.leanNamesOf(app.model.byId.get(id)).length;
    eq(a.getAttribute('data-lean'), n ? id : null, `the object link of ${id} (${n} Lean names)`);
    eq(a.textContent, 'object', `the object link of ${id} keeps its word`);
  }
  eq(links.get('def-filter').getAttribute('href'), '#/object/def-filter', 'a link to the object page');
});

await check('resting on the object link opens a card of its Lean declarations', async () => {
  await go('#/document/sec-foundations?collapse=refines');
  const link = leanLinks().get('def-filter');
  preview.hover(link);
  await tick(SHOWN);
  eq(cards().length, 1, 'one card');
  const card = cards()[0].card;
  ok(card.classList.contains('lean-card'), 'the Lean card, not the statement');
  const names = card.querySelectorAll('ul.lean-names li');
  eq(names.length, 2, 'one row per name');
  eq(names.map((li) => li.querySelector('code').textContent).join(' '), 'Compact.Filter Compact.Ultrafilter', 'the names');
  eq(names[0].querySelector('a.lean-name').getAttribute('href'), '#/object/def-filter?lean=Compact.Filter', 'each name leads to its declaration on the object page');
  eq(names[0].querySelector('a.lean-docs').getAttribute('href'),
    'https://example.github.io/compact/docs/Compact.html#Compact.Filter', 'and to its documentation');
  eq(card.querySelector('.preview-lead').textContent, 'Lean declarations (2)', 'the head counts them');
  preview.hover(root);
  await tick(GONE);
  eq(cards().length, 0, 'the card outlived the pointer');
});

await check('the object page numbers its Lean declarations and leads each with its docstring', async () => {
  await go('#/object/def-filter');
  const panel = root.querySelector('details.panel[data-fold="lean"]');
  ok(panel, 'the Lean declarations fold like the other panels');
  // The shim does not reflect the attribute onto the property.
  ok(panel.hasAttribute('open'), 'and start open');
  const decls = panel.querySelectorAll('.lean-decl');
  eq(decls.map((d) => d.querySelector('.lean-num').textContent).join(' '), '1 2', 'numbered in order');
  // Compact.Filter has no docstring: its name is the heading.
  ok(decls[0].querySelector('.lean-notation.is-name code'), 'a name without a docstring heads its own entry');
  eq(decls[0].querySelector('.lean-meta code'), null, 'and is not repeated beneath');
  // Compact.Ultrafilter has one: it leads, the name beneath it.
  ok(decls[1].querySelector('.lean-notation').textContent.includes('A maximal filter.'), 'the docstring leads');
  eq(decls[1].querySelector('.lean-meta code').textContent, 'Compact.Ultrafilter', 'the name beneath it');
  ok(!panel.querySelector('.lean-decl .doc'), 'the docstring is not repeated at the foot');
});

await check('a Lean card link opens the panel and lands on the declaration', async () => {
  await go('#/object/def-filter?lean=Compact.Ultrafilter');
  const panel = root.querySelector('details.panel[data-fold="lean"]');
  ok(panel.open || panel.hasAttribute('open'), 'the panel is open for the link');
  const target = panel.querySelector('[data-lean="Compact.Ultrafilter"]');
  ok(target.classList.contains('flash'), 'the declaration asked for is marked');
  await go('#/object/def-filter?lean=');
  ok(root.querySelector('details.panel[data-fold="lean"]').classList.contains('flash'), '?lean= marks the panel');
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

await check('an expanded section draws its contents\' arcs to the sections still shut, both ways', () => {
  const model = app.model;
  const st = { collapse: 'refines', expand: [], ekinds: null, status: null, q: '', sel: null, reduce: false, inner: false };
  const arcsOf = (expand) => {
    const view = M.makeView(model, 'refines', expand);
    const g = graphMod.buildElk({ model }, { ...st, expand }, view, M.quotient(view));
    return g.graph.edges.filter((e) => e.bp.kind === 'edge').map((e) => e.bp.entity);
  };
  const ids = (arcs) => arcs.map((e) => `${e.src}->${e.tgt}`);
  const open = arcsOf(['sec-applications']);
  // Stone-Čech uses the ultrafilter lemma, shut inside sec-foundations; the
  // diagonal lemma uses the finite subcover lemma, shut inside sec-main.
  ok(ids(open).includes('thm-stone-cech->sec-foundations'), `out of the open section to a shut one: ${ids(open)}`);
  ok(ids(open).includes('lem-diagonal->sec-main'), `and to another: ${ids(open)}`);
  // Between the two shut sections, only the arc declared on them.
  const shut = open.find((e) => e.src === 'sec-main' && e.tgt === 'sec-foundations');
  eq(shut.members.map((x) => x.id).join(' '), 'uses/sec-main/sec-foundations', 'a shut section drew its contents\' arc');
  // The other way: with sec-main open, Heine-Borel (shut in sec-applications)
  // is an instance of Tychonoff.
  const other = ids(arcsOf(['sec-main']));
  ok(other.includes('sec-applications->thm-tychonoff'), `from a shut section into the open one: ${other}`);
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

await check('the top bar: the style menu and Show progress on the first row; the search and Export PDF on the second, which the graph has not', async () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const between = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  const first = between('<div class="topbar-main">', '<div class="topbar-tools">');
  const second = between('<div class="topbar-tools">', '</header>');
  ok(/<nav class="tabs"[\s\S]*<\/nav>[\s\S]*id="topbar-aside"/.test(first), 'the aside is not after the tabs on the first row');
  ok(!/topbar-aside/.test(second), 'the aside is still on the second row');
  ok(/id="gsearch"/.test(second) && /id="export-pdf"/.test(second), 'the search and Export PDF are on the second row');
  ok(/setAttribute\('data-view', view\)/.test(html), 'index.html does not mark the page before it loads');
  const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');
  ok(/html\[data-view="graph"\] \.topbar-tools \{ display: none; \}/.test(css), 'the graph still has the second row');

  const view = () => dom.document.documentElement.getAttribute('data-view');
  await go('#/graph?collapse=refines');
  eq(view(), 'graph', 'the graph');
  await go('#/document');
  eq(view(), 'document', 'the document');
  await go('#/object/def-compact');
  eq(view(), 'object', 'an object page');
  await go('#/checks');
  eq(view(), 'graph', 'an old link the graph answers');
  const aside = dom.document.getElementById('topbar-aside');
  ok(aside.querySelector('select.theme-select') && aside.querySelector('button.progress-toggle'),
    'the style menu and Show progress are in the aside');
});

await check('the top bar\'s icon replays the intro, and the toolbar has no Replay intro', async () => {
  const project = app.model.project;
  const { watchBrand } = await import(path.join(webDir, 'app.js'));
  const brand = dom.document.createElement('a');
  brand.className = 'brand';
  const mark = dom.document.createElement('span');
  mark.className = 'brand-mark';
  const text = dom.document.createElement('span');
  text.className = 'brand-text';
  brand.appendChild(mark);
  brand.appendChild(text);
  watchBrand(brand);
  // A click on a part of the brand, as it reaches the brand's listener.
  const click = (target, ev = {}) => fire(brand, 'click', { target, ...ev });
  const intros = () => dom.document.body.querySelectorAll('.intro').filter((n) => !n.classList.contains('leaving'));
  try {
    app.model.project = { ...project, intro: { body: 'Welcome', durationMs: 60000 } };
    await go('#/progress');
    await go('#/graph');
    eq(root.querySelectorAll('.toolbar .intro-replay').length, 0, 'the toolbar still has Replay intro');
    ok(!click(text).defaultPrevented, 'the title no longer links to the graph');
    eq(intros().length, 0, 'the title plays the intro');
    ok(!click(mark, { metaKey: true }).defaultPrevented && intros().length === 0, 'a click for a new tab plays it');
    ok(click(mark).defaultPrevented, 'the icon follows its link');
    eq(intros().length, 1, 'the icon does not play the intro');
    click(mark);
    eq(intros().length, 1, 'again over itself');
    for (const n of intros()) n.parentNode.removeChild(n);

    app.model.project = { ...project };
    ok(!click(mark).defaultPrevented, 'the icon of a project with no intro is not its link');
    eq(intros().length, 0, 'an intro for a project with none');
  } finally {
    for (const n of intros()) n.parentNode.removeChild(n);
    app.model.project = project;
  }
});

await check('`/` focuses the top bar\'s search, and on the graph the graph\'s own', async () => {
  const focused = [];
  const spy = (e, name) => { e.focus = () => focused.push(name); e.select = () => {}; };
  const key = () => {
    let prevented = false;
    dom.document.dispatch('keydown', { key: '/', target: dom.document.documentElement, preventDefault() { prevented = true; } });
    return prevented;
  };
  spy(dom.document.getElementById('gsearch-input'), 'top bar');
  await go('#/document');
  ok(key(), 'the key was left to the page');
  await go('#/graph?collapse=refines');
  spy(root.querySelector('.toolbar .tb-search input'), 'graph');
  ok(key(), 'the key was left to the page on the graph');
  eq(focused.join(', '), 'top bar, graph', 'what took the focus');
});

await check('the graph opens with its toolbar folded, no sidebar and no statistics, until the reader asks', async () => {
  const store = new Map();
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  const bar = () => root.querySelector('.toolbar');
  const page = () => root.querySelector('.graph-page');
  const stage = () => root.querySelector('.graph-stage');
  const button = (sel) => bar().querySelector(sel);
  const mountGraph = async () => { await go('#/progress'); await go('#/graph?collapse=refines'); };
  try {
    await mountGraph();
    // What stays: Collapse all, the search and the zoom, outside the fold.
    const kept = [...bar().childNodes].map((n) => n.className);
    for (const c of ['tb-toggle', 'group tb-collapse', 'group tb-search', 'group tb-zoom', 'tb-stats', 'tb-side']) {
      ok(kept.includes(c), `${c} is not one of the toolbar's own items: ${JSON.stringify(kept)}`);
    }
    eq(button('.tb-collapse button').textContent, 'Collapse all', 'Collapse all is kept');
    eq(button('.tb-zoom').textContent, 'Fit+\u2212', 'the zoom is kept');
    const folded = button('.tb-filters');
    eq(bar().querySelectorAll('select').length, 0, 'no choice of collapse order');
    ok(!bar().querySelectorAll('button').some((b) => /Expand all/.test(b.textContent)), 'there is still an Expand all');
    ok(!folded.querySelectorAll('button').some((b) => b.textContent === 'Collapse all'), 'Collapse all is folded away');
    ok(folded.querySelectorAll('label.chk').length > 0, 'the filters are behind Filters');
    ok(!bar().classList.contains('open'), 'the filters start unfolded');
    eq(button('.tb-toggle').getAttribute('aria-expanded'), 'false', 'Filters says it is shut');
    ok(page().classList.contains('side-hidden'), 'the sidebar starts shown');
    eq(button('.tb-side').textContent, 'Show sidebar', 'the toolbar offers the sidebar');
    ok(stage().classList.contains('stats-hidden'), 'the statistics start shown');
    ok(root.querySelector('#graph-status').textContent.length > 0, 'and are not kept up to date meanwhile');
    eq(button('.tb-stats').textContent, 'Show statistics', 'the toolbar offers the statistics');
    const order = [...bar().childNodes].map((n) => n.className);
    eq(order.indexOf('tb-side') - order.indexOf('tb-stats'), 1, `not beside Show sidebar: ${JSON.stringify(order)}`);
    const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');
    ok(/\.graph-stage\.stats-hidden:not\(\.laying-out\) \.graph-status \{ display: none; \}/.test(css),
      'the statistics are not hidden, or hidden while a layout runs too');

    fire(button('.tb-toggle'), 'click');
    fire(button('.tb-side'), 'click');
    fire(button('.tb-stats'), 'click');
    ok(!stage().classList.contains('stats-hidden'), 'Show statistics did not show them');
    eq(button('.tb-stats').textContent, 'Hide statistics', 'the button offers to hide them again');
    eq(button('.tb-stats').getAttribute('aria-pressed'), 'true', 'and says they are shown');
    eq(store.get('blueprint.graph.stats'), 'shown', 'the shown statistics are not remembered');
    ok(bar().classList.contains('open'), 'Filters did not unfold');
    ok(!page().classList.contains('side-hidden'), 'Show sidebar did not show it');
    eq(button('.tb-side').textContent, 'Hide sidebar', 'the button offers to hide it again');
    eq(store.get('blueprint.graph.tools'), 'shown', 'the unfolded filters are not remembered');
    eq(store.get('blueprint.graph.side'), 'shown', 'the shown sidebar is not remembered');

    // A redraw and a fresh graph page keep the reader's choice.
    await go('#/graph?collapse=refines&reduce=0');
    ok(bar().classList.contains('open') && !page().classList.contains('side-hidden'), 'lost on a redraw');
    ok(!stage().classList.contains('stats-hidden'), 'the statistics lost on a redraw');
    await mountGraph();
    ok(bar().classList.contains('open') && !page().classList.contains('side-hidden'), 'lost on a fresh page');
    ok(!stage().classList.contains('stats-hidden'), 'the statistics lost on a fresh page');

    fire(button('.tb-toggle'), 'click');
    fire(button('.tb-side'), 'click');
    fire(button('.tb-stats'), 'click');
    eq(store.get('blueprint.graph.stats'), 'hidden', 'hiding the statistics is not remembered');
    ok(stage().classList.contains('stats-hidden'), 'the statistics did not hide again');
    eq(store.get('blueprint.graph.tools'), 'hidden', 'folding the filters is not remembered');
    eq(store.get('blueprint.graph.side'), 'hidden', 'hiding the sidebar is not remembered');
    ok(!bar().classList.contains('open') && page().classList.contains('side-hidden'), 'did not hide again');
  } finally {
    delete global.localStorage;
    await mountGraph();
  }
});

await check('Hide progress takes the statuses and bars from the graph and the document, not the Progress page; Show brings them back', async () => {
  const aside = dom.document.getElementById('topbar-aside');
  const toggle = () => aside.querySelector('button.progress-toggle');
  const html = dom.document.documentElement;
  const badges = () => root.querySelectorAll('span.badge').filter((b) => /\bstatus-/.test(b.className));
  await go('#/object/thm-tychonoff');
  eq(toggle().textContent, 'Hide progress', 'the button offers to hide');
  ok(aside.querySelector('a.row'), 'the top bar shows the progress figure');
  ok(badges().length > 0, 'an object page shows its status');
  ok(root.querySelectorAll('.bar').length > 0, 'and its progress');
  await go('#/contents?collapse=refines');
  ok(root.querySelectorAll('.contents-tree .bar').length > 0, 'the contents show progress bars');
  await go('#/document?collapse=refines&depth=1');
  ok(root.querySelectorAll('.doc-progress').length > 0, 'the document shows progress bars');

  fire(toggle(), 'click');
  await tick(5);
  try {
    eq(app.showProgress, false, 'the progress is hidden');
    eq(html.getAttribute('data-progress'), 'hidden', 'for the stylesheet too');
    const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');
    ok(!/data-progress="hidden"\][^{]*data-view="progress"/.test(css), 'the stylesheet drops the Progress tab');
    eq(toggle().textContent, 'Show progress', 'the button offers to show');
    eq(aside.querySelector('a.row'), null, 'no progress figure in the top bar');
    eq(root.querySelectorAll('.doc-progress').length, 0, 'no progress bars in the document');
    await go('#/contents?collapse=refines');
    eq(root.querySelectorAll('.contents-tree .bar').length, 0, 'nor in the contents');
    await go('#/object/thm-tychonoff');
    eq(badges().length, 0, 'no status on an object page');
    eq(root.querySelectorAll('.bar').length, 0, 'nor progress');
    await go('#/graph?collapse=refines&status=proved');
    const lbls = root.querySelectorAll('.toolbar span.lbl').map((l) => l.textContent);
    ok(lbls.includes('edges') && !lbls.includes('status'), 'the graph offers no status filter');
    ok(!root.querySelector('.legend').textContent.includes('no Lean ref'), 'and its key no fills');
    await go('#/progress');
    ok(root.querySelectorAll('table').length > 0, 'the Progress page lost its tables');
    ok(root.querySelectorAll('.stat').length > 0, 'and its counts');
    ok(root.querySelectorAll('table .bar').length > 0, 'and the bars in its tables');
    ok(badges().length > 0, 'and the statuses in its listing');
    ok(!root.textContent.includes('progress is hidden'), 'it says the progress is hidden');
  } finally {
    fire(toggle(), 'click');
    await tick(5);
  }
  eq(app.showProgress, true, 'shown again');
  eq(html.getAttribute('data-progress'), null, 'still marked as hidden');
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

await check('a section box carries its number in the document before its title', async () => {
  const outline = M.documentOutline(app.model, app.model.defaultCollapse || app.model.collapseKinds[0]);
  // A long title is wrapped onto lines of its own, which join with no space.
  const label = (n) => n.querySelector('.label').textContent.replace(/\s+/g, '');
  const flat = (t) => t.replace(/\s+/g, '');
  const nodes = root.querySelectorAll('.gnode').filter((n) => !n.classList.contains('junction'));
  const sections = nodes.filter((n) => M.isSectionKind(app.model.byId.get(n.dataset.id).kind));
  ok(sections.length > 0, 'no section box was drawn');
  for (const n of sections) {
    const o = app.model.byId.get(n.dataset.id);
    const e = outline.byId.get(o.id);
    eq(label(n), flat((e && e.number != null ? e.number : '') + M.titleOf(o)), `the box of ${o.id}`);
    if (e && e.number != null) ok(n.querySelector('tspan').textContent.startsWith(e.number + ' '), `no number on ${o.id}`);
  }
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

await check('inside a section the level it was opened from is faded but in reach, and arcs across its edge are kept', async () => {
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
  ok(!nodeAt('sec-main').classList.contains('outside'), 'the section itself is faded');
  ok(!nodeAt('thm-tychonoff').classList.contains('outside'), 'what is inside it is faded');
  ok(nodeAt('sec-foundations').classList.contains('outside'), 'the level it was opened from is not faded');
  eq(nodeAt('sec-foundations').getAttribute('tabindex'), '0', 'and out of reach of Tab');
  for (const e of root.querySelectorAll('.gedge')) {
    const inside = (nid) => nid === 'sec-main' || nid === 'thm-tychonoff' || nid === 'sec-main-induction';
    eq(e.classList.contains('outside'), !inside(e.dataset.src) && !inside(e.dataset.tgt),
      `${e.dataset.src} -> ${e.dataset.tgt}`);
  }
  const inSec = (nid) => nid === 'sec-main' || nid === 'thm-tychonoff' || nid === 'sec-main-induction';
  ok(root.querySelectorAll('.gedge').some((e) => inSec(e.dataset.src) !== inSec(e.dataset.tgt)),
    'the sample has no arc across the section\'s edge to test');
  eq(back.hidden, false, 'no way back');
  eq(back.textContent, '↑ Back to the top level', 'the way back');

  await layout('#/graph?collapse=refines&expand=sec-main,sec-main-induction');
  ok(nodeAt('sec-main').classList.contains('outside'), 'one level down, the section above is not faded');
  ok(!nodeAt('lem-finite-subcover').classList.contains('outside'), 'and the new level faded');
  ok(back.textContent.endsWith('Back to ' + M.titleOf(app.model.byId.get('sec-main'))), back.textContent);

  fire(back, 'click');
  const req = lastLayoutMessage(w);
  w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
  await tick(5);
  eq(new URLSearchParams(app.route.params).get('expand'), 'sec-main', 'Back closes the section');
  ok(!nodeAt('sec-main').classList.contains('outside'), 'the level above is still faded');

  await layout('#/graph?collapse=refines');
  ok(!layer.classList.contains('entered'), 'at the top nothing is entered');
  eq(outside('.gnode').length + outside('.gtitle').length + outside('.gedge').length, 0, 'and something faded');
  eq(back.hidden, true, 'nor a way back');
});

await check('the key shows the dashed line when an expanded section draws a dashed arc to a collapsed one', async () => {
  const w = dom.workers.created[dom.workers.created.length - 1];
  const layout = async (hash) => {
    await go(hash);
    const req = lastLayoutMessage(w);
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
  };
  const stage = () => root.querySelector('.graph-stage');
  const dashed = () => root.querySelectorAll('.gedge').filter((g) => g.classList.contains('state-derived-only'));
  await layout('#/graph?collapse=refines');
  eq(dashed().length, 0, 'collapsed, nothing is dashed');
  ok(!stage().classList.contains('derived-arcs'), 'and the key has no dashed line');
  await layout('#/graph?collapse=refines&expand=sec-applications');
  ok(dashed().length > 0, 'the arcs out of sec-applications into the collapsed sections are not dashed');
  ok(stage().classList.contains('derived-arcs'), 'the key does not show the dashed line');
  await layout('#/graph?collapse=refines');
  ok(!stage().classList.contains('derived-arcs'), 'collapsed again, the key still shows it');
});

await check('"hide implied" starts on and the arcs of contents off, the Filters dot shows when one filters, and no arc carries a count', async () => {
  const w = dom.workers.created[dom.workers.created.length - 1];
  const layout = async (hash) => {
    await go(hash);
    const req = lastLayoutMessage(w);
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
  };
  const bar = () => root.querySelector('.toolbar');
  const box = (group, n = 0) => bar().querySelectorAll(`.group.${group} input`)[n];
  const dot = () => bar().querySelector('.tb-toggle').classList.contains('filtered');
  const status = () => root.querySelector('.graph-status').textContent;
  await layout('#/graph?collapse=refines');
  ok(box('reduce') && box('reduce').hasAttribute('checked'), '"hide implied" starts unticked');
  ok(box('reduce', 1) && !box('reduce', 1).hasAttribute('checked'), '"arcs of contents" starts ticked');
  ok(!dot(), 'the Filters dot shows by default');
  ok(/\d+ implied arcs? hidden/.test(status()), 'the status line does not count the hidden implied arcs');
  fire(box('reduce'), 'change', { target: { checked: false } });
  await tick(5);
  const req = lastLayoutMessage(w);
  w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
  await tick(5);
  eq(new URLSearchParams(location.hash.split('?')[1]).get('reduce'), '0', 'unticking it writes reduce=0');
  ok(!/implied arc/.test(status()), 'with every arc, the status line counts no hidden implied arcs');
  ok(!dot(), 'no Filters dot with every arc drawn');
  for (const hash of ['#/graph?collapse=refines&inner=1']) {
    await layout(hash);
    ok(dot(), `no Filters dot with ${hash.split('&')[1]}`);
  }
  // With the arcs of contents several relations share one arc: still no count.
  const lifted = graphMod.buildElk({ model: app.model },
    { collapse: 'refines', expand: [], ekinds: null, status: null, q: '', sel: null, reduce: false, inner: true },
    modelMod.makeView(app.model, 'refines', []), modelMod.quotient(modelMod.makeView(app.model, 'refines', [])));
  ok([...lifted.edgeMeta.values()].some((m) => m.kind === 'edge' && m.entity.members.length > 1),
    'no arc stands for several relations here');
  const counts = root.querySelectorAll('.gedge .elabel').filter((t) => /^×/.test(t.textContent));
  eq(counts.length, 0, 'an arc carries a count');
  await layout('#/graph?collapse=refines');
});

await check('unfolding or folding a node fits the graph into the stage; a filter keeps the view', async () => {
  const w = dom.workers.created[dom.workers.created.length - 1];
  const layout = async (hash) => {
    await go(hash);
    const req = lastLayoutMessage(w);
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
  };
  const transform = () => root.querySelector('g.glayer').getAttribute('transform');
  const button = (text) => root.querySelectorAll('.toolbar button').find((b) => b.textContent === text);
  const fit = () => { fire(button('Fit'), 'click'); return transform(); };
  await layout('#/graph?collapse=refines');
  const zoomed = () => { fire(button('+'), 'click'); return transform(); };
  // Zoomed in by hand, a filter keeps the view.
  const z = zoomed();
  ok(z !== fit(), 'the zoom did not move the view');
  zoomed();
  const before = transform();
  await layout('#/graph?collapse=refines&reduce=0');
  eq(transform(), before, 'a filter moved the view');
  // Unfolding a section fits the new graph, as Fit would.
  zoomed();
  await layout('#/graph?collapse=refines&reduce=0&expand=sec-main');
  const opened = transform();
  eq(fit(), opened, 'unfolding did not fit the graph');
  // So does folding it again.
  zoomed();
  await layout('#/graph?collapse=refines&reduce=0');
  const shut = transform();
  eq(fit(), shut, 'folding did not fit the graph');
  ok(opened !== shut, 'the two graphs fit the same way: nothing was checked');
  await layout('#/graph?collapse=refines');
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

await check('the graph fetches elkjs itself: the page half for the worker, the bundle only for the main thread', async () => {
  const elkTags = () => dom.document.querySelectorAll('script[src*="elkjs"]');
  const fireScript = (tag, type) => { for (const fn of tag._listeners.get(type) || []) fn({ target: tag }); };
  const before = elkTags().length;
  const saved = global.window.ELK;
  global.window.ELK = null;
  dom.workers.created.length = 0;
  try {
    const graphPage = await freshGraph('cdn');
    graphPage.prepare(app);
    await tick(1);
    let tags = elkTags().slice(before);
    eq(tags.length, 1, 'prepare() did not ask for exactly one script');
    eq(tags[0].getAttribute('src'), 'https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk-api.js', 'not the page half');
    ok(/^sha384-/.test(tags[0].getAttribute('integrity')), 'elk-api.js is loaded without its integrity hash');
    eq(tags[0].getAttribute('crossorigin'), 'anonymous', 'crossorigin');
    // A layout asked for while it is on its way waits for it, not a second copy.
    graphPage.render(root, app);
    await tick(5);
    eq(elkTags().length - before, 1, 'the layout fetched elk-api.js a second time');
    eq(dom.workers.created.length, 0, 'a worker was started before ELK was there');

    // It arrives: the worker starts, and the bundle is never asked for.
    const state = installFakeELK();
    fireScript(tags[0], 'load');
    await tick(5);
    eq(dom.workers.created.length, 1, 'no worker once elk-api.js was in');
    eq(state.instances[state.instances.length - 1].mode, 'worker', 'not driving the worker');
    const w = dom.workers.created[0];
    const req = lastLayoutMessage(w);
    ok(req, 'the layout that waited for ELK never reached the worker');
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
    ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn once ELK was in');
    ok(!elkTags().slice(before).some((t) => /elk\.bundled\.js$/.test(t.getAttribute('src'))), 'the bundle was fetched for a worker layout');

    // Workers blocked by a policy, which shows only once one is made: the
    // main thread then needs the whole of elkjs, and fetches it only then.
    global.window.ELK = null;
    dom.workers.enabled = false;
    const blocked = await freshGraph('cdn-blocked');
    const seen = elkTags().length;
    blocked.render(root, app);
    await tick(5);
    const api = elkTags().slice(seen);
    eq(api.length, 1, 'the page half was not asked for first');
    installFakeELK();
    fireScript(api[0], 'load');
    await tick(5);
    tags = elkTags().slice(seen).filter((t) => /elk\.bundled\.js$/.test(t.getAttribute('src')));
    eq(tags.length, 1, 'the main-thread fallback did not fetch elk.bundled.js');
    ok(/^sha384-/.test(tags[0].getAttribute('integrity')), 'elk.bundled.js is loaded without its integrity hash');
    // The CDN is down: the graph says so rather than "laying out…" for ever.
    fireScript(tags[0], 'error');
    await tick(5);
    ok(/ELK could not be loaded/.test(statusText()), `status was "${statusText()}"`);
    ok(!layingOut(), 'the stage is still marked as laying out');
  } finally {
    dom.workers.enabled = true;
    global.window.ELK = saved;
  }
});

await check('the worker index.html starts for the graph is taken over, once, and only if it is the pinned one', async () => {
  const saved = global.window.ELK;
  try {
    // The one it started: no second worker, and the page drives this one.
    let state = installFakeELK();
    dom.workers.created.length = 0;
    const early = new global.Worker('blob:http://localhost/early');
    global.window.blueprintElkWorker = { src: graphMod.ELK_WORKER, worker: early, failed: false };
    let graphPage = await freshGraph('early-worker');
    graphPage.render(root, app);
    await tick(5);
    eq(dom.workers.created.length, 1, 'a second worker was started beside the early one');
    ok(state.instances[state.instances.length - 1].worker === early, 'ELK is not driving the early worker');
    eq(global.window.blueprintElkWorker, null, 'the early worker was not marked as taken');
    const req = lastLayoutMessage(early);
    ok(req, 'no layout was asked of the early worker');
    early.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
    ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn from its answer');

    // One importing some other file, or one that already failed, is dropped.
    for (const [tag, entry] of [
      ['stale', { src: 'https://cdn.jsdelivr.net/npm/elkjs@0.9.2/lib/elk-worker.min.js', failed: false }],
      ['failed', { src: graphMod.ELK_WORKER, failed: true }],
    ]) {
      state = installFakeELK();
      dom.workers.created.length = 0;
      const old = new global.Worker('blob:http://localhost/' + tag);
      global.window.blueprintElkWorker = { ...entry, worker: old };
      graphPage = await freshGraph('early-' + tag);
      graphPage.render(root, app);
      await tick(5);
      ok(old.terminated, `the ${tag} early worker was left running`);
      const used = state.instances[state.instances.length - 1].worker;
      ok(used && used !== old, `the ${tag} early worker was used`);
      ok(String(used.url).startsWith('blob:') && used.source.includes(graphMod.ELK_WORKER), 'its replacement is not the pinned worker');
      const r = lastLayoutMessage(used);
      used.reply({ id: r.id, data: fakeLayout(JSON.parse(JSON.stringify(r.graph))) });
      await tick(5);
    }
  } finally {
    global.window.ELK = saved;
    global.window.blueprintElkWorker = null;
  }
});

await check('a layout is remembered under its exact input, and drawn again without ELK', async () => {
  const items = new Map();
  let full = false;
  global.localStorage = {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); items.set(k, String(v)); },
    removeItem: (k) => { items.delete(k); },
  };
  const saved = global.window.ELK;
  try {
    // The first time: ELK lays it out, and it is kept.
    installFakeELK();
    dom.workers.created.length = 0;
    let graphPage = await freshGraph('remember-1');
    graphPage.render(root, app);
    await tick(5);
    const w = dom.workers.created[0];
    const req = lastLayoutMessage(w);
    ok(req, 'the first layout did not go to ELK');
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await tick(5);
    const drawn = root.querySelectorAll('.gnode').map((g) => g.getAttribute('transform')).join(' ');
    ok(drawn, 'nothing was drawn the first time');
    const names = [...items.keys()].filter((k) => k.startsWith('blueprint.layout.'));
    eq(names.length, 1, 'the layout was not kept');
    const entry = JSON.parse(items.get(names[0]));
    eq(entry.elk, graphMod.ELK_WORKER, 'the entry does not say which ELK made it');
    eq(entry.input, JSON.stringify(req.graph), 'the entry is not keyed by the exact input');

    // A new page load, the same graph: drawn from memory, no ELK at all.
    installFakeELK();
    dom.workers.created.length = 0;
    graphPage = await freshGraph('remember-2');
    graphPage.render(root, app);
    await tick(5);
    eq(dom.workers.created.length, 0, 'a worker was started for a remembered layout');
    eq(root.querySelectorAll('.gnode').map((g) => g.getAttribute('transform')).join(' '), drawn,
      'the remembered layout is not the one ELK gave');
    ok(/nodes, \d+ links/.test(statusText()), `status was "${statusText()}"`);
    ok(!layingOut(), 'the stage is marked as laying out');

    // Another ELK's layout, or an entry for another input under the same name,
    // is never used.
    for (const tamper of [(e) => ({ ...e, elk: 'https://example.org/elk-worker.min.js' }),
      (e) => ({ ...e, input: e.input.replace('"id"', '"id" ') })]) {
      items.set(names[0], JSON.stringify(tamper(entry)));
      eq(graphMod.rememberedLayout(entry.input), null, 'an entry that does not match was used');
    }
    items.set(names[0], JSON.stringify(entry));
    ok(graphMod.rememberedLayout(entry.input), 'the untampered entry is not found');

    // Bounded: only the last few are kept, and their index stays in step.
    for (let i = 0; i < 20; i += 1) graphMod.rememberLayout(`{"id":"g${i}"}`, '{"id":"root","children":[]}');
    const kept = [...items.keys()].filter((k) => k.startsWith('blueprint.layout.'));
    ok(kept.length <= 12, `${kept.length} layouts kept`);
    eq(JSON.parse(items.get('blueprint.layouts')).sort().join(), kept.sort().join(), 'the index lists other entries than are kept');
    ok(graphMod.rememberedLayout('{"id":"g19"}'), 'the newest was dropped');
    eq(graphMod.rememberedLayout('{"id":"g0"}'), null, 'the oldest was kept');
    // Too large to be worth the space: not kept.
    graphMod.rememberLayout('{"id":"big"}', 'x'.repeat(500000));
    eq(graphMod.rememberedLayout('{"id":"big"}'), null, 'a huge layout was kept');

    // Full storage, or storage that throws on access: no cache, nothing worse.
    full = true;
    graphMod.rememberLayout('{"id":"full"}', '{"id":"root"}');
    eq(graphMod.rememberedLayout('{"id":"full"}'), null, 'kept although storage was full');
    full = false;
    global.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
    eq(graphMod.rememberedLayout(entry.input), null, 'a refusing storage answered');
    graphMod.rememberLayout('{"id":"x"}', '{"id":"root"}');
  } finally {
    delete global.localStorage;
    global.window.ELK = saved;
  }
});

await check('index.html starts the early worker on the URL graph.js pins', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const m = html.match(/var src = '([^']+)'/);
  ok(m, 'index.html starts no early ELK worker');
  eq(m[1], graphMod.ELK_WORKER, 'index.html and graph.js pin different elk-worker.min.js');
  ok(!/<script[^>]+elk(\.bundled|-api)?[.-]/.test(html), 'index.html loads ELK on every page again');
});

// --- fetching what the reader may open next, while they read ----------------

/** requestIdleCallback under the test's control: `idle.run()` is the browser going idle. */
function stubIdle() {
  const idle = { queue: [], cancelled: 0 };
  global.requestIdleCallback = (fn) => { idle.queue.push(fn); return idle.queue.length; };
  global.cancelIdleCallback = () => { idle.cancelled += 1; idle.queue.length = 0; };
  idle.run = async () => { const q = idle.queue.splice(0); for (const fn of q) fn(); await tick(1); };
  return idle;
}
function unstubIdle() {
  delete global.requestIdleCallback;
  delete global.cancelIdleCallback;
}
/** A task the test settles by hand. */
function handTask(name, { big = false, needed = () => true } = {}) {
  const t = { name, big, needed, runs: 0, signals: [] };
  t.run = (signal) => {
    t.runs += 1;
    t.signals.push(signal);
    return new Promise((resolve, reject) => {
      t.finish = resolve;
      t.fail = reject;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  return t;
}

// The app's own prefetcher is held for these tests: they make the page idle
// and loaded by hand, which it would otherwise act on too.
const appPrefetch = await import(path.join(webDir, 'prefetch.js'));
appPrefetch.pausePrefetch();

await check('background fetching waits for the drawn page and idle time, one file at a time', async () => {
  const P = await import(path.join(webDir, 'prefetch.js') + '?scheduler');
  const idle = stubIdle();
  dom.document.readyState = 'complete';
  try {
    const a = handTask('a');
    const b = handTask('b', { big: true });
    const c = handTask('c');
    P.setupPrefetch([a, b, c]);
    await idle.run();
    eq(a.runs, 0, 'a file was fetched before the page was drawn');

    P.resumePrefetch();
    eq(a.runs, 0, 'a file was fetched before the browser was idle');
    await idle.run();
    eq(a.runs, 1, 'nothing was fetched once idle');
    eq(b.runs, 0, 'two files at once');

    // Done: the next waits for idle time again.
    a.finish();
    await tick(1);
    eq(b.runs, 0, 'the next file did not wait for idle time');
    await idle.run();
    eq(b.runs, 1, 'the next file was not fetched');

    // The reader opens a page: the large download goes, and nothing starts.
    P.pausePrefetch();
    ok(b.signals[0].aborted, 'the large download went on beside the page asked for');
    await tick(1);
    await idle.run();
    eq(c.runs, 0, 'a file was fetched while a page was being opened');
    // That page is drawn: the aborted file is fetched again, then the rest.
    P.resumePrefetch();
    await idle.run();
    eq(b.runs, 2, 'the aborted file was not fetched again');
    b.finish();
    await tick(1);
    await idle.run();
    eq(c.runs, 1, 'the last file was not fetched');

    // A small file is left to finish across a page change.
    P.pausePrefetch();
    ok(!c.signals[0].aborted, 'a small file was aborted');
    c.finish();
    await tick(1);
    eq(P.pendingPrefetch().length, 0, `left over: ${P.pendingPrefetch()}`);
  } finally {
    P.setupPrefetch([]);
    delete dom.document.readyState;
    unstubIdle();
  }
});

await check('background fetching skips what is loaded, gives up on a failure, and waits for the page’s own load', async () => {
  const P = await import(path.join(webDir, 'prefetch.js') + '?rules');
  const idle = stubIdle();
  try {
    let wanted = true;
    const a = handTask('a', { needed: () => wanted });
    const b = handTask('b');
    P.setupPrefetch([a, b]);
    // index.html's own resources still loading: not yet.
    dom.document.readyState = 'interactive';
    P.resumePrefetch();
    await idle.run();
    eq(a.runs, 0, 'a file was fetched before the page’s own load');
    dom.document.readyState = 'complete';
    global.window.dispatch('load', {});
    wanted = false; // meanwhile loaded for real
    await idle.run();
    eq(a.runs, 0, 'a file already loaded was fetched');
    eq(b.runs, 1, 'the next file was not fetched');
    b.fail(new Error('404'));
    await tick(1);
    await idle.run();
    eq(b.runs, 1, 'a failed file was fetched again');
  } finally {
    P.setupPrefetch([]);
    delete dom.document.readyState;
    unstubIdle();
  }
});

await check('a reader saving data gets no background fetching at all', async () => {
  const P = await import(path.join(webDir, 'prefetch.js') + '?save-data');
  const idle = stubIdle();
  dom.document.readyState = 'complete';
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
      Object.defineProperty(globalThis, 'navigator', { value: { connection }, configurable: true });
      ok(P.saveData(), `${JSON.stringify(connection)} is not left alone`);
      const a = handTask('a');
      P.setupPrefetch([a]);
      P.resumePrefetch();
      await idle.run();
      eq(a.runs, 0, `fetched on ${JSON.stringify(connection)}`);
    }
    Object.defineProperty(globalThis, 'navigator', { value: { connection: { effectiveType: '4g' } }, configurable: true });
    ok(!P.saveData(), 'a 4g connection is left alone');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    P.setupPrefetch([]);
    delete dom.document.readyState;
    unstubIdle();
  }
});

await check('the graph prefetches both halves of ELK, at low priority, and only while ELK is not here', async () => {
  const savedELK = global.window.ELK;
  const savedFetch = global.fetch;
  const asked = [];
  global.fetch = async (url, init) => {
    asked.push({ url: String(url), init });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  try {
    global.window.ELK = null;
    global.window.blueprintElkWorker = null;
    const g = await freshGraph('prefetch-elk');
    ok(g.elkNeeded(), 'ELK counts as here before anything was fetched');
    await g.prefetchElk(new AbortController().signal);
    eq(asked.map((a) => a.url).join(' '),
      'https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk-api.js ' + g.ELK_WORKER, 'not the two halves');
    for (const a of asked) {
      eq(a.init.priority, 'low', `${a.url} at priority ${a.init.priority}`);
      eq(a.init.credentials, 'omit', `${a.url} with credentials`);
    }
    // ELK here, or the early worker started by index.html: nothing to fetch.
    asked.length = 0;
    global.window.ELK = function ELK() {};
    ok(!g.elkNeeded(), 'ELK on the page still counts as needed');
    await g.prefetchElk(new AbortController().signal);
    global.window.ELK = null;
    global.window.blueprintElkWorker = { src: g.ELK_WORKER, worker: {}, failed: false };
    ok(!g.elkNeeded(), 'the early worker still counts as needed');
    await g.prefetchElk(new AbortController().signal);
    eq(asked.length, 0, 'ELK was fetched again');
  } finally {
    global.fetch = savedFetch;
    global.window.ELK = savedELK;
    global.window.blueprintElkWorker = null;
  }
});

await check('ELK warmed up in the background is the worker the graph then lays out in', async () => {
  const saved = global.window.ELK;
  try {
    const state = installFakeELK();
    global.window.blueprintElkWorker = null;
    dom.workers.created.length = 0;
    const g = await freshGraph('warm');
    const warming = g.warmElk();
    await tick(5);
    eq(dom.workers.created.length, 1, 'warming up did not start the worker');
    const w = dom.workers.created[0];
    const req = lastLayoutMessage(w);
    ok(req && req.graph.id === 'warm', 'no warm-up layout was asked of the worker');
    eq(req.graph.layoutOptions['elk.algorithm'], 'layered', 'not with the graph’s own options');
    w.reply({ id: req.id, data: fakeLayout(JSON.parse(JSON.stringify(req.graph))) });
    await warming;
    // The graph opened afterwards: the same worker, no second one.
    g.render(root, app);
    await tick(5);
    eq(dom.workers.created.length, 1, 'the graph started a second worker');
    const real = lastLayoutMessage(w);
    ok(real && real.id !== req.id && real.graph.id !== 'warm', 'the graph did not lay out in the warmed worker');
    eq(state.instances.filter((i) => i.mode === 'worker').length, 1, 'ELK was constructed twice');
    w.reply({ id: real.id, data: fakeLayout(JSON.parse(JSON.stringify(real.graph))) });
    await tick(5);
    ok(root.querySelectorAll('.gnode').length > 0, 'nothing was drawn');
  } finally {
    global.window.ELK = saved;
  }
});

await check('every module app.js imports is preloaded by index.html', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(webDir, 'app.js'), 'latin1');
  const imports = [...src.matchAll(/^import\b[^;]*?from '\.\/([^']+)';/gm)].map((m) => m[1]);
  ok(imports.length >= 5, `found only ${imports}`);
  for (const f of imports) {
    ok(html.includes(`<link rel="modulepreload" href="${f}">`),
      `${f} is not preloaded: app.js cannot run until it is found, after app.js itself has arrived`);
  }
});

await check('the app hands over the pages, ELK and the export, most likely first', async () => {
  eq(appPrefetch.pendingPrefetch().join(' '), 'graph document contents object elk elk-worker search progress export',
    'the tasks app.js set up');
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
    ok(/where Lemma 2\.2 is read/.test(d.querySelector('.export-why').textContent), 'and why');
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

await check('a zooming intro: its pictures, hold and step', () => {
  const d = intro.introOf({ intro: { body: 'Weil' } });
  eq(d.zoom.length, 0, 'none: the single node');
  eq(d.holdMs, intro.HOLD_MS, 'the default hold');
  eq(d.stepMs, intro.STEP_MS, 'the default step');
  eq(d.background, '', 'no background');
  const z = intro.introOf({ intro: {
    body: 'Weil', background: 'assets/page.jpg', holdMs: 800, stepMs: 1200,
    zoom: [
      { nodes: [{ id: 'w', title: 'Weil Conjecture', kind: 'theorem' }] },
      { nodes: [{ id: 'a', title: 'A' }, { title: 'B' }, { id: 'c' }],
        arrows: [['a', 'B'], ['a', 'c'], ['a'], 'x'] },
      { nodes: [] },
    ],
  } });
  eq(z.background, 'assets/page.jpg', 'the background');
  eq(z.holdMs, 800, 'its hold');
  eq(z.stepMs, 1200, 'its step');
  eq(z.zoom.length, 2, 'a picture without nodes is left out');
  eq(z.zoom[0].nodes[0].kind, 'theorem', 'a node keeps its kind');
  eq(JSON.stringify(z.zoom[1].nodes.map((n) => [n.id, n.kind])), '[["a","section"],["B","section"]]',
    'a node without a title is left out; an id defaults to the title, a kind to section');
  eq(JSON.stringify(z.zoom[1].arrows), '[["a","B"]]', 'only arrows between two of its nodes');
});

await check('each step of the zoom is quick at first and settles slowly', () => {
  const steps = 3;
  eq(intro.zoomProgress(0, steps), 0, 'starts at 0');
  eq(intro.zoomProgress(1, steps), 1, 'a step ends where the next begins');
  eq(intro.zoomProgress(steps, steps), steps, 'ends at the last step');
  eq(intro.zoomProgress(-1, steps), 0, 'clamped below');
  eq(intro.zoomProgress(9, steps), steps, 'clamped above');
  const h = 1e-4;
  const speed = (t) => (intro.zoomProgress(t + h, steps) - intro.zoomProgress(t - h, steps)) / (2 * h);
  ok(speed(1.05) > 2 * speed(1.5) && speed(1.5) > 2 * speed(1.95), 'quick, then slower and slower');
  ok(speed(steps - h) < 0.01, 'to rest at the end');
  for (let t = 0; t < steps; t += 0.05) {
    ok(intro.zoomProgress(t + 0.05, steps) >= intro.zoomProgress(t, steps), 'never backwards at ' + t);
  }
  // What comes in, ten times smaller at the start of its step: about 60% of
  // its size 40% into the step.
  const size = intro.zoomLayers(intro.zoomProgress(1.4, steps), 4, 10)[2].scale;
  ok(size > 0.55 && size < 0.65, 'about 60% of its size 40% into the step, ' + size);
});

await check('each layer of the zoom grows by the same factor per step', () => {
  const at = (p) => intro.zoomLayers(p, 4, 10);
  const r = (x) => Math.round(x * 1000) / 1000;
  eq(JSON.stringify(at(0).map((l) => [r(l.scale), r(l.opacity)])),
    '[[1,1],[0.1,0],[0.01,0],[0.001,0]]', 'at the start: the background alone');
  eq(JSON.stringify(at(1).map((l) => [r(l.scale), r(l.opacity)])),
    '[[10,0],[1,1],[0.1,0],[0.01,0]]', 'after one step: the first picture at rest');
  const mid = at(1.5);
  eq(r(mid[1].scale / mid[2].scale), 10, 'the picture going out is ten times the one coming in');
  eq(JSON.stringify([mid[1].opacity, mid[2].opacity]), '[0,1]', 'half way: the old one gone, the new one in');
  const cross = at(1 + intro.CROSSFADE / 2);
  ok(cross[1].opacity > 0 && cross[1].opacity < 1 && cross[2].opacity > 0 && cross[2].opacity < 1,
    'early in the step: the two cross');
  eq(r(cross[1].opacity + cross[2].opacity), 1, 'one fades out as the other fades in');
  eq(at(1 + intro.CROSSFADE)[1].opacity, 0, 'gone after the first CROSSFADE of the step');
  eq(JSON.stringify(at(3).map((l) => [r(l.scale), r(l.opacity)])),
    '[[1000,0],[100,0],[10,0],[1,1]]', 'at the end: the graph at rest');
  eq(r(at(5)[3].scale), 1, 'the last layer stays at rest');
});

await check('a zoom whose steps have lengths of their own keeps one speed', () => {
  const steps = intro.introOf({ intro: { body: 'W', stepMs: [1000, 1500, 1500] } });
  eq(JSON.stringify(steps.stepsMs), '[1000,1500,1500]', 'the lengths');
  eq(steps.stepMs, 1000, 'stepMs is the first');
  eq(JSON.stringify(intro.introOf({ intro: { body: 'W', stepMs: 1200 } }).stepsMs), '[1200]', 'one length');
  eq(JSON.stringify(intro.introOf({ intro: { body: 'W', stepMs: [0, 'x'] } }).stepsMs), JSON.stringify([intro.STEP_MS]),
    'nonsense is the default');
  const lengths = [1000, 1500, 1500];
  eq(intro.zoomProgress(0, lengths), 0, 'starts at 0');
  eq(intro.zoomProgress(4000, lengths), 3, 'ends at the last step');
  eq(intro.zoomProgress(1000, lengths), 1, 'the first step takes its length');
  eq(intro.zoomProgress(2500, lengths), 2, 'and so does the second');
  const r = (x) => Math.round(x * 1000) / 1000;
  const f = intro.zoomFactors(lengths, 10);
  eq(r(f[1]), 10, 'the longest grow ten times');
  eq(r(f[0]), r(Math.pow(10, 2 / 3)), 'a shorter one grows less');
  // One pace: the growth per millisecond at the same point of each step.
  const h = 1;
  const rate = (t, layer) => {
    const a = intro.zoomLayers(intro.zoomProgress(t - h, lengths), 4, f)[layer].scale;
    const b = intro.zoomLayers(intro.zoomProgress(t + h, lengths), 4, f)[layer].scale;
    return Math.log(b / a) / (2 * h);
  };
  ok(Math.abs(rate(400, 1) - rate(1000 + 600, 2)) < 1e-4, 'the first and second steps alike, 40% in');
  const at1 = intro.zoomLayers(1, 4, f);
  eq(r(at1[0].scale), r(f[0]), 'the background went out by the first factor');
  eq(r(at1[2].scale), 0.1, 'the next comes in by the second');
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
    eq(layer.querySelector('button'), null, 'no skip button: a click or a key ends it');
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

await check('the top bar\'s icon replays the intro, once at a time', async () => {
  const host = dom.document.createElement('div');
  const project = app.model.project;
  app.model.project = { ...project, intro: { body: 'Welcome', durationMs: 60000 } };
  try {
    const a = intro.replayIntro(app, { atLanding: true, host });
    ok(a && host.querySelector('.intro'), 'on the landing page it plays at once');
    eq(intro.replayIntro(app, { atLanding: true, host }), null, 'not over itself');
    a.leave();
    const b = intro.replayIntro(app, { atLanding: true, host });
    ok(b && b.layer !== a.layer, 'again once the first is leaving');
    b.leave();
    app.model.project = { ...project };
    eq(intro.replayIntro(app, { atLanding: true, host }), null, 'no intro, nothing to replay');
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
