# Blueprint: design draft

Status: draft, 2026-09-19. Everything here is up for discussion.

## 1. Purpose

A blueprint records the informal mathematics of a formalisation project, the
Lean declarations that realise it, and the relations between the pieces, at
whatever levels of detail the project needs. The tool must

- offer a text format that mathematicians without Lean can edit,
- derive everything derivable (proof status, actual dependencies) from the
  Lean environment rather than trusting hand-written annotations,
- support arbitrarily many levels of detail, with coarse objects being real
  objects carrying their own prose and status,
- allow relations between relations, and relations with more than two ends,
- version the data so that progress over time and git-style operations are
  cheap,
- render as an interactive website.

Non-goals for the first version: a bespoke version control system, live
collaborative editing, and enforcing any algebraic structure on the graph.

## 2. Core model

### 2.1 Objects

There is one sort of thing, the object. Nodes, edges, hyperedges, and
edges between edges are all objects. An object has

| field      | meaning                                                          |
|------------|------------------------------------------------------------------|
| `id`       | stable identifier, see 2.4                                       |
| `kind`     | name of a kind declared in the schema, see 2.3                   |
| `boundary` | finite list of pairs (role, object id)                           |
| `attrs`    | key–value attributes permitted by the kind (title, lean, tags, …) |
| `body`     | informal text, Markdown with LaTeX maths                         |

An object with an empty boundary is a node. An object whose boundary is
`{src: a, tgt: b}` is an ordinary directed edge. Anything else is a
hyperedge. Roles are names declared by the kind; a role may hold several
objects.

### 2.2 Boundaries

The only global constraint is that the boundary relation is well founded:
following boundary entries from any object terminates. Since the object set is
finite this means the boundary graph is acyclic. It rules out an object that is
its own boundary and nothing else.

Consequences:

- Depth is defined by `depth(x) = 0` if the boundary is empty, else
  `1 + max depth(b)` over boundary objects. Nodes have depth 0, ordinary edges
  depth 1, edges between edges depth 2, and so on. Nothing assumes a maximum.
- Boundary objects may have different depths. An edge from a node to an edge
  is allowed.
- Globularity is not required. Objects tagged as cells of an n-category can be
  checked for it by an optional lint, but blueprints do not need it.
- Composition, identities, and coherence are never computed. They can be
  recorded as further objects if a project wants them.

### 2.3 Kinds and the schema

Kinds are declared per project in `blueprint.toml`. A kind declares the roles
its boundary may use, with cardinalities, restrictions on the kinds of
boundary objects, permitted attributes, constraints, and display hints. A
default schema ships with the tool.

```toml
[kinds.theorem]
boundary = {}                       # node
attrs    = ["title", "lean", "review", "tags"]
countable = true                    # contributes to progress fractions

[kinds.section]
boundary = {}
attrs    = ["title", "order"]

[kinds.uses]
boundary = { src = "1", tgt = "1" }
kinds    = { src = ["theorem", "definition", "uses"], tgt = ["theorem", "definition"] }

[kinds.refines]
boundary   = { src = "1", tgt = "1" }
constraint = ["acyclic"]           # induced relation on objects must be a DAG
collapse   = true                   # may drive views, see 3

[kinds.instance_of]
boundary   = { src = "1", tgt = "1" }
constraint = ["acyclic"]
collapse   = true

[kinds.commutes]
boundary = { edges = "2.." }        # hyperedge among two or more edges
kinds    = { edges = ["uses", "implies"] }
```

Constraint vocabulary, all checked by `blueprint check`:

- `acyclic`: the relation `src → tgt` induced by objects of this kind is a DAG.
- role cardinalities `"1"`, `"0..1"`, `"1.."`, `"2.."`.
- role kind restrictions.
- `unique`: at most one object of this kind per boundary.

`refines` is not special in the model. It is an ordinary kind that happens to
be acyclic and collapsible. Any kind with those two properties can drive
views. A refines edge may itself be the boundary of another object, for
example a lemma that explains why a decomposition works.

### 2.4 Identity

Objects are identified by a human-readable slug, chosen by the author for
objects that have their own file, and derived deterministically for objects
created by sugar:

```
uses/main-theorem/key-prop          # kind, then boundary in role order
commutes/uses~a~b/uses~b~c/uses~a~c
```

Deterministic ids mean an anonymous edge and a later file describing the same
edge are the same object, so "promoting" an edge to carry prose does not
change identity or history.

Renaming is handled by an `aliases` attribute listing former ids. The semantic
diff (see 7) matches objects by id, then by alias. A `blueprint rename` command
rewrites references and records the alias.

ULIDs were considered and rejected for the first version: they make files
unreadable and the alias mechanism covers renames. The parser is written so
that switching id policy later is local.

## 3. Views and quotients

Let K be a collapsible kind. Write `x ≤K y` if there is a chain of K-edges from
x to y, meaning x is a detail of y. Acyclicity makes this a partial order.

