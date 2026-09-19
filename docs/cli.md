# The `blueprint` command line and the authoring format

Phases 1, 2 and 4 of `DESIGN.md`: the model, the schema, the parser,
`check`, `build`, the Lean extractor behind `extract` and `check --lean`,
and the semantic diff behind `diff`, `log`, `progress`, `history add`,
`site` and `serve`.  Phase 3 is the website under `web/`.

```
lake build                      # builds .lake/build/bin/blueprint
lake exe blueprint --help
./test.sh                       # the acceptance tests over examples/
```

## Commands

Every command takes `--root <dir>` (default: the working directory).  The
exit status is `1` when any *error* level check fires, `0` otherwise.

### `blueprint check [--lean] [--view K] [--json]`

Parses the sources and runs every check of `docs/snapshot-format.md`.

* `--lean` also reads `<root>/lean-facts.json` and reports `missing-lean`,
  `declared-not-actual` and `actual-not-declared`.  It is an error if the
  file is not there.
* `--view K` computes the view consistency lints (`undeclared-edge`,
  `unwitnessed-edge`) for the collapse kind `K` instead of the schema's
  `defaultCollapse`.
* `--json` prints `{ "checks": [...], "errors": n, "warnings": n, "infos": n }`
  instead of one line per check.

### `blueprint build [-o file] [--facts path]`

Compiles the snapshot described by `docs/snapshot-format.md` and writes it to
`file` (default `<root>/blueprint.json`).  Lean facts are merged in from
`path`, or from `<root>/lean-facts.json` when that exists; otherwise `facts`
is `null`.  The snapshot is written even when checks fail, so that a broken
blueprint can still be inspected; the exit status still reflects the errors.

Output is deterministic: objects are sorted by id, checks are sorted by
level, code, objects and message, and no timestamp is written (`generated` is
optional in the format), so snapshots diff cleanly.

### `blueprint view [--collapse K] [--expand id,...] [--json]`

Prints the quotient graph of `DESIGN.md` §3 at one view: which objects are
expanded, which are visible, which objects are drawn as arcs or junctions
between visible objects, and the declared/derived state of every edge between
visible objects.  `--expand` takes a comma separated list of ids; the set is
closed upwards automatically.

### `blueprint new <kind> <id> [--dir d]`

Scaffolds `<root>/<source dir>/[d/]<id>.md` with the front matter keys the
kind needs.  Slashes in `id` become `~` in the file name.

### `blueprint rename <old> <new>`

Rewrites every reference to `old` in every source file: front matter strings
(including `old` appearing as one `/` or `~` separated segment of a derived
id), sugar values, and `[old]` links in bodies.  The file that declares the
object gets `new` as its `id` and `old` appended to its `aliases`.  Files are
never renamed or moved; if the id used to come from the file name, an
explicit `id` key is inserted instead.

### `blueprint read <blueprint.json> [-o out]`

Parses a snapshot and writes it out again.  Not part of `DESIGN.md` §8; it
exists so that the reader (which `blueprint diff` uses for a side that is a
file) is exercised, and `test.sh` uses it as a round trip test.

### `blueprint extract [modules...] [--root d] [--snapshot f] [--names a,b] [--out f]`

Imports the named Lean modules and writes `lean-facts.json`
(`docs/snapshot-format.md`).  Run it through Lake, so that the project's
`.olean` files are on `LEAN_PATH`:

```
lake exe blueprint extract MyProject
lake exe blueprint extract                       # modules from blueprint.toml
```

**Which modules.**  The positional arguments, or, when there are none and
`--root` is given, `[lean] modules` of that root's `blueprint.toml`.  It is
an error if neither names anything.  Importing a module brings in everything
it imports, so naming the project's root module is usually enough.

**Which constants.**  The union of

* every constant carrying `@[blueprint "<id>"]` in the imported environment,
  including constants of *imported* modules — the attribute is stored in a
  persistent environment extension;
* the `lean` attributes of the blueprint sources under `--root`;
* the `lean` attributes of the snapshot given with `--snapshot`, which is
  the `blueprint build` &rarr; `blueprint extract` &rarr; `blueprint build`
  route of `docs/snapshot-format.md`;
* the comma separated `--names`.

Constants that are named but not in the environment get `{"exists": false}`,
which is what `check --lean` reports as `missing-lean`.

