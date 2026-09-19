import Blueprint.Check

/-!
# The snapshot format

`docs/snapshot-format.md`, version 1.  This module writes `blueprint.json`
and reads it back; `blueprint build` and, later, `blueprint diff` are the
only consumers on the Lean side.
-/

namespace Blueprint

open Lean (Json JsonNumber)

/-- The version of the snapshot format this module speaks. -/
def snapshotVersion : Nat := 1

/-! ## Writing -/

/-- Build a JSON object from a sorted association array. -/
private def objOf (xs : Array (String × Json)) : Json :=
  Json.mkObj (xs.qsort (fun a b => a.1 < b.1)).toList

/-- An attribute value as JSON. -/
def AttrValue.toJson : AttrValue → Json
  | .str s => Json.str s
  | .int n => Json.num (JsonNumber.fromInt n)
  | .float f => match JsonNumber.fromFloat? f with
    | .inr n => Json.num n
    | .inl _ => Json.null
  | .bool b => Json.bool b
  | .strs xs => Json.arr (xs.map Json.str)

/-- A cardinality as JSON: `{ "min": n, "max": m }` with `null` for unbounded. -/
def Cardinality.toJson (c : Cardinality) : Json :=
  Json.mkObj [("min", Json.num (JsonNumber.fromInt c.min)),
              ("max", match c.max with
                      | some m => Json.num (JsonNumber.fromInt m)
                      | none => Json.null)]

/-- A kind declaration as JSON. -/
def KindSpec.toJson (k : KindSpec) : Json :=
  let base : Array (String × Json) := #[
    ("boundary", objOf (k.roles.map fun r => (r.name, r.card.toJson))),
    ("kinds", objOf (k.roles.map fun r => (r.name, Json.arr (r.kinds.map Json.str)))),
    ("attrs", Json.arr (k.attrs.map Json.str)),
    ("constraints", Json.arr (k.constraints.map Json.str)),
    ("collapse", Json.bool k.collapse),
    ("countable", Json.bool k.countable),
    ("sugar", Json.bool k.sugar)]
  Json.mkObj (base.toList ++ (match k.color with
    | some c => [("color", Json.str c)]
    | none => []))

/-- The schema as JSON. -/
def Schema.toJson (s : Schema) : Json :=
  Json.mkObj [
    ("kinds", objOf (s.kinds.map fun k => (k.name, k.toJson))),
    ("defaultCollapse", match s.defaultCollapse with
      | some c => Json.str c
      | none => Json.null)]

/-- An object as JSON. -/
def Object.toJson (o : Object) : Json :=
  Json.mkObj [
    ("id", Json.str o.id),
    ("kind", Json.str o.kind),
    ("boundary", Json.arr (o.boundary.map fun e =>
      Json.mkObj [("role", Json.str e.role), ("id", Json.str e.id)])),
    ("attrs", objOf (o.attrs.map fun (k, v) => (k, v.toJson))),
    ("body", Json.str o.body),
    ("source", Json.mkObj [("file", Json.str o.source.file),
                           ("anonymous", Json.bool o.source.anonymous)]),
    ("depth", Json.num (JsonNumber.fromInt o.depth))]

/-- A check as JSON. -/
def Check.toJson (c : Check) : Json :=
  Json.mkObj [
    ("level", Json.str c.level),
    ("code", Json.str c.code),
    ("message", Json.str c.message),
    ("objects", Json.arr (c.objects.map Json.str))]

/-- A compiled snapshot. -/
structure Snapshot where
  /-- Format version. -/
  version : Nat := snapshotVersion
  /-- Project configuration. -/
  project : Project
  /-- The schema. -/
  schema : Schema
  /-- All objects, sorted by id. -/
  objects : Array Object
  /-- The `decls` map of `lean-facts.json`, or `none`. -/
  facts : Option Json := none
  /-- Derived status per object. -/
  statuses : Array (String × DerivedStatus) := #[]
  /-- Progress per collapse kind per object. -/
  progress : Array (String × Array (String × Progress)) := #[]
  /-- Every check produced by `blueprint check`. -/
  checks : Array Check := #[]
  deriving Inhabited

/-- The snapshot of an analysis. -/
def Analysis.snapshot (a : Analysis) (facts : Option Facts := none) : Snapshot :=
  { project := a.blueprint.project
    schema := a.blueprint.schema
    objects := a.blueprint.objects
    facts := facts.map (·.json)
    statuses := a.statuses
    progress := a.progress
    checks := a.checks }

