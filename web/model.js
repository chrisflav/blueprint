// model.js — pure logic for the blueprint snapshot format.
//
// No DOM, no fetch, no globals. Everything here is a plain function over a
// snapshot (docs/snapshot-format.md) so it can be unit tested under node.
//
// Vocabulary follows DESIGN.md sections 2-4:
//   * an *object* is the only sort of thing; nodes, edges, hyperedges and
//     edges-between-edges differ only in their `boundary`.
//   * a *collapse kind* K is a kind with `collapse: true` and an acyclic
//     src -> tgt relation.  `src` is the detail, `tgt` is the coarser object,
//     so `x <=K y` means "x is a detail of y".
//   * a *view* is an upward-closed set X of expanded ids.
//   * the *quotient* of a view is what the graph draws.
//
// Cost.  A real blueprint is a few thousand objects, and the graph page rebuilds
// its view on every expand, collapse, filter and keystroke, so everything here
// is linear or near-linear in the snapshot and the repeated work is cached:
//
//   * `collapseOrder` precomputes the ancestor chain of every object once per
//     collapse kind (topologically, so it is one pass), and memoises descendant
//     sets on demand;
//   * `makeView` is memoised on (collapse kind, normalised expanded set), so
//     going back to a view you have seen — which is what collapse-then-expand
//     is — costs a map lookup;
//   * `quotient` is memoised on the view plus its options.
//
// Every cache is keyed by immutable data derived from the model, so it cannot go
// stale: expanding or collapsing produces a *different* expanded set and hence a
// different key.  The model itself is rebuilt whenever the snapshot changes.

export const STATUSES = [
  'absent',
  'missing',
  'stated',
  'proved',
  'proved_with_axioms',
];

export const STATUS_LABEL = {
  absent: 'absent',
  missing: 'missing',
  stated: 'stated',
  proved: 'proved',
  proved_with_axioms: 'proved (extra axioms)',
};

export const CHECK_LEVELS = ['error', 'warning', 'info'];

// ---------------------------------------------------------------------------
// 1. Indexing
// ---------------------------------------------------------------------------

/**
 * Build the derived indices for a snapshot.  Everything downstream takes the
 * resulting `model` rather than the raw snapshot.
 */
export function buildModel(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('buildModel: snapshot is not an object');
  }
  const objects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
  const byId = new Map();
  for (const o of objects) {
    // Normalise the shape once so every consumer can be careless.
    o.boundary = Array.isArray(o.boundary) ? o.boundary : [];
    o.attrs = o.attrs && typeof o.attrs === 'object' ? o.attrs : {};
    if (typeof o.body !== 'string') o.body = '';
    byId.set(o.id, o);
  }

  // incidence: for an id, every (object, role) pair that mentions it in its
  // boundary.  This is "everything incident to the object" on the object page.
  const incidence = new Map();
  for (const o of objects) {
    for (const b of o.boundary) {
      if (!incidence.has(b.id)) incidence.set(b.id, []);
      incidence.get(b.id).push({ object: o, role: b.role });
    }
  }

  const kinds = (snapshot.schema && snapshot.schema.kinds) || {};
  const collapseKinds = Object.keys(kinds).filter((k) => kinds[k] && kinds[k].collapse);
  const defaultCollapse =
    (snapshot.schema && snapshot.schema.defaultCollapse) || collapseKinds[0] || null;

  const byKind = new Map();
  for (const o of objects) {
    if (!byKind.has(o.kind)) byKind.set(o.kind, []);
    byKind.get(o.kind).push(o);
  }

  // Kinds whose boundary is exactly {src, tgt}: asked about once per object in
  // the quotient, so decide it once per kind instead.
  const binaryKinds = new Set();
  for (const [name, k] of Object.entries(kinds)) {
    const b = k && k.boundary;
    if (!b) continue;
    const roles = Object.keys(b);
    if (roles.length === 2 && roles.includes('src') && roles.includes('tgt')) binaryKinds.add(name);
  }

  const model = {
    snapshot,
    objects,
    byId,
    byKind,
    incidence,
    kinds,
    binaryKinds,
    collapseKinds,
    defaultCollapse,
    status: (snapshot.derived && snapshot.derived.status) || {},
    progress: (snapshot.derived && snapshot.derived.progress) || {},
    checks: (snapshot.derived && snapshot.derived.checks) || [],
    facts: snapshot.facts || null,
    project: snapshot.project || {},
    _orders: new Map(), // memoised collapse orders
    _views: new Map(), // memoised views, keyed by kind + normalised expanded set
    _search: null, // lowercase search index, built on first search
    _searchHits: new Map(), // memoised results per query string
    _fullText: null, // the search page's index of words, built on its first search
    _positions: new Map(), // memoised document positions, per collapse kind
    _countable: null, // countable objects by title, for the progress listing
    _outlines: new Map(), // memoised document outlines, per collapse kind
    _mixes: new Map(), // memoised status counts under each object, per collapse kind
    _types: new Map(), // memoised `nodeType`, per object
    _graphModels: new Map(), // memoised `graphModel`, per choice of what to hide
    _namingRe: null, // the words that already name a reference, see `referenceLabel`
  };
  return model;
}

/** How many views to keep around.  Each one is a few sets of ids. */
const VIEW_CACHE_LIMIT = 24;
const SEARCH_CACHE_LIMIT = 64;

