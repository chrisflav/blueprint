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
  `declared-not-actual`, `actual-not-declared`, `use-belongs-to-proof` and
  `use-belongs-to-statement`.  It is an error if the file is not there.
  For a statement with a proof, its `uses` are held against the
  dependencies of the declaration's type and the proof's against those of
  its value; a use declared on the wrong one of the two is reported as
  `use-belongs-to-proof` (on the statement, needed only by the proof) or
  `use-belongs-to-statement` (on the proof, needed to state it), both info.
  Without a proof, or with facts from before `typeDeps` and `valueDeps`,
  everything declared on the object and its proofs is held against
  `deps`.
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

### `blueprint import-latex <entry.tex> --out <dir>`

```
blueprint import-latex <entry.tex> --out <dir>
      [--toml blueprint.toml] [--report file] [--macros file]... [--clean]
```

Converts a `leanblueprint` style LaTeX blueprint into the authoring format
below.  It is a one-way conversion: the LaTeX is the input, the Markdown is
from then on the source.  Nothing is expanded and nothing is thrown away
silently — everything the converter did not understand is counted in the
report, which goes to `--report` or, by default, to stderr.

```
blueprint import-latex blueprint/src/content.tex --out blueprint \
  --toml blueprint.toml --report import-report.txt
```

**Inputs.**  `\input{path}` is spliced in recursively, resolved against the
directory of the entry file (as `leanblueprint` resolves them, relative to
`src/`) and then against the directory of the including file; `.tex` may be
left off.  Comments (`%` to the end of the line, but not `\%`) are stripped
first.  An `\input` that does not resolve is listed in the report.

**Sections.**  `\chapter`, `\section`, `\subsection` and `\subsubsection`
become `section` objects, one directory each: a chapter is a directory below
`--out`, a section a directory below its chapter, and so on, with the section
object itself in that directory's `_section.md`.  The `refines` chain of the
`_section.md` convention therefore reproduces the document tree.  The id is
the slug of the `\label` that follows the heading, or of the title when there
is none, with a numeric suffix if that is taken.  Every object gets an
`order` attribute counting up in document order, so the document view reads
like the paper.  `\paragraph` is a run-in heading, not a section: it becomes
a bold paragraph.

**Environments.**  The theorem-like environments are `theorem`,
`proposition`, `lemma`, `corollary`, `definition`, `construction`,
`openproblem`, `conditionaltheorem`, `remark`, `example`, `warning`, a few
further standard names, and everything a `\newtheorem` in the macro files or
in the corpus declares.  They map to kinds:

| environment | kind |
|---|---|
| `theorem`, `conditionaltheorem`, `conjecture`, `claim`, … | `theorem` |
| `proposition` | `proposition` |
| `corollary` | `corollary` |
| `lemma` | `lemma` |
| `definition`, `construction`, `notation`, `convention` | `definition` |
| `remark`, `example`, `warning`, `openproblem`, … | `remark` |

An environment whose name differs from its kind records the name as a tag,
`latex:openproblem`.  `[title]` becomes `title`; the `\label` gives the id
(slug: lower case, everything outside `a-z0-9-_.` to `-`, repeats collapsed);
an environment without a label gets `<section-id>--<env>-<n>`, `n` counting
that environment within that section, and is counted in the report.

**Annotations.**  `\lean{a, b}` becomes the `lean` attribute, split on commas
and trimmed, and may be wrapped over several lines.  `\uses{a,b}` is
deduplicated, resolved through the label map and written as the `uses` sugar
key.  A `proof` environment that directly follows a statement becomes a
proof object of its own, `<id>.proof.md` next to the statement (`DESIGN.md`
§2.5), with the `\uses` written in the proof as its `uses`, less those the
statement already declares; every kind the importer produces can take a
proof, `remark` included.  `\leanok`, `\notready` and `\mathlibok` are
dropped: derived status comes from Lean in this tool, never from the text.
`\discussion{n}` becomes the tag `discussion:n`.

**Unresolved dependencies.**  A `\uses` target that names no label would be a
`dangling-ref` error, so it never becomes an edge.  It is listed at the end
of the body it was written in, statement or proof, after `Unresolved
dependencies:` and counted in the
report, with the object that referred to it.

**Bodies.**  Maths is copied out untouched: `$…$`, `$$…$$`, `\(…\)` and
`\[…\]`, and the `equation`, `equation*`, `gather`, `multline`, `displaymath`
environments, become `$…$` or `$$ … $$`; `align`, `align*`, `alignat` and
`flalign` become `$$ \begin{aligned} … \end{aligned} $$`, which is what KaTeX
can render.  Prose is translated heuristically: `\emph`/`\textit` to `*…*`,
`\textbf` to `**…**`, `\texttt`/`\verb`/`\nolinkurl` to a code span,
`\textsc`/`\textsf`/`\text` to plain text, `itemize`/`enumerate` (nested, and
`description` with bold terms) to Markdown lists, `quote` to a `>` block,
`verbatim` to a fenced block, `\ref`/`\cref`/`\Cref`/`\autoref`/`\eqref` to a
`[slug]` link when the label is known and to the label's plain text when it
is not, `\cite{k1,k2}` to `[k1, k2]`, `\url`/`\href` to Markdown links,
`\footnote` to a parenthesis, `\\` to a hard line break, `\par` and blank
lines to paragraph breaks, `~` to a space, `\,`/`\;`/`\!` to nothing, `\ldots`
to `...`, `--`/`---` to the dashes they stand for, `\'e` and friends to the
accented letter, and `\%`, `\&`, `\_`, `\#`, `\$`, `\{`, `\}` to the
characters they escape.  The five prose macros of a `leanblueprint` project's
`macros/common.tex` that carry meaning are translated too: `\statusnote{x}`
to a `**Status.** x` paragraph, `\formalizationnote{x}` to
`**Formalization note.** x`, `\constructedby{x}` to `*Constructed by:* x`,
`\openobligation{x}` to `**Open obligation:** x` and `\retiredobligation{x}`
to `**Retired invalid route:** x`.

