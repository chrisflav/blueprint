# blueprint

A blueprint records the informal mathematics of a formalisation project, the
Lean declarations that realise it, and the relations between the pieces, at
whatever levels of detail the project needs.  There is one sort of thing, the
*object*: nodes, edges, hyperedges and edges between edges are all objects,
told apart only by their boundary.  Kinds are declared per project, so a
`uses` edge can itself carry prose, be refined by lemmas, or sit inside a
`commutes` hyperedge.  Any kind that is acyclic and collapsible can drive
views, which is how one blueprint reads at several levels of detail at once.
`DESIGN.md` is the design; `docs/snapshot-format.md` is the contract between
the Lean core, the Lean extractor and the website under `web/`.

This repository is at phase 4: the model, the schema, the parser, `check`,
`build`, the Lean extractor behind `extract` and `check --lean`, and the
semantic diff behind `diff`, `log`, `progress`, `history add`, `site` and
`serve`, written in Lean 4 (toolchain `v4.34.0`, no dependencies beyond the
toolchain — TOML comes from `Lake.Toml` and JSON from `Lean.Data.Json`).
Authors write Markdown files with TOML front matter under `blueprint/`; the
tool derives the edges the front matter implies, validates the whole thing,
reads the Lean environment for proof status and actual dependencies, and
compiles `blueprint.json`.  The website under `web/` renders that snapshot;
in-browser editing is the one phase still to come.

## Running it

```bash
lake build                                  # builds .lake/build/bin/blueprint
lake exe blueprint --help
./test.sh                                   # acceptance tests over examples/
```

Three example blueprints ship with the tool:

```bash
# a small, correct blueprint: one section, four nodes, uses/refines sugar
lake exe blueprint check --root examples/minimal
lake exe blueprint view  --root examples/minimal --expand basics

# DESIGN.md §3: an edge with its own prose that lemmas refine, an edge
# between edges, a commutes hyperedge, an object with two parents
lake exe blueprint check --root examples/induction --lean
lake exe blueprint build --root examples/induction -o /tmp/induction.json
lake exe blueprint view  --root examples/induction --expand induction

# every error level check at once; exits 1
lake exe blueprint check --root examples/broken --lean

# the website, assembled into examples/induction/_site and served
lake exe blueprint site  --root examples/induction
lake exe blueprint serve --root examples/induction
```

`docs/cli.md` documents the commands, `blueprint.toml`, the authoring format
and the default schema; `examples/broken/README.md` says which line of that
example triggers which check.

## Lean integration

Nothing about the proof status of a declaration, and nothing about what it
actually depends on, is written by hand: both are read out of the Lean
environment.  A formalisation project wires itself up in four steps.

**1. Require the package.**  In the project's `lakefile.toml`:

```toml
[[require]]
name = "blueprint"
git  = "https://github.com/…/blueprint"
rev  = "main"
```

**2. Tag declarations.**  `Blueprint.Attr` is the only module a project
imports; it depends on nothing but Lean core.

```lean
import Blueprint.Attr

@[blueprint "main-theorem"]
theorem MyProject.mainTheorem (X : Space) : Decomposable X := …

@[blueprint key-prop]              -- the bare form, same thing
theorem MyProject.keyProp : … := …
```

The mapping may equally be stated from the text side, and the two merge:

```markdown
+++
id   = "main-theorem"
kind = "theorem"
lean = ["MyProject.mainTheorem"]
+++
```

**3. Extract.**  Name the modules to import, or put them in
`blueprint.toml`:

```toml
[lean]
modules = ["MyProject"]
```

```bash
lake exe blueprint extract                  # writes lean-facts.json
lake exe blueprint extract MyProject.Basic MyProject.Main
```

The tags survive `import`, so importing the project's root module finds
every tagged declaration below it.

**4. Check and build.**

```bash
lake exe blueprint check --lean             # exits 1 on any error
lake exe blueprint build                    # blueprint.json, facts merged in
```

`check --lean` reports a named constant that does not exist
(`missing-lean`), a `uses` edge the Lean dependency graph does not show
(`declared-not-actual`), and a Lean dependency no `uses` edge declares
(`actual-not-declared`).  The derived status of an object is `proved`,
`proved_with_axioms` when its proof rests on an axiom outside `propext`,
`Classical.choice` and `Quot.sound`, `stated` when it rests on `sorry`, and
`missing` when the constant is not there.

