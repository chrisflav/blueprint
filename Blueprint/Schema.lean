import Blueprint.Toml

/-!
# The default schema and `blueprint.toml`

See `DESIGN.md` §2.3.  A project may declare kinds in `blueprint.toml`; each
`[kinds.X]` table extends (if `X` is a default kind) or introduces a kind.
-/

namespace Blueprint

/-! ## The default schema -/

/-- Attributes every node kind permits. -/
def defaultNodeAttrs : Array String :=
  #["title", "lean", "review", "tags", "order", "aliases", "owner"]

/-- Attributes every edge kind permits. -/
def defaultEdgeAttrs : Array String :=
  #["title", "review", "tags", "order", "aliases", "owner"]

/-- Cardinality "exactly one". -/
def cardOne : Cardinality := { min := 1, max := some 1 }

/-- A node kind of the default schema. -/
def mkNodeKind (name : String) (countable : Bool) (color : String) : KindSpec :=
  { name, roles := #[], attrs := defaultNodeAttrs, countable, color := some color }

/-- A binary (`src`/`tgt`) kind of the default schema. -/
def mkBinaryKind (name : String) (constraints : Array String := #[])
    (collapse : Bool := false) (sugar : Bool := true)
    (srcKinds : Array String := #[]) (tgtKinds : Array String := #[])
    (color : Option String := none) : KindSpec :=
  { name
    roles := #[{ name := "src", card := cardOne, kinds := srcKinds },
               { name := "tgt", card := cardOne, kinds := tgtKinds }]
    attrs := defaultEdgeAttrs, constraints, collapse, sugar, color }

/-- Kinds that a `commutes` hyperedge may relate. -/
def defaultEdgeKindNames : Array String :=
  #["uses", "implies", "refines", "instance_of", "generalises", "equivalent"]

/-- The schema that ships with the tool. -/
def defaultSchema : Schema where
  defaultCollapse := some "refines"
  kinds :=
    let ks : Array KindSpec := #[
      mkNodeKind "section" false "#8899aa",
      mkNodeKind "definition" true "#4a7",
      mkNodeKind "theorem" true "#47a",
      mkNodeKind "lemma" true "#57b",
      mkNodeKind "concept" false "#aa7",
      mkNodeKind "remark" false "#999",
      mkBinaryKind "uses" (color := some "#666"),
      mkBinaryKind "refines" (constraints := #["acyclic"]) (collapse := true)
        (color := some "#a55"),
      mkBinaryKind "instance_of" (constraints := #["acyclic"]) (collapse := true)
        (color := some "#5a5"),
      mkBinaryKind "generalises" (color := some "#77a"),
      mkBinaryKind "equivalent" (color := some "#7a7"),
      mkBinaryKind "implies" (color := some "#a77"),
      { name := "commutes"
        roles := #[{ name := "edges", card := { min := 2, max := none },
                     kinds := defaultEdgeKindNames }]
        attrs := defaultEdgeAttrs, sugar := false, color := some "#c93" } ]
    ks.qsort (fun a b => a.name < b.name)

/-! ## Parsing `blueprint.toml` -/

/-- Parse a cardinality such as `"1"`, `"0..1"`, `"1.."`, `"2..5"`. -/
def parseCardinality (s : String) : Except String Cardinality := do
  let s := trim s
  if s.isEmpty then throw "empty cardinality"
  match (s.splitOn "..") with
  | [one] =>
    match one.toNat? with
    | some n => return { min := n, max := some n }
    | none => throw s!"cannot parse cardinality '{s}'"
  | [lo, hi] =>
    let lo := trim lo
    let hi := trim hi
    let min ← if lo.isEmpty then pure 0 else
      match lo.toNat? with
      | some n => pure n
      | none => throw s!"cannot parse cardinality '{s}'"
    let max ← if hi.isEmpty then pure none else
      match hi.toNat? with
      | some n => pure (some n)
      | none => throw s!"cannot parse cardinality '{s}'"
    return { min, max }
  | _ => throw s!"cannot parse cardinality '{s}'"

/-- Parse a cardinality given either as a string or an integer. -/
def parseCardinalityValue (v : TValue) : Except String Cardinality :=
  match v with
  | .str s => parseCardinality s
  | .int n => if n < 0 then throw "negative cardinality"
              else return { min := n.toNat, max := some n.toNat }
  | v => throw s!"expected a cardinality string, got a {v.typeName}"

/-- Decode one `[kinds.X]` table on top of a possibly existing declaration. -/
def decodeKind (name : String) (base : Option KindSpec) (t : TValue) :
    Except String KindSpec := do
  let mut k : KindSpec := base.getD { name }
  -- allowed kinds per role
  let roleKinds : Array (String × Array String) ←
    match t.get? "kinds" with
    | none => pure #[]
    | some (.table xs) =>
      xs.foldlM (init := #[]) fun acc (r, v) =>
        match v.asStrings? with
        | some ss => pure (acc.push (r, ss))
        | none => throw s!"kind '{name}': role '{r}' expects an array of kind names"
    | some v => throw s!"kind '{name}': 'kinds' must be a table, got a {v.typeName}"
  match t.get? "boundary" with
  | none =>
    -- no boundary given: only update the allowed kinds of existing roles
    k := { k with roles := k.roles.map fun r =>
             match roleKinds.find? (·.1 == r.name) with
             | some (_, ks) => { r with kinds := ks }
             | none => r }
  | some (.table xs) =>
    let roles ← xs.foldlM (init := #[]) fun acc (r, v) => do
      let card ← parseCardinalityValue v
      let kinds := (roleKinds.find? (·.1 == r)).map (·.2) |>.getD #[]
      return acc.push ({ name := r, card, kinds } : RoleSpec)
    k := { k with roles }
  | some v => throw s!"kind '{name}': 'boundary' must be a table, got a {v.typeName}"
  if let some v := t.get? "attrs" then
    match v.asStrings? with
    | some ss => k := { k with attrs := ss }
    | none => throw s!"kind '{name}': 'attrs' must be an array of strings"
  if let some v := t.get? "constraints" then
    match v.asStrings? with
    | some ss => k := { k with constraints := ss }
    | none => throw s!"kind '{name}': 'constraints' must be an array of strings"
  if let some v := t.get? "constraint" then
    match v.asStrings? with
    | some ss => k := { k with constraints := ss }
    | none => throw s!"kind '{name}': 'constraint' must be a string or array of strings"
  for c in k.constraints do
    unless c == "acyclic" || c == "unique" do
      throw s!"kind '{name}': unknown constraint '{c}' (expected 'acyclic' or 'unique')"
  if let some v := t.get? "collapse" then
    match v.asBool? with
    | some b => k := { k with collapse := b }
    | none => throw s!"kind '{name}': 'collapse' must be a boolean"
  if let some v := t.get? "countable" then
    match v.asBool? with
    | some b => k := { k with countable := b }
    | none => throw s!"kind '{name}': 'countable' must be a boolean"
  if let some v := t.get? "sugar" then
    match v.asBool? with
    | some b => k := { k with sugar := b }
    | none => throw s!"kind '{name}': 'sugar' must be a boolean"
  if let some v := t.get? "color" then
    match v.asString? with
    | some s => k := { k with color := some s }
    | none => throw s!"kind '{name}': 'color' must be a string"
  return k

/-- Decode a whole `blueprint.toml` on top of the default schema. -/
def decodeConfig (t : TValue) (defaultName : String) :
    Except String (Project × Schema) := do
  let proj := t.get? "project"
  let lookup (k : String) : Option TValue :=
    match proj.bind (·.get? k) with
    | some v => some v
    | none => t.get? k
  let getStr (k : String) : Except String (Option String) :=
    match lookup k with
    | none => return none
    | some (.str s) => return some s
    | some v => throw s!"'{k}' must be a string, got a {v.typeName}"
  let name := (← getStr "name").getD defaultName
  let title := (← getStr "title").getD name
  let dir := (← getStr "dir").getD "blueprint"
  let leanModules ← match t.get? "lean" |>.bind (·.get? "modules") with
    | none => pure #[]
    | some v => match v.asStrings? with
      | some ss => pure ss
      | none => throw "'[lean] modules' must be a string or an array of strings"
  let katexMacros ← match (t.get? "katex").bind (·.get? "macros") with
    | none => pure #[]
    | some (.table xs) =>
      let ms ← xs.foldlM (init := #[]) fun acc (k, v) =>
        match v.asString? with
        | some s => pure (acc.push (k, s))
        | none => throw s!"'[katex.macros] {k}' must be a string, got a {v.typeName}"
      pure (ms.qsort (fun a b => a.1 < b.1))
    | some v => throw s!"'[katex.macros]' must be a table, got a {v.typeName}"
  let project : Project := { name, title, dir, leanModules, katexMacros }
  let mut schema := defaultSchema
  if let some v := lookup "defaultCollapse" then
    match v.asString? with
    | some s => schema := { schema with defaultCollapse := some s }
    | none => throw "'defaultCollapse' must be a string"
  match t.get? "kinds" with
  | none => pure ()
  | some (.table xs) =>
    for (kname, kv) in xs do
      match kv with
      | .table _ =>
        let k ← decodeKind kname (schema.kind? kname) kv
        schema := schema.insertKind k
      | v => throw s!"'[kinds.{kname}]' must be a table, got a {v.typeName}"
  | some v => throw s!"'kinds' must be a table, got a {v.typeName}"
  if let some c := schema.defaultCollapse then
    match schema.kind? c with
    | none => throw s!"defaultCollapse names an unknown kind '{c}'"
    | some k => unless k.collapse do
        throw s!"defaultCollapse names '{c}', which is not declared collapse = true"
  return (project, schema)

/-- Read `blueprint.toml` from `root`.  When there is no such file the default
schema is used and the project is named after the directory. -/
def loadConfig (root : System.FilePath) : IO (Project × Schema) := do
  let file := root / "blueprint.toml"
  let defaultName := (root.fileName.getD "blueprint")
  unless (← file.pathExists) do
    return ({ name := defaultName, title := defaultName, dir := "blueprint" }, defaultSchema)
  let input ← IO.FS.readFile file
  match ← parseToml input file.toString with
  | .error e => throw <| IO.userError s!"{file}: {e}"
  | .ok t =>
    match decodeConfig t defaultName with
    | .error e => throw <| IO.userError s!"{file}: {e}"
    | .ok r => return r

end Blueprint
