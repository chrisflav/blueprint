# Blueprint website

The frontend of the blueprint tool: a static single-page app that renders a
compiled snapshot (`blueprint.json`, see `../docs/snapshot-format.md`) as an
interactive graph, object pages, a linear document, a progress dashboard and a
lint report.

There is **no build step**. The files in this directory are the deployed
artefact: plain HTML, one CSS file, and ES modules loaded directly by the
browser. External libraries come from pinned CDN URLs with subresource
integrity hashes.

## Serving it

Any static file server works. The app needs `index.html` and a
`blueprint.json` in the same directory.

```sh
# the tool assembles this directory plus a fresh snapshot into _site
lake exe blueprint site  --root examples/induction -o _site
lake exe blueprint serve --root examples/induction      # site, then serve it

# or serve this directory directly, with a snapshot next to index.html
lake exe blueprint build --root examples/induction -o web/blueprint.json
nix-shell -p python3 --run "python3 -m http.server 8000 --directory web"
# then open http://localhost:8000/
```

Opening `index.html` straight from the filesystem does **not** work: ES modules
and `fetch` need an `http(s)` origin.

Without a `web/blueprint.json` the site shows a friendly error page offering to
load the bundled sample instead. To go straight there:

```
http://localhost:8000/?data=./sample/blueprint.json
```

## How data is loaded

1. `./blueprint.json`, relative to `index.html`, unless the page URL carries a
   `?data=<url>` query parameter, in which case that URL is used instead.
2. The directory containing that file is the *data base*. The app then tries
   `<base>/data/index.json`:

   ```jsonc
   { "snapshots": [
       { "sha": "…", "date": "2026-06-02", "file": "data/<sha>.json",
         "summary": { "proved": 1, "total": 6, "byStatus": { … } } }
   ] }
   ```

   Each `file` is resolved against the data base. If the index is absent or
   empty the time slider on the progress page is simply hidden.
3. Picking a snapshot in the slider loads that file, switches the whole app to
   it and shows a "viewing snapshot …" banner. "Back to current" reloads (1).

CI publishes `data/<sha>.json` plus `data/index.json` this way: `blueprint
history add` files each snapshot in a history directory and keeps its index
sorted and deduplicated, and `blueprint site --history <dir>` copies that
directory to `<site>/data` and makes sure the current snapshot is in the
index (DESIGN.md §7, `docs/snapshot-format.md`).

### What a page loads

Only what the screen on it needs, and as much of it at once as can be:

* the snapshot is asked for by a few lines of script at the top of
  `index.html`, before any other script has arrived; `app.js` takes that
  request over (`fetchSnapshot`) rather than making its own;
* each page's module (`graph.js`, `document.js`, `object.js`, `progress.js`,
  `checks.js`) is imported the first time the reader goes to it (`PAGES` in
  `app.js`). The one the URL opens on is preloaded by the same script in
  `index.html`, and `app.js`'s own imports by `modulepreload` tags, so they
  download beside `app.js` instead of after it;
* elkjs is fetched by the graph alone, and only its 9 kB page half plus the
  worker (`prepare` in `graph.js` starts both while the snapshot is still on
  its way); the 1.6 MB bundle only when the layout falls back to the main
  thread (see *How layout runs*). A page opened on the graph starts the
  worker from `index.html` itself, before any module has arrived, and
  `graph.js` takes it over (`earlyWorker`) if it imports the same pinned file;
* a layout ELK has made is remembered in `localStorage` under its exact input
  (`rememberedLayout` / `rememberLayout` in `graph.js`), so a reload, the next
  visit, or collapsing back to a view seen before is drawn without ELK at all.
  ELK is deterministic, and the whole input is the key, so the cache can only
  give what ELK would; it keeps the last 12 layouts of up to 400,000
  characters, and storage that is full or refused just means no cache;
* `data/index.json` is not waited for: the first page is drawn without it, and
  the progress page again once it is in;
* the snapshot's SHA-256 is worked out when the PDF export first asks for it.

`app.js` itself is loaded `async`, so it starts on the above while KaTeX and
marked are still arriving, and waits for them (`DOMContentLoaded`) only before
it draws.

## Routes

All state lives in the URL hash, so every view is a shareable link.

