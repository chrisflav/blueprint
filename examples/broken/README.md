# `examples/broken`

A deliberately broken blueprint: every error level check of
`docs/snapshot-format.md` fires here, and two of the non-error ones do too.

```
blueprint check --root examples/broken --lean     # exits 1
```

`--lean` is needed for `missing-lean`; the rest fire without it.

`lean-facts.json` here is generated, not written by hand:

```
lake exe blueprint extract --root examples/broken
```

It imports `BlueprintExamples.Broken` of this repository, which carries no
`@[blueprint]` tags and deliberately does not declare `Broken.nope`.

| line | code | why |
|------|------|-----|
| `blueprint/bad-kind.md:3` `kind = "nonsense"` | `unknown-kind` [error] | the schema declares no kind `nonsense` |
| `blueprint/bad-attr.md:4` `colour = "red"` | `unknown-attr` [error] | `theorem` does not permit a `colour` attribute, and `colour` is not a sugar kind either |
| `blueprint/bad-card.md:4` `src = ["thm-a", "thm-b"]` | `bad-boundary` [error] | role `src` of `uses` has cardinality `1` |
| `blueprint/bad-role.md:4` `{ from = …, to = … }` | `bad-boundary` [error] ×4 | `uses` declares no roles `from`/`to`, and its required `src`/`tgt` are then empty |
| `blueprint/bad-edge-kind.md:4` `edges = ["thm-a", "thm-b"]` | `bad-boundary` [error] ×2 | role `edges` of `commutes` only admits edge kinds, and `thm-a`/`thm-b` are theorems |
| `blueprint/cyc-a.md:4` and `blueprint/cyc-b.md:4` | `boundary-cycle` [error] | each object is in the other's boundary, so the boundary relation is not well founded |
| `blueprint/dangling.md:4` `uses = ["no-such-object"]` | `dangling-ref` [error] | the edge the sugar creates points at an object that does not exist |
| `blueprint/r1.md:4` and `blueprint/r2.md:4` | `constraint-acyclic` [error] | `refines` is declared `acyclic`, but `r1` refines `r2` refines `r1` |
| `blueprint/eq-a.md:4` and `blueprint/eq-b.md:4` | `constraint-unique` [error] | `blueprint.toml` declares `equivalent` `unique`, and both objects have the boundary `src=thm-a; tgt=thm-b` |
| `blueprint/dup1.md:2` and `blueprint/dup2.md:2` | `duplicate-id` [error] | two files claim the id `dup`; the second is dropped |
| `blueprint/no-lean.md:4` `lean = ["Broken.nope"]` | `missing-lean` [error] | `lean-facts.json` records `"exists": false` for that constant |
| `blueprint/thm-a.md:6` `[nowhere]` | `bad-link` [warning] | the body links to a slug that is not an object |

`status-regression` is the one remaining error level code; it is produced by
`blueprint diff`, which is phase 4.
