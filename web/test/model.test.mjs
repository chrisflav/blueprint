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

check('search limits, and filters candidates with accept', () => {
  const all = M.search(model, 'e', Infinity);
  if (all.length <= 3) throw new Error('"e" should match most of the sample');
  eq(M.search(model, 'e', 3).length, 3, 'limit');
  eq(M.searchIds(model, 'e').size, all.length, 'searchIds is not capped');
  const nodesOnly = M.search(model, 'e', Infinity, { accept: (o) => o.boundary.length === 0 });
  ok(nodesOnly.length > 0 && nodesOnly.every((h) => h.object.boundary.length === 0), 'accept is honoured');
  eq(nodesOnly.length, all.filter((h) => h.object.boundary.length === 0).length, 'and drops nothing else');
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

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
