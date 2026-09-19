import Blueprint.Json
import Blueprint.Git

/-!
# Semantic diff across snapshots

`DESIGN.md` §7.  Two snapshots are compared as *objects*, not as text: the
objects are matched by id, then by `aliases`, and what comes out is the list
of objects added, removed, renamed, and changed in kind, boundary, body,
attributes or derived status.

Each side is either a `blueprint.json` on disk or a git revision, whose tree
is materialised into a temporary directory and compiled in memory.

The same machinery serves `blueprint log`, which compares one object across
the revisions that touched its file, and `blueprint progress --since`.
-/

namespace Blueprint

open Lean (Json JsonNumber)

/-! ## Building a snapshot -/

/-- A parsed project: the blueprint plus the checks found while parsing. -/
structure Loaded where
  /-- The blueprint. -/
  blueprint : Blueprint
  /-- Checks from the parser. -/
  checks : Array Check
  deriving Inhabited

/-- Read `blueprint.toml` and every Markdown source under the project root. -/
def load (root : System.FilePath) : IO Loaded := do
  let (project, schema) ← loadConfig root
  let r ← parseProject root project schema
  return { blueprint := Blueprint.ofObjects project schema r.objects, checks := r.checks }

/-- Load the Lean facts, if a file is there. -/
def loadFactsIfPresent (path : System.FilePath) : IO (Option Facts) := do
  if ← path.pathExists then return some (← loadFacts path) else return none

/-- Compile the project at `root` into a snapshot, in memory.  Lean facts are
taken from `<root>/lean-facts.json` when that file is part of the tree. -/
def buildSnapshotAt (root : System.FilePath) : IO Snapshot := do
  let l ← load root
  let facts ← loadFactsIfPresent (root / "lean-facts.json")
  let a := analyse l.blueprint l.checks facts none
  return a.snapshot facts

/-- Read a snapshot from a `blueprint.json`. -/
def readSnapshot (path : System.FilePath) : IO Snapshot := do
  let text ← IO.FS.readFile path
  match Snapshot.parse text with
  | .error e => throw <| IO.userError s!"{path}: {e}"
  | .ok s => return s

/-- The snapshot's objects as a blueprint, so that ids can be looked up. -/
def Snapshot.blueprint (s : Snapshot) : Blueprint :=
  Blueprint.ofObjects s.project s.schema s.objects

/-- The derived status recorded for an object, if there is an entry. -/
def Snapshot.status? (s : Snapshot) (id : String) : Option DerivedStatus :=
  (s.statuses.find? (·.1 == id)).map (·.2)

/-! ## Summaries -/

/-- The five derived statuses, in the order the website shows them. -/
def statusOrder : Array String :=
  #["proved", "proved_with_axioms", "stated", "missing", "absent"]

/-- `proved` out of `total` countable objects, plus the counts per status.
This is what the history index records per snapshot. -/
structure Summary where
  /-- Countable objects whose derived status is `proved`. -/
  proved : Nat := 0
  /-- Countable objects that have a derived status at all. -/
  total : Nat := 0
  /-- Counts per status, only for statuses that occur, sorted by name. -/
  byStatus : Array (String × Nat) := #[]
  deriving Inhabited, BEq

/-- Build a JSON object from an association array, sorted by key. -/
def mkObjSorted (xs : Array (String × Json)) : Json :=
  Json.mkObj (xs.qsort (fun a b => a.1 < b.1)).toList

namespace Summary

/-- The summary as the history index writes it. -/
def toJson (s : Summary) : Json :=
  Json.mkObj [
    ("proved", Json.num (JsonNumber.fromInt s.proved)),
    ("total", Json.num (JsonNumber.fromInt s.total)),
    ("byStatus", mkObjSorted (s.byStatus.map fun (k, n) =>
      (k, Json.num (JsonNumber.fromInt n))))]