| route | page |
|-------|------|
| `#/graph` | the quotient graph |
| `#/object/<id>` | one object (the id is percent-encoded) |
| `#/document` | the contents of the linear document |
| `#/document/<id>` | the page of one entry of the document |
| `#/progress` | dashboard and time slider |
| `#/checks` | `derived.checks` |

The graph route carries its full view state as query parameters:
`collapse=<kind>`, `expand=<comma separated ids>`, `ekinds=<edge kinds>`,
`status=<derived statuses>`, `q=<search>`, `sel=<selected id>`,
`reduce=0` when *hide implied* is off, `inner=1` when *arcs of contents*
is on, and `appendix=0` when *hide appendix* is on.

The graph is drawn from `graphModel` in `model.js`: the snapshot without the
objects of a kind with `graph = "never"` (the built-in `hidden`), and, while
*hide appendix* is ticked, without those of a kind with `graph = "optional"`
(the built-in `appendix`). Either takes everything below it in any collapse
order, its proofs and every relation touching it along (`outOfGraph`), so
every view, consistency state and reduction is that of a blueprint in which
they were never written. The checkbox is offered only when the snapshot has an
appendix. The document, the object pages and the progress page read the whole
snapshot; there an appendix is a section and a hidden object is text (see
below), and an object the graph never draws says so instead of offering
*Show in graph*.

Each visible object draws its own arcs (`ownEdges` in `model.js`): an object
is drawn only when every end of it is visible as itself, never lifted to the
collapsed object it is hidden in. So a collapsed section shows the edges
declared on the section and not those of the statements inside it, and its
"×n" counts only its own edges. An edge object with contents of its own (one
that can be expanded) stays whatever its ends, as the way into them. The arcs
still carry their consistency state: solid when the contents witness the
section's edge, a hollow head when nothing inside does. *Arcs of contents*
(off by default) draws the full quotient of DESIGN.md §3 instead, the hidden
statements' edges lifted onto their sections and dashed where no section edge
declares them; the status line counts the arcs of contents it hid.

*Hide implied* (on by default) draws the transitive reduction of the graph as
drawn: an arc is left out when a longer path of the same kind already joins
its ends, so of "A uses B, B uses C, A uses C" only the first two are drawn.
The reduction (`transitiveReduction` in `model.js`) works

* per kind: a path implies an arc only of its own kind;
* on the quotient after the kind and status filters, so an arc is never hidden
  in favour of a path the reader cannot see, between collapsed sections just
  as between leaves;
* through junctions: src end → junction → tgt end is a path, but a junction
  and its spokes are never hidden themselves, since they carry more than
  reachability;