**What is recorded.**  Per constant: its kind, its pretty printed signature
(prefixed with the declaration keyword, wrapped at 100 columns), the module
and source range, the docstring, the axioms it depends on, the derived
status of `DESIGN.md` §4 (`stated` when `sorryAx` is among the axioms,
`proved_with_axioms` when anything outside `propext`, `Classical.choice` and
`Quot.sound` is, else `proved`), and its blueprint dependencies.

**Dependencies.**  `deps` is the set of *mapped* constants reachable from a
constant's type and value through the constant dependency graph, **stopping
at mapped constants**: the walk descends through an unmapped constant into
its own dependencies, but a mapped one is recorded and not descended into.
So if `a` uses `b` uses `c` and all three are mapped, `deps a = [b]`, not
`[b, c]`.  This is the *actual* `uses` graph at declaration granularity, and
it is why the example's declared edge `main-theorem -> compactness` comes
out as `declared-not-actual`: Lean reaches `Topology.compactness` only
through `Induction.keyProp`.

Axioms are collected over the *whole* graph, mapped constants included, so
a theorem whose proof rests on a sorried lemma is `stated`, exactly as
`#print axioms` reports it.

**Output** goes to `--out`, else to `<root>/lean-facts.json` when `--root`
is given, else to `./lean-facts.json`.  It is deterministic: names, axioms
and dependencies are sorted, JSON keys are sorted, and there is no
timestamp.

### The `@[blueprint]` attribute

`Blueprint.Attr` is the half of this package a formalisation project
imports.  It depends on nothing but Lean core.

```lean
import Blueprint.Attr

@[blueprint "main-theorem"]
theorem mainTheorem : ... := ...

@[blueprint main-theorem]        -- the bare form, same thing
theorem mainTheorem : ... := ...
```

The string form is the primary one; the bare form accepts the characters a
slug may contain (`a-z`, `A-Z`, `0-9`, `-`, `_`, `/`, `~`, `.`).  The pairs
go into a persistent environment extension, so the extractor sees them
again after `import`.

A declaration may be mapped from either side or from both; `check --lean`
merges the two.  A tag naming an object that does not exist is a
`dangling-ref` error.

### `blueprint diff <A> <B> [--json] [--no-fail]`

The semantic diff of `DESIGN.md` §7.  Each side is **either** a path to a
`blueprint.json` **or** anything `git rev-parse` accepts; for a revision, the
tree is materialised into a temporary directory (`git archive` piped through
`tar`) and compiled in memory, taking the `lean-facts.json` of that tree if
it has one.  The project root inside the materialised tree is the one
`--root` names, resolved through `git rev-parse --show-prefix`, so
`blueprint diff HEAD~5 HEAD --root examples/induction` works from anywhere in
the repository.

Objects are matched by id, then by `aliases`: an object of B whose `aliases`
name an id of A that nothing else matched is a **rename**, and is then
compared like any matched object.  What is reported, each sorted by id:

```
added / removed / renamed (old -> new)
kind changed / boundary changed / body changed
attrs changed (one line per attribute key)
status changed (old -> new; only when both sides carry Lean facts)
summary: … ; proved 2/6 -> 1/6
```

A status that falls from `proved` back to `stated`, `missing` or `absent` is
the `status-regression` check of `docs/snapshot-format.md`: it is reported at
error level and `diff` exits 1, unless `--no-fail` is given.  `--json` prints
the `diff.json` document of that same file instead of the text report.

### `blueprint log <id> [--limit n]`

Walks `git log --first-parent` over the file that declares the object, plus a
sibling file named after each of its `aliases`, and says what each commit did
to that one object relative to the previous listed commit.  `--root` must be
inside a work tree.  Default limit: 20 commits.

```
log first-step  [lemma]  blueprint/induction/base-case.md

605ad529  2026-09-19  rename base-case to first-step
    renamed: base-case -> first-step
    aliases: (unset) -> [base-case]

b636bbc1  2026-09-19  initial blueprint
    + added
```

Renames are followed backwards: the object is looked for under its current id
and under every alias seen so far, so the walk crosses a `blueprint rename`.
One `git log` and one `git show` per commit and candidate file is all it
costs — no snapshot is built per commit, only the single source file is
parsed, with the *current* schema.  Derived status is therefore not part of
`log`; it needs `lean-facts.json` per revision, which `diff` has and `log`
does not.

### `blueprint progress [--since <rev>] [--facts f]`

Status counts by kind, over the objects that have a derived status, with
countable kinds marked `*`:

