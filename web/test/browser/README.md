# The browser sweep

`sweep.mjs` drives the deployed site in **real headless browsers** — Firefox
through geckodriver's WebDriver API, Chromium through the DevTools protocol —
with real pointer, keyboard and wheel input, and asserts against the DOM the
browser actually built.

It exists because `../app.test.mjs` cannot fail on the bugs that matter most.
A DOM shim has no layout, so it cannot see a legend that has grown to twice its
height and covered the graph; no CSS cascade, so it cannot see a `hidden`
element that still takes 15px; no pointer capture, so it cannot see a click that
never reaches a node. Every one of those shipped with `app.test.mjs` green.
**Nothing counts as verified unless a real browser shows it**, so run this
before every deploy.

## Running it

Both browsers, against a site served at `http://127.0.0.1:8765`:

```sh
nix-shell -p firefox geckodriver chromium nodejs_22 \
  --run "node web/test/browser/sweep.mjs --browser=firefox,chromium"
```

The script starts and stops `geckodriver` and `chromium` itself; they only have
to be on `PATH`, which is what the `nix-shell -p` above is for. Screenshots and
a machine-readable `sweep-results.json` land in `--shots` (default `/tmp/shots`).
The exit status is non-zero if any check failed, so it drops straight into CI.

You need a site to point it at. Any static server over the assembled site
directory will do:

```sh
lake exe blueprint site --root <project> -o _site
nix-shell -p python3 --run "python3 -m http.server 8765 --directory _site"
```

While working on `web/`, copy the changed files into whatever directory is being
served and re-run; the drivers disable the HTTP cache, so there is no stale-CSS
trap.

### Options

| flag | default | meaning |
|------|---------|---------|
| `--origin=<url>` | `http://127.0.0.1:8765` | the site to drive |
| `--browser=firefox,chromium` | `firefox` | which browsers to run |
| `--sections=graph,layout,…` | all | which groups of checks to run |
| `--only=<substring>` | — | run only checks whose id contains this |
| `--shots=<dir>` | `/tmp/shots` | screenshots and `sweep-results.json` |
| `--width` / `--height` | `1400` / `900` | the viewport, exactly |
| `--no-launch` | — | attach to a geckodriver/Chromium you started yourself |
| `--verbose` | — | list the skipped checks in the summary |

`--sections` and `--only` together are what make an A/B of one fix quick:

```sh
# the fix in place
node sweep.mjs --browser=firefox,chromium --sections=layout
# the previous file back
git show HEAD~1:web/style.css > _site/style.css
node sweep.mjs --browser=firefox,chromium --sections=layout
```

## What it checks

Each check prints `PASS` / `FAIL` / `SKIP` with the DOM evidence it decided on,
so a failure is readable without re-running anything.

| section | checks |
|---------|--------|
| `boot` | the snapshot loads, the project title reaches the chrome, and KaTeX, auto-render, marked and ELK all arrived from their CDNs |
| `graph` | initial layout; click selects and fills the side panel; double-click expands and collapses again; Enter and Space on a focused node; the side panel's *Expand/Collapse (n children)* button; Expand all and Collapse all; the collapse-kind select; every edge-kind and every status checkbox, off and on again; search highlighting; Fit, `+`, `−`; wheel zoom; drag to pan; clicking empty stage to deselect; reloading a URL carrying `sel=` and `expand=`; the *Open object page* link; the legend not covering a node |
| `layout` | the shell geometry: legend sample icons stay 24×10, a `hidden` banner takes no space, the graph still fits when the snapshot banner *is* there, and no route overflows horizontally |
| `object` | a theorem with Lean facts, a definition without, a section, a sugar edge whose id contains slashes, an object with two parents, a body with KaTeX, and a `[slug]` link that is clicked; on every one of them, that **every** `#/object/…` link on the page names an id that exists and that no "unknown object" placeholder names one that does |
| `document` | initial render; scrolling to the bottom in steps while the bodies render lazily; headings at the bottom; how much maths rendered and what leftover `$…$` there is; heading sizes down the hierarchy; a contents link scrolling to its heading; `?focus=` |
| `progress` | both tables; the time slider and the chart; picking a snapshot (banner appears); *Back to current*; *Show all* |
| `checks` | the card count against the model, the level filter, the code filter, object links, and that every "unknown object" chip really is unknown |
| `nav` | the four top-bar tabs, browser back/forward, the scroll position resetting when the page changes but not when only the query does, and an unknown route falling back to the graph |
| `sample` | junction (hyperedge) nodes — hover and click — and an object with two parents, driven against `?data=./sample/blueprint.json`, because a real project's snapshot usually has neither |

The fixtures — which theorem, which definition, which slug — are **derived from
the snapshot that is actually served** by importing `../../model.js` in node, so
the sweep is not tied to one project's data. Anything a snapshot does not
contain is reported as `SKIP` with the reason rather than silently passing.

## What a failure means, and what it does not

* `console/<section>` fails on any `console.error`, uncaught exception,
  unhandled rejection, failed resource or non-favicon failed request.
* Warnings about the *snapshot's own* maths — KaTeX parse errors from the
  project's macros, and KaTeX's strict-mode complaints about Unicode in math
  mode — are counted and quoted in the evidence but do **not** fail: no change
  under `web/` can fix them. `document/katex-renders` fails only if the site
  rendered no maths at all or left `$…$` on screen.

## Known limits

* **The first moments of a page load are only covered in Chromium.** The
  recorder that collects `console.error` and friends is injected after the
  document has loaded, so in Firefox an exception thrown while `app.js` boots is
  missed. `boot/loads-the-snapshot` covers the outcome (data loaded, libraries
  present, no error box) instead. In Chromium the driver also reads the
  DevTools console and network events, which are armed before the first byte.
* **`<select>` elements are changed by assigning `value` and dispatching
  `change`**, not by real input: a native dropdown in a headless browser is not
  something WebDriver can drive portably. Every other control in the suite gets
  real events.
* The suite navigates once per browser and then drives the SPA through its hash
  router — which is how a reader uses it — reloading only where a check is
  explicitly about a reload.
