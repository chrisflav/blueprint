import Blueprint.Schema

/-!
# The authoring format

`DESIGN.md` §6.  One directory of Markdown files with TOML front matter
between `+++` lines, plus three conveniences:

* **sugar keys** — any kind declared `sugar = true` may be used as a front
  matter key, expanding to anonymous edge objects,
* **`_section.md`** — declares a section object that the other files in its
  directory refine,
* **derived ids** — an object with an explicit boundary and no `id` gets the
  deterministic id described in `DESIGN.md` §2.4.
-/

namespace Blueprint

/-- Reserved front matter keys, never attributes or sugar. -/
def reservedKeys : Array String := #["id", "kind", "boundary"]

/-- The basename of the file that declares a directory's section object. -/
def sectionFileStem : String := "_section"

/-! ## Deriving ids -/

/-- Boundary ids may themselves contain `/`; it becomes `~` inside a derived id. -/
def sanitizeIdPart (s : String) : String := replaceAll s "/" "~"

/-- The deterministic id of an object with the given kind and boundary,
`DESIGN.md` §2.4: the kind, then the boundary in role order, each entry with
its slashes turned into tildes. -/
def deriveId (kind : String) (boundary : Array BoundaryEntry) : String :=
  if boundary.isEmpty then kind else
    kind ++ "/" ++ String.intercalate "/" (boundary.toList.map (sanitizeIdPart ·.id))

