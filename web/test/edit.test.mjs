// web/test/edit.test.mjs
//
// The graph editor's pure half (../edit-model.js) and its TeX export
// (../export/blueprint-tex.js), against ../sample/paper/blueprint.json (the
// snapshot of examples/paper: sections, proofs with dependencies of their own,
// a lemma refining a proof, a lemma with two parents).
//
//   nix-shell -p nodejs_22 --run "node web/test/edit.test.mjs"
//
// With BLUEPRINT_BIN pointing at the built tool (test.sh sets it), it also
// takes an edited blueprint all the way round: Export TeX, `blueprint
// import-latex`, `blueprint build`, and checks that the snapshot that comes
// back has the edited graph.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../model.js';
import * as E from '../edit-model.js';
import { exportBlueprintTex, dependencyOrder } from '../export/blueprint-tex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', 'sample', 'paper', 'blueprint.json'), 'utf8');
const fresh = () => JSON.parse(raw);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, message: e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : String(e) });
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected true');
}

function throws(fn, re, what) {
  try { fn(); } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${what}: wrong message ${e.message}`);
    if (!(e instanceof E.EditError)) throw new Error(`${what}: not an EditError: ${e.message}`);
    return;
  }
  throw new Error(`${what || 'call'} did not throw`);
}

/** Apply ops one after another, each computed on the result of the last. */
function run(base, ...steps) {
  const ops = [];
  let snap = base;
  for (const step of steps) {
    ops.push(step(snap));
    snap = E.applyOps(base, ops);
  }
  return { ops, snap };
}

const uses = (snap) => {
  const out = new Set();
  for (const [s, ts] of E.usesRelation(snap)) for (const t of ts) out.add(`${s}>${t}`);
  return out;
};
const byId = (snap, id) => snap.objects.find((o) => o.id === id) || null;

// ---------------------------------------------------------------------------

check('the base snapshot is never changed', () => {
  const base = fresh();
  const before = JSON.stringify(base);
  run(base,
    (s) => E.opDelete(s, 'def-compact'),
    (s) => E.opEdit(s, 'thm-fip', { id: 'thm-closed', title: 'Closed sets' }),
    (s) => E.opAdd(s, { kind: 'lemma', title: 'New', section: 'products' }));
  eq(JSON.stringify(base), before, 'base JSON');
});

check('no ops is the base itself', () => {
  const base = fresh();
  ok(E.applyOps(base, []) === base, 'same object');
});

check('add: a lemma in a section, used by a theorem, using a definition', () => {
  const base = fresh();
  const op = E.opAdd(base, { kind: 'lemma', title: 'Slices are compact', section: 'products',
    statement: 'Each slice $\\{x\\} \\times Y$ is compact.', proof: 'It is homeomorphic to $Y$.',
    uses: ['def-compact'], usedBy: ['thm-product'] });
  eq(op.ids, ['lem-slices-are-compact'], 'suggested id');
  const s = E.applyOps(base, [op]);
  const o = byId(s, 'lem-slices-are-compact');
  eq(o.kind, 'lemma', 'kind');
  ok(byId(s, 'refines/lem-slices-are-compact/products'), 'in its section');
  ok(byId(s, 'proof/lem-slices-are-compact'), 'its proof');
  ok(uses(s).has('lem-slices-are-compact>def-compact'), 'uses def-compact');
  ok(uses(s).has('thm-product>lem-slices-are-compact'), 'used by thm-product');
  eq(E.checkGraph(s).dangling, [], 'nothing dangling');
  const m = M.buildModel(s);
  ok(M.documentOutline(m, 'refines').byId.has('lem-slices-are-compact'), 'in the document');
});

check('add: refuses a taken id, a bad id, an unknown kind', () => {
  const base = fresh();
  throws(() => E.opAdd(base, { id: 'def-fip', kind: 'lemma' }), /already/, 'taken');
  throws(() => E.opAdd(base, { id: 'a b', kind: 'lemma' }), /valid id/, 'bad id');
  throws(() => E.opAdd(base, { kind: 'nonsense' }), /not a kind/, 'kind');
});

check('delete with reconnect: users of a node use what it used', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opDelete(s, 'def-compact', { mode: 'bridge' }));
  ok(!byId(snap, 'def-compact'), 'gone');
  ok(!byId(snap, 'uses/thm-product/def-compact'), 'its edges gone');
  ok(!byId(snap, 'refines/def-compact/compact'), 'its section edge gone');
  const u = uses(snap);
  for (const x of ['lem-tube', 'thm-fip', 'thm-product']) ok(u.has(`${x}>def-cover`), `${x} now uses def-cover`);
  ok(!byId(snap, 'thm-product').body.includes('[def-compact]'), 'reference rewritten');
  ok(byId(snap, 'thm-product').body.includes('Compact space'), 'reference reads as the title');
  eq(E.checkGraph(snap).dangling, [], 'nothing dangling');
});

check('delete without reconnect: only the node and its edges go', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opDelete(s, 'def-compact', { mode: 'drop' }));
  ok(!uses(snap).has('thm-product>def-cover'), 'no new edge');
  ok(uses(snap).has('thm-product>lem-tube'), 'others kept');
});

check('delete a section: its contents move up', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opDelete(s, 'covers'));
  ok(byId(snap, 'refines/def-cover/spaces'), 'def-cover moved up to spaces');
  ok(byId(snap, 'refines/def-fip/spaces'), 'def-fip moved up to spaces');
  eq(E.checkGraph(snap).dangling, [], 'nothing dangling');
});

check('delete a statement whose proof has details: they stay in the section', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opDelete(s, 'thm-fip'));
  ok(!byId(snap, 'proof/thm-fip'), 'proof gone');
  ok(byId(snap, 'refines/lem-complements/compact'), 'lem-complements lifted to the section');
  ok(byId(snap, 'refines/lem-finite-subfamily/compact'), 'lem-finite-subfamily lifted too');
});

check('edit: rename carries edges, proof, details and references along', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opEdit(s, 'thm-fip', { id: 'thm-closed', title: 'Closed sets', kind: 'proposition' }));
  ok(!byId(snap, 'thm-fip'), 'old id gone');
  const o = byId(snap, 'thm-closed');
  eq([o.kind, o.attrs.title], ['proposition', 'Closed sets'], 'kind and title');
  ok(byId(snap, 'proof/thm-closed'), 'proof renamed');
  ok(byId(snap, 'uses/proof~thm-closed/def-fip'), 'proof edge renamed');
  ok(byId(snap, 'refines/lem-complements/proof~thm-closed'), 'detail edge renamed');
  ok(byId(snap, 'refines/uses~proof~thm-closed~def-fip/compact'), 'edge on an edge renamed');
  ok(byId(snap, 'thm-product').body.includes('[thm-closed]'), 'reference rewritten');
  eq(snap.derived.status['thm-closed'], 'absent', 'status follows');
  eq(E.checkGraph(snap).dangling, [], 'nothing dangling');
});

check('edit: fenced code keeps its brackets through a rename and is no broken link', () => {
  const base = fresh();
  const body = 'By [thm-fip] and [no-such_a].\n\n```lean\nexample := by simp [thm-fip, no-such_b]\n```\n\nAgain [thm-fip].';
  const { snap } = run(base,
    (s) => E.opEdit(s, 'thm-product', { statement: body }),
    (s) => E.opEdit(s, 'thm-fip', { id: 'thm-closed' }));
  eq(byId(snap, 'thm-product').body,
    'By [thm-closed] and [no-such_a].\n\n```lean\nexample := by simp [thm-fip, no-such_b]\n```\n\nAgain [thm-closed].',
    'prose rewritten, code as written');
  eq(E.checkGraph(snap).brokenLinks.filter((l) => l.id === 'thm-product'), [{ id: 'thm-product', ref: 'no-such_a' }],
    'only the link in prose is broken');
});

check('edit: statement and proof text, an emptied proof keeps its dependencies', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opEdit(s, 'lem-tube', { statement: 'New statement.', proof: '' }));
  eq(byId(snap, 'lem-tube').body, 'New statement.', 'statement');
  ok(!byId(snap, 'proof/lem-tube'), 'empty proof removed');
  const { snap: s2 } = run(base, (s) => E.opEdit(s, 'thm-fip', { proof: 'Shorter.' }));
  eq(byId(s2, 'proof/thm-fip').body, 'Shorter.', 'proof text');
  const { snap: s3 } = run(base, (s) => E.opEdit(s, 'def-cover', { proof: 'A new proof.' }));
  ok(byId(s3, 'proof/def-cover'), 'a proof created');
});

check('uses: add (to the proof when there is one), refuse duplicates and self, remove', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opAddUse(s, 'thm-fip', 'def-cover'));
  ok(byId(snap, 'uses/proof~thm-fip/def-cover'), 'on the proof');
  const { snap: s2 } = run(base, (s) => E.opAddUse(s, 'thm-fip', 'def-cover', { where: 'statement' }));
  ok(byId(s2, 'uses/thm-fip/def-cover'), 'on the statement');
  throws(() => E.opAddUse(base, 'thm-fip', 'def-fip'), /already/, 'duplicate');
  throws(() => E.opAddUse(base, 'thm-fip', 'thm-fip'), /itself/, 'self');
  const { snap: s3 } = run(base, (s) => E.opRemoveUse(s, 'thm-fip', 'def-fip'));
  ok(!uses(s3).has('thm-fip>def-fip'), 'statement and proof edges both gone');
  ok(!byId(s3, 'uses/proof~thm-fip/def-fip'), 'the proof edge too');
  throws(() => E.opRemoveUse(base, 'def-cover', 'thm-fip'), /does not use/, 'nothing to remove');
  const { snap: s4 } = run(base, (s) => E.opRemoveEdges(s, ['uses/thm-product/lem-tube']));
  ok(!uses(s4).has('thm-product>lem-tube'), 'remove by edge id');
});

check('cycles are found, and only warned about', () => {
  const base = fresh();
  eq(E.checkGraph(base).cycles, [], 'none at first');
  const { snap } = run(base, (s) => E.opAddUse(s, 'def-cover', 'thm-product'));
  const c = E.checkGraph(snap).cycles;
  eq(c.length, 1, 'one cycle');
  ok(c[0].includes('def-cover') && c[0].includes('thm-product'), 'through both');
});

check('split: pieces before the original, used by it, reusable elsewhere', () => {
  const base = fresh();
  const o = byId(base, 'proof/lem-tube');
  const { snap, ops } = run(base, (s) => E.opSplit(s, 'lem-tube', {
    pieces: [
      { id: 'lem-basic-boxes', kind: 'lemma', title: 'Basic boxes', from: 'proof',
        statement: 'Products of open sets form a basis.', deps: ['def-compact'], usedBy: ['thm-product'] },
      { kind: 'definition', title: 'Tube', from: 'statement', statement: 'A tube is $U \\times Y$.' },
    ],
    proof: o.body + '\n\nBy [lem-basic-boxes].',
    dropMovedDeps: true,
  }));
  const u = uses(snap);
  ok(u.has('lem-tube>lem-basic-boxes'), 'the original uses the first piece');
  ok(byId(snap, 'uses/proof~lem-tube/lem-basic-boxes'), 'from its proof');
  ok(byId(snap, 'uses/lem-tube/def-tube'), 'the second from its statement');
  ok(u.has('thm-product>lem-basic-boxes'), 'reused by thm-product');
  ok(u.has('lem-basic-boxes>def-compact'), 'the piece took the dependency');
  ok(!u.has('lem-tube>def-compact'), 'the original dropped it');
  ok(byId(snap, 'refines/lem-basic-boxes/compact'), 'in the section');
  const ord = (id) => byId(snap, id).attrs.order;
  ok(ord('lem-basic-boxes') < ord('lem-tube') && ord('def-tube') < ord('lem-tube'), 'placed before the original');
  ok(ord('lem-basic-boxes') > byId(snap, 'thm-fip').attrs.order, 'after the sibling before it');
  eq(ops[0].op, 'split', 'one op');
});

check('split, replacing the original: its users use the pieces', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opSplit(s, 'lem-tube', {
    pieces: [{ id: 'lem-a', kind: 'lemma', statement: 'A' }, { id: 'lem-b', kind: 'lemma', statement: 'B' }],
    replaceOriginal: true,
  }));
  ok(!byId(snap, 'lem-tube'), 'original gone');
  const u = uses(snap);
  ok(u.has('thm-product>lem-a') && u.has('thm-product>lem-b'), 'users use the pieces');
  ok(byId(snap, 'thm-product').body.includes('[lem-a]'), 'references go to the first piece');
  throws(() => E.opSplit(base, 'lem-tube', { pieces: [] }), /at least one/, 'no pieces');
});

check('merge: one node with the union of the dependencies', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opMerge(s, ['def-fip', 'def-cover'], { keep: 'def-fip', id: 'def-cover-fip', title: 'Covers and the FIP' }));
  ok(!byId(snap, 'def-fip') && !byId(snap, 'def-cover'), 'both old ids gone');
  const u = uses(snap);
  ok(u.has('def-compact>def-cover-fip'), 'users of def-cover use it');
  ok(u.has('thm-fip>def-cover-fip'), 'users of def-fip use it');
  ok(!u.has('def-cover-fip>def-cover-fip'), 'no self loop');
  eq(byId(snap, 'def-cover-fip').attrs.title, 'Covers and the FIP', 'title');
  ok(byId(snap, 'refines/def-cover-fip/covers'), 'kept its section');
  eq(E.checkGraph(snap).dangling, [], 'nothing dangling');
  throws(() => E.opMerge(base, ['def-fip']), /two/, 'one node');
});

check('merge: details of a merged proof move to the survivor', () => {
  const base = fresh();
  const { snap } = run(base, (s) => E.opMerge(s, ['thm-fip', 'lem-tube'], { keep: 'lem-tube' }));
  ok(byId(snap, 'refines/lem-complements/lem-tube'), 'detail re-parented');
  ok(uses(snap).has('lem-tube>def-fip'), 'took over the dependencies');
});

check('undo is replaying one op fewer', () => {
  const base = fresh();
  const { ops } = run(base, (s) => E.opDelete(s, 'def-compact'), (s) => E.opAddUse(s, 'def-fip', 'lem-tube'));
  const undone = E.applyOps(base, ops.slice(0, 1));
  ok(!uses(undone).has('def-fip>lem-tube'), 'last op undone');
  ok(!byId(undone, 'def-compact'), 'first kept');
  eq(JSON.stringify(E.applyOps(base, [])), JSON.stringify(base), 'all undone');
});

check('summary: added, removed, changed, dependencies; marks', () => {
  const base = fresh();
  const { snap } = run(base,
    (s) => E.opDelete(s, 'rem-infinite'),
    (s) => E.opAdd(s, { id: 'lem-x', kind: 'lemma', section: 'products', usedBy: ['thm-product'] }),
    (s) => E.opEdit(s, 'def-fip', { title: 'FIP' }));
  const sum = E.summarize(base, snap);
  eq(sum.added, ['lem-x'], 'added');
  eq(sum.removed, ['rem-infinite'], 'removed');
  eq(sum.changed.find((c) => c.id === 'def-fip').what, ['title'], 'changed');
  ok(sum.usesAdded.some(([a, b]) => a === 'thm-product' && b === 'lem-x'), 'uses added');
  eq(sum.marks.get('lem-x'), 'new', 'mark new');
  eq(sum.marks.get('def-fip'), 'changed', 'mark changed');
  eq(sum.marks.get('thm-product'), 'changed', 'a node with a new dependency is changed');
});

check('edit file: serialise, parse, refuse what is not one', () => {
  const base = fresh();
  const { ops, snap } = run(base, (s) => E.opDelete(s, 'def-compact'), (s) => E.opEdit(s, 'thm-fip', { id: 'thm-closed' }));
  const text = E.serializeEdits(base, ops);
  const back = E.parseEdits(text);
  ok(E.sameBase(back.base, E.fingerprint(base)), 'same base');
  eq(JSON.stringify(E.applyOps(base, back.ops)), JSON.stringify(snap), 'replays to the same snapshot');
  throws(() => E.parseEdits('{'), /JSON/, 'not JSON');
  throws(() => E.parseEdits('{"format":"x"}'), /not a blueprint edit file/, 'wrong format');
  throws(() => E.parseEdits('{"format":"blueprint-edits","version":1,"ops":[{"op":"edit","label":"x","ids":[],"changes":[{"oops":1}]}]}'), /neither/, 'bad change');
  ok(!E.sameBase(E.fingerprint(E.applyOps(base, ops)), E.fingerprint(base)), 'another base differs');
});

check('ids: only what import-latex keeps as it is', () => {
  for (const id of ['lem-a', 'a.b_c', 'sec-rings--lemma-1', 'x', '0', 'lem_']) ok(E.ID_RE.test(id), `${id} refused`);
  for (const id of ['Lem-a', 'a-', 'a.', '-a', '.a', 'a b', 'a/b', 'lem-ä', '']) ok(!E.ID_RE.test(id), `${id} accepted`);
  // `labelId` in Blueprint/ImportLatex.lean, for the editor's file: a label
  // all of `a-z0-9-_.`, not starting or ending with `-`, is kept.
  const kept = (l) => /^[a-z0-9._-]+$/.test(l) && !l.startsWith('-') && !l.endsWith('-');
  for (const id of ['lem-a', 'a.b_c', 'sec-rings--lemma-1', 'lem_']) ok(kept(id), `${id} would be renamed`);
  const base = fresh();
  throws(() => E.opEdit(base, 'thm-fip', { id: 'Thm-Fip' }), /valid id \(lower case/, 'upper case');
  throws(() => E.opAdd(base, { id: 'lem-a.', kind: 'lemma' }), /valid id/, 'a trailing dot');
});

check('Lean names: refused unless they are names, stripped by the TeX export', () => {
  const base = fresh();
  for (const n of ['Foo}bar%', 'a b', 'x#y', 'a\\b', 'Nat.', '.x', '1x', '«a{b»']) {
    throws(() => E.opEdit(base, 'thm-fip', { lean: [n] }), /not a Lean name/, n);
  }
  throws(() => E.opAdd(base, { kind: 'lemma', title: 'New', lean: ['ok.name', 'bad}'] }), /"bad}" is not a Lean name/, 'add');
  const good = ['Nat.add_comm', 'CategoryTheory.Functor.map_comp\'', '«my-thm».x₁', 'α.β!', 'h?'];
  const s = E.applyOps(base, [E.opEdit(base, 'thm-fip', { lean: good })]);
  eq(byId(s, 'thm-fip').attrs.lean, good, 'names kept');
  // A name the blueprint already carries goes through, however odd.
  const odd = { ...base, objects: base.objects.map((o) => (o.id === 'def-fip' ? { ...o, attrs: { ...o.attrs, lean: ['Foo}bar%'] } } : o)) };
  const merged = E.applyOps(odd, [E.opMerge(odd, ['def-fip', 'thm-fip'], { keep: 'thm-fip' })]);
  eq(byId(merged, 'thm-fip').attrs.lean, ['Foo}bar%'], 'a merge carries an odd name along');
  const { tex, diagnostics } = exportBlueprintTex(merged);
  ok(tex.includes('\\lean{Foobar}'), 'the name is not stripped in the TeX');
  ok(!tex.includes('Foo}bar%'), 'the raw name is in the TeX');
  ok(diagnostics.some((d) => d.code === 'lean-name' && d.object === 'thm-fip'), 'no note of it');
});

check('edit file: a malformed one is refused, saying what is wrong', () => {
  const base = fresh();
  const good = JSON.parse(E.serializeEdits(base, [E.opEdit(base, 'thm-fip', { title: 'Closed' })]));
  const put = good.ops[0].changes.find((c) => c.put);
  const variant = (f) => { const d = JSON.parse(JSON.stringify(good)); f(d, d.ops[0], d.ops[0].changes.find((c) => c.put)); return JSON.stringify(d); };
  ok(put && typeof put.was === 'string', 'a put records the version it replaces');
  E.parseEdits(JSON.stringify(good));
  const cases = [
    [(d, op) => { op.op = 'script'; }, /"script" is not a kind of edit/],
    [(d, op) => { delete op.op; }, /undefined is not a kind of edit/],
    [(d, op) => { op.label = 5; }, /no "label"/],
    [(d, op) => { op.ids = ['<img src=x onerror=alert(1)>']; }, /"ids" is not a list of ids/],
    [(d, op) => { op.extra = 1; }, /unknown field "extra"/],
    [(d, op) => { op.changes = []; }, /no "changes"/],
    [(d, op, p) => { p.put.id = '<img src=x onerror=alert(1)>'; }, /is not an id/],
    [(d, op, p) => { p.put.kind = 'x y'; }, /is not a kind/],
    [(d, op, p) => { p.put.body = { html: '<b>' }; }, /body is not a string/],
    [(d, op, p) => { p.put.attrs.title = ['<img>']; }, /title is not a string/],
    [(d, op, p) => { p.put.attrs.lean = 'Nat'; }, /lean is not a list of strings/],
    [(d, op, p) => { p.put.attrs = null; }, /"attrs" is not an object/],
    [(d, op, p) => { p.put.boundary = [{ role: 'of', id: 'a b' }]; }, /"boundary" is not a list/],
    [(d, op, p) => { p.was = 'nope'; }, /"was" is not a version/],
    [(d, op, p) => { p.del = 'x'; }, /neither one "put", "del" nor "rename"/],
    [(d, op) => { op.changes.push({ rename: { from: 'a', to: 5 } }); }, /"rename" is not a \{from, to\}/],
    [(d) => { d.base = 'x'; }, /does not name a snapshot/],
    [(d) => { d.ops = {}; }, /no "ops" list/],
  ];
  for (const [f, re] of cases) throws(() => E.parseEdits(variant(f)), re, String(re));
  throws(() => E.parseEdits(variant((d) => { d.base.project = 'another'; }), { snapshot: base }), /made on the blueprint "another", not on "paper"/, 'another project');
  E.parseEdits(variant((d) => { d.base.hash = '00000000'; }), { snapshot: base });
  throws(() => E.checkOps([{ op: 'edit' }]), /no "label"/, 'checkOps');
});

check('edit file: hostile prose is kept as text, for the site to sanitise', () => {
  // The model never interprets prose; what it must do is keep a hostile
  // body or title a plain string, which the site renders through its
  // sanitiser (app.test.mjs checks that), and never let one into an id.
  const base = fresh();
  const evil = '<img src=x onerror=alert(1)>';
  const op = E.opEdit(base, 'thm-fip', { title: evil, statement: evil });
  const back = E.parseEdits(E.serializeEdits(base, [op]));
  const s = E.applyOps(base, back.ops);
  eq(byId(s, 'thm-fip').attrs.title, evil, 'title');
  eq(byId(s, 'thm-fip').body, evil, 'body');
  throws(() => E.opEdit(base, 'thm-fip', { id: evil }), /valid id/, 'as an id');
});

check('replay onto another snapshot: what changed upstream since is listed', () => {
  const base = fresh();
  const { ops } = run(base,
    (s) => E.opEdit(s, 'thm-fip', { title: 'Closed sets' }),
    (s) => E.opEdit(s, 'thm-fip', { statement: 'Again.' }),
    (s) => E.opDelete(s, 'rem-infinite', { mode: 'drop' }),
    (s) => E.opAdd(s, { id: 'lem-new', kind: 'lemma', title: 'New' }));
  eq(E.replayConflicts(base, ops), [], 'on its own base: nothing');
  const upstream = (f) => { const b = fresh(); f(b); return b; };
  const changed = upstream((b) => { byId(b, 'thm-fip').body = 'Changed upstream.'; });
  eq(E.replayConflicts(changed, ops).map((c) => [c.id, c.how]), [['thm-fip', 'changed']], 'a body changed upstream');
  eq(E.replayConflicts(changed, ops)[0].label, ops[0].label, 'by the first edit that touches it');
  const moved = upstream((b) => { byId(b, 'thm-fip').source.file = 'elsewhere.md'; byId(b, 'thm-fip').depth = 7; });
  eq(E.replayConflicts(moved, ops), [], 'a file moved, a depth changed: nothing');
  const elsewhere = upstream((b) => { byId(b, 'def-fip').body = 'Untouched by the edits.'; });
  eq(E.replayConflicts(elsewhere, ops), [], 'an object the edits leave alone');
  const removed = upstream((b) => { b.objects = b.objects.filter((o) => o.id !== 'rem-infinite'); });
  ok(E.replayConflicts(removed, ops).some((c) => c.id === 'rem-infinite' && c.how === 'removed'), 'removed upstream');
  const added = upstream((b) => { b.objects.push({ id: 'lem-new', kind: 'lemma', boundary: [], attrs: {}, body: 'Upstream.' }); });
  ok(E.replayConflicts(added, ops).some((c) => c.id === 'lem-new' && c.how === 'added'), 'added upstream');
  const old = ops.map((op) => ({ ...op, changes: op.changes.map(({ was, ...c }) => c) }));
  ok(E.replayConflicts(base, old).every((c) => c.how === 'unknown'), 'a log without versions');
});

check('dependency order is stable and puts what is used first', () => {
  eq(dependencyOrder(['a', 'b', 'c'], new Map([['a', new Set(['c'])]])), ['c', 'a', 'b'], 'c before a');
  eq(dependencyOrder(['a', 'b'], new Map([['a', new Set(['b'])], ['b', new Set(['a'])]])), ['b', 'a'], 'a cycle terminates');
  eq(dependencyOrder(['x', 'y'], new Map()), ['x', 'y'], 'no deps: as given');
});

check('TeX export: environments, labels, \\uses, proofs, sections, order', () => {
  const base = fresh();
  const { snap } = run(base,
    (s) => E.opAdd(s, { id: 'lem-slice', kind: 'lemma', title: 'Slices', section: 'products', order: 99,
      statement: 'By [def-compact], slices are compact.', uses: ['def-compact'], usedBy: ['thm-product'] }),
    (s) => E.opDelete(s, 'rem-infinite'));
  const { tex, diagnostics, stats } = exportBlueprintTex(snap);
  ok(tex.includes('\\begin{document}') && tex.trim().endsWith('\\end{document}'), 'a whole document');
  // The line `editorGenerated` in Blueprint/ImportLatex.lean looks for, to keep the labels.
  ok(tex.split('\n').slice(0, 3).some((l) => l.startsWith('% Written by blueprint-edit-tex/')), 'the generator line');
  ok(tex.includes('\\begin{lemma}[Slices]\n\\label{lem-slice}\n\\uses{def-compact}'), 'the new lemma');
  ok(tex.includes('By \\cref{def-compact}, slices are compact.'), 'reference as \\cref');
  ok(!tex.includes('rem-infinite'), 'the deleted remark is gone');
  ok(/\\label\{thm-product\}\n\\uses\{def-compact, lem-tube, lem-slice\}|\\label\{thm-product\}\n\\uses\{[^}]*lem-slice/.test(tex), 'thm-product uses the new lemma');
  ok(tex.indexOf('\\label{lem-slice}') < tex.indexOf('\\label{thm-product}'), 'used before user, although order says later');
  ok(tex.includes('\\begin{proof}\n\\uses{def-fip}'), 'a proof with its own \\uses');
  ok(tex.indexOf('\\chapter{Covers and compact spaces}') < tex.indexOf('\\section{Covers}'), 'sections nested');
  ok(tex.includes('\\section{Compact spaces}\\label{compact}'), 'section label');
  ok(/\\providecommand\{\\fam\}\{\}\\renewcommand\{\\fam\}/.test(tex), 'project macros');
  eq(stats.statements, 11, 'statements');
  ok(Array.isArray(diagnostics), 'diagnostics');
});

// ---------------------------------------------------------------------------
// round trip through the tool itself
// ---------------------------------------------------------------------------

const bin = process.env.BLUEPRINT_BIN;
if (bin && fs.existsSync(bin)) {
  check('round trip: Export TeX, import-latex, build gives the edited graph', () => {
    const base = fresh();
    const { snap } = run(base,
      (s) => E.opDelete(s, 'def-compact', { mode: 'bridge' }),
      (s) => E.opAdd(s, { id: 'lem-slice', kind: 'lemma', title: 'Slices', section: 'products',
        statement: 'Slices are compact.', proof: 'Clear.', uses: ['def-cover'], usedBy: ['thm-product'] }),
      (s) => E.opSplit(s, 'lem-tube', { pieces: [{ id: 'lem-boxes', kind: 'lemma', title: 'Boxes', from: 'proof', statement: 'Boxes form a basis.' }] }),
      (s) => E.opMerge(s, ['lem-complements', 'lem-finite-subfamily'], { keep: 'lem-complements' }),
      (s) => E.opEdit(s, 'thm-fip', { id: 'thm-closed--sets.v2_x', title: 'Closed sets', lean: ['Nat.add_comm'] }),
      (s) => E.opRemoveUse(s, 'thm-product', 'lem-tube'),
      (s) => E.opAddUse(s, 'thm-product', 'lem-boxes'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-edit-'));
    try {
      const { tex } = exportBlueprintTex(snap);
      fs.writeFileSync(path.join(dir, 'edited.tex'), tex);
      execFileSync(bin, ['import-latex', path.join(dir, 'edited.tex'), '--out', path.join(dir, 'p', 'blueprint'),
        '--toml', path.join(dir, 'p', 'blueprint.toml'), '--report', path.join(dir, 'report.txt')], { stdio: 'pipe' });
      execFileSync(bin, ['build', '--root', path.join(dir, 'p'), '-o', path.join(dir, 'back.json')], { stdio: 'pipe' });
      const back = JSON.parse(fs.readFileSync(path.join(dir, 'back.json'), 'utf8'));
      const d1 = new E.Draft(snap);
      const d2 = new E.Draft(back);
      const nodes = (d) => d.objects().filter((o) => d.isNode(o) && o.kind !== M.TEXT_KIND).map((o) => o.id).sort();
      eq(nodes(d2), nodes(d1), 'the same nodes, by id');
      eq([...uses(back)].sort(), [...uses(snap)].sort(), 'the same dependencies');
      for (const id of nodes(d1)) {
        const a = d1.get(id);
        const b = d2.get(id);
        if (!M.isSectionKind(a.kind)) {
          eq(b.kind, a.kind, `${id} kind`);
          eq(d2.sectionOf(id), d1.sectionOf(id), `${id} section`);
          eq(d2.proofsOf(id).length, d1.proofsOf(id).length, `${id} proofs`);
        }
        eq(b.attrs.title || '', a.attrs.title || '', `${id} title`);
      }
      const report = fs.readFileSync(path.join(dir, 'report.txt'), 'utf8');
      ok(/unresolved uses\s+0/.test(report), 'every \\uses resolved');
      ok(/unlabelled environments\s+0/.test(report), 'every environment labelled');
      ok(!/katex macros.*\n[\s\S]*\\\\lean/.test(fs.readFileSync(path.join(dir, 'p', 'blueprint.toml'), 'utf8')), 'no \\lean macro');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  console.log('  (skipping the import-latex round trip: set BLUEPRINT_BIN to the built tool)');
}

let pdflatex = null;
try { pdflatex = execFileSync('sh', ['-c', 'command -v pdflatex'], { encoding: 'utf8' }).trim() || null; } catch (e) { pdflatex = null; }
if (pdflatex) {
  check('the exported TeX compiles with pdfLaTeX', () => {
    const base = fresh();
    const { snap } = run(base,
      (s) => E.opAdd(s, { id: 'lem-slice', kind: 'lemma', title: 'Slices', section: 'products', statement: 'By [def-compact], $x \\in X$.' }),
      (s) => E.opMerge(s, ['def-fip', 'def-cover'], { keep: 'def-fip' }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-edit-tex-'));
    try {
      fs.writeFileSync(path.join(dir, 'e.tex'), exportBlueprintTex(snap).tex);
      execFileSync(pdflatex, ['-interaction=nonstopmode', '-halt-on-error', 'e.tex'], { cwd: dir, stdio: 'pipe', timeout: 120000 });
      ok(fs.statSync(path.join(dir, 'e.pdf')).size > 1000, 'a PDF');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  console.log('  (skipping the pdfLaTeX check: no pdflatex on PATH)');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
