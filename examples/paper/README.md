# `examples/paper`

A short paper written as a blueprint: the fixture of the PDF export
(`docs/pdf-export.md`).  It has no Lean side; every status is `absent`.

| what the export has to get right | where |
|---|---|
| sections nested three deep, ordered by `order` | `spaces/`, `spaces/covers/`, `spaces/compact/` |
| text that belongs to no statement (`hidden`), set in place, unnumbered | `spaces/covers/opening.md`, `spaces/compact/between.md` |
| a lemma under two sections (`multi-parent`), written out once and pointed at from the other, or written out in full when its first place is not exported | `spaces/compact/lem-tube.md` |
| a proof object with lemmas refining it and a step of its own, read after its statement | `spaces/compact/thm-fip.proof.md`, `lem-complements.md`, `lem-finite-subfamily.md`, `proof-uses-fip.md` |
| a proof still in a body, as `## Proof` | `products/thm-product.md` |
| `[katex.macros]`, inline and display maths, `aligned` | `blueprint.toml`, `spaces/covers/` |
| an appendix with a table, code spans, a fenced code block, a block quote and an image | `appendix/` |
| Latin, Greek and mathematical characters in text | `intro.md`, `appendix/notation.md` |
| references inside the part, outside it, and in the other direction | throughout |

`export/` is what `blueprint export` makes of it, and `./test.sh` checks
the `.tex` files are byte for byte what the command writes:

```bash
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)    # reproducible PDFs
lake exe blueprint export --root examples/paper -o examples/paper/export
lake exe blueprint export --root examples/paper --scope products -o examples/paper/export
lake exe blueprint export --root examples/paper --scope thm-fip -o examples/paper/export
rm examples/paper/export/*-source.zip
```

* `paper-whole` — the whole blueprint, four pages, with the contents, the
  appendix and its image;
* `paper-3-products` — section 3 alone: the tube lemma, whose first place is
  section 2.2, is written out in it with its proof, and the references to
  section 2 are listed as outside the export;
* `paper-2-2-2-compactness-by-closed-sets` — one refined theorem: the
  statement, its proof with the step and the two lemmas inside it.

`web/sample/paper/blueprint.json` is the snapshot (`lake exe blueprint
build --root examples/paper -o web/sample/paper/blueprint.json`), which
`web/test/export.test.mjs` reads.