function cachePut(map, key, value, limit) {
  map.set(key, value);
  if (map.size > limit) {
    // Maps iterate in insertion order, so the first key is the oldest.
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  return value;
}

export function objectsOfKind(model, kind) {
  return model.byKind.get(kind) || [];
}

/** Display title for an object. */
export function titleOf(object) {
  if (!object) return '(unknown)';
  const t = object.attrs && object.attrs.title;
  return typeof t === 'string' && t.length ? t : object.id;
}

/** Derived status, or null when the kind carries no Lean reference at all. */
export function statusOf(model, id) {
  const s = model.status[id];
  return typeof s === 'string' ? s : null;
}

/**
 * The status a badge shows: the derived status, except that an object of a
 * kind that does not count toward progress (a remark, a concept, a section)
 * shows none for naming no Lean declaration, since it is not expected to.
 * Once it names one, its status shows as any other's.
 */
export function badgeStatusOf(model, id) {
  const s = statusOf(model, id);
  if (s !== 'absent') return s;
  const o = model.byId.get(id);
  const k = o && model.kinds[o.kind];
  return k && k.countable ? s : null;
}

/** {proved, total} for a collapse kind, or null. */
export function progressOf(model, kind, id) {
  const table = model.progress[kind];
  if (!table) return null;
  const p = table[id];
  if (!p || typeof p.total !== 'number') return null;
  return { proved: p.proved || 0, total: p.total };
}

/** The statement words a node's type can be, with their short marks. */
const TYPE_MARK = {
  definition: 'def', theorem: 'thm', proposition: 'prop', lemma: 'lem',
  corollary: 'cor', remark: 'rem',
};

/**
 * Kinds the document sets as headings rather than as numbered statements, and
 * the graph draws as sections: a section, and an appendix (a section the graph
 * can hide).
 */
const SECTION_KINDS = new Set(['section', 'appendix']);

export function isSectionKind(kind) {
  return SECTION_KINDS.has(kind);
}

/**
 * The kind of the text between statements that belongs to no statement: the
 * lines at the start of a section, a paragraph between two lemmas, as in the
 * Stacks project.  The document sets it as bare prose, with no heading and no
 * number; the graph never draws it (its kind is `graph = "never"`).
 */
export const TEXT_KIND = 'hidden';

/** The shape family of each statement word. */
const TYPE_SHAPE = {
  definition: 'definition', theorem: 'statement', proposition: 'statement',
  lemma: 'statement', corollary: 'statement', remark: 'remark',
};

/**
 * What a node is, for drawing: {word, mark, shape}.  The word is its kind; a
 * sketch of a statement is an object of that statement's kind (`blueprint
 * migrate` turns the sections that used to stand for one into it).  `shape`
 * is `definition`, `statement`, `remark`, `section`, or `other`.  Memoised on
 * the model.
 */
export function nodeType(model, o) {
  let t = model._types.get(o.id);
  if (t) return t;
  const word = o.kind;
  const shape = TYPE_SHAPE[word] || (isSectionKind(word) ? 'section' : 'other');
  t = { word, mark: TYPE_MARK[word] || word.slice(0, 3), shape };
  model._types.set(o.id, t);
  return t;
}

/** The order the segments of a status bar run in: done first. */
export const STATUS_BAR_ORDER = ['proved', 'proved_with_axioms', 'stated', 'missing', 'absent'];

/**
 * `progressOf` plus `mix`, the count of each derived status, so a bar can say
 * what the unproved part is.  Below an object, the counted nodes are the
 * countable leaves (countable objects at or below it with no children in the
 * order), as for `progressOf`.  A section counts its direct children instead,
 * each by its own status, leaving out those with nothing countable at or below
 * them (a remark, a concept): its progress is that of the layer right under
 * it, not of everything further down.  Memoised per kind.
 */
export function progressMixOf(model, kind, id) {
  const p = progressOf(model, kind, id);
  if (!p) return null;
  let memo = model._mixes.get(kind);
  if (!memo) model._mixes.set(kind, (memo = new Map()));
  let out = memo.get(id);
  if (!out) {
    const order = collapseOrder(model, kind);
    const mix = Object.create(null);
    const tally = (x) => {
      const s = statusOf(model, x) || 'absent';
      mix[s] = (mix[s] || 0) + 1;
    };
    // A child counts when it is countable itself or has countable leaves
    // below it, so a remark or concept right under a section is left out.
    const children = childrenOf(order, id).filter((x) => {
      const o = model.byId.get(x);
      const k = o && model.kinds[o.kind];
      return (k && k.countable) || progressOf(model, kind, x);
    });
    const self = model.byId.get(id);
    if (children.length && self && isSectionKind(self.kind)) {
      children.forEach(tally);
      out = { proved: mix.proved || 0, total: children.length, mix };
    } else {
      for (const x of [id, ...descendantsOf(order, id)]) {
        const o = model.byId.get(x);
        const k = o && model.kinds[o.kind];
        if (k && k.countable && !childrenOf(order, x).length) tally(x);
      }
      out = { ...p, mix };
    }
    memo.set(id, out);
  }
  return out;
}

/** Everything whose boundary mentions `id`, as [{object, role}]. */
export function incidentTo(model, id) {
  return model.incidence.get(id) || [];
}

/** true when the kind is an ordinary directed edge (roles src and tgt). */
export function isBinaryKind(model, kindName) {
  if (model.binaryKinds) return model.binaryKinds.has(kindName);
  const k = model.kinds[kindName];
  if (!k || !k.boundary) return false;
  const roles = Object.keys(k.boundary);
  return roles.length === 2 && roles.includes('src') && roles.includes('tgt');
}

/**
 * true when the kind's arrows are drawn tgt -> src (`arrow: "reverse"`, e.g.
 * `uses`, drawn from the dependency to its user).  Display only: `src` and
 * `tgt` keep their meaning everywhere else.
 */
export function isReversedKind(model, kindName) {
  const k = model.kinds[kindName];
  return !!k && k.arrow === 'reverse';
}

/**
 * The id of the object `object` is attached to, when its boundary is exactly
 * one object (a proof and its statement, DESIGN 2.5), else null.
 */
export function attachedTo(object) {
  return object && object.boundary.length === 1 ? object.boundary[0].id : null;
}

/**
 * How a proof is introduced: "Proof." untitled, "Proof of the detailed
 * form." when its title says what it proves, "Proof (by induction)."
 * otherwise.  Returns the text after the word "Proof".
 */
export function proofLeadRest(object) {
  const t = object && object.attrs && object.attrs.title;
  if (typeof t !== 'string' || !t) return '.';
  return /^of\s/.test(t) ? ' ' + t + '.' : ' (' + t + ').';
}

/**
 * true when objects of the kind are attached to a single object: one role,
 * holding at most one object.  They are never drawn as arcs of their own.
 */
export function isAttachedKind(model, kindName) {
  const b = model.kinds[kindName] && model.kinds[kindName].boundary;
  if (!b) return false;
  const roles = Object.values(b);
  return roles.length === 1 && roles[0] && roles[0].max === 1;
}

/** Kinds that can appear as an arc in the graph (a boundary of two or more). */
export function edgeKinds(model) {
  return Object.keys(model.kinds).filter((k) => {
    const b = model.kinds[k] && model.kinds[k].boundary;
    return b && Object.keys(b).length > 0 && !isAttachedKind(model, k);
  });
}

/** Kinds with an empty boundary: these are the nodes. */
export function nodeKinds(model) {
  return Object.keys(model.kinds).filter((k) => {
    const b = model.kinds[k] && model.kinds[k].boundary;
    return !b || Object.keys(b).length === 0;
  });
}

export function boundaryEntry(object, role) {
  for (const b of object.boundary) if (b.role === role) return b.id;
  return null;
}

// ---------------------------------------------------------------------------
// 2. Collapse orders (DESIGN 3)
// ---------------------------------------------------------------------------

/**
 * The partial order induced by the edge objects of a collapsible kind.
 * `src` is the detail, `tgt` the coarser object, so parents(src) contains tgt.
 *
 * Returns { kind, parents, children, roots, expandable, edgeFor, ancestors,
 * expandableAncestors, cyclic } where the id -> id[] maps are defined for
 * *every* object id (possibly empty).
 *
 * The ancestor chains are precomputed here, in one topological pass, because
 * every view operation asks for them: upward-closing an expanded set, deciding
 * what is visible, and walking from a hidden object up to its representatives.
 */
export function collapseOrder(model, kind) {
  if (model._orders.has(kind)) return model._orders.get(kind);

  const parents = new Map();
  const children = new Map();
  const edgeFor = new Map(); // "child parent" -> edge object id
  for (const o of model.objects) {
    parents.set(o.id, []);
    children.set(o.id, []);
  }

  const seenPair = new Set();
  for (const o of model.objects) {
    if (o.kind !== kind) continue;
    const src = boundaryEntry(o, 'src');
    const tgt = boundaryEntry(o, 'tgt');
    if (src == null || tgt == null) continue;
    if (!parents.has(src) || !parents.has(tgt)) continue; // dangling ref
    if (src === tgt) continue; // degenerate, ignore
    // `includes` on the parent list would be quadratic in a wide fan-in, and a
    // real blueprint has sections with hundreds of children.
    if (!seenPair.has(src + ' ' + tgt)) {
      seenPair.add(src + ' ' + tgt);
      parents.get(src).push(tgt);
      children.get(tgt).push(src);
    }
    edgeFor.set(src + ' ' + tgt, o.id);
  }

  const roots = new Set();
  const expandable = new Set();
  for (const o of model.objects) {
    if (parents.get(o.id).length === 0) roots.add(o.id);
    if (children.get(o.id).length > 0) expandable.add(o.id);
  }

  const order = {
    kind,
    parents,
    children,
    roots,
    expandable,
    edgeFor,
    model,
    _descendants: new Map(),
  };
  buildAncestors(order);
  model._orders.set(kind, order);
  return order;
}

/**
 * Fill in `order.ancestors` (id -> all strict ancestors) and
 * `order.expandableAncestors` (the same list, filtered), in a single
 * topological sweep over the parent relation.  Every object's chain is then a
 * map lookup rather than a walk, which is what makes `normalizeExpanded`,
 * `expand` and `visibleSet` linear.
 *
 * The collapse kind is constrained `acyclic`, but a broken snapshot can still
 * contain a cycle.  Those ids are collected in `order.cyclic` and fall back to
 * a guarded walk; nothing derived from them is cached anywhere else.
 */
function buildAncestors(order) {
  const { parents, children } = order;
  const ancestors = new Map();
  const expandableAncestors = new Map();

  // Kahn over child -> parent: emit an object only once every parent is done,
  // so its parents' chains are already known when we get to it.
  const remaining = new Map();
  const queue = [];
  for (const [id, ps] of parents) {
    remaining.set(id, ps.length);
    if (ps.length === 0) queue.push(id);
  }
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    const ps = parents.get(id);
    if (ps.length === 0) {
      ancestors.set(id, []);
      expandableAncestors.set(id, []);
    } else {
      const acc = new Set();
      for (const p of ps) {
        acc.add(p);
        for (const a of ancestors.get(p) || []) acc.add(a);
      }
      const list = [...acc];
      ancestors.set(id, list);
      expandableAncestors.set(id, list.filter((x) => order.expandable.has(x)));
    }
    for (const c of children.get(id)) {
      const n = remaining.get(c) - 1;
      remaining.set(c, n);
      if (n === 0) queue.push(c);
    }
  }

  const cyclic = new Set();
  if (queue.length !== parents.size) {
    for (const id of parents.keys()) if (!ancestors.has(id)) cyclic.add(id);
    for (const id of cyclic) {
      const list = walkAncestors(order, id);
      ancestors.set(id, list);
      expandableAncestors.set(id, list.filter((x) => order.expandable.has(x)));
    }
  }

  order.ancestors = ancestors;
  order.expandableAncestors = expandableAncestors;
  order.cyclic = cyclic;
}

/** The breadth-first ancestor walk, for the ids a cycle kept out of the sweep. */
function walkAncestors(order, id) {
  const out = [];
  const seen = new Set([id]);
  let frontier = order.parents.get(id) || [];
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      for (const q of order.parents.get(p) || []) if (!seen.has(q)) next.push(q);
    }
    frontier = next;
  }
  return out;
}

export function parentsOf(order, id) {
  return order.parents.get(id) || [];
}

