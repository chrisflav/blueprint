import Std.Time
import Blueprint.Diff

/-!
# Assembling the static site and the history index

`DESIGN.md` §7 and §9.  The website under `web/` is the deployed artefact as
it stands: no build step, just files.  `blueprint site` copies it next to a
freshly built `blueprint.json`, and `blueprint history add` maintains the
`data/index.json` the time slider reads.

The history index format is the one `web/README.md` documents:

```jsonc
{ "snapshots": [ { "sha": "…", "date": "2026-06-02",
                   "file": "data/<sha>.json",
                   "summary": { "proved": 1, "total": 6, "byStatus": {…} } } ] }
```

`file` is resolved by the frontend against the directory holding the main
snapshot, so the paths written here assume the history directory is deployed
as `<site>/data`.
-/

namespace Blueprint

open Lean (Json)

/-! ## Dates -/

/-- Today's date as `YYYY-MM-DD`, or `""` if the clock or the timezone
database is unavailable (which happens in minimal containers). -/
def todayISO : IO String := do
  try
    return toString (← Std.Time.PlainDate.now)
  catch _ =>
    return ""

/-! ## Finding `web/` -/

/-- Does this directory look like the website? -/
def isWebDir (d : System.FilePath) : IO Bool := (d / "index.html").pathExists

/-- Where the tool's copy of `web/` is.  In order:

1. `BLUEPRINT_WEB_DIR`,
2. `<root>/web`, when it has an `index.html`,
3. the package the running executable belongs to: the directory of
   `IO.appPath` and its parents, looking for a `web/index.html`.

A project that consumes `blueprint` as a Lake dependency gets (3), which
finds `.lake/packages/blueprint/web`. -/
def findWebDir (root : System.FilePath) : IO System.FilePath := do
  if let some p ← IO.getEnv "BLUEPRINT_WEB_DIR" then
    let d : System.FilePath := p
    if ← isWebDir d then return d
    throw <| IO.userError s!"BLUEPRINT_WEB_DIR={p}: no index.html in that directory"
  if ← isWebDir (root / "web") then return root / "web"
  let app ← try IO.appPath catch _ => pure (System.FilePath.mk ".")
  let mut dir := app.parent
  for _ in [0 : 16] do
    match dir with
    | none => break
    | some d =>
      if ← isWebDir (d / "web") then return d / "web"
      dir := d.parent
  throw <| IO.userError
    s!"cannot find the website: set BLUEPRINT_WEB_DIR, or put a web/index.html \
      under {root}, or run the tool from its own package (looked upwards from {app})"

/-! ## Copying a tree -/

/-- Copy `src` onto `dst`, recursively, returning the number of files
written.  Entries of `exclude` are skipped at the *top* level only. -/
def copyTree : Nat → System.FilePath → System.FilePath → Array String → IO Nat
  | 0, src, _, _ =>
    throw <| IO.userError s!"{src}: directory nesting is deeper than 32 levels"
  | fuel + 1, src, dst, exclude => do
    unless ← src.pathExists do
      throw <| IO.userError s!"{src}: no such directory"
    IO.FS.createDirAll dst
    let entries := (← src.readDir).qsort (fun a b => a.fileName < b.fileName)
    let mut n := 0
    for e in entries do
      let nm := e.fileName
      if exclude.contains nm then continue
      if ← e.path.isDir then
        n := n + (← copyTree fuel e.path (dst / nm) #[])
      else
        IO.FS.writeBinFile (dst / nm) (← IO.FS.readBinFile e.path)
        n := n + 1
    return n

/-- Copy a directory tree, with room for 32 levels of nesting. -/
def copyDir (src dst : System.FilePath) (exclude : Array String := #[]) : IO Nat :=
  copyTree 32 src dst exclude

/-- What `blueprint site` leaves behind: the website is the deployed artefact,
but its own fixtures and tests are not part of it. -/
def siteExcludes : Array String := #["sample", "test", "README.md"]

/-! ## The history index -/

/-- One entry of `data/index.json`. -/
structure HistoryEntry where
  /-- The commit the snapshot was built from. -/
  sha : String
  /-- Its date, `YYYY-MM-DD`; the index is sorted by it. -/
  date : String
  /-- Where the snapshot is, relative to the directory holding the main
  `blueprint.json`. -/
  file : String
  /-- Its progress summary. -/
  summary : Summary
  deriving Inhabited

namespace HistoryEntry

/-- An entry as JSON. -/
def toJson (e : HistoryEntry) : Json :=
  Json.mkObj [("sha", Json.str e.sha), ("date", Json.str e.date),
              ("file", Json.str e.file), ("summary", e.summary.toJson)]

/-- Read an entry back. -/
def ofJson (j : Json) : Option HistoryEntry :=
  let str (k : String) : String := match j.getObjVal? k with
    | .ok v => v.getStr?.toOption.getD ""
    | .error _ => ""
  let sha := str "sha"
  if sha.isEmpty then none else
    some { sha, date := str "date", file := str "file"
           summary := Summary.ofJson ((j.getObjVal? "summary").toOption.getD Json.null) }

end HistoryEntry

/-- Sort by date, then sha, the way the frontend expects. -/
def sortHistory (es : Array HistoryEntry) : Array HistoryEntry :=
  es.qsort fun a b => if a.date != b.date then a.date < b.date else a.sha < b.sha

/-- Insert an entry, replacing any entry with the same sha. -/
def upsertHistory (es : Array HistoryEntry) (e : HistoryEntry) : Array HistoryEntry :=
  match es.findIdx? (·.sha == e.sha) with
  | some i => sortHistory (es.set! i e)
  | none => sortHistory (es.push e)

/-- Read `index.json`; an absent file is an empty index. -/
def readHistoryIndex (path : System.FilePath) : IO (Array HistoryEntry) := do
  unless ← path.pathExists do return #[]
  let text ← IO.FS.readFile path
  if (trim text).isEmpty then return #[]
  match Json.parse text with
  | .error e => throw <| IO.userError s!"{path}: {e}"
  | .ok j =>
    match j.getObjVal? "snapshots" with
    | .ok (.arr xs) => return sortHistory (xs.filterMap HistoryEntry.ofJson)
    | _ => throw <| IO.userError s!"{path}: no 'snapshots' array"

/-- Write `index.json`, sorted and with a trailing newline. -/
def writeHistoryIndex (path : System.FilePath) (es : Array HistoryEntry) : IO Unit := do
  if let some d := path.parent then IO.FS.createDirAll d
  let j := Json.mkObj [("snapshots", Json.arr ((sortHistory es).map HistoryEntry.toJson))]
  IO.FS.writeFile path (j.pretty ++ "\n")

/-- `blueprint history add`: copy `snapshot` into `dir` as `<sha>.json`,
summarise it, and fold it into `dir/index.json`. -/
def historyAdd (dir : System.FilePath) (snapshot : System.FilePath) (sha date : String) :
    IO (HistoryEntry × Nat) := do
  let text ← IO.FS.readFile snapshot
  let snap ← match Snapshot.parse text with
    | .error e => throw <| IO.userError s!"{snapshot}: {e}"
    | .ok s => pure s
  IO.FS.createDirAll dir
  IO.FS.writeFile (dir / (sha ++ ".json")) text
  let entry : HistoryEntry :=
    { sha, date, file := s!"data/{sha}.json", summary := snap.summary }
  let index := dir / "index.json"
  let es := upsertHistory (← readHistoryIndex index) entry
  writeHistoryIndex index es
  return (entry, es.size)

end Blueprint