/-- A snapshot as JSON, exactly as `docs/snapshot-format.md` describes it. -/
def Snapshot.toJson (s : Snapshot) : Json :=
  Json.mkObj [
    ("version", Json.num (JsonNumber.fromInt s.version)),
    -- `katexMacros` is left out when the project declares none, so that a
    -- blueprint without maths macros has exactly the `project` it had before
    -- the field existed.
    ("project", Json.mkObj ([("name", Json.str s.project.name),
                             ("title", Json.str s.project.title),
                             ("dir", Json.str s.project.dir)] ++
      (if s.project.katexMacros.isEmpty then [] else
        [("katexMacros",
          objOf (s.project.katexMacros.map fun (n, d) => (n, Json.str d)))]))),
    ("schema", s.schema.toJson),
    ("objects", Json.arr (s.objects.map Object.toJson)),
    ("facts", s.facts.getD Json.null),
    ("derived", Json.mkObj [
      ("status", objOf (s.statuses.map fun (i, st) => (i, Json.str st.toString))),
      ("progress", objOf (s.progress.map fun (k, ps) =>
        (k, objOf (ps.map fun (i, p) => (i, Json.mkObj [
          ("proved", Json.num (JsonNumber.fromInt p.proved)),
          ("total", Json.num (JsonNumber.fromInt p.total))]))))),
      ("checks", Json.arr (s.checks.map Check.toJson))])]

/-! ## Reading -/

private def expectStr (j : Json) (what : String) : Except String String :=
  match j.getStr? with
  | .ok s => .ok s
  | .error _ => .error s!"expected a string for {what}"

private def expectNat (j : Json) (what : String) : Except String Nat :=
  match j.getNum? with
  | .ok n => if n.mantissa < 0 then .error s!"expected a natural number for {what}"
             else .ok n.mantissa.toNat
  | .error _ => .error s!"expected a number for {what}"

private def field? (j : Json) (k : String) : Option Json := (j.getObjVal? k).toOption

private def fieldStrD (j : Json) (k : String) (d : String) : String :=
  match field? j k with
  | some v => (v.getStr?).toOption.getD d
  | none => d

private def fieldBoolD (j : Json) (k : String) (d : Bool) : Bool :=
  match field? j k with
  | some v => (v.getBool?).toOption.getD d
  | none => d

private def fieldStrs (j : Json) (k : String) : Array String :=
  match field? j k with
  | some (.arr xs) => xs.filterMap fun (x : Json) => x.getStr?.toOption
  | _ => #[]

/-- Entries of a JSON object, sorted by key. -/
private def objEntries (j : Json) : Array (String × Json) :=
  match j.getObj? with
  | .ok o => (o.toArray).qsort (fun a b => a.1 < b.1)
  | .error _ => #[]

/-- Read an attribute value. -/
def AttrValue.ofJson? : Json → Option AttrValue
  | .str s => some (.str s)
  | .bool b => some (.bool b)
  | .num n => if n.exponent == 0 then some (.int n.mantissa) else some (.float n.toFloat)
  | .arr xs => some (.strs (xs.filterMap fun (x : Json) => x.getStr?.toOption))
  | _ => none

/-- Read a cardinality. -/
def Cardinality.ofJson (j : Json) : Cardinality :=
  let min := match field? j "min" with
    | some v => (expectNat v "min").toOption.getD 0
    | none => 0
  let max := match field? j "max" with
    | some Json.null => none
    | some v => (expectNat v "max").toOption
    | none => none
  { min, max }