export function childrenOf(order, id) {
  return order.children.get(id) || [];
}

/**
 * All strict ancestors of `id` in the collapse order, nearest first-ish.
 * Precomputed by `collapseOrder`, so this is a map lookup.  Treat the result as
 * read-only: it is the order's own array.
 */
export function ancestorsOf(order, id) {
  const a = order.ancestors && order.ancestors.get(id);
  if (a) return a;
  return order.parents.has(id) ? walkAncestors(order, id) : [];
}

/** The ancestors of `id` that have children of their own. */
export function expandableAncestorsOf(order, id) {
  const a = order.expandableAncestors && order.expandableAncestors.get(id);
  if (a) return a;
  return ancestorsOf(order, id).filter((x) => order.expandable.has(x));
}

/** All strict descendants of `id`, memoised on the order. */
export function descendantsOf(order, id) {
  const memo = order._descendants;
  if (memo && memo.has(id)) return memo.get(id);
  const out = [];
  const seen = new Set([id]);
  const stack = childrenOf(order, id).slice();
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    for (const g of childrenOf(order, c)) if (!seen.has(g)) stack.push(g);
  }
  if (memo) memo.set(id, out);
  return out;
}

/**
 * Chains of ancestors from `id` up to a root, for "position in the collapse
 * order" on the object page.  One chain per branch, at most `limit` chains.
 */
export function ancestorChains(order, id, limit = 8) {
  const chains = [];
  const walk = (cur, acc) => {
    if (chains.length >= limit) return;
    const ps = parentsOf(order, cur);
    if (ps.length === 0) {
      chains.push(acc.slice().reverse());
      return;
    }
    for (const p of ps) {
      if (acc.includes(p)) continue; // defensive: cycle
      walk(p, acc.concat([p]));
    }
  };
  walk(id, []);
  return chains;
}

// ---------------------------------------------------------------------------
// 3. Views (DESIGN 3)
// ---------------------------------------------------------------------------

/**
 * Upward-close a set of expanded ids and drop ids that cannot be expanded
 * (they have no K-children) or do not exist.
 */
export function normalizeExpanded(order, ids) {
  const out = new Set();
  for (const id of ids || []) {
    if (!order.expandable.has(id)) continue;
    out.add(id);
    for (const a of expandableAncestorsOf(order, id)) out.add(a);
  }
  return out;
}

/**
 * Visible objects: not expanded, and either a K-root or with some K-parent
 * expanded.  Objects outside the K-relation entirely are roots, hence visible.
 */
export function visibleSet(order, expanded) {
  const vis = new Set();
  for (const id of order.parents.keys()) {
    if (expanded.has(id)) continue;
    const ps = parentsOf(order, id);
    if (ps.length === 0) {
      vis.add(id);
      continue;
    }
    for (const p of ps) {
      if (expanded.has(p)) {
        vis.add(id);
        break;
      }
    }
  }
  return vis;
}

/** Expand a single object (keeping X upward closed). */
export function expand(order, expanded, id) {
  if (!order.expandable.has(id)) return new Set(expanded);
  const next = new Set(expanded);
  next.add(id);
  for (const a of expandableAncestorsOf(order, id)) next.add(a);
  return next;
}

/**
 * Collapse an object: remove it and everything below it from X, which keeps X
 * upward closed.
 */
export function collapse(order, expanded, id) {
  const next = new Set(expanded);
  next.delete(id);
  for (const d of descendantsOf(order, id)) next.delete(d);
  return next;
}

export function expandAll(order) {
  return new Set(order.expandable);
}

export function collapseAll() {
  return new Set();
}

/**
 * A view bundles the order, the expanded set, the visible set and a memoised
 * `rep`.  Treat it as immutable: expand/collapse produce a new one.
 */
export function makeView(model, kind, expandedIds = []) {
  const order = collapseOrder(model, kind);
  const expanded = normalizeExpanded(order, expandedIds);

  // The normalised expanded set *is* the identity of a view, so it is also the
  // cache key: collapsing and re-expanding lands back on the same view object,
  // and no expand or collapse can ever return a view that was built for a
  // different expanded set.
  const key = kind + ' ' + [...expanded].sort().join('');
  const cached = model._views && model._views.get(key);
  if (cached) return cached;

  const visible = visibleSet(order, expanded);
  const repCache = new Map();
  const EMPTY = new Set();

  // rep(id): the visible objects that stand for `id`.  Walks up the collapse
  // order from a hidden object; memoised, and bounded by the depth of the
  // hierarchy rather than by its size.
  function rep(id, onPath) {
    const hit = repCache.get(id);
    if (hit) return hit;
    if (visible.has(id)) {
      const s = new Set([id]);
      repCache.set(id, s);
      return s;
    }
    const parents = parentsOf(order, id);
    if (parents.length === 0) return EMPTY;
    // Only a snapshot with a cycle in the collapse kind can revisit an id, and
    // then the answer depends on where the walk started, so it is not cached.
    const cyclic = order.cyclic && order.cyclic.has(id);
    if (cyclic) {
      const seen = onPath || new Set();
      if (seen.has(id)) return EMPTY;
      seen.add(id);
      const out = new Set();
      for (const p of parents) for (const r of rep(p, seen)) out.add(r);
      seen.delete(id);
      return out;
    }
    const out = new Set();
    for (const p of parents) for (const r of rep(p, onPath)) out.add(r);
    repCache.set(id, out);
    return out;
  }

  // anchor(id): what `id` stands for.  An object attached to a single object
  // (a proof) and with no parent of its own stands for that object, and so on
  // down the chain; anything else stands for itself, and so does an object
  // whose chain runs in a circle, as `anchor` in View.lean decides (DESIGN 3).
  function anchor(id) {
    let cur = id;
    const seen = new Set([id]);
    for (;;) {
      if (parentsOf(order, cur).length > 0) return cur;
      const next = attachedTo(model.byId.get(cur));
      if (next == null || !model.byId.has(next)) return cur;
      if (seen.has(next)) return id;
      seen.add(next);
      cur = next;
    }
  }

  const view = {
    model,
    kind,
    order,
    expanded,
    visible,
    anchor,
    rep: (id) => rep(anchor(id)),
    isVisible: (id) => visible.has(id),
    isExpanded: (id) => expanded.has(id),
    isExpandable: (id) => order.expandable.has(id),
    with: (ids) => makeView(model, kind, ids),
    expand: (id) => makeView(model, kind, expand(order, expanded, id)),
    collapse: (id) => makeView(model, kind, collapse(order, expanded, id)),
    expandAll: () => makeView(model, kind, expandAll(order)),
    collapseAll: () => makeView(model, kind, collapseAll()),
    _quotients: new Map(),
  };
  if (model._views) cachePut(model._views, key, view, VIEW_CACHE_LIMIT);
  return view;
}

// ---------------------------------------------------------------------------
// 4. The quotient (DESIGN 3, display rule + consistency)
// ---------------------------------------------------------------------------

const SEP = ' ';

export function pairKey(s, t, kind) {
  return s + SEP + t + SEP + kind;
}

export function undirectedKey(a, b, kind) {
  return (a < b ? a + SEP + b : b + SEP + a) + SEP + kind + SEP + 'u';
}

/**
 * The three consistency states of DESIGN 3.  Fix a collapse kind K and an edge
 * kind E; for visible objects s and t an E-edge s -> t is
 *   *declared* when some E-object has both ends visible and equal to s and t,
 *   *derived*  when some E-object whose ends are not both visible has
 *              representative sets s and t.
 *   declared &&  derived -> 'both'          (consistent)
 *   declared && !derived -> 'declared-only' (planned, not elaborated)
 *  !declared &&  derived -> 'derived-only'  (detail the coarse story omits)
 */
export function consistencyState(declared, derived) {
  if (declared && derived) return 'both';
  if (declared) return 'declared-only';
  if (derived) return 'derived-only';
  return null;
}

/**
 * Compute the drawn quotient of a view.
 *
 * Display rule.  For every object `o` with a nonempty boundary let
 * `R = union of rep(b)` over the boundary objects `b`.
 *   |R| >= 2  ->  `o` is drawn as an arc or a junction among R
 *   |R| == 1  ->  `o` is internal to that element and is hidden
 *   |R| == 0  ->  every end is inside an expanded container; nothing to draw
 *
 * Returns
 *   items        one entry per drawn object, faithful to the display rule
 *   edges        the grouped drawing list used by graph.js: binary items with
 *                the same (src, tgt, kind) share one arc, and derived-only
 *                relations carried by junctions get a synthetic dashed arc
 *   internal     visibleId -> [objectId] for |R| == 1 (prose is attributed there)
 *   consistency  pairKey -> { s, t, kind, declared: [], derived: [], state }
 */
