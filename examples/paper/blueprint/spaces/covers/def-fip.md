+++
id    = "def-fip"
kind  = "definition"
title = "Finite intersection property"
order = 2
uses  = ["def-cover"]
+++
A family $(F_i)_{i \in I}$ of subsets of $X$ has the *finite intersection
property* when every finite subfamily meets:
$$
\begin{aligned}
F_{i_1} \cap \dots \cap F_{i_n} &\neq \emptyset
  &&\text{for all } n \ge 1 \text{ and } i_1, \dots, i_n \in I .
\end{aligned}
$$
It is the dual of [def-cover] under complements.