/-- Read a summary back. -/
def ofJson (j : Json) : Summary :=
  let nat (k : String) : Nat := match j.getObjVal? k with
    | .ok v => match v.getNat? with
      | .ok n => n
      | .error _ => 0
    | .error _ => 0
  let byStatus := match j.getObjVal? "byStatus" with
    | .ok b => match b.getObj? with
      | .ok o => (o.toArray.filterMap fun (k, v) =>
          (v.getNat?.toOption).map fun n => (k, n)).qsort (fun a b => a.1 < b.1)
      | .error _ => #[]
    | .error _ => #[]
  { proved := nat "proved", total := nat "total", byStatus }

/-- `3/7` -/
def fraction (s : Summary) : String := s!"{s.proved}/{s.total}"

end Summary

/-- Count the countable objects of a snapshot by derived status.  "Countable"
is the `countable = true` of the object's kind; objects without an entry in
`derived.status` do not count, so a snapshot built without facts has a
summary of `0/0`. -/
def Snapshot.summary (s : Snapshot) : Summary := Id.run do
  let b := s.blueprint
  let mut counts : Array (String × Nat) := #[]
  let mut proved := 0
  let mut total := 0
  for (id, st) in s.statuses do
    match b.find? id with
    | none => continue
    | some o =>
      unless (b.kindOf? o).any KindSpec.countable do continue
      total := total + 1
      if st == .proved then proved := proved + 1
      let key := st.toString
      counts := match counts.findIdx? (·.1 == key) with
        | some i => counts.set! i (key, counts[i]!.2 + 1)
        | none => counts.push (key, 1)
  return { proved, total, byStatus := counts.qsort (fun a b => a.1 < b.1) }

/-! ## Changes to one object -/

/-- One attribute whose value differs between the two sides. -/
structure AttrChange where
  /-- The attribute key. -/
  key : String
  /-- Its value on the old side, `none` when the key was not set. -/
  old : Option AttrValue
  /-- Its value on the new side, `none` when the key is no longer set. -/
  new : Option AttrValue
  deriving Inhabited

/-- Everything that changed about one object that is present on both sides. -/
structure ObjectChange where
  /-- The id on the new side. -/
  id : String
  /-- The id on the old side; different from `id` exactly for a rename. -/
  oldId : String
  /-- Old and new kind. -/
  kindChange : Option (String × String) := none
  /-- Old and new boundary. -/
  boundaryChange : Option (Array BoundaryEntry × Array BoundaryEntry) := none
  /-- Did the prose change? -/
  bodyChanged : Bool := false
  /-- Attributes that differ, sorted by key. -/
  attrChanges : Array AttrChange := #[]
  /-- Old and new derived status; only ever set when both sides carry facts. -/
  statusChange : Option (DerivedStatus × DerivedStatus) := none
  deriving Inhabited

namespace ObjectChange

/-- Was the object renamed? -/
def renamed (c : ObjectChange) : Bool := c.id != c.oldId

/-- Is there nothing to report? -/
def isEmpty (c : ObjectChange) : Bool :=
  !c.renamed && c.kindChange.isNone && c.boundaryChange.isNone && !c.bodyChanged
    && c.attrChanges.isEmpty && c.statusChange.isNone

end ObjectChange

/-- Compare two objects, ignoring their ids (the caller knows whether the
pair is a rename) and ignoring `depth` and `source`, which are derived. -/
def compareObjects (oldId newId : String) (a b : Object) : ObjectChange := Id.run do
  let keys := sortDedup (a.attrs.map (·.1) ++ b.attrs.map (·.1))
  let mut attrChanges : Array AttrChange := #[]
  for k in keys do
    let old := a.attr? k
    let new := b.attr? k
    unless old == new do
      attrChanges := attrChanges.push { key := k, old, new }
  return {
    id := newId, oldId
    kindChange := if a.kind == b.kind then none else some (a.kind, b.kind)
    boundaryChange := if a.boundary == b.boundary then none else some (a.boundary, b.boundary)
    bodyChanged := a.body != b.body
    attrChanges }

/-! ## Rendering one change -/

/-- A boundary as `{src=a, tgt=b}`. -/
def renderBoundary (bs : Array BoundaryEntry) : String :=
  "{" ++ String.intercalate ", " (bs.toList.map fun e => s!"{e.role}={e.id}") ++ "}"

