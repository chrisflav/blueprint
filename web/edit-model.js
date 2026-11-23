// edit-model.js — the graph editor's pure half: edits as a log over a snapshot.
//
// Edit mode (edit.js, docs/graph-edit.md) never touches the snapshot it was
// opened on.  Every operation the reader performs — delete, replace, add,
// split, merge, a dependency added or removed — is turned here into an *op*:
//
//   { op: 'split', label: 'Split thm-main into lem-a, lem-b', at: ISO date,
//     ids: [the objects to show for it],
//     changes: [ {put: object, was} | {del: id, was} | {rename: {from, to}} ] }
//
// a list of whole objects to put in place and ids to delete, computed against
// the snapshot as edited so far; `was` is the version (`versionOf`) of the
// object a change replaces, null for a new one.  The edited snapshot is the
// base with every op's changes applied in turn (`applyOps`), so undo is
// dropping the last op and redo putting it back; the log is what is saved in
// the browser and in an edit file, and it replays onto a later snapshot of the
// same blueprint as long as the objects it names are still there
// (`replayConflicts` says which of them changed upstream since, a change the
// replay undoes).
//
// Pure: no DOM, no fetch, so the tests run it under node.

import { SLUG_PATTERN, isSectionKind, TEXT_KIND, mapProseLines, fencedLines } from './model.js';

export const EDIT_FORMAT = 'blueprint-edits';
export const EDIT_VERSION = 1;

/**
 * An id for a node the editor makes or renames: one that `blueprint
 * import-latex` keeps as it is when it reads the editor's Export TeX back
 * (`labelId` in Blueprint/ImportLatex.lean): lower case letters, digits, `.`,
 * `_` and `-`, starting with a letter or digit and not ending in `-` or `.`.
 */
export const ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_])?$/;
const ID_RULE = 'lower case letters, digits, ".", "_" and "-", not ending in "-" or "."';

// Any object's id, as a `[slug]` reference may name it: the ids an edit file
// may mention (a node's, or a derived one such as `proof/lem-a`).
const OBJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/;

// A Lean declaration name: dot-separated parts, each an identifier or a
// «quoted» one.  Nothing in it may mean anything to TeX (`{}%#\`), so that
// Export TeX can write it into `\lean{…}` as it stands.
const LEAN_PART = "(?:«[^«»\\s{}%#\\\\,]+»|[\\p{L}_][\\p{L}\\p{N}_'!?]*)";
export const LEAN_NAME_RE = new RegExp(`^${LEAN_PART}(?:\\.${LEAN_PART})*$`, 'u');

