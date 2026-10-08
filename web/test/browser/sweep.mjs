#!/usr/bin/env node
// sweep.mjs — the pre-deploy browser sweep.
//
// Drives the deployed site in *real* headless browsers (Firefox through
// geckodriver, Chromium through the DevTools protocol) with real pointer,
// keyboard and wheel input, and asserts against the DOM the browser actually
// built.  The shim-based tests in ../app.test.mjs cannot see layout, pointer
// capture, CSS, KaTeX or ELK; this can, which is the whole point.
//
//   node sweep.mjs --origin=http://127.0.0.1:8765 --browser=firefox,chromium
//
// See README.md in this directory for how to run it on a machine with nix.
//
// Every check prints PASS/FAIL with the DOM evidence it decided on, so a
// failure is readable without re-running anything.  The fixtures (which
// theorem, which definition, which slug) are derived from the snapshot that is
// actually served, so the sweep is not tied to one project's data.

import { writeFileSync, mkdirSync } from 'node:fs';
import * as M from '../../model.js';
import { firefox, chromium, sleep } from './driver.mjs';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] === undefined ? 'true' : m[2]);
}
const ORIGIN = (args.get('origin') || 'http://127.0.0.1:8765').replace(/\/$/, '');
const BROWSERS = (args.get('browser') || 'firefox').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = args.get('shots') || '/tmp/shots';
const ONLY = args.get('only') || null;
// Which groups of checks to run at all — the A/B of a single fix does not need
// to lay out 1,068 nodes on the way past.
const SECTIONS = new Set((args.get('sections')
  || 'boot,graph,layout,object,document,references,progress,search,checks,nav,sample').split(',').map((s) => s.trim()));
const WIDTH = Number(args.get('width') || 1400);
const HEIGHT = Number(args.get('height') || 900);
const LAUNCH = args.get('no-launch') !== 'true';
const VERBOSE = args.get('verbose') === 'true';
// Driver ports, for running beside another sweep on the same machine.
const GECKO_PORT = Number(args.get('gecko-port')) || null;
const CDP_PORT = Number(args.get('cdp-port')) || null;

mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// small assertion helpers
// ---------------------------------------------------------------------------

const results = [];
let current = null;

function record(browser, id, ok, evidence, skipped = false) {
  results.push({ browser, id, ok, evidence, skipped });
  const tag = skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  [${browser}] ${id}\n        ${evidence}`);
}

async function check(d, id, fn) {
  if (ONLY && !id.includes(ONLY)) return;
  current = id;
  try {
    const r = await fn();
    if (r && r.skip) record(d.name, id, true, r.evidence || 'skipped', true);
    else record(d.name, id, !!(r && r.ok), (r && r.evidence) || '(no evidence)');
  } catch (e) {
    record(d.name, id, false, 'threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' < ') : e));
  }
}

const j = (x) => JSON.stringify(x);

async function waitFor(d, body, { timeout = 20000, interval = 100, label = '' } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    last = await d.js(body);
    if (last) return last;
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${label || 'condition'}; last value ${j(last)}`);
    }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// page-side snippets
// ---------------------------------------------------------------------------

const GRAPH_IDLE = `
  var stage = document.querySelector('.graph-stage');
  var st = document.querySelector('#graph-status');
  if (!stage || !st) return false;
  if (stage.classList.contains('laying-out')) return false;
  var t = st.textContent || '';
  if (!t || /laying out/.test(t)) return false;
  return t;
`;

const GRAPH_COUNTS = `
  return {
    nodes: document.querySelectorAll('.gnode').length,
    leaves: document.querySelectorAll('.gnode:not(.compound):not(.junction)').length,
    compounds: document.querySelectorAll('.gnode.compound').length,
    junctions: document.querySelectorAll('.gnode.junction').length,
    edges: document.querySelectorAll('.gedge').length,
    status: (document.querySelector('#graph-status') || {}).textContent || '',
    error: (document.querySelector('.graph-error') || {}).textContent || null,
    hash: location.hash,
    transform: (document.querySelector('.glayer') || {}).getAttribute ? document.querySelector('.glayer').getAttribute('transform') : null,
    sidePanel: (document.querySelector('aside.side h2') || {}).textContent || null,
    selId: (document.querySelector('aside.side .obj-id') || {}).textContent || null
  };
`;

function boxOf(selector, which = 'shape') {
  return `
    var g = document.querySelector(${j(selector)});
    if (!g) return null;
    var s = ${which === 'shape' ? "g.querySelector('.shape') || g" : 'g'};
    var r = s.getBoundingClientRect();
    return { id: g.dataset ? g.dataset.id : null, x: r.left + r.width / 2, y: r.top + r.height / 2,
             left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  `;
}

// Real input goes to viewport coordinates, so anything scrolled out of the
// window — or out of the side panel, which has its own scrollbar — has to be
// brought into view before it can be clicked, exactly as a reader would.
// It also returns the element's *first* line box rather than the union of
// them: the centre of a link that wraps over two lines falls in the gap
// between them, where the click lands on the list item behind it, which is not
// where a reader clicks and not what the link's hit area is.
const IN_VIEW = `
  function inView(e) {
    var r = e.getBoundingClientRect();
    if (r.top < 4 || r.bottom > window.innerHeight - 4 || r.left < 4 || r.right > window.innerWidth - 4) {
      e.scrollIntoView({ block: 'center', inline: 'center' });
      r = e.getBoundingClientRect();
    }
    var rects = e.getClientRects();
    if (rects.length && rects[0].width > 2 && rects[0].height > 2) return rects[0];
    return r;
  }
`;

/** Centre of an element found by selector (any element, not just a node). */
function elBox(selector) {
  return `
    var e = document.querySelector(${j(selector)});
    if (!e) return null;
    var r = inView(e);
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top,
             right: r.right, bottom: r.bottom, w: r.width, h: r.height,
             text: (e.textContent || '').trim().slice(0, 80) };
    ${IN_VIEW}
  `;
}

/** Centre of the first element whose text contains `text`. */
function elBoxByText(selector, text) {
  return `
    var all = Array.prototype.slice.call(document.querySelectorAll(${j(selector)}));
    var e = all.filter(function (x) { return (x.textContent || '').indexOf(${j(text)}) >= 0; })[0];
    if (!e) return null;
    var r = inView(e);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top,
             right: r.right, bottom: r.bottom, w: r.width, h: r.height,
             text: (e.textContent || '').trim().slice(0, 80) };
    ${IN_VIEW}
  `;
}

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------

async function route(d, hash) {
  const now = await d.js('return location.hash');
  if (now === hash) return;
  await d.js(`location.hash = ${j(hash)}; return location.hash;`);
  await sleep(150);
}

/**
 * The graph on screen draws every title with maths in it with KaTeX, inside a
 * <foreignObject>: each such node has KaTeX output and no KaTeX error, and
 * each of its lines lies inside the node's box, clear of its kind mark and
 * expander and of every other node's box.  Measured in the graph's own
 * coordinates, so the zoom does not loosen the tolerance.  A formula the
 * project's macros cannot render stays as source; that is counted, not
 * failed (see README, "What a failure means").
 */
async function mathTitles(d, dataUrl) {
  const r = await d.js(`
    return fetch(${j(dataUrl)}, { cache: 'no-cache' }).then(function (res) { return res.json(); }).then(function (snap) {
      var title = {};
      snap.objects.forEach(function (o) { title[o.id] = (o.attrs && o.attrs.title) || o.id; });
      var hasMath = function (t) { return /\\$[^$]+\\$|\\\\\\(|\\\\\\[/.test(t); };
      var ctm = document.querySelector('.glayer').getScreenCTM();
      var g2 = function (r) {
        return { left: (r.left - ctm.e) / ctm.a, top: (r.top - ctm.f) / ctm.d,
                 right: (r.right - ctm.e) / ctm.a, bottom: (r.bottom - ctm.f) / ctm.d };
      };
      var inside = function (a, b) {
        return a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
      };
      var apart = function (a, b) {
        return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      };
      var all = Array.prototype.slice.call(document.querySelectorAll('.gnode:not(.junction)'));
      var leaves = all.filter(function (g) { return !g.classList.contains('compound'); })
        .map(function (g) { return { g: g, box: g2(g.querySelector('.shape').getBoundingClientRect()) }; });
      var want = all.filter(function (g) { return hasMath(String(title[g.dataset.id])); });
      var bad = [], leftover = [], rendered = 0, lines = 0;
      want.forEach(function (g) {
        var id = g.dataset.id;
        var fo = g.querySelector(':scope > foreignObject.label');
        if (!fo) { bad.push(id + ': drawn as plain text'); return; }
        if (fo.querySelector('.katex-error')) bad.push(id + ': KaTeX error shown');
        if (fo.querySelector('.katex')) rendered++;
        var rest = fo.cloneNode(true);
        Array.prototype.forEach.call(rest.querySelectorAll('.katex'), function (k) { k.remove(); });
        if (hasMath(rest.textContent)) leftover.push(id);
        var box = g2(g.querySelector('.shape').getBoundingClientRect());
        Array.prototype.forEach.call(fo.querySelectorAll('.gm-line'), function (line) {
          lines++;
          var range = document.createRange();
          range.selectNodeContents(line);
          var ink = g2(range.getBoundingClientRect());
          if (!inside(ink, box)) bad.push(id + ': a line spills out of the box');
          ['.kindmark', '.expander'].forEach(function (sel) {
            var o = g.querySelector(':scope > ' + sel);
            if (o && !apart(ink, g2(o.getBoundingClientRect()))) bad.push(id + ': a line overlaps ' + sel);
          });
          leaves.forEach(function (other) {
            if (other.g !== g && !apart(ink, other.box)) bad.push(id + ': a line is under ' + other.g.dataset.id);
          });
        });
      });
      return { nodes: all.length, want: want.length, rendered: rendered, lines: lines, bad: bad, leftover: leftover };
    });
  `);
  if (!r.want) return { skip: true, evidence: `none of the ${r.nodes} nodes on screen has maths in its title` };
  return {
    ok: r.bad.length === 0 && r.rendered > 0,
    evidence: `${r.want} of ${r.nodes} nodes have maths in their titles: ${r.rendered} rendered by KaTeX on ${r.lines} lines` +
      (r.leftover.length ? `, ${r.leftover.length} still showing source the project's macros do not cover (${j(r.leftover.slice(0, 3))})` : '') +
      `; problems: ${r.bad.length ? j(r.bad.slice(0, 5)) + ` (${r.bad.length})` : 'none'}`,
  };
}

async function gotoGraph(d, query = '') {
  await route(d, '#/graph' + (query ? '?' + query : ''));
  return waitFor(d, GRAPH_IDLE, { timeout: 90000, label: 'graph layout' });
}

/** Settle the 0.28s `.glayer` transition before measuring geometry. */
const settle = () => sleep(450);

// ---------------------------------------------------------------------------
// fixtures, derived from the snapshot that is actually served
// ---------------------------------------------------------------------------

async function loadFixtures(origin) {
  const res = await fetch(origin + '/blueprint.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`cannot fetch ${origin}/blueprint.json: HTTP ${res.status}`);
  const snapshot = await res.json();
  const m = M.buildModel(snapshot);
  const kind = m.defaultCollapse || m.collapseKinds[0];
  const order = M.collapseOrder(m, kind);
  const has = (id) => m.byId.has(id);

  const nodeKinds = new Set(M.nodeKinds(m));
  const nodes = m.objects.filter((o) => o.boundary.length === 0);
  const facts = snapshot.facts || {};
  const leanOf = (o) => {
    const v = o.attrs && o.attrs.lean;
    return Array.isArray(v) ? v : v ? [v] : [];
  };

  const withFacts = nodes.find((o) => leanOf(o).some((n) => facts[n]));
  const withoutFacts = nodes.find((o) => leanOf(o).length === 0 && o.body && o.body.trim());
  const section = nodes.find((o) => M.childrenOf(order, o.id).length > 2);
  // A sugar-created edge whose id carries slashes, so the object route has to
  // percent-encode and decode it.  An edge of a kind other than the collapse
  // kind is the more interesting one (`uses/a/b` rather than `refines/a/b`),
  // because its page shows a boundary that is not just the hierarchy.
  const sugarCandidates = m.objects.filter((o) => o.id.includes('/') && o.boundary.length > 0);
  const sugar = sugarCandidates.find((o) => o.kind !== kind) || sugarCandidates[0];
  const twoParents = m.objects.find((o) => M.parentsOf(order, o.id).length >= 2);
  const katex = m.objects.find((o) => o.body && /\$[^$\n]+\$/.test(o.body));
  const slugRe = /\[([A-Za-z0-9][A-Za-z0-9._~/-]*)\](?!\()/g;
  let slug = null;
  for (const o of m.objects) {
    if (!o.body) continue;
    slugRe.lastIndex = 0;
    let mm;
    while ((mm = slugRe.exec(o.body))) {
      if (has(mm[1])) { slug = { id: o.id, target: mm[1] }; break; }
    }
    if (slug) break;
  }

  // The graph work-bench: a top-level object with expandable children, so
  // expanding it puts something new and filterable on screen.
  const tops = M.topLevel(m, kind).filter((o) => M.childrenOf(order, o.id).length > 0);
  const bench = tops.find((o) => {
    const kids = M.childrenOf(order, o.id);
    return kids.length >= 3 && kids.some((c) => M.statusOf(m, c) !== null);
  }) || tops[0];

  // The split document: a top-level entry with children and a next sibling, to
  // click into and page along, and a leaf two levels down, read on its parent's
  // page, for the redirect of an old `?focus=` link.
  const outline = M.documentOutline(m, kind);
  const chapterIdx = outline.roots.findIndex((e, i) => !e.duplicate && e.children.length > 0
    && outline.roots.slice(i + 1).some((x) => !x.duplicate));
  const chapter = chapterIdx >= 0 ? outline.roots[chapterIdx] : null;
  const deepLeaf = outline.entries.find((e) => !e.duplicate && e.depth >= 2 && !e.children.length
    && e.object.body && e.object.body.trim())
    || outline.entries.find((e) => !e.duplicate && e.depth >= 1 && !e.children.length);

  // A page with many entries carrying prose, and one halfway down it: when it
  // is focused, the prose above renders after the scroll and must not push it
  // out of view.
  const proseKids = (e) => e.children.filter((c) => !c.duplicate && c.object.body && c.object.body.trim());
  const busiest = outline.entries.filter((e) => !e.duplicate)
    .reduce((best, e) => (proseKids(e).length > (best ? proseKids(best).length : 5) ? e : best), null);
  const midFocus = busiest
    ? { page: busiest.id, id: proseKids(busiest)[Math.floor(proseKids(busiest).length / 2)].id }
    : null;

  // Cross references (taxis #524): a `[slug]` naming a numbered object from
  // the prose of an entry the document writes out, one of those whose target
  // is read on another page than its source, and one on the same page.
  let ref = null;
  let refFar = null;
  let refNear = null;
  for (const o of m.objects) {
    if (!o.body || !outline.byId.has(o.id)) continue;
    slugRe.lastIndex = 0;
    let mm;
    while ((mm = slugRe.exec(o.body))) {
      const t = mm[1];
      if (!has(t) || !M.referenceOf(outline, t)) continue;
      const r = M.referenceOf(outline, t);
      const page = M.documentPageOf(outline, o.id);
      const entry = { id: o.id, target: t, page, label: r.word + ' ' + r.number, number: r.number };
      if (!ref) ref = entry;
      if (!refFar && !M.documentPageShows(outline, page, 1, t)) refFar = entry;
      if (!refNear && t !== o.id && M.documentPageShows(outline, page, 1, t)) refNear = entry;
    }
    if (ref && refFar && refNear) break;
  }
  // A link that resolves nowhere, as the tool reported it: a bracket found by
  // a regex over the body might be maths (`F[1]`), which is not a link.
  const badLink = m.checks.find((c) => c.code === 'bad-link' && c.objects && c.objects.length
    && /`\[([^\]`]+)\]`/.test(c.message || ''));
  const brokenRef = badLink && { id: badLink.objects[0], target: badLink.message.match(/`\[([^\]`]+)\]`/)[1] };

  const view = M.makeView(m, kind, []);
  const quot = M.quotient(view);
  const visibleNodeIds = [...view.visible].filter((id) => {
    const o = m.byId.get(id);
    return o && o.boundary.length === 0;
  });
  // The side panel's layout (taxis #527): a node on screen with prose and the
  // most incident objects, whose listing is the long one folded away.
  const incidents = (id) => M.incidentTo(m, id).length;
  const panel = visibleNodeIds.map((id) => m.byId.get(id))
    .filter((o) => o.body && o.body.trim() && incidents(o.id) > 0)
    .reduce((best, o) => (!best || incidents(o.id) > incidents(best.id) ? o : best), null);

  return {
    snapshot, m, kind, order,
    edgeKinds: M.edgeKinds(m).filter((k) => k !== kind),
    statuses: M.STATUSES,
    nodeKinds: [...nodeKinds],
    withFacts: withFacts && withFacts.id,
    withoutFacts: withoutFacts && withoutFacts.id,
    section: section && section.id,
    sugar: sugar && sugar.id,
    twoParents: twoParents && twoParents.id,
    katex: katex && katex.id,
    slug,
    outline,
    chapter: chapter && chapter.id,
    deepLeaf: deepLeaf && deepLeaf.id,
    deepLeafPage: deepLeaf ? M.documentPageOf(outline, deepLeaf.id) : null,
    midFocus,
    ref, refFar, refNear, brokenRef,
    bench: bench && bench.id,
    panel: panel && panel.id,
    benchKids: bench ? M.childrenOf(order, bench.id) : [],
    defaultNodeCount: visibleNodeIds.length,
    defaultEdgeCount: quot.edges.length,
    visibleNodeIds,
    checkCodes: [...new Set(m.checks.map((c) => c.code))].sort(),
    checkLevels: [...new Set(m.checks.map((c) => c.level))],
    nChecks: m.checks.length,
  };
}