A view for K is an upward-closed set X of expanded objects: if x is expanded,
every object above it is expanded. The visible objects are those not in X that
are either K-roots or have some K-parent in X. Fully collapsed is X empty,
fully expanded is X equal to every object with K-children. Expanding a visible
object adds it to X. This formulation, rather than antichains, is what the UI
does and it behaves sensibly with multiple parents.

The representative `rep(x)` of any object is the set of visible objects above
or equal to x. It is a singleton unless x has several parents on different
branches.

Display rule. For every object o with a nonempty boundary, let R be the union
of `rep(b)` over its boundary objects.

- If R has two or more elements, o is drawn as an arc or junction among R.
- If R has one element, o is internal to that element and is hidden.
- If o is itself visible, it is drawn with its own prose and status. If o is
  hidden beneath a visible object, its prose is attributed there.

This is the ordinary graph quotient by the partition into visible objects,
applied to hyperedges, and it is independent of where o sits in the K-order.
In particular a lemma hidden inside a collapsed section that uses something
outside still produces a visible dependency of the section.

Consistency. Fix K and an edge kind E. For visible objects s and t, an E-edge
from s to t is *declared* if some E-object has boundary exactly (s, t), that is,
both of its ends are themselves visible, and *derived* if some E-object whose
ends are not both visible has representatives s and t. Where the edge object
itself sits in the K-order is irrelevant. The three states are

| declared | derived | reading                                          |
|----------|---------|--------------------------------------------------|
| yes      | yes     | consistent                                       |
| yes      | no      | planned but not yet elaborated                    |
| no       | yes     | detail the coarse story does not mention (lint)  |

The UI shows these as line styles. `blueprint check` reports them on request.

Projects may combine several collapse kinds into one view as long as the
union of their induced relations is still acyclic.

## 4. Status

Two families, kept apart:

- Derived, computed from Lean and never stored in the text: `absent` (no Lean
  reference), `missing` (reference does not resolve), `stated` (declaration
  exists but depends on `sorryAx`), `proved`, `proved_with_axioms` (depends on
  axioms outside the standard three).
- Declared, stored in the text by humans: `review` in
  `{draft, ready, reviewed}`, `owner`, `tags`, free-form notes.

Progress. For a collapse kind K, an object's progress is the fraction of
countable K-leaves below it whose derived status is `proved`. Every view thus
has an honest completion measure. Objects with several parents are counted
under each and flagged by a lint.

## 5. Lean integration

Mapping between objects and declarations can be stated from either side and
must agree:

```lean
@[blueprint main-theorem]
theorem mainTheorem ... := ...
```

```toml
lean = ["MyProject.mainTheorem"]
```

The attribute writes to an environment extension. The extractor,
`lake exe blueprint extract`, imports the project's modules the way doc-gen4
does and emits `lean-facts.json` with, per mapped constant:

- existence, declaration kind, pretty-printed signature, module, source
  range, docstring,
- derived status as in 4, via `collectAxioms`,
- blueprint dependencies: the set of mapped constants reachable in the
  constant dependency graph, stopping at mapped constants. This is the
  *actual* `uses` graph at declaration granularity.

`blueprint check --lean` merges the facts and reports, for each pair of
objects, whether a `uses` edge is declared, actual, or both, in the same three
states as section 3. Missing references and status regressions are errors in
CI.

## 6. Authoring format

One directory, `blueprint/`, of Markdown files with TOML front matter between
`+++` lines. Subdirectories are free, with one optional convention: a file
named `_section.md` declares a section object and every file in that
directory refines it unless it says otherwise.

```markdown
+++
id      = "key-prop"
kind    = "theorem"
title   = "Key proposition"
lean    = ["MyProject.keyProp"]
refines = "sec-induction"                 # sugar: refines edge object
uses    = ["compactness", "base-case"]     # sugar: uses edge objects
review  = "ready"
+++
Let $X$ be compact. Then ...
```

An edge with its own prose is a file whose boundary is explicit:

```markdown
+++
id       = "uses/main-theorem/key-prop"
kind     = "uses"
boundary = { src = "main-theorem", tgt = "key-prop" }
+++
By induction on the dimension. The base case is [base-case] and the
inductive step is [inductive-step].
+++
```

Objects that refine an edge simply name it:

```toml
refines = "uses/main-theorem/key-prop"
```

A hyperedge:

```markdown
+++
kind     = "commutes"
boundary = { edges = ["uses/a/b", "uses/b/c", "uses/a/c"] }
+++
```

Sugar keys are declared in the schema: any collapsible or binary kind may be
offered as a front-matter key that expands to edge objects with the current
object as `src`. Links in the body of the form `[slug]` are resolved and
validated but create no edges.

The linear document view orders sections by the `order` attribute and their
children likewise, so a blueprint still reads as a paper.

Verso was considered as the text language. It is deferred: it would let prose
reference Lean names with checking, but raises the barrier for contributors
without Lean. The parser keeps the body opaque so a Verso backend can be added.

