# Editing the graph

A blueprint imported as it stands — a LaTeX file released with a paper, say —
is often more tangled than the argument it records: lemmas restated in
several places, one box that is really three steps, a remark that everything
points through.  *Edit mode* lets an expert reorganise the dependency graph in
the browser — delete boxes, replace them, add new ones, split a box into
smaller reusable lemmas, merge boxes — and then write the whole reorganised
argument out as LaTeX that `blueprint import-latex` reads back.

Nothing about reading the site changes: edit mode is opt-in, and while it is
off the site downloads, draws and does exactly what it did before.

## Entering and leaving

* the `e` key, anywhere that is not taking text;
* *Edit graph*, behind the graph's *Filters* button;
* `?edit=1` in the page's address: `http://…/?edit=1#/graph`.

`e` again, or *Done*, leaves it.  Within a tab edit mode stays on across
reloads until it is left.  The edits themselves are kept either way (below).

Only then are `edit.js`, `edit-model.js`, `edit.css` and the TeX writer
loaded; a reader who never presses `e` never fetches them.  A past snapshot
(the progress page's time slider) is not edited: going to one leaves edit
mode.

## What it looks like

* a bar at the bottom left: the number of changes, a warning when the edits
  made a dependency cycle, *Undo*, *Redo*, *+ Node*, *Export TeX*, *Export
  edits*, *Import edits*, `?` for the shortcuts, *Done*;
* the graph inside a thin accent frame; a new node drawn with a green dashed
  border, an edited one (text, kind, title, dependencies) orange, a collapsed
  section with edits inside it dotted orange, a node marked for merging
  violet;
* the side panel of a selected node gains an *Edit* box: its kind, title,
  id, statement and proof, edited in place (*Save* or Ctrl+Enter), a
  *Preview* of each text, its dependencies (*Uses*, with what is only used
  in the proof marked) and its dependents (*Used by*), each with a × to
  remove it and a field to add one by id;
* the object page gets a bar of the same commands above its title, and shows
  the edited object; the document is the edited document;
* the changes count opens a panel listing what was added, removed and
  changed, the dependencies added and removed, the cycles, and the edit log,
  each id a link into the graph.

## Operations

Every operation is one step of the log: undone by Ctrl+Z (or ↶), redone by
Ctrl+Shift+Z / Ctrl+Y (↷).

| operation | how | what it does |
|---|---|---|
| **delete** | right-click → *Delete…*, the `Delete` key, the side panel | removes the node, its proof and every edge at it.  *Reconnect* (the default) makes whatever used it use what it used, so no dependency is lost; *Drop its edges* only takes it away.  What was filed inside it moves up to its own section; a `[reference]` to it in prose is left as its title |
| **replace / edit** | F2 or `R`, *Edit…*, the side panel | the id, kind, title, statement, proof and Lean names.  A new id renames the node everywhere: its edges, its proof (`proof/<id>`), what refines it, and every `[id]` in prose.  Emptying the proof removes it, its dependencies moving to the statement |
| **add a node** | `N`, *+ Node*, right-click → *New node beside it…* or *New lemma it uses…* | a node of any statement kind, in a section (by default the selected node's, right after it), with what it uses and what uses it |
| **add a dependency** | Shift+drag from one node to another; `U` or `D` then click; the side panel's *Uses* / *Used by* fields | the drag goes the way of the arrow the graph will draw: from a dependency to what uses it.  A new dependency goes into the proof when there is one, the statement otherwise; the side panel's menu says which |
| **remove a dependency** | right-click an arc → *Remove this dependency*; × in the side panel | every `uses` between the two, statement and proof |
| **split** | `S`, *Split…* | in the dialog, select part of the statement or the proof and press *Extract selection →*: it becomes a new piece (a lemma by default) and, with *leave a [reference]*, the original's text gets `[piece-id]` in its place.  Each piece has its kind, title, id, statement, proof, which of the original's dependencies it needs, and *Also used by*: other nodes that are to use it, which is how a piece is reused.  The pieces go into the original's section, just before it, and the original uses them (from its proof when the text came from there).  *the original stops using what a piece now uses for it* moves those dependencies; *replace the original by the pieces* deletes it and makes what used it use them all |
| **merge** | mark nodes with Ctrl+click (or `X`), select one, `M` | one node keeps its id (by default the one that uses the others), or takes a new one; its statement and proof start as the merged texts, to edit.  What the merged nodes used it uses; what used them uses it; what refined them refines it; a `[reference]` to one of them is one to it; their Lean names are pooled |

The graph stays valid: every operation removes the edges of what it removes
and renames the edges of what it renames, so no relation ever points at
nothing.  A dependency cycle is allowed — a blueprint in progress may have one
— but the edit that makes it says so, and the bar shows the count.

Keys work while nothing is being typed: `?` lists them, Esc cancels a pick or
closes a menu or dialog, arrow keys move through a menu, Ctrl+Enter saves a
dialog or the side panel.

## Where the edits are kept

The edit log is kept in the browser's `localStorage`, under
`blueprint.edits:<project>:<snapshot address>`, after every step; leaving edit
mode and coming back, or a reload, resumes it.  Storage that is full or
refused is said, and the edits then last as long as the page.  The snapshot
the site serves is never changed.

*Export edits* saves the log as a file, `<project>-edits.json`; *Import
edits* loads one (replacing the current log, after asking).  So a
reorganisation can be saved, mailed to a colleague and resumed.  *Discard
all* in the changes panel undoes every step (Redo brings them back).

### The edit file

```jsonc
{ "format": "blueprint-edits", "version": 1,
  "base": { "project": "paper", "nodes": 23, "hash": "1f0c33ab" },   // what it was made on
  "saved": "2026-11-20T10:00:00.000Z",
  "ops": [
    { "op": "split", "label": "Split lem-boxes out of lem-tube", "at": "2026-11-20T09:58:12.000Z",
      "ids": ["lem-tube", "lem-boxes"],
      "changes": [
        { "put": { "id": "lem-boxes", "kind": "lemma", "boundary": [], "attrs": { "order": 3.5 }, "body": "…" } },
        { "put": { "id": "uses/proof~lem-tube/lem-boxes", "kind": "uses", "boundary": [ … ] } },
        { "del": "uses/lem-tube/def-compact" },
        { "rename": { "from": "thm-fip", "to": "thm-closed" } }
      ] } ] }
```

Each op is what one step did, as whole snapshot objects (`docs/snapshot-format.md`)
to put in place and ids to delete, computed against the blueprint as edited
by the steps before it; `rename` carries a derived status along.  The edited
blueprint is the snapshot with every op's changes applied in turn
(`applyOps` in `web/edit-model.js`).  `base` names the snapshot the log was
made on — its project and a hash of its node ids.  A log loaded onto another
version of the blueprint (the next commit, say) is replayed all the same,
and the editor says it was made on another version: puts and deletes of whole
objects replay as long as the objects they name are still there.

## Export TeX

*Export TeX* writes the blueprint as edited as one LaTeX document,
`<project>-edited.tex`, in the conventions of a `leanblueprint` project
(`web/export/blueprint-tex.js`):

* `\chapter`, `\section`, `\subsection`, `\subsubsection` for the sections, in
  their order and nesting, each with `\label{<id>}`;
* a theorem-like environment per statement — its kind (`lemma`,
  `definition`, …), or the environment it was imported from (the
  `latex:<env>` tag) — with `[title]`, `\label{<id>}`, `\lean{…}`, `\leanok`
  when Lean says it is proved, and `\uses{…}` with what the statement uses;
* its `proof` right after it, with the proof's own `\uses{…}` (and
  `\leanok`);
* within a section, statements in dependency order: each after what it uses
  from the same section, otherwise in the order the document reads them;
* the prose converted from Markdown as the PDF export converts it, `[slug]`
  becoming `\cref{slug}` and maths copied through;
* a preamble that compiles on its own with pdfLaTeX (amsthm environments, the
  project's KaTeX macros as `\newcommand`s, the Unicode characters declared,
  `\lean`, `\leanok` and `\uses` as no-ops).

Every label is the object's id, so reading it back gives the same ids:

```bash
blueprint import-latex paper-edited.tex --out blueprint --toml blueprint.toml
blueprint build                      # the edited graph, as a snapshot
```

`import-latex` reads a whole document like this one: the preamble only for
its `\newcommand`s and `\newtheorem`s, the document from `\begin{document}`
on, and the blueprint annotations' own declarations are not taken for KaTeX
macros (`docs/cli.md`).

What LaTeX cannot say is written as near as it can be, and listed in the
export's notes: a statement filed under another (a detail) is written in the
same section beside it; a relation with prose of its own is written as text
after its source; a node's second proof is read on in the first; the text
between statements becomes the section's prose on import, and an appendix a
section.  `[slug]` that names no object (a citation key) is written as
`\cite{slug}`, which imports back as `[slug]`.

## For developers

* `web/edit-model.js` is pure (no DOM): the `Draft` the operations are
  computed on, `opDelete`, `opAdd`, `opEdit`, `opAddUse`, `opRemoveUse`,
  `opRemoveEdges`, `opSplit`, `opMerge`, `applyOps`, `summarize`,
  `checkGraph`, and the edit file.  `web/test/edit.test.mjs` tests it, and
  with `BLUEPRINT_BIN` set (as `test.sh` does) takes an edited blueprint
  through Export TeX, `import-latex` and `build` and compares the graphs.
* `web/edit.js` is the interface.  The pages call into it only through
  `app.editor`, which is `null` in reading mode: `graph.js` lets it decorate
  each node and arc and the side panel, `object.js` the object page.
* `web/test/browser/edit-sweep.mjs` drives all of it in headless Chromium
  with real input, and compares reading mode with a site built without it.
