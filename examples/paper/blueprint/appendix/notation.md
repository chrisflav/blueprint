+++
id    = "notation"
kind  = "remark"
title = "Symbols"
order = 1
+++
| Symbol | Meaning | First used |
| :--- | :--- | ---: |
| $\cl{A}$ | the closure of $A$ | [def-fip] |
| $\Opens{X}$ | the open subsets of $X$ | [intro] |
| $\fam{U}$, $\fam{W}$ | families of open sets | [def-cover] |
| $\Top$ | the category of spaces, $f\colon X \to Y$ continuous | — |

Greek letters index families (α ∈ A), and ℝ, ≤, → are used as usual.
Identifiers in the Lean sources look like `TopologicalSpace.IsCompact` or
`isCompact_iff_finite_subfamily_closed`; a typical lookup is

```lean
example (X : Type*) [TopologicalSpace X] :
    CompactSpace X ↔ IsCompact (Set.univ : Set X) := ⟨fun h => h.1, fun h => ⟨h⟩⟩
```

> Every result here is classical; see any text on point-set topology.