const clone = (o) => JSON.parse(JSON.stringify(o));
const enc = (id) => String(id).replace(/\//g, '~');

/** The id the tool derives for an object created by sugar: kind, then boundary ids. */
export function derivedId(kind, boundary) {
  return [kind, ...boundary.map((b) => enc(b.id))].join('/');
}

export class EditError extends Error {}

function fail(message) {
  throw new EditError(message);
}

// ---------------------------------------------------------------------------
// the kinds the editor works with
// ---------------------------------------------------------------------------

/** What the schema calls the dependency relation, the collapse order and proofs. */
export function editKinds(snapshot) {
  const kinds = (snapshot.schema && snapshot.schema.kinds) || {};
  const binary = (k) => {
    const b = kinds[k] && kinds[k].boundary;
    if (!b) return false;
    const roles = Object.keys(b);
    return roles.length === 2 && roles.includes('src') && roles.includes('tgt');
  };
  const uses = kinds.uses ? 'uses'
    : Object.keys(kinds).find((k) => binary(k) && kinds[k].sugar && !kinds[k].collapse) || 'uses';
  const collapse = (snapshot.schema && snapshot.schema.defaultCollapse)
    || Object.keys(kinds).find((k) => kinds[k] && kinds[k].collapse) || 'refines';
  const proof = kinds.proof ? 'proof' : null;
  // The kinds a node may be given: empty boundary, not the text between
  // statements or a bibliography entry.
  const nodes = Object.keys(kinds).filter((k) => {
    const b = kinds[k] && kinds[k].boundary;
    return (!b || Object.keys(b).length === 0) && k !== TEXT_KIND && k !== 'reference';
  });
  return { uses, collapse, proof, nodes, kinds };
}

/** The kinds offered for a statement, most common first. */
export function statementKinds(snapshot) {
  const { nodes } = editKinds(snapshot);
  const pref = ['definition', 'lemma', 'proposition', 'theorem', 'corollary', 'remark', 'example'];
  const rest = nodes.filter((k) => !pref.includes(k)).sort();
  return pref.filter((k) => nodes.includes(k)).concat(rest);
}

// ---------------------------------------------------------------------------
// a draft: the snapshot as edited so far, plus what this op changes
// ---------------------------------------------------------------------------

export class Draft {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.k = editKinds(snapshot);
    this.cur = new Map();
    for (const o of snapshot.objects) this.cur.set(o.id, o);
    // What each object was when this draft began, for the op's `was`.
    this.orig = new Map(this.cur);
    this.touched = new Set();
    this.renames = [];
    this._inc = null;
  }

  get(id) { return this.cur.get(id) || null; }
  has(id) { return this.cur.has(id); }
  objects() { return [...this.cur.values()]; }

  put(o) {
    this.cur.set(o.id, o);
    this.touched.add(o.id);
    this._inc = null;
  }

  del(id) {
    if (this.cur.delete(id)) {
      this.touched.add(id);
      this._inc = null;
    }
  }

  /** Objects whose boundary mentions `id`. */
  incident(id) {
    if (!this._inc) {
      this._inc = new Map();
      for (const o of this.cur.values()) {
        for (const b of o.boundary || []) {
          if (!this._inc.has(b.id)) this._inc.set(b.id, []);
          this._inc.get(b.id).push(o);
        }
      }
    }
    return this._inc.get(id) || [];
  }

  /** The changes this draft makes, as an op's `changes`. */
  changes() {
    const out = this.renames.map(([from, to]) => ({ rename: { from, to } }));
    for (const id of this.touched) {
      const was = this.orig.has(id) ? versionOf(this.orig.get(id)) : null;
      if (this.cur.has(id)) out.push({ put: clone(this.cur.get(id)), was });
      else if (this.orig.has(id)) out.push({ del: id, was });
    }
    return out;
  }

  // --- the blueprint's structure, as the editor reads it --------------------

  isProof(o) { return !!o && o.kind === this.k.proof && (o.boundary || []).length === 1; }
  isNode(o) { return !!o && (o.boundary || []).length === 0; }

  /** The statement a proof proves; any other object stands for itself. */
  statementOf(id) {
    const o = this.get(id);
    return this.isProof(o) ? o.boundary[0].id : id;
  }

  proofsOf(id) {
    return this.incident(id).filter((o) => this.isProof(o) && o.boundary[0].id === id);
  }

  end(o, role) {
    const b = (o.boundary || []).find((x) => x.role === role);
    return b ? b.id : null;
  }

  usesEdges() { return this.objects().filter((o) => o.kind === this.k.uses); }

  /** A node's dependencies: `{statement: [ids], proof: [ids]}`, as written. */
  depsOf(id) {
    const statement = [];
    const proof = [];
    for (const e of this.incident(id)) {
      if (e.kind === this.k.uses && this.end(e, 'src') === id) statement.push(this.end(e, 'tgt'));
    }
    for (const p of this.proofsOf(id)) {
      for (const e of this.incident(p.id)) {
        if (e.kind === this.k.uses && this.end(e, 'src') === p.id) proof.push(this.end(e, 'tgt'));
      }
    }
    return { statement: [...new Set(statement)], proof: [...new Set(proof)] };
  }

  allDepsOf(id) {
    const d = this.depsOf(id);
    return [...new Set(d.statement.concat(d.proof))];
  }

  /** The `uses` edges that point at a node or one of its proofs, with who uses it. */
  dependentEdgesOf(id) {
    const targets = [id, ...this.proofsOf(id).map((p) => p.id)];
    const out = [];
    for (const t of targets) {
      for (const e of this.incident(t)) {
        if (e.kind === this.k.uses && this.end(e, 'tgt') === t) {
          const src = this.end(e, 'src');
          out.push({ edge: e, src, user: this.statementOf(src) });
        }
      }
    }
    return out;
  }

  dependentsOf(id) {
    return [...new Set(this.dependentEdgesOf(id).map((d) => d.user))].filter((u) => u !== id);
  }

  /** Parents in the collapse order: the sections (or proofs, edges) an object refines. */
  parentsOf(id) {
    return this.incident(id)
      .filter((e) => e.kind === this.k.collapse && this.end(e, 'src') === id)
      .map((e) => this.end(e, 'tgt'));
  }

  childrenOf(id) {
    return this.incident(id)
      .filter((e) => e.kind === this.k.collapse && this.end(e, 'tgt') === id)
      .map((e) => this.end(e, 'src'));
  }

  /** The section a node is read in: its first parent that is a heading. */
  sectionOf(id) {
    const seen = new Set();
    let frontier = [this.statementOf(id)];
    while (frontier.length) {
      const next = [];
      for (const x of frontier) {
        for (const p of this.parentsOf(x)) {
          if (seen.has(p)) continue;
          seen.add(p);
          const o = this.get(p);
          if (o && isSectionKind(o.kind)) return p;
          next.push(this.statementOf(p));
        }
      }
      frontier = next;
    }
    return null;
  }

  depthOf(boundary) {
    let d = 0;
    for (const b of boundary) {
      const o = this.get(b.id);
      d = Math.max(d, o && typeof o.depth === 'number' ? o.depth : 0);
    }
    return boundary.length ? d + 1 : 0;
  }

  fileOf(id) {
    const o = this.get(id);
    return o && o.source && typeof o.source.file === 'string' ? o.source.file : null;
  }

  /** The directory new files of a section go to, as `import-latex` would put them. */
  dirOf(sectionId) {
    if (!sectionId) return (this.snapshot.project && this.snapshot.project.dir) || 'blueprint';
    const f = this.fileOf(sectionId);
    if (f) return f.slice(0, Math.max(0, f.lastIndexOf('/')));
    return ((this.snapshot.project && this.snapshot.project.dir) || 'blueprint') + '/' + sectionId;
  }

  // --- building blocks ------------------------------------------------------

  edge(kind, src, tgt, file) {
    const boundary = [{ role: 'src', id: src }, { role: 'tgt', id: tgt }];
    const id = derivedId(kind, boundary);
    if (this.has(id)) return this.get(id);
    const o = {
      id, kind, boundary, attrs: {}, body: '',
      source: { file: file || this.fileOf(src) || this.fileOf(this.statementOf(src)) || '', anonymous: true },
      depth: this.depthOf(boundary),
    };
    this.put(o);
    return o;
  }

  /** Add `src uses tgt`; `src` a statement or a proof. */
  addUse(src, tgt) {
    if (this.statementOf(src) === this.statementOf(tgt)) return null;
    return this.edge(this.k.uses, src, tgt);
  }

  /** Where a new dependency of `id` goes: its proof when it has one (`auto`). */
  useSource(id, where = 'auto') {
    const proofs = this.proofsOf(id);
    if (where === 'statement') return id;
    if (proofs.length) return proofs[0].id;
    return id;
  }

  ensureProof(id, body = '') {
    const proofs = this.proofsOf(id);
    if (proofs.length) return proofs[0];
    const boundary = [{ role: 'of', id }];
    const f = this.fileOf(id);
    const p = {
      id: derivedId(this.k.proof || 'proof', boundary), kind: this.k.proof || 'proof', boundary, attrs: {}, body,
      source: { file: f ? f.replace(/\.md$/, '') + '.proof.md' : '', anonymous: false },
      depth: 1,
    };
    this.put(p);
    return p;
  }

  setBody(id, body) {
    const o = clone(this.get(id));
    o.body = body;
    this.put(o);
  }

  setAttrs(id, attrs) {
    const o = clone(this.get(id));
    o.attrs = o.attrs || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) delete o.attrs[k];
      else o.attrs[k] = v;
    }
    this.put(o);
  }

  /**
   * Remove objects and everything that hangs off them (their proofs, the
   * edges at them, edges at those edges).  What refined a removed object and
   * is left with no parent is moved up to the removed object's own parents,
   * so nothing drops out of its section.
   */
  remove(ids) {
    const R = new Set(ids.filter((id) => this.has(id)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...R]) {
        for (const o of this.incident(id)) {
          if (!R.has(o.id)) { R.add(o.id); grew = true; }
        }
      }
    }
    const liftParents = (id, seen = new Set()) => {
      if (seen.has(id)) return [];
      seen.add(id);
      const base = this.statementOf(id);
      const out = [];
      for (const p of this.parentsOf(base)) {
        if (R.has(p)) out.push(...liftParents(p, seen));
        else out.push(p);
      }
      if (base !== id && R.has(base)) out.push(...liftParents(base, seen));
      return [...new Set(out)];
    };
    const reparent = [];
    for (const id of R) {
      const e = this.get(id);
      if (!e || e.kind !== this.k.collapse) continue;
      const child = this.end(e, 'src');
      const parent = this.end(e, 'tgt');
      if (R.has(child)) continue;
      const kept = this.parentsOf(child).filter((p) => !R.has(p));
      if (kept.length) continue;
      reparent.push([child, liftParents(parent)]);
    }
    for (const id of R) this.del(id);
    for (const [child, parents] of reparent) {
      for (const p of parents) if (this.has(p) && p !== child) this.edge(this.k.collapse, child, p);
    }
    return R;
  }

  /**
   * Rewrite `[old]` references (and quiet links `[text](@old)`) in every body:
   * `map` from id to a new id, or to `{text}` for a reference that is to read
   * as plain text from now on.  Fenced code is kept as written.
   */
  rewriteRefs(map) {
    if (!map.size) return;
    const slug = new RegExp(SLUG_PATTERN, 'g');
    const quiet = /\[([^\]\n]*)\]\(@([A-Za-z0-9][A-Za-z0-9._~/-]*)\)/g;
    for (const o of this.objects()) {
      if (!o.body || o.body.indexOf('[') < 0) continue;
      let changed = false;
      const body = mapProseLines(o.body, (line) => line
        .replace(quiet, (whole, text, id) => {
          if (!map.has(id)) return whole;
          changed = true;
          const to = map.get(id);
          return typeof to === 'string' ? `[${text}](@${to})` : text;
        })
        .replace(slug, (whole, id) => {
          if (!map.has(id)) return whole;
          changed = true;
          const to = map.get(id);
          return typeof to === 'string' ? `[${to}]` : to.text;
        }));
      if (changed) this.setBody(o.id, body);
    }
  }

  /** Give `from` the id `to`, carrying every edge, proof and reference along. */
  rename(from, to) {
    if (from === to) return;
    if (!ID_RE.test(to)) fail(`"${to}" is not a valid id (${ID_RULE})`);
    if (this.has(to)) fail(`there is already an object "${to}"`);
    const o = clone(this.get(from));
    o.id = to;
    const kind = this.k.kinds[o.kind];
    if (kind && Array.isArray(kind.attrs) && kind.attrs.includes('aliases')) {
      o.attrs.aliases = [...new Set([...(o.attrs.aliases || []), from])];
    }
    this.del(from);
    this.put(o);
    const map = new Map([[from, to]]);
    this.renames.push([from, to]);
    for (let pass = 0; pass < 8; pass += 1) {
      let changed = false;
      for (const x of this.objects()) {
        if (!(x.boundary || []).some((b) => map.has(b.id))) continue;
        const before = derivedId(x.kind, x.boundary);
        const y = clone(x);
        y.boundary = y.boundary.map((b) => ({ ...b, id: map.has(b.id) ? map.get(b.id) : b.id }));
        if (x.id === before) {
          y.id = derivedId(y.kind, y.boundary);
          if (y.id !== x.id) {
            map.set(x.id, y.id);
            this.renames.push([x.id, y.id]);
          }
        }
        if (y.id !== x.id) this.del(x.id);
        this.put(y);
        changed = true;
      }
      if (!changed) break;
    }
    this.rewriteRefs(map);
  }

  /** `order` for an object placed just before (or after) `id` among its siblings. */
  orderNear(id, { before = true, i = 0, n = 1 } = {}) {
    const ordOf = (x) => {
      const o = this.get(x);
      return o && o.attrs && typeof o.attrs.order === 'number' ? o.attrs.order : null;
    };
    const ord = ordOf(id);
    if (ord === null) return undefined;
    // The sibling on the other side, so that the new ones fall between the two.
    const parent = this.parentsOf(id)[0] || null;
    const sibs = (parent ? this.childrenOf(parent) : []).map(ordOf).filter((x) => x !== null);
    const other = before
      ? sibs.filter((x) => x < ord).reduce((a, b) => Math.max(a, b), ord - 1)
      : sibs.filter((x) => x > ord).reduce((a, b) => Math.min(a, b), ord + 1);
    const step = (ord - other) / (n + 1);
    return before ? other + step * (i + 1) : ord + (other - ord) / (n + 1) * (i + 1);
  }

  nextOrderIn(section) {
    let max = 0;
    const kids = section ? this.childrenOf(section) : this.objects().filter((o) => this.isNode(o) && !this.parentsOf(o.id).length).map((o) => o.id);
    for (const c of kids) {
      const o = this.get(c);
      if (o && o.attrs && typeof o.attrs.order === 'number') max = Math.max(max, o.attrs.order);
    }
    return max + 1;
  }

  /**
   * Refuse a Lean name that is not one (`LEAN_NAME_RE`), as the reader typed
   * it.  A name some object of the blueprint carries already is let through,
   * so that a merge never trips over one the blueprint was built with.
   */
  checkLean(names) {
    let carried = null;
    for (const n of names || []) {
      if (typeof n === 'string' && LEAN_NAME_RE.test(n)) continue;
      if (!carried) carried = new Set([...this.orig.values()].flatMap((o) => (o.attrs && Array.isArray(o.attrs.lean) ? o.attrs.lean : [])));
      if (!carried.has(n)) fail(`"${n}" is not a Lean name (identifiers joined by ".", or «quoted» parts without {}%#\\)`);
    }
  }

  /** A fresh id for a statement of `kind` titled `title`. */
  suggestId(kind, title) {
    const prefix = { definition: 'def', lemma: 'lem', theorem: 'thm', proposition: 'prop',
      corollary: 'cor', remark: 'rem', example: 'ex', section: 'sec' }[kind] || kind;
    let slug = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/\$[^$]*\$/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .split('-').filter(Boolean).slice(0, 5).join('-');
    if (!slug) slug = 'new';
    const stem = `${prefix}-${slug}`;
    let id = stem;
    for (let k = 2; this.has(id); k += 1) id = `${stem}-${k}`;
    return id;
  }

  /**
   * Create a node: `{id, kind, title, statement, proof, section, order,
   * uses: [ids], proofUses: [ids], usedBy: [ids], lean: [names]}`.
   */
  createNode(spec) {
    const id = spec.id || this.suggestId(spec.kind, spec.title);
    if (!ID_RE.test(id)) fail(`"${id}" is not a valid id (${ID_RULE})`);
    if (this.has(id)) fail(`there is already an object "${id}"`);
    if (!this.k.nodes.includes(spec.kind)) fail(`"${spec.kind}" is not a kind of statement in this blueprint`);
    this.checkLean(spec.lean);
    const section = spec.section && this.has(spec.section) ? spec.section : null;
    const attrs = {};
    if (spec.title) attrs.title = spec.title;
    const order = spec.order !== undefined ? spec.order : this.nextOrderIn(section);
    if (order !== undefined) attrs.order = order;
    if (spec.lean && spec.lean.length) attrs.lean = spec.lean;
    const o = {
      id, kind: spec.kind, boundary: [], attrs, body: spec.statement || '',
      source: { file: `${this.dirOf(section)}/${id}.md`, anonymous: false },
      depth: 0,
    };
    this.put(o);
    if (section) this.edge(this.k.collapse, id, section);
    if (spec.proof && spec.proof.trim()) this.ensureProof(id, spec.proof);
    for (const t of spec.uses || []) if (this.has(t)) this.addUse(id, t);
    for (const t of spec.proofUses || []) if (this.has(t)) this.addUse(this.useSource(id), t);
    for (const u of spec.usedBy || []) if (this.has(u) && u !== id) this.addUse(this.useSource(u), id);
    return id;
  }

  /** Change a node's kind, title, texts and Lean names; a proof emptied away is removed, its dependencies kept on the statement. */
  editNode(id, spec) {
    const o = this.get(id);
    if (!o) fail(`no object "${id}"`);
    if (spec.kind !== undefined && spec.kind !== o.kind) {
      if (!this.k.nodes.includes(spec.kind) && !isSectionKind(spec.kind)) fail(`"${spec.kind}" is not a kind of statement in this blueprint`);
      const x = clone(this.get(id));
      x.kind = spec.kind;
      this.put(x);
    }
    const attrs = {};
    if (spec.title !== undefined) attrs.title = spec.title.trim();
    if (spec.lean !== undefined) { this.checkLean(spec.lean); attrs.lean = spec.lean; }
    if (Object.keys(attrs).length) this.setAttrs(id, attrs);
    if (spec.statement !== undefined && spec.statement !== this.get(id).body) this.setBody(id, spec.statement);
    if (spec.proof !== undefined) {
      const proofs = this.proofsOf(id);
      if (spec.proof.trim()) {
        const p = this.ensureProof(id, spec.proof);
        if (p.body !== spec.proof) this.setBody(p.id, spec.proof);
      } else if (proofs.length) {
        const deps = this.depsOf(id).proof;
        const p = proofs[0];
        // A proof with details of its own stays; an empty one goes, its
        // dependencies moving to the statement.
        if (!this.childrenOf(p.id).length) {
          this.remove([p.id]);
          for (const t of deps) if (this.has(t)) this.addUse(id, t);
        } else if (p.body) {
          this.setBody(p.id, '');
        }
      }
    }
    if (spec.id && spec.id !== id) this.rename(id, spec.id);
    return spec.id || id;
  }
}

