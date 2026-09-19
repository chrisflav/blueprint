# `examples/latex-import`

A small hand-written `leanblueprint` LaTeX blueprint and the Markdown sources
`blueprint import-latex` turns it into.

```
lake exe blueprint import-latex examples/latex-import/src/content.tex \
  --out /tmp/li/blueprint --toml /tmp/li/blueprint.toml --report /tmp/li/report.txt
diff -r /tmp/li examples/latex-import/expected      # byte identical
lake exe blueprint check --root /tmp/li             # zero errors
```

`src/` covers the conventions the importer has to get right:

| in `src/` | in `expected/` |
|---|---|
| `\input` without `.tex`, comments, `\%` | spliced, stripped, kept |
| `\chapter` / `\section` with and without `\label` | one directory each, `_section.md`, `order` |
| `\newtheorem` in `macros/common.tex` | `openproblem` is a theorem-like environment |
| `theorem`, `lemma`, `definition`, `openproblem` | kinds `theorem`, `lemma`, `definition`, `remark` + tag `latex:openproblem` |
| a `lemma` with no `\label` | the derived id `sec-rings--lemma-1` |
| `\lean{a,\n b}` over two lines | `lean = ["Example.main", "Example.main'"]` |
| `\uses` in the statement and in the proof | one deduplicated `uses` list |
| `\uses{lem:nowhere}`, `\cref{lem:missing}` | no dangling edge; `Unresolved dependencies:` and plain text |
| `align`, `equation`, `\[ … \]`, `$ … $` | `$$ … $$`, `\begin{aligned}`, maths untouched |
| `\emph`, `\textbf`, `\texttt`, `\cite`, `\url`, `\href`, `quote` | Markdown |
| `tabular` and `description` | a GitHub Markdown table and a bold-term list |
| `enumerate` around a nested `itemize` | nested Markdown list |
| `\statusnote{…}` from `macros/common.tex` | a `**Status.**` paragraph |
| `\newcommand`, `\DeclareMathOperator[*]` | `[katex.macros]` in `blueprint.toml` |
| a `proof` environment | a `## Proof` section of the object's body |

`expected/report.txt` is the report the import prints.  Its dropped-command
table is empty and its unknown-environment table holds only `tabular`, which
is passed through as a Markdown table rather than understood as LaTeX.