```
progress for induction: 2/6 countable objects proved

kind         proved  proved_with_axioms  stated  missing  absent  total
concept           1                   0       0        0       0      1
definition*       1                   0       0        0       0      1
…
```

With `--since <rev>` it also runs the diff against that revision and prints
the status changes, any regression, and the summary line.  Unlike `diff`, a
regression does not change the exit status here.

### `blueprint site [-o dir] [--facts f] [--history dir]`

Assembles the static website:

* copies `web/` into `dir` (default `<root>/_site`), leaving out `sample`,
  `test` and `README.md`, which are fixtures of the frontend and not part of
  the deployed site;
* writes the freshly built snapshot to `<dir>/blueprint.json`, which is where
  `index.html` looks for it;
* with `--history dir`, copies that directory to `<dir>/data/` and makes sure
  `data/index.json` lists the snapshot that was just built — as
  `data/<sha>.json` when `history add` already filed it, and otherwise as an
  entry pointing at `blueprint.json` itself.

The exit status is that of `build`: 1 when an error level check fires, and
the site is written either way.

**Where `web/` comes from.**  In order:

1. `$BLUEPRINT_WEB_DIR`, which must contain an `index.html`;
2. `<root>/web`, when it contains an `index.html`;
3. the package the running executable belongs to: the directory of
   `IO.appPath` and each of its parents, looking for a `web/index.html`.

(3) is what makes the tool work as a Lake dependency: the binary lives in
`.lake/packages/blueprint/.lake/build/bin/`, and walking up finds
`.lake/packages/blueprint/web`.

### `blueprint serve [--port p] [--site dir] [--facts f] [--history dir]`

Runs `site` first, so what is served is fresh, then serves `dir` (default
`<root>/_site`) on `--port` (default 8000) with the first of these that is
installed:

```
python3 -m http.server <port> --directory <dir>
npx serve -l <port> <dir>
busybox httpd -f -p <port> -h <dir>
nix-shell -p python3 --run "python3 -m http.server <port> --directory <dir>"
```

Core Lean has no socket API to write a static file server against — `Std.Http`
in the toolchain is not part of this tool's dependencies — so `serve` borrows
one.  When none of the four is installed it says so, prints all four command
lines with the path of the assembled site, and exits 1; the site is still
there to serve by hand.

### `blueprint history add <blueprint.json> --dir <dir> [--sha s] [--date d]`

Files a snapshot in the history directory the website's time slider reads:
copies it to `<dir>/<sha>.json`, computes its summary (`proved`, `total` and
the counts per status over countable objects that have a derived status), and
folds an entry into `<dir>/index.json`, which stays sorted by date and holds
at most one entry per sha.  `--sha` and `--date` default to `git rev-parse
HEAD` and that commit's date; outside a work tree they are required.

The `file` written into the index is `data/<sha>.json`, because the frontend
resolves it against the directory holding the main `blueprint.json` and the
history directory is deployed as `<site>/data` — which is exactly what
`blueprint site --history` does.

## `blueprint.toml`

At the project root.  Everything is optional.

```toml
name            = "MyProject"       # or under a [project] table
title           = "My Project blueprint"
dir             = "blueprint"       # where the Markdown lives
defaultCollapse = "refines"

[lean]
modules = ["MyProject"]             # what `blueprint extract` imports

[kinds.theorem]                     # extends the built-in `theorem`
attrs = ["title", "lean", "review", "tags", "order", "aliases", "owner"]

[kinds.uses]                        # a fresh kind looks the same
boundary   = { src = "1", tgt = "1" }
kinds      = { src = [], tgt = ["theorem", "definition", "lemma"] }
attrs      = ["title"]
constraints = ["acyclic"]           # "acyclic" | "unique"
collapse   = false
countable  = false
sugar      = true
color      = "#4a7"
```

A `[kinds.X]` table *extends* the built-in kind `X` if there is one: keys you
do not mention keep their default.  Giving `boundary` replaces the whole role
list; giving only `kinds` updates the allowed kinds of the existing roles.
Cardinalities are written `"1"`, `"0..1"`, `"1.."`, `"2.."`, `"2..5"`, or as
a bare integer.

`[lean] modules` is the module list `blueprint extract` falls back to when
the command line names none.  It is optional; a string is accepted as well
as an array.

### The default schema