Any other command keeps its braced argument, loses its name, and is counted
by name in the report; any other environment keeps its contents and is
counted.  A handful of commands that take a length or a counter rather than
prose (`\vspace`, `\Needspace`, `\refstepcounter`, …) lose their argument as
well, and are still counted.

**KaTeX macros.**  Every `\newcommand`, `\renewcommand`, `\providecommand`,
`\DeclareMathOperator` and `\DeclareMathOperator*` in the corpus and in the
macro files is collected — later definitions win — and written into the
`[katex.macros]` table of the file `--toml` names, replacing whatever was
there and leaving the rest of the file alone.  `\DeclareMathOperator{\Sh}{Sh}`
becomes `"\\Sh" = "\\operatorname{Sh}"` and the starred form
`\operatorname*`.  Macros are never expanded: `#1` style parameters are kept
exactly as KaTeX wants them.  The macro files are the ones `--macros` names
(repeatable) plus `<dir of entry>/macros/common.tex` when that exists.

**Output.**  `<out>/<chapter>/<section>/…/<id>.md`, with a `_section.md` in
every directory, written deterministically so that re-importing diffs
cleanly.  `--clean` additionally deletes `.md` files below `--out` that this
import did not write, and then the directories that are left empty; without
it, files from an earlier import with different ids stay where they are.

**The report** counts, per name and biggest first, the commands and
environments that were not understood, and lists the unresolved `\uses`
targets, the environments without a label, the labels declared twice and the
totals per kind.

### `blueprint read <blueprint.json> [-o out]`

Parses a snapshot and writes it out again.  Not part of `DESIGN.md` §8; it
exists so that the reader (which `blueprint diff` uses for a side that is a
file) is exercised, and `test.sh` uses it as a round trip test.

### `blueprint extract [modules...] [--root d] [--snapshot f] [--names a,b] [--descend a,b] [--out f]`

Imports the named Lean modules and writes `lean-facts.json`
(`docs/snapshot-format.md`).  Run it through Lake, so that the project's
`.olean` files are on `LEAN_PATH`:

```
lake exe blueprint extract MyProject
lake exe blueprint extract                       # modules from blueprint.toml
```

**Which root.**  `--root`, else the working directory.  Without `--root`
the working directory is read as a blueprint project only when it has a
`blueprint.toml`, so `extract MyProject` also runs outside of one.

**Which modules.**  The positional arguments, or, when there are none,
`[lean] modules` of the root's `blueprint.toml`.  It is an error if neither
names anything.  Importing a module brings in everything
it imports, so naming the project's root module is usually enough.

**Which constants.**  The union of

* every constant carrying `@[blueprint "<id>"]` in the imported environment,
  including constants of *imported* modules — the attribute is stored in a
  persistent environment extension;
* the `lean` attributes of the blueprint sources under the root;
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

The walk also **stops at the edge of the project**: it descends only through
unmapped constants declared in the project's own modules.  A mapped constant
of a dependency (say a blueprint object mapped to a Mathlib lemma) is still
recorded when project code names it, or reaches it through project code, but
the walk never passes through a dependency's internals.  Otherwise every
project declaration whose proof touches Mathlib somewhere would pick up an
edge to every mapped Mathlib lemma that Mathlib itself happens to use, and
`check --lean` would report those as `actual-not-declared`.  The project's
modules are those below `--descend a,b`, else `[lean] descend` of
`blueprint.toml`, else the first component of every imported module
(`WeilConjectures` for `WeilConjectures.Foo.Bar`).

`typeDeps` and `valueDeps` are the same walk, stopping at the same places,
started from the type alone and from the value (and, for an inductive type,
its constructors) alone, so `deps` is their union.  They are what `check --lean` holds a statement's and
its proof's `uses` against: `Induction.mainTheorem` needs `Induction.keyProp`
only in its proof, `Induction.keyProp` needs `Topology.compactness` already
to state it.

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

### `blueprint site [-o dir] [--facts f] [--history dir] [--pdf [--history-limit n]]`

Assembles the static website:

* copies `web/` into `dir` (default `<root>/_site`), leaving out `sample`,
  `test` and `README.md`, which are fixtures of the frontend and not part of
  the deployed site;
* writes the freshly built snapshot to `<dir>/blueprint.json`, which is where
  `index.html` looks for it.  Its `derived.checks` is empty: the website shows
  no checks, so the reader does not download them.  The errors are printed
  instead, as `build` prints them, and `blueprint check` lists them all;
* with `--history dir`, copies that directory to `<dir>/data/` and makes sure
  `data/index.json` lists the snapshot that was just built — as
  `data/<sha>.json` when `history add` already filed it, and otherwise as an
  entry pointing at `blueprint.json` itself;