* in the model's src → tgt direction, which for a kind drawn `arrow =
  "reverse"` gives the same answer;
* on the condensation when there are cycles, where the reduction is not
  unique: arcs inside a cycle are never hidden, an arc between two strongly
  connected components only when a third component lies between them, and
  two arcs joining the same pair of components are both kept.

Hiding everything it says loses no reachability. The status line counts the
arcs it hid.

Expanding a section enters it: the level it was opened from — every node,
title and arc drawn outside it — is blurred, faded and out of reach (no
clicks, no Tab) until the reader goes back up, with *↑ Back to …* at the top
left of the stage or the section's own −. Going down another level does the
same again, one level at a time. The section entered is the innermost of the
open ones when they nest one inside the next (`enteredSection` in
`graph.js`); with sections open side by side, as after *Expand all*, there is
no one level to be in and nothing is blurred.

The progress route carries the "All countable objects" listing's search and
filters, so a filtered listing is a link too: `q=<search>`, `kind=<kind>`,
`status=<derived status, or none, or unproved>`, `under=<id>` (objects that id
is an ancestor of, at any depth, in the collapse order), next to
`collapse=<kind>`. Typing and picking rewrite these silently and rebuild only
the table, not the page.

## On a phone

Below 900px wide the graph page keeps the whole window for the graph, and
nothing changes on a wider screen:

* the toolbar is one row (*Filters*, the highlight search, Fit, `+`, `−`);
  the collapse kind, Expand/Collapse all and the edge and status filters fold
  behind *Filters*, which carries a dot while anything is filtered out;
* the side panel is a sheet over the bottom of the graph, there only while
  something is selected. Its bar minimises it to the title and the
  *Expand/Collapse* button, or closes it, which deselects. A node tapped under
  the sheet is panned up into view;
* two fingers pinch to zoom about their midpoint and pan; one finger pans;
* a double tap on a node expands or collapses it. It is counted by the page
  (`DOUBLE_TAP_MS` in `graph.js`), since a touch browser's own `dblclick` is
  missing (iOS) or unreliable, and is ignored after a touch.

## Search

There is one matcher, `model.search`: a case-insensitive substring match over
id, title, the Lean declaration names in `attrs.lean`, and body, ranked in that
spirit (exact id or title, exact Lean name, id, title, part of a Lean name,
body; within a tier statements before edges and shorter ids first), over a
lowercase index built once per snapshot. Three places use it:

* the **search box in the top bar** (`/` focuses it from anywhere that is not
  taking text) lists the best twelve objects of the whole blueprint, leaving
  out bare sugar edges (a `uses/a/b` with no title and no prose of its own
  matches whatever `a` matches); arrows move, Enter or a click opens the
  object page, Escape closes the list;
* the graph's highlight (`q=`), which dims every node that does not match;
* the progress listing's search box, combined with its kind, status and
  "under" filters (`model.filterListing`).

### Comments

Every object page ends with a comment section, after the Stacks project's: a
name, a comment in Markdown with LaTeX maths and `[label]` references, a
preview, and the comments so far. They are kept by `comments-server.py`, which
`blueprint serve` runs instead of a plain static server when `python3` is at
hand: it serves the site and answers `GET`/`POST api/comments/<id>`, keeping
one JSON file per object under `--comments` (default `<root>/comments`). Comment
HTML is parsed in an inert document and cut down to the tags markdown produces
before it is shown. Served without that server, the section says comments are
unavailable. `blueprint site` leaves the script out of the published site. The same
server makes PDFs on demand for the Export PDF dialog (`POST api/export`,
`../docs/pdf-export.md`).

### The document's pages

The document is the reading order of DESIGN.md §6, numbered as a paper is
("Definition 1.2.14"), and split into pages along the collapse order.
`#/document` is the contents: a row per top-level entry — usually the
chapters — with its number, title and progress, each a link to that entry's
page; nothing is written out there but text at the top level (see below).
`#/document/<id>` writes out one entry and the levels below it. An entry whose
children are not on the page links on to its own page, by its number and by a
*Read 1.2 →* link beside its title. Each page has breadcrumbs up its chain, back to the
contents, its previous and next siblings, and the contents in a sidebar. A
top-level entry with nothing under it (an introduction, say) is read on its
own page too, since the contents do not write it out.

Every entry of the contents and of the sidebar leads to its *level*: the page
of its parent, which writes out the entry and its siblings and nothing below
them, scrolled to it (`?focus=`) — for a chapter, the top level written out
(`#/document?depth=1&focus=<id>`). The sidebar (`levelSidebar` in
`document.js`) lists the level the page writes out, under the chain down to
it as headings, with the entry gone to opened on its own entries. So after a
click on chapter 1 the page is 1, 2, 3, … and the sidebar is 1 with 1.1, 1.2,
… under it, then 2, 3, …; after a click on 1.1 the page is 1.1, 1.2, … and
the sidebar is the heading 1 over 1.1, with 1.1.1, 1.1.2, … under it, then
1.2, …, and no 2, 3. A heading of the chain leads to its own level the same
way, so 1 goes back to the chapters. An entry of the level on screen is only
scrolled to and opened, and the link updated, without rebuilding the page. A
page reached otherwise — by a *Read* line, the breadcrumbs, a number — lists
its own entries under its chain. The Outline style keeps its own sidebar, the
whole outline opened along the way to the page. Query parameters:

