import Blueprint.Status

/-!
# Validation

Every check of `docs/snapshot-format.md`, with the codes and levels listed
there.  Also computes `depth`.
-/

namespace Blueprint

/-! ## Depth and well-foundedness -/

/-- Boundary adjacency: `adj[i]` are the objects in the boundary of object `i`. -/
def boundaryAdj (b : Blueprint) : Array (Array Nat) :=
  b.objects.map fun o => o.boundary.filterMap fun e => b.findIdx? e.id

/-- `depth x = 0` for a node, else `1 + max` over the boundary.  Objects on a
boundary cycle keep depth `0`; `boundary-cycle` reports them separately. -/
def computeDepths (b : Blueprint) : Array Nat := Id.run do
  let adj := boundaryAdj b
  let n := adj.size
  let mut depth : Array Nat := Array.replicate n 0
  let mut fuel := n
  let mut changed := true
  while changed && fuel > 0 do
    fuel := fuel - 1
    changed := false
    for i in [0 : n] do
      let d := adj[i]!.foldl (init := 0) fun acc j => Nat.max acc (depth[j]! + 1)
      if d != depth[i]! then
        depth := depth.set! i d
        changed := true
  return depth

/-- The blueprint with `depth` filled in. -/
def withDepths (b : Blueprint) : Blueprint :=
  let ds := computeDepths b
  { b with objects := b.objects.mapIdx fun i o => { o with depth := ds[i]!.min b.objects.size } }

/-- Groups of objects that lie on a common cycle of `adj`, deterministically
ordered.  Empty when `adj` is acyclic. -/
def cycleGroups (adj : Array (Array Nat)) : Array (Array Nat) := Id.run do
  let n := adj.size
  let reach : Array (Array Bool) := (Array.range n).map fun i => closure adj adj[i]!
  let mut groups : Array (Array Nat) := #[]
  let mut placed : Array Bool := Array.replicate n false
  for i in [0 : n] do
    if placed[i]! then continue
    if !reach[i]![i]! then continue
    let mut g : Array Nat := #[]
    for j in [0 : n] do
      if reach[i]![j]! && reach[j]![i]! then
        g := g.push j
        placed := placed.set! j true
    groups := groups.push g
  return groups

/-! ## Links in prose -/

/-- Characters that may appear in a slug. -/
def isSlugChar (c : Char) : Bool :=
  c.isAlphanum || c == '-' || c == '_' || c == '/' || c == '~' || c == '.'

/-- Read a `slug]` starting after an opening bracket. -/
private def takeSlug : Nat → List Char → String → Option (String × List Char)
  | 0, _, _ => none
  | _, [], _ => none
  | fuel + 1, c :: rest, acc =>
    if c == ']' then (if acc.isEmpty then none else some (acc, rest))
    else if isSlugChar c then takeSlug fuel rest (acc.push c)
    else none

/-- Skip to just past the closing maths delimiter.  `dbl` says whether the
opening delimiter was `$$`. -/
private def skipMath : Nat → List Char → Bool → List Char
  | 0, cs, _ => cs
  | _, [], _ => []
  | fuel + 1, c :: rest, dbl =>
    if c == '\\' then (match rest with | _ :: r => skipMath fuel r dbl | [] => [])
    else if c == '$' then
      (if dbl then (match rest with | '$' :: r => r | r => skipMath fuel r dbl) else rest)
    else skipMath fuel rest dbl