* with `[site] blog` in `blueprint.toml`, copies that directory to
  `<dir>/blog/` and lists its posts in `<dir>/blog.json`, which the website's
  *Blog* page reads (see `[site] blog` below); otherwise removes
  `blog.json`;
* with `[site.comments]` in `blueprint.toml`, writes
  `<dir>/comments-config.json`, which says where the website's comments go:
  the Zulip and channel the comment server posts them to, and the comment
  server of a site served elsewhere (see `[site.comments]` below), but nothing
  of the bot; otherwise removes it.

With `--pdf` it then prepares the PDFs the website's *Export PDF* button
hands out (`docs/pdf-export.md`): every choice its dialog offers — each
collapse kind, each part of the document, each depth, with and without
appendices — for the current snapshot and the `--history-limit` (default
10) newest snapshots of the history, under `<dir>/data/exports/<snapshot
hash>/` with a `manifest.json`.  What is already there for a snapshot is
reused, the exports of snapshots no longer kept are removed, and images are
read from the project for the current snapshot.  It runs
`<dir>/export/cli.mjs site` under node and needs TeX Live (pdfLaTeX).

The exit status is that of `build`: 1 when an error level check fires, and
the site is written either way.  With `--pdf` it is that of the export when
an export of the current snapshot failed (1) or there is no TeX or node (3);
each failure is printed and recorded in the manifest, where the dialog
shows it.

**Where `web/` comes from.**  In order:

1. `$BLUEPRINT_WEB_DIR`, which must contain an `index.html`;
2. `<root>/web`, when it contains an `index.html`;
3. the package the running executable belongs to: the directory of
   `IO.appPath` and each of its parents, looking for a `web/index.html`.

(3) is what makes the tool work as a Lake dependency: the binary lives in
`.lake/packages/blueprint/.lake/build/bin/`, and walking up finds
`.lake/packages/blueprint/web`.

### `blueprint serve [--port p] [--site dir] [--facts f] [--history dir] [--pdf]`

Runs `site` first (with `--pdf` if given), so what is served is fresh, then
serves `dir` (default `<root>/_site`) on `--port` (default 8000).  With
`python3` at hand that is `web/comments-server.py`, which also keeps the
comments of object pages and of the document's pages and makes, on demand, a PDF the site was not built
with (`POST api/export`, `docs/pdf-export.md`), reading images from the
project root (a site with `comments-config.json` keeps its comments on
Zulip instead, the server posting them as the bot of `BLUEPRINT_ZULIP_EMAIL`
and `BLUEPRINT_ZULIP_KEY` in its environment); otherwise it is the first of
these that is installed:

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

### `blueprint export [--scope id] [--depth n|all] [--collapse K] [--no-appendices] [-o dir] [--name base] [--tex-only] [--snapshot f] [--facts f] [--list] [--json] [--timeout s] [--label text]`

