import Blueprint.View

/-!
# Derived status and progress

`DESIGN.md` §4.  Derived status is computed from the Lean facts and never
stored in the text.  Progress is, for a collapse kind `K`, the fraction of
countable `K`-leaves below an object whose derived status is `proved`.
-/

namespace Blueprint

open Lean (Json)

/-! ## Derived status -/

/-- The derived status of an object, computed from `lean-facts.json`. -/
inductive DerivedStatus where
  /-- The object names no Lean declaration. -/
  | absent
  /-- It names a declaration that does not exist. -/
  | missing
  /-- The declaration exists but depends on `sorryAx`. -/
  | stated
  /-- The declaration is proved. -/
  | proved
  /-- Proved, but using axioms beyond the standard three. -/
  | provedWithAxioms
  deriving Inhabited, BEq, DecidableEq

namespace DerivedStatus

/-- The spelling used in `blueprint.json`. -/
def toString : DerivedStatus → String
  | .absent => "absent"
  | .missing => "missing"
  | .stated => "stated"
  | .proved => "proved"
  | .provedWithAxioms => "proved_with_axioms"

instance : ToString DerivedStatus := ⟨DerivedStatus.toString⟩

/-- Read a status back from `blueprint.json`. -/
def ofString? : String → Option DerivedStatus
  | "absent" => some .absent
  | "missing" => some .missing
  | "stated" => some .stated
  | "proved" => some .proved
  | "proved_with_axioms" => some .provedWithAxioms
  | _ => none

end DerivedStatus

/-! ## Lean facts -/

/-- What `lean-facts.json` records about one constant. -/
structure DeclFact where
  /-- The constant's name. -/
  name : String
  /-- Whether the constant exists in the environment. -/
  present : Bool
  /-- `stated`, `proved` or `proved_with_axioms`. -/
  status : String := ""
  /-- Mapped constants it depends on. -/
  deps : Array String := #[]
  deriving Inhabited

/-- The decoded contents of `lean-facts.json`. -/
structure Facts where
  /-- The `decls` object, kept verbatim for the snapshot. -/
  json : Json
  /-- The decoded declarations. -/
  decls : Array DeclFact
  /-- The `attrMap`: Lean constant to object id, as written by
  `@[blueprint "<id>"]`.  Sorted by constant name. -/
  attrMap : Array (String × String) := #[]
  deriving Inhabited

namespace Facts