// ---------------------------------------------------------------------------
// console assertions
// ---------------------------------------------------------------------------

const IGNORED_NET = /favicon/i;
// Warnings that are about the *snapshot's* maths, not about the site: the
// project's own macros failing to parse, and KaTeX's strict-mode grumbling
// about Unicode in math mode.  They are counted and named in the evidence but
// they must not fail a deploy gate, because no change to web/ can fix them.
const DATA_WARN = /KaTeX:|LaTeX-incompatible input/;

async function consoleCheck(d, label) {
  const got = await d.drain();
  const errors = got.errors || [];
  const net = (got.net || []).filter((x) => !IGNORED_NET.test(x));
  const allWarns = got.warns || [];
  const dataWarns = allWarns.filter((x) => DATA_WARN.test(x));
  const warns = allWarns.filter((x) => !DATA_WARN.test(x));
  const bad = [...errors, ...net, ...warns];
  await check(d, `console/${label}`, async () => ({
    ok: bad.length === 0,
    evidence: bad.length
      ? `${bad.length} problem(s): ` + bad.slice(0, 4).join(' ;; ')
      : `clean — ${dataWarns.length} snapshot-maths warnings`
        + (dataWarns.length ? ` (e.g. ${j(dataWarns[0].slice(0, 110))})` : '')
        + `, ${(got.net || []).length - net.length} ignored favicon entries`,
  }));
  return { errors, net, dataWarns, warns: allWarns };
}

// ---------------------------------------------------------------------------
// 1. graph page
// ---------------------------------------------------------------------------