| kind | boundary | notes |
|------|----------|-------|
| `section` | — | |
| `definition` | — | countable |
| `theorem` | — | countable |
| `lemma` | — | countable |
| `concept` | — | |
| `remark` | — | |
| `uses` | `src` 1, `tgt` 1 | sugar |
| `refines` | `src` 1, `tgt` 1 | acyclic, collapse, sugar |
| `instance_of` | `src` 1, `tgt` 1 | acyclic, collapse, sugar |
| `generalises` | `src` 1, `tgt` 1 | sugar |
| `equivalent` | `src` 1, `tgt` 1 | sugar |
| `implies` | `src` 1, `tgt` 1 | sugar |
| `commutes` | `edges` 2.. | only edge kinds in `edges` |

Node kinds permit `title`, `lean`, `review`, `tags`, `order`, `aliases`,
`owner`; edge kinds permit the same minus `lean`.  `defaultCollapse` is
`refines`.

## The authoring format

One directory (`blueprint/` by default) of Markdown files with TOML front
matter between `+++` lines.  Subdirectories are free.

```markdown
+++
id      = "key-prop"          # optional, see below
kind    = "theorem"
title   = "Key proposition"
lean    = ["MyProject.keyProp"]
refines = "sec-induction"     # sugar: a refines edge object
uses    = ["compactness"]     # sugar: uses edge objects
review  = "ready"
+++
Let $X$ be compact.  Then ...
```

**Ids.**  An explicit `id` always wins.  Otherwise, an object with a boundary
gets the deterministic id of `DESIGN.md` §2.4 — the kind, then the boundary
in the kind's role order, with each boundary id's slashes turned into tildes
and the entries joined by slashes:

```
uses/main-theorem/key-prop
commutes/uses~main-theorem~key-prop/uses~key-prop~compactness/uses~main-theorem~compactness
```

