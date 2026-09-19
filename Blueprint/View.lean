import Blueprint.Parse
import Lean.Data.Json

/-!
# Collapse orders, views and the display rule

`DESIGN.md` §3.  Let `K` be a collapsible kind.  `x ≤K y` when there is a
chain of `K`-edges from `x` to `y`.  A view is an upward closed set `X` of
*expanded* objects; the *visible* objects are those outside `X` that are
`K`-roots or have a `K`-parent in `X`.
-/

namespace Blueprint

open Lean (Json)

/-! ## The collapse relation -/

/-- The `K`-edge relation of a blueprint, as index adjacency lists. -/
structure Collapse where
  /-- The collapse kind. -/
  kind : String
  /-- `parents[i]` are the objects directly above object `i`. -/
  parents : Array (Array Nat)
  /-- `children[i]` are the objects directly below object `i`. -/
  children : Array (Array Nat)
  deriving Inhabited

/-- Build the collapse relation for kind `k`. -/
def Collapse.of (b : Blueprint) (k : String) : Collapse := Id.run do
  let n := b.objects.size
  let mut parents : Array (Array Nat) := Array.replicate n #[]
  let mut children : Array (Array Nat) := Array.replicate n #[]
  for o in b.objects do
    if o.kind != k then continue
    match o.src?, o.tgt? with
    | some s, some t =>
      match b.findIdx? s, b.findIdx? t with
      | some si, some ti =>
        parents := parents.modify si (·.push ti)
        children := children.modify ti (·.push si)
      | _, _ => pure ()
    | _, _ => pure ()
  return { kind := k, parents, children }

/-- Nodes reachable from `starts` along `adj`, as a membership array.  The
starting nodes are marked too. -/
def closure (adj : Array (Array Nat)) (starts : Array Nat) : Array Bool := Id.run do
  let mut seen : Array Bool := Array.replicate adj.size false
  let mut frontier : Array Nat := #[]
  for s in starts do
    if s < seen.size && !seen[s]! then
      seen := seen.set! s true
      frontier := frontier.push s
  let mut fuel := adj.size
  while !frontier.isEmpty && fuel > 0 do
    fuel := fuel - 1
    let mut next : Array Nat := #[]
    for i in frontier do
      for j in adj[i]!.toList do
        if j < seen.size && !seen[j]! then
          seen := seen.set! j true
          next := next.push j
    frontier := next
  return seen

/-- Indices at which an array of booleans is `true`. -/
def trueIndices (xs : Array Bool) : Array Nat := Id.run do
  let mut out := #[]
  for i in [0 : xs.size] do
    if xs[i]! then out := out.push i
  return out

/-! ## Views -/

/-- A view: a collapse relation together with an upward closed set of
expanded objects, and the derived visibility information. -/
structure View where
  /-- The collapse relation it is taken with respect to. -/
  collapse : Collapse
  /-- `expanded[i]` is true when object `i` is expanded. -/
  expanded : Array Bool
  /-- `visible[i]` is true when object `i` is drawn in its own right. -/
  visible : Array Bool
  deriving Inhabited

/-- Close a set of objects upwards: expanding `x` expands everything above it. -/
def Collapse.upwardClose (c : Collapse) (xs : Array Nat) : Array Bool :=
  closure c.parents xs

/-- The view obtained by expanding (the upward closure of) `xs`. -/
def View.of (c : Collapse) (xs : Array Nat) : View := Id.run do
  let expanded := c.upwardClose xs
  let n := c.parents.size
  let mut visible : Array Bool := Array.replicate n false
  for i in [0 : n] do
    if expanded[i]! then continue
    let ps := c.parents[i]!
    if ps.isEmpty || ps.any (fun p => expanded[p]!) then
      visible := visible.set! i true
  return { collapse := c, expanded, visible }

/-- The fully collapsed view: nothing is expanded. -/
def View.collapsed (c : Collapse) : View := View.of c #[]

/-- The representative set of object `i`: the visible objects above or equal
to it. -/
def View.rep (v : View) (i : Nat) : Array Nat :=
  let above := closure v.collapse.parents #[i]
  (trueIndices above).filter fun j => v.visible[j]!