* `collapse=<kind>`: the collapse order to read along (default: the
  snapshot's `defaultCollapse`). The outline, the numbers and the pages are
  all of that order;
* `depth=<n>|all`: how many levels below the page are written out on it
  (default 1). On the top page there is no default: without `depth=` it is the
  contents, and the depth control offers *contents* besides the numbers.
  `depth=1` there writes out the chapters, `depth=2` the chapters with their
  sections, and `depth=all` is the whole document on one page;
* `focus=<id>`: scroll to that entry. If the page does not show it, the route
  is replaced by the page that does: an entry with children is read on its own
  page, any other on its parent's (or its own, at the top level), a step
  wherever its source is (`documentPageOf` in `model.js`). That is what keeps every link written
  before the split, `#/document?focus=<id>`, working.

What is in the document, the numbers and the pages are pure functions of the
snapshot (`documentOutline`, `documentPageOf`, `documentPageShows`,
`documentPageEntries` in `model.js`), tested in `test/model.test.mjs`. An
object with several parents in the order is written out under its first parent
and repeated under the others as a pointer back to it; the repetition carries
the first occurrence's number and takes none of its own, so every object has
exactly one number.

A `hidden` object with nothing under it is *text*, as the Stacks project has
it: the lines that open a section, or a paragraph between two lemmas, that
belong to no statement. It is set where its `order` puts it, as bare prose with
no heading, no kind word and no number, and takes no number from its
siblings, so the lemma after the lines that open section 2 is still 2.1.
Text at the top level is written out on the contents, between the rows. It is
not in the contents, the pager or the outline sidebar, and a `[slug]` link to
it keeps its title rather than reading "Section 2.1".

### Proofs

A proof (`DESIGN.md` §2.5) is set right after the statement it proves, as
"*Proof.* … ∎", with the steps filed under it, and has no number of its own:
a reference to it, its `?focus=` and its page are its statement's. The
statement's object page shows its proofs the same way.

A proof that lemmas refine has details of its own, and so is an entry of the
document, numbered and with a page, its details below it. The collapse order
puts it nowhere (a proof is below no statement), so it is read right after
its statement, as the statement's first entry (`detailedProofs` in
`model.js`), rather than at the top of the document. A step filed under a
step — a relation between relations — is set inside the step it starts
from.

Every proof is a `<details class="proof">` (`proofDisclosure` in `app.js`)
whose summary is its "Proof." line, so one click folds or unfolds one proof,
and *Fold proofs* / *Unfold proofs* (the document's controls line, and object
pages with a proof) does all of them; the choice is kept in `localStorage`
(`blueprint.proofs`). A blueprint not yet migrated to proof objects gets the
same: `renderBody` turns a body's `## Proof` heading and what follows it, up
to the next heading of the same level, into that disclosure.

In the graph a proof
is never drawn: it stands for its statement (`view.anchor` in `model.js`), so
the `uses` written on it are arcs of the statement — declared while the
statement is visible, derived for whatever it is collapsed into otherwise —
and it is listed under the statement's "Hidden inside".

### Themes (experimental)

A *Style* menu in the top bar switches between the candidate styles of the
site, so they can be compared on the real thing before one is chosen:
Default (`style.css` alone), Drafting, Article, Textbook, PreTeXt and Outline.
Each other style is a sheet in `themes/`, loaded after `style.css`. A sheet
lists only the rules it changes; Article and Textbook `@import` Drafting,
Outline imports PreTeXt, and the themes that use web fonts import them
themselves, so the default fetches none. A theme may also ask for a sidebar:
Outline sets `data-sidebar="outline"` on `<html>`, and the document draws the
whole outline in the sidebar, opened along the way to the page, in place of
the list of what the page writes out. `?theme=<id>` in the page's URL picks a
style for a shared link; otherwise the reader's last pick is kept in
`localStorage` (`blueprint.theme`), and a reader who has not picked one sees
the project's style, `project.theme` (`[site] theme` in `blueprint.toml`), or
else the default. The registry is `THEMES` in `app.js`.

### Hiding the progress

The site opens with everything that says how far the formalization has got
hidden, so a reader sees the mathematics alone: the status badges (and
whether a Lean declaration exists), the progress bars, the top bar's
percentage, the Progress tab, and in the graph the status colours of the
nodes, the status filter and the fills of the key. *Show progress* in the top
bar brings it all back, and *Hide progress* takes it away again. A status
filter in a graph link waits until the progress is shown. The choice is the
reader's, kept in `localStorage` (`blueprint.progress`, `shown` or `hidden`;
no choice is hidden); while it is hidden `<html>` carries
`data-progress="hidden"`, and `app.showProgress` is false for the pages.

### The intro

A project may open its site on an introduction (`[site.intro]` in
`blueprint.toml`, `project.intro` in the snapshot, see `docs/cli.md`): one
node in the middle of an empty screen, drawn as the graph draws its nodes,
with the project's Markdown in it — maths, `[slug]` references, pictures and
HTML of its own (`intro.js`). The graph is laid out behind it meanwhile. A bar
along its foot runs down its duration (default 3 s), then it shrinks and fades
into the graph; a click, Escape, Enter or Space ends it at once, and a link in
it is still followed. With `prefers-reduced-motion` it only fades.