/-- Read a kind declaration. -/
def KindSpec.ofJson (name : String) (j : Json) : KindSpec :=
  let kindsOf : Array (String × Json) := match field? j "kinds" with
    | some k => objEntries k
    | none => #[]
  let roles := (match field? j "boundary" with
    | some bd => objEntries bd
    | none => #[]).map fun (r, cv) =>
      ({ name := r, card := Cardinality.ofJson cv
         kinds := match kindsOf.find? (fun (p : String × Json) => p.1 == r) with
           | some (_, v) => match v with
             | .arr xs => xs.filterMap fun (x : Json) => x.getStr?.toOption
             | _ => #[]
           | none => #[] } : RoleSpec)
  { name, roles
    attrs := fieldStrs j "attrs"
    constraints := fieldStrs j "constraints"
    collapse := fieldBoolD j "collapse" false
    countable := fieldBoolD j "countable" false
    sugar := fieldBoolD j "sugar" false
    color := (field? j "color").bind fun (v : Json) => v.getStr?.toOption }

/-- Read a schema. -/
def Schema.ofJson (j : Json) : Schema :=
  { kinds := (match field? j "kinds" with
      | some k => objEntries k
      | none => #[]).map fun (n, v) => KindSpec.ofJson n v
    defaultCollapse := (field? j "defaultCollapse").bind fun (v : Json) => v.getStr?.toOption }

/-- Read an object. -/
def Object.ofJson (j : Json) : Except String Object := do
  let id ← expectStr ((field? j "id").getD Json.null) "object id"
  let kind := fieldStrD j "kind" ""
  let boundary := match field? j "boundary" with
    | some (.arr xs) => xs.filterMap fun (e : Json) =>
        match (field? e "role").bind (fun (v : Json) => v.getStr?.toOption),
              (field? e "id").bind (fun (v : Json) => v.getStr?.toOption) with
        | some role, some i => some ({ role, id := i } : BoundaryEntry)
        | _, _ => none
    | _ => #[]
  let attrs := (match field? j "attrs" with
    | some a => objEntries a
    | none => #[]).filterMap fun (k, v) => (AttrValue.ofJson? v).map fun a => (k, a)
  let src := (field? j "source").getD Json.null
  return {
    id, kind, boundary, attrs
    body := fieldStrD j "body" ""
    source := { file := fieldStrD src "file" "", anonymous := fieldBoolD src "anonymous" false }
    depth := match field? j "depth" with
      | some v => (expectNat v "depth").toOption.getD 0
      | none => 0 }

/-- Read a check. -/
def Check.ofJson (j : Json) : Check :=
  { level := fieldStrD j "level" "info"
    code := fieldStrD j "code" ""
    message := fieldStrD j "message" ""
    objects := fieldStrs j "objects" }

/-- Read a whole snapshot. -/
def Snapshot.ofJson (j : Json) : Except String Snapshot := do
  let version := match field? j "version" with
    | some v => (expectNat v "version").toOption.getD snapshotVersion
    | none => snapshotVersion
  if version != snapshotVersion then
    throw s!"unsupported snapshot version {version} (this tool speaks {snapshotVersion})"
  let p := (field? j "project").getD Json.null
  let katexMacros : Array (String × String) := match field? p "katexMacros" with
    | some m => (objEntries m).filterMap fun (n, v) => (v.getStr?.toOption).map (n, ·)
    | none => #[]
  let project : Project :=
    { name := fieldStrD p "name" "blueprint"
      title := fieldStrD p "title" ""
      dir := fieldStrD p "dir" "blueprint"
      katexMacros }
  let schema := Schema.ofJson ((field? j "schema").getD Json.null)
  let objects ← match field? j "objects" with
    | some (.arr xs) => xs.mapM Object.ofJson
    | _ => throw "'objects' must be an array"
  let facts := match field? j "facts" with
    | some Json.null => none
    | some f => some f
    | none => none
  let derived := (field? j "derived").getD Json.null
  let statusEntries : Array (String × Json) := match field? derived "status" with
    | some s => objEntries s
    | none => #[]
  let statuses : Array (String × DerivedStatus) := statusEntries.filterMap fun (i, v) =>
      (v.getStr?.toOption.bind DerivedStatus.ofString?).map fun st => (i, st)
  let progress := (match field? derived "progress" with
    | some s => objEntries s
    | none => #[]).map fun (k, v) =>
      (k, (objEntries v).map fun (i, pv) =>
        (i, ({ proved := match field? pv "proved" with
                 | some x => (expectNat x "proved").toOption.getD 0
                 | none => 0
               total := match field? pv "total" with
                 | some x => (expectNat x "total").toOption.getD 0
                 | none => 0 } : Progress)))
  let checks := match field? derived "checks" with
    | some (.arr xs) => xs.map Check.ofJson
    | _ => #[]
  return { version, project, schema, objects, facts, statuses, progress, checks }

/-- Parse a snapshot from text. -/
def Snapshot.parse (text : String) : Except String Snapshot := do
  Snapshot.ofJson (← Json.parse text)

/-- Render a snapshot, with a trailing newline. -/
def Snapshot.render (s : Snapshot) : String := s.toJson.pretty ++ "\n"

end Blueprint