/-- Reorder a boundary so that roles come in the order the kind declares them.
Roles the kind does not declare keep their relative order and come last. -/
def inRoleOrder (spec : Option KindSpec) (boundary : Array BoundaryEntry) :
    Array BoundaryEntry :=
  match spec with
  | none => boundary
  | some k =>
    let known := k.roles.foldl (init := #[]) fun acc r =>
      acc ++ boundary.filter (·.role == r.name)
    let unknown := boundary.filter fun e => !k.roles.any (·.name == e.role)
    known ++ unknown

/-! ## Reading files -/

/-- A Markdown file with its front matter parsed. -/
structure RawFile where
  /-- Path relative to the project root, with `/` separators. -/
  rel : String
  /-- Directory relative to the source directory, `""` at the top level. -/
  dirRel : String
  /-- File name without the `.md` extension. -/
  stem : String
  /-- Front matter entries, in source order. -/
  entries : Array (String × TValue)
  /-- The Markdown body. -/
  body : String
  deriving Inhabited

/-- Split a file into TOML front matter and Markdown body. -/
def splitFrontMatter (text : String) : Except String (String × String) :=
  let lines := splitLines text
  let isFence (l : String) := trim l == "+++"
  match lines[0]? with
  | none => throw "empty file"
  | some first =>
    if !isFence first then
      throw "expected TOML front matter starting with a '+++' line"
    else
      match (lines.toList.drop 1).findIdx? isFence with
      | none => throw "front matter is not closed by a '+++' line"
      | some i =>
        let front := (lines.toList.drop 1).take i
        let rest := (lines.toList.drop (i + 2))
        -- `DESIGN.md` shows some bodies closed by a further `+++`; tolerate it.
        let rest := match rest.reverse.dropWhile (fun l => trim l == "") with
          | l :: tl => if trim l == "+++" then tl.reverse else rest
          | [] => rest
        .ok (String.intercalate "\n" front, trim (String.intercalate "\n" rest))

/-- Recursively collect `*.md` files, sorted, with paths relative to `base`. -/
private def walkDir (fuel : Nat) (base : System.FilePath) (relPrefix : String) :
    IO (Array (String × System.FilePath)) :=
  match fuel with
  | 0 => throw <| IO.userError s!"{base}: directory nesting is deeper than 64 levels"
  | fuel + 1 => do
    let entries ← base.readDir
    let entries := entries.qsort (fun a b => a.fileName < b.fileName)
    entries.foldlM (init := #[]) fun out e => do
      let nm := e.fileName
      if nm.startsWith "." then return out
      let rel := if relPrefix.isEmpty then nm else relPrefix ++ "/" ++ nm
      if ← e.path.isDir then
        return out ++ (← walkDir fuel e.path rel)
      else if e.path.extension == some "md" then
        return out.push (rel, e.path)
      else
        return out
termination_by fuel

/-- All Markdown sources under `base`, sorted by path. -/
def collectMarkdown (base : System.FilePath) : IO (Array (String × System.FilePath)) :=
  walkDir 64 base ""

/-! ## Front matter to objects -/

/-- An object as read from one file, before sugar is expanded. -/
structure PreObj where
  /-- The file it came from. -/
  raw : RawFile
  /-- Its id. -/
  id : String
  /-- Its kind, `""` if the file did not say. -/
  kind : String
  /-- Its boundary, in role order. -/
  boundary : Array BoundaryEntry
  /-- Its attributes, sorted by key. -/
  attrs : Array (String × AttrValue)
  /-- Sugar keys: kind name and the ids named. -/
  sugars : Array (String × Array String)
  /-- Checks produced while reading the file. -/
  checks : Array Check
  deriving Inhabited

/-- Read the `boundary` table of a file. -/
def decodeBoundary (v : TValue) : Except String (Array BoundaryEntry) :=
  match v with
  | .table xs => xs.foldlM (init := #[]) fun acc (role, rv) =>
      match rv.asStrings? with
      | some ids => .ok (ids.foldl (init := acc) fun a i => a.push { role, id := i })
      | none => .error s!"role '{role}' must hold a string or an array of strings"
  | v => .error s!"'boundary' must be a table, got a {v.typeName}"

/-- Turn one file into a `PreObj`. -/
def readPreObj (schema : Schema) (raw : RawFile) : PreObj := Id.run do
  let mut checks : Array Check := #[]
  let kind := match (raw.entries.find? (·.1 == "kind")).map (·.2) with
    | some (.str s) => s
    | _ => ""
  if kind.isEmpty then
    checks := checks.push <| Check.error "unknown-kind"
      s!"{raw.rel}: no 'kind' given"
  let spec := schema.kind? kind
  let boundary := match (raw.entries.find? (·.1 == "boundary")).map (·.2) with
    | some v =>
      match decodeBoundary v with
      | .ok b => b
      | .error _ => #[]
    | none => #[]
  let boundary := inRoleOrder spec boundary
  if let some v := (raw.entries.find? (·.1 == "boundary")).map (·.2) then
    if let .error e := decodeBoundary v then
      checks := checks.push <| Check.error "bad-boundary" s!"{raw.rel}: {e}"
  -- the id: explicit, else derived from the boundary, else the file name
  let defaultId :=
    if raw.stem == sectionFileStem then
      if raw.dirRel.isEmpty then "" else
        (raw.dirRel.splitOn "/").getLast!
    else raw.stem
  let id := match (raw.entries.find? (·.1 == "id")).map (·.2) with
    | some (.str s) => s
    | _ => if boundary.isEmpty then defaultId else deriveId kind boundary
  -- attributes and sugar
  let mut attrs : Array (String × AttrValue) := #[]
  let mut sugars : Array (String × Array String) := #[]
  for (k, v) in raw.entries do
    if reservedKeys.contains k then continue
    let sugarSpec : Option KindSpec := schema.kind? k
    -- a key that the kind permits as an attribute is an attribute; otherwise a
    -- key naming a sugar kind expands to edges; anything else is an error
    let isAttr := match spec with
      | some s => s.attrs.contains k
      | none => !sugarSpec.any KindSpec.sugar
    if isAttr then
      match v.toAttr? with
      | some a => attrs := attrs.push (k, a)
      | none => checks := checks.push <| Check.error "unknown-attr" s!"{raw.rel}: attribute '{k}' has an unsupported value type ({v.typeName})" #[id]
    else if sugarSpec.any KindSpec.sugar then
      match v.asStrings? with
      | some ids => sugars := sugars.push (k, ids)
      | none => checks := checks.push <| Check.error "bad-boundary" s!"{raw.rel}: sugar key '{k}' must be a string or an array of strings" #[id]
    else
      checks := checks.push <| Check.error "unknown-attr"
        s!"{raw.rel}: kind '{kind}' does not permit the attribute '{k}'" #[id]
  return { raw, id, kind, boundary, attrs := attrs.qsort (fun a b => a.1 < b.1),
           sugars, checks }

/-! ## The parse result -/

/-- Objects and the checks found while reading them. -/
structure ParseResult where
  /-- All objects, file objects first, then the anonymous ones. -/
  objects : Array Object
  /-- Checks produced during parsing. -/
  checks : Array Check
  deriving Inhabited

/-- The collapse kind used by the `_section.md` convention. -/
def sectionCollapseKind (schema : Schema) : Option String :=
  if (schema.kind? "refines").any KindSpec.collapse then some "refines"
  else schema.mainCollapse?

/-- Read every Markdown file under the project's source directory and build
the object set: file objects, then the anonymous objects created by sugar and
by the `_section.md` convention. -/
def parseProject (root : System.FilePath) (project : Project) (schema : Schema) :
    IO ParseResult := do
  let srcDir := root / project.dir
  unless ← srcDir.pathExists do
    throw <| IO.userError
      s!"{srcDir}: source directory does not exist (set 'dir' in blueprint.toml)"
  let files ← collectMarkdown srcDir
  let mut raws : Array RawFile := #[]
  for (rel, path) in files do
    let relFull := project.dir ++ "/" ++ rel
    let text ← IO.FS.readFile path
    match splitFrontMatter text with
    | .error e => throw <| IO.userError s!"{relFull}: {e}"
    | .ok (front, body) =>
      match ← parseToml front relFull with
      | .error e => throw <| IO.userError s!"{relFull}: front matter: {e}"
      | .ok t =>
        let parts := rel.splitOn "/"
        let dirRel := String.intercalate "/" (parts.dropLast)
        let stem := (parts.getLast!).dropEnd 3 |>.copy
        raws := raws.push { rel := relFull, dirRel, stem, entries := t.entries, body }
  let pres := raws.map (readPreObj schema)
  let mut checks : Array Check := pres.foldl (init := #[]) (· ++ ·.checks)
  -- section objects, by directory
  let topName := (System.FilePath.mk project.dir).fileName.getD project.dir
  let sections : Array (String × String) := pres.foldl (init := #[]) fun acc p =>
    if p.raw.stem == sectionFileStem then
      let id := if p.id.isEmpty then topName else p.id
      acc.push (p.raw.dirRel, id)
    else acc
  let sectionOf (dir : String) : Option String :=
    (sections.find? (·.1 == dir)).map (·.2)
  -- file objects, dropping duplicates
  let mut objects : Array Object := #[]
  let mut seen : Array String := #[]
  for p in pres do
    let id := if p.id.isEmpty then topName else p.id
    if seen.contains id then
      let other := (objects.find? (·.id == id)).map (·.source.file) |>.getD "?"
      checks := checks.push <| Check.error "duplicate-id"
        s!"{p.raw.rel}: id '{id}' is already declared in {other}" #[id]
      continue
    seen := seen.push id
    objects := objects.push
      { id, kind := p.kind, boundary := p.boundary, attrs := p.attrs, body := p.raw.body,
        source := { file := p.raw.rel, anonymous := false } }
  -- anonymous objects from sugar and from `_section.md`
  let secKind := sectionCollapseKind schema
  let mut anon : Array Object := #[]
  let addEdge (seen : Array String) (anon : Array Object) (kind src tgt file : String) :
      Array String × Array Object :=
    let boundary : Array BoundaryEntry := #[{ role := "src", id := src },
                                            { role := "tgt", id := tgt }]
    let id := deriveId kind boundary
    if seen.contains id then (seen, anon) else
      (seen.push id,
       anon.push { id, kind, boundary, source := { file, anonymous := true } })
  for p in pres do
    let id := if p.id.isEmpty then topName else p.id
    -- explicit sugar keys
    for (kind, tgts) in p.sugars do
      for tgt in tgts do
        let (s, a) := addEdge seen anon kind id tgt p.raw.rel
        seen := s; anon := a
    -- the `_section.md` convention
    if let some sk := secKind then
      if !p.sugars.any (·.1 == sk) then
        let parent :=
          if p.raw.stem == sectionFileStem then
            if p.raw.dirRel.isEmpty then none
            else sectionOf (String.intercalate "/" ((p.raw.dirRel.splitOn "/").dropLast))
          else sectionOf p.raw.dirRel
        if let some par := parent then
          if par != id then
            let (s, a) := addEdge seen anon sk id par p.raw.rel
            seen := s; anon := a
  return { objects := objects ++ anon, checks }

end Blueprint