/-- An attribute value, with strings quoted. -/
def renderAttrValue : AttrValue → String
  | .str s => "\"" ++ s ++ "\""
  | v => v.toString

/-- An attribute value that may be unset. -/
def renderAttrValue? : Option AttrValue → String
  | none => "(unset)"
  | some v => renderAttrValue v

/-- The change to one object, as indented lines.  `log` prints these under a
commit, `diff` groups them by category instead. -/
def ObjectChange.lines (c : ObjectChange) : Array String := Id.run do
  let mut out : Array String := #[]
  if c.renamed then
    out := out.push s!"renamed: {c.oldId} -> {c.id}"
  if let some (o, n) := c.kindChange then
    out := out.push s!"kind: {o} -> {n}"
  if let some (o, n) := c.boundaryChange then
    out := out.push s!"boundary: {renderBoundary o} -> {renderBoundary n}"
  if c.bodyChanged then
    out := out.push "body changed"
  for a in c.attrChanges do
    out := out.push s!"{a.key}: {renderAttrValue? a.old} -> {renderAttrValue? a.new}"
  if let some (o, n) := c.statusChange then
    out := out.push s!"status: {o} -> {n}"
  return out

/-! ## A whole diff -/

/-- One side of a diff: where it came from and what it contains. -/
structure SnapshotSide where
  /-- What the user wrote on the command line. -/
  label : String
  /-- Did that name a git revision (rather than a file)? -/
  isRev : Bool := false
  /-- The commit it resolved to, when it did. -/
  sha : Option String := none
  /-- The snapshot itself. -/
  snapshot : Snapshot
  deriving Inhabited

namespace SnapshotSide

/-- How the side is named in output: the label, plus the short sha when the
label was a revision that is not already the sha. -/
def describe (s : SnapshotSide) : String :=
  match s.sha with
  | some sha =>
    let short := (sha.take 8).copy
    if s.label == sha then short else s!"{s.label} ({short})"
  | none => s.label

/-- Does this side carry Lean facts? -/
def hasFacts (s : SnapshotSide) : Bool := s.snapshot.facts.isSome

end SnapshotSide

/-- The result of comparing two snapshots. -/
structure Diff where
  /-- The old side. -/
  before : SnapshotSide
  /-- The new side. -/
  after : SnapshotSide
  /-- Objects only in the new snapshot, sorted by id. -/
  added : Array Object := #[]
  /-- Objects only in the old snapshot, sorted by id. -/
  removed : Array Object := #[]
  /-- Renames, as old id and new id, sorted by old id. -/
  renamed : Array (String × String) := #[]
  /-- Objects present on both sides that differ, sorted by new id. -/
  changed : Array ObjectChange := #[]
  /-- Were derived statuses compared?  Only when both sides carry facts. -/
  withStatus : Bool := false
  deriving Inhabited

/-- Match the objects of two snapshots and report every difference.  Objects
are matched by id first; an object of the new snapshot whose `aliases` name
an id of the old snapshot that nothing else matched is a rename. -/
def diffSnapshots (before after : SnapshotSide) : Diff := Id.run do
  let a := before.snapshot
  let b := after.snapshot
  let ba := a.blueprint
  let bb := b.blueprint
  let withStatus := before.hasFacts && after.hasFacts
  -- matched by id
  let mut pairs : Array (String × String) := #[]
  let mut unmatchedA : Array String := #[]
  for o in ba.objects do
    if bb.contains o.id then pairs := pairs.push (o.id, o.id)
    else unmatchedA := unmatchedA.push o.id
  let mut unmatchedB : Array String := #[]
  for o in bb.objects do
    unless ba.contains o.id do unmatchedB := unmatchedB.push o.id
  -- matched by alias: a new object whose aliases name an unmatched old id
  let mut renamed : Array (String × String) := #[]
  let mut stillNew : Array String := #[]
  for id in unmatchedB do
    let aliases := match bb.find? id with
      | some o => o.attrStrings "aliases"
      | none => #[]
    match aliases.find? (fun al => unmatchedA.contains al) with
    | some al =>
      renamed := renamed.push (al, id)
      pairs := pairs.push (al, id)
      unmatchedA := unmatchedA.filter (· != al)
    | none => stillNew := stillNew.push id
  -- what is left
  let added := stillNew.filterMap bb.find?
  let removed := unmatchedA.filterMap ba.find?
  -- changes to matched objects
  let mut changed : Array ObjectChange := #[]
  for (oldId, newId) in pairs do
    match ba.find? oldId, bb.find? newId with
    | some x, some y =>
      let mut c := compareObjects oldId newId x y
      if withStatus then
        let so := a.status? oldId
        let sn := b.status? newId
        if so != sn && (so.isSome || sn.isSome) then
          let pair := (so.getD .absent, sn.getD .absent)
          c := { c with statusChange := some pair }
      unless c.isEmpty do changed := changed.push c
    | _, _ => pure ()
  return {
    before, after, withStatus
    added := added.qsort (fun x y => x.id < y.id)
    removed := removed.qsort (fun x y => x.id < y.id)
    renamed := renamed.qsort (fun x y => x.1 < y.1)
    changed := changed.qsort (fun x y => x.id < y.id) }

