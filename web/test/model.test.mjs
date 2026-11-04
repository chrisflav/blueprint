// web/test/model.test.mjs
//
// Unit tests for the pure logic in ../model.js against ../sample/blueprint.json.
//
//   nix-shell -p nodejs_22 --run "node web/test/model.test.mjs"
//
// No dependencies, no DOM, no network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'sample', 'blueprint.json'), 'utf8'),
);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sameSet(actual, expected, what) {
  const a = [...actual].sort();
  const b = [...expected].sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    const missing = b.filter((x) => !a.includes(x));
    const extra = a.filter((x) => !b.includes(x));
    throw new Error(
      `${what || 'set'} mismatch\n    missing: ${JSON.stringify(missing)}\n    extra:   ${JSON.stringify(extra)}`,
    );
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected true');
}

function has(collection, x, what) {
  const arr = [...collection];
  if (!arr.includes(x)) throw new Error(`${what || 'collection'} should contain ${JSON.stringify(x)}`);
}

function hasNot(collection, x, what) {
  const arr = [...collection];
  if (arr.includes(x)) throw new Error(`${what || 'collection'} should not contain ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------

const model = M.buildModel(snapshot);
const TYCH_ULTRA = 'uses/thm-tychonoff/lem-ultrafilter';
const PROOF = 'proof/thm-heine-borel';
const COMMUTES =
  'commutes/uses~thm-heine-borel~thm-tychonoff/uses~thm-tychonoff~def-compact/uses~thm-heine-borel~def-compact';
const GENERALISES =
  'generalises/uses~lem-finite-subcover~def-compact/uses~thm-tychonoff~def-compact';

const itemById = (q, id) => q.items.find((it) => it.id === id);
const edgeFor = (q, src, tgt, kind) =>
  q.edges.find((e) => e.type === 'edge' && e.directed && e.src === src && e.tgt === tgt && e.kind === kind);
const junctionFor = (q, id) => q.edges.find((e) => e.type === 'junction' && e.members[0].id === id);
const stateOf = (q, s, t, kind) => {
  const rec = q.consistency.get(M.pairKey(s, t, kind));
  return rec ? rec.state : null;
};

// --- indexing --------------------------------------------------------------

check('snapshot loads and indexes', () => {
  eq(snapshot.version, 1, 'version');
  eq(model.objects.length, 55, 'object count');
  eq(model.byId.size, 55, 'byId size');
  eq(model.defaultCollapse, 'refines', 'defaultCollapse');
  sameSet(model.collapseKinds, ['refines', 'instance_of'], 'collapse kinds');
});

check('boundaries all resolve', () => {
  for (const o of model.objects) {
    for (const b of o.boundary) {
      if (!model.byId.has(b.id)) throw new Error(`${o.id} has dangling boundary ${b.id}`);
    }
  }
});

check('depth matches the boundary recursion', () => {
  const depth = (id) => {
    const o = model.byId.get(id);
    if (!o.boundary.length) return 0;
    return 1 + Math.max(...o.boundary.map((b) => depth(b.id)));
  };
  for (const o of model.objects) eq(depth(o.id), o.depth, `depth of ${o.id}`);
  eq(model.byId.get(GENERALISES).depth, 2, 'generalises is an edge between edges');
  eq(model.byId.get(COMMUTES).depth, 2, 'commutes is a hyperedge over edges');
});

check('incidence finds the objects that use one as a boundary', () => {
  const inc = M.incidentTo(model, TYCH_ULTRA).map((r) => r.object.id);
  has(inc, 'refines/lem-base-case/uses~thm-tychonoff~lem-ultrafilter', 'incidence of the prose edge');
  has(inc, 'refines/lem-inductive-step/uses~thm-tychonoff~lem-ultrafilter', 'incidence');
  has(inc, 'refines/lem-limit-point/uses~thm-tychonoff~lem-ultrafilter', 'incidence');
  eq(inc.length, 3, 'the prose edge is refined by exactly three lemmas');

  const incUses = M.incidentTo(model, 'uses/thm-tychonoff/def-compact').map((r) => r.object.id);
  sameSet(incUses, [GENERALISES, COMMUTES], 'an edge incident to an edge and a hyperedge');
});

check('kind predicates', () => {
  eq(M.isBinaryKind(model, 'uses'), true, 'uses is binary');
  eq(M.isBinaryKind(model, 'commutes'), false, 'commutes is not binary');
  eq(M.isBinaryKind(model, 'theorem'), false, 'theorem is a node kind');
  sameSet(M.nodeKinds(model), ['section', 'definition', 'theorem', 'lemma'], 'node kinds');
});

// --- collapse order --------------------------------------------------------

const order = M.collapseOrder(model, 'refines');

check('collapse order: parents and children', () => {
  sameSet(M.parentsOf(order, 'lem-diagonal'), ['sec-main-induction', 'sec-applications'], 'two parents');
  sameSet(M.parentsOf(order, 'lem-base-case'), [TYCH_ULTRA], 'a node refining an edge');
  sameSet(
    M.childrenOf(order, TYCH_ULTRA),
    ['lem-base-case', 'lem-inductive-step', 'lem-limit-point'],
    'an edge with three children',
  );
  sameSet(
    M.childrenOf(order, 'sec-foundations'),
    ['def-compact', 'def-filter', 'def-net', 'def-metric', 'lem-ultrafilter'],
    'children of sec-foundations',
  );
  sameSet(
    order.expandable,
    ['sec-foundations', 'sec-main', 'sec-main-induction', 'sec-applications', TYCH_ULTRA],
    'expandable objects',
  );
});

check('collapse order: ancestors and descendants', () => {
  sameSet(M.ancestorsOf(order, 'lem-finite-subcover'), ['sec-main-induction', 'sec-main'], 'ancestors');
  sameSet(
    M.descendantsOf(order, 'sec-main'),
    ['sec-main-induction', 'thm-tychonoff', 'lem-finite-subcover', 'lem-diagonal'],
    'descendants of sec-main',
  );
  const chains = M.ancestorChains(order, 'lem-diagonal');
  eq(chains.length, 2, 'lem-diagonal sits under two chains');
  sameSet(chains.map((c) => c.join('>')), ['sec-main>sec-main-induction', 'sec-applications'], 'chains');
});

// --- views -----------------------------------------------------------------

check('fully collapsed view: visible set is exactly the K-roots', () => {
  const view = M.makeView(model, 'refines', []);
  eq(view.expanded.size, 0, 'nothing expanded');
  sameSet(view.visible, order.roots, 'visible = roots');
  // Sections are visible, their contents are not.
  has(view.visible, 'sec-foundations', 'visible');
  hasNot(view.visible, 'def-compact', 'visible');
  // The prose edge is a K-root, so it is visible even fully collapsed.
  has(view.visible, TYCH_ULTRA, 'visible');
  hasNot(view.visible, 'lem-base-case', 'visible');
  sameSet(view.rep('def-compact'), ['sec-foundations'], 'rep of a collapsed node');
  sameSet(view.rep('lem-base-case'), [TYCH_ULTRA], 'rep of a node refining an edge');
  sameSet(view.rep('lem-diagonal'), ['sec-main', 'sec-applications'], 'rep is not a singleton');
  // ... and rep of a multi-parent object walks all the way up.
  sameSet(view.rep('lem-finite-subcover'), ['sec-main'], 'rep via one branch');
});

check('expanding is upward closed and collapsing removes the subtree', () => {
  const v0 = M.makeView(model, 'refines', []);
  // Expanding a nested section pulls its parent in.
  const v1 = v0.expand('sec-main-induction');
  sameSet(v1.expanded, ['sec-main', 'sec-main-induction'], 'upward closure on expand');
  has(v1.visible, 'lem-finite-subcover', 'grandchild visible');
  has(v1.visible, 'thm-tychonoff', 'sibling visible');
  hasNot(v1.visible, 'sec-main', 'expanded objects are not visible');
  hasNot(v1.visible, 'sec-main-induction', 'expanded objects are not visible');

  // Collapsing the top removes the whole subtree from X again.
  const v2 = v1.collapse('sec-main');
  eq(v2.expanded.size, 0, 'collapse removes descendants too');
  sameSet(v2.visible, v0.visible, 'back to the fully collapsed view');

  // Expanding a leaf is a no-op.
  sameSet(v0.expand('def-compact').expanded, [], 'leaves are not expandable');
});

check('expandAll / collapseAll', () => {
  const all = M.makeView(model, 'refines', []).expandAll();
  sameSet(all.expanded, order.expandable, 'expandAll expands everything expandable');
  hasNot(all.visible, 'sec-main', 'containers are not visible');
  has(all.visible, 'lem-base-case', 'leaves are visible');
  has(all.visible, 'thm-tychonoff', 'leaves are visible');
  // A proof is a root too, but it stands for its statement (DESIGN 3).
  for (const id of all.visible) {
    if (M.attachedTo(model.byId.get(id))) continue;
    sameSet(all.rep(id), [id], `rep of visible ${id}`);
  }
  eq(all.collapseAll().expanded.size, 0, 'collapseAll');
});

check('rep of an expanded root is empty', () => {
  const v = M.makeView(model, 'refines', ['sec-main']);
  eq(v.rep('sec-main').size, 0, 'an expanded container represents nothing');
});

// --- quotient: fully collapsed --------------------------------------------

const vCollapsed = M.makeView(model, 'refines', []);
const qCollapsed = M.quotient(vCollapsed);

check('collapsed quotient: internal edges are hidden', () => {
  // Three uses edges live entirely inside sec-foundations.
  sameSet(
    qCollapsed.internal.get('sec-foundations') || [],
    ['uses/lem-ultrafilter/def-filter', 'uses/lem-ultrafilter/def-compact', 'uses/def-net/def-filter'],
    'edges internal to sec-foundations',
  );
  // The only other container with something inside is sec-applications,
  // where Heine-Borel's proof sits with its statement.
  eq(qCollapsed.internal.size, 2, 'no other container has internal objects here');
  sameSet(qCollapsed.internal.get('sec-applications') || [], [PROOF], 'the proof inside its statement\'s section');
  for (const id of ['uses/lem-ultrafilter/def-filter', 'uses/def-net/def-filter']) {
    eq(itemById(qCollapsed, id), undefined, `${id} must not be drawn`);
  }
  eq(qCollapsed.dropped.length, 0, 'nothing is dropped in the fully collapsed view');
});

check('collapsed quotient: refines edges never draw themselves', () => {
  for (const it of qCollapsed.items) {
    if (it.kind === 'refines') throw new Error(`refines edge ${it.id} leaked into the quotient`);
  }
});

check('collapsed quotient: a lemma inside a section still produces a section edge', () => {
  // thm-tychonoff -> lem-ultrafilter quotients to sec-main -> sec-foundations.
  const it = itemById(qCollapsed, TYCH_ULTRA);
  sameSet(it.ends.map((e) => e.id), ['sec-main', 'sec-foundations'], 'ends of the prose edge');
  eq(it.ends.find((e) => e.id === 'sec-main').roles.join(), 'src', 'src role');
  eq(it.ends.find((e) => e.id === 'sec-foundations').roles.join(), 'tgt', 'tgt role');
});

check('collapsed quotient: junctions', () => {
  // An edge that carries another object must become a junction node.
  eq(itemById(qCollapsed, TYCH_ULTRA).junction, true, 'refined-by-lemmas edge is a junction');
  eq(itemById(qCollapsed, 'uses/thm-tychonoff/def-compact').junction, true, 'end of commutes+generalises');
  eq(itemById(qCollapsed, 'uses/lem-finite-subcover/def-compact').junction, true, 'end of generalises');
  eq(itemById(qCollapsed, 'uses/thm-heine-borel/thm-tychonoff').junction, true, 'end of commutes');
  eq(itemById(qCollapsed, 'uses/thm-heine-borel/def-compact').junction, true, 'end of commutes');
  // A hyperedge over three edges is a junction with three ends.
  const c = itemById(qCollapsed, COMMUTES);
  eq(c.ends.length, 3, 'commutes has three ends');
  eq(c.junction, true, 'commutes is a junction');
  sameSet(
    c.ends.map((e) => e.id),
    [
      'uses/thm-heine-borel/thm-tychonoff',
      'uses/thm-tychonoff/def-compact',
      'uses/thm-heine-borel/def-compact',
    ],
    'commutes ends are the three uses edges themselves',
  );
  // A plain quotiented arc is not a junction.
  eq(itemById(qCollapsed, 'uses/thm-heine-borel/def-metric').junction, false, 'plain arc');
  // An object with a non-singleton rep on both sides cannot be a plain arc.
  const diag = itemById(qCollapsed, 'uses/lem-diagonal/lem-finite-subcover');
  eq(diag.junction, true, 'multi-parent source forces a junction');
  sameSet(diag.ends.find((e) => e.id === 'sec-main').roles, ['src', 'tgt'], 'src and tgt coincide');
});

check('collapsed quotient: an edge between two edges is drawn between them', () => {
  const g = itemById(qCollapsed, GENERALISES);
  eq(g.junction, false, 'generalises is a plain arc');
  sameSet(
    g.ends.map((e) => e.id),
    ['uses/lem-finite-subcover/def-compact', 'uses/thm-tychonoff/def-compact'],
    'ends of generalises are two uses edges',
  );
});

check('collapsed quotient: consistency states (DESIGN 3 table)', () => {
  eq(stateOf(qCollapsed, 'sec-main', 'sec-foundations', 'uses'), 'both', 'declared and derived');
  eq(stateOf(qCollapsed, 'sec-applications', 'sec-main', 'uses'), 'both', 'declared and derived');
  eq(stateOf(qCollapsed, 'sec-main', 'sec-applications', 'uses'), 'declared-only', 'planned, unwitnessed');
  eq(stateOf(qCollapsed, 'sec-applications', 'sec-foundations', 'uses'), 'derived-only', 'undeclared detail');
  eq(stateOf(qCollapsed, 'sec-foundations', 'sec-main', 'uses'), null, 'no such relation');

  const both = qCollapsed.consistency.get(M.pairKey('sec-main', 'sec-foundations', 'uses'));
  sameSet(both.declared, ['uses/sec-main/sec-foundations'], 'the coarse declaration');
  sameSet(
    both.derived,
    [TYCH_ULTRA, 'uses/thm-tychonoff/def-compact', 'uses/lem-finite-subcover/def-compact'],
    'three finer witnesses',
  );
  eq(both.elaborable, true, 'sections can be elaborated');

  const undeclared = qCollapsed.consistency.get(
    M.pairKey('sec-applications', 'sec-foundations', 'uses'),
  );
  sameSet(
    undeclared.derived,
    [
      'uses/thm-heine-borel/def-compact',
      'uses/thm-heine-borel/def-metric',
      'uses/thm-stone-cech/lem-ultrafilter',
    ],
    'witnesses of the undeclared section edge',
  );
  eq(undeclared.declared.length, 0, 'nothing declares it');
});

check('collapsed quotient: the lint list agrees with the computed states', () => {
  // The website no longer reads the checks; the snapshot still has them.
  const checks = snapshot.derived.checks;
  const codes = checks.map((c) => c.code);
  has(codes, 'undeclared-edge', 'check codes');
  has(codes, 'unwitnessed-edge', 'check codes');
  // unwitnessed-edge names the declared-only pair
  const unwitnessed = checks.find((c) => c.code === 'unwitnessed-edge');
  has(unwitnessed.objects, 'uses/sec-main/sec-applications', 'unwitnessed check objects');
  eq(stateOf(qCollapsed, 'sec-main', 'sec-applications', 'uses'), 'declared-only', 'agrees');
});

check('collapsed quotient: grouped drawing list', () => {
  // The two undeclared witnesses that are plain arcs share one grouped edge.
  const g = edgeFor(qCollapsed, 'sec-applications', 'sec-foundations', 'uses');
  eq(g.state, 'derived-only', 'grouped state');
  sameSet(
    g.members.map((m) => m.id),
    ['uses/thm-heine-borel/def-metric', 'uses/thm-stone-cech/lem-ultrafilter'],
    'grouped members (the third witness is a junction)',
  );
  eq(g.synthetic, false, 'real members');
  // Junction items get their own entry.
  if (!junctionFor(qCollapsed, COMMUTES)) throw new Error('commutes junction entry missing');
  // Every drawn end refers to a visible object.
  for (const e of qCollapsed.edges) {
    const ends = e.type === 'junction' ? e.ends.map((x) => x.id) : [e.src, e.tgt];
    for (const id of ends) {
      if (!vCollapsed.visible.has(id)) throw new Error(`edge ${e.id} attaches to invisible ${id}`);
    }
  }
});

// --- quotient: expanding the prose edge ------------------------------------

const vEdge = M.makeView(model, 'refines', [TYCH_ULTRA]);
const qEdge = M.quotient(vEdge);

check('expanding an edge object replaces it by its three lemmas', () => {
  hasNot(vEdge.visible, TYCH_ULTRA, 'the edge itself is expanded away');
  for (const l of ['lem-base-case', 'lem-inductive-step', 'lem-limit-point']) {
    has(vEdge.visible, l, 'lemma visible');
  }
  // The edge is now hidden, so its arc becomes a derived witness of the
  // sec-main -> sec-foundations relation, which is also declared: both.
  const it = itemById(qEdge, TYCH_ULTRA);
  eq(it.visible, false, 'the edge object is no longer visible');
  eq(it.junction, false, 'and nothing hangs off it any more');
  eq(it.state, 'both', 'consistent with the declared section edge');
  const g = edgeFor(qEdge, 'sec-main', 'sec-foundations', 'uses');
  eq(g.members.length, 2, 'declared coarse edge plus the quotiented prose edge share one arc');
  // Its children now have their own arcs out of the (still collapsed) sections.
  eq(stateOf(qEdge, 'lem-base-case', 'sec-foundations', 'uses'), 'derived-only', 'child arc');
  eq(stateOf(qEdge, 'lem-limit-point', 'sec-foundations', 'uses'), 'derived-only', 'child arc');
});

// --- quotient: two sections expanded, synthetic arcs ------------------------

const vTwo = M.makeView(model, 'refines', ['sec-main', 'sec-applications']);
const qTwo = M.quotient(vTwo);

check('expanded containers drop edges whose ends both vanish', () => {
  has(qTwo.dropped, 'uses/sec-main/sec-applications', 'both ends expanded');
  has(qTwo.dropped, 'uses/sec-applications/sec-main', 'both ends expanded');
  eq(itemById(qTwo, 'uses/sec-main/sec-applications'), undefined, 'not drawn');
});

check('derived-only relations carried by junctions get a synthetic dashed arc', () => {
  const synth = qTwo.edges.filter((e) => e.synthetic);
  sameSet(
    synth.map((e) => `${e.src}->${e.tgt}`),
    ['thm-tychonoff->sec-foundations', 'sec-main-induction->sec-foundations'],
    'synthetic arcs',
  );
  for (const e of synth) {
    eq(e.state, 'derived-only', 'synthetic arcs are always derived-only');
    eq(e.members.length, 0, 'synthetic arcs have no own object');
    // and the relation really is present in the consistency table
    if (!qTwo.consistency.get(M.pairKey(e.src, e.tgt, e.kind))) {
      throw new Error('synthetic arc without a consistency record');
    }
  }
  // The witnesses are junction items, which is why no grouped arc covered them.
  eq(itemById(qTwo, 'uses/thm-tychonoff/def-compact').junction, true, 'witness is a junction');
});

// --- own arcs: a collapsed object draws its own, not its contents' ----------

const ownArcs = (q) => M.ownEdges(q.view, q.edges);
const arcIds = (edges) => edges.filter((e) => e.type === 'edge').map((e) => `${e.src}->${e.tgt}`);

check('collapsed: each section keeps its own arcs and drops its contents\'', () => {
  const own = ownArcs(qCollapsed);
  sameSet(arcIds(own), ['sec-main->sec-foundations', 'sec-main->sec-applications', 'sec-applications->sec-main'],
    'only the arcs declared between sections');
  const g = own.find((e) => e.src === 'sec-main' && e.tgt === 'sec-foundations');
  sameSet(g.members.map((x) => x.id), ['uses/sec-main/sec-foundations'], 'its own edge, not the three witnesses');
  eq(g.state, 'both', 'still witnessed by the contents');
  eq(own.find((e) => e.tgt === 'sec-applications').state, 'declared-only', 'still unwitnessed');
  // Two members in the quotient, the second written on a proof inside
  // sec-applications: the own arc keeps one, so it carries no "×2".
  sameSet(edgeFor(qCollapsed, 'sec-applications', 'sec-main', 'uses').members.map((x) => x.id),
    ['uses/sec-applications/sec-main', 'uses/proof~thm-heine-borel/lem-finite-subcover'], 'the quotient\'s arc');
  sameSet(own.find((e) => e.src === 'sec-applications' && e.tgt === 'sec-main').members.map((x) => x.id),
    ['uses/sec-applications/sec-main'], 'the own arc, not mutating the quotient');
  eq(own.filter((e) => e.synthetic).length, 0, 'no synthesised arc');
  // A junction among hidden edges (commutes, generalises) is contents too;
  // the prose edge with lemmas of its own stays, as the way into them.
  sameSet(own.filter((e) => e.type === 'junction').map((e) => e.members[0].id), [TYCH_ULTRA],
    'only the edge with contents of its own');
  for (const e of own) {
    if (e.type === 'junction') continue;
    for (const it of e.members) {
      for (const b of it.object.boundary) has(vCollapsed.visible, vCollapsed.anchor(b.id), `${it.id}: every end visible`);
    }
  }
});

check('expanded: arcs between visible leaves are theirs, and so are their arcs into a collapsed section', () => {
  const own = ownArcs(qTwo);
  const ids = arcIds(own);
  has(ids, 'thm-heine-borel->thm-tychonoff', 'leaf to leaf, both visible');
  // A visible leaf's relation to something shut inside a collapsed section is
  // drawn to that section: thm-stone-cech uses lem-ultrafilter, inside
  // sec-foundations; lem-diagonal uses lem-finite-subcover, inside
  // sec-main-induction.
  has(ids, 'thm-stone-cech->sec-foundations', 'a leaf into a collapsed section');
  has(ids, 'thm-heine-borel->sec-foundations', 'another');
  has(ids, 'lem-diagonal->sec-main-induction', 'into a collapsed section inside an expanded one');
  const into = own.find((e) => e.src === 'thm-stone-cech' && e.tgt === 'sec-foundations');
  sameSet(into.members.map((x) => x.id), ['uses/thm-stone-cech/lem-ultrafilter'], 'the leaf\'s own relation');
  // One junction too: def-compact, its far end, is inside sec-foundations.
  ok(own.some((e) => e.type === 'junction' && e.members[0].id === 'uses/thm-heine-borel/def-compact'),
    'a junction with one end visible');
  eq(own.filter((e) => e.synthetic).length, 0, 'no synthesised arc');
});

check('collapsed sections draw no arc between their contents, whatever is expanded', () => {
  // With only sec-main expanded, sec-foundations and sec-applications stay
  // shut: what their contents use of each other is still theirs alone.
  const v = M.makeView(model, 'refines', ['sec-main']);
  const own = M.ownEdges(v, M.quotient(v).edges);
  for (const e of own) {
    for (const it of e.members) {
      ok(it.object.boundary.some((b) => v.isVisible(v.anchor(b.id))) || (v.isVisible(it.id) && v.isExpandable(it.id)),
        `${it.id}: drawn with no end visible`);
    }
  }
  ok(!arcIds(own).some((id) => id === 'sec-applications->sec-foundations'), 'contents to contents');
  // An arc into the expanded section from a collapsed one is drawn too: Heine-Borel
  // is an instance of Tychonoff.
  has(arcIds(own), 'sec-applications->thm-tychonoff', 'a collapsed section into a visible leaf');
});

check('a uses written on a proof is its statement\'s own arc while the statement is visible', () => {
  const proofUse = model.objects.find((o) => o.kind === 'uses' && model.byId.get(o.boundary[0].id).kind === 'proof');
  if (!proofUse) return; // the sample has none: nothing to say
  const v = M.makeView(model, 'refines', [...M.collapseOrder(model, 'refines').expandable]);
  const own = M.ownEdges(v, M.quotient(v).edges);
  ok(own.some((e) => e.members.some((x) => x.id === proofUse.id)), `${proofUse.id} kept`);
});

check('multi-parent objects appear under each parent', () => {
  // lem-diagonal is visible (both its parents are expanded).
  has(vTwo.visible, 'lem-diagonal', 'visible');
  sameSet(vTwo.rep('lem-diagonal'), ['lem-diagonal'], 'rep of a visible object is itself');
  // With only sec-applications expanded it is represented twice.
  const vApp = M.makeView(model, 'refines', ['sec-applications']);
  sameSet(vApp.rep('lem-diagonal'), ['lem-diagonal'], 'visible through the expanded parent');
  const vInd = M.makeView(model, 'refines', ['sec-main', 'sec-main-induction']);
  sameSet(vInd.rep('lem-diagonal'), ['lem-diagonal'], 'visible through the other parent');
});

// --- quotient: fully expanded ----------------------------------------------

const vAll = M.makeView(model, 'refines', [...order.expandable]);
const qAll = M.quotient(vAll);

check('fully expanded quotient draws every uses edge between leaves', () => {
  // A proof is drawn inside its statement whatever is expanded; nothing else
  // is internal when nothing is collapsed.
  eq(qAll.internal.size, 1, 'only the proof is internal');
  sameSet(qAll.internal.get('thm-heine-borel'), [PROOF], 'the proof sits in its statement');
  has(qAll.dropped, 'uses/sec-main/sec-foundations', 'coarse section edges have no ends left');
  eq(stateOf(qAll, 'lem-ultrafilter', 'def-filter', 'uses'), 'declared-only', 'leaf edges are declared');
  // The edge object itself is expanded here, hence not visible; what decides
  // "declared" is that both of its ends are visible.
  eq(vAll.isVisible(TYCH_ULTRA), false, 'the prose edge is expanded');
  eq(stateOf(qAll, 'thm-tychonoff', 'lem-ultrafilter', 'uses'), 'declared-only',
    'an expanded edge object still declares its pair');
  eq(itemById(qAll, TYCH_ULTRA).state, 'declared-only', 'and its arc says so');
  const rec = qAll.consistency.get(M.pairKey('lem-ultrafilter', 'def-filter', 'uses'));
  eq(rec.elaborable, false, 'leaf-to-leaf declared edges are not "unwitnessed"');
  const secRec = qCollapsed.consistency.get(M.pairKey('sec-main', 'sec-applications', 'uses'));
  eq(secRec.elaborable, true, 'section-level declared-only edges are');
});

check('the commutes hyperedge survives full expansion', () => {
  const c = itemById(qAll, COMMUTES);
  eq(c.junction, true, 'still a junction');
  eq(c.ends.length, 3, 'still three ends');
  for (const e of c.ends) has(vAll.visible, e.id, 'ends are visible uses edges');
});

// --- a second collapse kind -------------------------------------------------

check('instance_of is a collapse kind too', () => {
  const io = M.collapseOrder(model, 'instance_of');
  sameSet(io.expandable, ['thm-tychonoff', 'lem-finite-subcover'], 'instance_of parents');
  const v = M.makeView(model, 'instance_of', []);
  hasNot(v.visible, 'thm-heine-borel', 'it is an instance of tychonoff');
  has(v.visible, 'thm-tychonoff', 'the general statement is the root');
  sameSet(v.rep('thm-heine-borel'), ['thm-tychonoff'], 'rep under instance_of');
  const q = M.quotient(v);
  for (const it of q.items) {
    if (it.kind === 'instance_of') throw new Error('the active collapse kind must not be drawn');
  }
  // refines edges are ordinary edges under this collapse kind.
  const refItem = itemById(q, 'refines/thm-heine-borel/sec-applications');
  if (!refItem) throw new Error('refines edges should be drawn when K = instance_of');
  sameSet(refItem.ends.map((e) => e.id), ['thm-tychonoff', 'sec-applications'], 'quotiented refines edge');
});

// --- status, progress, search ----------------------------------------------

check('status lookup covers every value of the enum', () => {
  eq(M.statusOf(model, 'def-compact'), 'proved', 'proved');
  eq(M.statusOf(model, 'thm-tychonoff'), 'stated', 'stated');
  eq(M.statusOf(model, 'thm-heine-borel'), 'missing', 'missing');
  eq(M.statusOf(model, 'def-metric'), 'absent', 'absent');
  eq(M.statusOf(model, 'lem-ultrafilter'), 'proved_with_axioms', 'proved_with_axioms');
  eq(M.statusOf(model, 'sec-main'), null, 'sections carry no derived status');
  const seen = new Set(Object.values(model.status));
  sameSet(seen, M.STATUSES, 'the sample exercises every status');
});

check('a remark that names no Lean declaration shows no status badge', () => {
  const m = {
    status: { rem: 'absent', 'rem-lean': 'proved', thm: 'absent' },
    byId: new Map([
      ['rem', { id: 'rem', kind: 'remark' }],
      ['rem-lean', { id: 'rem-lean', kind: 'remark' }],
      ['thm', { id: 'thm', kind: 'theorem' }],
    ]),
    kinds: { remark: { countable: false }, theorem: { countable: true } },
  };
  eq(M.badgeStatusOf(m, 'rem'), null, 'remark without Lean');
  eq(M.badgeStatusOf(m, 'rem-lean'), 'proved', 'remark with Lean');
  eq(M.badgeStatusOf(m, 'thm'), 'absent', 'theorem without Lean');
  eq(M.badgeStatusOf(model, 'def-metric'), 'absent', 'a definition still shows absent');
  eq(M.badgeStatusOf(model, 'sec-main'), null, 'a section still shows none');
});

check('progress lookup', () => {
  const p = M.progressOf(model, 'refines', 'sec-foundations');
  eq(p.proved, 3, 'proved');
  eq(p.total, 5, 'total');
  eq(M.progressOf(model, 'refines', TYCH_ULTRA).total, 3, 'an edge object has progress too');
  eq(M.progressOf(model, 'refines', 'nope'), null, 'unknown id');
  eq(M.progressOf(model, 'nope', 'sec-main'), null, 'unknown kind');
  eq(M.progressOf(model, 'instance_of', 'thm-tychonoff').total, 1, 'second collapse kind');
});

check('progress totals are consistent with the refines leaves', () => {
  const countable = (id) => {
    const o = model.byId.get(id);
    const k = model.kinds[o.kind];
    return !!(k && k.countable);
  };
  for (const id of ['sec-foundations', 'sec-main', 'sec-main-induction', 'sec-applications', TYCH_ULTRA]) {
    const leaves = [id, ...M.descendantsOf(order, id)].filter(
      (x) => countable(x) && M.childrenOf(order, x).length === 0,
    );
    const proved = leaves.filter((x) => M.statusOf(model, x) === 'proved');
    const p = M.progressOf(model, 'refines', id);
    eq(p.total, leaves.length, `total of ${id}`);
    eq(p.proved, proved.length, `proved of ${id}`);
  }
});

check('a remark under a top-level section is not counted in its bar', () => {
  const s = structuredClone(snapshot);
  s.schema.kinds.remark = { ...s.schema.kinds.section, countable: false };
  s.objects.push(
    { id: 'rem-aside', kind: 'remark', boundary: [], attrs: {}, body: '' },
    { id: 'refines/rem-aside/sec-foundations', kind: 'refines', attrs: {}, body: '',
      boundary: [{ role: 'src', id: 'rem-aside' }, { role: 'tgt', id: 'sec-foundations' }] },
  );
  const m = M.buildModel(s);
  const p = M.progressMixOf(m, 'refines', 'sec-foundations');
  eq(p.total, 5, 'the remark is left out of the total');
  eq(p.proved, 3, 'proved');
  eq(p.mix.absent, 1, 'only def-metric is absent');
});

check('a nested section counts its direct children, without remarks', () => {
  // sec-main-induction (itself under sec-main) gets a remark and a subsection
  // holding two lemmas: its bar is over lem-finite-subcover, lem-diagonal and
  // sec-deep, not over the four lemma leaves below it.
  const s = structuredClone(snapshot);
  s.schema.kinds.remark = { ...s.schema.kinds.section, countable: false };
  const refines = (src, tgt) => ({
    id: `refines/${src}/${tgt}`, kind: 'refines', attrs: {}, body: '',
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }],
  });
  s.objects.push(
    { id: 'rem-nested', kind: 'remark', boundary: [], attrs: {}, body: '' },
    { id: 'sec-deep', kind: 'section', boundary: [], attrs: {}, body: '' },
    { id: 'lem-deep-a', kind: 'lemma', boundary: [], attrs: {}, body: '' },
    { id: 'lem-deep-b', kind: 'lemma', boundary: [], attrs: {}, body: '' },
    refines('rem-nested', 'sec-main-induction'),
    refines('sec-deep', 'sec-main-induction'),
    refines('lem-deep-a', 'sec-deep'),
    refines('lem-deep-b', 'sec-deep'),
  );
  s.derived.progress.refines['sec-deep'] = { proved: 0, total: 2 };
  s.derived.progress.refines['sec-main-induction'] = { proved: 2, total: 4 };
  const m = M.buildModel(s);
  ok(M.ancestorsOf(M.collapseOrder(m, 'refines'), 'sec-main-induction').length > 0, 'nested');
  const p = M.progressMixOf(m, 'refines', 'sec-main-induction');
  eq(p.total, 3, 'two lemmas and the subsection, not the remark');
  eq(p.proved, 2, 'the two proved lemmas');
  eq(p.mix.absent, 1, 'the unproved subsection');
});

check('statusCounts only counts countable kinds', () => {
  const { counts, total } = M.statusCounts(model);
  eq(total, 13, 'thirteen countable objects');
  eq(counts.proved, 6, 'proved');
  eq(counts.stated, 3, 'stated');
  eq(counts.missing, 1, 'missing');
  eq(counts.absent, 2, 'absent');
  eq(counts.proved_with_axioms, 1, 'proved_with_axioms');
});

check('search over id, title and body', () => {
  eq(M.search(model, '').length, 0, 'empty query');
  const ids = M.search(model, 'tychonoff').map((h) => h.object.id);
  has(ids, 'thm-tychonoff', 'by id');
  const byTitle = M.search(model, 'ultrafilter criterion').map((h) => h.object.id);
  eq(byTitle[0], 'lem-ultrafilter', 'exact title ranks first');
  const byBody = M.search(model, 'tube lemma').map((h) => h.object.id);
  has(byBody, 'lem-finite-subcover', 'by body');
  const set = M.searchIds(model, 'compact');
  if (set.size < 3) throw new Error('searchIds should find several objects');
});

check('search finds Lean declaration names', () => {
  const exact = M.search(model, 'Compact.tychonoff').map((h) => h.object.id);
  eq(exact[0], 'thm-tychonoff', 'an exact Lean name ranks first');
  const part = M.search(model, 'ultrafilter_le').map((h) => h.object.id);
  sameSet(part, ['lem-ultrafilter'], 'part of a Lean name, found nowhere else');
  has(M.searchIds(model, 'heineBorel'), 'thm-heine-borel', 'the graph highlight sees Lean names too');
  sameSet(M.leanNamesOf(model.byId.get('def-filter')), ['Compact.Filter', 'Compact.Ultrafilter'], 'a list');
  eq(M.leanNamesOf(model.byId.get('sec-main')).length, 0, 'none');
  eq(M.leanNamesOf({ attrs: { lean: 'X.y' } })[0], 'X.y', 'a single name');
});

check('hiddenHits counts the matches hidden inside each visible object', () => {
  const counts = (view, ids) => Object.fromEntries([...M.hiddenHits(view, new Set(ids))].sort());
  // "tube lemma" is in the body of lem-finite-subcover, in sec-main-induction, in sec-main.
  const tube = M.searchIds(model, 'tube lemma');
  eq(JSON.stringify(counts(M.makeView(model, 'refines', []), tube)), '{"sec-main":1}', 'collapsed');
  eq(JSON.stringify(counts(M.makeView(model, 'refines', ['sec-main']), tube)),
    '{"sec-main-induction":1}', 'one level down');
  eq(M.hiddenHits(M.makeView(model, 'refines', ['sec-main', 'sec-main-induction']), tube).size, 0,
    'nothing hidden once the match is drawn');
  // An object in two sections counts for both.
  eq(JSON.stringify(counts(M.makeView(model, 'refines', []), ['lem-diagonal'])),
    '{"sec-applications":1,"sec-main":1}', 'two parents');
  // A proof counts for its statement, drawn or collapsed.
  eq(JSON.stringify(counts(M.makeView(model, 'refines', ['sec-applications']), [PROOF])),
    '{"thm-heine-borel":1}', 'a proof, with its statement drawn');
  eq(JSON.stringify(counts(M.makeView(model, 'refines', []), [PROOF])),
    '{"sec-applications":1}', 'a proof, with its statement collapsed');
  // Arcs are not inside anything.
  eq(M.hiddenHits(M.makeView(model, 'refines', []), new Set(['uses/lem-ultrafilter/def-filter'])).size, 0, 'an arc');
});

check('search limits, and filters candidates with accept', () => {
  const all = M.search(model, 'e', Infinity);
  if (all.length <= 3) throw new Error('"e" should match most of the sample');
  eq(M.search(model, 'e', 3).length, 3, 'limit');
  eq(M.searchIds(model, 'e').size, all.length, 'searchIds is not capped');
  const nodesOnly = M.search(model, 'e', Infinity, { accept: (o) => o.boundary.length === 0 });
  ok(nodesOnly.length > 0 && nodesOnly.every((h) => h.object.boundary.length === 0), 'accept is honoured');
  eq(nodesOnly.length, all.filter((h) => h.object.boundary.length === 0).length, 'and drops nothing else');
});

// --- the search page's full-text search -------------------------------------

check('searchWords: letters and digits, lowercased, accents dropped', () => {
  eq(M.searchWords('Stone–Čech $\\beta X$').join(' '), 'stone cech beta x', 'a title with maths');
  eq(M.searchWords('Compact.ultrafilter_le').join(' '), 'compact ultrafilter le', 'a Lean name');
  eq(M.searchWords('').length, 0, 'nothing');
});

check('searchWords and compoundWords: TeX accents, hyphenated words written as one', () => {
  eq(M.searchWords("pro-\\'etale, \\'{E}tale, \\v{C}ech").join(' '), 'pro etale etale cech', 'TeX accents dropped');
  eq(M.compoundWords('the pro-étale site').join(' '), 'proetale', 'pro-étale is proetale');
  eq(M.compoundWords("pro-\\'etale").join(' '), 'proetale', 'so is pro-\\\'etale');
  eq(M.compoundWords('small-pro-etale-site').join(' '),
    'smallpro smallproetale smallproetalesite proetale proetalesite etalesite', 'runs of two to four pieces');
  eq(M.compoundWords('Stone–Čech, a - b, -x').length, 0, 'not a dash, nor a hyphen between spaces');
});

check('queryAlternative: the Stacks project\'s hint for an unquoted hyphenated word', () => {
  eq(M.queryAlternative('proetale'), null, 'nothing to say');
  eq(M.queryAlternative('"pro-etale" -foo'), null, 'a phrase and an exclusion are meant');
  const alt = M.queryAlternative('pro-etale site');
  eq(alt.keywords.join(), 'pro-etale', 'the keyword');
  eq(alt.alternative, '"pro-etale" site', 'in double quotes');
});

check('parseQuery: words, wildcards, phrases, exclusions and OR, as on the Stacks project', () => {
  const w = (word, prefix = false) => ({ word, prefix });
  const q = M.parseQuery('a b OR c -d "e f*" quasi-compact');
  eq(JSON.stringify(q.all), JSON.stringify([[[w('a')]], [[w('b')], [w('c')]], [[w('e'), w('f', true)]], [[w('quasi')]]]), 'wanted');
  eq(JSON.stringify(q.none), JSON.stringify([[w('d')], [w('compact')]]), 'left out');
  eq(JSON.stringify(M.parseQuery('Nat.succ_le').all), JSON.stringify([[[w('nat'), w('succ'), w('le')]]]), 'a word of several is a phrase');
  eq(JSON.stringify(M.parseQuery('-"x y"').none), JSON.stringify([[w('x'), w('y')]]), 'a phrase left out');
  eq(M.parseQuery('OR x').all.length, 1, 'a leading OR is ignored');
  eq(M.parseQuery('or x').all.length, 2, 'a lowercase or is a word');
});

check('fullTextSearch: whole words, in document order', () => {
  const ids = (q, opts) => M.fullTextSearch(model, q, opts).map((o) => o.id);
  eq(ids('').length, 0, 'empty query');
  eq(ids('-compact').length, 0, 'only words to leave out finds nothing');
  const compact = ids('compact');
  ok(!compact.includes('sec-foundations'), '"compact" is not "compactness"');
  ok(ids('compact*').includes('sec-foundations'), 'but "compact*" is');
  // Ordered as the document reads: 1.1, 1.2, …, a proof right after its statement.
  const outline = M.documentOutline(model, 'refines');
  const at = (id) => (outline.byId.has(id) ? outline.entries.indexOf(outline.byId.get(id)) : outline.entries.indexOf(outline.byId.get(outline.stepOf.get(id))) + 0.5);
  for (let i = 1; i < compact.length; i += 1) ok(at(compact[i - 1]) <= at(compact[i]), `document order at ${compact[i]}`);
  eq(compact[0], 'def-compact', 'Definition 1.1 first');
  ok(compact.indexOf('proof/thm-heine-borel') === compact.indexOf('thm-heine-borel') + 1, 'a proof after its statement');
  sameSet(ids('"finite intersection"'), ['def-filter'], 'a phrase');
  eq(ids('"intersection finite"').length, 0, 'a phrase is in order');
  sameSet(ids('heineBorel', { radius: 'statements' }), ['thm-heine-borel'], 'a Lean name');
  // A hyphenated word written as one, and the other way round.
  ok(ids('heineborel').includes('thm-heine-borel'), 'heineborel finds heine-borel');
  ok(ids('heinebor*').includes('thm-heine-borel'), 'so does a prefix of it');
  ok(ids('"heine-borel"', { radius: 'statements' }).includes('thm-heine-borel'), 'a phrase finds the Lean name heineBorel');
  sameSet(ids('cech'), ids('Čech'), 'accents do not matter');
  ok(ids('compact -tychonoff').every((id) => !ids('tychonoff').includes(id)), 'exclusion');
  const either = ids('ultrafilter OR net');
  ok(ids('ultrafilter').concat(ids('net')).every((id) => either.includes(id)) && either.length <= ids('ultrafilter').length + ids('net').length, 'OR');
});

check('fullTextSearch: all objects but bare sugar, or the statements alone', () => {
  const all = M.fullTextSearch(model, 'compact*');
  ok(all.every((o) => !M.isBareSugar(model, o)), 'no bare sugar edge');
  ok(M.fullTextSearch(model, 'ultrafilter').some((o) => o.id === 'uses/thm-tychonoff/lem-ultrafilter'), 'an edge with prose of its own is found');
  const st = M.fullTextSearch(model, 'compact*', { radius: 'statements' });
  ok(st.length > 0 && st.length < all.length, 'fewer statements than objects');
  ok(st.every((o) => M.isStatement(model, o)), 'only statements');
  ok(!st.some((o) => o.kind === 'section' || o.kind === 'proof' || o.boundary.length), 'no section, proof or edge');
});

// --- the progress listing -------------------------------------------------

check('countableObjects is every countable object, by title, memoised', () => {
  const list = M.countableObjects(model);
  eq(list.length, M.statusCounts(model).total, 'as many as statusCounts counts');
  for (let i = 1; i < list.length; i += 1) {
    ok(M.titleOf(list[i - 1]) <= M.titleOf(list[i]), `sorted at ${i}`);
  }
  eq(M.countableObjects(model), list, 'memoised');
});

check('filterListing: each filter, and their combination', () => {
  const all = M.countableObjects(model);
  const ids = (f) => M.filterListing(model, all, { order, ...f }).map((o) => o.id);
  eq(ids({}).length, all.length, 'no filter keeps everything');
  sameSet(ids({ kind: 'theorem' }), ['thm-tychonoff', 'thm-heine-borel', 'thm-stone-cech'], 'kind');
  sameSet(ids({ status: 'stated' }), ['thm-tychonoff', 'lem-inductive-step', 'lem-limit-point'], 'status');
  sameSet(ids({ status: 'unproved' }),
    ['thm-tychonoff', 'lem-inductive-step', 'lem-limit-point', 'thm-heine-borel', 'def-metric', 'thm-stone-cech'],
    'unproved is everything but proved and proved_with_axioms');
  eq(ids({ status: 'none' }).length, 0, 'every countable sample object has a status');
  // `under` is any strict ancestor, not just the parent: lem-finite-subcover
  // sits in sec-main-induction, which sits in sec-main.
  sameSet(ids({ under: 'sec-main' }), ['thm-tychonoff', 'lem-finite-subcover', 'lem-diagonal'], 'under, at any depth');
  sameSet(ids({ under: TYCH_ULTRA }), ['lem-base-case', 'lem-inductive-step', 'lem-limit-point'], 'under an edge');
  sameSet(ids({ q: 'tychonoff' }), ['thm-tychonoff', 'thm-stone-cech'], 'text, by id and by body');
  sameSet(ids({ q: 'tychonoff', under: 'sec-main' }), ['thm-tychonoff'], 'text and under');
  sameSet(ids({ q: 'compact', kind: 'definition' }), ['def-compact', 'def-filter', 'def-net', 'def-metric']
    .filter((id) => M.searchIds(model, 'compact').has(id)), 'text and kind');
  sameSet(ids({ under: 'sec-foundations', status: 'proved', kind: 'definition' }),
    ['def-compact', 'def-filter', 'def-net'], 'three filters at once');
  eq(ids({ under: 'sec-main', status: 'missing' }).length, 0, 'filters combine with "and"');
  eq(ids({ under: 'sec-main', order: null }).length, 0, 'under without an order matches nothing');
});

check('body links', () => {
  sameSet(M.bodyLinks(model.byId.get('thm-stone-cech').body), ['def-uniformity'], 'a dangling link');
  sameSet(
    M.bodyLinks(model.byId.get(TYCH_ULTRA).body),
    ['lem-base-case', 'lem-inductive-step', 'lem-limit-point'],
    'links in the prose edge',
  );
  eq(M.bodyLinks('see [x](http://y)').length, 0, 'markdown links are not object links');
});

// --- checks ----------------------------------------------------------------

check('the website leaves the checks out of its model', () => {
  ok(snapshot.derived.checks.length > 0, 'the sample has checks to leave out');
  eq(model.checks, undefined, 'the model keeps them');
});

// --- lean facts -------------------------------------------------------------

check('lean facts are joined to objects', () => {
  const f = M.leanFactsFor(model, model.byId.get('def-filter'));
  eq(f.length, 2, 'two declarations');
  eq(f[0].fact.module, 'Compact.Basic', 'module');
  const missing = M.leanFactsFor(model, model.byId.get('thm-heine-borel'));
  eq(missing[0].fact.exists, false, 'missing declaration');
  eq(M.leanFactsFor(model, model.byId.get('thm-stone-cech')).length, 0, 'no lean attribute');
  for (const o of model.objects) {
    for (const { name, fact } of M.leanFactsFor(model, o)) {
      if (!fact) throw new Error(`${o.id} names ${name} which is absent from facts`);
    }
  }
});

// --- reading order ----------------------------------------------------------

check('reading order follows the order attribute, then id', () => {
  const doc = M.readingOrder(model, 'refines');
  const sections = doc.filter((e) => e.object.kind === 'section' && e.depth === 0).map((e) => e.id);
  sameSet(sections, ['sec-foundations', 'sec-main', 'sec-applications'], 'top level sections');
  const idx = (id) => doc.findIndex((e) => e.id === id);
  if (!(idx('sec-foundations') < idx('sec-main'))) throw new Error('order attr ignored');
  if (!(idx('sec-main') < idx('sec-applications'))) throw new Error('order attr ignored');
  // Children come straight after their parent.
  if (!(idx('sec-foundations') < idx('def-compact'))) throw new Error('child before parent');
  eq(doc.find((e) => e.id === 'def-compact').depth, 1, 'depth');
  eq(doc.find((e) => e.id === 'lem-finite-subcover').depth, 2, 'nested section depth');
  eq(doc.find((e) => e.id === 'lem-base-case').depth, 1, 'the prose edge is a root of its own');
  // The multi-parent lemma appears twice, the second time flagged.
  const dia = doc.filter((e) => e.id === 'lem-diagonal');
  eq(dia.length, 2, 'lem-diagonal appears under both parents');
  eq(dia[0].duplicate, false, 'first occurrence');
  eq(dia[1].duplicate, true, 'second occurrence flagged');
  // Every object appears at least once.
  const seen = new Set(doc.map((e) => e.id));
  eq(seen.size, model.objects.length, 'every object is reachable in the reading order');
});

// --- the document outline: numbers and pages ---------------------------------

check('the document outline numbers entries the way a paper does', () => {
  const out = M.documentOutline(model, 'refines');
  const num = (id) => out.byId.get(id).number;
  eq(num('sec-foundations'), '1', 'first chapter');
  eq(num('def-compact'), '1.1', 'first entry of the first chapter');
  eq(num('lem-ultrafilter'), '1.5', 'numbers count up through a chapter');
  eq(num('sec-main-induction'), '2.1', 'a section in a chapter, numbered among the headings');
  eq(num('lem-finite-subcover'), '2.1', 'a statement in a section: numbered in its chapter');
  eq(num('lem-diagonal'), '2.2', 'statements count up through a chapter, whatever its sections');
  eq(num('thm-tychonoff'), '2.3', 'numbering continues after a nested section');
  eq(num('sec-applications'), '3', 'the headings their own series');
  // The prose edge with children is a top-level entry; its steps are not.
  // Under no heading, statements are numbered among themselves.
  eq(num('commutes/uses~thm-heine-borel~thm-tychonoff/uses~thm-tychonoff~def-compact/uses~thm-heine-borel~def-compact'), '1',
    'a statement under no heading');
  eq(num('uses/thm-tychonoff/lem-ultrafilter'), '3', 'an edge heading its own part');
  eq(num('lem-base-case'), '4', 'under the edge, still under no heading');
  eq(out.byId.has('refines/def-compact/sec-foundations'), false, 'collapse edges are structure');
  eq(out.stepOf.get('uses/sec-main/sec-foundations'), 'sec-main', 'a leaf edge with prose is a step');
  eq(out.byId.has('uses/sec-main/sec-foundations'), false, 'a step has no number of its own');
  // Parents and children are the entries', so pages can be read off them.
  eq(out.byId.get('lem-finite-subcover').parent.id, 'sec-main-induction', 'parent entry');
  sameSet(out.roots.map((e) => e.id).filter((id) => id.startsWith('sec-')),
    ['sec-foundations', 'sec-main', 'sec-applications'], 'top level');
});

check('an object with two parents has one number, and its repetition none', () => {
  const out = M.documentOutline(model, 'refines');
  const occ = out.entries.filter((e) => e.id === 'lem-diagonal');
  eq(occ.length, 2, 'written out once, repeated once');
  eq(occ[0].duplicate, false, 'first occurrence written out');
  eq(occ[1].duplicate, true, 'second occurrence a pointer');
  eq(occ[0].number, '2.2', 'the number of the first occurrence');
  eq(occ[1].number, '2.2', 'the repetition carries the same number');
  eq(out.byId.get('lem-diagonal'), occ[0], 'byId is the written-out entry');
  // The repetition sits under sec-applications and takes no number there.
  eq(occ[1].parent.id, 'sec-applications', 'repeated under its second parent');
  eq(out.byId.get('thm-heine-borel').number, '3.1', 'before the repetition');
  eq(out.byId.get('thm-stone-cech').number, '3.2', 'after it: no number was used up');
});

check('the outline follows the collapse order it is asked for', () => {
  const a = M.documentOutline(model, 'refines');
  const b = M.documentOutline(model, 'instance_of');
  eq(M.documentOutline(model, 'refines'), a, 'memoised');
  eq(a !== b, true, "one outline per collapse kind");
  eq(b.byId.get('thm-heine-borel').parent.id, 'thm-tychonoff', 'instance_of nests differently');
  eq(b.byId.get('thm-heine-borel').number, '6', 'and numbers differently');
});

check('[site] numbering = "nested" numbers a statement inside a statement within it', () => {
  const nested = M.buildModel({ ...JSON.parse(JSON.stringify(snapshot)),
    project: { ...(snapshot.project || {}), numbering: 'nested' } });
  const out = M.documentOutline(nested, 'instance_of');
  const tych = out.byId.get('thm-tychonoff');
  eq(out.byId.get('thm-heine-borel').parent.id, 'thm-tychonoff', 'a statement inside a statement');
  eq(out.byId.get('thm-heine-borel').number, tych.number + '.1', 'numbered within it');
  // Every statement inside a statement is numbered under it, 1, 2, … in order,
  // and the others count up without them.
  const isStatementEntry = (e) => !e.duplicate && e.number && !M.isSectionKind(e.object.kind);
  const inside = (e) => e.parent && !M.isSectionKind(e.parent.object.kind);
  const series = new Map();
  for (const e of out.entries.filter(isStatementEntry)) {
    const host = inside(e) ? e.parent : null;
    const key = host ? host.id : 'top:' + (e.parent ? e.parent.id : '');
    const k = (series.get(key) || 0) + 1;
    series.set(key, k);
    if (host) eq(e.number, host.number + '.' + k, `${e.id} is ${host.number}.${k}`);
  }
  // Any numbered entry that is not a heading hosts what lies inside it: in the
  // refines outline the edge heading its own part (3) holds lem-base-case.
  const b = M.documentOutline(nested, 'refines');
  eq(b.byId.get('lem-base-case').number, '3.1', 'under a numbered edge');
  eq(b.byId.get('def-compact').number, '1.1', 'statements under headings as before');
  eq(b.byId.get('thm-tychonoff').number, '2.3', 'and further on in the chapter');
  // Without the setting nothing changes.
  eq(M.documentOutline(model, 'refines').byId.get('lem-base-case').number, '4', 'flat by default');
});

check('pages of the split document', () => {
  const out = M.documentOutline(model, 'refines');
  // An entry with children is read on its own page, a leaf on its parent's,
  // a top-level leaf on its own too (the top page is the contents), a step
  // wherever its source is.
  const leaf = 'commutes/uses~thm-heine-borel~thm-tychonoff/uses~thm-tychonoff~def-compact/uses~thm-heine-borel~def-compact';
  eq(M.documentPageOf(out, 'sec-main'), 'sec-main', 'own page');
  eq(M.documentPageOf(out, 'lem-finite-subcover'), 'sec-main-induction', "parent's page");
  eq(M.documentPageOf(out, leaf), leaf, 'a top-level leaf');
  eq(M.documentPageOf(out, 'uses/sec-main/sec-foundations'), 'sec-main', 'a step');
  eq(M.documentPageOf(out, 'refines/def-compact/sec-foundations'), undefined, 'not in the document');

  // Every link leads to an entry's level instead: its parent's page, the top
  // level (null) for a chapter, whatever is below it.
  eq(M.documentLevelOf(out, 'sec-main'), null, 'a chapter: the top level');
  eq(M.documentLevelOf(out, 'sec-main-induction'), 'sec-main', "a section: its chapter's page");
  eq(M.documentLevelOf(out, 'lem-finite-subcover'), 'sec-main-induction', "a lemma: its section's page");
  eq(M.documentLevelOf(out, leaf), null, 'a top-level leaf: the top level');
  eq(M.documentLevelOf(out, 'uses/sec-main/sec-foundations'), null, "a step: its source's level");
  eq(M.documentLevelOf(out, 'refines/def-compact/sec-foundations'), undefined, 'not in the document');
  for (const e of out.byId.values()) {
    const level = M.documentLevelOf(out, e.id);
    eq(M.documentPageShows(out, level, 1, e.id), true, `${e.id} written out on its level`);
  }

  // What a page writes out, by levels.
  const ids = (page, levels) => M.documentPageEntries(out, page, levels).map((e) => e.id);
  sameSet(ids(null, 1), out.roots.map((e) => e.id), 'the top page at one level: the chapters');
  eq(ids(null, 2).includes('sec-main-induction'), true, 'two levels: their sections too');
  eq(ids(null, 2).includes('lem-finite-subcover'), false, 'but not three');
  eq(ids(null, Infinity).length, out.entries.length, 'all levels: the whole document');
  eq(ids('sec-main', 1).join(' '), 'sec-main sec-main-induction thm-tychonoff', 'a chapter page');
  eq(ids('sec-main', 2).join(' '),
    'sec-main sec-main-induction lem-finite-subcover lem-diagonal thm-tychonoff', 'two levels below it');
  eq(ids('no-such-id', 1).length, 0, 'an unknown page writes nothing');

  // And the converse, which is what decides whether a focus needs a redirect.
  eq(M.documentPageShows(out, null, 1, 'sec-main'), true, 'a chapter on the top page');
  eq(M.documentPageShows(out, null, 1, 'thm-tychonoff'), false, 'not its contents');
  eq(M.documentPageShows(out, null, 2, 'thm-tychonoff'), true, 'unless two levels are inlined');
  eq(M.documentPageShows(out, 'sec-main', 1, 'sec-main'), true, 'a page shows itself');
  eq(M.documentPageShows(out, 'sec-main', 1, 'lem-diagonal'), false, 'two levels down');
  eq(M.documentPageShows(out, 'sec-main', 2, 'lem-diagonal'), true, 'with two levels');
  eq(M.documentPageShows(out, 'sec-foundations', 3, 'lem-diagonal'), false, 'another branch');
  eq(M.documentPageShows(out, 'sec-main', 1, 'uses/sec-main/sec-foundations'), true, 'a step with its source');
  // The contents (the top page at no level) write nothing out but text.
  eq(ids(null, 0).length, 0, 'the contents write out no entry');
  eq(M.documentPageShows(out, null, 0, 'sec-main'), false, 'not even a chapter');
  eq(M.documentPageShows(out, null, 1, leaf), true, 'a top-level leaf is on the top page written out');
  // Every entry's page shows it, at the default depth.
  for (const e of out.entries) {
    if (e.duplicate) continue;
    eq(M.documentPageShows(out, M.documentPageOf(out, e.id), 1, e.id), true, `${e.id} on its own page`);
  }
});

check('cross references read as the document numbers them', () => {
  const out = M.documentOutline(model, 'refines');
  const ref = (id) => { const r = M.referenceOf(out, id); return r && r.word + ' ' + r.number; };
  eq(ref('def-filter'), 'Definition 1.2', 'a statement');
  eq(ref('sec-main-induction'), 'Section 2.1', 'a section, by the same rule');
  eq(ref('lem-diagonal'), 'Lemma 2.2', 'two parents: the first occurrence');
  eq(ref('uses/thm-tychonoff/lem-ultrafilter'), 'Uses 3', 'an edge heading its own part, as the document sets it');
  eq(ref('uses/sec-main/sec-foundations'), null, 'a step has no number');
  eq(ref('refines/def-compact/sec-foundations'), null, 'not in the document');
  eq(ref('no-such-object'), null, 'unknown');
  // Along another order, other numbers.
  const r = M.referenceOf(M.documentOutline(model, 'instance_of'), 'thm-heine-borel');
  eq(r.word + ' ' + r.number, 'Theorem 6', 'instance_of numbering');
});

check('kindWord', () => {
  eq(M.kindWord('definition'), 'Definition', 'capitalised');
  eq(M.kindWord('main_theorem'), 'Main theorem', 'underscores are spaces');
});

check('topLevel', () => {
  const tl = M.topLevel(model, 'refines').map((o) => o.id);
  eq(tl[0], 'sec-foundations', 'first section');
  has(tl, TYCH_ULTRA, 'edge roots are top level too');
});

// --- precomputed ancestor chains --------------------------------------------
//
// `collapseOrder` computes every object's ancestors once, topologically.  These
// check it against the obvious breadth-first walk, which is what the rest of
// the module used to do object by object.

function walkAncestors(ord, id) {
  const out = new Set();
  let frontier = M.parentsOf(ord, id);
  const seen = new Set([id]);
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.add(p);
      for (const q of M.parentsOf(ord, p)) if (!seen.has(q)) next.push(q);
    }
    frontier = next;
  }
  return out;
}

check('ancestors are precomputed for every object and agree with the walk', () => {
  for (const kind of model.collapseKinds) {
    const ord = M.collapseOrder(model, kind);
    eq(ord.cyclic.size, 0, `no cycles in ${kind}`);
    eq(ord.ancestors.size, model.objects.length, `${kind}: a chain per object`);
    for (const o of model.objects) {
      sameSet(M.ancestorsOf(ord, o.id), walkAncestors(ord, o.id), `${kind} ancestors of ${o.id}`);
      sameSet(
        M.expandableAncestorsOf(ord, o.id),
        [...walkAncestors(ord, o.id)].filter((x) => ord.expandable.has(x)),
        `${kind} expandable ancestors of ${o.id}`,
      );
    }
  }
  // The multi-parent lemma sees both branches, all the way up.
  sameSet(M.ancestorsOf(order, 'lem-diagonal'),
    ['sec-main-induction', 'sec-main', 'sec-applications'], 'both branches');
});

check('descendants are memoised without changing the answer', () => {
  const first = M.descendantsOf(order, 'sec-main');
  const second = M.descendantsOf(order, 'sec-main');
  eq(first === second, true, 'the memo hands back the same array');
  sameSet(second,
    ['sec-main-induction', 'thm-tychonoff', 'lem-finite-subcover', 'lem-diagonal'],
    'and it is still right');
});

check('a cycle in the collapse kind does not hang or poison the cache', () => {
  // Nothing `build` emits looks like this, but a hand-edited snapshot might.
  const cyc = M.buildModel({
    version: 1,
    schema: {
      defaultCollapse: 'refines',
      kinds: {
        section: { boundary: {}, countable: false, collapse: false },
        refines: {
          boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } },
          collapse: true, countable: false,
        },
      },
    },
    objects: [
      { id: 'a', kind: 'section', boundary: [], attrs: {}, body: '', depth: 0 },
      { id: 'b', kind: 'section', boundary: [], attrs: {}, body: '', depth: 0 },
      { id: 'out', kind: 'section', boundary: [], attrs: {}, body: '', depth: 0 },
      { id: 'r1', kind: 'refines', depth: 1, attrs: {}, body: '',
        boundary: [{ role: 'src', id: 'a' }, { role: 'tgt', id: 'b' }] },
      { id: 'r2', kind: 'refines', depth: 1, attrs: {}, body: '',
        boundary: [{ role: 'src', id: 'b' }, { role: 'tgt', id: 'a' }] },
    ],
    derived: {},
  });
  const ord = M.collapseOrder(cyc, 'refines');
  sameSet(ord.cyclic, ['a', 'b'], 'both ends of the cycle are flagged');
  sameSet(M.ancestorsOf(ord, 'a'), ['b'], 'ancestors still terminate');
  const v = M.makeView(cyc, 'refines', []);
  // Neither `a` nor `b` is a root, so nothing represents them; the point is
  // that asking does not loop forever.
  eq(v.rep('a').size, 0, 'rep of a cyclic object is empty rather than infinite');
  has(v.visible, 'out', 'the rest of the snapshot is unaffected');
});

// --- caches ------------------------------------------------------------------
//
// Views and quotients are memoised.  The bug to guard against is a *stale*
// cache: expanding or collapsing must never hand back an answer computed for a
// different expanded set.

check('views are memoised on the normalised expanded set', () => {
  const a = M.makeView(model, 'refines', []);
  const b = M.makeView(model, 'refines', []);
  eq(a === b, true, 'the same view comes back');
  // Normalisation happens before the lookup, so these name the same view.
  const c = M.makeView(model, 'refines', ['sec-main-induction']);
  const d = M.makeView(model, 'refines', ['sec-main', 'sec-main-induction']);
  const e = M.makeView(model, 'refines', ['sec-main-induction', 'sec-main', 'nonsense']);
  eq(c === d, true, 'upward closure lands on one view');
  eq(c === e, true, 'order and junk in the parameter do not matter');
  eq(a === c, false, 'a different expanded set is a different view');
  // Different collapse kinds never collide.
  eq(M.makeView(model, 'instance_of', []) === a, false, 'keyed by kind too');
});

check('expand then collapse returns the original view, not a stale one', () => {
  const v0 = M.makeView(model, 'refines', []);
  const q0 = M.quotient(v0);
  const v1 = v0.expand('sec-main');
  const q1 = M.quotient(v1);
  if (q1 === q0) throw new Error('the expanded view reused the collapsed quotient');
  has(v1.visible, 'thm-tychonoff', 'expanded contents are visible');
  hasNot(q1.dropped, 'uses/sec-main/sec-foundations', 'the coarse edge still has one end');

  const v2 = v1.collapse('sec-main');
  eq(v2 === v0, true, 'back to the very same view object');
  const q2 = M.quotient(v2);
  eq(q2 === q0, true, 'and to the very same quotient');
  // ... and it really is the collapsed answer, not whatever the detour left.
  sameSet(v2.visible, order.roots, 'visible = roots again');
  sameSet(
    q2.items.map((it) => it.id).filter((id) => id === TYCH_ULTRA),
    [TYCH_ULTRA],
    'the prose edge is drawn again',
  );
});

check('the quotient cache is keyed by its options as well as by the view', () => {
  const v = M.makeView(model, 'refines', []);
  const plain = M.quotient(v);
  eq(M.quotient(v) === plain, true, 'memoised');
  const withK = M.quotient(v, { includeCollapseKind: true });
  if (withK === plain) throw new Error('different options returned the cached answer');
  const drawsRefines = (q) => q.items.some((it) => it.kind === 'refines');
  eq(drawsRefines(plain), false, 'the collapse kind is normally hidden');
  eq(drawsRefines(withK), true, 'and drawn when asked for');
  const excluded = M.quotient(v, { excludeKinds: ['uses'] });
  eq(excluded.items.some((it) => it.kind === 'uses'), false, 'excludeKinds is honoured');
  eq(M.quotient(v) === plain, true, 'and the plain answer survived all that');
});

check('the view cache evicts without going stale', () => {
  // More distinct views than the cache holds, then back to the first one.
  const ids = [...order.expandable];
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    const pick = ids.filter((_, j) => ((i >> j) & 1) === 1);
    seen.push(M.makeView(model, 'refines', pick));
  }
  for (let i = 0; i < 40; i += 1) {
    const pick = ids.filter((_, j) => ((i >> j) & 1) === 1);
    const again = M.makeView(model, 'refines', pick);
    sameSet(again.expanded, seen[i].expanded, `expanded set of view ${i}`);
    sameSet(again.visible, seen[i].visible, `visible set of view ${i}`);
    const q = M.quotient(again);
    sameSet(
      q.edges.map((e) => e.id).sort(),
      M.quotient(seen[i]).edges.map((e) => e.id).sort(),
      `quotient of view ${i}`,
    );
  }
});

check('search is indexed once and memoised per query', () => {
  const naive = (q) => model.objects.filter((o) => {
    const s = q.toLowerCase();
    return o.id.toLowerCase().includes(s) ||
      M.titleOf(o).toLowerCase().includes(s) ||
      M.leanNamesOf(o).some((n) => n.toLowerCase().includes(s)) ||
      (o.body || '').toLowerCase().includes(s);
  }).map((o) => o.id);
  for (const q of ['compact', 'Tychonoff', 'ULTRAFILTER', 'tube lemma', 'zzz']) {
    sameSet(M.searchIds(model, q), naive(q), `search "${q}"`);
  }
  const a = M.searchIds(model, 'compact');
  eq(M.searchIds(model, 'compact') === a, true, 'the same query is memoised');
  eq(M.searchIds(model, '  COMPACT ') === a, true, 'and normalised before the lookup');
  eq(M.searchIds(model, '').size, 0, 'the empty query still finds nothing');
});

// --- transitive reduction ----------------------------------------------------

const arc = (src, tgt, kind = 'uses', keep = false) =>
  ({ id: `${kind}:${src}>${tgt}`, kind, src, tgt, keep });

check('transitive reduction: the issue’s triangle loses its long side', () => {
  const hidden = M.transitiveReduction([arc('A', 'B'), arc('B', 'C'), arc('A', 'C')]);
  sameSet(hidden, ['uses:A>C'], 'hidden');
});

check('transitive reduction: a longer chain implies every shortcut', () => {
  const arcs = [arc('a', 'b'), arc('b', 'c'), arc('c', 'd'), arc('a', 'c'), arc('a', 'd'), arc('b', 'd')];
  sameSet(M.transitiveReduction(arcs), ['uses:a>c', 'uses:a>d', 'uses:b>d'], 'hidden');
  // a diamond is already reduced
  const diamond = [arc('a', 'b'), arc('a', 'c'), arc('b', 'd'), arc('c', 'd')];
  eq(M.transitiveReduction(diamond).size, 0, 'nothing in a diamond is implied');
});

check('transitive reduction is per kind', () => {
  const hidden = M.transitiveReduction([
    arc('A', 'B', 'uses'), arc('B', 'C', 'generalises'), arc('A', 'C', 'uses'),
    arc('A', 'B', 'other'), arc('B', 'C', 'other'), arc('A', 'C', 'other'),
  ]);
  sameSet(hidden, ['other:A>C'], 'only a path of the same kind implies an arc');
});

check('transitive reduction: kept arcs are paths but stay', () => {
  // A junction J of kind uses with src end A and tgt end C, plus A -> C direct
  // through another route: the spokes imply nothing is lost, and stay.
  const hidden = M.transitiveReduction([
    arc('A', 'J', 'uses', true), arc('J', 'C', 'uses', true), arc('A', 'C'),
    arc('X', 'Y', 'uses', true), arc('Y', 'Z', 'uses', true), arc('X', 'Z', 'uses', true),
  ]);
  sameSet(hidden, ['uses:A>C'], 'the arc goes, the spokes and the kept shortcut stay');
});

check('transitive reduction on a cyclic graph works on the condensation', () => {
  // Both orientations of a triangle: every arc is implied by the others, but
  // they cannot all go.  Inside a cycle nothing is hidden.
  const tri = [arc('a', 'b'), arc('b', 'c'), arc('c', 'a'), arc('b', 'a'), arc('c', 'b'), arc('a', 'c')];
  eq(M.transitiveReduction(tri).size, 0, 'nothing inside a strongly connected component');
  // A 2-cycle s <-> m, both pointing at f: the two arcs into f join the same
  // pair of components, so neither is preferred and both stay ...
  eq(M.transitiveReduction([arc('s', 'm'), arc('m', 's'), arc('s', 'f'), arc('m', 'f')]).size, 0,
    'two arcs between the same components');
  // ... but a third component in between does imply the shortcut.
  sameSet(M.transitiveReduction([
    arc('s', 'm'), arc('m', 's'), arc('m', 'x'), arc('x', 'f'), arc('s', 'f'),
  ]), ['uses:s>f'], 'a shortcut past a further component');
  // Self loops and dangling arcs are ignored rather than fatal.
  eq(M.transitiveReduction([arc('a', 'a'), { id: 'z', kind: 'uses', src: null, tgt: 'b' }]).size, 0,
    'degenerate arcs');
});

check('transitive reduction matches its definition on random graphs', () => {
  // Brute force against the doc comment: u -> v is hidden exactly when u and v
  // are in different components and some node w, in neither of their
  // components, lies on a path from u to v.  And hiding all of them loses no
  // reachability.
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const reach = (arcs, from) => {
    const out = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const u = stack.pop();
      for (const a of arcs) if (a.src === u && !out.has(a.tgt)) { out.add(a.tgt); stack.push(a.tgt); }
    }
    return out;
  };
  for (let round = 0; round < 40; round += 1) {
    const n = 4 + rand(9);
    const arcs = [];
    const seen = new Set();
    for (let k = 0; k < n * 2; k += 1) {
      const s = rand(n);
      const t = rand(n);
      // mostly forward, so most graphs are acyclic and some are not
      if (s === t || seen.has(s + '>' + t) || (s > t && rand(6) !== 0)) continue;
      seen.add(s + '>' + t);
      arcs.push(arc(String(s), String(t)));
    }
    const hidden = M.transitiveReduction(arcs);
    const nodes = [...Array(n).keys()].map(String);
    const R = new Map(nodes.map((x) => [x, reach(arcs, x)]));
    const sameComp = (x, y) => R.get(x).has(y) && R.get(y).has(x);
    for (const a of arcs) {
      const expected = !sameComp(a.src, a.tgt) && nodes.some((w) =>
        !sameComp(w, a.src) && !sameComp(w, a.tgt) && R.get(a.src).has(w) && R.get(w).has(a.tgt));
      eq(hidden.has(a.id), expected, `round ${round}: ${a.id} hidden`);
    }
    const left = arcs.filter((a) => !hidden.has(a.id));
    for (const a of arcs) {
      eq(reach(left, a.src).has(a.tgt), true, `round ${round}: ${a.tgt} still reachable from ${a.src}`);
    }
  }
});

check('the sample: hiding implied arcs on the drawn quotient', () => {
  // Fully collapsed, sec-main and sec-applications use each other and both
  // use sec-foundations: one component pointing at another twice, so the
  // cycle guard keeps both arcs.  The prose edge TYCH_ULTRA is drawn as a
  // junction, and the lemmas refining it give it uses-arcs of its own, to
  // sec-main and to sec-foundations: the second goes through the first's
  // component, so it is implied.
  const arcsOf = (q) => q.edges.filter((e) => e.type === 'edge' && e.directed)
    .map((e) => ({ id: e.id, kind: e.kind, src: e.src, tgt: e.tgt }));
  const hidden = M.transitiveReduction(arcsOf(qCollapsed));
  sameSet(hidden, [edgeFor(qCollapsed, TYCH_ULTRA, 'sec-foundations', 'uses').id], 'hidden');
  for (const [s, t] of [['sec-main', 'sec-foundations'], ['sec-applications', 'sec-foundations'],
    ['sec-main', 'sec-applications'], ['sec-applications', 'sec-main']]) {
    hasNot(hidden, edgeFor(qCollapsed, s, t, 'uses').id, `${s} -> ${t}`);
  }
  // The instance_of arc between the same nodes is another kind: untouched.
  hasNot(hidden, edgeFor(qCollapsed, TYCH_ULTRA, 'sec-main', 'instance_of').id, 'instance_of');
});

// --- proofs (DESIGN 2.5) ---------------------------------------------------

check('a proof stands for its statement', () => {
  eq(M.attachedTo(model.byId.get(PROOF)), 'thm-heine-borel', 'attached to its statement');
  eq(M.isAttachedKind(model, 'proof'), true, 'proof is an attached kind');
  hasNot(M.edgeKinds(model), 'proof', 'proofs are not an edge kind of the graph');
  sameSet(vAll.rep(PROOF), ['thm-heine-borel'], 'expanded: the statement');
  const vC = M.makeView(model, 'refines', []);
  sameSet(vC.rep(PROOF), vC.rep('thm-heine-borel'), 'collapsed: wherever the statement is');
});

check("a proof's uses are the statement's, declared while it is visible", () => {
  const PU = 'uses/proof~thm-heine-borel/lem-finite-subcover';
  eq(stateOf(qAll, 'thm-heine-borel', 'lem-finite-subcover', 'uses'), 'declared-only',
    'expanded: a declared arc of the statement');
  const it = itemById(qAll, PU);
  sameSet(it.ends.map((e) => e.id), ['thm-heine-borel', 'lem-finite-subcover'], 'drawn between the statement and its target');
  // Collapsed, the statement is inside sec-applications and the lemma inside
  // sec-main: the proof's edge is a detail deriving an arc between them.
  const rec = qCollapsed.consistency.get(M.pairKey('sec-applications', 'sec-main', 'uses'));
  ok(rec && rec.derived.includes(PU), 'collapsed: derives the sections\' arc');
});

check('a proof is introduced by what it proves', () => {
  const p = (title) => ({ kind: 'proof', boundary: [], attrs: title ? { title } : {} });
  eq(M.proofLeadRest(p()), '.', 'untitled');
  eq(M.proofLeadRest(p('of the detailed form')), ' of the detailed form.', 'what it proves');
  eq(M.proofLeadRest(p('by induction')), ' (by induction).', 'anything else');
});

check('the document files a proof under its statement', () => {
  const outline = M.documentOutline(model, 'refines');
  sameSet((outline.proofs.get('thm-heine-borel') || []).map((o) => o.id), [PROOF], 'filed');
  eq(outline.stepOf.get(PROOF), 'thm-heine-borel', 'read with its statement');
  eq(outline.byId.has(PROOF), false, 'no entry of its own');
  eq(M.referenceOf(outline, PROOF), null, 'no number');
  eq(M.documentPageOf(outline, PROOF), M.documentPageOf(outline, 'thm-heine-borel'), 'on its statement\'s page');
});

check('a proof with details of its own is read after its statement, not at the top', () => {
  const node = (id, kind, body = 'text') => ({ id, kind, boundary: [], attrs: {}, body, depth: 0 });
  const edge = (kind, src, tgt) => ({ id: `${kind}/${src}/${tgt}`, kind, attrs: {}, body: '', depth: 1,
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }] });
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  const proof = (id, of) => ({ id, kind: 'proof', attrs: {}, body: 'by the lemmas', depth: 1, boundary: [{ role: 'of', id: of }] });
  const m = M.buildModel({
    version: 1,
    schema: { defaultCollapse: 'refines', kinds: {
      section: { boundary: {} }, theorem: { boundary: {} }, lemma: { boundary: {} },
      refines: { ...binary, collapse: true }, proof: { boundary: { of: { min: 1, max: 1 } } } } },
    objects: [
      node('sec', 'section'), node('thm', 'theorem'), node('detail', 'lemma'), node('aux', 'lemma'),
      proof('proof/thm', 'thm'), edge('refines', 'thm', 'sec'), edge('refines', 'aux', 'thm'),
      edge('refines', 'detail', 'proof/thm'),
      // A proof whose statement is one of its own details keeps its place.
      node('odd', 'lemma'), proof('proof/odd', 'odd'), edge('refines', 'odd', 'proof/odd'),
    ],
  });
  const outline = M.documentOutline(m, 'refines');
  const flow = outline.entries.map((e) => e.id);
  eq(flow.join(' '), 'proof/odd odd sec thm proof/thm detail aux', 'reading order');
  eq(outline.byId.get('proof/thm').parent.id, 'thm', 'under its statement');
  eq(outline.byId.get('sec').number, '1', 'the headings numbered among themselves');
  eq(outline.byId.get('proof/thm').number, '1.2', 'the next statement of the chapter');
  eq(outline.byId.get('detail').number, '1.3', 'its details below it, and after it');
  eq(outline.byId.get('aux').number, '1.4', 'before what refines the statement');
  eq(outline.byId.get('proof/odd').parent, null, 'the odd one stays a root, so both are still read');
});

// --- appendices and hidden objects -------------------------------------------
//
// `graph = "optional"` (an appendix) is drawn unless the reader hides it,
// `graph = "never"` (a hidden object) is never drawn; either way what is below
// it, what is attached to it and what touches it go too.

const appendixSnapshot = () => {
  const node = (id, kind) => ({ id, kind, boundary: [], attrs: {}, body: 'text', depth: 0 });
  const edge = (kind, src, tgt, id = `${kind}/${src}/${tgt}`) => ({
    id, kind, attrs: {}, body: '', depth: 1,
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }],
  });
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  return {
    version: 1,
    schema: {
      defaultCollapse: 'refines',
      kinds: {
        section: { boundary: {} },
        appendix: { boundary: {}, graph: 'optional' },
        hidden: { boundary: {}, graph: 'never' },
        theorem: { boundary: {}, countable: true },
        lemma: { boundary: {}, countable: true },
        refines: { ...binary, collapse: true },
        uses: binary,
        proof: { boundary: { of: { min: 1, max: 1 } } },
      },
    },
    objects: [
      node('main', 'section'),
      node('thm', 'theorem'),
      node('intro', 'hidden'),
      node('app', 'appendix'),
      node('aux', 'lemma'),
      edge('refines', 'thm', 'main'),
      edge('refines', 'intro', 'main'),
      edge('refines', 'aux', 'app'),
      edge('uses', 'thm', 'aux'),
      edge('uses', 'thm', 'intro'),
      { id: 'proof/aux', kind: 'proof', attrs: {}, body: 'by hand', depth: 1,
        boundary: [{ role: 'of', id: 'aux' }] },
    ],
    derived: { status: { thm: 'stated', aux: 'proved' } },
  };
};

check('the graph never draws a hidden object, or what touches it', () => {
  const m = M.buildModel(appendixSnapshot());
  eq(M.graphHint(m, 'hidden'), 'never', 'hint of hidden');
  eq(M.graphHint(m, 'appendix'), 'optional', 'hint of appendix');
  eq(M.graphHint(m, 'theorem'), 'always', 'no hint means always');
  sameSet(M.outOfGraph(m), ['intro', 'refines/intro/main', 'uses/thm/intro'], 'out of the graph');
  const gm = M.graphModel(m);
  eq(gm === M.graphModel(m), true, 'memoised');
  eq(gm.byId.has('intro'), false, 'the hidden object is gone');
  eq(gm.byId.has('aux'), true, 'the appendix is kept by default');
  const q = M.quotient(M.makeView(gm, 'refines', ['main', 'app']));
  ok(!q.items.some((it) => it.ends.some((e) => e.id === 'intro')), 'no arc reaches it');
  // The document reads it all the same, as text: where it stands, numbered
  // not at all, and taking no number from the statement after it.
  const outline = M.documentOutline(m, 'refines');
  const intro = outline.byId.get('intro');
  ok(intro, 'in the document');
  eq(intro.text, true, 'a piece of text');
  eq(intro.number, null, 'with no number');
  eq(intro.parent && intro.parent.id, 'main', 'inside its section');
  const flow = outline.entries.map((e) => e.id);
  ok(flow.indexOf('intro') < flow.indexOf('thm'), 'before the theorem, by id');
  eq(outline.byId.get('thm').number, outline.byId.get('main').number + '.1',
    'the theorem is still the section\'s first');
  eq(outline.byId.get('thm').text, false, 'a statement is not text');
  eq(M.referenceOf(outline, 'intro'), null, 'nothing to refer to it by');
  eq(M.documentPageOf(outline, 'intro'), 'main', 'read on its section\'s page');
  // Text at the top level is read on the top level written out, not on the
  // contents.
  const snap = appendixSnapshot();
  snap.objects = snap.objects.filter((o) => o.id !== 'refines/intro/main');
  const top = M.documentOutline(M.buildModel(snap), 'refines');
  eq(top.byId.get('intro').depth, 0, 'text at the top level');
  eq(M.documentPageOf(top, 'intro'), null, 'is read on the top page');
  eq(M.documentPageShows(top, null, 0, 'intro'), false, 'which the contents do not write out');
  eq(M.documentPageShows(top, null, 1, 'intro'), true, 'the top level written out does');
});

check('matter is a section to the reader and nothing to the graph', () => {
  const node = (id, kind) => ({ id, kind, boundary: [], attrs: { title: id }, body: 'text', depth: 0 });
  const edge = (kind, src, tgt) => ({ id: `${kind}/${src}/${tgt}`, kind, attrs: {}, body: '', depth: 1,
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }] });
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  const m = M.buildModel({
    version: 1,
    schema: { defaultCollapse: 'refines', kinds: {
      chapter: { boundary: {} }, matter: { boundary: {}, graph: 'never' },
      theorem: { boundary: {} }, remark: { boundary: {} },
      refines: { ...binary, collapse: true }, uses: binary } },
    objects: [
      { ...node('intro', 'matter'), attrs: { title: 'Introduction', order: 1 } }, node('motive', 'remark'),
      { ...node('ch', 'chapter'), attrs: { title: 'Chapter', order: 2 } }, node('thm', 'theorem'),
      { ...node('refs', 'matter'), attrs: { title: 'References', order: 9 } },
      edge('refines', 'motive', 'intro'), edge('refines', 'thm', 'ch'), edge('uses', 'thm', 'motive'),
    ],
  });
  ok(M.isSectionKind('matter'), 'a heading');
  eq(M.graphHint(m, 'matter'), 'never', 'never drawn');
  sameSet(M.outOfGraph(m), ['intro', 'motive', 'refs', 'refines/motive/intro', 'uses/thm/motive'],
    'out of the graph, contents and the relations touching them along');
  const gm = M.graphModel(m);
  ok(gm.byId.has('thm') && gm.byId.has('ch'), 'the rest is drawn');
  const outline = M.documentOutline(m, 'refines');
  const num = (id) => outline.byId.get(id).number;
  eq(num('intro'), '1', 'numbered among the headings');
  eq(num('ch'), '2', 'the chapter after it counts on');
  eq(num('motive'), '1.1', 'a statement in it numbered in it, as in a chapter');
  eq(num('refs'), '3', 'where its order puts it');
  ok(M.isContentsEntry(outline.byId.get('intro')), 'a row in the contents');
  const r = M.referenceOf(outline, 'intro');
  eq(r.word + ' ' + r.number, 'Section 1', 'referred to as a section');
  eq(M.kindWord('matter'), 'Section', 'its lead word');
});

check('the arcs between nodes are exactly the rule, in every expanded set', () => {
  // For nodes A and B of a view: A -> B exactly when A, or something inside
  // A, has an edge to B itself, or A itself has one to B or to something
  // inside B.  An arc drawn through a junction (an edge with lemmas of its
  // own) counts as drawn; arcs to or from such junction nodes are not between
  // two nodes and are left out on both sides.
  const kind = 'refines';
  const order = M.collapseOrder(model, kind);
  const expandable = [...order.expandable];
  const inside = (id) => new Set([id, ...M.descendantsOf(order, id)]);
  let states = 0;
  let arcs = 0;
  for (let mask = 0; mask < 1 << expandable.length; mask += 1) {
    const v = M.makeView(model, kind, expandable.filter((_, i) => mask & (1 << i)));
    const nodes = [...v.visible].filter((id) => model.byId.get(id).boundary.length === 0);
    const isNode = new Set(nodes);
    const drawn = new Set();
    for (const e of M.ownEdges(v, M.quotient(v).edges)) {
      if (e.type === 'edge' && e.directed) {
        if (isNode.has(e.src) && isNode.has(e.tgt)) drawn.add(`${e.src} -> ${e.tgt} ${e.kind}`);
      } else if (e.type === 'junction') {
        const ends = e.members[0].ends.filter((x) => isNode.has(x.id));
        for (const a of ends.filter((x) => x.roles.includes('src'))) {
          for (const b of ends.filter((x) => x.roles.includes('tgt'))) {
            if (a.id !== b.id) drawn.add(`${a.id} -> ${b.id} ${e.kind}`);
          }
        }
      }
    }
    const want = new Set();
    for (const o of model.objects) {
      if (o.kind === kind || !M.isBinaryKind(model, o.kind)) continue;
      const s = v.anchor(M.boundaryEntry(o, 'src'));
      const t = v.anchor(M.boundaryEntry(o, 'tgt'));
      for (const a of nodes) {
        for (const b of nodes) {
          if (a !== b && ((inside(a).has(s) && t === b) || (s === a && inside(b).has(t)))) want.add(`${a} -> ${b} ${o.kind}`);
        }
      }
    }
    const key = [...v.expanded].sort().join(',') || 'nothing';
    sameSet([...drawn], [...want], `expanded: ${key}`);
    states += 1;
    arcs += want.size;
  }
  eq(states, 32, 'every expanded set');
  ok(arcs > 100, `the rule has arcs to check: ${arcs}`);
});

check('hide_content leaves an entry with a page off its parent\'s page, and nothing else', () => {
  const snap = JSON.parse(JSON.stringify(snapshot));
  const set = (id, v) => { const o = snap.objects.find((x) => x.id === id); o.attrs = { ...(o.attrs || {}), hide_content: v }; };
  set('sec-main', true);
  set('sec-main-induction', 'Yes');
  set('def-compact', true); // a leaf: no page of its own, never hidden
  const m = M.buildModel(snap);
  const out = M.documentOutline(m, 'refines');
  eq(M.hidesContent(m.byId.get('sec-main')), true, 'true');
  eq(M.hidesContent(m.byId.get('sec-main-induction')), true, '"yes", in any case');
  eq(M.hidesContent(m.byId.get('sec-foundations')), false, 'not set');
  eq(M.hidesContent({ attrs: { hide_content: 'no' } }), false, '"no"');
  eq(M.isHiddenEntry(out, out.byId.get('sec-main')), true, 'a chapter');
  eq(M.isHiddenEntry(out, out.byId.get('def-compact')), false, 'a leaf is never hidden');
  // Numbers and the contents are untouched.
  eq(out.byId.get('sec-main').number, '2', 'its number');
  eq(out.byId.get('thm-heine-borel').number, '3.1', 'the numbers after it');
  // Links lead to its own page, where it is the head.
  eq(M.documentLevelOf(out, 'sec-main'), 'sec-main', 'a hidden chapter is read on its own page');
  eq(M.documentLevelOf(out, 'sec-main-induction'), 'sec-main-induction', 'so is a hidden section');
  eq(M.documentLevelOf(out, 'thm-tychonoff'), 'sec-main', 'its children are read where they were');
  eq(M.documentLevelOf(out, 'def-compact'), 'sec-foundations', 'and so is the leaf');
  // The top page leaves it out; its own page shows it; its children stay.
  const ids = (page, levels) => M.documentPageEntries(out, page, levels).map((e) => e.id);
  ok(!ids(null, 1).includes('sec-main'), 'on the top page');
  ok(ids(null, 1).includes('sec-foundations') && ids(null, 1).includes('def-compact') === false, 'the others are there');
  ok(ids(null, 2).includes('thm-tychonoff') && !ids(null, 2).includes('sec-main-induction'),
    'two levels down: its children, but not the hidden one among them');
  eq(ids('sec-main', 1)[0], 'sec-main', 'its own page heads with it');
  ok(!ids('sec-main', 1).includes('sec-main-induction') && ids('sec-main', 1).includes('thm-tychonoff'), 'and leaves out 2.1');
  eq(ids('sec-main-induction', 1)[0], 'sec-main-induction', '2.1 on its own page');
  eq(M.documentPageShows(out, null, 1, 'sec-main'), false, 'the top page does not show it');
  eq(M.documentPageShows(out, 'sec-main', 1, 'sec-main'), true, 'its own page does');
  eq(M.documentPageShows(out, 'sec-foundations', 1, 'def-compact'), true, 'the leaf is shown');
});

// A copy of the sample with a References section of bibliography entries,
// and a definition that cites them.
function withReferences() {
  const snap = JSON.parse(JSON.stringify(snapshot));
  const add = (o) => snap.objects.push({ boundary: [], attrs: {}, body: '', depth: 0, ...o });
  add({ id: 'sec-refs', kind: 'section', attrs: { title: 'References', order: 99 } });
  const ref = (id, attrs, body = '') => {
    add({ id, kind: 'reference', attrs, body });
    add({ id: `refines/${id}/sec-refs`, kind: 'refines', depth: 1,
      boundary: [{ role: 'src', id }, { role: 'tgt', id: 'sec-refs' }] });
  };
  ref('del80', { author: ['P. Deligne'], title: 'La conjecture de Weil. II', journal: 'Publ. Math. IHÉS', volume: '52', year: '1980', pages: '137-252' });
  ref('del74', { author: ['P. Deligne'], title: 'La conjecture de Weil. I', journal: 'Publ. Math. IHÉS', volume: '43', year: '1974', pages: '273-307', url: 'https://example.org/del74' });
  ref('bbd', { author: ['A. Beilinson', 'J. Bernstein', 'P. Deligne'], title: 'Faisceaux pervers', series: 'Astérisque', volume: '100', publisher: 'Soc. Math. France', year: '1982', type: 'book' });
  ref('sga4', { label: 'SGA4', editor: ['M. Artin', 'A. Grothendieck', 'J.-L. Verdier'], title: 'Théorie des topos', series: 'Lecture Notes in Mathematics', volume: '269, 270, 305', publisher: 'Springer', year: '1972–1973', type: 'book' });
  ref('x1', { author: 'A. Bhatt and P. Scholze', title: 'B', year: '2015' });
  ref('x2', { author: ['A. Bhatt', 'P. Scholze'], title: 'A', year: '2015' });
  ref('many', { author: ['A. One', 'B. Two', 'C. Three', 'D. Four', 'E. Five'], title: 'Many', year: '2001' });
  ref('free', {}, 'Some free-form entry, [online](https://example.org).');
  return M.buildModel(snap);
}

check('references: alphabetic labels as BibTeX alpha makes them', () => {
  const m = withReferences();
  const L = (id) => M.referenceLabelOf(m, id);
  eq(L('del74'), 'Del74', 'one author: three letters and the year');
  eq(L('del80'), 'Del80', 'the same author, another year');
  eq(L('bbd'), 'BBD82', 'two to four authors: their initials');
  eq(L('sga4'), 'SGA4', 'an explicit label');
  eq(L('x2'), 'BS15a', 'a clash is told apart by a, b in the order of the titles');
  eq(L('x1'), 'BS15b', '"A and B" is a list of names too');
  eq(L('many'), 'OTT+01', 'more than four: three initials and +');
  eq(M.referenceLabelOf(m, 'def-compact'), null, 'not a reference');
});

check('references: a label of its own is never taken again or suffixed', () => {
  const mk = (objs) => ({ objects: objs, byId: new Map(objs.map((o) => [o.id, o])) });
  const r = (id, attrs) => ({ id, kind: 'reference', boundary: [], attrs, body: '' });
  const L = (objs) => [...M.referenceLabels(mk(objs))].map(([id, l]) => id + '=' + l).sort().join(' ');
  eq(L([r('f', { author: ['P. Deligne'], year: '1974' }), r('e', { author: ['P. Deligne'], year: '1974', label: 'Del74' })]),
    'e=Del74 f=Del74a', 'the explicit one keeps it, whatever the order');
  eq(L([r('e', { author: ['P. Deligne'], year: '1974', title: 'A' }), r('f', { author: ['P. Deligne'], year: '1974', title: 'B' }), r('k', { author: ['P. Deligne'], year: '1974', title: 'C' })]),
    'e=Del74a f=Del74b k=Del74c', 'a three-way clash');
  eq(L([r('x', { author: ['P. Deligne'], year: '1974', title: 'A' }), r('y', { author: ['P. Deligne'], year: '1974', title: 'B' }), r('z', { label: 'Del74a' })]),
    'x=Del74b y=Del74c z=Del74a', 'a suffix is not given twice');
  eq(L([r('c1', { label: 'del80' }), r('c2', { author: ['P. Deligne'], year: '1980' })]), 'c1=del80 c2=Del80a', 'case aside');
  eq(L([r('o', { author: 'A. Alpha and B. Beta and others', year: '2001' }), r('j', { author: ['J. Smith Jr.'], year: '1990' }), r('s', { author: ['A. Bee'], year: '1974/75' })]),
    'j=Smi90 o=AB+01 s=Bee75', '"and others", "Jr.", the last two digits');
  eq(L([r('a', { author: ['A. van Dam', 'B. Cee'], year: '1999' }), r('b', { author: ['Ludwig van Beethoven'], year: '1800' }), r('d', { author: ['{van Dam}, A.'], year: '1990' })]),
    'a=vDC99 b=vB00 d=van90', 'a "von" part: its initials, then the family name\'s; braces keep words together');
});

check('references: an entry in the order and punctuation of alpha', () => {
  const m = withReferences();
  const md = (id) => M.referenceMarkdown(m.byId.get(id));
  eq(md('del74'), 'P. Deligne. [La conjecture de Weil. I](https://example.org/del74). *Publ. Math. IHÉS*, 43:273–307, 1974.', 'an article, its title linked');
  eq(md('bbd'), 'A. Beilinson, J. Bernstein, and P. Deligne. *Faisceaux pervers*, volume 100 of *Astérisque*. Soc. Math. France, 1982.', 'a book in a series');
  eq(md('sga4'), 'M. Artin, A. Grothendieck, and J.-L. Verdier, editors. *Théorie des topos*, volumes 269, 270, 305 of *Lecture Notes in Mathematics*. Springer, 1972–1973.', 'editors, several volumes');
  eq(md('free'), 'Some free-form entry, [online](https://example.org).', 'no title: the prose alone');
  eq(M.displayBody(m.byId.get('del80')), md('del80'), 'what a reference reads as');
});

check('references: citations name references, and only references', () => {
  const m = withReferences();
  const c = (s) => JSON.stringify(M.parseCitation(m, s));
  eq(c('del74, del80'), JSON.stringify({ items: ['del74', 'del80'], locator: '' }), 'two references');
  eq(c('sga4, Exp. X, Cor. 4.3'), JSON.stringify({ items: ['sga4'], locator: 'Exp. X, Cor. 4.3' }), 'one with a locator');
  eq(M.parseCitation(m, '0, 1'), null, 'an interval');
  eq(M.parseCitation(m, 'def-compact, 2'), null, 'an object that is not a reference');
  const re = new RegExp(M.CITE_PATTERN);
  eq(re.exec('see [sga4, Exp. X] there')[1], 'sga4, Exp. X', 'the pattern finds it');
  eq(re.test('see [sga4] there'), false, 'a single id is SLUG_PATTERN\'s');
  eq(re.test('[sga4, x](https://e.org)'), false, 'not a Markdown link');
});

check('references: read in place under their labels, sorted by them', () => {
  const m = withReferences();
  const out = M.documentOutline(m, 'refines');
  const sec = out.byId.get('sec-refs');
  eq(sec.children.map((e) => e.id).join(' '), 'bbd x2 x1 del74 del80 free many sga4', 'by label: BBD82 BS15a BS15b Del74 Del80 fre OTT+01 SGA4');
  const e = out.byId.get('del74');
  eq(e.text && e.reference, true, 'text, and a reference');
  eq(e.number, null, 'no number');
  eq(e.label, 'Del74', 'its label');
  const ref = M.referenceOf(out, 'del74');
  eq(ref.cite && ref.number, 'Del74', 'a reference to it is its label');
  eq(out.byId.get('sec-refs').number !== null, true, 'the section is numbered as before');
});

check('hiding the appendix takes its contents and their relations along', () => {
  const m = M.buildModel(appendixSnapshot());
  sameSet(M.outOfGraph(m, { hideOptional: true }), [
    'intro', 'refines/intro/main', 'uses/thm/intro',
    'app', 'aux', 'refines/aux/app', 'uses/thm/aux', 'proof/aux',
  ], 'out of the graph');
  const gm = M.graphModel(m, { hideOptional: true });
  eq(gm === M.graphModel(m), false, 'a model of its own');
  sameSet(M.visibleNodes(M.makeView(gm, 'refines', ['main'])).map((o) => o.id), ['thm'],
    'only the main section\'s theorem is left');
  eq(M.quotient(M.makeView(gm, 'refines', [])).items.length, 0, 'nothing is drawn between what is left');
  // Shown, the appendix is a section like any other.
  ok(M.isSectionKind(m.byId.get('app').kind), 'a heading, as a section is');
  eq(M.referenceOf(M.documentOutline(m, 'refines'), 'app').word, 'Appendix', 'referred to as an appendix');
  // A snapshot with nothing to leave out is drawn from its own model.
  eq(M.graphModel(model, { hideOptional: true }), model, 'the sample has no appendix');
});

check('a chapter and a subsection are headings, as a section is; a question is not', () => {
  const types = { _types: new Map() };
  for (const kind of ['chapter', 'section', 'subsection']) ok(M.isSectionKind(kind), `${kind} is set as a heading`);
  ok(!M.isSectionKind('question'), 'a question is not a heading');
  eq(M.nodeType(types, { id: 'c', kind: 'chapter' }).mark, 'chap', 'a chapter\'s mark');
  eq(M.nodeType(types, { id: 'q', kind: 'question' }).mark, 'q?', 'a question\'s mark');
  eq(M.nodeType(types, { id: 'x', kind: 'example' }).mark, 'ex', 'an example\'s mark');
  eq(M.kindWord('question'), 'Question', 'referred to as a question');
});

// A proof is read where its file puts it, as any node is: in the section of
// its directory, where its `order` puts it.  Unmoved, it stays with its
// statement.
const placedProofsSnapshot = () => {
  const node = (id, kind, file, order) => ({
    id, kind, boundary: [], attrs: order === undefined ? {} : { order }, body: 'text of ' + id, depth: 0,
    source: { file, anonymous: false },
  });
  const edge = (kind, src, tgt) => ({
    id: `${kind}/${src}/${tgt}`, kind, attrs: {}, body: '', depth: 1,
    boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }], source: { file: 'x.md', anonymous: true },
  });
  const proof = (of, file, order, id = 'proof/' + of) => ({
    id, kind: 'proof', attrs: order === undefined ? {} : { order }, body: 'proof of ' + of, depth: 1,
    boundary: [{ role: 'of', id: of }], source: { file, anonymous: false },
  });
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  return {
    version: 1,
    schema: {
      defaultCollapse: 'refines',
      kinds: {
        section: { boundary: {} },
        hidden: { boundary: {}, graph: 'never' },
        theorem: { boundary: {}, countable: true },
        lemma: { boundary: {}, countable: true },
        refines: { ...binary, collapse: true },
        uses: binary,
        proof: { boundary: { of: { min: 1, max: 1 } } },
      },
    },
    objects: [
      node('chap', 'section', 'blueprint/chap/_section.md', 1),
      node('sa', 'section', 'blueprint/chap/a/_section.md', 1),
      node('sb', 'section', 'blueprint/chap/b/_section.md', 2),
      { ...node('sc', 'section', 'blueprint/chap/c/_section.md', 3), body: '' },
      node('thm', 'theorem', 'blueprint/chap/a/thm.md', 1),
      node('note', 'hidden', 'blueprint/chap/a/note.md', 2),
      node('lem', 'lemma', 'blueprint/chap/a/lem.md', 4),
      node('lemb', 'lemma', 'blueprint/chap/b/lemb.md', 1),
      // moved within its section: after the note between them
      proof('thm', 'blueprint/chap/a/thm.proof.md', 3),
      // moved to another section, no order of its own
      proof('lem', 'blueprint/chap/b/lem.proof.md'),
      // unmoved: next to its statement, no order
      proof('lemb', 'blueprint/chap/b/lemb.proof.md'),
      // a second proof, alone in a section with no prose of its own
      proof('thm', 'blueprint/chap/c/thm-again.proof.md', undefined, 'proof/thm-again'),
      edge('refines', 'sa', 'chap'), edge('refines', 'sb', 'chap'), edge('refines', 'sc', 'chap'),
      edge('refines', 'thm', 'sa'), edge('refines', 'note', 'sa'), edge('refines', 'lem', 'sa'),
      edge('refines', 'lemb', 'sb'),
      edge('uses', 'proof/thm', 'lemb'),
    ],
  };
};

check('a proof is read where its file puts it, as any node is, and stays with its statement unmoved', () => {
  const m = M.buildModel(placedProofsSnapshot());
  const out = M.documentOutline(m, 'refines');
  const kids = (id) => out.byId.get(id).children.map((e) => e.id).join(' ');
  eq(kids('sa'), 'thm note proof/thm lem', 'moved by its order: after the note between it and its statement');
  eq(kids('sb'), 'lemb proof/lem', 'moved to the section of its file, after what has an order');
  eq(kids('chap'), 'sa sb sc', 'a section holding only a proof is read too');
  eq(kids('sc'), 'proof/thm-again', 'with the proof in it');
  const p = out.byId.get('proof/thm');
  ok(p.proof && !p.text, 'an entry set as a proof');
  eq(p.number, null, 'with no number');
  eq(out.byId.get('lem').number, '1.2', 'and taking none from its siblings');
  eq(out.byId.get('lemb').number, '1.3', 'nor in the other section');
  eq(out.byId.get('sb').number, '1.2', 'the sections numbered among themselves');
  eq((out.proofs.get('lemb') || []).map((x) => x.id).join(' '), 'proof/lemb', 'an unmoved proof is filed under its statement');
  eq(out.proofs.get('thm'), undefined, 'a moved one is not');
  eq(out.byId.get('proof/lemb'), undefined, 'and is no entry');
  // Where it is read, and how it is named there.
  eq(M.documentPageOf(out, 'proof/thm'), 'sa', 'read on its section\'s page');
  eq(M.documentLevelOf(out, 'proof/lem'), 'sb', 'and the other on the other section\'s');
  eq(M.referenceOf(out, 'proof/thm'), null, 'no number to refer to it by');
  eq(M.proofLeadAway(m, out, m.byId.get('proof/lem')), ' of Lemma 1.2.', 'away from its statement: what it proves');
  eq(M.proofLeadRest(m.byId.get('proof/thm')), '.', 'right after it: "Proof." as ever');
  // The graph is left alone: no node for a proof, and its uses are its statement's.
  const view = M.makeView(m, 'refines', ['chap', 'sa', 'sb']);
  ok(!M.visibleNodes(view).some((o) => o.kind === 'proof'), 'no proof drawn');
  eq(view.anchor('proof/thm'), 'thm', 'a moved proof stands for its statement');
  eq(M.parentsOf(M.collapseOrder(m, 'refines'), 'proof/lem').length, 0, 'below nothing in the collapse order');
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