Writes the document, or one part of it, as LaTeX and PDF:
`<name>.tex` and `<name>.pdf` in `-o` (default: the working directory),
`<name>` saying what it is (`paper-whole`, `paper-3-products`,
`paper-2-covers-and-compact-spaces-depth-2`).  `--scope` names the part by
its object id — a section, or any entry of the document with what is below
it — and defaults to the whole blueprint; `--depth` is how many levels below
it are written out (default `all`); `--collapse` the hierarchy (default the
snapshot's `defaultCollapse`); `--no-appendices` leaves out the appendices
inside the part.  `--list` prints the parts that can be exported, with their
number of levels.  `--tex-only` writes the `.tex` without running TeX.
`--json` prints the result, with its diagnostics, as JSON.

The snapshot is built as `build` builds it (with `--facts`, else
`lean-facts.json` when it is there), unless `--snapshot` names a compiled
one; images are read relative to their Markdown files under the root and
packaged with the TeX (`assets/`, `<name>-source.zip`).  What is selected,
in what order and under which numbers is the website's document, read by the
same code (`web/export/latex.js`), which `docs/pdf-export.md` describes;
the command hands the snapshot to `web/export/cli.mjs` under node.

Exit status: 0; 1 when TeX failed (the `.tex` and `<name>.log` are kept and
no PDF is left behind) or the blueprint has errors; 2 for a part that does
not exist or is not one (a proof is read with its statement), a bad depth or
hierarchy; 3 when TeX or node is not installed.  It needs node 18 or later,
and TeX Live with pdfLaTeX unless `--tex-only`.

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

### `blueprint migrate [--facts f] [--dry-run]`

Moves a blueprint written before proofs were objects onto them (`DESIGN.md`
§2.5).  Three steps in one pass, safe to run again; a second run over a
migrated blueprint changes nothing.

* **Sketches.**  A section whose body opens with `*Proposition (sketch).*`
  — any kind of the schema in place of `Proposition` — is that statement at
  the level of a sketch.  It becomes an object of that kind, tagged
  `sketch`, without the lead-in, and keeps its id, its file and everything
  that refines it, so a `_section.md` stays its directory's object.  A word
  the schema has no kind for is reported and left alone.
* **Split.**  Every proof in the body of a statement the `proof` kind may
  attach to moves into a file of its own next to it.  A proof is the
  section of a `Proof` heading (`## Proof` or `## Proof.`, at any level), up
  to the next heading of the same or a higher level, markers inside it
  included; or a paragraph opened by an inline marker (`*Proof.*`,
  `**Proof.**`, `*Proof of (i).*`, `*Proof sketch.*`), up to the next such
  marker or the next heading that closes the one it sits under.  Fenced
  code is never cut.  The first proof goes to `<stem>.proof.md` with the
  derived id `proof/<id>`; the `k`-th to `<stem>.proof-<k>.md` with the id
  `proof/<id>/<k>`, and with several each gets an `order`.  The stem is the
  file's name, or the id for a directory's `_section.md`.  Proofs found
  after an earlier run are numbered after the ones split off then.  A proof
  that follows a restatement or claim under a heading of its own (a
  `Detailed form`) is titled after it, `of the detailed form`, and the site
  reads it as *Proof of the detailed form.*  A marker gives its own title:
  `*Proof of (i).*` gives `of (i)` (*Proof of (i).*), `*Proof sketch.*` and
  `*Proof (sketch).*` give `sketch` (*Proof (sketch).*).  The restatement
  stays with the statement.
* **Move uses.**  With Lean facts that split each declaration's
  dependencies (`typeDeps` and `valueDeps`, from this version of
  `blueprint extract`), a use in the statement's `uses` key that Lean needs
  only in the value moves to the proof's `uses`, whether the proof was just
  split off or was already there.  A use the facts do not decide stays on
  the statement, and so does an edge written out in a file of its own.

Left alone and listed: a section opening with a word the schema has no kind
for, a statement with a proof in its body and an anonymous proof object
already, and an object of a kind a proof cannot attach to (a section, say)
with a proof in its body.  The facts are `--facts`, else
`<root>/lean-facts.json` when it is there; without them the command only
splits.  `--dry-run` prints what it would do and writes nothing.

## `blueprint.toml`

At the project root.  Everything is optional.

```toml
name            = "MyProject"       # or under a [project] table
title           = "My Project blueprint"
dir             = "blueprint"       # where the Markdown lives
defaultCollapse = "refines"

[lean]
modules = ["MyProject"]             # what `blueprint extract` imports
descend = ["MyProject", "MyLib"]    # optional: where the dependency walk goes

[katex.macros]                      # handed to the website as project.katexMacros
"\\Fq"   = "\\mathbf F_q"
"\\Spec" = "\\operatorname{Spec}"
"\\poly" = "#1[T]"

[site]
numbering = "nested"                # statements inside statements: n.m.k, default "flat"
pdfDetails = false                  # PDFs leave the details out, default true
pdfScopes = ["part", "chapter"]     # PDFs only of these kinds or ids, besides the whole; default every page
pdfReferences = "all"               # every PDF ends with the whole bibliography, default "cited"
assets  = "site-assets"             # copied into the site as assets/
blog    = "blog"                    # posts, Markdown and PDFs, on the Blog page
logo    = "assets/logo.svg"         # left of the title in the top bar
logoInk = true                      # drawn in the title's colour, default false

[site.intro]                        # shown as the website opens, then the graph
file     = "intro.md"               # Markdown; or body = """…""" inline
duration = 4                        # seconds, default 3

# or, instead of the single node, a zoom from the intro as a title into the
# graph, through pictures of its own:
#   background = "assets/page.jpg"   # faded behind the title
#   hold       = 0.5                 # seconds the title stays, default 0.5
#   step       = 1                   # seconds per step of the zoom, default 1
#
#   [[site.intro.zoom]]
#   nodes  = [{ title = "Main theorem", kind = "theorem" }]
#
#   [[site.intro.zoom]]
#   nodes  = [{ id = "a", title = "Part A" }, { id = "b", title = "Part B" }]
#   arrows = [["a", "b"]]

[site.comments]                     # comments on Zulip, through the comment server
zulip   = "https://example.zulipchat.com"
channel = "blueprint comments"      # one topic per comment, named by its title
# server = "https://comments.example.org/"   # the comment server of a site served elsewhere

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
arrow      = "reverse"              # "forward" (src -> tgt) | "reverse" (tgt -> src)
graph      = "always"               # "always" | "optional" | "never" | "through"
```

`arrow` only changes the picture: which end of a binary kind's arc carries the
head, and so which end ELK lays out first.  The built-in `uses` is `reverse`,
so `uses/a/b` ("a uses b") is drawn from `b` to `a`, dependencies above what
depends on them; every other built-in kind is `forward`.

`graph` only changes the website's graph, never the document: `always` (the
default) draws objects of the kind, `optional` draws them unless the reader
ticks *hide appendix* in the graph's toolbar, and `never` leaves them to the
document alone.  An object the graph leaves out takes along everything below
it in every collapse order, everything attached to it (its proofs), and every
relation with it on its boundary.  `through` leaves out the object and every
relation with it on its boundary, but not what is below it, which the graph
then draws as if the object were not there: the chapters of a part stand at
the top.  The built-in `part` is `through`, `appendix` is `optional`, the
built-in `matter`, `hidden` and `reference` are `never`; every other built-in
kind is `always`.

A `[kinds.X]` table *extends* the built-in kind `X` if there is one: keys you
do not mention keep their default.  Giving `boundary` replaces the whole role
list; giving only `kinds` updates the allowed kinds of the existing roles.
Cardinalities are written `"1"`, `"0..1"`, `"1.."`, `"2.."`, `"2..5"`, or as
a bare integer.