An object without a boundary gets the file name without `.md` (and a
`_section.md` gets its directory's name).  Because the derived ids are
deterministic, writing a file whose `id` equals the id an anonymous edge
would get *promotes* that edge: same object, now with prose and attributes.
`examples/induction/blueprint/induction/main-uses-key.md` does this.

**Sugar keys.**  Any kind with `sugar = true` may be a front matter key whose
value is an id or a list of ids.  Each expands to an edge object of that kind
with `src` the current object and `tgt` the named one.  A key that the
object's kind permits as an attribute is always read as an attribute, so a
kind cannot shadow its own attributes.

**Explicit boundaries.**  Write them out to give an edge its own prose, or to
build hyperedges and edges between edges:

```markdown
+++
kind     = "commutes"
boundary = { edges = ["uses/a/b", "uses/b/c", "uses/a/c"] }
+++
```

**`_section.md`.**  A file of that name declares an object for its directory
(id defaulting to the directory name).  Every other Markdown file directly in
that directory gets a `refines` edge to it, unless it declares its own
`refines`.  A subdirectory's `_section.md` likewise refines the section of
its parent directory when there is one, so sections nest.

**Links.**  `[slug]` in a body is resolved against the object set and
reported as `bad-link` when it does not resolve.  It creates no edge.
`[text](url)`, `![x]` and `\[` are left alone.

## The examples

```
lake exe blueprint check --root examples/minimal
lake exe blueprint view  --root examples/minimal --expand basics
lake exe blueprint extract --root examples/induction        # regenerates the facts
lake exe blueprint check --root examples/induction --lean
lake exe blueprint build --root examples/induction -o /tmp/induction.json
lake exe blueprint check --root examples/broken --lean     # exits 1

lake exe blueprint site --root examples/induction          # _site/ next to it
lake exe blueprint serve --root examples/induction         # and serve it
lake exe blueprint diff HEAD~10 HEAD --root examples/induction
```

* `examples/minimal` — one section, four nodes, `uses` and the `_section.md`
  convention.  Nothing to complain about.
* `examples/induction` — the example of `DESIGN.md` §3: `main-theorem` uses
  `key-prop`, that edge has its own prose, and `base-case`,
  `inductive-step`, `compactness-lemma` and a finer `uses` edge refine it.
  It also has a `generalises` edge between two `uses` edges (depth 2), a
  `commutes` hyperedge over three `uses` edges, an object with two parents
  (`multi-parent`), a coarse edge nothing witnesses (`unwitnessed-edge`),
  fine dependencies the coarse story does not mention (`undeclared-edge`),
  and a `lean-facts.json` so that `check --lean` has something to say.
* `examples/broken` — every error level check, documented line by line in
  `examples/broken/README.md`.

The Lean side of both `examples/induction` and `examples/broken` is the
`BlueprintExamples` library of this repository, and their `lean-facts.json`
is generated from it rather than written by hand.  `Topology.dim` and
`Topology.compactnessLemma` are mapped with `@[blueprint …]`,
`Topology.compactness` and `Induction.keyProp` with `lean = [...]` in the
text, and `Induction.mainTheorem` with both, to check that the two paths
merge.  `Topology.coverChoice` is a custom axiom (`proved_with_axioms`),
`Induction.smallSpace` is sorried (`main-theorem` is `stated`), and
`Broken.nope` is named by `examples/broken` but deliberately never declared
(`missing-lean`).

## Deviations from `DESIGN.md`

* **Consistency (§3).**  The design says an edge is *declared* when "a
  visible E-object has exactly that boundary".  Taken literally that is
  almost always true, because an anonymous edge has no `refines` parent and
  is therefore a K-root and so visible.  What is implemented instead: an
  E-object declares the arc `s → t` when its own two ends `s` and `t` are
  visible, and derives arcs between the representatives of its ends
  otherwise.  For an object with visible ends these agree; for a detail edge
  the implemented rule is the one the design's prose describes.
* **`unwitnessed-edge`.**  Only reported when there is something below that
  could have witnessed the edge: one of the two ends, or the declaring edge
  itself, has `K`-children.  Otherwise every leaf level edge would be
  reported.
* **Front matter errors** (a missing `+++` fence, malformed TOML) are
  reported as failures with the file path rather than as checks, because
  `docs/snapshot-format.md` has no code for them.
* **`generated`** is not written into `blueprint.json`.  The format marks it
  optional and leaving it out keeps snapshots byte identical across runs.
* **`blueprint read`** is an extra command, see above.
* **The `attrMap` is merged into the object mapping (§5).**
  `docs/snapshot-format.md` records `attrMap` but says only that the names
  in `decls` come from both sides.  Since the design says the mapping "can
  be stated from either side and must agree", `check --lean` and the derived
  status treat an object's Lean names as the union of its `lean` attribute
  and every constant tagged with its id.  An object mapped only by the
  attribute therefore gets a derived status and takes part in the
  declared-versus-actual comparison.
* **A stale `@[blueprint]` tag is a `dangling-ref` error.**  The format has
  no code for "the attribute names an object that does not exist", and
  `dangling-ref` is the closest: a reference that does not resolve.  It only
  fires with `--lean`, since without the facts there is no `attrMap`.
* **`range.file`** is the module's source path relative to the working
  directory when the file is found below it through `LEAN_SRC_PATH`, and
  otherwise the path derived from the module name (`A.B` &rarr;
  `A/B.lean`).  The format calls it a "file relative path" without saying
  relative to what.
* **`modules`** in `lean-facts.json` is the list of modules that were
  imported, not the list of modules the constants live in; the latter is in
  each declaration's `module`.
* **Phase 4 commands not in §8.**  `DESIGN.md` §8 lists `diff`, `log` and
  `serve`.  `progress --since` is in §7's prose, and `site` and
  `history add` are the two halves of "CI builds the snapshot on every push
  and stores it as `data/<sha>.json` on the site branch together with an
  index": they exist so that the CI workflow is four ordinary commands
  rather than a shell script.
* **`git archive` is not piped.**  The tree of a revision is written to a
  temporary `.tar` and unpacked with `tar -xf`, rather than piped, so that
  no shell is involved and both failures can be reported with their paths.
* **`log` does not report status.**  Derived status needs a
  `lean-facts.json` per revision; `log` deliberately parses only the single
  source file (with the *current* schema) rather than building a snapshot
  per commit, so it reports kind, boundary, body, attributes and renames.
  `diff`, which builds both sides, reports status too.
* **Which files `log` follows.**  The file that declares the object now,
  plus, for each alias, a file of that alias's name in the same directory —
  which is where `blueprint rename` leaves the object, since it never moves
  files.  An object that was moved between directories under a different
  name is not followed across the move.
* **`serve` has no live reload.**  §8 says "local website with live
  reload".  What is implemented refreshes the site once, then hands the
  directory to an external static file server; the website is plain files,
  so a reload in the browser after re-running `site` is the whole story.
* **Progress fractions in `diff`, `progress` and the history index** count
  objects of a `countable` kind that have an entry in `derived.status`.
  This is the same set `web/model.js` counts, so the fraction on the site
  and the fraction in the terminal agree.
