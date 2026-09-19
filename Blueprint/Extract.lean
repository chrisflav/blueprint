import Lean
import Blueprint.Attr
import Blueprint.Json

/-!
# The extractor

`DESIGN.md` §5 and the `lean-facts.json` section of
`docs/snapshot-format.md`.  `blueprint extract` imports a project's modules
the way doc-gen4 does and writes, for every constant the blueprint names,
its existence, kind, signature, module, source range, docstring, derived
status, axioms and blueprint dependencies.

The set of constants is the union of

* the keys of the `@[blueprint]` map of the imported environment,
* the `lean` attributes of the blueprint sources (`--root`) or of a
  snapshot (`--snapshot`),
* the names given with `--names`.
-/

namespace Blueprint

open Lean

/-! ## Facts about one constant -/

/-- The source range of a declaration. -/
structure DeclRange where
  /-- Path of the file, relative to the working directory when the source
  search path finds it below it, else derived from the module name. -/
  file : String
  /-- First line of the declaration, 1 based. -/
  startLine : Nat
  /-- Last line of the declaration, 1 based. -/
  endLine : Nat
  deriving Inhabited, BEq

/-- Everything `lean-facts.json` records about one constant. -/
structure DeclFacts where
  /-- The constant's name. -/
  name : String
  /-- Whether the constant is in the environment. -/
  present : Bool
  /-- `theorem`, `definition`, `axiom`, `inductive`, `structure`,
  `instance`, `opaque` or `other`. -/
  kind : String := "other"
  /-- Pretty printed `kind name : type`. -/
  signature : String := ""
  /-- The module the constant lives in. -/
  module : String := ""
  /-- Where in the sources it is, when Lean knows. -/
  range : Option DeclRange := none
  /-- The docstring, when there is one. -/
  doc : Option String := none
  /-- `stated`, `proved` or `proved_with_axioms`. -/
  status : String := "proved"
  /-- Every axiom the constant depends on, sorted. -/
  axioms : Array String := #[]
  /-- The mapped constants it depends on, sorted. -/
  deps : Array String := #[]
  deriving Inhabited

/-- One constant as JSON, exactly as `docs/snapshot-format.md` describes. -/
def DeclFacts.toJson (d : DeclFacts) : Json :=
  if !d.present then Json.mkObj [("exists", Json.bool false)] else
  Json.mkObj [
    ("exists", Json.bool true),
    ("kind", Json.str d.kind),
    ("signature", Json.str d.signature),
    ("module", Json.str d.module),
    ("range", match d.range with
      | none => Json.null
      | some r => Json.mkObj [
          ("file", Json.str r.file),
          ("startLine", Json.num (JsonNumber.fromInt r.startLine)),
          ("endLine", Json.num (JsonNumber.fromInt r.endLine))]),
    ("doc", match d.doc with | none => Json.null | some s => Json.str s),
    ("status", Json.str d.status),
    ("axioms", Json.arr (d.axioms.map Json.str)),
    ("deps", Json.arr (d.deps.map Json.str))]

/-- The whole `lean-facts.json` document. -/
structure LeanFacts where
  /-- The modules that were imported. -/
  modules : Array String
  /-- The `@[blueprint]` map: constant name to object id. -/
  attrMap : Array (String × String)
  /-- One entry per requested constant, sorted by name. -/
  decls : Array DeclFacts
  deriving Inhabited

/-- The document as JSON.  Keys are sorted throughout, so two runs over the
same environment produce byte identical files. -/
def LeanFacts.toJson (f : LeanFacts) : Json :=
  Json.mkObj [
    ("version", Json.num (JsonNumber.fromInt snapshotVersion)),
    ("modules", Json.arr (f.modules.map Json.str)),
    ("attrMap", Json.mkObj ((f.attrMap.qsort (fun a b => a.1 < b.1)).toList.map
      fun (n, i) => (n, Json.str i))),
    ("decls", Json.mkObj ((f.decls.qsort (fun a b => a.name < b.name)).toList.map
      fun d => (d.name, d.toJson)))]

/-- The document, rendered with a trailing newline. -/
def LeanFacts.render (f : LeanFacts) : String := f.toJson.pretty ++ "\n"

/-! ## The constant dependency graph

Everything below walks the graph iteratively and memoises, so a project with
thousands of constants costs one pass over the reachable part.
-/

