+++
id    = "thm-product"
kind  = "theorem"
title = "Products of two compact spaces"
order = 1
uses  = ["lem-tube", "def-compact"]
+++
If $X$ and $Y$ are compact, so is $X \times Y$ with the product topology.

## Proof

Let $\fam{W}$ be an open cover of $X \times Y$.  For each $x \in X$ the
slice $\{x\} \times Y \cong Y$ is compact, so finitely many members of
$\fam{W}$ cover it; call their union $W_x$.  By [lem-tube] there is an open
$U_x \ni x$ with $U_x \times Y \subseteq W_x$.

1. The $U_x$ cover $X$, so by [def-compact] finitely many do:
   $U_{x_1}, \dots, U_{x_m}$.
2. Then $X \times Y = \bigcup_{k=1}^{m} U_{x_k} \times Y \subseteq \bigcup_k W_{x_k}$,
   a union of finitely many members of $\fam{W}$.

Compare the closed-set form, [thm-fip], which gives the same result by a
less direct route.