// ---------------------------------------------------------------------------
// operations: each returns an op, computed against `snapshot`
// ---------------------------------------------------------------------------

function makeOp(op, label, draft, ids) {
  const changes = draft.changes();
  if (!changes.length) fail('nothing to change');
  return { op, label, at: new Date().toISOString(), ids: ids.filter(Boolean), changes };
}

const titleOr = (d, id) => {
  const o = d.get(id);
  return o && o.attrs && o.attrs.title ? o.attrs.title : id;
};

/**
 * Delete a node.  `mode: 'bridge'` (the default) reconnects: whatever used it
 * now uses what it used; `'drop'` only takes it and its edges away.  A
 * reference to it in prose is left as its title.
 */
export function opDelete(snapshot, id, { mode = 'bridge' } = {}) {
  const d = new Draft(snapshot);
  const o = d.get(id);
  if (!o) fail(`no object "${id}"`);
  const deps = d.allDepsOf(id).filter((t) => t !== id);
  const users = d.dependentEdgesOf(id).filter((u) => u.user !== id);
  const title = titleOr(d, id);
  d.remove([id]);
  let bridged = 0;
  if (mode === 'bridge') {
    for (const u of users) {
      if (!d.has(u.src)) continue;
      for (const t of deps) {
        if (!d.has(t) || d.statementOf(t) === u.user) continue;
        if (d.addUse(u.src, t)) bridged += 1;
      }
    }
  }
  d.rewriteRefs(new Map([[id, { text: title }]]));
  const how = mode === 'bridge' && users.length && deps.length ? ', reconnecting its users to its dependencies' : '';
  return { ...makeOp('delete', `Delete ${id}${how}`, d, [...new Set(users.map((u) => u.user))]), removed: [id], bridged };
}