export function quotient(view, options = {}) {
  const model = view.model;
  const excludeKinds = new Set(options.excludeKinds || []);
  const includeCollapseKind = options.includeCollapseKind === true;
  if (!includeCollapseKind) excludeKinds.add(view.kind);

  // Memoised per view.  The view is immutable and identified by its expanded
  // set, so the only other thing the answer depends on is the options; both go
  // into the key.
  const cacheKey = [...excludeKinds].sort().join('');
  if (view._quotients) {
    const hit = view._quotients.get(cacheKey);
    if (hit) return hit;
  }

  const items = [];
  const internal = new Map(); // visible id -> [object id]
  const dropped = []; // |R| == 0
  const consistency = new Map();

  const bump = (s, t, kind, which, objectId) => {
    const key = pairKey(s, t, kind);
    let rec = consistency.get(key);
    if (!rec) {
      rec = {
        key,
        s,
        t,
        kind,
        declared: [],
        derived: [],
        state: null,
        // `elaborable` is true when at least one end still has finer structure
        // under K.  A declared edge between two K-leaves cannot be witnessed by
        // anything finer, so "declared but not derived" is not interesting
        // there; the `unwitnessed-edge` lint and the hollow arrow head are for
        // the elaborable case.
        elaborable: view.order.expandable.has(s) || view.order.expandable.has(t),
      };
      consistency.set(key, rec);
    }
    rec[which].push(objectId);
  };

  for (const o of model.objects) {
    if (o.boundary.length === 0) continue;
    if (excludeKinds.has(o.kind)) continue;

    // R, with the roles that reach each element.
    const endRoles = new Map();
    for (const b of o.boundary) {
      for (const r of view.rep(b.id)) {
        if (!endRoles.has(r)) endRoles.set(r, []);
        const roles = endRoles.get(r);
        if (!roles.includes(b.role)) roles.push(b.role);
      }
    }

    if (endRoles.size === 0) {
      dropped.push(o.id);
    } else if (endRoles.size === 1) {
      const only = endRoles.keys().next().value;
      if (!internal.has(only)) internal.set(only, []);
      internal.get(only).push(o.id);
    } else {
      const ends = [];
      for (const [id, roles] of endRoles) ends.push({ id, roles });
      items.push({
        id: o.id,
        object: o,
        kind: o.kind,
        ends,
        visible: view.isVisible(o.id),
        junction: false, // filled in below
        orientation: orientationOf(ends),
        state: null,
      });
    }

    // Consistency bookkeeping for ordinary directed edges (DESIGN 3).
    //
    // An E-edge s -> t is *declared* when some E-object has both of its ends
    // visible and equal to s and t, and *derived* when some E-object whose ends
    // are not both visible has representative sets s and t.  Whether the edge
    // object itself is expanded, visible, or a K-root is irrelevant: what
    // matters is whether the coarse story names the pair outright or only
    // reaches it through the quotient.
    if (isBinaryKind(model, o.kind)) {
      // An end attached to another object (a proof) stands for it.
      const src = boundaryEntry(o, 'src');
      const tgt = boundaryEntry(o, 'tgt');
      const a = src == null ? null : view.anchor(src);
      const b = tgt == null ? null : view.anchor(tgt);
      if (a != null && b != null) {
        if (view.isVisible(a) && view.isVisible(b)) {
          if (a !== b) bump(a, b, o.kind, 'declared', o.id);
        } else {
          for (const s of view.rep(a)) {
            for (const t of view.rep(b)) {
              if (s === t) continue;
              bump(s, t, o.kind, 'derived', o.id);
            }
          }
        }
      }
    }
  }

  for (const rec of consistency.values()) {
    rec.state = consistencyState(rec.declared.length > 0, rec.derived.length > 0);
  }

  // A drawn object that is itself an end of another drawn object must become a
  // junction node so the higher object has something to attach to.
  const usedAsEnd = new Set();
  for (const it of items) for (const e of it.ends) usedAsEnd.add(e.id);
  for (const it of items) {
    it.junction = !it.orientation || usedAsEnd.has(it.id);
  }

  // --- grouped drawing list -------------------------------------------------
  const edges = [];
  const groups = new Map();
  for (const it of items) {
    if (it.junction) {
      edges.push({
        type: 'junction',
        id: 'j:' + it.id,
        kind: it.kind,
        ends: it.ends,
        members: [it],
        state: null,
        synthetic: false,
      });
      continue;
    }
    const o = it.orientation;
    const key = o.directed
      ? pairKey(o.src, o.tgt, it.kind)
      : undirectedKey(o.a, o.b, it.kind);
    let g = groups.get(key);
    if (!g) {
      g = {
        type: 'edge',
        id: 'e:' + key,
        kind: it.kind,
        directed: o.directed,
        src: o.directed ? o.src : o.a,
        tgt: o.directed ? o.tgt : o.b,
        members: [],
        state: null,
        synthetic: false,
      };
      groups.set(key, g);
      edges.push(g);
    }
    g.members.push(it);
  }

  // Attach consistency states and synthesise the derived-only arcs that are
  // not already carried by a grouped item (they belong to junction items).
  for (const g of groups.values()) {
    if (!g.directed) continue;
    const rec = consistency.get(pairKey(g.src, g.tgt, g.kind));
    if (rec) {
      g.state = rec.state;
      g.elaborable = rec.elaborable;
      g.consistency = rec;
      for (const m of g.members) m.state = rec.state;
    }
  }
  for (const rec of consistency.values()) {
    if (rec.state !== 'derived-only') continue;
    const key = pairKey(rec.s, rec.t, rec.kind);
    if (groups.has(key)) continue;
    edges.push({
      type: 'edge',
      id: 'd:' + key,
      kind: rec.kind,
      directed: true,
      src: rec.s,
      tgt: rec.t,
      members: [],
      state: 'derived-only',
      elaborable: rec.elaborable,
      consistency: rec,
      synthetic: true,
    });
  }

  const result = { view, items, edges, internal, dropped, consistency };
  if (view._quotients) cachePut(view._quotients, cacheKey, result, 8);
  return result;
}

/**
 * The drawn entities of a quotient that belong to the visible objects
 * themselves: an object is drawn only when every end of it is visible as
 * itself (an end that is an edge object being, in turn, one of these), never
 * lifted to whatever collapsed object it is hidden in.  So a collapsed section
 * keeps the arcs declared on it and drops those of its contents, a grouped
 * arc keeps only such members (and its "×n" counts only them), and the
 * synthesised derived-only arcs, which stand for contents alone, go.
 *
 * An edge object with contents of its own (one the view can expand) is a node
 * of the view whatever its ends: it stays, as the way into those contents.
 *
 * The consistency states are the quotient's: an own arc still reads `both`
 * when the contents witness it, and `declared-only` when nothing does.
 */
export function ownEdges(view, edges) {
  const model = view.model;
  const memo = new Map();
  const own = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false); // boundaries are acyclic; this only guards bad data
    const o = model.byId.get(id);
    const yes = !!o && ((view.isVisible(id) && view.isExpandable(id)) || o.boundary.every((b) => {
      const a = view.anchor(b.id);
      const end = model.byId.get(a);
      return view.isVisible(a) && !!end && (end.boundary.length === 0 || own(a));
    }));
    memo.set(id, yes);
    return yes;
  };
  const out = [];
  for (const e of edges) {
    if (e.synthetic) continue;
    const members = e.members.filter((it) => own(it.id));
    if (!members.length) continue;
    out.push(members.length === e.members.length ? e : { ...e, members });
  }
  return out;
}

/**
 * How to draw a set of ends as a plain arc, or null when it needs a junction.
 * Exactly two ends, carrying either src/tgt disjointly, or no src/tgt at all.
 */
function orientationOf(ends) {
  if (ends.length !== 2) return null;
  const src = ends.filter((e) => e.roles.includes('src'));
  const tgt = ends.filter((e) => e.roles.includes('tgt'));
  if (src.length === 1 && tgt.length === 1 && src[0].id !== tgt[0].id &&
      src[0].roles.length === 1 && tgt[0].roles.length === 1) {
    return { directed: true, src: src[0].id, tgt: tgt[0].id };
  }
  if (src.length === 0 && tgt.length === 0) {
    const [a, b] = ends.map((e) => e.id).sort();
    return { directed: false, a, b };
  }
  return null;
}