`[lean] modules` is the module list `blueprint extract` falls back to when
the command line names none.  It is optional; a string is accepted as well
as an array.

`[lean] descend` lists the module prefixes the dependency walk of `blueprint
extract` passes through (see "Dependencies" above), for a project that counts
a companion library as its own.  It defaults to the roots of the imported
modules; `--descend` overrides it.

`[katex.macros]` maps a macro name, with its backslash, to the definition
KaTeX is to use for it.  Both are ordinary TOML strings, so every backslash
is doubled; `#1`, `#2`, … are the macro's parameters and KaTeX infers the
number of arguments from them.  `blueprint build` copies the table into the
snapshot as `project.katexMacros` (`docs/snapshot-format.md`), which is where
the website picks it up, and `blueprint import-latex --toml` writes the table
from the `\newcommand`s of a LaTeX blueprint.  Nothing in the core expands
them.

The website has one style, so there is no `[site] theme` to choose one; a
`theme` left in `[site]` from when it had a style menu is ignored.

`[site] numbering` says how the document numbers a statement that lies
inside another statement, a detail under the statement it refines.  With
`"flat"`, the default, every statement of a chapter is numbered in one
series whatever its depth, as `documentOutline` describes, so details take
numbers from the chapter's series.  With `"nested"` such a statement is
numbered within the one it lies in, `2.3.1`, `2.3.2`, … under `2.3`, and the
chapter's statements keep the numbers they have without their details.
Headings and statements directly under headings are numbered as before.
`blueprint build` copies it into the snapshot as `project.numbering`.

A `part` is a heading above chapters, "Part I", "Part II", …: numbered in a
series of its own, in Roman numerals, and otherwise not there for the
numbers, so what is in it is numbered as if it stood where the part stands.
The chapters of a book in parts count on from one part to the next, as with
LaTeX's `\part`, and a statement in a chapter is numbered in its chapter.  A
chapter is put in a part by `refines`.  `serial = false` leaves a part
unnumbered ("Appendices"); a `serial` of its own replaces its numeral.

An entry's own number is set by `serial` in its front matter, an attribute
every kind accepts.  A string or a whole number is its number (`serial =
"A"`, `serial = 0`), and what is inside it is numbered under it: an appendix
`A` has sections `A.1`, `A.2` and statements `A.1`, `A.2`, ….  `serial =
false` (or `""`) leaves it unnumbered, like LaTeX's `\section*`; what is
inside it is then numbered on its own, `1`, `2`, …, and a reference to it
reads its title.  Either way it takes no place among its siblings, so they
are numbered as if it were not there: with an unnumbered introduction the
next chapter is `1`.  `check` reports `bad-attr` for any other value.

`[site] blog` names a directory, relative to the root, of posts the website
shows on a *Blog* page, a tab after *Progress*. Each `*.md` at its top is a
post: Markdown, rendered as an object's prose is (maths, `[slug]`
references, pictures, HTML), with optional TOML front matter between `+++`
lines, `title`, `author` (shown under the title) and `date` (a string or a
TOML date, shown as written). Without
a `title` its first line is the title when it is a `# ` heading, and its file
name otherwise. Each `*.pdf` at its top is a post too, read in the page
under its file name; a post and a PDF of the same name, `paper.md` and
`paper.pdf`, are one post, its words above the PDF. The posts are listed in
the order of their file names, so `01-…`, `02-…` or dates put them in order.
`blueprint site` copies the whole directory into the site as `blog/`, so a
post refers to its pictures and other files by their place in the directory
(`![](fig/a.png)`, `[slides](talks/slides.pdf)`), and only the top level
makes posts. It is not part of the snapshot, so `blueprint build` ignores it;
keep it outside `dir`, whose Markdown files are the blueprint's objects. A
site without it has no Blog tab.

`[site] pdfDetails = false` keeps the details out of every PDF the website
and `blueprint export` make (`docs/pdf-export.md`): a statement that lies
inside another statement, text inside one, and everything below them, the
entries `numbering = "nested"` numbers `n.m.k`.  The website shows them as
before.  A PDF then writes none of them out, counts none as left out, offers
none as a part, and names none: a reference to one reads as one to the
statement it lies in.  A statement's own proof is no detail, even when it has
details of its own.  The numbers stay the website's, so with `"flat"`
numbering the details' numbers are gaps in the PDF; with `"nested"` there
are none.  The default, `true`, writes the details out.  `blueprint build`
copies `false` into the snapshot as `project.pdfDetails`.

`[site] pdfScopes` names what a PDF may be made of, besides the whole
blueprint: with `["part", "chapter", "appendix"]` the export dialog offers the
whole blueprint, the parts and the chapters, `blueprint site --pdf` prepares
those alone, and `blueprint export` and the server refuse a section or a
statement, naming the part or chapter it is in.  On a section's page the
dialog offers its chapter.  A name is a kind of the schema, every entry of
which may be a PDF, or an object's id, that entry alone: `"chap-Introduction"`
allows the introduction and not the references, though both are `matter`.
A name that is neither is a `dangling-ref` error.  Without it every page, an
entry with entries below it, may be a PDF.  `blueprint build` copies it into
the snapshot as `project.pdfScopes`.