/** Add a new node (see `Draft.createNode`). */
export function opAdd(snapshot, spec) {
  const d = new Draft(snapshot);
  const id = d.createNode(spec);
  return makeOp('add', `Add ${spec.kind} ${id}`, d, [id]);
}

/**
 * Edit a node in place — replace its id, kind, title, statement, proof or
 * Lean names, keeping every edge.
 */
export function opEdit(snapshot, id, spec) {
  const d = new Draft(snapshot);
  const before = d.get(id);
  if (!before) fail(`no object "${id}"`);
  const now = d.editNode(id, spec);
  const what = [];
  if (now !== id) what.push(`rename to ${now}`);
  if (spec.kind !== undefined && spec.kind !== before.kind) what.push(`kind ${spec.kind}`);
  if (spec.title !== undefined && (spec.title.trim() || undefined) !== (before.attrs.title || undefined)) what.push('title');
  if (spec.statement !== undefined && spec.statement !== before.body) what.push('statement');
  if (spec.proof !== undefined) what.push('proof');
  return makeOp('edit', `Edit ${id}` + (what.length ? ` (${what.join(', ')})` : ''), d, [now]);
}

/** `src` uses `tgt`: in its proof when it has one, unless `where` says `statement` or `proof`. */
export function opAddUse(snapshot, src, tgt, { where = 'auto' } = {}) {
  const d = new Draft(snapshot);
  if (!d.has(src) || !d.has(tgt)) fail('both ends must exist');
  const user = d.statementOf(src);
  const dep = d.statementOf(tgt);
  if (user === dep) fail('a node cannot use itself');
  if (d.allDepsOf(user).includes(dep)) fail(`${user} already uses ${dep}`);
  let from = src;
  if (from === user) {
    if (where === 'proof') from = d.ensureProof(user).id;
    else from = d.useSource(user, where);
  }
  d.addUse(from, dep);
  return makeOp('use', `${user} uses ${dep}`, d, [user, dep]);
}

