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
| `#/document` | linear reading order |
| `#/progress` | dashboard and time slider |
| `#/checks` | `derived.checks` |

The graph route carries its full view state as query parameters:
`collapse=<kind>`, `expand=<comma separated ids>`, `ekinds=<edge kinds>`,
`status=<derived statuses>`, `q=<search>`, `sel=<selected id>`.

## Files

| file | contents |
|------|----------|
| `index.html` | the shell: CDN tags, top bar, banner, `#app` mount point |
| `style.css` | everything visual, light and dark via `prefers-color-scheme` |
| `model.js` | **pure** logic: indexing, collapse orders, views, the quotient, consistency states, progress, search. No DOM, no fetch |
| `app.js` | data loading, hash router, and the DOM helpers handed to the pages in the `app` context object |
| `graph.js` | ELK compound layout plus hand-written SVG rendering, pan/zoom, filters, side panel |
| `object.js` | the object page |
| `document.js` | the linear document |
| `progress.js` | the dashboard, the hand-drawn SVG line chart and the time slider |
| `checks.js` | the lint report |
| `sample/blueprint.json` | a hand-written snapshot exercising every feature |
| `sample/data/` | four fake historical snapshots and their index |
| `test/dom-shim.mjs` | a minimal DOM, so the page modules can run under node |
| `test/gen-large.mjs` | generates a synthetic snapshot the size of a real project |
| `test/bench.mjs` | the performance harness (indexing, quotient, ELK, pages) |
| `sample/real/blueprint.json` | a snapshot produced by the Lean tool itself, kept as a second fixture, regenerated with `lake exe blueprint build --root examples/induction --facts examples/induction/lean-facts.json -o web/sample/real/blueprint.json` and checked by `./test.sh` |
| `test/model.test.mjs` | unit tests for `model.js` |
| `test/app.test.mjs` | tests for the parts that need a DOM: KaTeX options, lazy document rendering, the ELK worker |

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
| elkjs (`elk.bundled.js`) | 0.9.3 | jsDelivr — elkjs is not published on cdnjs |

Each tag carries an `integrity` hash.

`elk.bundled.js` is loaded by `index.html` but the graph does not normally run
it on the main thread: `graph.js` builds a Web Worker out of a `Blob` whose
whole program is "`importScripts` that same pinned URL, then lay out what you
are sent". Layout of a few thousand nodes therefore takes seconds *beside* the
page rather than freezing it, and the deployment stays a directory of static
files — there is no worker script to serve and still no build step. The site is
served plainly (nginx, GitHub Pages: no `Content-Security-Policy` anywhere in
this repository or added by those servers), so `blob:` workers and a
cross-origin `importScripts` are both allowed. Behind a CSP that forbids
either, worker creation throws, and the layout falls back to the main thread
with a yield to the event loop around it so the status line is painted first.

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
and that the graph really posts a `bp`-free graph to a Blob worker and falls
back when workers are blocked.

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
* the document view appends its headings a chunk per frame and renders a
  section's prose when it scrolls into view, so opening it costs a screenful
  rather than the whole project;
* `quotient`, `rep` and the incidence lookups are linear, with the ancestor
  chains precomputed once per collapse kind and views and quotients memoised;
* search works off a lowercase index built once per snapshot.