* It is shown on the way in only: when the site is opened at its landing
  page, the bare graph (`/`, `#/graph`). A link to anything else, a graph
  with parameters included, opens straight on it, and `?intro=0` in the
  page's URL leaves it out anywhere.
* A relative address in it (`![](assets/logo.png)`, a `<video src>`) is
  resolved against the directory holding `blueprint.json`, which is where
  `blueprint site` copies the project's `[site] assets` directory, as
  `assets/`.

### Cross references

A `[slug]` in prose reads the way a paper's cross reference does: the lead
word the document sets the object under and its number, "Definition 1.2.1",
"Section 2.3" (`referenceOf` in `model.js`; the word is the kind's name,
capitalised, for every kind alike). The numbers are those of the active
collapse order: the document's `collapse=`, the graph's `collapse=`, and the
default order on the object page. The slug stays the link's tooltip.

* A click jumps to the level of what it names. In the document, and from
  object pages, the intro and preview cards, that is the document's page for
  it: its own page when it has entries below it (a section, or a statement
  with refinements), and otherwise the page it is read on, scrolled to it,
  which is the same page when it is written out there (a click scrolls). The
  object page is one click further, on the entry's title.
* In the graph's side panel and its cards it is the level of the graph the
  object is drawn at: the sections above it opened, the object itself too
  when it has contents (so the reader is in it), and the object selected; the
  rest of the view (filters, collapse order) is kept.
* When the prose already says the word, "by Lemma [lem-x]", only the number
  is added, so it does not read "Lemma Lemma 2.3".
* An object the document gives no number keeps its slug as the text: one
  that is not in the flow (a sugar edge with no prose, an object with neither
  prose nor children), or a step, which is read as part of its source. An
  object with several parents is referred to by its one number. A slug that
  resolves nowhere is a broken link exactly as before, and explicit link text,
  `[text](…)`, is markdown's and untouched.

### Export PDF

The top bar's **Export PDF** button (also on every document page, next to
its controls) opens a dialog that says what will be exported before anything
is made (`pdf.js`): *this part* — the document page's entry, or the part an
object page's object (or the graph's selection) is read in — or *the whole
blueprint*, which is the default at the top of the document, or *another
part* picked by its number and title; the hierarchy when there are several;
the detail, all levels by default or a number of levels below the part; and
whether to include appendices, when the part has any. It shows how many
entries and proofs that is, and which snapshot it comes from, a historical
one included. *Export PDF* then finds the PDF prepared for exactly that
snapshot and choice (`data/exports/<hash of the snapshot's bytes>/`, made by
`blueprint site --pdf`), or has the local server of `blueprint serve` make
it, checks that what came back is a PDF, and downloads it, with *Open in a
new tab* and the TeX source next to it. Failing that it says why — nothing
prepared, the server has no TeX, TeX failed in a named object, with its log
— and still hands out the TeX source, which the page writes itself. A second
click while one export runs does nothing; Escape closes the dialog and gives
the focus back. What is in the PDF and in what order is the document's
(`export/latex.js` reads `documentOutline`); `../docs/pdf-export.md` is the
reference.

### Previews

Resting the pointer on a link to an object — a `[slug]` reference in prose, a
title in a listing, anywhere on the site — opens a card with that object's
statement, the way a hover preview works on a wiki (`preview.js`):

* the reference as it reads here ("Theorem 2.2") and the title, the status,
  what an edge joins, the prose with its maths and its own references (a proof
  in it starts folded), the slug, and *Open →* to the object page. Not the
  Lean names: a statement formalised by many declarations would leave its
  prose no room in a card of a fixed size, so they have a card of their own
  (below);
* it opens after the pointer has rested 300 ms, so a link passed over on the
  way elsewhere opens nothing, and closes 250 ms after the pointer has left
  both the link and the card, so the pointer can cross into the card to scroll
  it or follow a link in it;
* a reference inside a card opens a card of its own, so a chain of
  references can be followed without leaving the page; moving back into an
  outer card closes the ones opened from it;
* the card goes below the link, or above it when there is more room there, and
  is never taller than that room; Escape, a click outside the cards, a scroll
  of the page and a change of route close every card, and so does following a
  link in one, once it has been followed;
* a link focused with the keyboard opens its card too. A touch has no hover,
  so on a phone a tap follows the link, as before;
