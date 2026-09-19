import BlueprintExamples.Topology

/-!
# Induction: the main argument of `examples/induction`

This module imports `BlueprintExamples.Topology` but never imports
`Blueprint.Attr` itself, so running the extractor on it also checks that the
`@[blueprint]` map survives `import`: the tags of `Topology` must still show
up in the `attrMap`.
-/

-- `Induction.smallSpace` is sorried on purpose, so that `main-theorem` comes
-- out as `stated`.  Without this the warning would make `lake build` noisy,
-- and `./test.sh` fails a build that emits warnings.
set_option warn.sorry false

namespace Induction

open Topology

/-- A space is decomposable when it decomposes into at most one piece. -/
def Decomposable (X : Space) : Prop := X.points ≤ 1

-- Mapped from the text side, `lean = ["Induction.keyProp"]`.  Its *statement*
-- mentions `Topology.compactness`, which is what makes the declared `uses`
-- edge `key-prop -> compactness` actual.
/-- Let $X$ be compact.  Then the restriction map is surjective. -/
theorem keyProp (X : Space) (h : compactness X) : Decomposable X := h

/-- The deliberate `sorry` of this example.  Its statement avoids
`Topology.compactness`, so that `mainTheorem` reaches that constant only
through `keyProp`, where the dependency walk stops. -/
theorem smallSpace (X : Space) : X.points ≤ 1 := sorry

-- Mapped from *both* sides: `@[blueprint "main-theorem"]` here and
-- `lean = ["Induction.mainTheorem"]` in `blueprint/induction/main-theorem.md`.
-- The two must merge into one mapping.
--
-- The proof goes through `keyProp` and through nothing else that mentions
-- `Topology.compactness`, so the blueprint's declared edge
-- `main-theorem -> compactness` is *not* actual: `declared-not-actual`.
/-- Every finite dimensional object admits a decomposition. -/
@[blueprint "main-theorem"]
theorem mainTheorem (X : Space) : Decomposable X :=
  keyProp X (smallSpace X)

end Induction