/-- Decode the `decls` object of `lean-facts.json`. -/
def ofDeclsJson (j : Json) : Facts :=
  let decls := match j.getObj? with
    | .ok o => o.foldl (init := (#[] : Array DeclFact)) fun (acc : Array DeclFact) (name : String) (v : Json) =>
        let present := (v.getObjValAs? Bool "exists").toOption.getD false
        let status := (v.getObjValAs? String "status").toOption.getD ""
        let deps := match v.getObjVal? "deps" with
          | .ok (.arr xs) => xs.filterMap fun (d : Json) => d.getStr?.toOption
          | _ => #[]
        acc.push { name, present, status, deps }
    | .error _ => #[]
  { json := j, decls := decls.qsort (fun a b => a.name < b.name) }

/-- Decode the `attrMap` object of `lean-facts.json`. -/
def attrMapOfJson (j : Json) : Array (String × String) :=
  let xs := match j.getObj? with
    | .ok o => o.foldl (init := (#[] : Array (String × String)))
        fun (acc : Array (String × String)) (n : String) (v : Json) =>
          match v.getStr?.toOption with
          | some id => acc.push (n, id)
          | none => acc
    | .error _ => #[]
  xs.qsort (fun a b => a.1 < b.1)

/-- Decode a whole `lean-facts.json` document. -/
def ofJson (j : Json) : Facts :=
  let base := match j.getObjVal? "decls" with
    | .ok d => ofDeclsJson d
    | .error _ => ofDeclsJson (Json.mkObj [])
  let attrMap := match j.getObjVal? "attrMap" with
    | .ok m => attrMapOfJson m
    | .error _ => #[]
  { base with attrMap }

/-- Look up one constant. -/
def find? (f : Facts) (name : String) : Option DeclFact := f.decls.find? (·.name == name)

/-- The constants `@[blueprint]` maps to a given object. -/
def taggedWith (f : Facts) (id : String) : Array String :=
  (f.attrMap.filter (·.2 == id)).map (·.1)

end Facts

/-- Read `lean-facts.json` from a path. -/
def loadFacts (path : System.FilePath) : IO Facts := do
  let text ← IO.FS.readFile path
  match Json.parse text with
  | .error e => throw <| IO.userError s!"{path}: {e}"
  | .ok j => return Facts.ofJson j

/-! ## Computing status -/

/-- The Lean names an object claims. -/
def Object.leanNames (o : Object) : Array String := o.attrStrings "lean"

/-- Does the kind of this object permit a `lean` attribute? -/
def permitsLean (b : Blueprint) (o : Object) : Bool :=
  match b.kindOf? o with
  | some k => k.attrs.contains "lean"
  | none => false

/-- Every Lean name an object claims: the `lean` attribute written in the
text plus every constant carrying `@[blueprint "<this id>"]`.  `DESIGN.md`
§5: the mapping may be stated from either side, and the two merge. -/
def Facts.namesOf (f : Facts) (o : Object) : Array String :=
  sortDedup (o.leanNames ++ f.taggedWith o.id)

/-- The names an object claims, given the facts if there are any. -/
def leanNamesOf (facts : Option Facts) (o : Object) : Array String :=
  match facts with
  | some f => f.namesOf o
  | none => o.leanNames

/-- The derived status of one object: `proved` only if every name is proved,
`missing` if any name is missing, else `stated`. -/
def statusOf (facts : Option Facts) (o : Object) : DerivedStatus :=
  let names := leanNamesOf facts o
  if names.isEmpty then .absent else
  match facts with
  | none => .absent
  | some f =>
    let sts := names.map fun n =>
      match f.find? n with
      | none => DerivedStatus.missing
      | some d =>
        if !d.present then .missing
        else match d.status with
          | "proved" => .proved
          | "proved_with_axioms" => .provedWithAxioms
          | _ => .stated
    if sts.contains .missing then .missing
    else if sts.contains .stated then .stated
    else if sts.contains .provedWithAxioms then .provedWithAxioms
    else .proved

/-- The derived status of every object whose kind permits `lean`, sorted by id. -/
def allStatuses (b : Blueprint) (facts : Option Facts) : Array (String × DerivedStatus) :=
  (b.objects.filter (permitsLean b ·)).map fun o => (o.id, statusOf facts o)

/-! ## Progress -/

/-- `proved` out of `total` countable leaves. -/
structure Progress where
  /-- Countable `K`-leaves below whose status is `proved`. -/
  proved : Nat
  /-- All countable `K`-leaves below. -/
  total : Nat
  deriving Inhabited, BEq

/-- Progress of every object under one collapse kind.  The countable leaves
below an object `o` are the objects `x ≤K o` of a countable kind that have no
`K`-children; `o` itself counts when it is such a leaf. -/
def progressFor (b : Blueprint) (c : Collapse) (statuses : Array (String × DerivedStatus)) :
    Array (String × Progress) := Id.run do
  let n := b.objects.size
  let countable : Array Bool := b.objects.map fun o =>
    (b.kindOf? o).any KindSpec.countable
  let isLeaf : Array Bool := (Array.range n).map fun i => c.children[i]!.isEmpty
  let statusAt : Array DerivedStatus := b.objects.map fun o =>
    (statuses.find? (·.1 == o.id)).map (·.2) |>.getD .absent
  let mut out : Array (String × Progress) := #[]
  for i in [0 : n] do
    let below := trueIndices (closure c.children #[i])
    let leaves := below.filter fun j => countable[j]! && isLeaf[j]!
    if leaves.isEmpty then continue
    let proved := (leaves.filter fun j => statusAt[j]! == .proved).size
    out := out.push (b.objects[i]!.id, { proved, total := leaves.size })
  return out

/-- Progress for every collapse kind of the schema, sorted by kind then id. -/
def allProgress (b : Blueprint) (statuses : Array (String × DerivedStatus)) :
    Array (String × Array (String × Progress)) :=
  b.schema.collapseKinds.map fun k => (k, progressFor b (Collapse.of b k) statuses)

end Blueprint