/-- The `K`-roots, that is the objects with no `K`-parent. -/
def Collapse.roots (c : Collapse) : Array Nat :=
  (Array.range c.parents.size).filter fun i => c.parents[i]!.isEmpty

/-! ## The display rule -/

/-- One end of a drawn object: a role and the visible objects it lands on. -/
structure DrawnEnd where
  /-- The role. -/
  role : String
  /-- Ids of the visible representatives of the object in that role. -/
  reps : Array String
  deriving Inhabited

/-- An object drawn as an arc or junction in the quotient graph. -/
structure DrawnObject where
  /-- The object's id. -/
  id : String
  /-- Its kind. -/
  kind : String
  /-- Whether the object is itself visible (drawn with its own prose). -/
  visible : Bool
  /-- Its boundary, pushed down to representatives. -/
  ends : Array DrawnEnd
  deriving Inhabited

/-- The declared/derived state of an `E`-edge between two visible objects. -/
structure EdgeState where
  /-- The edge kind `E`. -/
  kind : String
  /-- Visible source. -/
  src : String
  /-- Visible target. -/
  tgt : String
  /-- A visible `E`-object has exactly this boundary. -/
  declared : Bool
  /-- A hidden `E`-object has these representatives. -/
  derived : Bool
  deriving Inhabited


/-- A visible object of a view. -/
structure VisibleObject where
  /-- Its id. -/
  id : String
  /-- Its kind. -/
  kind : String
  /-- True when the object has a boundary that collapses onto a single visible
  object, so that it is drawn inside that object rather than between two. -/

  internal : Bool
  deriving Inhabited
/-- The quotient graph of a blueprint at a view. -/
structure QuotientGraph where
  /-- The collapse kind. -/
  collapse : String
  /-- Ids of the expanded objects. -/
  expanded : Array String
  /-- The visible objects. -/
  visible : Array VisibleObject
  /-- Objects drawn as arcs or junctions. -/
  drawn : Array DrawnObject
  /-- Consistency of every edge between visible objects. -/
  consistency : Array EdgeState
  deriving Inhabited

/-- Edge kinds whose consistency is reported: binary kinds other than the
collapse kind. -/
def consistencyKinds (b : Blueprint) (collapseKind : String) : Array String :=
  (b.schema.kinds.filter fun k => k.isBinary && k.name != collapseKind).map (·.name)

/-- Apply the display rule of `DESIGN.md` §3 and compute the quotient graph. -/
def quotient (b : Blueprint) (v : View) : QuotientGraph := Id.run do
  let n := b.objects.size
  let reps : Array (Array Nat) := (Array.range n).map v.rep
  let idOf (i : Nat) : String := b.objects[i]!.id
  let mut drawn : Array DrawnObject := #[]
  let mut internal : Array Bool := Array.replicate n false
  for i in [0 : n] do
    let o := b.objects[i]!
    if o.boundary.isEmpty then continue
    let mut r : Array Nat := #[]
    let mut ends : Array DrawnEnd := #[]
    for e in o.boundary do
      let rs := match b.findIdx? e.id with
        | some j => reps[j]!
        | none => #[]
      for x in rs do
        if !r.contains x then r := r.push x
      ends := ends.push { role := e.role, reps := sortDedup (rs.map idOf) }
    if r.size ≥ 2 then
      drawn := drawn.push { id := o.id, kind := o.kind, visible := v.visible[i]!, ends }
    else
      internal := internal.set! i true
  -- consistency of binary edges between visible objects
  let mut states : Array EdgeState := #[]
  for ek in consistencyKinds b v.collapse.kind do
    -- (src, tgt, declared, derived) observations, merged below
    let mut obs : Array (String × String × Bool × Bool) := #[]
    let record (obs : Array (String × String × Bool × Bool))
        (s t : String) (dec der : Bool) : Array (String × String × Bool × Bool) :=
      match obs.findIdx? (fun p => p.1 == s && p.2.1 == t) with
      | some k => obs.modify k fun p => (p.1, p.2.1, p.2.2.1 || dec, p.2.2.2 || der)
      | none => obs.push (s, t, dec, der)
    for i in [0 : n] do
      let o := b.objects[i]!
      if o.kind != ek then continue
      match o.src?, o.tgt? with
      | some s, some t =>
        match b.findIdx? s, b.findIdx? t with
        | some si, some ti =>
          -- An edge whose two ends are themselves visible *declares* that
          -- arc; otherwise it is a detail and *derives* arcs between the
          -- representatives of its ends.  (Both ends visible is equivalent to
          -- the edge having exactly that boundary among visible objects.)
          if v.visible[si]! && v.visible[ti]! then
            if si != ti then
              obs := record obs s t true false
          else
            for a in reps[si]! do
              for c in reps[ti]! do
                if a != c then
                  obs := record obs (idOf a) (idOf c) false true
        | _, _ => pure ()
      | _, _ => pure ()
    for (s, t, dec, der) in obs do
      states := states.push { kind := ek, src := s, tgt := t, declared := dec, derived := der }
  return {
    collapse := v.collapse.kind
    expanded := sortDedup ((trueIndices v.expanded).map idOf)
    visible := ((trueIndices v.visible).map fun i =>
      ({ id := idOf i, kind := b.objects[i]!.kind, internal := internal[i]! } : VisibleObject)).qsort
      (fun a c => a.id < c.id)
    drawn := drawn.qsort (fun a c => a.id < c.id)
    consistency := states.qsort (fun a c =>
      if a.kind != c.kind then a.kind < c.kind
      else if a.src != c.src then a.src < c.src else a.tgt < c.tgt) }