* not previewed: a broken reference, an object title in a heading (the
  document writes the object out right under it) and a proof's "Proof." line.
  The link's tooltip (its slug) is held back while the pointer is on it, since
  the card says the same and the tooltip would cover it.

In the document, the heading of every object with Lean declarations carries a
small **Lean** mark after its title, with their number when there are
several ("Lean 2"). It is a link to the object page, where the declarations
are set out with their signatures; a click or a tap goes there. Resting on
it or focusing it opens a card of the same kind listing the declarations:
each name, a link to the object page too, with its kind and status from the
Lean facts and, when the snapshot has a `project.docgen`, *docs ↗* to its
doc-gen4 page.

It is one set of listeners on the document, so it covers every page without
the pages knowing about it.

## Files

| file | contents |
|------|----------|
| `index.html` | the shell: the early request for the snapshot, CDN tags, module preloads, top bar (with the search box), banner, `#app` mount point |
| `style.css` | everything visual, light and dark via `prefers-color-scheme` |
| `model.js` | **pure** logic: indexing, collapse orders, views, the quotient, consistency states, the document outline and its pages, progress, search, the progress listing's filters. No DOM, no fetch |
| `app.js` | data loading, hash router, the top bar's search box, and the DOM helpers handed to the pages in the `app` context object |
| `graph.js` | ELK compound layout plus hand-written SVG rendering, pan/zoom, filters, side panel |
| `object.js` | the object page |
| `document.js` | the linear document, one page per entry of the collapse order |
| `progress.js` | the dashboard, the hand-drawn SVG line chart, the time slider, and the searchable, filterable listing of every countable object |
| `checks.js` | the lint report |
| `intro.js` | the project's intro, shown over the landing page while the graph is laid out under it |
| `preview.js` | the card a link to an object opens while the pointer rests on it, and the document's Lean mark and its card |
| `pdf.js` | the Export PDF button and dialog: the part, the detail, finding or making the PDF, the TeX source |
| `export/latex.js` | **pure**: a part of the document as a LaTeX document — the request, the plan (order, shared objects, depth), the TeX. Imported by the dialog and by the command line |
| `export/markdown-tex.js`, `export/unicode.js` | **pure**: a body's Markdown and maths as LaTeX; the characters pdfLaTeX is told about |
| `export/sha256.js` | SHA-256, where the browser has no `crypto.subtle`; the name of a snapshot's export directory |
| `export/cli.mjs`, `export/store.mjs`, `export/compile.mjs`, `export/zip.mjs` | node only: the command line, the `data/exports` store, TeX in a sandbox, the source archive |
| `comments-server.py` | the local server `blueprint serve` runs: the site plus the comments API (not copied into the site) |
| `sample/blueprint.json` | a hand-written snapshot exercising every feature |
| `sample/data/` | four fake historical snapshots and their index |
| `sample/paper/blueprint.json` | the snapshot of `examples/paper`, the PDF export's fixture, regenerated with `lake exe blueprint build --root examples/paper -o web/sample/paper/blueprint.json` and checked by `./test.sh` |
| `test/dom-shim.mjs` | a minimal DOM, so the page modules can run under node |
| `test/gen-large.mjs` | generates a synthetic snapshot the size of a real project |
| `test/bench.mjs` | the performance harness (indexing, quotient, ELK, pages) |
| `sample/real/blueprint.json` | a snapshot produced by the Lean tool itself, kept as a second fixture, regenerated with `lake exe blueprint build --root examples/induction --facts examples/induction/lean-facts.json -o web/sample/real/blueprint.json` and checked by `./test.sh` |
| `test/browser/` | the pre-deploy sweep: the whole site driven in real headless Firefox and Chromium (`test/browser/README.md`) |
| `test/model.test.mjs` | unit tests for `model.js` |
| `test/app.test.mjs` | tests for the parts that need a DOM: KaTeX options, the document pages and their lazy rendering, the ELK worker and its fallbacks, the progress filters, the top bar's search, the link previews, the Export PDF dialog and the intro |
| `test/export.test.mjs` | the PDF export without TeX: selection, order, numbers, depth, shared objects, proofs, text, appendices, references, maths, escaping, images, the store and the command line's errors |
| `test/export-compile.test.mjs` | the PDF export with TeX (skipped without pdflatex): real PDFs read back, TeX errors, the sandbox, the time limit |

Both samples can be opened directly:

