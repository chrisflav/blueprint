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

## Routes

All state lives in the URL hash, so every view is a shareable link.

| route | page |
|-------|------|
| `#/graph` | the quotient graph |
| `#/object/<id>` | one object (the id is percent-encoded) |
| `#/document` | the top of the linear document |
| `#/document/<id>` | the page of one entry of the document |
| `#/progress` | dashboard and time slider |
| `#/checks` | `derived.checks` |

The graph route carries its full view state as query parameters:
`collapse=<kind>`, `expand=<comma separated ids>`, `ekinds=<edge kinds>`,
`status=<derived statuses>`, `q=<search>`, `sel=<selected id>`, and
`reduce=0` when *hide implied* is off.

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

The progress route carries the "All countable objects" listing's search and
filters, so a filtered listing is a link too: `q=<search>`, `kind=<kind>`,
`status=<derived status, or none, or unproved>`, `under=<id>` (objects that id
is an ancestor of, at any depth, in the collapse order), next to
`collapse=<kind>`. Typing and picking rewrite these silently and rebuild only
the table, not the page.

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

The document page has a search box of its own at the head of its left column,
over the statements, sections and steps of the document only: results read by
their numbers in the active order ("Lemma 1.18.2 Closed image…") with the
matching Lean name, and lead to where the entry is written out (scrolling there
on the same page, opening its page otherwise). The query is kept from page to
page.

### Proofs