/-! ## Rendering -/

/-- Render a quotient graph as readable text. -/
def QuotientGraph.render (q : QuotientGraph) : String := Id.run do
  let mut out := s!"collapse kind: {q.collapse}\n"
  out := out ++ s!"expanded ({q.expanded.size}): "
    ++ String.intercalate ", " q.expanded.toList ++ "\n"
  out := out ++ s!"visible ({q.visible.size}):\n"
  for o in q.visible do
    let tag := if o.internal then "  [internal]" else ""
    out := out ++ s!"  {o.id} : {o.kind}{tag}\n"
  out := out ++ s!"drawn ({q.drawn.size}):\n"
  for d in q.drawn do
    let ends := String.intercalate "  " (d.ends.toList.map fun e =>
      e.role ++ "={" ++ String.intercalate "," e.reps.toList ++ "}")
    let vis := if d.visible then "visible" else "hidden"
    out := out ++ s!"  {d.id} : {d.kind} [{vis}]  {ends}\n"
  out := out ++ s!"consistency ({q.consistency.size}):\n"
  for c in q.consistency do
    let state :=
      if c.declared && c.derived then "consistent"
      else if c.declared then "declared only (no detail below witnesses it)"
      else "derived only (the coarse story does not declare it)"
    out := out ++ s!"  {c.kind}: {c.src} -> {c.tgt}  {state}\n"
  return out

/-- Render a quotient graph as JSON. -/
def QuotientGraph.toJson (q : QuotientGraph) : Json :=
  Json.mkObj [
    ("collapse", Json.str q.collapse),
    ("expanded", Json.arr (q.expanded.map Json.str)),
    ("visible", Json.arr (q.visible.map fun o => Json.mkObj [
      ("id", Json.str o.id),
      ("kind", Json.str o.kind),
      ("internal", Json.bool o.internal)])),
    ("drawn", Json.arr (q.drawn.map fun d => Json.mkObj [
      ("id", Json.str d.id),
      ("kind", Json.str d.kind),
      ("visible", Json.bool d.visible),
      ("ends", Json.arr (d.ends.map fun e => Json.mkObj [
        ("role", Json.str e.role),
        ("reps", Json.arr (e.reps.map Json.str))]))])),
    ("consistency", Json.arr (q.consistency.map fun c => Json.mkObj [
      ("kind", Json.str c.kind),
      ("src", Json.str c.src),
      ("tgt", Json.str c.tgt),
      ("declared", Json.bool c.declared),
      ("derived", Json.bool c.derived)]))]

end Blueprint