```
http://localhost:8000/?data=./sample/blueprint.json    # with history slider
http://localhost:8000/?data=./sample/real/blueprint.json
```

Page modules never import each other; they import `model.js` for logic and
receive everything DOM-shaped through the `app` object, so the dependency graph
stays a tree.

## Pinned dependencies

| library | version | source |
|---------|---------|--------|
| KaTeX (css, js, auto-render) | 0.16.11 | cdnjs |
| marked | 12.0.2 | cdnjs |
| elkjs (`elk-api.js` on the page, `elk-worker.min.js` in the worker, `elk.bundled.js` only for the fallback) | 0.9.3 | jsDelivr — elkjs is not published on cdnjs |

KaTeX and marked are tags in `index.html`; elkjs is not, since only the graph
needs it: `graph.js` adds its tags itself when the graph is first shown (the
pin and the hashes are `ELK_CDN`, `ELK_API` and `ELK_BUNDLE` there). Each tag
carries an `integrity` hash. The worker half is not a tag: it is fetched by
`importScripts` from the same pinned directory (see below), so it carries no
SRI hash.

### How layout runs

elkjs ships as two halves that talk to each other over one fixed protocol
(`{id, cmd: 'register' | 'layout', …}` out, `{id, data}` or `{id, error}`
back): `elk-api`, the `ELK` class on the page, and `elk-worker.min.js`, the
layouter itself, which claims `self.onmessage` for that protocol as soon as it
is loaded in a worker. `elk-api.js` is the page half alone, 9 kB, and is
what the page loads; `elk.bundled.js` is both halves in one file, 1.6 MB, and
is fetched only when the layout has to run on the main thread.

`graph.js` pairs them the way elkjs intends:

* the worker's whole program is `importScripts("…/elk-worker.min.js")`, from
  the same pinned directory as the page half, built into a `Blob`, so the
  deployment stays a directory of static files: no worker script to serve,
  still no build step;
* the page lays out with
  `new ELK({ workerFactory: () => new Worker(blobUrl) })`, so elkjs's own
  protocol runs on both sides.

Layout of a few thousand nodes therefore happens *beside* the page rather than
freezing it. The site is served plainly (nginx, GitHub Pages: no
`Content-Security-Policy` anywhere in this repository or added by those
servers), so `blob:` workers and a cross-origin `importScripts` are both
allowed.

What must **not** be done — and was, until it hung a real browser — is to load
`elk.bundled.js` inside the worker and run a protocol of one's own on top of
it. In a worker context (no `document`, a `self`) the bundle's worker half
takes `self.onmessage` for elkjs's protocol and exports no in-thread worker, so
`new ELK()` *inside* the worker throws and every message in any other protocol
is dropped without an answer: the page waits for ever.

Every way this can still go wrong ends on the main thread, in
`elk.bundled.js`'s in-thread mode (`new ELK()` with no worker at all), fetched
then, with a yield to the event loop around it so the status line is painted
first:

* `Worker`, `Blob` or `URL.createObjectURL` missing, or construction refused by
  a CSP that forbids `blob:` workers or the cross-origin `importScripts`;
* the worker raising an `error` event;
* the layout promise rejecting;
* a watchdog: no answer within 4 s plus 2 ms per node and edge, after which the
  worker is terminated and never used again. The fixed part can be overridden
  with `window.BLUEPRINT_LAYOUT_DEADLINE_MS`, which is how the tests avoid
  waiting for it.

A failure anywhere on that path — in the layouter, or in the drawing that
follows a successful layout — replaces "laying out N nodes…" with a red line in
the graph pane saying what happened, and leaves the page able to try again.

## Maths

Bodies are rendered with KaTeX auto-render, with `$…$`/`$$…$$` *and*
`\(…\)`/`\[…\]` as delimiters. Project-wide macros come from the snapshot:

```jsonc
"project": { "katexMacros": { "\\Fbar": "\\overline{\\mathbf F}_q",
                              "\\cover": "\\mathcal{#1}" } }
```

They are passed to every auto-render call on the site — object pages, the
document, the graph's side panel — by `app.katexOptions()`, which is the single
place those options are built. `throwOnError` is off, so a formula KaTeX cannot
parse is left as red source text and the rest of the page renders normally.

If a CDN is unreachable the app degrades rather than dies: without marked the
prose is shown as preformatted text, without KaTeX the maths is left as source,
and without elkjs the graph page explains that it needs it while the other
pages keep working.