## 7. Storage, versioning, interchange

Git is the store. Each object with prose is a file, so history, blame,
branches, and merges come for free and conflicts are per object. The content
graph being cyclic is irrelevant to git.

The compiled snapshot `blueprint.json` is the single interchange format:

```
{ schema, objects: [...], facts: {...}, derived: { status, progress, checks } }
```

Semantic operations work on snapshots, not files:

- `blueprint diff A B` matches objects by id and aliases and reports added,
  removed, renamed, kind or boundary changed, body changed, attribute changed,
  and status changed. Each side is either a compiled snapshot or a git
  revision, whose tree is materialised and compiled in memory. A status that
  falls back from proved is an error, so a pull request cannot quietly
  unprove something.
- `blueprint log <id>` walks history for one object across renames.
- `blueprint progress --since <rev>` summarises status changes.

Status history needs Lean facts per revision. CI builds the snapshot on every
push to the default branch, files it with `blueprint history add` as
`data/<sha>.json` on the site branch together with an index, and assembles
the site with `blueprint site --history`. The website's time slider reads
that index.

If graph-aware merging or time-travel queries become a real need, Dolt or a
fact store are the candidates. The snapshot format is designed so that the
store can change without touching the frontend.

## 8. Command line

```
blueprint check   [--lean] [--view K]     validate schema, constraints, references, lints
blueprint build   [-o blueprint.json]      compile snapshot, merging lean-facts.json if present
blueprint extract                          Lean side, produces lean-facts.json
blueprint new     <kind> <id>              scaffold a file
blueprint rename  <old> <new>              rewrite references, record alias
blueprint diff    <A> <B> [--json] [--no-fail]  snapshot files or git revisions
blueprint log     <id> [--limit n]         what each commit did to one object
blueprint progress [--since <rev>]         status counts by kind, and a delta
blueprint view    [--collapse K] [--expand ids] prints the quotient graph
blueprint site    [-o dir] [--history dir] assemble the static website
blueprint serve   [--port p] [--site dir]  assemble it and serve it locally
blueprint history add <snapshot> --dir d   file a snapshot, update the index
```

`serve` borrows a static file server (`python3 -m http.server` and three
fallbacks) rather than implementing one: the site is plain files, and core
Lean has no socket API this tool depends on. There is no live reload.

## 9. Website

Static site generated from `blueprint.json` and the history index, deployed
by CI. Separate TypeScript package under `web/`.

- Graph view: compound-graph layout via ELK so collapse and expand are real
  layout operations. Objects with incident higher objects are rendered as
  junctions. Line style encodes the three consistency states, colour encodes
  status, filters by kind and collapse kind.
- Object page: rendered prose with KaTeX, Lean signature linking to doc-gen4,
  derived and declared status, boundary, everything incident to the object,
  and its position in each collapse order.
- Document view: linear reading order.
- Progress dashboard and a time slider that replays snapshots.
- Later: in-browser editing that commits through the git hosting API.

## 10. Architecture and phases

Lean 4 for the core and the extractor. The extractor must be Lean, and sharing
the model between core and extractor avoids two implementations. Users get the
tool through Lake with no extra install. TOML front matter is parsed with
`Lake.Toml`; JSON with core Lean.

```
Blueprint/Model.lean     objects, boundaries, schema types
Blueprint/Schema.lean    schema parsing and defaults
Blueprint/Parse.lean     front matter, sugar expansion, id derivation
Blueprint/Check.lean     well-foundedness, constraints, references, lints
Blueprint/View.lean      collapse orders, views, display rule, consistency
Blueprint/Status.lean    derived status, progress
Blueprint/Json.lean      snapshot in and out
Blueprint/Git.lean       running git: revisions, trees, commits
Blueprint/Diff.lean      semantic diff across snapshots
Blueprint/Site.lean      static site assembly, snapshot history index
Blueprint/Extract.lean   environment walk, facts (separate executable)
Main.lean                CLI
web/                     frontend
```

Phases, each usable on its own:

1. Model, schema, parser, `check`, `build`. Validate with three real example
   blueprints, including one with edges between edges and one hyperedge.
2. Extractor and `check --lean`, including declared-versus-actual `uses`.
3. Static website with graph, object pages, and document view.
4. Semantic diff, history index in CI, time slider.
5. Editing in the browser.

Phases 1 to 4 are implemented; `docs/cli.md` is the reference for what the
commands do and where they depart from this document.

## 11. Open questions

- Should `uses` be required acyclic? Mathematically it should be, but a
  blueprint in progress may legitimately contain a cycle for a while.
- Several Lean declarations per object, for instance a definition and its
  API: is the status the conjunction, or should the object refine into one
  object per declaration?
- Double counting under multiple parents: allow with a lint, or forbid.
- Whether `_section.md` directory sugar is worth its magic.
- Performance ceiling for the graph view; a few thousand objects should be
  fine with ELK, tens of thousands need a different renderer.
- Whether the history store should move to a fact store once the time slider
  exists.