`[site] pdfReferences = "all"` ends every PDF with the whole bibliography,
every `reference` entry sorted by label, on pages of its own, whether the
PDF cites it or not; where the PDF writes the bibliography out in place (the
whole blueprint), that section starts a new page instead.  The default,
`"cited"`, ends a PDF with the entries it cites and does not write out in
place, and with none when it cites nothing.  `blueprint build` copies it into
the snapshot as `project.pdfReferences`.

`[site.intro]` is what the website shows in the middle of the screen when
it is opened at its landing page, drawn as a single graph node, before it
fades and leaves the graph laid out underneath.  `file` names a Markdown file,
relative to the root, which `blueprint build` reads; `body` gives the
Markdown inline instead (exactly one of the two is required).  It is rendered
as an object's prose is, so it may hold maths, `[slug]` references, pictures
(`![](assets/logo.png)`) and HTML of its own, such as a `<video>` or an
`<svg>`.  `duration` is how long it stays, in seconds (an integer or a
float, default 3); a click, Escape, Enter or Space skips it.  It reaches the
snapshot as `project.intro`.  A link to any other page of the site opens
straight on that page, and `?intro=0` in the page's URL leaves the intro out.
The *Replay intro* button in the graph's toolbar, beside *Show sidebar*,
plays it again: from a graph with a selection or expanded sections it goes
to the landing page first.

With one or more `[[site.intro.zoom]]` tables the intro is a short zoom
instead of the single node.  The Markdown is a title, large in the middle of
the screen in the font of the top bar's title, over `background` (an address
the site serves, such as `assets/page.jpg`, shown faded; optional).  After
`hold` seconds (default 0.5) the title flies into the top bar and becomes
its title, the top bar and the graph's tools fade in, and the view zooms
into the middle of the screen: the background grows and fades while the
first picture grows out of a point, then that picture grows on and fades
while the next grows out of its middle, and so on, the last being the graph
itself.  The fading is quick, within the first third of a step's growth, so
that a picture is gone well before it fills the screen; a picture at rest
takes at most about half of the screen.  Each step takes `step` seconds
(default 1) and makes everything ten times bigger, quickly at first and then
settling slowly: what comes in reaches about 60% of its size in the first 40%
of the step.  `step` may instead be a list, one length per step (`step = [1,
1.5, 1.5]`, the last standing for any steps after it); every step then grows
at the same pace, the longest ten times, so a shorter step grows less.  A picture is a few
boxes and arrows, laid out and drawn as the graph lays out and draws its
nodes and arcs: `nodes` lists them, each a title or a table with a `title`,
an `id` for `arrows` to name (default: the title) and the `kind` it is drawn
as (default `section`, drawn as a collapsed section); `arrows` lists pairs of
ids, each drawn from the first to the second.  `duration` is unused then.
The title may move: an `<svg>` in it with SMIL animations (`<animate>`,
`<set>`) starts from its time 0 as the intro opens, without the title
growing in (it shows itself, writing itself say), so `hold` is best the
length of its animation.  While it plays the website only downloads the
snapshot; reading it and drawing the graph wait until the title has played,
so that the title never stops halfway, and it then stays at its end until
the graph is drawn.  The title runs on a clock of its own, which goes on
frame by frame: a moment in which the browser is busy, or the tab is out of
sight, holds it where it is rather than letting it skip ahead, so it is
always seen whole; with reduced motion it is shown as it
ends.  And it may land on the top bar's logo (`[site] logo`) rather than on
its title: an element of the title marked `data-intro-logo`, framing a
drawing of the logo as the logo's picture is framed, flies onto the logo,
which the top bar shows only once it has landed, while the top bar's title
fades in with the rest of the bar.
`blueprint site` writes the intro to `intro.json` beside the snapshot as
well, so that the title shows at once and stays until the snapshot is in and
the graph is drawn, rather than the page waiting blank for a large snapshot.

`[site] assets` names a directory, relative to the root, that `blueprint
site` copies into the site as `assets/`: the place for the intro's pictures.
It is not part of the snapshot.  A relative address in the intro is resolved
against the directory holding `blueprint.json`, which is the site's root.

`[site] logo` is a picture the website shows left of its title in the top
bar, in place of its own mark and in every style: an address the site
serves, such as `assets/logo.svg`, resolved as the intro's are.  It is drawn
a little taller than the title's letters.  With `logoInk = true` only its
shape counts: it is filled with the title's colour, so a one-colour logo
follows the style and dark mode; otherwise it keeps its own colours.  They
reach the snapshot as `project.logo` and `project.logoInk`.

A comment on the website is public, listed below its page, or private, kept
for the blueprint's authors and never listed: the reader chooses.  Every
comment has a short title, at most 60 characters, which the website shows
above it.  The
comment server (`web/comments-server.py`, which `blueprint serve` runs)
keeps both, by default in its comment files (`--comments`, one JSON file per
object), and answers the page with the public ones alone.

`[site.comments]` keeps them on a Zulip server instead.  `zulip` is the
address of the server and `channel` the channel the comments go to; both are
needed.  The page still posts to the comment server, and the comment server
posts to Zulip as a bot, each comment in a topic of its own named by its
title (a second comment with the same title joins that topic).  The first
line of the message names the author, the page, whether the comment is
public or private, and, last, the object's id as code; the comment server
lists an object's comments by searching the channel for the bot's public
messages and keeping those whose first line names that id, so a message
edited or deleted on Zulip is a comment edited or deleted on the website.
The website links each comment's title to its topic.  Comments kept before
titles, all of an object in one topic (the object's id, or for an id longer
than Zulip's 60 characters its first 50 and a hash; `document (top page)`
for the top page of the document), are still listed, and a comment posted
without a title, by a page of before titles, still goes there.