/** Visible objects with an empty boundary — the nodes of the drawn graph. */
export function visibleNodes(view) {
  const out = [];
  for (const id of view.visible) {
    const o = view.model.byId.get(id);
    if (o && o.boundary.length === 0) out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4a. Transitive reduction of the drawn arcs
// ---------------------------------------------------------------------------

/**
 * The arcs a reader can do without: those already implied by a longer path of
 * the same kind.  If A uses B, B uses C and A uses C, the arc A -> C says
 * nothing the other two do not, and on a real dependency graph such arcs are
 * most of the ink.
 *
 * `arcs` is a list of `{id, kind, src, tgt, keep}`, directed src -> tgt in the
 * model's sense, between whatever ids the caller draws as nodes.  The answer is
 * the Set of ids that may be hidden.  Choices, and why:
 *
 *   * Per kind.  A path only implies an arc of its own kind: `uses` through a
 *     `generalises` is not a use.  Nothing here knows any kind by name; arcs
 *     are simply grouped by `kind`.
 *   * On what the caller passes, which for the graph is the quotient as drawn
 *     (after the kind and status filters), so an arc is never hidden in favour
 *     of a path the reader cannot see.
 *   * `keep: true` arcs count as paths but are never hidden.  The graph uses
 *     this for the spokes of a junction: a junction carries more than its
 *     reachability (other ends, objects attached to it), so it stays, but the
 *     path src -> junction -> tgt does imply src -> tgt.
 *   * Direction is the model's, src -> tgt.  A kind drawn reversed reverses
 *     every one of its arcs, which leaves the set of implied arcs unchanged.
 *   * Cycles.  On a cyclic graph the transitive reduction is not unique (in a
 *     triangle with both orientations every arc is implied by the others, but
 *     not all of them can go), so the reduction is taken on the condensation:
 *     arcs inside a strongly connected component are never hidden, and an arc
 *     between two components is hidden only when its target component is
 *     reachable from its source component through some third component.  Two
 *     arcs joining the same pair of components are both kept, since neither
 *     can be preferred.  Hiding everything this says loses no reachability.
 *
 * Linear in the arcs plus one bitset of reachable components per component,
 * which for the few thousand nodes of a fully expanded blueprint is a few
 * megabytes at worst and normally nothing.
 */
export function transitiveReduction(arcs) {
  const hidden = new Set();
  const byKind = new Map();
  for (const a of arcs || []) {
    if (a.src == null || a.tgt == null || a.src === a.tgt) continue;
    if (!byKind.has(a.kind)) byKind.set(a.kind, []);
    byKind.get(a.kind).push(a);
  }
  for (const list of byKind.values()) reduceOneKind(list, hidden);
  return hidden;
}

function reduceOneKind(arcs, hidden) {
  const index = new Map();
  const succ = [];
  const at = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      i = succ.length;
      index.set(id, i);
      succ.push([]);
    }
    return i;
  };
  const ends = arcs.map((a) => [at(a.src), at(a.tgt)]);
  for (const [u, v] of ends) succ[u].push(v);

  // Tarjan numbers components in the order it finishes them, and a component
  // finishes only after everything reachable from it: so every arc between two
  // components runs from a higher number to a lower one.
  const comp = stronglyConnected(succ);
  let nComp = 0;
  for (const c of comp) if (c + 1 > nComp) nComp = c + 1;

  const csucc = Array.from({ length: nComp }, () => new Set());
  for (const [u, v] of ends) if (comp[u] !== comp[v]) csucc[comp[u]].add(comp[v]);

  // below[c]: the components reachable from c by a path of at least one arc,
  // as a bitset.  Filled lowest number first, so every successor is done.
  const words = (nComp + 31) >>> 5;
  const below = new Array(nComp);
  const setBit = (bits, i) => { bits[i >>> 5] |= 1 << (i & 31); };
  const hasBit = (bits, i) => (bits[i >>> 5] & (1 << (i & 31))) !== 0;
  for (let c = 0; c < nComp; c += 1) {
    if (csucc[c].size === 0) { below[c] = null; continue; }
    const bits = new Uint32Array(words);
    for (const d of csucc[c]) {
      setBit(bits, d);
      const bd = below[d];
      if (bd) for (let w = 0; w < words; w += 1) bits[w] |= bd[w];
    }
    below[c] = bits;
  }

  // An arc c -> d is implied when d is two or more steps below c, that is,
  // below some successor of c.
  const twoSteps = new Array(nComp);
  const twoStepsOf = (c) => {
    if (twoSteps[c] !== undefined) return twoSteps[c];
    let bits = null;
    for (const e of csucc[c]) {
      const be = below[e];
      if (!be) continue;
      if (!bits) bits = new Uint32Array(words);
      for (let w = 0; w < words; w += 1) bits[w] |= be[w];
    }
    twoSteps[c] = bits;
    return bits;
  };
  arcs.forEach((a, i) => {
    if (a.keep) return;
    const cu = comp[ends[i][0]];
    const cv = comp[ends[i][1]];
    if (cu === cv) return; // inside a cycle: never hidden
    const bits = twoStepsOf(cu);
    if (bits && hasBit(bits, cv)) hidden.add(a.id);
  });
}

/**
 * Tarjan's strongly connected components, iteratively (a long chain of uses
 * would overflow the stack recursively).  Returns comp[node] in finishing
 * order, sinks first.
 */
function stronglyConnected(succ) {
  const n = succ.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const comp = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack = [];
  let next = 0;
  let nComp = 0;
  for (let root = 0; root < n; root += 1) {
    if (index[root] !== -1) continue;
    const work = [[root, 0]]; // node, position in its successor list
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      if (top[1] < succ[v].length) {
        const w = succ[v][top[1]];
        top[1] += 1;
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] === index[v]) {
        let w;
        do {
          w = stack.pop();
          onStack[w] = 0;
          comp[w] = nComp;
        } while (w !== v);
        nComp += 1;
      }
    }
  }
  return comp;
}

// ---------------------------------------------------------------------------
// 4b. What the graph leaves out
// ---------------------------------------------------------------------------

/**
 * The `graph` display hint of a kind: `always` (the default), `optional` (an
 * appendix: drawn unless the reader hides it) or `never` (read in the
 * document only).
 */
export function graphHint(model, kindName) {
  const k = model.kinds[kindName];
  const g = k && k.graph;
  return g === 'optional' || g === 'never' ? g : 'always';
}

/**
 * The ids the graph leaves out: every object whose kind is `never` drawn, or
 * `optional` when `hideOptional` is set; everything below one of those in any
 * collapse order, so an appendix goes with its contents whichever order the
 * graph is driven by; and every object with one of them on its boundary, so a
 * relation never points at something that is not there.  The last two apply
 * again to what they add, which takes a proof along with its statement and a
 * lemma refining a left-out relation along with that relation.
 */
export function outOfGraph(model, { hideOptional = false } = {}) {
  const out = new Set();
  const stack = [];
  for (const o of model.objects) {
    const g = graphHint(model, o.kind);
    if (g === 'never' || (g === 'optional' && hideOptional)) stack.push(o.id);
  }
  // Built only when something is left out: most snapshots leave nothing, and
  // the graph and object pages then need no order but the one they show.
  let orders = null;
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    if (!orders) orders = model.collapseKinds.map((k) => collapseOrder(model, k));
    for (const order of orders) for (const c of childrenOf(order, id)) stack.push(c);
    for (const { object } of incidentTo(model, id)) stack.push(object.id);
  }
  return out;
}

/**
 * The model the graph page draws: `model` itself when nothing is left out, and
 * otherwise the model of the same snapshot without the objects `outOfGraph`
 * names.  Every view, quotient, consistency state and reduction computed on it
 * is then that of a blueprint in which those objects were never written.
 * Memoised on the model.
 */
export function graphModel(model, { hideOptional = false } = {}) {
  const key = hideOptional ? 'optional' : 'never';
  const hit = model._graphModels.get(key);
  if (hit) return hit;
  const out = outOfGraph(model, { hideOptional });
  const gm = out.size === 0 ? model
    : buildModel({ ...model.snapshot, objects: model.objects.filter((o) => !out.has(o.id)) });
  model._graphModels.set(key, gm);
  return gm;
}

// ---------------------------------------------------------------------------
// 5. Reading order (DESIGN 6: "a blueprint still reads as a paper")
// ---------------------------------------------------------------------------

function orderKey(model, id) {
  const o = model.byId.get(id);
  const ord = o && o.attrs ? o.attrs.order : undefined;
  const n = typeof ord === 'number' ? ord : Number.POSITIVE_INFINITY;
  return [n, id];
}