async function graphChecks(d, f) {
  await gotoGraph(d, `collapse=${encodeURIComponent(f.kind)}`);
  await settle();

  await check(d, 'graph/initial-render', async () => {
    const c = await d.js(GRAPH_COUNTS);
    return {
      ok: c.nodes > 0 && !c.error && /\d+ nodes/.test(c.status),
      evidence: `${c.nodes} .gnode (${c.compounds} compound, ${c.junctions} junction), ${c.edges} .gedge, status=${j(c.status)}, error=${j(c.error)}`,
    };
  });

  await d.shot(`${SHOTS}/${d.name}-graph.png`);

  await check(d, 'graph/legend-does-not-overlap-nodes', async () => {
    const r = await d.js(`
      var lg = document.querySelector('.legend');
      if (!lg) return { ok: false, why: 'no .legend' };
      var L = lg.getBoundingClientRect();
      var hits = [];
      var nodes = document.querySelectorAll('.gnode .shape');
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect();
        if (r.right < L.left || r.left > L.right || r.bottom < L.top || r.top > L.bottom) continue;
        hits.push((nodes[i].parentNode.dataset.id || '?') + '@' + Math.round(r.left) + ',' + Math.round(r.top));
      }
      return { ok: hits.length === 0, legend: [Math.round(L.left), Math.round(L.top), Math.round(L.right), Math.round(L.bottom)], hits: hits.slice(0, 6), n: nodes.length };
    `);
    return {
      ok: r.ok,
      evidence: `legend box=${j(r.legend)} over ${r.n} node shapes; overlapping: ${r.hits.length ? j(r.hits) : 'none'}`,
    };
  });

  // --- selection ----------------------------------------------------------
  await check(d, 'graph/click-selects-and-fills-side-panel', async () => {
    const box = await d.js(boxOf('.gnode:not(.compound):not(.junction)'));
    if (!box) return { ok: false, evidence: 'no leaf node drawn' };
    await d.click(box.x, box.y);
    await sleep(400);
    const c = await d.js(GRAPH_COUNTS);
    const sel = await d.js(`
      var s = document.querySelector('aside.side');
      return { head: (s.querySelector('h2') || {}).textContent, id: (s.querySelector('.obj-id') || {}).textContent,
               sections: s.querySelectorAll('section').length, selected: document.querySelectorAll('.gnode.selected').length };
    `);
    return {
      ok: sel.id === box.id && sel.selected > 0 && /sel=/.test(c.hash),
      evidence: `clicked ${j(box.id)} at (${Math.round(box.x)},${Math.round(box.y)}); side .obj-id=${j(sel.id)}, h2=${j(sel.head)}, ${sel.sections} sections, ${sel.selected} .selected, hash=${j(c.hash)}`,
    };
  });

  await check(d, 'graph/click-empty-stage-deselects', async () => {
    const pt = await emptyStagePoint(d);
    if (!pt) return { ok: false, evidence: 'no empty point on the stage' };
    await d.click(pt.x, pt.y);
    await sleep(350);
    const c = await d.js(GRAPH_COUNTS);
    return {
      ok: c.sidePanel === 'Nothing selected' && !/sel=/.test(c.hash),
      evidence: `clicked empty (${pt.x},${pt.y}); side h2=${j(c.sidePanel)}, hash=${j(c.hash)}`,
    };
  });

  // --- expand / collapse --------------------------------------------------
  const expandable = `.gnode:not(.compound) .expander`;

  await check(d, 'graph/double-click-expands', async () => {
    const box = await d.js(`
      var ex = Array.prototype.slice.call(document.querySelectorAll('.gnode .expander'))
        .filter(function (t) { return (t.textContent || '').indexOf('+') >= 0; });
      var g = ex.length ? ex[0].parentNode : null;
      if (!g) return null;
      var r = (g.querySelector('.shape') || g).getBoundingClientRect();
      return { id: g.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!box) return { ok: false, evidence: 'no collapsed expandable node on screen' };
    const before = await d.js(GRAPH_COUNTS);
    await d.dblclick(box.x, box.y);
    await waitFor(d, `return location.hash.indexOf('expand=') >= 0`, { timeout: 8000, label: 'expand= in hash' });
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 90000, label: 'relayout after expand' });
    await settle();
    const after = await d.js(GRAPH_COUNTS);
    d.__expanded = box.id;
    return {
      ok: after.nodes > before.nodes && after.compounds > before.compounds && decodeURIComponent(after.hash).includes(box.id),
      evidence: `dblclick ${j(box.id)}: nodes ${before.nodes}->${after.nodes}, compounds ${before.compounds}->${after.compounds}, hash=${j(decodeURIComponent(after.hash))}, status=${j(status)}`,
    };
  });

  await check(d, 'graph/double-click-collapses-again', async () => {
    const id = d.__expanded;
    if (!id) return { ok: false, evidence: 'nothing was expanded' };
    const box = await d.js(`
      var g = document.querySelector('.gnode.compound[data-id=' + JSON.stringify(${j(id)}).replace(/"/g, '"') + ']');
      g = g || Array.prototype.slice.call(document.querySelectorAll('.gnode.compound')).filter(function (x) { return x.dataset.id === ${j(id)}; })[0];
      if (!g) return null;
      var lbl = g.querySelector('.label');
      var r = (lbl || g).getBoundingClientRect();
      return { id: g.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!box) return { ok: false, evidence: `compound ${j(id)} not on screen` };
    const before = await d.js(GRAPH_COUNTS);
    await d.dblclick(box.x, box.y);
    await sleep(600);
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 90000, label: 'relayout after collapse' });
    await settle();
    const after = await d.js(GRAPH_COUNTS);
    return {
      ok: after.nodes < before.nodes && !decodeURIComponent(after.hash).includes('expand=' + id),
      evidence: `dblclick compound label ${j(id)}: nodes ${before.nodes}->${after.nodes}, hash=${j(decodeURIComponent(after.hash))}, status=${j(status)}`,
    };
  });

  await check(d, 'graph/keyboard-space-selects', async () => {
    await d.js(`document.querySelectorAll('.gnode')[0].focus(); return document.activeElement.tagName;`);
    const focused = await d.js(`return { tag: document.activeElement.tagName, id: document.activeElement.dataset ? document.activeElement.dataset.id : null };`);
    await d.key('Space');
    await sleep(400);
    const c = await d.js(GRAPH_COUNTS);
    return {
      ok: c.selId === focused.id && /sel=/.test(c.hash),
      evidence: `focused ${j(focused)}; after Space side .obj-id=${j(c.selId)}, hash=${j(c.hash)}`,
    };
  });

  await check(d, 'graph/keyboard-enter-expands', async () => {
    const target = await d.js(`
      var ex = Array.prototype.slice.call(document.querySelectorAll('.gnode .expander'))
        .filter(function (t) { return (t.textContent || '').indexOf('+') >= 0; });
      if (!ex.length) return null;
      var g = ex[0].parentNode;
      g.focus();
      return { id: g.dataset.id, active: document.activeElement === g };
    `);
    if (!target) return { ok: false, evidence: 'no collapsed expandable node on screen' };
    const before = await d.js(GRAPH_COUNTS);
    await d.key('Enter');
    await sleep(500);
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 90000, label: 'relayout after Enter' });
    const after = await d.js(GRAPH_COUNTS);
    return {
      ok: after.nodes > before.nodes && decodeURIComponent(after.hash).includes(target.id),
      evidence: `Enter on ${j(target.id)} (focused=${target.active}): nodes ${before.nodes}->${after.nodes}, hash=${j(decodeURIComponent(after.hash))}, status=${j(status)}`,
    };
  });

  // --- side panel expand/collapse button -----------------------------------
  await check(d, 'graph/side-panel-collapse-button', async () => {
    const btn = await d.js(`
      var b = Array.prototype.slice.call(document.querySelectorAll('aside.side button'))
        .filter(function (x) { return /^(Collapse|Expand) \\(/.test((x.textContent || '').trim()); })[0];
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!btn) return { ok: false, evidence: 'no Expand/Collapse (n children) button in the side panel' };
    const before = await d.js(GRAPH_COUNTS);
    await d.click(btn.x, btn.y);
    await sleep(500);
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 90000, label: 'relayout after side button' });
    const after = await d.js(GRAPH_COUNTS);
    return {
      ok: after.nodes !== before.nodes,
      evidence: `clicked ${j(btn.text)}: nodes ${before.nodes}->${after.nodes}, status=${j(status)}`,
    };
  });

  // --- expand all / collapse all ------------------------------------------
  await check(d, 'graph/expand-all', async () => {
    const btn = await d.js(elBoxByText('.toolbar button', 'Expand all'));
    if (!btn) return { ok: false, evidence: 'no "Expand all" button' };
    const before = await d.js(GRAPH_COUNTS);
    await d.click(btn.x, btn.y);
    await sleep(500);
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 300000, interval: 500, label: 'expand-all layout' });
    const after = await d.js(GRAPH_COUNTS);
    return {
      ok: after.nodes > before.nodes * 2 && !after.error,
      evidence: `${j(btn.text)}: nodes ${before.nodes}->${after.nodes}, edges ${before.edges}->${after.edges}, status=${j(status)}, error=${j(after.error)}`,
    };
  });

  await d.shot(`${SHOTS}/${d.name}-graph-expand-all.png`);

  // Titles are never cut: each node shows the whole of it, wrapped if need
  // be, inside its box and clear of the kind mark and the expander.
  await check(d, 'graph/titles-are-whole-and-inside-their-nodes', async () => {
    const r = await d.js(`
      return fetch('./blueprint.json', { cache: 'no-cache' }).then(function (res) { return res.json(); }).then(function (snap) {
        var title = {};
        snap.objects.forEach(function (o) { title[o.id] = (o.attrs && o.attrs.title) || o.id; });
        var inside = function (a, b) {
          return a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
        };
        var apart = function (a, b) {
          return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        };
        var nodes = document.querySelectorAll('.gnode:not(.junction)');
        var bad = [], lines = 0, math = 0;
        for (var i = 0; i < nodes.length; i++) {
          var g = nodes[i], id = g.dataset.id;
          // A title with maths is KaTeX's HTML: graph/math-titles-… checks it.
          if (g.querySelector(':scope > foreignObject.label')) { math++; continue; }
          var label = g.querySelector('.label');
          var spans = label ? label.querySelectorAll('tspan') : [];
          var shown = Array.prototype.map.call(spans, function (s) { return s.textContent; }).join(' ');
          lines = Math.max(lines, spans.length);
          var want = String(title[id]).split(/\\s+/).filter(Boolean).join(' ');
          if (shown !== want) { bad.push(id + ': shows ' + JSON.stringify(shown)); continue; }
          var lb = label.getBBox(), sb = g.querySelector('.shape').getBBox();
          if (!inside(lb, sb)) bad.push(id + ': title spills out of the box');
          ['.kindmark', '.expander'].forEach(function (sel) {
            var o = g.querySelector(sel);
            if (o && !apart(lb, o.getBBox())) bad.push(id + ': title overlaps ' + sel);
          });
        }
        return { n: nodes.length, lines: lines, math: math, bad: bad };
      });
    `);
    return {
      ok: r.n > r.math && r.bad.length === 0,
      evidence: `${r.n - r.math} plain-text titles (${r.math} with maths left to the next check), up to ${r.lines} title lines; problems: ${r.bad.length ? j(r.bad.slice(0, 5)) + ` (${r.bad.length})` : 'none'}`,
    };
  });

  await check(d, 'graph/math-titles-render-and-fit-their-nodes', () => mathTitles(d, './blueprint.json'));

  // Each edge keeps its own route: two edges running along the same line
  // cannot be told apart, which is what `elk.layered.mergeEdges` used to do.
  await check(d, 'graph/edges-do-not-share-segments', async () => {
    const r = await d.js(`
      var segs = [];
      var paths = document.querySelectorAll('.gedge > path:not(.hit)');
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        var nums = (p.getAttribute('d') || '').match(/-?[0-9.]+/g) || [];
        for (var k = 2; k + 1 < nums.length; k += 2) {
          segs.push({ id: p.parentNode.dataset.id, x1: +nums[k - 2], y1: +nums[k - 1], x2: +nums[k], y2: +nums[k + 1] });
        }
      }
      var shared = [];
      for (var a = 0; a < segs.length; a++) for (var b = a + 1; b < segs.length; b++) {
        var s = segs[a], t = segs[b];
        if (s.id === t.id) continue;
        var hs = Math.abs(s.y1 - s.y2) < 0.5, ht = Math.abs(t.y1 - t.y2) < 0.5;
        var vs = Math.abs(s.x1 - s.x2) < 0.5, vt = Math.abs(t.x1 - t.x2) < 0.5;
        var ov = 0;
        if (hs && ht && Math.abs(s.y1 - t.y1) < 1) {
          ov = Math.min(Math.max(s.x1, s.x2), Math.max(t.x1, t.x2)) - Math.max(Math.min(s.x1, s.x2), Math.min(t.x1, t.x2));
        } else if (vs && vt && Math.abs(s.x1 - t.x1) < 1) {
          ov = Math.min(Math.max(s.y1, s.y2), Math.max(t.y1, t.y2)) - Math.max(Math.min(s.y1, s.y2), Math.min(t.y1, t.y2));
        }
        if (ov > 4) shared.push(s.id + ' / ' + t.id + ' (' + Math.round(ov) + 'px)');
      }
      return { n: segs.length, shared: shared };
    `);
    return {
      ok: r.n > 0 && r.shared.length === 0,
      evidence: `${r.n} edge segments; shared: ${r.shared.length ? j(r.shared.slice(0, 5)) : 'none'}`,
    };
  });

  // `uses` is `arrow: "reverse"`: the head sits on the user (`src`), not on
  // what it uses.  Every other directed kind keeps its head on `tgt`.
  await check(d, 'graph/arrow-heads-follow-the-kind', async () => {
    const r = await d.js(`
      return fetch('./blueprint.json', { cache: 'no-cache' }).then(function (res) { return res.json(); }).then(function (snap) {
      var byId = {};
      snap.objects.forEach(function (o) { byId[o.id] = o; });
      var end = function (o, role) {
        var b = o.boundary.find(function (x) { return x.role === role; });
        return b ? b.id : null;
      };
      var boxOf = function (id) {
        var g = document.querySelector('.gnode[data-id="' + CSS.escape(id) + '"] .shape');
        return g ? g.getBoundingClientRect() : null;
      };
      var near = function (p, r) {
        return p.x >= r.left - 12 && p.x <= r.right + 12 && p.y >= r.top - 12 && p.y <= r.bottom + 12;
      };
      var out = { checked: {}, bad: [] };
      var edges = document.querySelectorAll('.gedge:not(.spoke):not(.synthetic)');
      for (var i = 0; i < edges.length; i++) {
        var o = byId[edges[i].dataset.id];
        var path = edges[i].querySelector('path[marker-end]');
        if (!o || !path) continue;
        var src = end(o, 'src'), tgt = end(o, 'tgt');
        var head = snap.schema.kinds[o.kind].arrow === 'reverse' ? src : tgt;
        var box = head && boxOf(head);
        if (!box) continue; // the head end is a junction or folded away
        var p = path.getPointAtLength(path.getTotalLength());
        var m = path.getScreenCTM();
        var s = { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
        out.checked[o.kind] = (out.checked[o.kind] || 0) + 1;
        if (!near(s, box)) out.bad.push(o.id + ' head not at ' + head);
      }
      return out;
      });
    `);
    return {
      ok: (r.checked.uses || 0) > 0 && r.bad.length === 0,
      evidence: `checked ${j(r.checked)}; wrong way round: ${r.bad.length ? j(r.bad.slice(0, 5)) : 'none'}`,
    };
  });

  await check(d, 'graph/collapse-all', async () => {
    const btn = await d.js(elBoxByText('.toolbar button', 'Collapse all'));
    if (!btn) return { ok: false, evidence: 'no "Collapse all" button' };
    await d.click(btn.x, btn.y);
    await sleep(500);
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 120000, interval: 300, label: 'collapse-all layout' });
    const after = await d.js(GRAPH_COUNTS);
    return {
      ok: after.nodes === f.defaultNodeCount && !after.error,
      evidence: `nodes=${after.nodes} (expected ${f.defaultNodeCount} from the model), status=${j(status)}, hash=${j(after.hash)}`,
    };
  });

  // --- collapse kind select ------------------------------------------------
  await check(d, 'graph/collapse-kind-select', async () => {
    if (f.m.collapseKinds.length < 2) return { skip: true, evidence: 'only one collapse kind in the schema' };
    const other = f.m.collapseKinds.find((k) => k !== f.kind);
    const set = (v) => d.js(`
      var s = document.querySelector('.toolbar select');
      if (!s) return null;
      s.value = ${j(v)};
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    `);
    await set(other);
    await sleep(400);
    const s1 = await waitFor(d, GRAPH_IDLE, { timeout: 120000, interval: 300, label: 'layout after kind switch' });
    const c1 = await d.js(GRAPH_COUNTS);
    await set(f.kind);
    await sleep(400);
    const s2 = await waitFor(d, GRAPH_IDLE, { timeout: 120000, interval: 300, label: 'layout back' });
    const c2 = await d.js(GRAPH_COUNTS);
    return {
      ok: s1.includes(other) && s2.includes(f.kind) && !c1.error && !c2.error,
      evidence: `${f.kind}->${other}: ${c1.nodes} nodes, status=${j(s1)}; back: ${c2.nodes} nodes, status=${j(s2)}`,
    };
  });

  // --- filters -------------------------------------------------------------
  await gotoGraph(d, `collapse=${encodeURIComponent(f.kind)}&expand=${encodeURIComponent(f.bench || '')}`);
  await settle();

  await check(d, 'graph/edge-kind-filters', async () => {
    const kinds = await d.js(`
      var g = Array.prototype.slice.call(document.querySelectorAll('.toolbar .group'))
        .filter(function (x) { var l = x.querySelector('.lbl'); return l && l.textContent === 'edges'; })[0];
      if (!g) return null;
      return Array.prototype.slice.call(g.querySelectorAll('label.chk')).map(function (l, i) {
        var r = l.querySelector('input').getBoundingClientRect();
        return { i: i, label: l.textContent.trim(), checked: l.querySelector('input').checked,
                 x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    `);
    if (!kinds || !kinds.length) return { ok: false, evidence: 'no edge-kind checkboxes' };
    const log = [];
    let allOk = true;
    for (let i = 0; i < kinds.length; i += 1) {
      const pos = await d.js(`
        var g = Array.prototype.slice.call(document.querySelectorAll('.toolbar .group'))
          .filter(function (x) { var l = x.querySelector('.lbl'); return l && l.textContent === 'edges'; })[0];
        var l = g.querySelectorAll('label.chk')[${i}];
        var r = l.querySelector('input').getBoundingClientRect();
        return { label: l.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2, checked: l.querySelector('input').checked };
      `);
      const before = await d.js(GRAPH_COUNTS);
      await d.click(pos.x, pos.y);
      await sleep(350);
      let status;
      try { status = await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'relayout after edge filter' }); }
      catch (e) { allOk = false; log.push(`${pos.label}: TIMEOUT`); continue; }
      const off = await d.js(GRAPH_COUNTS);
      if (off.error) allOk = false;
      // turn it back on
      const pos2 = await d.js(`
        var g = Array.prototype.slice.call(document.querySelectorAll('.toolbar .group'))
          .filter(function (x) { var l = x.querySelector('.lbl'); return l && l.textContent === 'edges'; })[0];
        var l = g.querySelectorAll('label.chk')[${i}];
        var r = l.querySelector('input').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: l.querySelector('input').checked };
      `);
      await d.click(pos2.x, pos2.y);
      await sleep(350);
      await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'relayout back' });
      const back = await d.js(GRAPH_COUNTS);
      if (back.edges !== before.edges) allOk = false;
      log.push(`${pos.label}: edges ${before.edges}->${off.edges}->${back.edges}${off.error ? ' ERROR ' + off.error : ''}`);
    }
    return { ok: allOk, evidence: log.join(' | ') };
  });

  // "hide implied", on by default: the status line counts the arcs it hides, a
  // real click on the checkbox must bring back exactly that many, the off state
  // must reach the URL and survive a reload, and a second click must hide them
  // again and drop the flag.
  await check(d, 'graph/hide-implied-arcs', async () => {
    const box = `
      var l = document.querySelector('.toolbar .group.reduce label.chk');
      if (!l) return null;
      var r = l.querySelector('input').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: l.querySelector('input').checked };
    `;
    const pos = await d.js(box);
    if (!pos) return { ok: false, evidence: 'no "hide implied" checkbox' };
    if (!pos.checked) return { ok: false, evidence: 'it is off by default' };
    const on = await d.js(GRAPH_COUNTS);
    const m = /(\d+) implied arcs? hidden/.exec(on.status);
    const n = m ? Number(m[1]) : -1;
    await d.click(pos.x, pos.y);
    await sleep(350);
    await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'relayout with every arc' });
    const off = await d.js(GRAPH_COUNTS);
    await d.open(ORIGIN + '/' + off.hash);
    await d.installHooks();
    await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 300, label: 'layout after reload' });
    const reloaded = await d.js(GRAPH_COUNTS);
    const pos2 = await d.js(box);
    await d.click(pos2.x, pos2.y);
    await sleep(350);
    await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'relayout with implied arcs hidden' });
    const back = await d.js(GRAPH_COUNTS);
    return {
      ok: n >= 0 && off.edges - on.edges === n && /[?&]reduce=0/.test(off.hash) &&
        !pos2.checked && reloaded.edges === off.edges && back.edges === on.edges &&
        !/reduce=/.test(back.hash) && off.nodes === on.nodes && !on.error && !off.error,
      evidence: `edges ${on.edges} (status: ${n} hidden) -> off ${off.edges} -> reload ${reloaded.edges}, ` +
        `checked=${pos2.checked} -> on ${back.edges}; nodes ${on.nodes}/${off.nodes}; hash=${j(off.hash)}`,
    };
  });

  await check(d, 'graph/status-filters', async () => {
    const n = await d.js(`
      var g = Array.prototype.slice.call(document.querySelectorAll('.toolbar .group'))
        .filter(function (x) { var l = x.querySelector('.lbl'); return l && l.textContent === 'status'; })[0];
      return g ? g.querySelectorAll('label.chk').length : 0;
    `);
    if (!n) return { ok: false, evidence: 'no status checkboxes' };
    const log = [];
    let allOk = true;
    let changed = 0;
    for (let i = 0; i < n; i += 1) {
      const pos = await d.js(`
        var g = Array.prototype.slice.call(document.querySelectorAll('.toolbar .group'))
          .filter(function (x) { var l = x.querySelector('.lbl'); return l && l.textContent === 'status'; })[0];
        var l = g.querySelectorAll('label.chk')[${i}];
        var r = l.querySelector('input').getBoundingClientRect();
        return { label: l.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      `);
      const before = await d.js(GRAPH_COUNTS);
      await d.click(pos.x, pos.y);
      await sleep(350);
      let status;
      try { status = await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'relayout after status filter' }); }
      catch (e) { allOk = false; log.push(`${pos.label}: TIMEOUT`); continue; }
      const off = await d.js(GRAPH_COUNTS);
      if (off.error) allOk = false;
      if (off.nodes !== before.nodes) changed += 1;
      const pos2 = await d.js(`
        var g = Array.prototype.slice.call(document.querySelectorAll('.toolbar .group'))
          .filter(function (x) { var l = x.querySelector('.lbl'); return l && l.textContent === 'status'; })[0];
        var l = g.querySelectorAll('label.chk')[${i}];
        var r = l.querySelector('input').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      `);
      await d.click(pos2.x, pos2.y);
      await sleep(350);
      await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'relayout back' });
      const back = await d.js(GRAPH_COUNTS);
      if (back.nodes !== before.nodes) allOk = false;
      log.push(`${pos.label}: nodes ${before.nodes}->${off.nodes}->${back.nodes}${off.error ? ' ERROR ' + off.error : ''}`);
    }
    return {
      ok: allOk && changed > 0,
      evidence: `${changed}/${n} status toggles changed what is drawn — ` + log.join(' | '),
    };
  });

  // --- search --------------------------------------------------------------
  await check(d, 'graph/search-highlights-matches', async () => {
    const drawn = await d.js(`
      var g = document.querySelector('.gnode:not(.junction)');
      return g ? g.dataset.id : null;
    `);
    if (!drawn) return { ok: false, evidence: 'nothing drawn' };
    const q = String(drawn).replace(/^[^a-z0-9]*/i, '').slice(0, 7);
    const inp = await d.js(elBox('.toolbar input[type="search"]'));
    await d.click(inp.x, inp.y);
    await d.type(q);
    await sleep(900);
    const r = await d.js(`
      return { matches: document.querySelectorAll('.gnode.match').length,
               dim: document.querySelectorAll('.gnode.dim').length,
               searching: document.querySelector('.glayer').classList.contains('searching'),
               hash: location.hash, value: document.querySelector('.toolbar input[type=search]').value };
    `);
    // clear it again so later checks see the unfiltered graph
    await d.js(`
      var s = document.querySelector('.toolbar input[type=search]');
      s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true;
    `);
    await sleep(500);
    return {
      ok: r.matches > 0 && r.searching && /q=/.test(r.hash),
      evidence: `typed ${j(q)} (input value=${j(r.value)}): ${r.matches} .gnode.match, ${r.dim} dim, .searching=${r.searching}, hash=${j(r.hash)}`,
    };
  });

  // --- pan / zoom ----------------------------------------------------------
  await check(d, 'graph/zoom-buttons-and-fit', async () => {
    const t0 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const plus = await d.js(elBoxByText('.toolbar button', '+'));
    await d.click(plus.x, plus.y);
    await sleep(350);
    const t1 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const minus = await d.js(elBoxByText('.toolbar button', '\u2212'));
    await d.click(minus.x, minus.y);
    await sleep(350);
    const t2 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const fit = await d.js(elBoxByText('.toolbar button', 'Fit'));
    await d.click(fit.x, fit.y);
    await sleep(500);
    const t3 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const k = (t) => Number((/scale\(([-0-9.]+)\)/.exec(t) || [])[1]);
    return {
      ok: k(t1) > k(t0) && k(t2) < k(t1) && !!t3,
      evidence: `transform: start=${j(t0)} +=${j(t1)} -=${j(t2)} Fit=${j(t3)}`,
    };
  });

  await check(d, 'graph/wheel-zooms', async () => {
    const stage = await d.js(elBox('.graph-stage'));
    const t0 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    await d.wheel(stage.x, stage.y, -300);
    await sleep(450);
    const t1 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const k = (t) => Number((/scale\(([-0-9.]+)\)/.exec(t) || [])[1]);
    return {
      ok: t1 !== t0 && k(t1) > k(t0),
      evidence: `wheel deltaY=-300 at stage centre: ${j(t0)} -> ${j(t1)}`,
    };
  });

  await check(d, 'graph/drag-pans', async () => {
    const pt = await emptyStagePoint(d);
    const t0 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const selBefore = await d.js(`return location.hash`);
    await d.drag(pt.x, pt.y, pt.x + 140, pt.y - 60);
    await sleep(450);
    const t1 = await d.js(`return document.querySelector('.glayer').getAttribute('transform')`);
    const selAfter = await d.js(`return location.hash`);
    const tr = (t) => (/translate\(([-0-9.]+),([-0-9.]+)\)/.exec(t) || []).slice(1).map(Number);
    const [x0, y0] = tr(t0);
    const [x1, y1] = tr(t1);
    return {
      ok: Math.abs(x1 - x0) > 80 && Math.abs(y1 - y0) > 30 && selBefore === selAfter,
      evidence: `drag (${pt.x},${pt.y}) -> (+140,-60): translate ${j([x0, y0])} -> ${j([x1, y1])}, hash unchanged=${selBefore === selAfter}`,
    };
  });

  // --- restore from a URL --------------------------------------------------
  await check(d, 'graph/restores-sel-and-expand-from-hash', async () => {
    const id = f.bench;
    const hash = `#/graph?collapse=${encodeURIComponent(f.kind)}&expand=${encodeURIComponent(id)}&sel=${encodeURIComponent(id)}`;
    await d.open(ORIGIN + '/' + hash);
    await d.installHooks();
    const status = await waitFor(d, GRAPH_IDLE, { timeout: 120000, interval: 300, label: 'layout after reload' });
    await settle();
    const r = await d.js(`
      var compound = Array.prototype.slice.call(document.querySelectorAll('.gnode.compound')).map(function (g) { return g.dataset.id; });
      return { selId: (document.querySelector('aside.side .obj-id') || {}).textContent,
               selected: document.querySelectorAll('.gnode.selected').length,
               compound: compound, nodes: document.querySelectorAll('.gnode').length };
    `);
    return {
      ok: r.selId === id && r.compound.includes(id) && r.selected > 0,
      evidence: `reloaded ${j(hash)}: side .obj-id=${j(r.selId)}, ${r.selected} .selected, compounds=${j(r.compound)}, ${r.nodes} nodes, status=${j(status)}`,
    };
  });

  // --- the side panel's order (taxis #527) ----------------------------------
  // The prose comes first and is on screen without scrolling the panel; the
  // incident objects follow, folded shut so their rows take no room, and a
  // real click on the summary opens them, and another shuts them again.  A
  // shut <details> still lays its rows out (its content is only
  // `content-visibility: hidden`), so their own boxes say nothing: what counts
  // is whether they are drawn and how tall the section is.
  await check(d, 'graph/side-panel-prose-first-incidents-folded', async () => {
    if (!f.panel) return { skip: true, evidence: 'no node on screen with both prose and incident objects' };
    await gotoGraph(d, `collapse=${encodeURIComponent(f.kind)}&sel=${encodeURIComponent(f.panel)}`);
    const LAYOUT = `
      var side = document.querySelector('aside.side');
      side.scrollTop = 0;
      var sections = Array.prototype.slice.call(side.querySelectorAll('section'));
      var name = function (s) { var h = s.querySelector('h3, summary'); return h ? h.textContent : ''; };
      var prose = sections.filter(function (s) { return name(s) === 'Prose'; })[0];
      var fold = sections.filter(function (s) { return /^Incident objects/.test(name(s)); })[0];
      if (!prose || !fold) return { names: sections.map(name) };
      var details = fold.querySelector('details');
      var row = fold.querySelector('ul.objlist li');
      var S = side.getBoundingClientRect();
      var drawn = !row ? null : row.checkVisibility ? row.checkVisibility() : row.getClientRects().length > 0;
      return { names: sections.map(name), proseIdx: sections.indexOf(prose), foldIdx: sections.indexOf(fold),
               proseTop: Math.round(prose.getBoundingClientRect().top - S.top), panelH: Math.round(S.height),
               open: details.open, drawn: drawn, foldH: Math.round(fold.getBoundingClientRect().height),
               summary: fold.querySelector('summary').textContent };
    `;
    const before = await d.js(LAYOUT);
    if (before.proseIdx === undefined) return { ok: false, evidence: `sections ${j(before.names)}: no Prose or no Incident objects` };
    const sum = await d.js(elBox('aside.side section.fold summary'));
    await d.click(sum.x, sum.y);
    await sleep(250);
    const opened = await d.js(LAYOUT);
    const sum2 = await d.js(elBox('aside.side section.fold summary'));
    await d.click(sum2.x, sum2.y);
    await sleep(250);
    const shut = await d.js(LAYOUT);
    return {
      ok: before.proseIdx < before.foldIdx && before.proseTop < before.panelH && !before.open && before.drawn === false
        && opened.open && opened.drawn && opened.foldH > before.foldH + 20
        && !shut.open && shut.drawn === false && shut.foldH === before.foldH,
      evidence: `${j(f.panel)}: sections ${j(before.names)}; prose at ${before.proseTop}px of a ${before.panelH}px panel; `
        + `${j(before.summary)} open=${before.open} (rows drawn=${before.drawn}, section ${before.foldH}px), `
        + `after a click open=${opened.open} (drawn=${opened.drawn}, ${opened.foldH}px), `
        + `after another open=${shut.open} (drawn=${shut.drawn}, ${shut.foldH}px)`,
    };
  });

  await check(d, 'graph/side-panel-open-object-link', async () => {
    const a = await d.js(elBoxByText('aside.side a', 'Open object page'));
    if (!a) return { ok: false, evidence: 'no "Open object page" link (is anything selected?)' };
    await d.click(a.x, a.y);
    await sleep(700);
    const r = await d.js(`
      return { hash: location.hash, h1: (document.querySelector('.obj-head h1') || {}).textContent,
               objId: (document.querySelector('.page > .obj-id') || {}).textContent };
    `);
    return {
      ok: r.hash.startsWith('#/object/') && !!r.h1,
      evidence: `clicked ${j(a.text)}: hash=${j(decodeURIComponent(r.hash))}, h1=${j(r.h1)}, .obj-id=${j(r.objId)}`,
    };
  });

  await consoleCheck(d, 'graph');
}

/** A viewport point inside the stage that no node shape covers. */
async function emptyStagePoint(d) {
  return d.js(`
    var stage = document.querySelector('.graph-stage');
    if (!stage) return null;
    var S = stage.getBoundingClientRect();
    var shapes = Array.prototype.slice.call(document.querySelectorAll('.gnode .shape, .gedge .hit')).map(function (s) { return s.getBoundingClientRect(); });
    var lg = document.querySelector('.legend');
    if (lg) shapes.push(lg.getBoundingClientRect());
    var st = document.querySelector('#graph-status');
    if (st) shapes.push(st.getBoundingClientRect());
    for (var gy = 0.9; gy > 0.05; gy -= 0.06) {
      for (var gx = 0.06; gx < 0.95; gx += 0.05) {
        var x = S.left + S.width * gx, y = S.top + S.height * gy;
        var clear = true;
        for (var i = 0; i < shapes.length; i++) {
          var r = shapes[i];
          if (x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12) { clear = false; break; }
        }
        if (clear) return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return null;
  `);
}

// ---------------------------------------------------------------------------
// 1b. shell layout
//
// Two bugs this sweep found live here and nowhere else: a `hidden` banner that
// still laid out, and the graph page sized from the viewport rather than from
// what the shell left it.  Neither is visible to a DOM shim.
// ---------------------------------------------------------------------------

async function layoutChecks(d, f) {
  await gotoGraph(d, `collapse=${encodeURIComponent(f.kind)}`);
  await settle();

  await check(d, 'layout/legend-sample-icons-stay-small', async () => {
    const s = await d.js(`
      var lg = document.querySelector('.legend');
      if (!lg) return null;
      var L = lg.getBoundingClientRect();
      var icons = Array.prototype.map.call(lg.querySelectorAll('.lgsvg'), function (s) {
        var r = s.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height);
      });
      var stage = document.querySelector('.graph-stage').getBoundingClientRect();
      return { legend: Math.round(L.width) + 'x' + Math.round(L.height), icons: icons,
               insideStage: L.bottom <= stage.bottom + 1 && L.right <= stage.right + 1,
               bottom: Math.round(L.bottom), viewport: window.innerHeight };
    `);
    if (!s) return { ok: false, evidence: 'no .legend' };
    const big = s.icons.filter((x) => Number(x.split('x')[1]) > 16);
    return {
      ok: big.length === 0 && s.insideStage && s.bottom <= s.viewport,
      evidence: `legend ${s.legend}, sample icons ${j(s.icons.slice(0, 3))} (oversized: ${big.length}), inside the stage=${s.insideStage}, bottom=${s.bottom} of ${s.viewport}`,
    };
  });

  await check(d, 'layout/top-bar-is-the-same-on-every-page', async () => {
    // The body is a flex column, and a top bar left to shrink was squeezed to
    // its tallest child on every page taller than the window: all but the
    // graph.  The tall pages are scrolled, too, so the bar is measured stuck.
    const heights = {};
    for (const hash of ['#/graph', '#/document', '#/progress', '#/checks', '#/object/' + encodeURIComponent((f.withFacts || f.section))]) {
      await route(d, hash);
      await sleep(900);
      heights[hash.split('/')[1]] = await d.js(`window.scrollTo(0, 600);
        var r = document.querySelector('.topbar').getBoundingClientRect();
        return { h: Math.round(r.height * 10) / 10, top: Math.round(r.top),
                 want: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) };`);
    }
    const hs = Object.values(heights);
    return {
      ok: hs.every((x) => x.h === hs[0].h && x.top === 0) && hs[0].h >= hs[0].want,
      evidence: `top bar ${j(Object.fromEntries(Object.entries(heights).map(([k, v]) => [k, v.h])))}, --topbar-h ${hs[0].want}px`,
    };
  });
  await gotoGraph(d, `collapse=${encodeURIComponent(f.kind)}`);
  await settle();

  await check(d, 'layout/hidden-banner-takes-no-space', async () => {
    const s = await d.js(`
      var b = document.getElementById('banner');
      var r = b.getBoundingClientRect();
      var page = document.querySelector('.graph-page').getBoundingClientRect();
      return { hidden: b.hidden, h: Math.round(r.height), display: getComputedStyle(b).display,
               pageBottom: Math.round(page.bottom), viewport: window.innerHeight,
               scrollH: document.documentElement.scrollHeight };
    `);
    return {
      ok: s.hidden && s.h === 0 && s.display === 'none' && s.scrollH <= s.viewport,
      evidence: `#banner hidden=${s.hidden} display=${j(s.display)} height=${s.h}px; graph page bottom=${s.pageBottom}, viewport=${s.viewport}, document scrollHeight=${s.scrollH}`,
    };
  });

  await check(d, 'layout/graph-fits-under-a-visible-banner', async () => {
    await route(d, '#/progress');
    await waitFor(d, `return document.querySelectorAll('.chart .pt').length > 0 || document.querySelectorAll('table.grid').length > 0`, { timeout: 30000, label: 'progress' });
    const dot = await d.js(`
      var p = document.querySelectorAll('.chart .pt')[0];
      if (!p) return null;
      var r = p.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!dot) return { skip: true, evidence: 'no history in data/index.json, so the banner never shows' };
    await d.click(dot.x, dot.y);
    await waitFor(d, `return !document.getElementById('banner').hidden`, { timeout: 30000, label: 'banner' });
    await gotoGraph(d, `collapse=${encodeURIComponent(f.kind)}`);
    await settle();
    const s = await d.js(`
      var b = document.getElementById('banner').getBoundingClientRect();
      var page = document.querySelector('.graph-page').getBoundingClientRect();
      var st = document.querySelector('#graph-status').getBoundingClientRect();
      var lg = document.querySelector('.legend').getBoundingClientRect();
      return { bannerH: Math.round(b.height), pageBottom: Math.round(page.bottom),
               statusBottom: Math.round(st.bottom), legendBottom: Math.round(lg.bottom),
               viewport: window.innerHeight, scrollH: document.documentElement.scrollHeight };
    `);
    // back to the live snapshot for everything that follows
    await route(d, '#/progress');
    await sleep(600);
    const back = await d.js(elBoxByText('#banner button', 'Back to current'));
    if (back) { await d.click(back.x, back.y); await sleep(1500); }
    return {
      ok: s.pageBottom <= s.viewport + 1 && s.statusBottom <= s.viewport && s.legendBottom <= s.viewport && s.scrollH <= s.viewport,
      evidence: `banner ${s.bannerH}px tall: graph page bottom=${s.pageBottom}, status bottom=${s.statusBottom}, legend bottom=${s.legendBottom}, viewport=${s.viewport}, scrollHeight=${s.scrollH}`,
    };
  });

  await check(d, 'layout/no-horizontal-overflow-on-any-route', async () => {
    const out = [];
    let ok = true;
    for (const hash of ['#/graph', '#/document', '#/progress', '#/checks', '#/object/' + encodeURIComponent(f.withFacts || f.section)]) {
      await route(d, hash);
      if (hash === '#/graph') await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'graph' }).catch(() => {});
      await sleep(900);
      const s = await d.js(`
        return { sw: document.documentElement.scrollWidth, iw: window.innerWidth,
                 sh: document.documentElement.scrollHeight, ih: window.innerHeight };
      `);
      if (s.sw > s.iw + 1) ok = false;
      out.push(`${hash}: scrollWidth=${s.sw}/${s.iw} scrollHeight=${s.sh}/${s.ih}`);
    }
    return { ok, evidence: out.join(' | ') };
  });

  await consoleCheck(d, 'layout');
}

// ---------------------------------------------------------------------------
// 2. object pages
// ---------------------------------------------------------------------------

const OBJECT_STATE = `
  var page = document.querySelector('.page');
  if (!page) return null;
  var links = Array.prototype.slice.call(document.querySelectorAll('a[href^="#/object/"]'))
    .map(function (a) { return decodeURIComponent(a.getAttribute('href').replace(/^#\\/object\\//, '').split('?')[0]); });
  var unknown = Array.prototype.slice.call(document.querySelectorAll('[title="unknown object"]'))
    .map(function (e) { return (e.textContent || '').trim(); });
  var broken = Array.prototype.slice.call(document.querySelectorAll('a.objlink.broken')).map(function (a) { return a.textContent; });
  return {
    h1: (document.querySelector('.obj-head h1') || {}).textContent,
    objId: (document.querySelector('.page > .obj-id') || {}).textContent,
    panels: Array.prototype.slice.call(document.querySelectorAll('.panel h3')).map(function (h) { return h.textContent; }),
    leanDecls: document.querySelectorAll('.lean-decl').length,
    katex: document.querySelectorAll('.katex').length,
    katexError: document.querySelectorAll('.katex-error').length,
    rawDollar: (document.querySelector('.body-prose') ? (document.querySelector('.body-prose').textContent.match(/\\$[^$\\n]{1,80}\\$/g) || []).length : 0),
    objlinks: document.querySelectorAll('a.objlink').length,
    links: links, unknown: unknown, broken: broken,
    boundary: document.querySelectorAll('.panel ul.objlist li').length,
    errorBox: !!document.querySelector('.error-box'),
    hash: location.hash
  };
`;

async function openObject(d, id) {
  await route(d, '#/object/' + encodeURIComponent(id));
  await waitFor(d, `return !!document.querySelector('.page, .error-box')`, { timeout: 15000, label: 'object page' });
  await sleep(250);
  return d.js(OBJECT_STATE);
}

async function objectChecks(d, f) {
  const known = f.m.byId;

  const one = async (label, id, extra) => {
    await check(d, `object/${label}`, async () => {
      if (!id) return { skip: true, evidence: 'no such fixture in this snapshot' };
      const s = await openObject(d, id);
      if (!s) return { ok: false, evidence: `no .page for ${j(id)}` };
      const badLinks = s.links.filter((x) => !known.has(x));
      const badUnknown = s.unknown.filter((x) => known.has(x));
      const base = `id=${j(id)} h1=${j(s.h1)} panels=${j(s.panels)} objlinks=${s.objlinks} katex=${s.katex}/${s.katexError} err`
        + `=${s.errorBox}`;
      const linkEv = `unresolvable object links: ${badLinks.length ? j(badLinks.slice(0, 5)) : 'none'}; `
        + `"unknown object" spans naming existing ids: ${badUnknown.length ? j(badUnknown.slice(0, 5)) : 'none'}`;
      const ex = extra ? extra(s) : { ok: true, evidence: '' };
      return {
        ok: !s.errorBox && badLinks.length === 0 && badUnknown.length === 0 && ex.ok,
        evidence: `${base}; ${linkEv}${ex.evidence ? '; ' + ex.evidence : ''}`,
      };
    });
  };

  await one('theorem-with-lean-facts', f.withFacts, (s) => ({
    ok: s.leanDecls > 0 && s.panels.includes('Lean declarations'),
    evidence: `.lean-decl=${s.leanDecls}`,
  }));
  await one('definition-without-lean-facts', f.withoutFacts, (s) => ({
    ok: s.leanDecls === 0 && !s.panels.includes('Lean declarations'),
    evidence: `.lean-decl=${s.leanDecls}`,
  }));
  await one('section', f.section, (s) => ({
    ok: s.panels.some((p) => /^Position in the /.test(p)),
    evidence: `collapse panels=${j(s.panels.filter((p) => /^Position/.test(p)))}`,
  }));
  await one('sugar-edge-with-slashes-in-id', f.sugar, (s) => ({
    ok: s.objId === f.sugar && s.panels.includes('Boundary'),
    evidence: `.obj-id=${j(s.objId)} (round-tripped through the percent-encoded hash)`,
  }));
  await one('object-with-two-parents', f.twoParents, (s) => ({
    ok: true,
    evidence: `ancestor panel present=${s.panels.some((p) => /^Position/.test(p))}`,
  }));
  await one('katex-in-the-body', f.katex, (s) => ({
    ok: s.katex > 0 && s.rawDollar === 0,
    evidence: `.katex=${s.katex}, leftover $…$ runs in text=${s.rawDollar}, snapshot formulas KaTeX could not parse=${s.katexError}`,
  }));

  await check(d, 'object/long-listings-are-folded', async () => {
    // Incident objects, attributes, the positions in the collapse orders and
    // the checks start shut, one line each; a real click opens one, and it is
    // still open on the next object page, until it is shut again.
    const id = f.panel || f.section || f.withFacts;
    if (!id) return { skip: true, evidence: 'no object with incident objects' };
    const state = `
      return Array.prototype.slice.call(document.querySelectorAll('details.panel')).map(function (p) {
        var row = p.querySelector('ul.objlist li, dl.kv dt, .check, .chain');
        return { key: p.getAttribute('data-fold'), open: p.open, h: Math.round(p.getBoundingClientRect().height),
                 shown: row ? row.checkVisibility() : null };
      });`;
    await openObject(d, id);
    const shut = await d.js(state);
    const sum = await d.js(elBox('details.panel[data-fold="incident"] > summary'));
    if (!sum) return { ok: false, evidence: `${j(id)}: no incident summary; folds ${j(shut)}` };
    await d.click(sum.x, sum.y);
    await sleep(300);
    const opened = (await d.js(state)).find((p) => p.key === 'incident');
    await openObject(d, f.withFacts || id);
    const carried = (await d.js(state)).find((p) => p.key === 'incident');
    const again = await d.js(elBox('details.panel[data-fold="incident"] > summary'));
    if (again) { await d.click(again.x, again.y); await sleep(300); }
    const closed = (await d.js(state)).find((p) => p.key === 'incident');
    const keys = shut.map((p) => p.key);
    return {
      ok: shut.length >= 3 && shut.every((p) => !p.open && p.shown !== true && p.h < 60)
        && ['attrs', 'incident'].every((k) => keys.includes(k)) && keys.some((k) => /^order:/.test(k))
        && opened && opened.open && opened.shown === true
        && (!carried || carried.open) && (!closed || !closed.open),
      evidence: `${j(id)}: shut ${j(shut)}; after a click incident ${j(opened)}; on the next page ${j(carried)}; clicked shut ${j(closed)}`,
    };
  });

  await check(d, 'object/slug-link-navigates', async () => {
    if (!f.slug) return { skip: true, evidence: 'no [slug] in any body resolves to an object' };
    await openObject(d, f.slug.id);
    const a = await d.js(`
      var a = Array.prototype.slice.call(document.querySelectorAll('.body-prose a.objlink'))
        .filter(function (x) { return x.getAttribute('title') === ${j(f.slug.target)}; })[0];
      if (!a) return null;
      var r = inView(a);
      return { href: a.getAttribute('href'), x: r.left + r.width / 2, y: r.top + r.height / 2, broken: a.classList.contains('broken') };
      ${IN_VIEW}
    `);
    if (!a) return { ok: false, evidence: `no a.objlink for [${f.slug.target}] inside ${j(f.slug.id)}` };
    await d.click(a.x, a.y);
    await sleep(600);
    const s = await d.js(OBJECT_STATE);
    return {
      ok: !!s && s.objId === f.slug.target && !s.errorBox,
      evidence: `clicked [${f.slug.target}] (href=${j(a.href)}, broken=${a.broken}) in ${j(f.slug.id)}: now .obj-id=${j(s && s.objId)}, hash=${j(decodeURIComponent((s && s.hash) || ''))}`,
    };
  });

  await check(d, 'object/unknown-id-shows-error-page', async () => {
    await route(d, '#/object/' + encodeURIComponent('no-such-object-' + Date.now()));
    await sleep(500);
    const r = await d.js(`
      return { errorBox: !!document.querySelector('.error-box'),
               h1: (document.querySelector('.error-box h1') || {}).textContent,
               detail: (document.querySelector('.error-box .detail') || {}).textContent };
    `);
    return { ok: r.errorBox && /No such object/.test(r.h1 || ''), evidence: `h1=${j(r.h1)}, detail=${j(r.detail)}` };
  });

  await d.shot(`${SHOTS}/${d.name}-object.png`);
  await consoleCheck(d, 'object');
}

// ---------------------------------------------------------------------------
// 3. document page  (observed only — the fix is someone else's)
// ---------------------------------------------------------------------------

const DOC_STATE = `
  var entries = document.querySelectorAll('.doc-entry');
  var proseWithContent = 0;
  var prose = document.querySelectorAll('.doc-entry .prose');
  for (var i = 0; i < prose.length; i++) if (prose[i].childNodes.length) proseWithContent++;
  var heads = {};
  for (var lv = 1; lv <= 5; lv++) heads['h' + lv] = document.querySelectorAll('.doc-entry .head h' + lv).length;
  var text = document.body.innerText || '';
  return {
    entries: entries.length,
    toc: document.querySelectorAll('nav.toc a').length,
    prose: prose.length, proseRendered: proseWithContent,
    steps: document.querySelectorAll('.doc-entry .step').length,
    katex: document.querySelectorAll('.katex').length,
    katexError: document.querySelectorAll('.katex-error').length,
    rawInline: (text.match(/\\$[^$\\n]{1,120}\\$/g) || []).length,
    rawDisplay: (text.match(/\\\\\\[|\\\\\\]/g) || []).length,
    heads: heads,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    innerHeight: window.innerHeight
  };
`;

// Where the document view is: which page, what it writes out, its chrome.
const PAGE_STATE = `
  var head = document.querySelector('.doc-entry.page-head .head h1');
  var top = document.querySelector('.doc-flow .doc-entry');
  return {
    hash: decodeURIComponent(location.hash),
    entries: document.querySelectorAll('.doc-entry').length,
    ids: Array.prototype.map.call(document.querySelectorAll('.doc-entry'), function (s) { return s.id; }).slice(0, 6),
    pageHead: head ? (head.textContent || '').trim().slice(0, 60) : null,
    crumbs: document.querySelectorAll('.doc-crumbs a').length,
    pagers: document.querySelectorAll('.doc-pager').length,
    opens: document.querySelectorAll('.doc-open a').length,
    toc: document.querySelectorAll('nav.toc a').length,
    scrollY: Math.round(window.scrollY),
    errorBox: !!document.querySelector('.error-box')
  };
`;

const anchorOf = (id) => 'doc-' + String(id).replace(/[^A-Za-z0-9_-]/g, '_');

/** Is the entry for `id` built and in the top part of the viewport? */
const ENTRY_IN_VIEW = (id) => `
  var t = document.getElementById(${j(anchorOf(id))});
  if (!t) return { found: false };
  var b = t.getBoundingClientRect();
  // An entry near the end of a short page cannot be scrolled to the top: there
  // it counts when the page is scrolled as far as it goes and the entry shows.
  var atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
  return { found: true, top: Math.round(b.top), atBottom: atBottom, scrollY: Math.round(window.scrollY),
           inView: b.top > -60 && (b.top < window.innerHeight * 0.6 || (atBottom && b.top < window.innerHeight - 20)),
           hash: decodeURIComponent(location.hash) };
`;

async function clickAndWait(d, box, cond, label) {
  await d.click(box.x, box.y);
  await sleep(500);
  return waitFor(d, cond, { timeout: 30000, label });
}

/** The split document (taxis #526): pages, their navigation, and old links. */
async function pageChecks(d, f) {
  const out = f.outline;
  const docPath = (id) => '#/document/' + id + '?';

  await check(d, 'document/top-page-lists-the-top-level', async () => {
    const s = await d.js(PAGE_STATE);
    const withKids = out.roots.filter((e) => !e.duplicate && e.children.length).length;
    return {
      ok: s.entries === out.roots.length && s.opens === withKids && !s.pageHead && s.crumbs === 0 && s.pagers === 0,
      evidence: `#/document: ${s.entries} .doc-entry (outline roots ${out.roots.length}), ${s.opens} "Read …" links (roots with children ${withKids}), page head ${j(s.pageHead)}, ${s.crumbs} breadcrumbs, ${s.pagers} pagers`,
    };
  });

  await check(d, 'document/click-into-a-chapter', async () => {
    if (!f.chapter) return { skip: true, evidence: 'no top-level entry with children and a next sibling' };
    const entry = out.byId.get(f.chapter);
    await d.js('window.scrollTo(0, 0); return 0;');
    const box = await d.js(`
      var a = Array.prototype.slice.call(document.querySelectorAll('.doc-open a')).filter(function (x) {
        return x.getAttribute('href').indexOf(${j('#/document/' + encodeURIComponent(f.chapter) + '?')}) === 0; })[0];
      if (!a) return null;
      var r = inView(a);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (a.textContent || '').trim() };
      ${IN_VIEW}
    `);
    if (!box) return { ok: false, evidence: `no "Read" link for ${f.chapter} on the top page` };
    await clickAndWait(d, box, `return !!document.querySelector('.doc-entry.page-head')`, 'chapter page');
    await sleep(400);
    const s = await d.js(PAGE_STATE);
    const want = M.documentPageEntries(out, f.chapter, 1).length;
    return {
      ok: s.hash.startsWith(docPath(f.chapter)) && s.entries === want && s.crumbs >= 1 && s.pagers >= 1
        && s.scrollY === 0 && s.ids[0] === anchorOf(f.chapter),
      evidence: `clicked ${j(box.text)}: hash=${j(s.hash)}, page head ${j(s.pageHead)} (${entry.number}), ${s.entries} entries (want ${want}), `
        + `${s.crumbs} breadcrumb links, ${s.pagers} pagers, scrollY=${s.scrollY}`,
    };
  });

  await check(d, 'document/pager-next-sibling', async () => {
    if (!f.chapter) return { skip: true, evidence: 'no chapter fixture' };
    const siblings = out.roots.filter((e) => !e.duplicate);
    const next = siblings[siblings.indexOf(out.byId.get(f.chapter)) + 1];
    const box = await d.js(elBox('.doc-pager a.next'));
    if (!box) return { ok: false, evidence: 'no .doc-pager a.next' };
    await clickAndWait(d, box, `return decodeURIComponent(location.hash).indexOf(${j(docPath(next.id))}) === 0
      && !!document.querySelector('.doc-entry.page-head')`, 'next page');
    const s = await d.js(PAGE_STATE);
    return {
      ok: s.ids[0] === anchorOf(next.id),
      evidence: `next of ${f.chapter} is ${next.id} (${next.number}): hash=${j(s.hash)}, first entry #${s.ids[0]}, head ${j(s.pageHead)}`,
    };
  });

  await check(d, 'document/breadcrumb-leads-to-the-top', async () => {
    if (!f.chapter) return { skip: true, evidence: 'no chapter fixture' };
    const box = await d.js(elBox('.doc-crumbs a'));
    if (!box) return { ok: false, evidence: 'no breadcrumb link' };
    await clickAndWait(d, box, `return location.hash.indexOf('#/document?') === 0 && !document.querySelector('.doc-entry.page-head')
      && document.querySelectorAll('.doc-entry').length > 0`, 'top page');
    const s = await d.js(PAGE_STATE);
    return { ok: s.entries === out.roots.length, evidence: `clicked ${j(box.text)}: hash=${j(s.hash)}, ${s.entries} entries` };
  });

  await check(d, 'document/depth-control-inlines-a-level', async () => {
    const want = M.documentPageEntries(out, null, 2).length;
    await d.js(`
      var s = document.querySelectorAll('.doc-controls select');
      s = s[s.length - 1];
      s.value = '2';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    `);
    const n = await waitFor(d, `var n = document.querySelectorAll('.doc-entry').length; return n >= ${want} ? n : 0;`,
      { timeout: 30000, label: `${want} entries at depth 2` }).catch(() => null);
    const s = await d.js(PAGE_STATE);
    const opensOk = s.opens > 0 || !out.roots.some((e) => e.children.some((c) => c.children.length));
    return {
      ok: n === want && /depth=2/.test(s.hash) && opensOk,
      evidence: `depth 2 on the top page: ${s.entries} entries (want ${want}), hash=${j(s.hash)}, ${s.opens} "Read …" links to third-level pages`,
    };
  });

  await check(d, 'document/old-focus-link-redirects-and-back-still-works', async () => {
    if (!f.deepLeaf) return { skip: true, evidence: 'no leaf below the top level' };
    await route(d, '#/progress');
    await waitFor(d, `return document.querySelectorAll('table.grid').length > 0`, { timeout: 30000, label: 'progress' });
    await route(d, '#/document?focus=' + encodeURIComponent(f.deepLeaf));
    const want = f.deepLeafPage === null ? '#/document?' : docPath(f.deepLeafPage);
    await waitFor(d, `return decodeURIComponent(location.hash).indexOf(${j(want)}) === 0
      && !!document.getElementById(${j(anchorOf(f.deepLeaf))})`, { timeout: 40000, label: 'redirected page' });
    await sleep(900);
    const r = await d.js(ENTRY_IN_VIEW(f.deepLeaf));
    await d.back();
    await sleep(900);
    const after = await d.js(`return { hash: location.hash, progress: document.querySelectorAll('table.grid').length > 0 }`);
    return {
      ok: r.found && r.inView && after.hash === '#/progress' && after.progress,
      evidence: `#/document?focus=${f.deepLeaf} -> ${j(r.hash)} (want ${j(want + '…')}), entry top=${r.top}px in view=${r.inView}; `
        + `Back -> ${j(after.hash)} (the redirect replaced its history entry)`,
    };
  });

  await check(d, 'document/object-page-link-opens-the-right-page', async () => {
    if (!f.deepLeaf) return { skip: true, evidence: 'no leaf below the top level' };
    await openObject(d, f.deepLeaf);
    const box = await d.js(elBoxByText('a', 'In the document'));
    if (!box) return { ok: false, evidence: `no "In the document" link on ${f.deepLeaf}` };
    const want = f.deepLeafPage === null ? '#/document?' : docPath(f.deepLeafPage);
    await clickAndWait(d, box, `return decodeURIComponent(location.hash).indexOf(${j(want)}) === 0
      && !!document.getElementById(${j(anchorOf(f.deepLeaf))})`, 'document page from the object page');
    await sleep(900);
    const r = await d.js(ENTRY_IN_VIEW(f.deepLeaf));
    return { ok: r.found && r.inView, evidence: `-> ${j(r.hash)}: entry top=${r.top}px, scrollY=${r.scrollY}, in view=${r.inView}` };
  });

  await check(d, 'document/focus-holds-while-prose-above-renders', async () => {
    if (!f.midFocus) return { skip: true, evidence: 'no page with more than five entries carrying prose' };
    const { page, id } = f.midFocus;
    await route(d, '#/progress');
    await waitFor(d, `return document.querySelectorAll('table.grid').length > 0`, { timeout: 30000, label: 'progress' });
    await route(d, '#/document/' + encodeURIComponent(page) + '?' + new URLSearchParams({ collapse: f.kind, focus: id }).toString());
    await waitFor(d, `return !!document.getElementById(${j(anchorOf(id))})`, { timeout: 30000, label: 'focused entry' });
    // Long enough for every body near the viewport to have rendered.
    await sleep(2500);
    const r = await d.js(ENTRY_IN_VIEW(id));
    const rendered = await d.js(`return Array.prototype.filter.call(document.querySelectorAll('.doc-entry .prose'),
      function (p) { return p.childNodes.length > 0; }).length`);
    return {
      ok: r.found && r.top > -10 && r.top < 200,
      evidence: `${page} focused on ${id} (halfway down): entry top=${r.top}px after ${rendered} bodies rendered, scrollY=${r.scrollY}`,
    };
  });

  await route(d, '#/document');
  await sleep(500);
}

async function documentChecks(d, f) {
  await route(d, '#/document');
  await waitFor(d, `return document.querySelectorAll('.doc-entry').length > 0`, { timeout: 30000, label: 'document entries' });
  await sleep(700);

  await check(d, 'document/initial-render', async () => {
    const s = await d.js(DOC_STATE);
    return {
      ok: s.entries > 0 && s.toc > 0,
      evidence: `${s.entries} .doc-entry, ${s.toc} toc links, ${s.prose} .prose (${s.proseRendered} rendered), ${s.steps} steps, heads=${j(s.heads)}`,
    };
  });

  await pageChecks(d, f);

  // The rest is about one large page: the whole document, which is what the
  // lazy machinery is for.
  await route(d, '#/document?depth=all');
  await waitFor(d, `return document.querySelectorAll('.doc-entry').length > 0`, { timeout: 30000, label: 'whole document' });
  await sleep(700);

  await check(d, 'document/depth-all-builds-the-whole-document', async () => {
    const want = f.outline.entries.length;
    const n = await waitFor(d, `var n = document.querySelectorAll('.doc-entry').length; return n >= ${want} ? n : 0;`,
      { timeout: 60000, interval: 300, label: `${want} entries` }).catch(() => null);
    const got = await d.js(`return document.querySelectorAll('.doc-entry').length`);
    return { ok: n === want, evidence: `depth=all: ${got} .doc-entry built, the outline has ${want}` };
  });

  await check(d, 'document/lazy-render-while-scrolling', async () => {
    const steps = [];
    let s = await d.js(DOC_STATE);
    steps.push(`y=${s.scrollY} rendered=${s.proseRendered}/${s.prose}`);
    for (let i = 0; i < 12; i += 1) {
      await d.js(`window.scrollBy(0, Math.round(window.innerHeight * 0.85)); return window.scrollY;`);
      await sleep(600);
      s = await d.js(DOC_STATE);
      steps.push(`y=${s.scrollY} rendered=${s.proseRendered}/${s.prose} entries=${s.entries}`);
    }
    await d.js(`window.scrollTo(0, document.documentElement.scrollHeight); return window.scrollY;`);
    await sleep(900);
    const end = await d.js(DOC_STATE);
    const got = await d.drain();
    const errs = (got.errors || []);
    // put the drained lines back so the console check still sees them
    d.__docDrain = got;
    return {
      ok: errs.length === 0 && end.proseRendered > 0 && end.entries > 0,
      evidence: `${steps.slice(0, 4).join(' | ')} … final ${end.proseRendered}/${end.prose} prose rendered, ${end.entries} entries, scrollHeight=${end.scrollHeight}; ${errs.length} console errors`,
    };
  });

  await check(d, 'document/headings-present-at-the-bottom', async () => {
    const s = await d.js(`
      var hs = Array.prototype.slice.call(document.querySelectorAll('.doc-entry .head h2, .doc-entry .head h3, .doc-entry .head h4, .doc-entry .head h5'));
      var visible = hs.filter(function (h) { var r = h.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });
      return { total: hs.length, visible: visible.length, sample: visible.slice(0, 3).map(function (h) { return h.tagName + ':' + (h.textContent || '').trim().slice(0, 40); }) };
    `);
    return { ok: s.total > 0 && s.visible > 0, evidence: `${s.total} headings, ${s.visible} in the viewport at the bottom: ${j(s.sample)}` };
  });

  // Whether the *site* rendered the maths at all.  A handful of `.katex-error`
  // spans are the snapshot's own formulas failing to parse, which no change to
  // web/ can fix, so they are named in the evidence but do not fail the gate.
  await check(d, 'document/katex-renders', async () => {
    const s = await d.js(DOC_STATE);
    const errs = await d.js(`
      return Array.prototype.map.call(document.querySelectorAll('.katex-error'), function (e) {
        return (e.textContent || '') + ' -> ' + (e.getAttribute('title') || '').slice(0, 90);
      }).slice(0, 4);
    `);
    return {
      ok: s.katex > 0 && s.rawInline === 0,
      evidence: `.katex=${s.katex} rendered, un-rendered inline $…$ runs in innerText=${s.rawInline}, stray \\[ \\] markers=${s.rawDisplay}; `
        + `snapshot formulas KaTeX could not parse: ${s.katexError}${errs.length ? ' e.g. ' + j(errs[0]) : ''}`,
    };
  });

  await check(d, 'document/typography-evidence', async () => {
    const s = await d.js(`
      var out = {};
      var pick = function (sel) {
        var e = document.querySelector(sel);
        if (!e) return null;
        var cs = getComputedStyle(e);
        return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, text: (e.textContent || '').trim().slice(0, 30) };
      };
      out.h2 = pick('.doc-entry .head h2');
      out.h3 = pick('.doc-entry .head h3');
      out.h4 = pick('.doc-entry .head h4');
      out.h5 = pick('.doc-entry .head h5');
      out.stepHead = pick('.doc-entry .step .step-head');
      out.stepTitle = pick('.doc-entry .step .step-title');
      return out;
    `);
    const px = (x) => (x ? parseFloat(x.fontSize) : null);
    const mono = [px(s.h2), px(s.h3), px(s.h4), px(s.h5)].filter((x) => x !== null);
    let decreasing = true;
    for (let i = 1; i < mono.length; i += 1) if (mono[i] > mono[i - 1]) decreasing = false;
    const stepBig = px(s.stepTitle) !== null && px(s.h3) !== null && px(s.stepTitle) > px(s.h3);
    return {
      ok: decreasing && !stepBig,
      evidence: `heading font sizes h2..h5 = ${j(mono)} (monotone non-increasing=${decreasing}); step-head=${j(s.stepHead)}, step-title=${j(s.stepTitle)}`,
    };
  });

  await check(d, 'document/toc-link-scrolls-to-heading', async () => {
    await d.js(`window.scrollTo(0, 0); return window.scrollY;`);
    await sleep(300);
    const link = await d.js(`
      var a = document.querySelectorAll('nav.toc a')[2] || document.querySelector('nav.toc a');
      if (!a) return null;
      var href = a.getAttribute('href');
      var focus = decodeURIComponent((href.split('focus=')[1] || '').split('&')[0]);
      var r = inView(a);
      return { text: (a.textContent || '').trim(), focus: focus, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      ${IN_VIEW}
    `);
    if (!link) return { ok: false, evidence: 'no toc links' };
    await d.click(link.x, link.y);
    await sleep(1200);
    const r = await d.js(`
      var id = 'doc-' + ${j(link.focus)}.replace(/[^A-Za-z0-9_-]/g, '_');
      var t = document.getElementById(id);
      if (!t) return { found: false, id: id };
      var b = t.getBoundingClientRect();
      return { found: true, id: id, top: Math.round(b.top), inView: b.top > -40 && b.top < window.innerHeight * 0.6, scrollY: Math.round(window.scrollY) };
    `);
    return {
      ok: r.found && r.inView,
      evidence: `toc ${j(link.text)} -> #${r.id}: heading top=${r.top}px, scrollY=${r.scrollY}, in view=${r.inView}`,
    };
  });

  await check(d, 'document/focus-query-scrolls', async () => {
    const id = f.section || f.withFacts;
    await route(d, '#/document?focus=' + encodeURIComponent(id));
    await waitFor(d, `return !!document.getElementById('doc-' + ${j(id)}.replace(/[^A-Za-z0-9_-]/g, '_'))`, { timeout: 40000, label: 'focused section built' });
    await sleep(1200);
    const r = await d.js(`
      var t = document.getElementById('doc-' + ${j(id)}.replace(/[^A-Za-z0-9_-]/g, '_'));
      var b = t.getBoundingClientRect();
      return { top: Math.round(b.top), scrollY: Math.round(window.scrollY), inView: b.top > -60 && b.top < window.innerHeight };
    `);
    return { ok: r.inView, evidence: `?focus=${id}: section top=${r.top}px, scrollY=${r.scrollY}` };
  });

  await d.shot(`${SHOTS}/${d.name}-document.png`);
  await consoleCheck(d, 'document');
}

// ---------------------------------------------------------------------------
// 3b. cross references: `[slug]` reads "Definition 1.2.1" (taxis #524)
// ---------------------------------------------------------------------------

/** The `[slug]` link naming `target` inside `scope`, with its text and box. */
const REF_LINK = (scope, target) => `
  var a = Array.prototype.slice.call(document.querySelectorAll(${j(scope + ' a.objlink')}))
    .filter(function (x) { return x.getAttribute('title') === ${j(target)}; })[0];
  if (!a) return null;
  var r = inView(a);
  return { text: (a.textContent || '').trim(), href: a.getAttribute('href'), title: a.getAttribute('title'),
           ref: a.classList.contains('ref'), broken: a.classList.contains('broken'),
           x: r.left + r.width / 2, y: r.top + r.height / 2 };
  ${IN_VIEW}
`;

/**
 * The link found by `body`, once it has stopped moving.  Bodies around it
 * render lazily as it is scrolled into view and push it about; a click aimed
 * at where it was a moment ago lands on the text next to it.
 */
async function steadyLink(d, body) {
  let last = await waitFor(d, body, { timeout: 30000, label: 'reference in the document' }).catch(() => null);
  for (let i = 0; last && i < 20; i += 1) {
    await sleep(300);
    const now = await d.js(body);
    if (now && Math.abs(now.x - last.x) < 1 && Math.abs(now.y - last.y) < 1) return now;
    last = now;
  }
  return last;
}

async function referenceChecks(d, f) {
  const labelOk = (got, want) => got === want.label || got === want.number;

  await check(d, 'references/object-page-reads-the-number', async () => {
    if (!f.ref) return { skip: true, evidence: 'no [slug] naming a numbered object' };
    await openObject(d, f.ref.id);
    const a = await waitFor(d, REF_LINK('.body-prose', f.ref.target), { timeout: 15000, label: 'reference link' }).catch(() => null);
    if (!a) return { ok: false, evidence: `no link for [${f.ref.target}] in ${j(f.ref.id)}` };
    const want = '#/object/' + encodeURIComponent(f.ref.target);
    return {
      ok: labelOk(a.text, f.ref) && a.href === want && a.title === f.ref.target && a.ref,
      evidence: `[${f.ref.target}] in ${j(f.ref.id)} reads ${j(a.text)} (want ${j(f.ref.label)}), href=${j(a.href)}, tooltip=${j(a.title)}`,
    };
  });

  await check(d, 'references/broken-link-unchanged', async () => {
    if (!f.brokenRef) return { skip: true, evidence: 'no bad-link check in this snapshot: every [slug] resolves' };
    await openObject(d, f.brokenRef.id);
    const a = await d.js(`
      var a = Array.prototype.slice.call(document.querySelectorAll('.body-prose a.objlink.broken'))
        .filter(function (x) { return (x.textContent || '').trim() === ${j(f.brokenRef.target)}; })[0];
      return a ? { text: a.textContent, href: a.getAttribute('href') } : null;
    `);
    return {
      ok: !!a && a.href === '#/checks?code=bad-link',
      evidence: a ? `[${f.brokenRef.target}] in ${j(f.brokenRef.id)}: text=${j(a.text)}, href=${j(a.href)}` : `no broken link ${j(f.brokenRef.target)} in ${j(f.brokenRef.id)}`,
    };
  });

  await check(d, 'references/graph-side-panel-reads-the-number', async () => {
    if (!f.ref) return { skip: true, evidence: 'no [slug] naming a numbered object' };
    const expand = M.expandableAncestorsOf(f.order, f.ref.id);
    await gotoGraph(d, new URLSearchParams({ collapse: f.kind, expand: expand.join(','), sel: f.ref.id }).toString());
    const a = await waitFor(d, REF_LINK('aside.side', f.ref.target), { timeout: 20000, label: 'side panel reference' }).catch(() => null);
    if (!a) return { ok: false, evidence: `no link for [${f.ref.target}] in the side panel of ${j(f.ref.id)}` };
    return {
      ok: labelOk(a.text, f.ref) && a.href === '#/object/' + encodeURIComponent(f.ref.target),
      evidence: `side panel of ${j(f.ref.id)}: [${f.ref.target}] reads ${j(a.text)}, href=${j(a.href)}`,
    };
  });

  const docPage = (page, focus) => '#/document' + (page ? '/' + encodeURIComponent(page) : '')
    + '?' + new URLSearchParams({ collapse: f.kind, focus }).toString();

  await check(d, 'references/document-reference-opens-the-page-it-is-read-on', async () => {
    if (!f.refFar) return { skip: true, evidence: 'no reference to an entry on another page' };
    const { id, target, page } = f.refFar;
    await route(d, docPage(page, id));
    const scope = '#' + anchorOf(id);
    const a = await steadyLink(d, REF_LINK(scope, target));
    if (!a) return { ok: false, evidence: `no link for [${target}] in ${scope} on ${docPage(page, id)}` };
    const home = M.documentPageOf(f.outline, target);
    const want = home === null ? '#/document?' : '#/document/' + home + '?';
    await d.click(a.x, a.y);
    await waitFor(d, `return decodeURIComponent(location.hash).indexOf(${j(want)}) === 0
      && !!document.getElementById(${j(anchorOf(target))})`, { timeout: 30000, label: 'target page' }).catch(() => null);
    await sleep(900);
    const r = await d.js(ENTRY_IN_VIEW(target));
    return {
      ok: labelOk(a.text, f.refFar) && r.found && r.inView,
      evidence: `[${target}] in ${j(id)} reads ${j(a.text)}; clicked -> ${j(r.hash)} (want ${j(want + '…')}), target top=${r.top}px in view=${r.inView}`,
    };
  });

  await check(d, 'references/document-reference-on-the-same-page-scrolls', async () => {
    if (!f.refNear) return { skip: true, evidence: 'no reference to an entry on the same page' };
    const { id, target, page } = f.refNear;
    await route(d, docPage(page, id));
    const scope = '#' + anchorOf(id);
    const a = await steadyLink(d, REF_LINK(scope, target));
    if (!a) return { ok: false, evidence: `no link for [${target}] in ${scope}` };
    const before = await d.js('return location.hash');
    await d.click(a.x, a.y);
    await sleep(1500);
    const r = await d.js(ENTRY_IN_VIEW(target));
    const after = await d.js('return location.hash');
    return {
      ok: labelOk(a.text, f.refNear) && r.found && r.inView && after === before,
      evidence: `[${target}] in ${j(id)} reads ${j(a.text)}, href=${j(decodeURIComponent(a.href))}; clicked: target top=${r.top}px in view=${r.inView}, hash ${after === before ? 'unchanged' : 'changed to ' + after}`,
    };
  });

  await consoleCheck(d, 'references');
}

// ---------------------------------------------------------------------------
// 4. progress page
// ---------------------------------------------------------------------------

async function progressChecks(d, f) {
  await route(d, '#/progress');
  await waitFor(d, `return document.querySelectorAll('table.grid').length > 0`, { timeout: 30000, label: 'progress tables' });
  await sleep(400);

  await check(d, 'progress/tables-render', async () => {
    const s = await d.js(`
      var tables = document.querySelectorAll('table.grid');
      return { tables: tables.length,
               rows: Array.prototype.map.call(tables, function (t) { return t.querySelectorAll('tbody tr').length; }),
               stats: document.querySelectorAll('.stat-row .stat').length,
               stack: document.querySelectorAll('.stackbar').length,
               h2: Array.prototype.map.call(document.querySelectorAll('.page h2'), function (h) { return h.textContent; }) };
    `);
    return {
      ok: s.tables >= 2 && s.rows.every((n) => n > 0) && s.stats > 0,
      evidence: `${s.tables} table.grid with rows=${j(s.rows)}, ${s.stats} .stat tiles, ${s.stack} stack bars, h2=${j(s.h2)}`,
    };
  });

  await check(d, 'progress/time-slider-exists', async () => {
    const s = await d.js(`
      var r = document.querySelector('input[type=range]');
      return r ? { min: r.min, max: r.max, value: r.value, dots: document.querySelectorAll('.chart .pt').length,
                   label: (document.querySelector('.slider-row .mono') || {}).textContent } : null;
    `);
    if (!s) return { ok: false, evidence: 'no input[type=range] — data/index.json missing or has one snapshot?' };
    return { ok: Number(s.max) >= 1 && s.dots > 1, evidence: `range ${s.min}..${s.max} at ${s.value}, ${s.dots} chart dots, label=${j(s.label)}` };
  });

  await check(d, 'progress/picking-a-snapshot-switches-the-app', async () => {
    const dot = await d.js(`
      var p = document.querySelectorAll('.chart .pt')[0];
      if (!p) return null;
      var r = p.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!dot) return { ok: false, evidence: 'no chart dots to click' };
    await d.click(dot.x, dot.y);
    await waitFor(d, `return !document.getElementById('banner').hidden`, { timeout: 30000, label: 'snapshot banner' });
    const s = await d.js(`
      var b = document.getElementById('banner');
      return { hidden: b.hidden, text: (b.textContent || '').trim(), cls: b.className,
               tables: document.querySelectorAll('table.grid').length };
    `);
    return {
      ok: !s.hidden && /Viewing snapshot/.test(s.text),
      evidence: `clicked the first chart dot: banner=${j(s.text)} class=${j(s.cls)}, ${s.tables} tables still rendered`,
    };
  });

  await check(d, 'progress/back-to-current', async () => {
    const b = await d.js(elBoxByText('#banner button', 'Back to current'));
    if (!b) return { ok: false, evidence: 'no "Back to current" button in the banner' };
    await d.click(b.x, b.y);
    await waitFor(d, `return document.getElementById('banner').hidden === true`, { timeout: 30000, label: 'banner hidden again' });
    const s = await d.js(`return { hidden: document.getElementById('banner').hidden, tables: document.querySelectorAll('table.grid').length, hash: location.hash };`);
    return { ok: s.hidden && s.tables >= 2, evidence: `banner hidden=${s.hidden}, ${s.tables} tables, hash=${j(s.hash)}` };
  });

  await check(d, 'progress/show-all-button', async () => {
    const b = await d.js(elBoxByText('.page button', 'Show all'));
    if (!b) return { skip: true, evidence: 'no "Show all" button: every object already fits' };
    const before = await d.js(`return document.querySelectorAll('table.grid')[1].querySelectorAll('tbody tr').length`);
    await d.click(b.x, b.y);
    await sleep(1500);
    const after = await d.js(`return document.querySelectorAll('table.grid')[1].querySelectorAll('tbody tr').length`);
    const note = await d.js(elBoxByText('.page p.muted.small', 'All '));
    return {
      ok: after > before,
      evidence: `${j(b.text)}: rows ${before} -> ${after}; note now ${j(note && note.text)}`,
    };
  });

  await d.shot(`${SHOTS}/${d.name}-progress.png`);
  await consoleCheck(d, 'progress');
}

// ---------------------------------------------------------------------------
// 4b. search: the top bar's box, and the progress listing's search and filters
// ---------------------------------------------------------------------------

const LISTING_STATE = `
  var t = document.querySelectorAll('table.grid')[1];
  var rows = t ? Array.prototype.filter.call(t.querySelectorAll('tbody tr'), function (tr) {
    return !tr.querySelector('td[colspan]'); }) : [];
  var sel = Array.prototype.map.call(document.querySelectorAll('.listing-filters select'), function (s) { return s.value; });
  var more = Array.prototype.filter.call(document.querySelectorAll('.page button'), function (b) {
    return /^Show all/.test(b.textContent); })[0];
  return { rows: rows.length,
           count: (document.querySelector('.listing-count') || {}).textContent || null,
           q: (document.querySelector('.listing-search') || {}).value,
           selects: sel, hash: location.hash,
           more: more ? more.textContent : null,
           marker: (document.querySelector('.page') || {}).dataset ? document.querySelector('.page').dataset.sweep || null : null,
           focus: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null };
`;

const GSEARCH_STATE = `
  var p = document.getElementById('gsearch-panel');
  var inp = document.getElementById('gsearch-input');
  var items = Array.prototype.map.call(document.querySelectorAll('#gsearch-results .gsearch-item'), function (a) {
    return { href: a.getAttribute('href'), active: a.classList.contains('active'), sel: a.getAttribute('aria-selected'),
             lean: (a.querySelector('.gsearch-lean') || {}).textContent || null }; });
  var r = p.getBoundingClientRect();
  var first = document.querySelector('#gsearch-results .gsearch-item');
  var hit = null;
  if (first && !p.hidden) {
    var fr = first.getBoundingClientRect();
    var e = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
    hit = !!(e && first.contains(e));
  }
  return { open: !p.hidden, value: inp.value, focused: document.activeElement === inp,
           expanded: inp.getAttribute('aria-expanded'), descendant: inp.getAttribute('aria-activedescendant'),
           items: items, foot: (document.getElementById('gsearch-foot') || {}).textContent,
           box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, vw: window.innerWidth, vh: window.innerHeight,
           firstOnTop: hit, hash: location.hash,
           h1: (document.querySelector('.page h1') || {}).textContent || null };
`;

async function typeInto(d, selector, text) {
  const inp = await d.js(elBox(selector));
  if (!inp) throw new Error('no ' + selector);
  await d.click(inp.x, inp.y);
  await d.js(`var e = document.querySelector(${j(selector)}); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await d.type(text);
}

async function searchChecks(d, f) {
  const m = f.m;
  const all = M.countableObjects(m);
  const objHref = (id) => '#/object/' + encodeURIComponent(id);
  const bareSugar = (o) => m.kinds[o.kind] && m.kinds[o.kind].sugar && !o.attrs.title && !o.body.trim();

  // --- the progress listing -------------------------------------------------
  await route(d, '#/progress');
  await waitFor(d, `return !!document.querySelector('.listing-filters')`, { timeout: 30000, label: 'listing filters' });
  await sleep(400);
  // A mark on the page element: if typing re-rendered the page, it is gone.
  await d.js(`document.querySelector('.page').dataset.sweep = 'kept'; return true;`);

  // The query: the id of a countable object, minus its first character, so it
  // is a substring and not the exact id.
  const probe = all.find((o) => o.id.length > 6) || all[0];
  const q = probe ? probe.id.slice(1) : 'a';
  await check(d, 'search/listing-search-updates-in-place', async () => {
    await typeInto(d, '.listing-search', q);
    await sleep(900);
    const s = await d.js(LISTING_STATE);
    const want = M.filterListing(m, all, { q }).length;
    return {
      ok: s.count === `${want} of ${all.length} objects` && s.rows === Math.min(want, 300)
        && s.marker === 'kept' && /listing-search/.test(s.focus || '') && s.hash.includes('q=' + encodeURIComponent(q)),
      evidence: `typed ${j(q)}: count=${j(s.count)} (model says ${want}), ${s.rows} rows, page marker=${j(s.marker)}, `
        + `focus=${j(s.focus)}, hash=${j(s.hash)}`,
    };
  });

  // kind, status and under, through the real <select>s (value + change, as the
  // README says), combined with an empty query.
  const kinds = [...new Set(all.map((o) => o.kind))];
  const kind = kinds.sort((a, b) => all.filter((o) => o.kind === b).length - all.filter((o) => o.kind === a).length)[0];
  const tops = M.topLevel(m, f.kind).filter((o) => M.childrenOf(f.order, o.id).length > 0);
  const under = tops.map((o) => o.id).find((id) => M.filterListing(m, all, { kind, status: 'unproved', under: id, order: f.order }).length > 0)
    || (tops[0] && tops[0].id);
  const filters = { kind, status: 'unproved', under };
  await check(d, 'search/listing-filters-combine', async () => {
    await d.js(`var e = document.querySelector('.listing-search'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(500);
    const setSel = async (i, v) => d.js(`
      var s = document.querySelectorAll('.listing-filters select')[${i}];
      s.value = ${j(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value;`);
    const got = [await setSel(0, kind), await setSel(1, 'unproved'), await setSel(2, under || '')];
    await sleep(400);
    const s = await d.js(LISTING_STATE);
    const want = M.filterListing(m, all, { ...filters, order: f.order }).length;
    const p = new URLSearchParams(s.hash.split('?')[1] || '');
    return {
      ok: s.count === `${want} of ${all.length} objects` && s.rows === Math.min(want, 300) && s.marker === 'kept'
        && p.get('kind') === kind && p.get('status') === 'unproved' && p.get('under') === under && !p.get('q'),
      evidence: `kind=${j(kind)} status=unproved under=${j(under)} (selects took ${j(got)}): count=${j(s.count)} `
        + `(model says ${want}), ${s.rows} rows, marker=${j(s.marker)}, hash=${j(s.hash)}`,
    };
  });

  await check(d, 'search/listing-link-survives-a-reload', async () => {
    const before = await d.js(LISTING_STATE);
    await d.reload();
    await waitFor(d, `return !!document.querySelector('.listing-filters')`, { timeout: 60000, label: 'listing after reload' });
    await sleep(600);
    await d.installHooks();
    const s = await d.js(LISTING_STATE);
    return {
      ok: s.count === before.count && s.rows === before.rows && j(s.selects) === j(before.selects) && s.hash === before.hash,
      evidence: `reloaded ${j(before.hash)}: count ${j(before.count)} -> ${j(s.count)}, selects ${j(before.selects)} -> ${j(s.selects)}`,
    };
  });

  await check(d, 'search/listing-show-all-over-filtered-rows', async () => {
    // Only the kind filter, so that there are more than 300 rows if anything does.
    await route(d, '#/progress?kind=' + encodeURIComponent(kind));
    await waitFor(d, `return !!document.querySelector('.listing-filters')`, { timeout: 30000, label: 'listing' });
    await sleep(500);
    const want = M.filterListing(m, all, { kind }).length;
    const before = await d.js(LISTING_STATE);
    if (want <= 300) {
      return { ok: before.rows === want && before.more === null, skip: true,
        evidence: `only ${want} ${kind} objects: no Show all to press (rows=${before.rows}, button=${j(before.more)})` };
    }
    const b = await d.js(elBoxByText('.page button', 'Show all'));
    await d.click(b.x, b.y);
    await sleep(1500);
    const s = await d.js(LISTING_STATE);
    return {
      ok: before.rows === 300 && before.more === `Show all ${want}` && s.rows === want,
      evidence: `kind=${j(kind)}: ${before.rows} rows and ${j(before.more)} -> ${s.rows} rows (model says ${want})`,
    };
  });

  await check(d, 'search/listing-clear', async () => {
    const b = await d.js(elBoxByText('.listing-filters button', 'Clear'));
    await d.click(b.x, b.y);
    await sleep(500);
    const s = await d.js(LISTING_STATE);
    return {
      ok: s.count === `${all.length} objects` && s.rows === Math.min(300, all.length) && s.hash === '#/progress'
        && s.selects.every((v) => v === '') && s.q === '',
      evidence: `count=${j(s.count)}, ${s.rows} rows, selects=${j(s.selects)}, hash=${j(s.hash)}`,
    };
  });

  await d.shot(`${SHOTS}/${d.name}-listing.png`);

  // --- the top bar's search box ---------------------------------------------
  // Start from a page where focus is on nothing in particular.
  await route(d, '#/checks');
  await sleep(700);
  await d.js(`if (document.activeElement) document.activeElement.blur(); return true;`);

  await check(d, 'search/global-slash-focuses-the-box', async () => {
    await d.key('/');
    await sleep(200);
    const s = await d.js(GSEARCH_STATE);
    return { ok: s.focused && s.value === '', evidence: `after "/": focused=${s.focused}, value=${j(s.value)} (the slash must not be typed)` };
  });

  const target = f.withFacts ? m.byId.get(f.withFacts) : all[0];
  await check(d, 'search/global-finds-an-object-by-id', async () => {
    if (!target) return { skip: true, evidence: 'no object to look for' };
    await d.type(target.id);
    await sleep(700);
    const s = await d.js(GSEARCH_STATE);
    const hrefs = s.items.map((x) => x.href);
    const bare = hrefs.map((h) => decodeURIComponent(h.replace('#/object/', ''))).filter((id) => {
      const o = m.byId.get(id); return o && bareSugar(o);
    });
    const inView = s.box.left >= 0 && s.box.right <= s.vw && s.box.bottom <= s.vh;
    return {
      ok: s.open && hrefs[0] === objHref(target.id) && s.items[0].active && s.expanded === 'true'
        && bare.length === 0 && inView && s.firstOnTop === true,
      evidence: `typed ${j(target.id)}: open=${s.open}, ${s.items.length} results, first=${j(hrefs[0])} active=${s.items[0] && s.items[0].active}, `
        + `bare sugar edges listed=${bare.length}, foot=${j(s.foot)}, panel ${Math.round(s.box.left)}..${Math.round(s.box.right)} x `
        + `${Math.round(s.box.top)}..${Math.round(s.box.bottom)} in ${s.vw}x${s.vh}, first item on top=${s.firstOnTop}`,
    };
  });

  await check(d, 'search/global-arrows-and-enter', async () => {
    const s0 = await d.js(GSEARCH_STATE);
    if (s0.items.length < 2) return { skip: true, evidence: `only ${s0.items.length} result(s) to move between` };
    await d.key('ArrowDown');
    await sleep(100);
    const s1 = await d.js(GSEARCH_STATE);
    await d.key('ArrowUp');
    await d.key('ArrowUp');
    await sleep(100);
    const s2 = await d.js(GSEARCH_STATE);
    const last = s2.items.length - 1;
    await d.key('Enter');
    await sleep(900);
    const s3 = await d.js(GSEARCH_STATE);
    const want = s2.items[last].href;
    return {
      ok: s1.items[1].active && s1.descendant === 'gsearch-opt-1' && s2.items[last].active
        && s3.hash === want && !s3.open && s3.value === '' && !!s3.h1,
      evidence: `down -> active ${s1.items.findIndex((x) => x.active)} (${j(s1.descendant)}); up, up -> ${s2.items.findIndex((x) => x.active)} of ${s2.items.length}; `
        + `Enter -> hash=${j(s3.hash)} (want ${j(want)}), open=${s3.open}, box=${j(s3.value)}, h1=${j(s3.h1)}`,
    };
  });

  const lean = f.withFacts ? M.leanNamesOf(m.byId.get(f.withFacts))[0] : null;
  await check(d, 'search/global-finds-a-lean-name', async () => {
    if (!lean) return { skip: true, evidence: 'no object with a Lean name' };
    await typeInto(d, '#gsearch-input', lean);
    await sleep(700);
    const s = await d.js(GSEARCH_STATE);
    const mine = s.items.find((x) => x.href === objHref(f.withFacts));
    return {
      ok: s.open && !!mine && !!mine.lean && mine.lean.includes(lean),
      evidence: `typed ${j(lean)}: ${s.items.length} results, ${j(f.withFacts)} listed=${!!mine} with Lean line ${j(mine && mine.lean)}`,
    };
  });

  await check(d, 'search/global-escape-then-click', async () => {
    await d.key('Escape');
    await sleep(150);
    const s1 = await d.js(GSEARCH_STATE);
    // ArrowDown reopens the list; a real click on a result follows it.
    await d.key('ArrowDown');
    await sleep(300);
    const s2 = await d.js(GSEARCH_STATE);
    const pick = s2.items[Math.min(1, s2.items.length - 1)];
    if (!pick) return { ok: false, evidence: 'no results to click' };
    const box = await d.js(elBox(`#gsearch-results .gsearch-item[href="${pick.href}"]`));
    await d.click(box.x, box.y);
    await sleep(900);
    const s3 = await d.js(GSEARCH_STATE);
    return {
      ok: !s1.open && s1.value === lean && s2.open && s3.hash === pick.href && !s3.open && s3.value === '',
      evidence: `Escape: open=${s1.open}, value kept=${j(s1.value)}; ArrowDown: open=${s2.open}; clicked ${j(pick.href)} -> hash=${j(s3.hash)}, open=${s3.open}`,
    };
  });

  await check(d, 'search/global-closes-on-navigation', async () => {
    await typeInto(d, '#gsearch-input', target ? target.id : 'e');
    await sleep(700);
    const s1 = await d.js(GSEARCH_STATE);
    await d.back();
    await sleep(900);
    const s2 = await d.js(GSEARCH_STATE);
    return { ok: s1.open && !s2.open, evidence: `open=${s1.open}, then back to ${j(s2.hash)}: open=${s2.open}` };
  });

  await d.js(`var e = document.getElementById('gsearch-input'); e.value = ''; e.blur(); return true;`);
  await consoleCheck(d, 'search');
}

// ---------------------------------------------------------------------------
// 5. checks page
// ---------------------------------------------------------------------------

async function checksChecks(d, f) {
  await route(d, '#/checks');
  await waitFor(d, `return document.querySelectorAll('.check').length > 0 || !!document.querySelector('.page p.muted')`, { timeout: 40000, label: 'checks page' });
  await sleep(400);

  await check(d, 'checks/initial-render', async () => {
    const s = await d.js(`
      return { cards: document.querySelectorAll('.check').length,
               rows: document.querySelectorAll('.filter-row').length,
               chips: document.querySelectorAll('.filter-row button').length,
               h2: Array.prototype.map.call(document.querySelectorAll('.page h2'), function (h) { return h.textContent; }) };
    `);
    return { ok: s.cards === f.nChecks && s.rows === 2, evidence: `${s.cards} .check cards (model says ${f.nChecks}), ${s.chips} filter chips, groups=${j(s.h2)}` };
  });

  await check(d, 'checks/level-filter', async () => {
    const lv = f.checkLevels.includes('error') ? 'error' : f.checkLevels[0];
    const b = await d.js(elBoxByText('.filter-row button', lv + ' ('));
    if (!b) return { ok: false, evidence: `no chip for level ${lv}` };
    await d.click(b.x, b.y);
    await sleep(800);
    const s = await d.js(`
      var cards = document.querySelectorAll('.check');
      var levels = {};
      for (var i = 0; i < cards.length; i++) { var m = cards[i].className.match(/level-(\\w+)/); levels[m[1]] = (levels[m[1]] || 0) + 1; }
      return { n: cards.length, levels: levels, hash: location.hash,
               active: (document.querySelector('.filter-row button.active') || {}).textContent };
    `);
    const expect = f.m.checks.filter((c) => c.level === lv).length;
    await d.js(`location.hash = '#/checks'; return true;`);
    await sleep(600);
    return {
      ok: s.n === expect && Object.keys(s.levels).length === 1 && s.levels[lv] === expect && s.hash.includes('level=' + lv),
      evidence: `clicked ${j(b.text)}: ${s.n} cards, by level=${j(s.levels)} (model says ${expect}), hash=${j(s.hash)}`,
    };
  });

  await check(d, 'checks/code-filter', async () => {
    const code = f.checkCodes[0];
    const b = await d.js(elBoxByText('.filter-row button', code + ' ('));
    if (!b) return { ok: false, evidence: `no chip for code ${code}` };
    await d.click(b.x, b.y);
    await sleep(800);
    const s = await d.js(`
      var cards = document.querySelectorAll('.check');
      var codes = {};
      for (var i = 0; i < cards.length; i++) { var c = cards[i].querySelector('.code').textContent; codes[c] = (codes[c] || 0) + 1; }
      return { n: cards.length, codes: codes, hash: location.hash };
    `);
    const expect = f.m.checks.filter((c) => c.code === code).length;
    return {
      ok: s.n === expect && Object.keys(s.codes).length === 1,
      evidence: `clicked ${j(b.text)}: ${s.n} cards, codes=${j(s.codes)} (model says ${expect}), hash=${j(s.hash)}`,
    };
  });

  await check(d, 'checks/object-links-navigate', async () => {
    const a = await d.js(`
      var a = document.querySelector('.check .objs a.objlink');
      if (!a) return null;
      var r = inView(a);
      return { href: a.getAttribute('href'), text: a.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      ${IN_VIEW}
    `);
    if (!a) return { ok: false, evidence: 'no object links on any check card' };
    await d.click(a.x, a.y);
    await sleep(700);
    const s = await d.js(OBJECT_STATE);
    return {
      ok: !!s && !s.errorBox && !!s.h1,
      evidence: `clicked ${j(a.text)} (${j(a.href)}): .obj-id=${j(s && s.objId)}, errorBox=${s && s.errorBox}`,
    };
  });

  await check(d, 'checks/unknown-object-chips-are-really-unknown', async () => {
    await route(d, '#/checks');
    await sleep(900);
    const s = await d.js(`
      return Array.prototype.slice.call(document.querySelectorAll('.check .objs .chip[title="unknown object"]'))
        .map(function (e) { return e.textContent.trim(); }).slice(0, 40);
    `);
    const wrong = s.filter((x) => f.m.byId.has(x));
    return { ok: wrong.length === 0, evidence: `${s.length} "unknown object" chips sampled; naming ids that do exist: ${wrong.length ? j(wrong) : 'none'}` };
  });

  await d.shot(`${SHOTS}/${d.name}-checks.png`);
  await consoleCheck(d, 'checks');
}

// ---------------------------------------------------------------------------
// 6. navigation
// ---------------------------------------------------------------------------

async function navChecks(d, f) {
  await check(d, 'nav/top-bar-tabs', async () => {
    const log = [];
    let ok = true;
    for (const view of ['graph', 'document', 'progress', 'checks']) {
      const a = await d.js(elBox(`#tabs a[data-view="${view}"]`));
      await d.click(a.x, a.y);
      await sleep(view === 'graph' ? 1200 : 900);
      if (view === 'graph') await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'graph after tab click' }).catch(() => {});
      const s = await d.js(`
        return { hash: location.hash, active: (document.querySelector('#tabs a.active') || {}).dataset.view,
                 mounted: !!document.querySelector('#app').firstElementChild,
                 kind: document.querySelector('.graph-page') ? 'graph' : document.querySelector('.doc-layout') ? 'document'
                     : document.querySelector('input[type=range]') ? 'progress' : document.querySelector('.filter-row') ? 'checks' : '?' };
      `);
      const good = s.hash.startsWith('#/' + view) && s.mounted;
      if (!good) ok = false;
      log.push(`${view}: hash=${s.hash} active=${s.active} shows=${s.kind}`);
    }
    return { ok, evidence: log.join(' | ') };
  });

  await check(d, 'nav/back-and-forward', async () => {
    await route(d, '#/checks');
    await sleep(700);
    await route(d, '#/progress');
    await sleep(700);
    await route(d, '#/document');
    await sleep(900);
    const trail = [];
    await d.back(); await sleep(900);
    trail.push(await d.js(`return location.hash + '/' + (document.querySelector('input[type=range]') ? 'progress-dom' : '?')`));
    await d.back(); await sleep(900);
    trail.push(await d.js(`return location.hash + '/' + (document.querySelector('.filter-row') ? 'checks-dom' : '?')`));
    await d.forward(); await sleep(900);
    trail.push(await d.js(`return location.hash + '/' + (document.querySelector('input[type=range]') ? 'progress-dom' : '?')`));
    return {
      ok: trail[0].startsWith('#/progress') && trail[1].startsWith('#/checks') && trail[2].startsWith('#/progress')
        && trail.every((t) => !t.endsWith('/?')),
      evidence: `back, back, forward -> ${j(trail)}`,
    };
  });

  await check(d, 'nav/scroll-resets-when-the-page-changes', async () => {
    // The whole document, so there are 4000px to scroll down.
    await route(d, '#/document?depth=all');
    await waitFor(d, `return document.querySelectorAll('.doc-entry').length > 0`, { timeout: 30000, label: 'document' });
    await sleep(600);
    await d.js(`window.scrollTo(0, 4000); return window.scrollY;`);
    await sleep(400);
    const deep = await d.js(`return Math.round(window.scrollY)`);
    const tab = await d.js(elBox('#tabs a[data-view="progress"]'));
    await d.click(tab.x, tab.y);
    await waitFor(d, `return document.querySelectorAll('table.grid').length > 0`, { timeout: 30000, label: 'progress' });
    await sleep(700);
    const afterTab = await d.js(`return { y: Math.round(window.scrollY), hash: location.hash, sh: document.documentElement.scrollHeight }`);

    // A query change on the page you are already on must NOT jump to the top.
    await route(d, '#/checks');
    await waitFor(d, `return document.querySelectorAll('.check').length > 0`, { timeout: 40000, label: 'checks' });
    await sleep(500);
    await d.js(`window.scrollTo(0, 3000); return window.scrollY;`);
    await sleep(300);
    await route(d, '#/checks?level=warning');
    await sleep(1200);
    const afterFilter = await d.js(`return Math.round(window.scrollY)`);
    return {
      ok: deep > 1000 && afterTab.y === 0 && afterFilter > 0,
      evidence: `document scrolled to ${deep}px, then the Progress tab -> scrollY=${afterTab.y} (page ${afterTab.sh}px tall); a checks filter at 3000px kept scrollY=${afterFilter}`,
    };
  });

  await check(d, 'nav/unknown-route-falls-back-to-graph', async () => {
    await route(d, '#/not-a-view');
    await sleep(1200);
    await waitFor(d, GRAPH_IDLE, { timeout: 90000, interval: 200, label: 'graph for unknown route' });
    const s = await d.js(`return { hash: location.hash, graph: !!document.querySelector('.graph-page'), nodes: document.querySelectorAll('.gnode').length };`);
    return { ok: s.graph && s.nodes > 0, evidence: `hash=${j(s.hash)} renders the graph page with ${s.nodes} nodes` };
  });

  await consoleCheck(d, 'nav');
}

// ---------------------------------------------------------------------------
// 7. the sample snapshot: junctions and multi-parent objects
// ---------------------------------------------------------------------------

async function sampleChecks(d) {
  const url = ORIGIN + '/sample/blueprint.json';
  const probe = await fetch(url).then((r) => r.ok, () => false);
  if (!probe) {
    record(d.name, 'sample/junction-nodes', true, `no ${url} on this deployment: junction and multi-parent objects untested`, true);
    return;
  }
  const snap = await (await fetch(url)).json();
  const m = M.buildModel(snap);
  const kind = m.defaultCollapse;
  const order = M.collapseOrder(m, kind);
  const twoParents = m.objects.find((o) => M.parentsOf(order, o.id).length >= 2);

  await d.open(`${ORIGIN}/?data=./sample/blueprint.json#/graph`);
  await d.installHooks();
  await waitFor(d, GRAPH_IDLE, { timeout: 60000, label: 'sample graph layout' });
  await settle();

  await check(d, 'sample/junction-nodes-hover-and-click', async () => {
    const box = await d.js(`
      var g = document.querySelector('.gnode.junction');
      if (!g) return null;
      var r = g.querySelector('.junction-dot').getBoundingClientRect();
      return { id: g.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2, title: (g.querySelector('title') || {}).textContent };
    `);
    if (!box) return { ok: false, evidence: 'no .gnode.junction drawn in the sample' };
    await d.move(box.x, box.y);
    await sleep(300);
    const hovered = await d.js(`return document.querySelectorAll('.gnode.junction.hovered').length`);
    await d.click(box.x, box.y);
    await sleep(500);
    const s = await d.js(`
      return { objId: (document.querySelector('aside.side .obj-id') || {}).textContent,
               head: (document.querySelector('aside.side h2') || {}).textContent,
               boundary: document.querySelectorAll('aside.side ul.objlist li').length, hash: location.hash };
    `);
    return {
      ok: hovered > 0 && s.objId === box.id,
      evidence: `junction ${j(box.id)} title=${j((box.title || '').replace(/\n/g, ' / '))}: hovered=${hovered}, side .obj-id=${j(s.objId)}, h2=${j(s.head)}, ${s.boundary} boundary/incident rows`,
    };
  });

  await check(d, 'sample/object-with-two-parents', async () => {
    if (!twoParents) return { skip: true, evidence: 'the sample has no object with two parents either' };
    await route(d, '#/object/' + encodeURIComponent(twoParents.id));
    await sleep(600);
    const s = await d.js(`
      return { h4: Array.prototype.map.call(document.querySelectorAll('.panel h4'), function (h) { return h.textContent; }),
               chains: document.querySelectorAll('.panel .chain').length,
               objId: (document.querySelector('.page > .obj-id') || {}).textContent };
    `);
    return {
      ok: s.objId === twoParents.id && s.chains >= 2 && s.h4.some((x) => /several branches/.test(x)),
      evidence: `${j(twoParents.id)}: ${s.chains} .chain rows, h4=${j(s.h4)}`,
    };
  });

  // The sample's titles carry maths in a leaf, in a long wrapped title, with
  // \( \) delimiters, and in a section header, so expand everything.
  await check(d, 'sample/math-titles-render-and-fit-their-nodes', async () => {
    await gotoGraph(d, 'expand=' + [...order.expandable].map(encodeURIComponent).join(','));
    await settle();
    return mathTitles(d, './sample/blueprint.json');
  });

  await d.shot(`${SHOTS}/${d.name}-sample-graph.png`);
  await consoleCheck(d, 'sample');

  // back to the real deployment for anything that follows
  await d.open(`${ORIGIN}/#/graph`);
  await d.installHooks();
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function runBrowser(name, f) {
  const d = name === 'firefox'
    ? await firefox({ width: WIDTH, height: HEIGHT, launch: LAUNCH, ...(GECKO_PORT ? { port: GECKO_PORT } : {}) })
    : await chromium({ width: WIDTH, height: HEIGHT, launch: LAUNCH, ...(CDP_PORT ? { port: CDP_PORT } : {}) });
  try {
    await d.open(`${ORIGIN}/#/checks`);
    // Past index.html's own "Loading blueprint…" placeholder: a large
    // snapshot takes long enough to arrive that the boot check otherwise ran
    // before the data, and the deferred CDN scripts, were there.
    await waitFor(d, `var a = document.querySelector('#app'); return !!a.firstElementChild && !a.querySelector('.loading');`, { timeout: 60000, label: 'first paint' });
    const hooked = await d.installHooks();
    if (SECTIONS.has('boot')) await check(d, 'boot/loads-the-snapshot', async () => {
      const s = await d.js(`
        return { title: document.title, brand: document.getElementById('project-title').textContent,
                 aside: document.getElementById('topbar-aside').textContent.trim(),
                 errorBox: !!document.querySelector('.error-box h1'),
                 katex: typeof window.katex, render: typeof window.renderMathInElement,
                 marked: !!window.marked, elk: typeof window.ELK,
                 viewport: [window.innerWidth, window.innerHeight] };
      `);
      return {
        ok: !s.errorBox && s.marked && s.katex === 'object' && s.render === 'function' && s.elk === 'function',
        evidence: `title=${j(s.title)} brand=${j(s.brand)} topbar=${j(s.aside)}; CDN: katex=${s.katex} autorender=${s.render} marked=${s.marked} ELK=${s.elk}; viewport=${j(s.viewport)}; recorder=${hooked}`,
      };
    });

    if (SECTIONS.has('graph')) await graphChecks(d, f);
    if (SECTIONS.has('layout')) await layoutChecks(d, f);
    if (SECTIONS.has('object')) await objectChecks(d, f);
    if (SECTIONS.has('document')) await documentChecks(d, f);
    if (SECTIONS.has('references')) await referenceChecks(d, f);
    if (SECTIONS.has('progress')) await progressChecks(d, f);
    if (SECTIONS.has('search')) await searchChecks(d, f);
    if (SECTIONS.has('checks')) await checksChecks(d, f);
    if (SECTIONS.has('nav')) await navChecks(d, f);
    if (SECTIONS.has('sample')) await sampleChecks(d);
  } finally {
    await d.close();
  }
}

async function main() {
  console.log(`# blueprint browser sweep\n# origin   ${ORIGIN}\n# browsers ${BROWSERS.join(', ')}\n# viewport ${WIDTH}x${HEIGHT}\n# shots    ${SHOTS}\n`);
  const f = await loadFixtures(ORIGIN);
  console.log(`# snapshot ${f.m.objects.length} objects, collapse kind ${j(f.kind)}, ${f.nChecks} checks`);
  console.log(`# fixtures ${j({
    withFacts: f.withFacts, withoutFacts: f.withoutFacts, section: f.section, sugar: f.sugar,
    twoParents: f.twoParents, katex: f.katex, slug: f.slug, bench: f.bench,
    chapter: f.chapter, deepLeaf: f.deepLeaf, deepLeafPage: f.deepLeafPage, midFocus: f.midFocus,
    ref: f.ref, refFar: f.refFar, refNear: f.refNear, brokenRef: f.brokenRef, panel: f.panel,
    defaultNodeCount: f.defaultNodeCount,
  })}\n`);

  for (const b of BROWSERS) {
    console.log(`\n=== ${b} ===\n`);
    try {
      await runBrowser(b, f);
    } catch (e) {
      record(b, 'runner', false, 'the run itself threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' < ') : e));
    }
  }

  const fails = results.filter((r) => !r.ok && !r.skipped);
  const skips = results.filter((r) => r.skipped);
  console.log(`\n=== summary ===`);
  for (const b of BROWSERS) {
    const mine = results.filter((r) => r.browser === b);
    console.log(`${b}: ${mine.filter((r) => r.ok && !r.skipped).length} pass, ${mine.filter((r) => !r.ok).length} fail, ${mine.filter((r) => r.skipped).length} skip`);
  }
  if (fails.length) {
    console.log('\nfailures:');
    for (const r of fails) console.log(`  [${r.browser}] ${r.id}\n      ${r.evidence}`);
  }
  if (skips.length && VERBOSE) {
    console.log('\nskipped:');
    for (const r of skips) console.log(`  [${r.browser}] ${r.id}: ${r.evidence}`);
  }
  writeFileSync(`${SHOTS}/sweep-results.json`, JSON.stringify(results, null, 1));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