## Tests

```sh
nix-shell -p nodejs_22 --run "node test/model.test.mjs"   # pure logic
nix-shell -p nodejs_22 --run "node test/app.test.mjs"     # the pages, in a DOM shim
nix-shell -p nodejs_22 --run "node test/export.test.mjs"  # the PDF export's TeX
nix-shell -p nodejs_22 texliveMedium poppler-utils --run "node test/export-compile.test.mjs"
```

`model.js` is deliberately free of DOM references so the whole of DESIGN.md §3
— collapse orders, upward-closed views, `rep`, the display rule, junctions and
the declared/derived/both table — is testable in node without a browser. It
also covers the caches: views and quotients are memoised, and the tests check
that expanding and collapsing never hands back an answer computed for a
different expanded set.

`app.test.mjs` runs the real page modules against `test/dom-shim.mjs`, with
marked, KaTeX and ELK replaced by stand-ins that record what they were asked to
do. It is what checks the KaTeX options, that the document view renders lazily,
and that the graph really drives a Blob worker that loads elk-worker.min.js —
with a `bp`-free graph, over elkjs's protocol — and that every way that can
fail (workers blocked, the worker silent, the layout rejected, the drawing
throwing) ends in a drawn graph or a visible error rather than a page stuck on
"laying out…".

Given a copy of elkjs it also runs the real `elk-worker.min.js` in a node
worker thread behind a small `self`/`importScripts` shim and drives it with the
real `ELK` class from `elk.bundled.js`, which is the check that the two halves
are paired correctly — the stand-ins cannot show that:

```sh
curl -sLo /tmp/elk.bundled.js    https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js
curl -sLo /tmp/elk-worker.min.js https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk-worker.min.js
nix-shell -p nodejs_22 --run "node test/app.test.mjs --elk=/tmp/elk.bundled.js"
```

Without `--elk` (or `BLUEPRINT_ELK`) that one check is skipped and says so.

### In real browsers

Neither of those can fail on a legend that has covered the graph, a `hidden`
element that still takes 15px, or a click that pointer capture swallowed: a DOM
shim has no layout, no cascade and no input. `test/browser/sweep.mjs` drives the
deployed site in headless Firefox (geckodriver) and Chromium (DevTools
protocol) with real pointer, keyboard and wheel events and asserts against the
DOM the browser built, one `PASS`/`FAIL` line with its evidence per check.
**Run it before every deploy**; see `test/browser/README.md`.

```sh
nix-shell -p python3 --run "python3 -m http.server 8765 --directory _site" &
nix-shell -p firefox geckodriver chromium nodejs_22 \
  --run "node test/browser/sweep.mjs --browser=firefox,chromium"
```

## Performance

A real blueprint is a few thousand objects. `test/gen-large.mjs` generates a
deterministic snapshot of that shape (~3,300 nodes in a three-level hierarchy,
~3,300 `refines` edges, ~1,500 `uses` edges) and `test/bench.mjs` measures the
whole pipeline against it:

```sh
curl -sLo /tmp/elk.bundled.js https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js
nix-shell -p nodejs_22 --run "node test/bench.mjs --elk=/tmp/elk.bundled.js"
```

Without `--elk` (or `BLUEPRINT_ELK`) the layout rows are skipped and the rest
still runs; `BLUEPRINT_BENCH_FULL=1` adds the fully expanded layout, which
takes a couple of seconds.

The shape the pages are built for:

* the graph's default view is the fully collapsed one — the top of the
  hierarchy, tens of nodes. Everything below it arrives as the reader expands
  into it, and only "Expand all" (which says how many objects that is) puts
  thousands of nodes on screen;
* the document is split into pages, so a page is one level of the hierarchy
  rather than the whole project; and a page that is still large (a section
  with hundreds of statements, or `depth=all`) appends its headings a chunk
  per frame and renders a section's prose when it scrolls into view, so
  opening it costs a screenful;
* `quotient`, `rep` and the incidence lookups are linear, with the ancestor
  chains precomputed once per collapse kind and views and quotients memoised;
* search works off a lowercase index built once per snapshot, so a query is
  one pass over it (a few milliseconds on a real blueprint, edges included),
  and every search box waits for a pause in the typing before it asks;
* the progress listing sorts the countable objects once per snapshot, and a
  filter change rebuilds only its table, at most 300 rows of it until "Show
  all" is pressed.