/** Take away every `uses` from `user` (statement and proofs) to `dep`. */
export function opRemoveUse(snapshot, user, dep) {
  const d = new Draft(snapshot);
  const u = d.statementOf(user);
  const t = d.statementOf(dep);
  const srcs = new Set([u, ...d.proofsOf(u).map((p) => p.id)]);
  const tgts = new Set([t, ...d.proofsOf(t).map((p) => p.id)]);
  const gone = d.usesEdges().filter((e) => srcs.has(d.end(e, 'src')) && tgts.has(d.end(e, 'tgt'))).map((e) => e.id);
  if (!gone.length) fail(`${u} does not use ${t}`);
  d.remove(gone);
  return makeOp('unuse', `${u} no longer uses ${t}`, d, [u, t]);
}

/** Take away the given relation objects (an arc of the graph stands for several). */
export function opRemoveEdges(snapshot, ids) {
  const d = new Draft(snapshot);
  const gone = ids.filter((id) => d.has(id) && d.get(id).kind === d.k.uses);
  if (!gone.length) fail('no dependency to remove');
  const pairs = gone.map((id) => {
    const e = d.get(id);
    return `${d.statementOf(d.end(e, 'src'))} → ${d.statementOf(d.end(e, 'tgt'))}`;
  });
  const ends = gone.flatMap((id) => [d.statementOf(d.end(d.get(id), 'src')), d.statementOf(d.end(d.get(id), 'tgt'))]);
  d.remove(gone);
  return makeOp('unuse', `Remove ${gone.length === 1 ? 'dependency' : gone.length + ' dependencies'} ${[...new Set(pairs)].join(', ')}`, d, [...new Set(ends)]);
}

/**
 * Split a node into smaller ones that can be reused.
 *
 *   pieces: [{id, kind, title, statement, proof, from: 'statement'|'proof',
 *             deps: [ids it uses], usedBy: [other nodes that use it]}]
 *   statement, proof: the original's texts after the split (what was moved
 *             out replaced by references to the pieces), when changed
 *   dropMovedDeps: the original stops using what a piece now uses for it
 *   replaceOriginal: the original goes; what used it uses the pieces
 *
 * The pieces go into the original's section, just before it.
 */
export function opSplit(snapshot, id, spec) {
  const d = new Draft(snapshot);
  const o = d.get(id);
  if (!o) fail(`no object "${id}"`);
  const pieces = (spec.pieces || []).filter((p) => p && (p.statement || p.title || p.id));
  if (!pieces.length) fail('a split needs at least one new piece');
  const section = d.sectionOf(id) || d.parentsOf(id)[0] || null;
  const made = [];
  pieces.forEach((p, i) => {
    const pid = d.createNode({
      id: p.id, kind: p.kind || 'lemma', title: p.title, statement: p.statement, proof: p.proof,
      section, order: d.orderNear(id, { before: true, i, n: pieces.length }), lean: p.lean,
      uses: (p.deps || []).filter((t) => t !== id), usedBy: (p.usedBy || []).filter((u) => u !== id),
    });
    made.push({ id: pid, from: p.from, deps: p.deps || [] });
  });
  if (!spec.replaceOriginal) {
    if (spec.statement !== undefined || spec.proof !== undefined) {
      d.editNode(id, { statement: spec.statement, proof: spec.proof });
    }
    for (const m of made) {
      const from = m.from === 'proof' ? d.ensureProof(id).id : id;
      d.addUse(from, m.id);
    }
    if (spec.dropMovedDeps) {
      const moved = new Set(made.flatMap((m) => m.deps));
      const srcs = new Set([id, ...d.proofsOf(id).map((p) => p.id)]);
      const gone = d.usesEdges().filter((e) => srcs.has(d.end(e, 'src')) && moved.has(d.end(e, 'tgt'))).map((e) => e.id);
      d.remove(gone);
    }
  } else {
    const users = d.dependentEdgesOf(id).filter((u) => u.user !== id && !made.some((m) => m.id === u.user));
    d.remove([id]);
    for (const u of users) {
      if (!d.has(u.src)) continue;
      for (const m of made) d.addUse(u.src, m.id);
    }
    d.rewriteRefs(new Map([[id, made[0].id]]));
  }
  const names = made.map((m) => m.id).join(', ');
  return makeOp('split', spec.replaceOriginal ? `Replace ${id} by ${names}` : `Split ${names} out of ${id}`, d,
    [spec.replaceOriginal ? null : id, ...made.map((m) => m.id)]);
}

