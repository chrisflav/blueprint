import Blueprint.Attr

/-!
# Topology: the example development behind `examples/induction`

A toy stand-in for the topological input of the blueprint in
`examples/induction`.  The declarations here are named exactly as that
blueprint's `lean` attributes and `@[blueprint]` tags expect.

`Topology.dim` and `Topology.compactnessLemma` are mapped to blueprint
objects from *this* side, with the attribute; `Topology.compactness` is
mapped from the text side by `blueprint/topology/compactness.md`.  The
extractor has to find all three.
-/

namespace Topology

/-- A space.  For this example a space is just a number of points. -/
structure Space where
  /-- How many points the space has. -/
  points : Nat

-- Mapped to the blueprint object `notation` from the Lean side only:
-- `blueprint/preliminaries/notation.md` carries no `lean` key.
/-- The dimension of a space; we write `|X|` for `dim X`. -/
@[blueprint "notation"]
def dim (X : Space) : Nat := X.points

-- Mapped from the text side, `lean = ["Topology.compactness"]`.
/-- Every open cover has a finite subcover. -/
def compactness (X : Space) : Prop := X.points ≤ 1

/-- A choice of finite subcover.  A deliberate custom axiom, so that
everything using it comes out as `proved_with_axioms`. -/
axiom coverChoice (X : Space) : compactness X → dim X ≤ 1

-- Tagged with the bare form of the attribute, `@[blueprint compactness-lemma]`,
-- to exercise the parser; the string form is the primary one.
/-- A compact space is covered by finitely many charts. -/
@[blueprint compactness-lemma]
theorem compactnessLemma (X : Space) (h : compactness X) : dim X ≤ 1 :=
  coverChoice X h

end Topology