The bot is the comment server's alone: it reads `BLUEPRINT_ZULIP_EMAIL` and
`BLUEPRINT_ZULIP_KEY` (a generic bot subscribed to the channel) from its own
environment, makes every call to Zulip itself, and never sends them to a
browser, so a reader cannot see or use the bot.  `blueprint.toml` refuses an
`email` or a `key`, and `blueprint site` writes no credentials: its
`comments-config.json` holds the Zulip, the channel and `server`, where the
comment server reads them.  Without the two variables the comment server says
so and keeps the comments in its files.

A site needs its comment server to have comments, on Zulip or not: a static
host cannot keep the bot's key secret.  For a site served elsewhere (GitHub
Pages, say), run the comment server where the key can be kept, on the built
site and naming the site's origin,

```
BLUEPRINT_ZULIP_EMAIL=… BLUEPRINT_ZULIP_KEY=… python3 web/comments-server.py \
  --directory _site --comments comments --port 8000 --bind 0.0.0.0 \
  --allow-origin https://user.github.io
```

and set `server` to its address: the website sends its comments there, and
the comment server answers no other site (`--allow-origin`, repeatable).

### The default schema

| kind | boundary | notes |
|------|----------|-------|
| `part` | — | a heading above chapters, "Part I": numbered in a series of its own with what is in it numbered as if it were not there; the graph draws what is in it but not it (`graph = "through"`) |
| `chapter` | — | a heading, as a section is |
| `section` | — | |
| `subsection` | — | a heading, as a section is |
| `appendix` | — | a section the graph can hide: `graph = "optional"` |
| `matter` | — | a section the graph never draws, with everything in it (`graph = "never"`): an introduction, the references.  In the contents, the document and the PDF it is a section like any other, numbered as one, and a reference to it reads "Section 1" |
| `hidden` | — | text belonging to no statement, such as the lines that open a section: read in place in the document, unnumbered, never drawn in the graph (`graph = "never"`) |
| `definition` | — | countable |
| `theorem` | — | countable |
| `lemma` | — | countable |
| `proposition` | — | countable |
| `corollary` | — | countable |
| `concept` | — | |
| `remark` | — | |
| `question` | — | an open question, set as a remark is |
| `example` | — | set as a remark is |
| `reference` | — | a bibliography entry, cited as `[id]`: set as a paper sets its references, unnumbered, never drawn in the graph (`graph = "never"`); see *References* below |
| `uses` | `src` 1, `tgt` 1 | sugar |
| `refines` | `src` 1, `tgt` 1 | acyclic, collapse, sugar |
| `instance_of` | `src` 1, `tgt` 1 | acyclic, collapse, sugar |
| `generalises` | `src` 1, `tgt` 1 | sugar |
| `equivalent` | `src` 1, `tgt` 1 | sugar |
| `implies` | `src` 1, `tgt` 1 | sugar |
| `commutes` | `edges` 2.. | only edge kinds in `edges` |
| `proof` | `of` 1 | only `definition`, `theorem`, `proposition`, `lemma`, `corollary`, `remark`, `example` in `of` |

Node kinds permit `title`, `lean`, `review`, `tags`, `order`, `aliases`,
`owner`; edge kinds and `proof` permit the same minus `lean`.  `defaultCollapse` is
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

**Role keys.**  A front matter key naming one of the kind's roles, and not
one of its attributes, fills that role: `of = "lem-x"` is short for
`boundary = { of = "lem-x" }`.

**Proofs.**  A proof is its own file, `DESIGN.md` §2.5, by convention
`<statement>.proof.md` next to the statement.  Its id is derived,
`proof/<statement>`, and its `uses` are what the proof needs:

```markdown
+++
kind = "proof"
of   = "add-comm"
uses = ["add-assoc"]
+++
By induction on $n$, unfolding [add] and regrouping with [add-assoc].
```

In the graph a proof is drawn inside its statement and its edges are the
statement's.  It does not refine its directory's section.

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
`refines` or is a proof (an object attached to a single object).  A
subdirectory's `_section.md` likewise refines the section of its parent
directory when there is one, so sections nest.

**Links.**  `[slug]` in a body is resolved against the object set and
reported as `bad-link` when it does not resolve.  It creates no edge.
`[text](url)`, `![x]` and `\[` are left alone.

**References.**  Each entry of the bibliography is an object of kind
`reference`, with the fields BibTeX gives it: `author` and `editor` (a list
of names, or one name; "A and B" is two, "and others" ends a list),
`title`, `year`, `month`, `journal`, `booktitle`, `series`, `volume`,
`number`, `pages`, `chapter`, `edition`, `publisher`, `organization`,
`address`, `institution`, `school`, `howpublished`, `note`, `url`, `doi`,
`eprint`, and, kept but not shown, `archivePrefix`, `primaryClass`, `isbn`,
`issn`, `key`, `keywords`, `abstract`, `language`.  `type` is the kind of
publication (`article`, `book`, `incollection`, `inproceedings`,
`phdthesis`, `mastersthesis`, `techreport`, `manual`, `misc`, …), otherwise
read off the fields: a `journal` is an article, a `booktitle` a chapter of a
collection, a `publisher` a book.  The fields are Markdown, so a title may
carry maths.