/-- Scan a body for `[slug]` references.  Maths is skipped: `\mathbf Z[T]`
is not a link, and the website's renderer, which runs KaTeX before looking for
links, does not treat it as one either. -/
private def scanLinks : Nat → List Char → Char → Array String → Array String
  | 0, _, _, acc => acc
  | _, [], _, acc => acc
  | fuel + 1, c :: rest, prev, acc =>
    if c == '$' && prev != '\\' then
      match rest with
      | '$' :: r => scanLinks fuel (skipMath fuel r true) '$' acc
      | r => scanLinks fuel (skipMath fuel r false) '$' acc
    else if c == '[' && prev != '\\' && prev != '[' && prev != '!' then
      match takeSlug (fuel + 1) rest "" with
      | some (slug, rest') =>
        match rest'.head? with
        | some '(' => scanLinks fuel rest c acc
        | some '[' => scanLinks fuel rest c acc
        | _ => scanLinks fuel rest' ']' (acc.push slug)
      | none => scanLinks fuel rest c acc
    else scanLinks fuel rest c acc

/-- The `[slug]` references in a body, in order of appearance. -/
def extractLinks (body : String) : Array String :=
  let cs := body.toList
  scanLinks cs.length cs ' ' #[]

/-! ## Structural checks -/

/-- A canonical rendering of a boundary, used for the `unique` constraint. -/
def boundaryKey (o : Object) : String :=
  String.intercalate ";" (o.boundary.toList.map fun e => e.role ++ "=" ++ e.id)