`renderBody` turns a body's `## Proof` heading and what follows it, up to the
next heading of the same level, into a `<details class="proof">` whose summary
is the heading, so one click folds or unfolds one proof. *Fold proofs* /
*Unfold proofs* (the document's controls line, and object pages with a proof)
does all of them, and the choice is kept in `localStorage`
(`blueprint.proofs`).

### Comments

Every object page ends with a comment section, after the Stacks project's: a
name, a comment in Markdown with LaTeX maths and `[label]` references, a
preview, and the comments so far. They are kept by `comments-server.py`, which
`blueprint serve` runs instead of a plain static server when `python3` is at
hand: it serves the site and answers `GET`/`POST api/comments/<id>`, keeping
one JSON file per object under `--comments` (default `<root>/comments`). Comment
HTML is parsed in an inert document and cut down to the tags markdown produces
before it is shown. Served without that server, the section says comments are
unavailable. `blueprint site` leaves the script out of the published site.

### The document's pages

The document is the reading order of DESIGN.md §6, numbered as a paper is
("Definition 1.2.14"), and split into pages along the collapse order.
`#/document` writes out the top level — usually the chapters, each with its
own prose — and `#/document/<id>` writes out one entry and the levels below
it. An entry whose children are not on the page links on to its own page, by
its number and by a *Read 1.2 →* line. Each page has breadcrumbs up its chain,
its previous and next siblings, and a contents list of what it shows. Query
parameters:

* `collapse=<kind>`: the collapse order to read along (default: the
  snapshot's `defaultCollapse`). The outline, the numbers and the pages are
  all of that order;
* `depth=<n>|all`: how many levels below the page are written out on it
  (default 1). `depth=2` on the top page is the chapters with their sections;
  `depth=all` is the whole document on one page;
* `focus=<id>`: scroll to that entry. If the page does not show it, the route
  is replaced by the page that does: an entry with children is read on its own
  page, any other on its parent's, a step wherever its source is
  (`documentPageOf` in `model.js`). That is what keeps every link written
  before the split, `#/document?focus=<id>`, working.

What is in the document, the numbers and the pages are pure functions of the
snapshot (`documentOutline`, `documentPageOf`, `documentPageShows`,
`documentPageEntries` in `model.js`), tested in `test/model.test.mjs`. An
object with several parents in the order is written out under its first parent
and repeated under the others as a pointer back to it; the repetition carries
the first occurrence's number and takes none of its own, so every object has
exactly one number.

### Cross references

A `[slug]` in prose reads the way a paper's cross reference does: the lead
word the document sets the object under and its number, "Definition 1.2.1",
"Section 2.3" (`referenceOf` in `model.js`; the word is the kind's name,
capitalised, for every kind alike). The numbers are those of the active
collapse order: the document's `collapse=`, the graph's `collapse=`, and the
default order on the object page. The slug stays the link's tooltip.

* In the document the reference stays in the paper: it links to where the
  object is written out, on the same page (a click scrolls there) or on the
  page it is read on, scrolled to it. The object page is one click further,
  on the entry's title.
* Everywhere else (object pages, the graph's side panel) it links to the
  object page, as before; only the text changed.
* When the prose already says the word, "by Lemma [lem-x]", only the number
  is added, so it does not read "Lemma Lemma 2.3".
* An object the document gives no number keeps its slug as the text: one
  that is not in the flow (a sugar edge with no prose, an object with neither
  prose nor children), or a step, which is read as part of its source. An
  object with several parents is referred to by its one number. A slug that
  resolves nowhere is a broken link exactly as before, and explicit link text,
  `[text](…)`, is markdown's and untouched.

## Files

| file | contents |
|------|----------|
| `index.html` | the shell: CDN tags, top bar (with the search box), banner, `#app` mount point |
| `style.css` | everything visual, light and dark via `prefers-color-scheme` |
| `model.js` | **pure** logic: indexing, collapse orders, views, the quotient, consistency states, the document outline and its pages, progress, search, the progress listing's filters. No DOM, no fetch |
| `app.js` | data loading, hash router, the top bar's search box, and the DOM helpers handed to the pages in the `app` context object |
| `graph.js` | ELK compound layout plus hand-written SVG rendering, pan/zoom, filters, side panel |
| `object.js` | the object page |
| `document.js` | the linear document, one page per entry of the collapse order |
| `progress.js` | the dashboard, the hand-drawn SVG line chart, the time slider, and the searchable, filterable listing of every countable object |
| `checks.js` | the lint report |
| `comments-server.py` | the local server `blueprint serve` runs: the site plus the comments API (not copied into the site) |
| `sample/blueprint.json` | a hand-written snapshot exercising every feature |
| `sample/data/` | four fake historical snapshots and their index |
| `test/dom-shim.mjs` | a minimal DOM, so the page modules can run under node |
| `test/gen-large.mjs` | generates a synthetic snapshot the size of a real project |
| `test/bench.mjs` | the performance harness (indexing, quotient, ELK, pages) |
| `sample/real/blueprint.json` | a snapshot produced by the Lean tool itself, kept as a second fixture, regenerated with `lake exe blueprint build --root examples/induction --facts examples/induction/lean-facts.json -o web/sample/real/blueprint.json` and checked by `./test.sh` |
| `test/browser/` | the pre-deploy sweep: the whole site driven in real headless Firefox and Chromium (`test/browser/README.md`) |
| `test/model.test.mjs` | unit tests for `model.js` |
| `test/app.test.mjs` | tests for the parts that need a DOM: KaTeX options, the document pages and their lazy rendering, the ELK worker and its fallbacks, the progress filters and the top bar's search |

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
| elkjs (`elk.bundled.js`, and `elk-worker.min.js` in the worker) | 0.9.3 | jsDelivr — elkjs is not published on cdnjs |

Each tag carries an `integrity` hash.  The worker half is not a tag: it is
fetched by `importScripts` from the same pinned directory as the bundle (see
below), so it carries no SRI hash.

### How layout runs

elkjs ships as two halves that talk to each other over one fixed protocol
(`{id, cmd: 'register' | 'layout', …}` out, `{id, data}` or `{id, error}`
back): `elk-api`, the `ELK` class on the page, and `elk-worker.min.js`, the
layouter itself, which claims `self.onmessage` for that protocol as soon as it
is loaded in a worker. `elk.bundled.js` is both halves in one file; that is
what `index.html` loads, and its tag is the only place the version is written
down.

`graph.js` pairs them the way elkjs intends:

* the worker's whole program is `importScripts("…/elk-worker.min.js")` — the
  URL derived from the `elk.bundled.js` tag by swapping the file name, so the
  pin stays in one place — built into a `Blob`, so the deployment stays a
  directory of static files: no worker script to serve, still no build step;
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
`elk.bundled.js`'s in-thread mode (`new ELK()` with no worker at all), with a
yield to the event loop around it so the status line is painted first:

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
