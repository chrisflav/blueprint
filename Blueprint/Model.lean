/-!
# Core data model

One sort of thing: the `Object`.  Nodes, edges, hyperedges and edges between
edges are all objects, distinguished only by their `boundary`.

See `DESIGN.md` §2.
-/

namespace Blueprint

/-! ## Small utilities -/

/-- Replace every occurrence of `pat` in `s` by `repl`. -/
def replaceAll (s pat repl : String) : String :=
  if pat.isEmpty then s else String.intercalate repl (s.splitOn pat)

/-- Sort an array of strings, dropping duplicates. -/
def sortDedup (xs : Array String) : Array String :=
  let sorted := xs.qsort (fun a b => a < b)
  sorted.foldl (init := #[]) fun acc x =>
    if acc.back?.any (· == x) then acc else acc.push x

/-! ## Attribute values -/

/-- A value of an object attribute: string, number, boolean or array of strings. -/
inductive AttrValue where
  /-- A string. -/
  | str   (s : String)
  /-- An integer. -/
  | int   (n : Int)
  /-- A floating point number. -/
  | float (f : Float)
  /-- A boolean. -/
  | bool  (b : Bool)
  /-- An array of strings. -/
  | strs  (xs : Array String)
  deriving Inhabited, BEq

namespace AttrValue

/-- View an attribute value as a list of strings. -/
def asStrings : AttrValue → Array String
  | .str s  => #[s]
  | .strs xs => xs
  | _ => #[]

/-- View an attribute value as a single string, if it is one. -/
def asString? : AttrValue → Option String
  | .str s => some s
  | _ => none

/-- Human readable rendering, used in CLI output and error messages. -/
def toString : AttrValue → String
  | .str s   => s
  | .int n   => ToString.toString n
  | .float f => ToString.toString f
  | .bool b  => if b then "true" else "false"
  | .strs xs => "[" ++ String.intercalate ", " xs.toList ++ "]"

instance : ToString AttrValue := ⟨AttrValue.toString⟩

end AttrValue

/-! ## Objects -/

/-- One entry of an object's boundary: a role name and the id of an object. -/
structure BoundaryEntry where
  /-- The role this boundary entry fills. -/
  role : String
  /-- The id of the object sitting in that role. -/
  id : String
  deriving Inhabited, BEq

/-- Where an object came from. -/
structure Source where
  /-- Path of the file, relative to the project root. -/
  file : String
  /-- `true` for objects created by sugar rather than written out. -/
  anonymous : Bool := false
  deriving Inhabited, BEq

/-- An object: a node, an edge, a hyperedge, or an edge between edges. -/
structure Object where
  /-- Stable human readable identifier. -/
  id : String
  /-- Name of a kind declared in the schema. -/
  kind : String
  /-- Ordered list of (role, object id) pairs; empty for a node. -/
  boundary : Array BoundaryEntry := #[]
  /-- Attributes permitted by the kind, sorted by key. -/
  attrs : Array (String × AttrValue) := #[]
  /-- Informal prose, Markdown with LaTeX. -/
  body : String := ""
  /-- Provenance. -/
  source : Source
  /-- `0` for a node, else `1 + max` of the depths of the boundary. -/
  depth : Nat := 0
  deriving Inhabited, BEq

namespace Object

/-- Look up an attribute. -/
def attr? (o : Object) (k : String) : Option AttrValue :=
  (o.attrs.find? (fun p => p.1 == k)).map (·.2)

/-- An attribute as an array of strings (`[]` if absent). -/
def attrStrings (o : Object) (k : String) : Array String :=
  match o.attr? k with
  | some v => v.asStrings
  | none => #[]

/-- Set (or replace) an attribute, keeping `attrs` sorted by key. -/
def setAttr (o : Object) (k : String) (v : AttrValue) : Object :=
  let attrs := (o.attrs.filter (fun p => p.1 != k)).push (k, v)
  { o with attrs := attrs.qsort (fun a b => a.1 < b.1) }

/-- The ids appearing in a given role. -/
def role (o : Object) (r : String) : Array String :=
  (o.boundary.filter (fun e => e.role == r)).map (·.id)

/-- The single id in role `r`, if there is exactly one. -/
def role1? (o : Object) (r : String) : Option String :=
  match o.role r with
  | #[x] => some x
  | _ => none

/-- Source of a binary edge. -/
def src? (o : Object) : Option String := o.role1? "src"

/-- Target of a binary edge. -/
def tgt? (o : Object) : Option String := o.role1? "tgt"

end Object

/-! ## Schema -/

/-- A role cardinality such as `1`, `0..1`, `1..`, `2..`. -/
structure Cardinality where
  /-- Minimum number of boundary entries in this role. -/
  min : Nat := 0
  /-- Maximum number of entries, `none` for unbounded. -/
  max : Option Nat := none
  deriving Inhabited, BEq

namespace Cardinality

/-- Render a cardinality the way it is written in `blueprint.toml`. -/
def toString (c : Cardinality) : String :=
  match c.max with
  | some m => if m == c.min then ToString.toString c.min
              else s!"{c.min}..{m}"
  | none => s!"{c.min}.."

instance : ToString Cardinality := ⟨Cardinality.toString⟩

/-- Does `n` satisfy the cardinality? -/
def admits (c : Cardinality) (n : Nat) : Bool :=
  c.min ≤ n && (match c.max with | some m => n ≤ m | none => true)

end Cardinality

/-- A role declared by a kind. -/
structure RoleSpec where
  /-- The role name, e.g. `src`. -/
  name : String
  /-- How many objects may sit in this role. -/
  card : Cardinality := {}
  /-- Kinds allowed in this role; empty means any kind. -/
  kinds : Array String := #[]
  deriving Inhabited, BEq

/-- The declaration of a kind: roles, attributes, constraints, display hints. -/
structure KindSpec where
  /-- The kind's name. -/
  name : String
  /-- Declared roles, in the order used for deriving ids. -/
  roles : Array RoleSpec := #[]
  /-- Permitted attribute keys. -/
  attrs : Array String := #[]
  /-- Constraints, drawn from `acyclic` and `unique`. -/
  constraints : Array String := #[]
  /-- May drive views (see `DESIGN.md` §3). -/
  collapse : Bool := false
  /-- Contributes to progress fractions. -/
  countable : Bool := false
  /-- Usable as a front matter key. -/
  sugar : Bool := false
  /-- Optional display hint. -/
  color : Option String := none
  deriving Inhabited, BEq

namespace KindSpec

/-- Is `c` among the kind's constraints? -/
def hasConstraint (k : KindSpec) (c : String) : Bool := k.constraints.contains c

/-- Find a role declaration by name. -/
def role? (k : KindSpec) (r : String) : Option RoleSpec := k.roles.find? (·.name == r)

/-- A binary kind has exactly the two roles `src` and `tgt`. -/
def isBinary (k : KindSpec) : Bool :=
  k.roles.size == 2 && k.roles[0]!.name == "src" && k.roles[1]!.name == "tgt"

/-- A node kind has no roles. -/
def isNode (k : KindSpec) : Bool := k.roles.isEmpty

end KindSpec

/-- The schema: all kinds plus the default collapse kind. -/
structure Schema where
  /-- All declared kinds, sorted by name. -/
  kinds : Array KindSpec := #[]
  /-- The kind used by `view` when none is given. -/
  defaultCollapse : Option String := none
  deriving Inhabited, BEq

namespace Schema

/-- Look up a kind by name. -/
def kind? (s : Schema) (n : String) : Option KindSpec := s.kinds.find? (·.name == n)

/-- Insert or replace a kind, keeping `kinds` sorted by name. -/
def insertKind (s : Schema) (k : KindSpec) : Schema :=
  let kinds := (s.kinds.filter (·.name != k.name)).push k
  { s with kinds := kinds.qsort (fun a b => a.name < b.name) }

/-- Names of all collapsible kinds. -/
def collapseKinds (s : Schema) : Array String :=
  (s.kinds.filter (·.collapse)).map (·.name)

/-- Names of all kinds usable as front matter sugar. -/
def sugarKinds (s : Schema) : Array String :=
  (s.kinds.filter (·.sugar)).map (·.name)

/-- The collapse kind to use by default: `defaultCollapse` if set, else the
first collapsible kind. -/
def mainCollapse? (s : Schema) : Option String :=
  match s.defaultCollapse with
  | some k => some k
  | none => s.collapseKinds[0]?

end Schema

/-! ## Project and blueprint -/

/-- Project level configuration from `blueprint.toml`. -/
structure Project where
  /-- Short name. -/
  name : String := "blueprint"
  /-- Human readable title. -/
  title : String := ""
  /-- Directory holding the Markdown sources, relative to the root. -/
  dir : String := "blueprint"
  /-- Modules `blueprint extract` imports when the command line names none;
  `[lean] modules` in `blueprint.toml`. -/
  leanModules : Array String := #[]
  deriving Inhabited, BEq

/-- A check produced by `blueprint check`. -/
structure Check where
  /-- `error`, `warning` or `info`. -/
  level : String
  /-- Machine readable code, see `docs/snapshot-format.md`. -/
  code : String
  /-- Human readable explanation, with file paths where useful. -/
  message : String
  /-- Object ids the check is about. -/
  objects : Array String := #[]
  deriving Inhabited, BEq

namespace Check

/-- An error level check. -/
def error (code message : String) (objects : Array String := #[]) : Check :=
  { level := "error", code, message, objects }

/-- A warning level check. -/
def warning (code message : String) (objects : Array String := #[]) : Check :=
  { level := "warning", code, message, objects }

/-- An info level check. -/
def info (code message : String) (objects : Array String := #[]) : Check :=
  { level := "info", code, message, objects }

/-- Rank of a level, for sorting: errors first. -/
def levelRank (l : String) : Nat :=
  if l == "error" then 0 else if l == "warning" then 1 else 2

/-- Deterministic order on checks. -/
def lt (a b : Check) : Bool :=
  let ra := levelRank a.level
  let rb := levelRank b.level
  if ra != rb then ra < rb
  else if a.code != b.code then a.code < b.code
  else if a.objects != b.objects then
    String.intercalate "," a.objects.toList < String.intercalate "," b.objects.toList
  else a.message < b.message

/-- Render as one line. -/
def render (c : Check) : String :=
  let objs := if c.objects.isEmpty then "" else
    " (" ++ String.intercalate ", " c.objects.toList ++ ")"
  s!"{c.level}: [{c.code}] {c.message}{objs}"

end Check

/-- Sort checks deterministically. -/
def sortChecks (cs : Array Check) : Array Check := cs.qsort Check.lt

/-- Are any of these checks errors? -/
def hasErrors (cs : Array Check) : Bool := cs.any (·.level == "error")

end Blueprint

/-- A whole blueprint: configuration, schema and objects. -/
structure Blueprint where
  /-- Project configuration. -/
  project : Blueprint.Project
  /-- The schema. -/
  schema : Blueprint.Schema
  /-- All objects, sorted by id. -/
  objects : Array Blueprint.Object := #[]
  deriving Inhabited

namespace Blueprint

/-- Build a blueprint, sorting the objects by id. -/
def ofObjects (project : Project) (schema : Schema) (objects : Array Object) : Blueprint :=
  { project, schema, objects := objects.qsort (fun a b => a.id < b.id) }

/-- Index of the object with the given id, by binary search over the sorted array. -/
def findIdx? (b : Blueprint) (id : String) : Option Nat :=
  go b.objects.size 0 b.objects.size
where
  /-- Binary search helper, structurally recursive on the fuel. -/
  go : Nat → Nat → Nat → Option Nat
  | 0, _, _ => none
  | fuel + 1, lo, hi =>
    if lo < hi then
      let mid := (lo + hi) / 2
      match b.objects[mid]? with
      | none => none
      | some o =>
        if o.id == id then some mid
        else if o.id < id then go fuel (mid + 1) hi
        else go fuel lo mid
    else none

/-- Look up an object by id. -/
def find? (b : Blueprint) (id : String) : Option Object :=
  match b.findIdx? id with
  | some i => b.objects[i]?
  | none => none

/-- Does an object with this id exist? -/
def contains (b : Blueprint) (id : String) : Bool := (b.findIdx? id).isSome

/-- The kind declaration of an object, if the kind is known. -/
def kindOf? (b : Blueprint) (o : Object) : Option KindSpec := b.schema.kind? o.kind

/-- All objects of a given kind. -/
def ofKind (b : Blueprint) (k : String) : Array Object := b.objects.filter (·.kind == k)

end Blueprint

namespace Blueprint

/-! ## String helpers

The 4.34 toolchain returns slices from the `trim` family; these wrappers keep
the rest of the code in terms of `String`.
-/

/-- Drop leading and trailing ASCII whitespace. -/
def trim (s : String) : String := s.trimAscii.copy

/-- Drop leading ASCII whitespace. -/
def trimStart (s : String) : String := s.trimAsciiStart.copy

/-- Drop trailing ASCII whitespace. -/
def trimEnd (s : String) : String := s.trimAsciiEnd.copy

/-- Split a string into lines, keeping empty trailing lines out. -/
def splitLines (s : String) : Array String :=
  (s.splitOn "\n").toArray.map fun l =>
    if l.endsWith "\r" then l.dropEnd 1 |>.copy else l

end Blueprint
