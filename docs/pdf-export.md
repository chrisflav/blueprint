# The PDF export

A reader picks the whole blueprint, a chapter, a section, or a smaller part
(a refined theorem, a relation with lemmas under it, a proof with details of
its own), clicks **Export PDF**, and gets that part of the mathematical
document as a PDF, together with its LaTeX source.  The command line makes
the same PDFs, from a project or from a compiled snapshot.

## What is in an export

An export is a part of the website's document — not a dump of the snapshot
and not what the page happened to draw.  What is in the document, in what
order and under which number is `documentOutline` in `web/model.js`
(`web/README.md`, *The document's pages*); the export reads exactly that
outline, along the collapse order chosen, and only chooses a part of it:

* **Scope.**  The whole blueprint, or one entry of the outline and
  everything below it.  The parts on offer are the document's pages: every
  entry with entries below it (`exportScopes`).  The command line takes any
  entry.  A proof or a step is read with its statement, and a piece of text
  (`hidden`) in its section, so those are refused as scopes with that
  reason.
* **Detail.**  `all` levels (the default), or *n* levels below the scope,
  counted as the document's pages count them (`documentPageEntries`): a
  section's statements are one level below it.  A proof and a step belong to
  their statement and come with it at any depth; a proof with details of its
  own is an entry, so its details are one level below it.  What a depth cuts
  is said in the PDF ("3 entries below 2.2.2 are left out at this detail
  level").  A depth that cuts nothing is `all`.
* **Appendices.**  An entry of a kind the graph may hide (`graph =
  "optional"`, the built-in `appendix`) inside the scope is in by default
  and can be left out.  Exporting an appendix itself always includes it.
* **Hierarchy.**  Any collapse kind; the default is the snapshot's
  `defaultCollapse`.

Within the chosen part:

* sibling order, numbers and lead words are the website's: "Lemma 2.2.3" in
  the PDF is "Lemma 2.2.3" on the site, in a section export too;
* a statement is followed by its proofs, then its steps (relations with prose
  of their own, read under the object they start from — including a
  relation between relations, under the relation it starts from), then what
  refines it;
* a proof with refinement details is set as a proof whose lemmas are inside
  it.  On the website and in the export alike it is read right after its
  statement, as the statement's first entry (`detailedProofs` in
  `model.js`), not at the top of the document where the collapse order
  alone would put it;
* `hidden` text is set in place as bare prose, unnumbered;
* sugar edges with nothing to say (`refines/a/b`, a bare `uses`) are
  structure and are not set;
* **an object with several parents is written out once**, at the first place
  the export meets it, with everything below it, and is a pointer ("…belongs
  here too; it is written out under 2.2 Compact spaces, on page 2")
  elsewhere.  When the full document writes it out somewhere outside the
  export — a lemma shared with another section — it is still written out
  here, with a note saying where the full document has it.  A pointer never
  leads out of the PDF.

References (`[slug]`) read as on the website ("Lemma 2.3", or just "2.3"
after "Lemma"; `referenceLabel` in `model.js`):

* to something in the export: a link to it;
* to something the export leaves out: the same words, marked with a
  superscript ∗ that links to an *Outside this export* list at the end, which
  says what each is and where in the blueprint it lives;
* to a step or proof: its slug, linked when it is in the export;
* to nothing: `[slug?]` in red, and a diagnostic naming the object.

## Architecture

```
web/model.js              the document: outline, order, numbers, references (shared)
web/export/latex.js       request -> plan -> LaTeX (pure; browser and node)
web/export/markdown-tex.js  a body's Markdown and maths as LaTeX (pure)
web/export/unicode.js     the characters beyond ASCII pdfLaTeX is told about
web/export/sha256.js      SHA-256 (the browser's fallback; the store's naming)
web/export/compile.mjs    LaTeX -> PDF in a sandboxed temporary directory (node)
web/export/store.mjs      data/exports/<snapshot>/: manifest, files, assets (node)
web/export/zip.mjs        the .tex and its images as one archive (node)
web/export/cli.mjs        the command line: export, list, site, prepare (node)
web/pdf.js                the Export PDF button and dialog (browser)
web/comments-server.py    POST api/export for `blueprint serve` (python)
Blueprint/Cli.lean        blueprint export, site --pdf, serve
```

The LaTeX is written by one module that both the browser and node import,
from the snapshot, never from the DOM.  The browser does not compile it:
a static host has no TeX, and an in-browser TeX would mean megabytes of
engine and fonts fetched from a third party on every click.  So:

| where | how a PDF is had |
|-------|------------------|
| published site (GitHub Pages) | **built in advance.** CI runs `blueprint site --pdf`, which compiles every choice the dialog offers — each hierarchy × each part × each depth × with and without appendices — for the current snapshot and the ten newest history snapshots, and files them under `data/exports/<hash>/` with a `manifest.json`. The dialog fetches the manifest of the bytes it loaded and the PDF it lists. |
| `blueprint serve` | **made on demand** by the local server (`POST api/export`), for any choice and any snapshot the site serves, historical ones included, and filed in the same place.  The dialog asks the server first, which reuses a prepared PDF when it was made from the same TeX and makes it again otherwise. |
| any other static server | what was prepared, if the site was built with `--pdf`; otherwise the dialog says no PDF was prepared and hands out the TeX source, written in the page. |
| command line | `blueprint export` (or `node web/export/cli.mjs export`). |

### Snapshots, and not serving a stale PDF

Everything prepared for a snapshot lives in `data/exports/<first 16 hex
digits of the SHA-256 of the snapshot file's bytes>/`.  The page hashes the
very bytes it loaded (`crypto.subtle`, or `export/sha256.js` where there is
none) and looks only there; the manifest records the full hash and is
ignored when it does not match.  Inside, an entry is found by its canonical
request (`resolveRequest`: hierarchy, scope, depth, appendices) and its files
are named by a hash of it.  A PDF made from one revision is therefore never
offered for another, nor one section's for another section, and a
historical snapshot chosen with the time slider gets its own PDFs.  The
title block names the snapshot ("Snapshot 2026-01-15, revision 1111111111").

Making an export first removes the files an earlier run left for the same
request, so a failure cannot leave an older PDF in place; the command line
does the same in `--out`.

`data/` is the directory CI keeps on `gh-pages`, so prepared PDFs survive
between runs with the history they belong to.  Each entry records the
SHA-256 of the TeX and images it was compiled from (`input`); `site --pdf`
and the server write the TeX again — which takes milliseconds — and compile
only when it differs, so an unchanged export is not compiled twice and a
change to the export itself never leaves a PDF of its old output in place.
`site --pdf` prunes the exports of snapshots it no longer keeps PDFs for
(`--history-limit`, default 10), so the store stays bounded; for those the
dialog offers the TeX source.

### Compiling

`compile.mjs` runs `latexmk -pdf` (or `pdflatex` as often as the log asks,
at most four times) in a fresh temporary directory holding the `.tex` and
its images and nothing else, with

* no shell escape (`-no-shell-escape`, `shell_escape=f`),
* `openin_any=p` and `openout_any=p`, so nothing outside that directory can
  be read or written by name — `\input{/etc/passwd}` in a formula fails
  rather than leaking the file into the PDF,
* `-halt-on-error`: an error stops the run rather than leaving a hole,
* a time limit (120 s by default) after which the process group is killed,
* a cap on the PDF's size, and the directory removed afterwards.

It succeeds only when TeX exits 0, the file starts with `%PDF-` and the log
has no undefined reference and no missing character.  A failure keeps the
`.tex` and the TeX log, and its message names the object whose prose the
error is in (`LaTeX error in thm-x (line 80): Undefined control sequence`),
read off the `% object: <id>` comment above each object in the `.tex`.
`SOURCE_DATE_EPOCH`, when set, makes the PDF reproducible.

### The local server

`blueprint serve` runs `web/comments-server.py`, which answers

```
GET  /api/export   -> {"available": true|false, "reason": "…"}
POST /api/export   <- {"snapshot": "blueprint.json" | "data/<sha>.json",
                       "sha256": "<what the page hashed>", "collapse": "refines",
                       "scope": "<id>" | null, "depth": "all" | n, "appendices": true}
                   -> 200 {"ok": true, "base": "data/exports/<hash>/", "entry": {…}}
                      400 a malformed or impossible request, 409 the snapshot
                      changed since the page loaded it, 422 TeX failed (with the
                      log), 503 no node or no TeX here, 504 too slow
```

The request is checked for shape before anything runs (JSON only, at most 4
KB, a snapshot named the way the site names it, an object id, a depth), then
`node <site>/export/cli.mjs prepare` is run with it as arguments — no shell —
which accepts only the site's `blueprint.json` or a file its
`data/index.json` lists, refuses a snapshot whose bytes no longer match the
page's hash, and resolves the part against the snapshot.  At most two
exports run at once, a request already running is waited for rather than run
twice, and one export is limited to three minutes.  Nothing is sent
anywhere: TeX runs on the machine serving the site.

## Command line

```bash
# the whole blueprint: <name>.tex and <name>.pdf in the working directory
lake exe blueprint export --root examples/paper

# a section, a refined theorem, two levels of a chapter
lake exe blueprint export --root examples/paper --scope products -o out
lake exe blueprint export --root examples/paper --scope thm-fip -o out
lake exe blueprint export --root examples/paper --scope spaces --depth 2 -o out

# what can be exported, with how many levels each part has
lake exe blueprint export --root examples/paper --list

# from a compiled snapshot (a historical one, say), TeX only, as JSON
lake exe blueprint export --snapshot data/1111.json --tex-only --json -o out

# the site with every PDF its dialog offers
lake exe blueprint site --root examples/paper --pdf
lake exe blueprint serve --root examples/paper          # and the on-demand API
```

`blueprint export` builds the snapshot as `build` does (with
`lean-facts.json` when it is there) and pipes it to `web/export/cli.mjs`,
which can also be run directly:

```
node web/export/cli.mjs export --snapshot blueprint.json [--scope ID] [--depth N|all]
     [--collapse K] [--no-appendices] [--out DIR] [--name BASE] [--assets-root DIR]
     [--label TEXT] [--tex-only] [--timeout SECONDS] [--json]
node web/export/cli.mjs list --snapshot blueprint.json [--collapse K] [--json]
node web/export/cli.mjs site --site _site [--assets-root DIR] [--history-limit N]
     [--jobs N] [--max-exports N] [--timeout SECONDS] [--tex-only]
node web/export/cli.mjs prepare --site _site --snapshot-file F [--sha256 H] …
```

| exit | meaning |
|------|---------|
| 0 | done (for `site`: every export of the current snapshot made) |
| 1 | TeX failed: the `.tex` and `<name>.log` are kept, no PDF; or, for `blueprint export`, the export worked but the blueprint has errors |
| 2 | a bad request: no such part, a proof or text as the part, a bad depth or hierarchy, not a snapshot, a snapshot that changed |
| 3 | no TeX (or no node) on this machine; with `--tex-only` the `.tex` is still written |
| 4 | anything else |

File names say what is in them: `paper-whole.pdf`,
`paper-3-products.pdf`, `paper-2-covers-and-compact-spaces-depth-2.pdf`,
`…-no-appendix`, `…-instance-of` for another hierarchy; a historical
snapshot's download adds its revision.

### Prerequisites

* **node** 18 or later, for the export itself (the website's tests use it
  already);
* **TeX Live** with pdfLaTeX for the PDF: the preamble needs only
  `amsmath`, `amssymb`, `amsthm`, `mathtools`, `bm`, `graphicx`, `xcolor`,
  `booktabs`, `tabularx`, `fancyvrb`, `ulem`, `microtype`, `lmodern`,
  `hyperref` and `bookmark` — a TeX Live `scheme-small` is enough, and
  `mathrsfs`, `stmaryrd` and `cancel` are used when they are installed.
  `latexmk` is used when it is there.  On Debian and Ubuntu:
  `apt-get install latexmk texlive-latex-recommended texlive-latex-extra
  texlive-fonts-recommended texlive-plain-generic lmodern`; on NixOS,
  `nix-shell -p texliveMedium`.

### The `.tex`

It is a complete document that compiles anywhere (`latexmk -pdf`, or
`pdflatex` twice): an `article` with its own preamble, the KaTeX commands
the website knows that LaTeX lacks (`\R`, `\N`, `\Set`, …), the
`\DeclareUnicodeCharacter`s for the characters it uses, and the project's
`[katex.macros]` as `\providecommand`/`\renewcommand` pairs (a macro that
would replace a LaTeX command such as `\begin`, or has unbalanced braces, is
left out with a diagnostic).  An export with images is also handed out as
`<name>-source.zip`, the `.tex` next to its `assets/`.  Images are read
relative to the Markdown file that names them, inside the project root only;
PNG, JPEG and PDF images are included, others (SVG, GIF, an `http` URL) are
a framed placeholder and a diagnostic.

Maths is copied through untouched apart from its delimiters: `$…$` becomes
`\(…\)`, `$$…$$` becomes `\[…\]`, and a display that is one `align`,
`gather`, `multline`, … is set as that environment, unnumbered, as KaTeX
sets it.  Blank lines inside a formula (which end a paragraph in TeX) and
`\label`s (which KaTeX ignores) are dropped, and a Latin letter in maths
(`\mathrm{ét}`) is wrapped in `\text`.  Text outside maths is escaped,
ligatures TeX would invent (`--`, `''`, `<<`) included.

## Limitations

* The published site can only hand out PDFs that were made when it was
  built: those of the current snapshot and of the ten newest history
  snapshots (`--history-limit`).  For older snapshots, and for sites built
  without `--pdf`, the dialog offers the TeX source instead, and `blueprint
  serve` makes any of them.
* Images are taken from the project's files, so they are included only in
  exports of the current snapshot; a historical snapshot's export has a
  placeholder for each image (the files of that revision are not at hand),
  and says so.
* pdfLaTeX knows the Latin, Greek and mathematical characters `unicode.js`
  lists; any other character (Cyrillic, CJK) is set as a framed `U+XXXX`
  and reported, never dropped silently.
* A formula KaTeX accepts that LaTeX does not (a KaTeX-only command not in
  the compatibility list, a project macro that only makes sense to KaTeX)
  fails the export of the parts it is in, with an error naming the object;
  the fix is a `[katex.macros]` entry that works in both.
* Raw HTML in a body keeps its text; its markup is dropped (a few inline
  tags — `<sup>`, `<sub>`, `<em>`, … — are kept as LaTeX).
* Numbers are the full document's, so a section exported alone starts at
  its own number ("Section 3", "Theorem 3.1"), and a shared lemma written
  out in it keeps the number it has where the full document puts it.

## Tests

```bash
node web/test/export.test.mjs           # selection, order, depth, references, LaTeX, store
nix-shell -p nodejs_22 texliveMedium poppler-utils \
  --run "node web/test/export-compile.test.mjs"   # real PDFs, read back; failures
node web/test/app.test.mjs              # the button and the dialog, in a DOM shim
./test.sh                               # the commands, the samples, the server API
node web/test/browser/sweep.mjs --sections=export   # the button, in real browsers
```

`examples/paper` is the blueprint these exercise (nested sections, text, an
appendix with a table, code and an image, a lemma under two sections, a
proof with details and a step, a `## Proof` in a body, macros, non-ASCII
text), and `examples/paper/export/` holds what `blueprint export` makes of
it: the whole blueprint, the section `products` (with the shared tube lemma
written out) and the refined theorem `thm-fip`, as `.tex` and `.pdf`.
`./test.sh` checks the `.tex` files are what the command writes.
