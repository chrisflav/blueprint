# Snapshot format (`blueprint.json`) and Lean facts (`lean-facts.json`)

This is the contract between the Lean core (`blueprint build`), the Lean
extractor (`blueprint extract`), and the website under `web/`. Change it only
by editing this file first. Version 1.

## blueprint.json

```jsonc
{
  "version": 1,
  "generated": "2026-09-19T12:00:00Z",         // ISO 8601, optional
  "project": {
    "name": "MyProject",
    "title": "My Project blueprint",
    "dir": "blueprint",                          // where the Markdown lives
    "katexMacros": {                             // optional, see below
      "\\Fq": "\\mathbf F_q",
      "\\Spec": "\\operatorname{Spec}",
      "\\poly": "#1[T]"
    }
  },

  "schema": {
    "kinds": {
      "theorem": {
        "boundary": {},                          // role -> cardinality
        "kinds": {},                             // role -> allowed kinds ([] = any)
        "attrs": ["title", "lean", "review", "tags", "order", "aliases"],
        "constraints": [],                       // "acyclic" | "unique"
        "collapse": false,                       // may drive views
        "countable": true,                       // counts toward progress
        "sugar": false,                          // usable as front-matter key
        "color": "#4a7"                          // optional display hint
      },
      "uses": {
        "boundary": { "src": { "min": 1, "max": 1 }, "tgt": { "min": 1, "max": 1 } },
        "kinds": { "src": [], "tgt": ["theorem", "definition", "lemma"] },
        "attrs": ["title"],
        "constraints": [],
        "collapse": false, "countable": false, "sugar": true
      },
      "refines": { "boundary": { "src": {"min":1,"max":1}, "tgt": {"min":1,"max":1} },
                   "kinds": {}, "attrs": ["title"], "constraints": ["acyclic"],
                   "collapse": true, "countable": false, "sugar": true },
      "commutes": { "boundary": { "edges": { "min": 2, "max": null } }, ... }
    },
    "defaultCollapse": "refines"
  },

  "objects": [
    {
      "id": "key-prop",                          // slug, unique
      "kind": "theorem",
      "boundary": [ { "role": "src", "id": "main-theorem" } ],   // ordered; [] for nodes
      "attrs": {                                 // only keys the kind permits
        "title": "Key proposition",
        "lean": ["MyProject.keyProp"],
        "review": "ready",
        "tags": ["chapter1"],
        "order": 3,
        "aliases": ["old-key-prop"]
      },
      "body": "Let $X$ be compact. Then ...",   // markdown, may be ""
      "source": { "file": "blueprint/ch1/key-prop.md", "anonymous": false },
      "depth": 0                                 // 0 = node, 1 + max depth of boundary
    }
  ],

  "facts": null | { ...contents of lean-facts.json "decls"... },

  "derived": {
    "status": { "key-prop": "proved" },          // absent|missing|stated|proved|proved_with_axioms
    "progress": {                                // per collapse kind, per object
      "refines": { "sec-1": { "proved": 3, "total": 7 } }
    },
    "checks": [
      { "level": "error", "code": "missing-ref", "message": "...", "objects": ["key-prop"] }
    ]
  }
}
```

Notes

- `project.katexMacros` is the `[katex.macros]` table of `blueprint.toml`
  (`docs/cli.md`): a macro name, backslash included, to the definition KaTeX
  is to use for it, with `#1`, `#2`, … as the parameters.  The website passes
  it to KaTeX as its `macros` option; nothing in the core ever expands a
  macro.  The key is left out entirely when the project declares no macros,
  so a reader must treat it as optional and default it to `{}`.
  `blueprint import-latex` fills the table from the `\newcommand`s,
  `\renewcommand`s, `\providecommand`s and `\DeclareMathOperator`s of a
  LaTeX blueprint.
- `boundary` entries are ordered as written; roles may repeat.
- `depth` is precomputed. Well-foundedness is guaranteed for a snapshot that
  `build` emitted without errors.
- `attrs` values are strings, numbers, booleans, or arrays of strings.
- Sugar-created objects have `source.anonymous = true` and `source.file` set
  to the file that created them. Their `body` is `""`.
- `facts` is `null` when no `lean-facts.json` was available.
- `derived.status` has an entry for every object whose kind permits `lean`.
- Check codes (levels in brackets):
  `unknown-kind` [error], `unknown-attr` [error], `bad-boundary` [error],
  `boundary-cycle` [error], `dangling-ref` [error], `constraint-acyclic` [error],
  `constraint-unique` [error], `duplicate-id` [error],
  `missing-lean` [error, only with facts], `status-regression` [error, diff only],
  `multi-parent` [warning], `undeclared-edge` [info], `unwitnessed-edge` [info],
  `declared-not-actual` [info], `actual-not-declared` [warning], `bad-link` [warning].

## lean-facts.json

