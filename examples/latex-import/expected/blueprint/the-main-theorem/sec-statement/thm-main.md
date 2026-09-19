+++
id = "thm-main"
kind = "theorem"
title = "Main"
order = 9
lean = ["Example.main", "Example.main'"]
uses = ["def-poly", "lem-degree"]
+++
For every $n$ the identities

$$
\begin{aligned}
a &= b \\
b &= c
\end{aligned}
$$

hold, and so does

$$
\sum_{i=0}^{n} i = \frac{n(n+1)}{2}.
$$

See [lem-degree] and [def-poly], lem:missing.

## Proof

By induction. The steps are

1. the base case, and
1. the inductive step, which uses
   - the degree lemma, and
   - nothing else.

Unresolved dependencies: lem:nowhere