```markdown
+++
kind    = "reference"
author  = ["P. Deligne"]
title   = "La conjecture de Weil. I"
journal = "Publ. Math. IHÉS"
volume  = "43"
pages   = "273-307"
year    = "1974"
url     = "https://www.numdam.org/item/PMIHES_1974__43__273_0/"
+++
```

The document and the PDF set it as BibTeX's `alpha` style does: under its
label in the margin, "[Del74]", then the authors, the title, the journal,
volume and pages, the year, in that style's order and punctuation, the title
linked to `url`.  The label follows `alpha`'s rule: the first three
letters of a single author's family name, the initials of two to four
("BBD"), three initials and "+" for more or for "and others", then the last
two digits of the year, with a, b, c telling clashes apart (compared without
regard to case, in the order of authors, year and title).  A lower-case
"von" part adds its initials, and then the family name gives its initials
too: "L. van Beethoven" is "vB", "A. van Dam and B. Cee" "vDC".  A name is
"Given von Family" (a trailing "Jr." or "III" left out) or "von Family,
Given", and `{…}` keeps words together ("{van Dam}, A." is "van").
`label = "SGA4"` gives one of your own, which no other entry is then given.
The entries of a section come after its other contents, sorted by label,
unless they carry an `order`; a directory `references/` with a `_section.md`
titled *References* is the usual home.  The object's prose,
if any, follows the entry (a note, a link to a copy); an entry with no
`title` is its prose alone.

Prose cites an entry as `[id]`, which reads "[Del74]", several at once as
`[del74, del80]`, "[Del74, Del80]", and with a place in the work as `[sga4,
Exp. X, Cor. 4.3]`, "[SGA4, Exp. X, Cor. 4.3]": the leading ids that name
references are what is cited, the rest is the locator.  Each label links to
its entry, and on the website shows it on hover.  The locator is Markdown
like the rest of the prose (maths, emphasis), but may not contain brackets.
Brackets whose first part names no reference, `[m, n]`, stay text; so does
a citation whose ids are mistyped (`[del74, del8O]` cites `del74` with the
locator "del8O"), which no check reports.

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
lake exe blueprint export --root examples/paper --scope products   # a section as PDF
lake exe blueprint diff HEAD~10 HEAD --root examples/induction

lake exe blueprint import-latex examples/latex-import/src/content.tex \
  --out /tmp/li/blueprint --toml /tmp/li/blueprint.toml --report /tmp/li/report.txt
diff -r /tmp/li examples/latex-import/expected
```

* `examples/minimal` — one section, four nodes, `uses`, the `_section.md`
  convention and a proof with `uses` of its own.  Nothing to complain about.
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
* `examples/paper` — a short paper as a blueprint, for the PDF export:
  nested sections, text that belongs to no statement, an appendix with a
  table, code and an image, a lemma under two sections, a proof refined by
  lemmas and with a step, a `## Proof` in a body, `[katex.macros]`, displays
  and non-ASCII text.  `export/` holds what `blueprint export` makes of it
  (the whole blueprint, the section `products`, the theorem `thm-fip`), and
  `web/sample/paper/blueprint.json` is its snapshot.
* `examples/latex-import` — a small LaTeX blueprint under `src/` and, under
  `expected/`, byte for byte what `blueprint import-latex` makes of it: two
  chapters, the theorem-like environments, a proof with `\uses`, `align` and
  `equation`, a custom macro, an unresolved `\uses` and an unlabelled lemma.
  `examples/latex-import/README.md` is the table of what it covers.

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
* **`import-latex` is not in `DESIGN.md`.**  §6 says the format must be one
  mathematicians can edit; a project that already has a `leanblueprint`
  LaTeX blueprint needs a way in.  The conversion is one way and lossy, and
  the report is the record of what was lost.  Judgement calls it makes:
  `\paragraph` becomes a bold run-in heading rather than a fifth section
  level, because a directory per `\paragraph` buries the objects; a `proof`
  that directly follows a theorem-like environment is part of that object
  rather than an object of its own, since `DESIGN.md` §2 has no separate
  proof sort; `\cite{k}` becomes `[k]`, which the `bad-link` lint then
  reports unless a `reference` object of that name exists; `\_`, `\#` and
  `\$` keep their backslash outside code spans, because a bare `_` or `#` is
  Markdown syntax; and blank lines inside display maths are removed, because
  the Markdown renderer runs before KaTeX and would otherwise cut the
  formula into paragraphs.
* **`bad-link` skips maths.**  `$\mathbf Z[T]$` is not a link.  The website
  runs KaTeX before it looks for `[slug]` links and skips the rendered
  nodes, so `check` agrees with it by skipping `$…$` and `$$…$$` in the body.
* **`project.katexMacros` is left out of the snapshot when it is empty**, so
  that a project without `[katex.macros]` gets exactly the `project` object
  it got before the field existed.  So is `project.numbering` when
  `[site] numbering` is not given, and `project.intro` when there is no
  `[site.intro]`.
  `project.pdfDetails` is written only when it is `false`, and
  `project.pdfScopes` only when it names a kind or an object, and
  `project.pdfReferences` only when it is set.
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