/**
 * Merge several nodes into one.  `keep` is the one that stays (default the
 * first); `spec` may give it a new id, kind, title, statement and proof.  The
 * others go: what they used the merged node uses, what used them uses it, and
 * a reference to them is one to it.
 */
export function opMerge(snapshot, ids, spec = {}) {
  const d = new Draft(snapshot);
  const all = [...new Set(ids.map((x) => d.statementOf(x)))].filter((x) => d.has(x));
  if (all.length < 2) fail('a merge needs at least two nodes');
  const keep = spec.keep && all.includes(spec.keep) ? spec.keep : all[0];
  const others = all.filter((x) => x !== keep);
  const inSet = (x) => all.includes(d.statementOf(x));
  const lean = new Set(d.get(keep).attrs.lean || []);
  const stmtDeps = [];
  const proofDeps = [];
  const users = [];
  const kids = [];
  for (const x of others) {
    const deps = d.depsOf(x);
    stmtDeps.push(...deps.statement.filter((t) => !inSet(t)));
    proofDeps.push(...deps.proof.filter((t) => !inSet(t)));
    users.push(...d.dependentEdgesOf(x).filter((u) => !inSet(u.user)));
    for (const n of d.get(x).attrs.lean || []) lean.add(n);
    for (const p of [x, ...d.proofsOf(x).map((q) => q.id)]) {
      for (const c of d.childrenOf(p)) if (!inSet(c)) kids.push(c);
    }
  }
  const hasProof = spec.proof !== undefined ? !!spec.proof.trim() : (d.proofsOf(keep).length > 0 || proofDeps.length > 0);
  // What refined a merged node (or its proof) refines the merged one.
  for (const c of new Set(kids)) d.edge(d.k.collapse, c, keep);
  d.remove(others);
  d.editNode(keep, {
    kind: spec.kind, title: spec.title, statement: spec.statement,
    proof: spec.proof !== undefined ? spec.proof : undefined,
    lean: lean.size ? [...lean] : undefined,
  });
  for (const t of stmtDeps) if (d.has(t)) d.addUse(keep, t);
  for (const t of proofDeps) if (d.has(t)) d.addUse(hasProof ? d.ensureProof(keep).id : keep, t);
  for (const u of users) if (d.has(u.src)) d.addUse(u.src, keep);
  d.rewriteRefs(new Map(others.map((x) => [x, keep])));
  let final = keep;
  if (spec.id && spec.id !== keep) { d.rename(keep, spec.id); final = spec.id; }
  return { ...makeOp('merge', `Merge ${all.join(', ')} into ${final}`, d, [final]), removed: others };
}

// ---------------------------------------------------------------------------
// replaying the log
// ---------------------------------------------------------------------------

/** The base snapshot with every op's changes applied, in order.  `base` is untouched. */
export function applyOps(base, ops) {
  if (!ops || !ops.length) return base;
  const byId = new Map();
  for (const o of base.objects) byId.set(o.id, o);
  const status = { ...((base.derived && base.derived.status) || {}) };
  for (const op of ops) {
    for (const ch of op.changes || []) {
      if (ch.put && ch.put.id) byId.set(ch.put.id, clone(ch.put));
      else if (ch.del) byId.delete(ch.del);
      else if (ch.rename) {
        const { from, to } = ch.rename;
        if (from in status) { status[to] = status[from]; delete status[from]; }
      }
    }
  }
  return {
    ...base,
    objects: [...byId.values()],
    derived: { ...(base.derived || {}), status, checks: [] },
  };
}

// ---------------------------------------------------------------------------
// what the editing did, and whether the graph is still sound
// ---------------------------------------------------------------------------

/** statement id -> Set of statement ids it uses, over the nodes. */
export function usesRelation(snapshot) {
  const d = new Draft(snapshot);
  const rel = new Map();
  for (const e of d.usesEdges()) {
    const s = d.statementOf(d.end(e, 'src'));
    const t = d.statementOf(d.end(e, 'tgt'));
    if (!s || !t || !d.isNode(d.get(s)) || !d.isNode(d.get(t))) continue;
    if (!rel.has(s)) rel.set(s, new Set());
    rel.get(s).add(t);
  }
  return rel;
}

/** The dependency cycles (strongly connected components, self-loops included). */
export function findCycles(rel) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const on = new Set();
  const stack = [];
  const out = [];
  const nodes = new Set([...rel.keys(), ...[...rel.values()].flatMap((s) => [...s])]);
  for (const root of nodes) {
    if (idx.has(root)) continue;
    // iterative Tarjan
    const work = [[root, 0]];
    while (work.length) {
      const [v, i] = work[work.length - 1];
      if (i === 0) {
        idx.set(v, index); low.set(v, index); index += 1;
        stack.push(v); on.add(v);
      }
      const succ = [...(rel.get(v) || [])];
      if (i < succ.length) {
        work[work.length - 1][1] = i + 1;
        const w = succ[i];
        if (!idx.has(w)) work.push([w, 0]);
        else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low.set(u, Math.min(low.get(u), low.get(v)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1 || (rel.get(v) && rel.get(v).has(v))) out.push(comp.reverse());
      }
    }
  }
  return out;
}

/**
 * The graph's soundness after editing: `cycles` among the dependencies (a
 * warning: a blueprint in progress may have one), `dangling` boundary
 * entries (an error the editor never makes), and `brokenLinks` in prose.
 */
