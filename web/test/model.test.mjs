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
  eq(model.objects.length, 53, 'object count');
  eq(model.byId.size, 53, 'byId size');
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
  for (const id of all.visible) sameSet(all.rep(id), [id], `rep of visible ${id}`);
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
  eq(qCollapsed.internal.size, 1, 'no other container has internal edges here');
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
  const codes = model.checks.map((c) => c.code);
  has(codes, 'undeclared-edge', 'check codes');
  has(codes, 'unwitnessed-edge', 'check codes');
  // unwitnessed-edge names the declared-only pair
  const unwitnessed = model.checks.find((c) => c.code === 'unwitnessed-edge');
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
  eq(qAll.internal.size, 0, 'nothing is internal when nothing is collapsed');
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

check('checks by level and by object', () => {
  const byLevel = M.checksByLevel(model);
  eq(byLevel.get('error').length, 1, 'one error');
  eq(byLevel.get('warning').length, 3, 'three warnings');
  eq(byLevel.get('info').length, 4, 'four infos');
  const forDiagonal = M.checksFor(model, 'lem-diagonal');
  eq(forDiagonal.length, 1, 'lem-diagonal is flagged');
  eq(forDiagonal[0].code, 'multi-parent', 'multi-parent lint');
  for (const c of model.checks) {
    for (const id of c.objects || []) {
      if (!model.byId.has(id)) throw new Error(`check ${c.code} names unknown object ${id}`);
    }
  }
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

check('topLevel', () => {
  const tl = M.topLevel(model, 'refines').map((o) => o.id);
  eq(tl[0], 'sec-foundations', 'first section');
  has(tl, TYCH_ULTRA, 'edge roots are top level too');
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
