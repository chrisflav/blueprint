/-!
# Broken: the example development behind `examples/broken`

`examples/broken/blueprint/no-lean.md` names `Broken.nope`, which is
deliberately never declared, so that `blueprint check --lean` reports
`missing-lean`.  This module carries no `@[blueprint]` tags and does not
import `Blueprint.Attr`, so extracting with it as the only module gives an
empty `attrMap`.
-/

namespace Broken

/-- Not `Broken.nope`: that constant is missing on purpose. -/
def yes : Nat := 0

end Broken