export function checkGraph(snapshot) {
  const ids = new Set(snapshot.objects.map((o) => o.id));
  const dangling = [];
  const brokenLinks = [];
  const slug = new RegExp(SLUG_PATTERN, 'g');
  for (const o of snapshot.objects) {
    for (const b of o.boundary || []) if (!ids.has(b.id)) dangling.push({ id: o.id, ref: b.id });
    if (o.body && o.body.indexOf('[') >= 0) {
      // fenced code is no prose: `simp [add_zero]` there is no link
      const lines = o.body.split('\n');
      const fenced = fencedLines(lines);
      const prose = lines.filter((_, i) => !fenced[i]).join('\n');
      for (const m of prose.matchAll(slug)) if (!ids.has(m[1]) && /[-_]/.test(m[1])) brokenLinks.push({ id: o.id, ref: m[1] });
    }
  }
  return { cycles: findCycles(usesRelation(snapshot)), dangling, brokenLinks };
}

/**
 * What changed between `base` and `edited`, node by node:
 * { added, removed, changed: [{id, what: [...]}], usesAdded: [[s,t]], usesRemoved, marks: Map id -> 'new'|'changed' }
 */
export function summarize(base, edited) {
  const db = new Draft(base);
  const de = new Draft(edited);
  const nodeIds = (d) => new Set(d.objects().filter((o) => d.isNode(o) && o.kind !== TEXT_KIND).map((o) => o.id));
  const nb = nodeIds(db);
  const ne = nodeIds(de);
  const added = [...ne].filter((x) => !nb.has(x));
  const removed = [...nb].filter((x) => !ne.has(x));
  const changed = [];
  const proofText = (d, id) => d.proofsOf(id).map((p) => p.body).join('\n');
  for (const id of ne) {
    if (!nb.has(id)) continue;
    const a = db.get(id);
    const b = de.get(id);
    const what = [];
    if (a.kind !== b.kind) what.push('kind');
    if ((a.attrs.title || '') !== (b.attrs.title || '')) what.push('title');
    if ((a.body || '') !== (b.body || '')) what.push('statement');
    if (proofText(db, id) !== proofText(de, id)) what.push('proof');
    if (JSON.stringify(a.attrs.lean || []) !== JSON.stringify(b.attrs.lean || [])) what.push('lean');
    if (db.parentsOf(id).join() !== de.parentsOf(id).join()) what.push('section');
    if (what.length) changed.push({ id, what });
  }
  const pairs = (rel) => {
    const s = new Set();
    for (const [a, ts] of rel) for (const t of ts) s.add(a + '\u0000' + t);
    return s;
  };
  const ub = pairs(usesRelation(base));
  const ue = pairs(usesRelation(edited));
  const split = (k) => k.split('\u0000');
  const usesAdded = [...ue].filter((k) => !ub.has(k)).map(split);
  const usesRemoved = [...ub].filter((k) => !ue.has(k)).map(split);
  const marks = new Map();
  for (const id of added) marks.set(id, 'new');
  for (const c of changed) marks.set(c.id, 'changed');
  for (const [s] of usesAdded.concat(usesRemoved)) if (!marks.has(s) && ne.has(s)) marks.set(s, 'changed');
  return { added, removed, changed, usesAdded, usesRemoved, marks };
}

// ---------------------------------------------------------------------------
// the edit file
// ---------------------------------------------------------------------------

/** A short, stable name for a snapshot: its project and a hash of its node ids. */
export function fingerprint(snapshot) {
  const ids = snapshot.objects.filter((o) => !(o.boundary || []).length).map((o) => o.id).sort();
  let h = 2166136261;
  for (const s of ids) {
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 10; h = Math.imul(h, 16777619) >>> 0;
  }
  return { project: (snapshot.project && (snapshot.project.name || snapshot.project.title)) || '', nodes: ids.length,
    hash: h.toString(16).padStart(8, '0') };
}

/** The edit file: the log, and what it was made against. */
export function serializeEdits(base, ops) {
  return JSON.stringify({ format: EDIT_FORMAT, version: EDIT_VERSION, base: fingerprint(base),
    saved: new Date().toISOString(), ops }, null, 1);
}

// What an edit file may hold.  Its ops are replayed as they stand and their
// objects drawn on every page, so a file (or a log in localStorage) is read
// as untrusted: every field of every op is checked here, and the prose it
// carries is rendered through the sanitiser (app.js, `untrustedOf`).
const OP_KINDS = ['add', 'delete', 'edit', 'use', 'unuse', 'split', 'merge'];
const OP_KEYS = new Set(['op', 'label', 'at', 'ids', 'changes', 'removed', 'bridged']);
const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const VERSION_RE = /^[0-9a-f]{8}$/;

const isPlain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isId = (x) => typeof x === 'string' && OBJECT_ID_RE.test(x);
const strings = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];

function checkObject(o, where) {
  if (!isPlain(o)) fail(`${where}: "put" is not an object`);
  if (!isId(o.id)) fail(`${where}: ${JSON.stringify(o.id)} is not an id`);
  where = `${where} (${o.id})`;
  if (typeof o.kind !== 'string' || !KIND_RE.test(o.kind)) fail(`${where}: ${JSON.stringify(o.kind)} is not a kind`);
  if (!Array.isArray(o.boundary) || !o.boundary.every((b) => isPlain(b) && typeof b.role === 'string' && KIND_RE.test(b.role) && isId(b.id))) {
    fail(`${where}: "boundary" is not a list of {role, id}`);
  }
  if (!isPlain(o.attrs)) fail(`${where}: "attrs" is not an object`);
  for (const k of Object.keys(o.attrs)) if (BAD_KEYS.includes(k)) fail(`${where}: an attribute "${k}"`);
  const a = o.attrs;
  if (a.title !== undefined && typeof a.title !== 'string') fail(`${where}: its title is not a string`);
  if (a.source !== undefined && typeof a.source !== 'string') fail(`${where}: its source is not a string`);
  if (a.order !== undefined && typeof a.order !== 'number') fail(`${where}: its order is not a number`);
  for (const k of ['lean', 'aliases', 'tags']) if (a[k] !== undefined && !strings(a[k])) fail(`${where}: its ${k} is not a list of strings`);
  if (o.body !== undefined && typeof o.body !== 'string') fail(`${where}: its body is not a string`);
  if (o.source !== undefined && !(isPlain(o.source) && (o.source.file === undefined || typeof o.source.file === 'string'))) {
    fail(`${where}: its "source" is not a {file}`);
  }
  if (o.depth !== undefined && typeof o.depth !== 'number') fail(`${where}: its depth is not a number`);
}