namespace Diff

/-- Changes with a kind change, in order. -/
def kindChanges (d : Diff) : Array ObjectChange := d.changed.filter (·.kindChange.isSome)

/-- Changes with a boundary change. -/
def boundaryChanges (d : Diff) : Array ObjectChange :=
  d.changed.filter (·.boundaryChange.isSome)

/-- Changes with a body change. -/
def bodyChanges (d : Diff) : Array ObjectChange := d.changed.filter (·.bodyChanged)

/-- Changes with at least one attribute change. -/
def attrChanges (d : Diff) : Array ObjectChange := d.changed.filter (!·.attrChanges.isEmpty)

/-- How many attribute changes there are in total, counting one per key. -/
def attrChangeCount (d : Diff) : Nat :=
  d.changed.foldl (init := 0) fun n c => n + c.attrChanges.size

/-- Changes with a status change. -/
def statusChanges (d : Diff) : Array ObjectChange := d.changed.filter (·.statusChange.isSome)

/-- The `status-regression` checks of `docs/snapshot-format.md`: an object
whose derived status fell from `proved` back to `stated`, `missing` or
`absent`. -/
def regressions (d : Diff) : Array Check :=
  d.statusChanges.filterMap fun c =>
    match c.statusChange with
    | some (.proved, n) =>
      if n == .stated || n == .missing || n == .absent then
        some <| Check.error "status-regression"
          s!"'{c.id}' went from proved to {n}" #[c.id]
      else none
    | _ => none

/-- Is there anything at all to report? -/
def isEmpty (d : Diff) : Bool :=
  d.added.isEmpty && d.removed.isEmpty && d.renamed.isEmpty && d.changed.isEmpty

/-- The one line summary: counts per category and the progress fractions. -/
def summaryLine (d : Diff) : String :=
  let before := d.before.snapshot.summary
  let after := d.after.snapshot.summary
  let counts := s!"{d.added.size} added, {d.removed.size} removed, \
    {d.renamed.size} renamed, {d.kindChanges.size} kind, \
    {d.boundaryChanges.size} boundary, {d.bodyChanges.size} body, \
    {d.attrChangeCount} attrs, {d.statusChanges.size} status"
  let progress :=
    if d.withStatus then s!"proved {before.fraction} -> {after.fraction}"
    else "proved ?/? (no Lean facts on at least one side)"
  s!"summary: {counts}; {progress}"