function compareIds(model, a, b) {
  const ka = orderKey(model, a);
  const kb = orderKey(model, b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
}

/**
 * Proofs with details of their own that the collapse order puts nowhere: a
 * proof (DESIGN 2.5) is not below its statement in any order, so one that
 * lemmas refine is a root of it, and would be read at the top of the document,
 * away from what it proves.  Each is read right after its statement instead.
 * Returns statement id -> [proof id], sorted.  A proof whose statement is
 * itself one of its details keeps its place as a root, so the walk below still
 * reaches both.
 */
function detailedProofs(model, order) {
  const out = new Map();
  for (const o of model.objects) {
    if (o.kind !== 'proof') continue;
    if (parentsOf(order, o.id).length || !childrenOf(order, o.id).length) continue;
    const of = attachedTo(o);
    if (of == null || of === o.id || !model.byId.has(of)) continue;
    if (descendantsOf(order, o.id).includes(of)) continue;
    if (!out.has(of)) out.set(of, []);
    out.get(of).push(o.id);
  }
  for (const list of out.values()) list.sort((a, b) => compareIds(model, a, b));
  return out;
}

/**
 * The linear document: roots of the collapse order sorted by `order` then id,
 * recursively through their children.  Objects with several parents appear
 * under each, the later occurrences flagged `duplicate`.  A proof with details
 * of its own is read right after its statement, before what refines the
 * statement (`detailedProofs`).
 */
export function readingOrder(model, kind) {
  const order = collapseOrder(model, kind);
  const seen = new Set();
  const out = [];

  const proofsAfter = detailedProofs(model, order);
  const placed = new Set([...proofsAfter.values()].flat());
  const roots = [...order.roots].filter((id) => !placed.has(id)).sort((a, b) => compareIds(model, a, b));

  const walk = (id, depth, path) => {
    const duplicate = seen.has(id);
    seen.add(id);
    out.push({ id, object: model.byId.get(id), depth, duplicate });
    if (duplicate) return; // do not repeat a whole subtree
    const kids = (proofsAfter.get(id) || []).concat(childrenOf(order, id)
      .slice()
      .sort((a, b) => compareIds(model, a, b)));
    for (const c of kids) {
      if (path.includes(c)) continue; // defensive
      walk(c, depth + 1, path.concat([id]));
    }
  };

  for (const r of roots) walk(r, 0, []);
  return out;
}

/** Top-level objects of the collapse order, in document order. */
export function topLevel(model, kind) {
  const order = collapseOrder(model, kind);
  return [...order.roots].sort((a, b) => compareIds(model, a, b)).map((id) => model.byId.get(id));
}

/**
 * The document as the document view sets it: which objects it shows, in what
 * order, with what numbers, and which page each of them is read on.  Memoised
 * per collapse kind, like the order itself.
 *
 * Two rules keep the result readable rather than a dump of every object in the
 * snapshot:
 *
 *   * an object appears in the flow when it has prose of its own or children
 *     in the collapse order.  Sugar-created edges with neither are structure,
 *     not content, and are left to the graph;
 *   * a proof is filed under the statement it proves and read there, after it;
 *     it has no number of its own.  A proof with children of its own in the
 *     collapse order is an entry, numbered as one, with its details under it;
 *     it is read right after its statement, as the first entry below it,
 *     unless the order gives it a place of its own;
 *   * a binary edge with prose or a title but no children of its own is a
 *     *step* of its source object, rendered as a block under it — "By
 *     induction on the dimension" belongs under the theorem it proves, not as
 *     a chapter.  An edge that does have children keeps its own place: it is a
 *     coarse object carrying its own prose, and its details nest under it.
 *
 * Objects of the collapse kind itself are never in the flow: they *are* the
 * structure.
 *
 * Numbers are the paper's: the third entry under the second top-level entry is
 * "2.3".  An object with several parents is written out under the first and
 * repeated, as a pointer, under the others; the repetition carries the number
 * of the first occurrence and uses none of its own, so every object has exactly
 * one number and a cross reference to it means one place.  A piece of text
 * (`TEXT_KIND`) is read where it stands and numbered not at all: the lemma
 * after the lines that open a section is still that section's first.
 *
 * Returns
 *   { kind,
 *     entries,  // the flow, in reading order: {id, object, depth, number,
 *               //   duplicate, text, parent, children}; `parent` is the enclosing
 *               //   entry (null at the top), `children` the entries under it
 *     roots,    // the top-level entries
 *     byId,     // id -> its first (written-out) entry, text entries included
 *     steps,    // source id -> the step objects filed under it
 *     proofs,   // statement id -> the proofs filed under it
 *     stepOf }  // step or proof id -> the id it is filed under
 */
export function documentOutline(model, kind) {
  if (model._outlines.has(kind)) return model._outlines.get(kind);
  const order = collapseOrder(model, kind);

  const hasProse = (o) => !!(o.body && o.body.trim());
  const hasTitle = (o) => !!(o.attrs && typeof o.attrs.title === 'string' && o.attrs.title);
  const hasKids = (id) => childrenOf(order, id).length > 0;
  // An object earns a place in the flow if it says something or contains
  // something.
  const inFlow = (o) => o.kind !== kind && (hasProse(o) || hasKids(o.id));

  // Steps: leaf binary edges with something to say, filed under their source.
  const steps = new Map();
  const stepOf = new Map();
  for (const o of model.objects) {
    if (o.kind === kind) continue;
    if (!isBinaryKind(model, o.kind)) continue;
    if (hasKids(o.id)) continue; // it heads its own part of the document
    if (!hasProse(o) && !hasTitle(o)) continue;
    const src = boundaryEntry(o, 'src');
    const srcObj = src && model.byId.get(src);
    if (!srcObj || !inFlow(srcObj)) continue; // nothing to file it under
    if (!steps.has(src)) steps.set(src, []);
    steps.get(src).push(o);
    stepOf.set(o.id, src);
  }

  // Proofs: attached to a statement in the flow, filed under it.
  const proofs = new Map();
  for (const o of model.objects) {
    if (o.kind !== 'proof' || hasKids(o.id)) continue;
    const of = attachedTo(o);
    const ofObj = of && model.byId.get(of);
    if (!ofObj || !inFlow(ofObj)) continue;
    if (!proofs.has(of)) proofs.set(of, []);
    proofs.get(of).push(o);
    stepOf.set(o.id, of);
  }
  for (const list of proofs.values()) list.sort((a, b) => compareIds(model, a.id, b.id));

  // `readingOrder` gives the walk with its depths; an entry's parent in the
  // flow is the nearest entry above it that is shallower.  Going by that
  // rather than by `depth - 1` keeps the numbers whole even where a level was
  // filtered out, which a broken snapshot can arrange.
  const entries = [];
  const roots = [];
  const byId = new Map();
  const counts = new Map(); // entry (or null) -> written-out children so far
  const stack = []; // the chain of open entries, with their walk depths
  for (const e of readingOrder(model, kind)) {
    if (!e.object || !inFlow(e.object) || stepOf.has(e.id)) continue;
    while (stack.length && stack[stack.length - 1].walkDepth >= e.depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].entry : null;
    const first = byId.get(e.id);
    const entry = {
      id: e.id,
      object: e.object,
      depth: parent ? parent.depth + 1 : 0,
      duplicate: !!first,
      number: null,
      // Text that belongs to no statement (`TEXT_KIND`, with nothing under
      // it): read in place, with no number and taking none from its siblings.
      text: e.object.kind === TEXT_KIND && !hasKids(e.id),
      parent,
      children: [],
    };
    if (entry.text) {
      if (!first) byId.set(e.id, entry);
    } else if (first) {
      entry.number = first.number;
    } else {
      const k = (counts.get(parent) || 0) + 1;
      counts.set(parent, k);
      entry.number = parent ? parent.number + '.' + k : String(k);
      byId.set(e.id, entry);
    }
    (parent ? parent.children : roots).push(entry);
    entries.push(entry);
    if (!entry.duplicate && !entry.text) stack.push({ walkDepth: e.depth, entry });
  }

  const outline = { kind, entries, roots, byId, steps, proofs, stepOf };
  model._outlines.set(kind, outline);
  return outline;
}

/** "Definition", "Section", "Main theorem": the lead word of a numbered entry. */
export function kindWord(kind) {
  const s = String(kind);
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

/**
 * How a cross reference to `id` reads along the outline, as a paper's would:
 * `{ word: 'Definition', number: '1.2.1' }`, the lead word being the one the
 * document view sets the entry under.  An object with several parents is
 * referred to by its one number, the first occurrence's.  `null` for an object
 * the document gives no number: one that is not in the flow, or a step or a
 * proof, which is read as part of its source rather than on its own, or a
 * piece of text, which has no number.
 */
export function referenceOf(outline, id) {
  const entry = outline.byId.get(id);
  if (!entry || entry.text) return null;
  return { word: kindWord(entry.object.kind), number: entry.number };
}

// The words prose names a reference with, besides the schema's own kind words:
// a blueprint imported from LaTeX says "Thm [x]" and "Proposition [x]" whatever
// the kind of `x` turned out to be, and "Thm Theorem 2.3" or "Theorem Section
// 2.3" is worse than letting the author's word stand, which is what
// `Theorem~\ref{…}` gave in the paper.
export const REFERENCE_WORDS = [
  'theorem', 'thm', 'lemma', 'lem', 'proposition', 'prop', 'corollary', 'cor',
  'definition', 'def', 'defn', 'remark', 'rem', 'example', 'exercise',
  'construction', 'conjecture', 'claim', 'notation', 'observation',
  'assumption', 'hypothesis', 'axiom', 'section', 'sec', 'chapter', 'chap',
  'appendix', 'equation', 'eq',
];

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text a `[slug]` reference reads as, given the prose `before` it: "Lemma
 * 2.3", or only "2.3" when the prose already names it, with the entry's own
 * word ("by Lemma [x]") or any word a reference is named with ("Thm [x]",
 * "Props. [x]", any kind of the schema), so it does not read "Lemma Lemma 2.3"
 * or "Thm Theorem 2.3".  `ref` is what `referenceOf` returns.  The website's
 * links and the PDF export both read references this way.
 */
export function referenceLabel(model, ref, before) {
  const text = String(before || '');
  const said = new RegExp('(?:^|[^\\p{L}])' + escapeRegExp(ref.word) + '\\s+$', 'iu');
  return said.test(text) || namesReference(model, text) ? ref.number : ref.word + ' ' + ref.number;
}

// One pattern per model: "<word>[s][.] " at the end of the text before the
// reference, the word whole (`\p{L}`, so "dilemma [x]" does not count).
function namesReference(model, before) {
  if (!model._namingRe) {
    const words = new Set(REFERENCE_WORDS);
    for (const k of Object.keys(model.kinds || {})) words.add(kindWord(k).toLowerCase());
    const alt = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    model._namingRe = new RegExp('(?:^|[^\\p{L}])(?:' + alt + ')s?\\.?\\s+$', 'iu');
  }
  return model._namingRe.test(before);
}

/** A `[slug]` reference in prose: the slug is group 1.  Not `[text](url)`. */
export const SLUG_PATTERN = '\\[([A-Za-z0-9][A-Za-z0-9._~/-]*)\\](?!\\()';

/**
 * The maths spans of a body, as the website hands them to KaTeX: `$$…$$`,
 * `\[…\]`, `\(…\)`, `$…$`, in that order, with fenced and inline code (group
 * 1) matched first so that maths inside code stays code.  Group 2 is the maths
 * span, delimiters included.  Inline formulas may wrap across source lines and
 * start with digits (`$0=[0]$`).  A fresh global RegExp per call.
 */
export function mathRegExp() {
  return /(```[\s\S]*?```|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)(?:[^$\\]|\\[\s\S])+?\$)/g;
}

/**
 * The page of the split document an object is read on: its own page if it has
 * entries under it, otherwise its parent's, which shows it among its siblings.
 * The top of the document is its contents, so a top-level entry with nothing
 * under it is read on its own page too; only text at the top level is read on
 * the top page (`null`).  A step is read wherever its source is, a proof
 * wherever its statement is.
 * `undefined` when the object is not in the document at all.
 */
export function documentPageOf(outline, id) {
  if (outline.stepOf.has(id)) return documentPageOf(outline, outline.stepOf.get(id));
  const entry = outline.byId.get(id);
  if (!entry) return undefined;
  if (entry.children.length) return entry.id;
  if (entry.parent) return entry.parent.id;
  return entry.text ? null : entry.id;
}

/**
 * Whether the page of `pageId` (null for the top level), inlining `levels`
 * levels below itself, writes out `id`.  `levels` 0 on the top page is its
 * contents alone, which write nothing out: text at the top level is read on
 * the top level written out.
 */
export function documentPageShows(outline, pageId, levels, id) {
  if (outline.stepOf.has(id)) id = outline.stepOf.get(id);
  const entry = outline.byId.get(id);
  if (!entry) return false;
  if (pageId === null) return entry.depth < levels;
  if (entry.id === pageId) return true;
  for (let p = entry.parent; p; p = p.parent) {
    if (p.id === pageId) return entry.depth - p.depth <= levels;
  }
  return false;
}

/**
 * The entries a page writes out, in reading order: the page's own entry (none
 * for the top level) and everything up to `levels` levels below it.
 */
export function documentPageEntries(outline, pageId, levels) {
  const out = [];
  const walk = (list, left) => {
    if (left <= 0) return;
    for (const e of list) {
      out.push(e);
      walk(e.children, left - 1);
    }
  };
  if (pageId === null) {
    walk(outline.roots, levels);
  } else {
    const entry = outline.byId.get(pageId);
    if (!entry) return out;
    out.push(entry);
    walk(entry.children, levels);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. Search and aggregates
// ---------------------------------------------------------------------------

/**
 * Substring search over id, title, the Lean declaration names (`attrs.lean`)
 * and body.  Returns objects ranked by where the match was found.  Empty
 * query returns [].
 *
 * `limit` may be `Infinity`.  `accept`, when given, is asked about every
 * candidate before it is scored, which is how the top bar's search leaves out
 * bare sugar edges: a real blueprint has several `uses/a/b` edges per
 * statement, and every one of them matches by id whatever `a` and `b` match.
 */
export function search(model, query, limit = 200, { accept = null } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const row of searchIndex(model)) {
    if (accept && !accept(row.object)) continue;
    let score = 0;
    if (row.id === q || row.title === q) score = 100;
    else if (row.lean.includes(q)) score = 90;
    else if (row.id.includes(q)) score = 60;
    else if (row.title.includes(q)) score = 50;
    else if (row.lean.some((n) => n.includes(q))) score = 40;
    else if (row.body.includes(q)) score = 20;
    if (score > 0) hits.push({ object: row.object, score });
  }
  // Within one tier: statements before the edges between them, whose ids
  // repeat their ends' ids, then the shorter id (the closer match), then the
  // id itself, so the order is total and stable.
  const isEdge = (o) => (o.boundary.length ? 1 : 0);
  hits.sort((a, b) => b.score - a.score
    || isEdge(a.object) - isEdge(b.object)
    || a.object.id.length - b.object.id.length
    || (a.object.id < b.object.id ? -1 : a.object.id > b.object.id ? 1 : 0));
  return hits.length > limit ? hits.slice(0, limit) : hits;
}

/** The Lean declaration names an object carries, as a list (possibly empty). */
export function leanNamesOf(object) {
  const names = object && object.attrs ? object.attrs.lean : null;
  if (Array.isArray(names)) return names.filter((n) => typeof n === 'string');
  return typeof names === 'string' && names ? [names] : [];
}

/**
 * The lowercase haystack, built once per model.  Lowercasing a few thousand
 * bodies takes long enough to be felt between keystrokes; doing it per search
 * was the whole cost of searching.
 */
function searchIndex(model) {
  if (!model._search) {
    model._search = model.objects.map((o) => ({
      object: o,
      id: o.id.toLowerCase(),
      title: titleOf(o).toLowerCase(),
      lean: leanNamesOf(o).map((n) => n.toLowerCase()),
      body: (o.body || '').toLowerCase(),
    }));
  }
  return model._search;
}

/**
 * Ids matching a query, as a Set — used to highlight graph nodes.  The graph
 * asks for the same query more than once per keystroke (once while typing, once
 * when the route settles), so the answer is memoised per query string.
 *
 * Every match, not `search`'s default 200.  Sugar edges matched by id outrank
 * statements matched by title or body, and in a real blueprint an ordinary
 * word matches several hundred objects, most of the first 200 of them `uses/…`
 * edges: the graph dimmed hundreds of nodes that did match.
 */
export function searchIds(model, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return new Set();
  if (model._searchHits) {
    const hit = model._searchHits.get(q);
    if (hit) return hit;
  }
  const ids = new Set(search(model, q, Infinity).map((h) => h.object.id));
  if (model._searchHits) cachePut(model._searchHits, q, ids, SEARCH_CACHE_LIMIT);
  return ids;
}

// ---------------------------------------------------------------------------
// 6b. The search page's full-text search, after the Stacks project's
// ---------------------------------------------------------------------------

/**
 * The words of a text as the search page reads them: runs of letters and
 * digits, lowercased, accents dropped ("Čech" is `cech`), the way the Stacks
 * project's full-text index (SQLite FTS) splits its text.  A Lean name
 * splits at its dots and underscores: `Nat.succ_le` is `nat succ le`.
 */
export function searchWords(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

// The words of a piece of query, each with whether it ends in `*`.
function queryWords(text) {
  return (String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .match(/[\p{L}\p{N}]+\*?/gu) || [])
    .map((w) => (w.endsWith('*') ? { word: w.slice(0, -1), prefix: true } : { word: w, prefix: false }));
}

/**
 * A query of the search page, in the syntax of the Stacks project's search
 * (SQLite's full-text queries):
 *
 *   * the words are all wanted: `compact space` finds what has both;
 *   * a word matches a whole word, so `ideal` does not find `ideals`, and a
 *     `*` at its end matches every word it begins: `ideal*` finds both;
 *   * "double quotes" make a phrase, its words next to each other and in
 *     order; so does a word that splits into several (`Nat.succ_le`);
 *   * `-word` (or `-"a phrase"`) leaves out what has it, which is why an
 *     unquoted `quasi-compact` asks for quasi but not compact;
 *   * `OR` between two terms wants either of them.
 *
 * Returns `{ all, none }`: `all` a list of groups, every group to be matched
 * by one of its terms, and `none` the terms nothing found may match.  A term
 * is a phrase, a list of `{word, prefix}`, often of one word.
 */
export function parseQuery(query) {
  const all = [];
  const none = [];
  let orNext = false;
  const add = (term, negated) => {
    if (!term.length) return;
    if (negated) { none.push(term); orNext = false; return; }
    if (orNext && all.length) all[all.length - 1].push(term);
    else all.push([term]);
    orNext = false;
  };
  const re = /(-?)"([^"]*)"?|([^\s"]+)/g;
  let m;
  while ((m = re.exec(String(query || ''))) !== null) {
    if (m[3] === undefined) { add(queryWords(m[2]), m[1] === '-'); continue; }
    if (m[3] === 'OR') { orNext = all.length > 0; continue; }
    // A hyphen inside a word starts a word to leave out, as in SQLite.
    for (const piece of m[3].split(/(?=-)/)) {
      add(queryWords(piece), piece.startsWith('-'));
    }
  }
  return { all, none };
}