function checkOp(op, n) {
  const where = `edit ${n}`;
  if (!isPlain(op)) fail(`${where} is not an object`);
  for (const k of Object.keys(op)) if (!OP_KEYS.has(k)) fail(`${where} has an unknown field "${k}"`);
  if (!OP_KINDS.includes(op.op)) fail(`${where}: ${JSON.stringify(op.op)} is not a kind of edit (${OP_KINDS.join(', ')})`);
  if (typeof op.label !== 'string') fail(`${where} has no "label"`);
  if (op.at !== undefined && typeof op.at !== 'string') fail(`${where}: "at" is not a date`);
  if (!Array.isArray(op.ids) || !op.ids.every(isId)) fail(`${where}: "ids" is not a list of ids`);
  if (op.removed !== undefined && !(Array.isArray(op.removed) && op.removed.every(isId))) fail(`${where}: "removed" is not a list of ids`);
  if (op.bridged !== undefined && typeof op.bridged !== 'number') fail(`${where}: "bridged" is not a number`);
  if (!Array.isArray(op.changes) || !op.changes.length) fail(`${where} has no "changes"`);
  op.changes.forEach((ch, i) => {
    const at = `${where}, change ${i + 1}`;
    if (!isPlain(ch)) fail(`${at} is not an object`);
    const keys = Object.keys(ch).filter((k) => k !== 'was');
    if (keys.length !== 1 || !['put', 'del', 'rename'].includes(keys[0])) fail(`${at} is neither one "put", "del" nor "rename"`);
    if (ch.was !== undefined && ch.was !== null && !(typeof ch.was === 'string' && VERSION_RE.test(ch.was))) fail(`${at}: "was" is not a version`);
    if (ch.put !== undefined) checkObject(ch.put, at);
    else if (ch.del !== undefined) { if (!isId(ch.del)) fail(`${at}: ${JSON.stringify(ch.del)} is not an id`); }
    else if (!(isPlain(ch.rename) && Object.keys(ch.rename).length === 2 && isId(ch.rename.from) && isId(ch.rename.to))) {
      fail(`${at}: "rename" is not a {from, to} of ids`);
    }
  });
}

/** Check a log (an edit file's, or the one kept in the browser); throws EditError on anything amiss. */
export function checkOps(ops) {
  if (!Array.isArray(ops)) fail('the edits are not a list');
  ops.forEach((op, i) => checkOp(op, i + 1));
  return ops;
}

/**
 * Read an edit file; throws EditError when it is not one, or (with
 * `snapshot`) when it was made on another blueprint.
 */
export function parseEdits(text, { snapshot = null } = {}) {
  let data;
  try { data = JSON.parse(text); } catch (e) { fail('not a JSON file'); }
  if (!isPlain(data) || data.format !== EDIT_FORMAT) fail('not a blueprint edit file (no "format": "blueprint-edits")');
  if (data.version !== EDIT_VERSION) fail(`edit file version ${data.version} is not supported`);
  const base = data.base === undefined || data.base === null ? null : data.base;
  if (base !== null && !(isPlain(base) && typeof base.project === 'string' && typeof base.hash === 'string')) {
    fail('the edit file\'s "base" does not name a snapshot');
  }
  if (base && snapshot) {
    const here = fingerprint(snapshot).project;
    if (base.project !== here) fail(`these edits were made on the blueprint "${base.project}", not on "${here}"`);
  }
  if (!Array.isArray(data.ops)) fail('the edit file has no "ops" list');
  checkOps(data.ops);
  return { ops: data.ops, base };
}

// ---------------------------------------------------------------------------
// replaying onto another snapshot
// ---------------------------------------------------------------------------

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isPlain(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * A short hash of what an object says — its kind, boundary, attributes and
 * body, not where its file is or how deep it sits — recorded with each change
 * as `was`, the version of the object the change was made against.
 */
export function versionOf(o) {
  const s = canonical({ kind: o.kind, boundary: o.boundary || [], attrs: o.attrs || {}, body: o.body || '' });
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/**
 * An op puts whole objects in place, so replayed onto a snapshot in which one
 * of them has changed since (upstream) it puts back the version it was made
 * on, undoing that change.  This finds them: every object a change touches
 * whose version on `base`, as edited by the ops before, is not the `was` the
 * change was recorded against.  `[{id, label, how}]`, `how` one of
 * 'changed' (since the edit), 'removed', 'added' (an object the edit creates
 * that `base` already has) or 'unknown' (a change recorded without `was`).
 */
export function replayConflicts(base, ops) {
  const cur = new Map();
  for (const o of base.objects) cur.set(o.id, o);
  const out = [];
  const seen = new Set();
  for (const op of ops || []) {
    for (const ch of op.changes || []) {
      const id = ch.put ? ch.put.id : ch.del;
      if (id === undefined) continue;
      if (!seen.has(id)) {
        let how = null;
        if (ch.was === undefined) how = 'unknown';
        else {
          const now = cur.has(id) ? versionOf(cur.get(id)) : null;
          if (now !== ch.was) how = ch.was === null ? 'added' : now === null ? 'removed' : 'changed';
        }
        if (how) { out.push({ id, label: op.label, how }); seen.add(id); }
      }
      if (ch.put) cur.set(id, ch.put);
      else cur.delete(id);
    }
  }
  return out;
}

/** Whether an edit file's base is this snapshot (same project and the same nodes). */
export function sameBase(a, b) {
  return !!a && !!b && a.project === b.project && a.hash === b.hash;
}