/-- The text report. -/
def render (d : Diff) : String := Id.run do
  let mut out : Array String := #[s!"diff {d.before.describe} -> {d.after.describe}"]
  let section_ (title : String) (n : Nat) (body : Array String) : Array String :=
    if n == 0 then #[] else #["", s!"{title} ({n})"] ++ body
  out := out ++ section_ "added" d.added.size (d.added.map fun o => s!"  + {o.id}  [{o.kind}]")
  out := out ++ section_ "removed" d.removed.size
    (d.removed.map fun o => s!"  - {o.id}  [{o.kind}]")
  out := out ++ section_ "renamed" d.renamed.size
    (d.renamed.map fun (o, n) => s!"  ~ {o} -> {n}")
  out := out ++ section_ "kind changed" d.kindChanges.size
    (d.kindChanges.filterMap fun c => c.kindChange.map fun (o, n) => s!"  ! {c.id}  {o} -> {n}")
  out := out ++ section_ "boundary changed" d.boundaryChanges.size
    (d.boundaryChanges.filterMap fun c => c.boundaryChange.map fun (o, n) =>
      s!"  ! {c.id}  {renderBoundary o} -> {renderBoundary n}")
  out := out ++ section_ "body changed" d.bodyChanges.size
    (d.bodyChanges.map fun c => s!"  ! {c.id}")
  out := out ++ section_ "attrs changed" d.attrChangeCount
    (d.attrChanges.flatMap fun c => c.attrChanges.map fun a =>
      s!"  ! {c.id}  {a.key}: {renderAttrValue? a.old} -> {renderAttrValue? a.new}")
  out := out ++ section_ "status changed" d.statusChanges.size
    (d.statusChanges.filterMap fun c => c.statusChange.map fun (o, n) =>
      s!"  ! {c.id}  {o} -> {n}")
  let regs := d.regressions
  unless regs.isEmpty do
    out := out ++ #[""] ++ regs.map (·.render)
  if d.isEmpty then out := out ++ #["", "no changes"]
  out := out ++ #["", d.summaryLine]
  return String.intercalate "\n" out.toList ++ "\n"

/-- One side, as the `diff.json` header records it. -/
def sideJson (s : SnapshotSide) : Json :=
  Json.mkObj [
    ("ref", Json.str s.label),
    ("kind", Json.str (if s.isRev then "rev" else "file")),
    ("sha", match s.sha with | some x => Json.str x | none => Json.null),
    ("objects", Json.num (JsonNumber.fromInt s.snapshot.objects.size)),
    ("facts", Json.bool s.hasFacts),
    ("summary", s.snapshot.summary.toJson)]

/-- The structured report, `docs/snapshot-format.md` §"diff.json". -/
def toJson (d : Diff) : Json :=
  let boundaryJson (bs : Array BoundaryEntry) : Json :=
    Json.arr (bs.map fun e => Json.mkObj [("role", Json.str e.role), ("id", Json.str e.id)])
  let attrJson : Option AttrValue → Json
    | none => Json.null
    | some v => v.toJson
  let regs := d.regressions
  Json.mkObj [
    ("version", Json.num (JsonNumber.fromInt snapshotVersion)),
    ("before", sideJson d.before),
    ("after", sideJson d.after),
    ("added", Json.arr (d.added.map fun o =>
      Json.mkObj [("id", Json.str o.id), ("kind", Json.str o.kind)])),
    ("removed", Json.arr (d.removed.map fun o =>
      Json.mkObj [("id", Json.str o.id), ("kind", Json.str o.kind)])),
    ("renamed", Json.arr (d.renamed.map fun (o, n) =>
      Json.mkObj [("from", Json.str o), ("to", Json.str n)])),
    ("kindChanged", Json.arr (d.kindChanges.filterMap fun c => c.kindChange.map fun (o, n) =>
      Json.mkObj [("id", Json.str c.id), ("from", Json.str o), ("to", Json.str n)])),
    ("boundaryChanged", Json.arr (d.boundaryChanges.filterMap fun c =>
      c.boundaryChange.map fun (o, n) =>
        Json.mkObj [("id", Json.str c.id), ("from", boundaryJson o), ("to", boundaryJson n)])),
    ("bodyChanged", Json.arr (d.bodyChanges.map fun c => Json.str c.id)),
    ("attrsChanged", Json.arr (d.attrChanges.flatMap fun c => c.attrChanges.map fun a =>
      Json.mkObj [("id", Json.str c.id), ("key", Json.str a.key),
                  ("from", attrJson a.old), ("to", attrJson a.new)])),
    ("statusChanged", Json.arr (d.statusChanges.filterMap fun c =>
      c.statusChange.map fun (o, n) =>
        Json.mkObj [("id", Json.str c.id), ("from", Json.str o.toString),
                    ("to", Json.str n.toString),
                    ("regression", Json.bool (o == .proved &&
                      (n == .stated || n == .missing || n == .absent)))])),
    ("checks", Json.arr (regs.map Check.toJson)),
    ("summary", Json.mkObj [
      ("added", Json.num (JsonNumber.fromInt d.added.size)),
      ("removed", Json.num (JsonNumber.fromInt d.removed.size)),
      ("renamed", Json.num (JsonNumber.fromInt d.renamed.size)),
      ("kindChanged", Json.num (JsonNumber.fromInt d.kindChanges.size)),
      ("boundaryChanged", Json.num (JsonNumber.fromInt d.boundaryChanges.size)),
      ("bodyChanged", Json.num (JsonNumber.fromInt d.bodyChanges.size)),
      ("attrsChanged", Json.num (JsonNumber.fromInt d.attrChangeCount)),
      ("statusChanged", Json.num (JsonNumber.fromInt d.statusChanges.size)),
      ("regressions", Json.num (JsonNumber.fromInt regs.size)),
      ("withStatus", Json.bool d.withStatus),
      ("before", d.before.snapshot.summary.toJson),
      ("after", d.after.snapshot.summary.toJson)])]