/-- Checks that do not need Lean facts. -/
def structuralChecks (b : Blueprint) : Array Check := Id.run do
  let mut cs : Array Check := #[]
  -- unknown kinds, unknown attributes are partly found while parsing
  for o in b.objects do
    if o.kind.isEmpty then continue
    if (b.schema.kind? o.kind).isNone then
      cs := cs.push <| Check.error "unknown-kind"
        s!"{o.source.file}: object '{o.id}' has unknown kind '{o.kind}'" #[o.id]
  -- dangling references and boundary shape
  for o in b.objects do
    for e in o.boundary do
      if !b.contains e.id then
        cs := cs.push <| Check.error "dangling-ref"
          s!"{o.source.file}: object '{o.id}' refers to unknown object '{e.id}' in role '{e.role}'"
          #[o.id]
    match b.kindOf? o with
    | none => pure ()
    | some k =>
      -- roles the kind does not declare
      for e in o.boundary do
        if (k.role? e.role).isNone then
          cs := cs.push <| Check.error "bad-boundary"
            s!"{o.source.file}: kind '{k.name}' has no role '{e.role}' (object '{o.id}')" #[o.id]
      -- cardinalities and allowed kinds
      for r in k.roles do
        let ids := o.role r.name
        if !r.card.admits ids.size then
          cs := cs.push <| Check.error "bad-boundary"
            s!"{o.source.file}: object '{o.id}' has {ids.size} object(s) in role '{r.name}' of kind '{k.name}', which requires {r.card}"
            #[o.id]
        if !r.kinds.isEmpty then
          for i in ids do
            match b.find? i with
            | none => pure ()
            | some t =>
              if !r.kinds.contains t.kind then
                cs := cs.push <| Check.error "bad-boundary"
                  s!"{o.source.file}: role '{r.name}' of '{o.id}' may not hold a '{t.kind}' (allowed: {String.intercalate ", " r.kinds.toList})"
                  #[o.id, i]
  -- well-foundedness of the boundary relation
  for g in cycleGroups (boundaryAdj b) do
    let ids := g.map fun i => b.objects[i]!.id
    cs := cs.push <| Check.error "boundary-cycle"
      s!"the boundary relation is cyclic: {String.intercalate " -> " ids.toList}" ids
  -- per kind constraints
  for k in b.schema.kinds do
    if k.hasConstraint "acyclic" then
      let n := b.objects.size
      let mut adj : Array (Array Nat) := Array.replicate n #[]
      for o in b.objects do
        if o.kind != k.name then continue
        match o.src?, o.tgt? with
        | some s, some t =>
          match b.findIdx? s, b.findIdx? t with
          | some si, some ti => adj := adj.modify si (·.push ti)
          | _, _ => pure ()
        | _, _ => pure ()
      for g in cycleGroups adj do
        let ids := g.map fun i => b.objects[i]!.id
        cs := cs.push <| Check.error "constraint-acyclic"
          s!"kind '{k.name}' is declared acyclic but relates a cycle: {String.intercalate " -> " ids.toList}"
          ids
    if k.hasConstraint "unique" then
      let os := b.ofKind k.name
      let keys := sortDedup (os.map boundaryKey)
      for key in keys do
        let here := os.filter fun o => boundaryKey o == key
        if here.size > 1 then
          let ids := here.map (·.id)
          cs := cs.push <| Check.error "constraint-unique"
            s!"kind '{k.name}' is declared unique but {here.size} objects share the boundary {key}"
            ids
  -- more than one parent under a collapse kind
  for k in b.schema.collapseKinds do
    let c := Collapse.of b k
    for i in [0 : b.objects.size] do
      let ps := sortDedup (c.parents[i]!.map fun j => b.objects[j]!.id)
      if ps.size > 1 then
        let o := b.objects[i]!
        cs := cs.push <| Check.warning "multi-parent"
          s!"{o.source.file}: '{o.id}' has {ps.size} '{k}' parents ({String.intercalate ", " ps.toList}); it is counted under each"
          (#[o.id] ++ ps)
  -- links in prose
  for o in b.objects do
    for l in sortDedup (extractLinks o.body) do
      if !b.contains l then
        cs := cs.push <| Check.warning "bad-link"
          s!"{o.source.file}: '{o.id}' links to [{l}], which is not an object" #[o.id]
  return cs

/-! ## View consistency lints -/

/-- `undeclared-edge` and `unwitnessed-edge` for a collapse kind, computed at
the fully collapsed view and at each view expanding a single root. -/
def consistencyChecks (b : Blueprint) (collapseKind : String) : Array Check := Id.run do
  let c := Collapse.of b collapseKind
  let roots := (c.roots).filter fun i => !c.children[i]!.isEmpty
  let views : Array (String × View) :=
    #[("fully collapsed", View.collapsed c)] ++
      roots.map fun r => (s!"expanding '{b.objects[r]!.id}'", View.of c #[r])
  let mut cs : Array Check := #[]
  let mut seen : Array String := #[]
  for (desc, v) in views do
    let q := quotient b v
    for e in q.consistency do
      if e.declared && e.derived then continue
      -- Nothing below either end could have witnessed the edge, so declaring
      -- it is not "planned but not yet elaborated": it is all there is.
      if e.declared then
        let hasDetail (i : String) : Bool :=
          match b.findIdx? i with
          | some j => !c.children[j]!.isEmpty
          | none => false
        if !hasDetail e.src && !hasDetail e.tgt then continue
      let code := if e.declared then "unwitnessed-edge" else "undeclared-edge"
      let key := code ++ "|" ++ e.kind ++ "|" ++ e.src ++ "|" ++ e.tgt
      if seen.contains key then continue
      seen := seen.push key
      let msg :=
        if e.declared then
          s!"under '{collapseKind}' ({desc}): '{e.kind}' edge {e.src} -> {e.tgt} is declared but no detail below witnesses it"
        else
          s!"under '{collapseKind}' ({desc}): a hidden '{e.kind}' edge gives {e.src} -> {e.tgt}, which the coarse story does not declare"
      cs := cs.push <| Check.info code msg #[e.src, e.tgt]
  return cs

/-! ## Checks against the Lean facts -/

/-- `missing-lean`, `declared-not-actual` and `actual-not-declared`.

An object's Lean names are those of its `lean` attribute *and* those of the
`attrMap`, the constants tagged `@[blueprint "<its id>"]` (`DESIGN.md` §5).
The `uses` edge `s -> t` is *actual* when some Lean name of `s` depends on
some Lean name of `t`, where `deps` in the facts is already the dependency
graph cut off at mapped constants. -/
def factChecks (b : Blueprint) (f : Facts) : Array Check := Id.run do
  let mut cs : Array Check := #[]
  -- a `@[blueprint]` tag naming an object that does not exist
  for (n, id) in f.attrMap do
    unless b.contains id do
      cs := cs.push <| Check.error "dangling-ref"
        s!"'{n}' is tagged '@[blueprint \"{id}\"]', but there is no object '{id}'" #[id]
  -- every referenced Lean name must exist
  for o in b.objects do
    for n in o.leanNames do
      match f.find? n with
      | none =>
        cs := cs.push <| Check.error "missing-lean"
          s!"{o.source.file}: '{o.id}' names '{n}', which the extractor did not find" #[o.id]
      | some d =>
        if !d.present then
          cs := cs.push <| Check.error "missing-lean"
            s!"{o.source.file}: '{o.id}' names '{n}', which does not exist in the Lean environment"
            #[o.id]
  -- declared versus actual `uses`
  if (b.schema.kind? "uses").isSome then
    let owner : Array (String × String) := b.objects.foldl (init := #[]) fun acc o =>
      (f.namesOf o).foldl (init := acc) fun a n => a.push (n, o.id)
    let ownersOf (n : String) : Array String := (owner.filter (·.1 == n)).map (·.2)
    let mut actual : Array (String × String) := #[]
    for o in b.objects do
      for n in f.namesOf o do
        if let some d := f.find? n then
          for dep in d.deps do
            for b2 in ownersOf dep do
              if b2 != o.id && !actual.contains (o.id, b2) then
                actual := actual.push (o.id, b2)
    let declared : Array (String × String) :=
      (b.ofKind "uses").filterMap fun o =>
        match o.src?, o.tgt? with
        | some s, some t => some (s, t)
        | _, _ => none
    for (s, t) in actual do
      if !declared.contains (s, t) then
        cs := cs.push <| Check.warning "actual-not-declared"
          s!"Lean shows '{s}' depends on '{t}', but no 'uses' edge declares it" #[s, t]
    for (s, t) in declared do
      -- only meaningful when both ends are mapped to Lean
      let mapped := (b.find? s).any (fun o => !(f.namesOf o).isEmpty)
        && (b.find? t).any (fun o => !(f.namesOf o).isEmpty)
      if mapped && !actual.contains (s, t) then
        cs := cs.push <| Check.info "declared-not-actual"
          s!"'uses' edge {s} -> {t} is declared, but the Lean dependency graph does not show it"
          #[s, t]
  return cs

/-! ## Everything together -/

/-- The result of analysing a parsed blueprint. -/
structure Analysis where
  /-- The blueprint with `depth` filled in. -/
  blueprint : Blueprint
  /-- Every check, sorted deterministically. -/
  checks : Array Check
  /-- Derived status per object whose kind permits `lean`. -/
  statuses : Array (String × DerivedStatus)
  /-- Progress per collapse kind per object. -/
  progress : Array (String × Array (String × Progress))
  deriving Inhabited

/-- Run every check.  `viewKind` selects the collapse kind for the view
consistency lints; it defaults to the schema's default collapse kind. -/
def analyse (b : Blueprint) (parseChecks : Array Check) (facts : Option Facts := none)
    (viewKind : Option String := none) : Analysis :=
  let b := withDepths b
  let statuses := allStatuses b facts
  let progress := allProgress b statuses
  let collapseKind := match viewKind with
    | some k => some k
    | none => b.schema.mainCollapse?
  let viewChecks := match collapseKind with
    | some k => if (b.schema.kind? k).any KindSpec.collapse then consistencyChecks b k else
        #[Check.error "unknown-kind" s!"'{k}' is not a collapsible kind"]
    | none => #[]
  let factChecks := match facts with
    | some f => factChecks b f
    | none => #[]
  { blueprint := b
    checks := sortChecks (parseChecks ++ structuralChecks b ++ viewChecks ++ factChecks)
    statuses, progress }

end Blueprint