/-- Sort names and drop duplicates. -/
def sortDedupNames (xs : Array Name) : Array Name :=
  let sorted := xs.qsort Name.lt
  sorted.foldl (init := #[]) fun acc x =>
    if acc.back?.any (· == x) then acc else acc.push x

/-- The constants named by a declaration's type, value and — for an
inductive type — its constructors.  The same set `Lean.collectAxioms` walks. -/
def directDeps (env : Environment) (n : Name) : Array Name :=
  match env.find? n with
  | none => #[]
  | some info =>
    let fromValue : Array Name := match info.value? (allowOpaque := true) with
      | some v => v.getUsedConstants
      | none => #[]
    let fromCtors : Array Name := match info with
      | .inductInfo v => v.ctors.toArray
      | _ => #[]
    sortDedupNames (info.type.getUsedConstants ++ fromValue ++ fromCtors)

/-- The part of the constant dependency graph reachable from some roots, in
an order that puts every constant after the ones it depends on. -/
structure DepGraph where
  /-- Reachable constants, dependencies first. -/
  order : Array Name
  /-- Direct dependencies of every reachable constant. -/
  direct : Std.HashMap Name (Array Name)
  deriving Inhabited

/-- Depth first search with an explicit stack: no `partial`, and no risk of
blowing the Lean stack on a deep dependency chain.  Constants on a cycle (the
graph should not have any) are visited once and contribute what was known
when they were reached. -/
def buildDepGraph (env : Environment) (roots : Array Name) : DepGraph := Id.run do
  let mut direct : Std.HashMap Name (Array Name) := {}
  -- `false` while the children are being visited, `true` once emitted
  let mut state : Std.HashMap Name Bool := {}
  let mut order : Array Name := #[]
  let mut stack : Array (Name × Bool) := roots.reverse.map (fun n => (n, false))
  while 0 < stack.size do
    let (n, expanded) := stack.back!
    stack := stack.pop
    if expanded then
      if state[n]? == some false then
        state := state.insert n true
        order := order.push n
    else if state.contains n then
      pure ()
    else
      let ds := directDeps env n
      state := state.insert n false
      direct := direct.insert n ds
      stack := stack.push (n, true)
      for d in ds do
        unless state.contains d do
          stack := stack.push (d, false)
  return { order, direct }

/-- For every reachable constant, the axioms it depends on, sorted.  This is
`#print axioms`, computed once for the whole graph. -/
def axiomsOf (env : Environment) (g : DepGraph) : Std.HashMap Name (Array Name) := Id.run do
  let mut m : Std.HashMap Name (Array Name) := {}
  for n in g.order do
    let isAxiom := match env.find? n with
      | some (.axiomInfo _) => true
      | _ => false
    let mut acc : Array Name := if isAxiom then #[n] else #[]
    for d in g.direct.getD n #[] do
      acc := acc ++ m.getD d #[]
    m := m.insert n (sortDedupNames acc)
  return m

/-- For every reachable constant, the mapped constants below it, stopping at
mapped constants: `below n = {n}` when `n` is mapped, and the union of the
`below` of its direct dependencies otherwise. -/
def mappedBelow (g : DepGraph) (mapped : Std.HashSet Name) :
    Std.HashMap Name (Array Name) := Id.run do
  let mut m : Std.HashMap Name (Array Name) := {}
  for n in g.order do
    if mapped.contains n then
      m := m.insert n #[n]
    else
      let mut acc : Array Name := #[]
      for d in g.direct.getD n #[] do
        acc := acc ++ m.getD d #[]
      m := m.insert n (sortDedupNames acc)
  return m

/-! ## Reading one declaration -/

/-- The axioms a `proved` declaration may use without being flagged. -/
def standardAxioms : Array Name := #[``propext, ``Classical.choice, ``Quot.sound]

/-- `stated` when `sorryAx` is among the axioms, `proved_with_axioms` when
anything outside the standard three is, else `proved`. -/
def statusOfAxioms (axs : Array Name) : String :=
  if axs.contains ``sorryAx then "stated"
  else if axs.any (fun a => !standardAxioms.contains a) then "proved_with_axioms"
  else "proved"

/-- The declaration kind as `docs/snapshot-format.md` spells it. -/
def declKind (env : Environment) (n : Name) (isInst : Bool) : String :=
  if isStructure env n then "structure" else
  match env.find? n with
  | some (.axiomInfo _) => "axiom"
  | some (.thmInfo _) => "theorem"
  | some (.inductInfo _) => "inductive"
  | some (.opaqueInfo _) => "opaque"
  | some (.defnInfo _) => if isInst then "instance" else "definition"
  | _ => "other"

/-- The keyword the signature is prefixed with. -/
def kindKeyword : String → String
  | "theorem" => "theorem"
  | "axiom" => "axiom"
  | "inductive" => "inductive"
  | "structure" => "structure"
  | "instance" => "instance"
  | "opaque" => "opaque"
  | "definition" => "def"
  | _ => "def"

/-- The module a constant was declared in. -/
def moduleOf? (env : Environment) (n : Name) : Option Name := do
  let idx ← env.getModuleIdxFor? n
  env.header.moduleNames[idx.toNat]?

/-- `A.B` becomes `A/B.lean`. -/
def moduleRelPath (mod : Name) : String :=
  String.intercalate "/" (mod.components.map fun c => c.toString (escape := false)) ++ ".lean"

/-- Where a module's source lives, relative to the working directory when it
is below it, else the path derived from the module name. -/
def moduleFile (srcPath : SearchPath) (cwd : System.FilePath) (mod : Name) : IO String := do
  let derived := moduleRelPath mod
  match ← srcPath.findWithExt "lean" mod with
  | none => return derived
  | some p =>
    let prefix_ := cwd.toString ++ "/"
    let s := (← IO.FS.realPath p).toString
    return if prefix_.isPrefixOf s then (s.drop prefix_.length).copy else derived

/-! ## Producing the facts -/

/-- The pretty printer options the signatures are rendered with. -/
def ppOptions : Options :=
  (Options.empty.set `format.width (100 : Nat)).setBool `pp.fullNames true

/-- Run a `CoreM` action against an imported environment. -/
def runCore (env : Environment) (x : CoreM α) : IO α := do
  let (a, _) ← x.toIO
    { fileName := "<blueprint extract>", fileMap := default, options := ppOptions,
      maxHeartbeats := 0, maxRecDepth := 4096 }
    { env }
  return a

/-- Read the facts of every requested constant.  `names` is the full mapped
set; the dependency walk stops at any of them. -/
def declFactsOf (env : Environment) (names : Array Name) (srcPath : SearchPath)
    (cwd : System.FilePath) : IO (Array DeclFacts) := do
  let g := buildDepGraph env names
  let axs := axiomsOf env g
  let below := mappedBelow g (Std.HashSet.ofArray names)
  -- resolve each module's source file once rather than once per constant
  let mut files : Std.HashMap Name String := {}
  for m in sortDedupNames (names.filterMap (moduleOf? env ·)) do
    files := files.insert m (← moduleFile srcPath cwd m)
  runCore env do
    let mut out : Array DeclFacts := #[]
    for n in names do
      let nameStr := n.toString (escape := false)
      if (env.find? n).isNone then
        out := out.push { name := nameStr, present := false }
        continue
      let axioms := axs.getD n #[]
      -- the mapped constants below the direct dependencies; a constant is
      -- never a dependency of itself
      let mut depsAcc : Array Name := #[]
      for d in g.direct.getD n #[] do
        depsAcc := depsAcc ++ below.getD d #[]
      let deps := (sortDedupNames depsAcc).filter (· != n)
      let kind := declKind env n (← Meta.isInstance n)
      let signature ←
        try
          let fmt ← Meta.MetaM.run' (do return (← PrettyPrinter.ppSignature n).fmt)
          pure (kindKeyword kind ++ " " ++ fmt.pretty (width := 100))
        catch _ =>
          pure (kindKeyword kind ++ " " ++ nameStr)
      -- Lean keeps the whitespace before the closing `-/`; trim the ends.
      let doc := (← findDocString? env n).map trim
      let mod? := moduleOf? env n
      let range := match ← findDeclarationRanges? n, mod?.bind (files[·]?) with
        | some r, some file =>
          some { file, startLine := r.range.pos.line, endLine := r.range.endPos.line }
        | _, _ => none
      out := out.push {
        name := nameStr, present := true, kind, signature,
        module := (mod?.getD Name.anonymous).toString (escape := false),
        range, doc,
        status := statusOfAxioms axioms,
        axioms := sortDedup (axioms.map (·.toString (escape := false))),
        deps := sortDedup (deps.map (·.toString (escape := false))) }
    return out

/-- Import `modules` and produce the facts for `names` together with every
`@[blueprint]` tagged constant of the imported environment.

`loadExts := true` is what makes docstrings, declaration ranges and the
`@[blueprint]` extension visible, and it needs the initialisers of the
imported modules to run, hence `enableInitializersExecution` and
`supportInterpreter = true` on the executable. -/
unsafe def extractUnsafe (modules : Array Name) (names : Array String) : IO LeanFacts := do
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let env ← importModules (modules.map fun m => { module := m }) ppOptions
    (loadExts := true)
  let attrEntries := blueprintEntries env
  let attrMap := attrEntries.map fun e => (e.decl.toString (escape := false), e.id)
  let allNames := sortDedupNames
    ((names.map String.toName) ++ attrEntries.map (·.decl))
  let srcPath : SearchPath :=
    ((← IO.getEnv "LEAN_SRC_PATH").map System.SearchPath.parse |>.getD []) ++ [← IO.currentDir]
  let cwd ← IO.FS.realPath (← IO.currentDir)
  let decls ← declFactsOf env allNames srcPath cwd
  return { modules := (sortDedup (modules.map fun m => m.toString (escape := false))),
           attrMap, decls }

/-- `extractUnsafe`, wrapped so that the rest of the tool stays safe. -/
@[implemented_by extractUnsafe]
opaque extract (modules : Array Name) (names : Array String) : IO LeanFacts

end Blueprint