end Diff

/-! ## Naming a side on the command line -/

/-- Read one side of a diff.  An argument that names an existing file is read
as a snapshot; anything else is resolved as a git revision, whose tree is
materialised below `work` and compiled in memory.  `root` is the project
root: the same directory is used inside the materialised tree. -/
def loadSide (ctx : Option GitContext) (root : System.FilePath) (work : System.FilePath)
    (label : String) : IO SnapshotSide := do
  let path : System.FilePath := label
  if (← path.pathExists) && !(← path.isDir) then
    return { label, snapshot := ← readSnapshot path }
  match ctx with
  | none =>
    throw <| IO.userError
      s!"'{label}': not a file, and {root} is not inside a git work tree"
  | some c =>
    match ← resolveRev? c label with
    | none =>
      throw <| IO.userError
        s!"'{label}': neither a file nor a revision of {c.toplevel}"
    | some sha =>
      IO.FS.createDirAll work
      let tree ← materialiseRev c label work
      let subRoot := if c.prefixPath.isEmpty then tree else tree / c.prefixPath
      unless ← subRoot.pathExists do
        throw <| IO.userError
          s!"'{label}': {c.prefixPath} does not exist at that revision"
      return { label, isRev := true, sha := some sha, snapshot := ← buildSnapshotAt subRoot }

/-! ## One file at a time

`blueprint log` walks many revisions of a single source file.  Building a
whole snapshot per commit would need the whole tree of every commit; parsing
the one file is enough to see what changed about the one object, so that is
what it does.  The schema is the *current* one — a project that changes its
schema mid-history gets the current reading of old files.
-/

/-- Turn the text of one source file into the object it declares, without
expanding sugar.  `rel` is the path relative to the project root. -/
def parseOneFile (project : Project) (schema : Schema) (rel : String) (text : String) :
    IO (Option Object) := do
  match splitFrontMatter text with
  | .error _ => return none
  | .ok (front, body) =>
    match ← parseToml front rel with
    | .error _ => return none
    | .ok t =>
      -- the path below the source directory, as `parseProject` sees it
      let inDir : String :=
        if rel.startsWith (project.dir ++ "/") then (rel.drop (project.dir.length + 1)).copy
        else rel
      let parts : List String := inDir.splitOn "/"
      let name : String := parts.getLast!
      let stem : String := if name.endsWith ".md" then (name.dropEnd 3).copy else name
      let raw : RawFile :=
        { rel, dirRel := String.intercalate "/" parts.dropLast, stem,
          entries := t.entries, body }
      let p := readPreObj schema raw
      if p.id.isEmpty then return none
      return some { id := p.id, kind := p.kind, boundary := p.boundary, attrs := p.attrs,
                    body := p.raw.body, source := { file := rel, anonymous := false } }

end Blueprint