/** Which objects the search page looks through: all of them, or the statements alone. */
export const SEARCH_RADII = ['all', 'statements'];

/**
 * Whether an object is a *statement* for the search page's "Search only
 * statements": a node that is neither a section nor a piece of text, so a
 * definition, a lemma, a remark, but not a proof, an edge or a heading.
 */
export function isStatement(model, o) {
  return !!o && o.boundary.length === 0 && !isSectionKind(o.kind) && o.kind !== TEXT_KIND;
}

/**
 * An edge that sugar made and that says nothing of its own: every `uses/a/b`
 * repeats the ids of `a` and `b`, and a real blueprint has several per
 * statement, so listing them would bury the statements themselves.
 */
export function isBareSugar(model, o) {
  return !!(model.kinds[o.kind] && model.kinds[o.kind].sugar) && !(o.attrs.title || o.body.trim());
}

// The full-text index: per object, the words of each of its fields (id,
// title, every Lean name, body) and the set of all of them.  A phrase never
// runs from one field into the next.  Built once per model.
function fullTextIndex(model) {
  if (!model._fullText) {
    model._fullText = model.objects.map((o) => {
      const fields = [searchWords(o.id), searchWords(o.attrs.title), ...leanNamesOf(o).map(searchWords), searchWords(o.body)]
        .filter((f) => f.length);
      return { object: o, fields, words: new Set(fields.flat()) };
    });
  }
  return model._fullText;
}