```jsonc
{
  "version": 1,
  "modules": ["MyProject", "MyProject.Basic"],
  "attrMap": { "MyProject.keyProp": "key-prop" },      // from @[blueprint id]
  "decls": {
    "MyProject.keyProp": {
      "exists": true,
      "kind": "theorem",                     // theorem|definition|axiom|inductive|structure|instance|opaque|other
      "signature": "theorem MyProject.keyProp (X : Type) [CompactSpace X] : ...",
      "module": "MyProject.Basic",
      "range": { "file": "MyProject/Basic.lean", "startLine": 12, "endLine": 20 },
      "doc": "docstring or null",
      "status": "proved",                    // stated|proved|proved_with_axioms
      "axioms": ["propext", "Classical.choice", "Quot.sound"],
      "deps": ["MyProject.compactness"]      // mapped constants reachable, stopping at mapped ones
    },
    "MyProject.missing": { "exists": false }
  }
}
```

The set of names in `decls` is the union of names referenced by `lean`
attributes in the text and names carrying the `@[blueprint]` attribute. The
extractor learns the text-side names from a `blueprint.json` built without
facts (`blueprint build` then `blueprint extract`), or from `--names`.

## diff.json

What `blueprint diff --json` prints.  The two sides are matched by id and
then by `aliases`, so a rename appears as a rename rather than as an addition
and a removal; everything else is reported about the *matched* object under
its new id.

```jsonc
{
  "version": 1,

  "before": {                            // and "after", the same shape
    "ref": "HEAD~2",                     // what the command line said
    "kind": "rev",                       // "rev" | "file"
    "sha": "b636bbc1…",                  // null for a file
    "objects": 29,
    "facts": true,                       // does this side carry Lean facts?
    "summary": { "proved": 2, "total": 6, "byStatus": { "proved": 2, … } }
  },

  "added":    [ { "id": "brand-new", "kind": "theorem" } ],
  "removed":  [ { "id": "inductive-step", "kind": "lemma" } ],
  "renamed":  [ { "from": "base-case", "to": "first-step" } ],

  "kindChanged":     [ { "id": "x", "from": "lemma", "to": "theorem" } ],
  "boundaryChanged": [ { "id": "uses/a/b",
                         "from": [ { "role": "src", "id": "a" } ],
                         "to":   [ { "role": "src", "id": "a2" } ] } ],
  "bodyChanged":     [ "key-prop" ],     // ids only
  "attrsChanged":    [ { "id": "key-prop", "key": "title",
                         "from": "Key proposition",   // null when unset
                         "to": "Key proposition, sharpened" } ],
  "statusChanged":   [ { "id": "key-prop", "from": "proved", "to": "stated",
                         "regression": true } ],

  "checks": [ { "level": "error", "code": "status-regression",
                "message": "'key-prop' went from proved to stated",
                "objects": ["key-prop"] } ],

  "summary": {
    "added": 1, "removed": 1, "renamed": 1,
    "kindChanged": 0, "boundaryChanged": 0, "bodyChanged": 1,
    "attrsChanged": 1,                   // counted per (object, key)
    "statusChanged": 1, "regressions": 1,
    "withStatus": true,                  // were statuses comparable at all?
    "before": { "proved": 2, "total": 6, "byStatus": { … } },
    "after":  { "proved": 1, "total": 6, "byStatus": { … } }
  }
}
```

Notes

- Every array is sorted: `added`, `removed`, `bodyChanged` and the `*Changed`
  arrays by id, `renamed` by the old id, `attrsChanged` by id then key.
- `statusChanged` is empty unless **both** sides carry `facts`; a snapshot
  built without `lean-facts.json` has no statuses to compare, and
  `summary.withStatus` says so.
- `regression` is the `status-regression` check of the list above: `proved`
  became `stated`, `missing` or `absent`.  `blueprint diff` exits 1 when
  there is one, unless `--no-fail` is given.
- Attribute values are reproduced as they appear in `attrs`, with `null` for
  "the key was not set on that side".
- `depth` and `source` are derived, and are not compared.

## data/index.json

The history index the website's time slider reads (`web/README.md`), written
by `blueprint history add` and kept up to date by `blueprint site --history`.

```jsonc
{ "snapshots": [
    { "sha": "b636bbc1…",
      "date": "2026-09-19",                        // YYYY-MM-DD, the sort key
      "file": "data/b636bbc1….json",               // relative to the site root
      "summary": { "proved": 2, "total": 6,
                   "byStatus": { "proved": 2, "stated": 1, "absent": 2 } } } ] }
```

`summary` counts objects of a `countable = true` kind that have an entry in
`derived.status`; `byStatus` lists only the statuses that occur.  Entries are
sorted by date then sha, and there is at most one entry per sha.  The entry
`blueprint site` adds for the snapshot it just built points at
`blueprint.json` itself.