`BlueprintExamples/` in this repository is a small worked example of all of
this: it is the Lean development that `examples/induction` and
`examples/broken` describe.  Their `lean-facts.json` is generated from it —

```bash
lake exe blueprint extract --root examples/induction
lake exe blueprint extract --root examples/broken
```

— and `./test.sh` fails if the committed files are not what those commands
produce.

## Coming from a LaTeX blueprint

A project that already has a `leanblueprint` LaTeX blueprint converts in one
command:

```bash
lake exe blueprint import-latex blueprint/src/content.tex \
  --out blueprint --toml blueprint.toml --report import-report.txt
lake exe blueprint check
```

`\input` is followed, `\chapter`/`\section`/… become nested sections, the
theorem-like environments become objects with their `\label` as id, `\lean`
and `\uses` become the `lean` attribute and `uses` edges, a following
`proof` becomes a `## Proof` in the same object, and every `\newcommand` and
`\DeclareMathOperator` lands in `[katex.macros]` for the website to give to
KaTeX.  Maths is copied out untouched; every command and environment the
converter did not understand is counted in the report, so the loss is
visible.  `examples/latex-import` is a worked example with its expected
output committed next to it, and `docs/cli.md` is the reference.

## History and the website

The compiled snapshot is the whole interchange format, so everything about
change is a comparison of two snapshots (`DESIGN.md` §7).

```bash
# what changed between two revisions, or between a revision and a file
lake exe blueprint diff HEAD~10 HEAD --root examples/induction
lake exe blueprint diff old.json blueprint.json --json

# what every commit did to one object, across renames
lake exe blueprint log main-theorem --root examples/induction

# status counts by kind now, and the delta since a revision
lake exe blueprint progress --root examples/induction --since HEAD~10
```

`diff` matches objects by id and then by the `aliases` a `blueprint rename`
records, so a rename is a rename and not an addition plus a removal.  A
derived status that falls from `proved` back to `stated`, `missing` or
`absent` is the `status-regression` error of `docs/snapshot-format.md`:
`diff` exits 1 on it unless `--no-fail` is given, which is what makes it
useful in CI.

The website is plain files under `web/` — no build step — and
`blueprint site` puts them together with a freshly built snapshot:

```bash
lake exe blueprint site  --root examples/induction -o _site
lake exe blueprint serve --root examples/induction            # site, then serve
```

`site` finds its copy of `web/` through `$BLUEPRINT_WEB_DIR`, then
`<root>/web`, then the package the running executable belongs to — so a
project that consumes this tool through Lake gets the website out of
`.lake/packages/blueprint/web` without copying anything.  `serve` runs
`site` first and then hands the directory to `python3 -m http.server`, `npx
serve`, `busybox httpd` or `nix-shell -p python3`, whichever is installed,
and tells you what to run if none of them is.

The time slider on the progress page replays past snapshots out of
`data/index.json`, which `blueprint history add` maintains:

```bash
lake exe blueprint build --root examples/induction -o snapshot.json
lake exe blueprint history add snapshot.json --dir history   # sha, date from HEAD
lake exe blueprint site --root examples/induction --history history -o _site
```

`.github/workflows/lean_action_ci.yml` does exactly that on every push to
the default branch: it extracts the Lean facts, builds the snapshot, files
it in a `history/` directory restored from the `gh-pages` branch, assembles
`_site`, deploys it to GitHub Pages, and pushes the grown history back to
`gh-pages` under `data/` so that the next run finds it.

## Layout

```
Blueprint/Model.lean     objects, boundaries, schema types
Blueprint/Toml.lean      a thin wrapper around Lake.Toml
Blueprint/Schema.lean    the default schema, blueprint.toml
Blueprint/Parse.lean     front matter, sugar expansion, id derivation
Blueprint/Check.lean     well-foundedness, constraints, references, lints
Blueprint/View.lean      collapse orders, views, the display rule
Blueprint/Status.lean    derived status, progress
Blueprint/Json.lean      the snapshot, in and out
Blueprint/Git.lean       running git: revisions, trees, commits
Blueprint/Diff.lean      the semantic diff, and one file at a time for `log`
Blueprint/Site.lean      site assembly, the snapshot history index
Blueprint/Attr.lean      the @[blueprint] attribute (Lean core only)
Blueprint/Extract.lean   environment walk, lean-facts.json
Blueprint/Cli.lean       the commands
Main.lean                the executable
BlueprintExamples/       the Lean development examples/ talks about
examples/                three example blueprints
web/                     frontend (separate package)
```