const wordMatches = (w, q) => (q.prefix ? w.startsWith(q.word) : w === q.word);

function termMatches(row, term) {
  if (term.length === 1) {
    const q = term[0];
    if (!q.prefix) return row.words.has(q.word);
    for (const w of row.words) if (w.startsWith(q.word)) return true;
    return false;
  }
  for (const field of row.fields) {
    for (let i = 0; i + term.length <= field.length; i += 1) {
      let k = 0;
      while (k < term.length && wordMatches(field[i + k], term[k])) k += 1;
      if (k === term.length) return true;
    }
  }
  return false;
}

/**
 * Where each object comes in the document read along the collapse order
 * `kind`: id -> position.  A proof and a step come right after what they are
 * read under.  Memoised per kind.
 */
function documentPositions(model, kind) {
  if (model._positions.has(kind)) return model._positions.get(kind);
  const pos = new Map();
  if (kind) {
    const outline = documentOutline(model, kind);
    const place = (id) => { if (!pos.has(id)) pos.set(id, pos.size); };
    for (const e of outline.entries) {
      if (e.duplicate) continue;
      place(e.id);
      for (const p of outline.proofs.get(e.id) || []) place(p.id);
      for (const s of outline.steps.get(e.id) || []) place(s.id);
    }
  }
  model._positions.set(kind, pos);
  return pos;
}

/**
 * The search page's search: the objects matching `query` (see `parseQuery`),
 * in the order they are read in the document along the collapse order
 * `kind`, as the Stacks project lists its results in the order of the book.
 * What the document does not hold comes last, by id.
 *
 *   * `radius` — `'all'` looks through every object but the bare sugar edges
 *                (`isBareSugar`), `'statements'` through the statements alone
 *                (`isStatement`);
 *   * `kind`   — the collapse order that gives the reading order, by default
 *                the model's.
 *
 * A query with nothing to look for (empty, or only words to leave out)
 * finds nothing.
 */
export function fullTextSearch(model, query, { radius = 'all', kind = model.defaultCollapse || model.collapseKinds[0] || null } = {}) {
  const { all, none } = parseQuery(query);
  if (!all.length) return [];
  const accept = radius === 'statements' ? (o) => isStatement(model, o) : (o) => !isBareSugar(model, o);
  const hits = [];
  for (const row of fullTextIndex(model)) {
    if (!accept(row.object)) continue;
    if (!all.every((group) => group.some((t) => termMatches(row, t)))) continue;
    if (none.some((t) => termMatches(row, t))) continue;
    hits.push(row.object);
  }
  const pos = documentPositions(model, kind);
  const at = (o) => (pos.has(o.id) ? pos.get(o.id) : Infinity);
  hits.sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits;
}

/**
 * The objects of countable kinds, sorted by title: the rows of the progress
 * page's "All countable objects" table before any filter.  Memoised on the
 * model, so filtering on every keystroke does not sort a few thousand titles
 * each time.
 */
export function countableObjects(model) {
  if (!model._countable) {
    const rows = model.objects
      .filter((o) => model.kinds[o.kind] && model.kinds[o.kind].countable)
      .map((o) => ({ o, t: titleOf(o) }));
    rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    model._countable = rows.map((r) => r.o);
  }
  return model._countable;
}

/** `status` filter values of the progress listing that are not statuses. */
export const LISTING_NONE = 'none'; // the kind carries no Lean reference
export const LISTING_UNPROVED = 'unproved'; // anything but the two proved states

/**
 * Filter the progress listing.  Every filter is optional and they combine
 * with "and":
 *
 *   * `q`      — the same matcher as `search` (id, title, Lean names, body);
 *   * `kind`   — the object's kind;
 *   * `status` — a derived status, `'none'` for objects without one, or
 *                `'unproved'` for everything that is not proved (with or
 *                without extra axioms);
 *   * `under`  — an id that must be a strict ancestor of the object in the
 *                collapse order `order`, at any depth, so "under a chapter"
 *                takes in the lemmas of its sections too.
 *
 * Returns a new array, in the order of `objects`.
 */
export function filterListing(model, objects, { q = '', kind = null, status = null, under = null, order = null } = {}) {
  const ids = q && q.trim() ? searchIds(model, q) : null;
  return objects.filter((o) => {
    if (kind && o.kind !== kind) return false;
    if (status) {
      const s = statusOf(model, o.id);
      if (status === LISTING_NONE) { if (s !== null) return false; }
      else if (status === LISTING_UNPROVED) { if (s === 'proved' || s === 'proved_with_axioms') return false; }
      else if (s !== status) return false;
    }
    if (under && (!order || !ancestorsOf(order, o.id).includes(under))) return false;
    if (ids && !ids.has(o.id)) return false;
    return true;
  });
}

/** Count of objects per derived status, over countable kinds only. */
export function statusCounts(model) {
  const counts = Object.create(null);
  for (const s of STATUSES) counts[s] = 0;
  let total = 0;
  for (const o of model.objects) {
    const k = model.kinds[o.kind];
    if (!k || !k.countable) continue;
    const s = statusOf(model, o.id) || 'absent';
    if (!(s in counts)) counts[s] = 0;
    counts[s] += 1;
    total += 1;
  }
  return { counts, total };
}

/** Checks mentioning an object. */
export function checksFor(model, id) {
  return model.checks.filter((c) => Array.isArray(c.objects) && c.objects.includes(id));
}

export function checksByLevel(model) {
  const out = new Map();
  for (const lv of CHECK_LEVELS) out.set(lv, []);
  for (const c of model.checks) {
    const lv = CHECK_LEVELS.includes(c.level) ? c.level : 'info';
    if (!out.has(lv)) out.set(lv, []);
    out.get(lv).push(c);
  }
  return out;
}

/** Lean facts for the names an object declares, as [{name, fact|null}]. */
export function leanFactsFor(model, object) {
  const names = object && object.attrs ? object.attrs.lean : null;
  const list = Array.isArray(names) ? names : typeof names === 'string' ? [names] : [];
  return list.map((name) => ({ name, fact: model.facts ? model.facts[name] || null : null }));
}

/**
 * Where doc-gen4 documents a Lean declaration, under `base` (the snapshot's
 * `project.docgen`): the page of its module, at its anchor.
 */
export function docgenUrl(base, name) {
  const parts = String(name).split('.');
  parts.pop();
  const b = base.endsWith('/') ? base : base + '/';
  return `${b}${parts.join('/')}.html#${encodeURIComponent(name)}`;
}

/** `[slug]` links in a body, as a list of slugs (duplicates removed). */
export function bodyLinks(body) {
  const out = [];
  const re = new RegExp(SLUG_PATTERN, 'g');
  let m;
  while ((m = re.exec(body || '')) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
