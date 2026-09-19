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
| `sample/real/blueprint.json` | a snapshot produced by the Lean tool itself, kept as a second fixture, regenerated with `lake exe blueprint build --root examples/induction --facts examples/induction/lean-facts.json -o web/sample/real/blueprint.json` and checked by `./test.sh` |
| `test/model.test.mjs` | unit tests for `model.js` |

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

Each tag carries an `integrity` hash. `elk.bundled.js` runs on the main thread
(it ships its own worker shim), which keeps the deployment to plain files.

If a CDN is unreachable the app degrades rather than dies: without marked the
prose is shown as preformatted text, without KaTeX the maths is left as source,
and without elkjs the graph page explains that it needs it while the other
pages keep working.

## Tests

```sh
nix-shell -p nodejs_22 --run "node test/model.test.mjs"
```

`model.js` is deliberately free of DOM references so the whole of DESIGN.md §3
— collapse orders, upward-closed views, `rep`, the display rule, junctions and
the declared/derived/both table — is testable in node without a browser.
