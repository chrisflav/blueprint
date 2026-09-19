import Blueprint.Extract
import Blueprint.Site

/-!
# The command line

`DESIGN.md` §8.  Phase 1 implements `check`, `build`, `new`, `rename` and
`view`, phase 2 adds `extract`, phase 4 adds `diff`, `log`, `progress`,
`history add`, `site` and `serve`.
-/

namespace Blueprint

open Lean (Json)

/-! ## Argument parsing -/

/-- Options that take a value. -/
def valueOptions : Array String :=
  #["--root", "-o", "--output", "--facts", "--view", "--collapse", "--expand", "--dir",
    "--snapshot", "--names", "--out", "--limit", "--since", "--history", "--port",
    "--site", "--sha", "--date"]

/-- Positional arguments and options, parsed without any dependencies. -/
structure Args where
  /-- Positional arguments, in order. -/
  positional : Array String := #[]
  /-- Options; boolean flags have the value `""`. -/
  options : Array (String × String) := #[]
  deriving Inhabited

namespace Args

/-- Parse a command line. -/
def parse : List String → Except String Args
  | [] => .ok {}
  | a :: rest =>
    if a.startsWith "--" || (a.startsWith "-" && a.length > 1 && a != "-") then
      if valueOptions.contains a then
        match rest with
        | [] => .error s!"option {a} needs a value"
        | v :: rest' => do
          let r ← parse rest'
          return { r with options := #[(a, v)] ++ r.options }
      else do
        let r ← parse rest
        return { r with options := #[(a, "")] ++ r.options }
    else do
      let r ← parse rest
      return { r with positional := #[a] ++ r.positional }

/-- The value of an option. -/
def get? (a : Args) (n : String) : Option String := (a.options.find? (·.1 == n)).map (·.2)

/-- Was a flag given? -/
def has (a : Args) (n : String) : Bool := (a.get? n).isSome

/-- Options this command does not know about. -/
def unknown (a : Args) (known : Array String) : Array String :=
  (a.options.filter fun (n, _) => !known.contains n).map (·.1)

end Args

/-! ## Loading a project

`Loaded`, `load` and `loadFactsIfPresent` live in `Blueprint.Diff`, which
needs them to compile a snapshot out of a materialised git tree.
-/

/-- Summarise a list of checks. -/
def summarise (cs : Array Check) : String :=
  let e := (cs.filter (·.level == "error")).size
  let w := (cs.filter (·.level == "warning")).size
  let i := (cs.filter (·.level == "info")).size
  s!"{e} error(s), {w} warning(s), {i} info"

/-! ## `blueprint check` -/

/-- Checks as JSON. -/
def checksJson (cs : Array Check) : Json :=
  Json.mkObj [
    ("checks", Json.arr (cs.map Check.toJson)),
    ("errors", Json.num (Lean.JsonNumber.fromInt (cs.filter (·.level == "error")).size)),
    ("warnings", Json.num (Lean.JsonNumber.fromInt (cs.filter (·.level == "warning")).size)),
    ("infos", Json.num (Lean.JsonNumber.fromInt (cs.filter (·.level == "info")).size))]

/-- `blueprint check [--lean] [--view K] [--json]` -/
def cmdCheck (root : System.FilePath) (args : Args) : IO UInt32 := do
  let l ← load root
  let mut facts : Option Facts := none
  if args.has "--lean" then
    let p := root / "lean-facts.json"
    match ← loadFactsIfPresent p with
    | some f => facts := some f
    | none => throw <| IO.userError s!"{p}: no Lean facts; run 'lake exe blueprint extract' first"
  if let some k := args.get? "--view" then
    match l.blueprint.schema.kind? k with
    | none => throw <| IO.userError s!"unknown kind '{k}'"
    | some spec => unless spec.collapse do
        throw <| IO.userError s!"kind '{k}' is not declared collapse = true"
  let a := analyse l.blueprint l.checks facts (args.get? "--view")
  if args.has "--json" then
    IO.println (checksJson a.checks).pretty
  else
    for c in a.checks do
      IO.println c.render
    IO.println s!"{a.blueprint.objects.size} object(s); {summarise a.checks}"
  return if hasErrors a.checks then 1 else 0

/-! ## `blueprint build` -/

/-- `blueprint build [-o file] [--facts lean-facts.json]` -/
def cmdBuild (root : System.FilePath) (args : Args) : IO UInt32 := do
  let l ← load root
  let factsPath : System.FilePath :=
    match args.get? "--facts" with
    | some p => p
    | none => root / "lean-facts.json"
  if let some p := args.get? "--facts" then
    unless ← System.FilePath.pathExists p do
      throw <| IO.userError s!"{p}: no such file"
  let facts ← loadFactsIfPresent factsPath
  let a := analyse l.blueprint l.checks facts (args.get? "--view")
  let out : System.FilePath :=
    match args.get? "-o" with
    | some p => p
    | none => match args.get? "--output" with
      | some p => p
      | none => root / "blueprint.json"
  IO.FS.writeFile out (a.snapshot facts).render
  IO.println s!"wrote {out} ({a.blueprint.objects.size} objects; {summarise a.checks})"
  for c in a.checks do
    if c.level == "error" then IO.eprintln c.render
  return if hasErrors a.checks then 1 else 0

/-! ## `blueprint extract` -/

/-- Split a comma separated option value, dropping empty entries. -/
def splitList (s : String) : Array String :=
  ((s.splitOn ",").toArray.map trim).filter (fun (x : String) => !x.isEmpty)

/-- `blueprint extract [modules...] [--root d] [--snapshot f] [--names a,b]
[--out f]`.

The constants to report on are the union of the `@[blueprint]` tags of the
imported environment (the extractor finds those itself), `--names`, the
`lean` attributes of a snapshot given with `--snapshot`, and the `lean`
attributes of the blueprint sources under `--root`. -/
def cmdExtract (args : Args) : IO UInt32 := do
  let rootArg := args.get? "--root"
  let mut modules : Array Lean.Name :=
    (args.positional.toList.drop 1).toArray.map String.toName
  let mut names : Array String := #[]
  if let some s := args.get? "--names" then
    names := names ++ splitList s
  if let some p := args.get? "--snapshot" then
    let path : System.FilePath := p
    unless ← path.pathExists do
      throw <| IO.userError s!"{p}: no such file"
    match Snapshot.parse (← IO.FS.readFile path) with
    | .error e => throw <| IO.userError s!"{p}: {e}"
    | .ok s =>
      for o in s.objects do
        names := names ++ o.leanNames
  if let some r := rootArg then
    let root : System.FilePath := r
    let (project, schema) ← loadConfig root
    if modules.isEmpty then
      modules := project.leanModules.map String.toName
    let parsed ← parseProject root project schema
    for o in parsed.objects do
      names := names ++ o.leanNames
  if modules.isEmpty then
    throw <| IO.userError
      "no modules to import: name them on the command line, or set '[lean] modules' in blueprint.toml"
  let facts ← extract modules (sortDedup names)
  let out : System.FilePath := match args.get? "--out" with
    | some p => p
    | none => match rootArg with
      | some r => (System.FilePath.mk r) / "lean-facts.json"
      | none => "lean-facts.json"
  IO.FS.writeFile out facts.render
  let missing := (facts.decls.filter (fun d => !d.present)).size
  IO.println s!"wrote {out} ({facts.decls.size} constant(s), \
    {facts.attrMap.size} tagged, {missing} missing)"
  return 0

/-! ## `blueprint read` -/

/-- `blueprint read <file> [-o out]`: parse a snapshot and write it out
again.  Not in `DESIGN.md` §8; it exists so that the round trip through
`Snapshot.ofJson` is testable, and `diff` will need the reader anyway. -/
def cmdRead (args : Args) : IO UInt32 := do
  match (args.positional[1]? : Option String) with
  | none =>
    IO.eprintln "usage: blueprint read <blueprint.json> [-o out.json]"
    return 1
  | some p =>
    let text ← IO.FS.readFile (System.FilePath.mk p)
    match Snapshot.parse text with
    | .error e => throw <| IO.userError s!"{p}: {e}"
    | .ok s =>
      match args.get? "-o" with
      | some o => do
        IO.FS.writeFile (System.FilePath.mk o) s.render
        IO.println s!"read {p} ({s.objects.size} objects), wrote {o}"
      | none => IO.print s.render
      return 0

/-! ## `blueprint view` -/

/-- `blueprint view [--collapse K] [--expand id,...] [--json]` -/
def cmdView (root : System.FilePath) (args : Args) : IO UInt32 := do
  let l ← load root
  let a := analyse l.blueprint l.checks none (args.get? "--collapse")
  let b := a.blueprint
  let kind ← match args.get? "--collapse" with
    | some k => pure k
    | none => match b.schema.mainCollapse? with
      | some k => pure k
      | none => throw <| IO.userError "the schema declares no collapsible kind"
  match b.schema.kind? kind with
  | none => throw <| IO.userError s!"unknown kind '{kind}'"
  | some k => unless k.collapse do
      throw <| IO.userError s!"kind '{kind}' is not declared collapse = true"
  let c := Collapse.of b kind
  let expandIds := match args.get? "--expand" with
    | some s => ((s.splitOn ",").toArray.map trim).filter (fun (x : String) => !x.isEmpty)
    | none => #[]
  let mut idxs : Array Nat := #[]
  for i in expandIds do
    match b.findIdx? i with
    | some j => idxs := idxs.push j
    | none => throw <| IO.userError s!"unknown object '{i}'"
  let q := quotient b (View.of c idxs)
  if args.has "--json" then IO.println q.toJson.pretty else IO.print q.render
  return 0

/-! ## `blueprint new` -/

/-- `blueprint new <kind> <id> [--dir d]` -/
def cmdNew (root : System.FilePath) (args : Args) : IO UInt32 := do
  match args.positional[1]?, args.positional[2]? with
  | some kind, some id =>
    let (project, schema) ← loadConfig root
    match schema.kind? kind with
    | none => throw <| IO.userError s!"unknown kind '{kind}'"
    | some spec =>
      let dir := match args.get? "--dir" with
        | some d => root / project.dir / d
        | none => root / project.dir
      IO.FS.createDirAll dir
      let file := dir / (sanitizeIdPart id ++ ".md")
      if ← file.pathExists then
        throw <| IO.userError s!"{file}: already exists"
      let boundary :=
        if spec.roles.isEmpty then "" else
          "boundary = {" ++ String.intercalate ", " (spec.roles.toList.map fun r =>
            if r.card.max == some 1 then s!"{r.name} = \"\"" else s!"{r.name} = []") ++ "}\n"
      let title := if spec.attrs.contains "title" then "title    = \"\"\n" else ""
      let text := "+++\n" ++ s!"id       = \"{id}\"\n" ++ s!"kind     = \"{kind}\"\n"
        ++ title ++ boundary ++ "+++\n\n"
      IO.FS.writeFile file text
      IO.println s!"wrote {file}"
      return 0
  | _, _ =>
    IO.eprintln "usage: blueprint new <kind> <id> [--dir d]"
    return 1

/-! ## `blueprint rename` -/

/-- Rewrite `old` to `new` wherever it occurs as a `/` or `~` separated
segment of a slug. -/
def rewriteSegments (s old new : String) : String :=
  String.intercalate "/" ((s.splitOn "/").map fun part =>
    String.intercalate "~" ((part.splitOn "~").map fun seg =>
      if seg == old then new else seg))

/-- Rewrite every double quoted string of a TOML document with `f`. -/
def rewriteQuoted (text : String) (f : String → String) : String := Id.run do
  let mut out := ""
  let mut cur := ""
  let mut inStr := false
  for c in text.toList do
    if inStr then
      if c == '"' then
        out := out ++ f cur ++ "\""
        cur := ""
        inStr := false
      else
        cur := cur.push c
    else
      if c == '"' then
        out := out.push c
        inStr := true
      else
        out := out.push c
  return out ++ cur

/-- Split a source file into front matter lines and the rest. -/
def splitRawFile (text : String) : Option (Array String × Array String) :=
  let lines := splitLines text
  let isFence (l : String) := trim l == "+++"
  if !(lines[0]?.any isFence) then none else
    match (lines.toList.drop 1).findIdx? isFence with
    | none => none
    | some i => some (((lines.toList.drop 1).take i).toArray,
                      ((lines.toList.drop (i + 2)).toArray))

/-- Add `old` to the `aliases` array of a front matter block. -/
def recordAlias (front : Array String) (old : String) : Array String := Id.run do
  match front.findIdx? (fun l => (trim l).startsWith "aliases") with
  | some i =>
    let l := front[i]!
    match l.splitOn "[" with
    | [before, after] =>
      let inner := trim (after.splitOn "]").head!
      let items := if inner.isEmpty then s!"\"{old}\"" else inner ++ s!", \"{old}\""
      return front.set! i (before ++ "[" ++ items ++ "]")
    | _ => return front
  | none => return front.push s!"aliases  = [\"{old}\"]"

/-- Does this front matter block set `id` explicitly? -/
def hasExplicitId (front : Array String) : Bool :=
  front.any fun l =>
    match l.splitOn "=" with
    | key :: _ :: _ => trim key == "id"
    | _ => false

/-- `blueprint rename <old> <new>` -/
def cmdRename (root : System.FilePath) (args : Args) : IO UInt32 := do
  match args.positional[1]?, args.positional[2]? with
  | some old, some new =>
    if old == new then
      IO.eprintln "the two ids are the same"
      return 1
    let l ← load root
    unless l.blueprint.contains old do
      throw <| IO.userError s!"no object with id '{old}'"
    if l.blueprint.contains new then
      throw <| IO.userError s!"an object with id '{new}' already exists"
    let declaring := (l.blueprint.find? old).filter (fun o => !o.source.anonymous)
    let files ← collectMarkdown (root / l.blueprint.project.dir)
    let mut touched := 0
    for (rel, path) in files do
      let relFull := l.blueprint.project.dir ++ "/" ++ rel
      let text ← IO.FS.readFile path
      match splitRawFile text with
      | none => pure ()
      | some (front, rest) =>
        let isDeclaring := declaring.any fun o => o.source.file == relFull
        let mut front := front.map fun line => rewriteQuoted line (rewriteSegments · old new)
        if isDeclaring then
          front := recordAlias front old
          unless hasExplicitId front do
            front := #[s!"id       = \"{new}\""] ++ front
        let rest := rest.map fun line =>
          replaceAll line ("[" ++ old ++ "]") ("[" ++ new ++ "]")
        let out := String.intercalate "\n"
          (["+++"] ++ front.toList ++ ["+++"] ++ rest.toList)
        if out != text then
          IO.FS.writeFile path out
          touched := touched + 1
          -- The file keeps its name; the inserted `id` key makes the new id
          -- explicit, so the file name no longer determines it.
    IO.println s!"renamed '{old}' to '{new}' in {touched} file(s)"
    return 0
  | _, _ =>
    IO.eprintln "usage: blueprint rename <old> <new>"
    return 1

/-! ## `blueprint diff` -/

/-- `blueprint diff <A> <B> [--json] [--no-fail]`.  Each side is either a
path to a `blueprint.json` or a git revision, whose tree is materialised into
a temporary directory and compiled in memory. -/
def cmdDiff (root : System.FilePath) (args : Args) : IO UInt32 := do
  match args.positional[1]?, args.positional[2]? with
  | some a, some b =>
    let ctx ← gitContext? root
    IO.FS.withTempDir fun tmp => do
      let before ← loadSide ctx root (tmp / "a") a
      let after ← loadSide ctx root (tmp / "b") b
      let d := diffSnapshots before after
      if args.has "--json" then
        IO.println d.toJson.pretty
        for c in d.regressions do IO.eprintln c.render
      else
        IO.print d.render
      if !d.regressions.isEmpty && !args.has "--no-fail" then return 1
      return 0
  | _, _ =>
    IO.eprintln "usage: blueprint diff <A> <B> [--json] [--no-fail]"
    IO.eprintln "  each side is a blueprint.json or a git revision"
    return 1

/-! ## `blueprint log` -/

/-- The directory part of a `/` separated path, `""` at the top. -/
def dirPart (path : String) : String :=
  String.intercalate "/" (path.splitOn "/").dropLast

/-- `blueprint log <id> [--limit n]`: the commits of `git log --first-parent`
that touched the file declaring the object (or a file named after one of its
aliases), and what each of them did to that object. -/
def cmdLog (root : System.FilePath) (args : Args) : IO UInt32 := do
  let some id := args.positional[1]?
    | do IO.eprintln "usage: blueprint log <id> [--limit n]"; return 1
  let limit := match (args.get? "--limit").bind String.toNat? with
    | some n => max n 1
    | none => 20
  let ctx ← gitContext root
  let l ← load root
  let project := l.blueprint.project
  let schema := l.blueprint.schema
  let obj ← match l.blueprint.find? id with
    | some o => pure o
    | none => match l.blueprint.objects.find? (fun o => (o.attrStrings "aliases").contains id) with
      | some o => pure o
      | none => throw <| IO.userError s!"no object with id '{id}' (and none has it as an alias)"
  let aliases := obj.attrStrings "aliases"
  -- The files to follow: the one that declares the object, plus a sibling
  -- named after each alias, which is where a renamed object used to live.
  let dir := dirPart obj.source.file
  let aliasFiles := aliases.map fun a =>
    (if dir.isEmpty then "" else dir ++ "/") ++ sanitizeIdPart a ++ ".md"
  let rels := sortDedup (#[obj.source.file] ++ aliasFiles)
  let paths := rels.map ctx.repoPath
  -- one commit more than asked for, to tell "this is where it was added" from
  -- "this is where the list stops"
  let all ← logCommits ctx paths (some (limit + 1))
  let truncated := all.size > limit
  let commits := all.take limit
  IO.println s!"log {obj.id}  [{obj.kind}]  {obj.source.file}"
  if commits.isEmpty then
    IO.println "no commit in this work tree touches that file"
    return 0
  -- The object's state at each commit, newest first — including the one
  -- extra commit, which is what the oldest listed one is compared against.
  -- The set of ids to look for grows as older revisions turn up aliases.
  let mut ids := sortDedup (#[obj.id] ++ aliases)
  let mut states : Array (Option Object) := #[]
  for c in all do
    let mut found : Option Object := none
    for (rel, path) in rels.zip paths do
      if found.isSome then continue
      if let some text ← showFile? ctx c.sha path then
        if let some o ← parseOneFile project schema rel text then
          if ids.contains o.id then found := some o
    if let some o := found then
      ids := sortDedup (ids ++ o.attrStrings "aliases")
    states := states.push found
  for i in [0 : commits.size] do
    let c := commits[i]!
    IO.println ""
    IO.println s!"{c.short}  {c.date}  {c.subject}"
    let cur := states[i]!
    let prev := (states[i + 1]?).getD none
    match cur, prev with
    | none, none => IO.println "    (the object is not in this revision)"
    | some _, none => IO.println "    + added"
    | none, some o => IO.println s!"    - removed (was a {o.kind})"
    | some o, some p =>
      let ch := compareObjects p.id o.id p o
      if ch.isEmpty then
        IO.println "    (the file changed, the object did not)"
      else
        for line in ch.lines do IO.println s!"    {line}"
  if truncated then
    IO.println ""
    IO.println s!"(stopped at --limit {limit})"
  return 0

/-! ## `blueprint progress` -/

/-- Pad a string on the right. -/
def padRight (s : String) (n : Nat) : String :=
  s ++ String.ofList (List.replicate (n - s.length) ' ')

/-- Pad a string on the left. -/
def padLeft (s : String) (n : Nat) : String :=
  String.ofList (List.replicate (n - s.length) ' ') ++ s

/-- The status counts of a snapshot, per kind: one row per kind that has
objects with a derived status, in the column order of `statusOrder`. -/
def statusTable (s : Snapshot) : String := Id.run do
  let b := s.blueprint
  let mut rows : Array (String × Array Nat) := #[]
  for (id, st) in s.statuses do
    if let some o := b.find? id then
      let name := o.kind ++ (if (b.kindOf? o).any KindSpec.countable then "*" else "")
      let col := (statusOrder.findIdx? (· == st.toString)).getD 0
      rows := match rows.findIdx? (·.1 == name) with
        | some i =>
          let (n, cs) := rows[i]!
          rows.set! i (n, cs.set! col (cs[col]! + 1))
        | none => rows.push (name, (Array.range statusOrder.size).map fun j =>
            if j == col then 1 else 0)
  let sorted := rows.qsort (fun x y => x.1 < y.1)
  let nameW := sorted.foldl (init := 4) (fun w r => max w r.1.length)
  let widths := statusOrder.map (fun c => c.length)
  let header := padRight "kind" nameW ++ "  " ++
    String.intercalate "  " (statusOrder.toList.map fun c => c) ++ "  total"
  let mut out := #[header]
  let mut totals : Array Nat := statusOrder.map fun _ => 0
  for (name, cs) in sorted do
    let total := cs.foldl (· + ·) 0
    out := out.push <| padRight name nameW ++ "  " ++
      String.intercalate "  " ((cs.zip widths).toList.map fun (n, w) => padLeft (toString n) w)
      ++ "  " ++ padLeft (toString total) 5
    totals := (totals.zip cs).map fun (a, b) => a + b
  let grand := totals.foldl (· + ·) 0
  out := out.push <| padRight "all" nameW ++ "  " ++
    String.intercalate "  " ((totals.zip widths).toList.map fun (n, w) => padLeft (toString n) w)
    ++ "  " ++ padLeft (toString grand) 5
  return String.intercalate "\n" out.toList

/-- `blueprint progress [--since rev] [--facts path]` -/
def cmdProgress (root : System.FilePath) (args : Args) : IO UInt32 := do
  let l ← load root
  let factsPath : System.FilePath := match args.get? "--facts" with
    | some p => p
    | none => root / "lean-facts.json"
  let facts ← loadFactsIfPresent factsPath
  let a := analyse l.blueprint l.checks facts none
  let snap := a.snapshot facts
  let sum := snap.summary
  IO.println s!"progress for {snap.project.name}: {sum.fraction} countable objects proved"
  if facts.isNone then
    IO.println s!"(no Lean facts at {factsPath}: every status is 'absent')"
  IO.println ""
  IO.println (statusTable snap)
  IO.println ""
  IO.println "* countable kinds (the ones progress fractions are over)"
  if let some rev := args.get? "--since" then
    let ctx ← gitContext root
    IO.FS.withTempDir fun tmp => do
      let before ← loadSide (some ctx) root (tmp / "since") rev
      let after : SnapshotSide := { label := "working tree", snapshot := snap }
      let d := diffSnapshots before after
      IO.println ""
      IO.println s!"since {before.describe}:"
      if d.withStatus then
        if d.statusChanges.isEmpty then
          IO.println "  no status changed"
        else
          for c in d.statusChanges do
            if let some (o, n) := c.statusChange then
              IO.println s!"  ! {c.id}  {o} -> {n}"
      else
        IO.println "  (statuses are not comparable: one of the two sides has no Lean facts)"
      for c in d.regressions do IO.println s!"  {c.render}"
      IO.println s!"  {d.summaryLine}"
      return 0
  else
    return 0

/-! ## `blueprint site` -/

/-- The value of `-o` or `--output`. -/
def outOption (args : Args) : Option String :=
  match args.get? "-o" with
  | some p => some p
  | none => args.get? "--output"

/-- Assemble the static site: the website, a freshly built `blueprint.json`
next to its `index.html`, and, with `--history`, the snapshot history under
`data/`.  Returns the exit status of the build. -/
def assembleSite (root : System.FilePath) (out : System.FilePath) (args : Args) :
    IO UInt32 := do
  let web ← findWebDir root
  if let some p := args.get? "--facts" then
    unless ← System.FilePath.pathExists p do
      throw <| IO.userError s!"{p}: no such file"
  let factsPath : System.FilePath := match args.get? "--facts" with
    | some p => p
    | none => root / "lean-facts.json"
  let facts ← loadFactsIfPresent factsPath
  let l ← load root
  let a := analyse l.blueprint l.checks facts none
  let snap := a.snapshot facts
  IO.FS.createDirAll out
  let copied ← copyDir web out siteExcludes
  IO.FS.writeFile (out / "blueprint.json") snap.render
  IO.println s!"site: {out} ({copied} file(s) from {web}, \
    {snap.objects.size} objects; {summarise a.checks})"
  if let some h := args.get? "--history" then
    let data := out / "data"
    let n ← copyDir h data
    -- The current snapshot must be in the index, or the time slider would
    -- stop short of what the site actually shows.
    let index := data / "index.json"
    let es ← readHistoryIndex index
    let ctx ← gitContext? root
    let sha ← match ctx with
      | some c => pure ((← headSha? c).getD "current")
      | none => pure "current"
    if es.any (·.sha == sha) then
      IO.println s!"history: {data} ({n} file(s), {es.size} snapshot(s), \
        {sha.take 8} already indexed)"
    else
      let date ← match ctx with
        | some c => do
          match ← commitDate? c sha with
          | some d => pure d
          | none => todayISO
        | none => todayISO
      -- An unknown date would sort the current snapshot first; keeping the
      -- last known date instead keeps it at the end of the slider.
      let date := if date.isEmpty then (es.back?.map (·.date)).getD "" else date
      let es := upsertHistory es
        { sha, date, file := "blueprint.json", summary := snap.summary }
      writeHistoryIndex index es
      IO.println s!"history: {data} ({n} file(s), {es.size} snapshot(s), \
        added the current one as {sha.take 8})"
  return if hasErrors a.checks then 1 else 0

/-- `blueprint site [-o dir] [--facts f] [--history dir]` -/
def cmdSite (root : System.FilePath) (args : Args) : IO UInt32 := do
  let out : System.FilePath := (outOption args).getD (root / "_site").toString
  assembleSite root out args

/-! ## `blueprint serve` -/

/-- The static file servers `blueprint serve` knows about, in the order it
tries them: the command to probe for, and the command line to run.

Core Lean has no socket API that a small static server could be built on
without pulling in `Std.Http`, so `serve` borrows one. -/
def serverCandidates (dir : System.FilePath) (port : Nat) :
    Array (String × Array String) :=
  #[("python3", #["-m", "http.server", toString port, "--directory", dir.toString]),
    ("npx", #["serve", "-l", toString port, dir.toString]),
    ("busybox", #["httpd", "-f", "-p", toString port, "-h", dir.toString]),
    ("nix-shell", #["-p", "python3", "--run",
      s!"python3 -m http.server {port} --directory {dir}"])]

/-- `blueprint serve [--port p] [--site dir]`: refresh the site, then serve
it with whatever static file server is at hand. -/
def cmdServe (root : System.FilePath) (args : Args) : IO UInt32 := do
  let dir : System.FilePath := (args.get? "--site").getD (root / "_site").toString
  let port := match (args.get? "--port").bind String.toNat? with
    | some p => p
    | none => 8000
  let rc ← assembleSite root dir args
  if rc != 0 then
    IO.eprintln "blueprint: the blueprint has errors; serving it anyway"
  let candidates := serverCandidates dir port
  for (cmd, cmdArgs) in candidates do
    if ← haveExe cmd then
      IO.println s!"serving {dir} at http://localhost:{port}/ with {cmd} (Ctrl-C to stop)"
      let child ← IO.Process.spawn { cmd, args := cmdArgs }
      return ← child.wait
  IO.eprintln s!"blueprint: no static file server found; the site is ready in {dir}."
  IO.eprintln "serve it with any of:"
  for (cmd, cmdArgs) in candidates do
    let shown := cmdArgs.toList.map fun a =>
      if containsSubstr a " " then "\"" ++ a ++ "\"" else a
    IO.eprintln s!"  {cmd} {String.intercalate " " shown}"
  return 1

/-! ## `blueprint history` -/

/-- `blueprint history add <snapshot.json> --dir <dir> [--sha s] [--date d]` -/
def cmdHistory (root : System.FilePath) (args : Args) : IO UInt32 := do
  match (args.positional[1]? : Option String), (args.positional[2]? : Option String) with
  | some "add", some snapArg =>
    let snap : System.FilePath := snapArg
    let dir : System.FilePath ← match args.get? "--dir" with
      | some d => pure (System.FilePath.mk d)
      | none => throw <| IO.userError "history add: --dir <historydir> is required"
    unless ← snap.pathExists do
      throw <| IO.userError s!"{snap}: no such file"
    let ctx ← gitContext? root
    let sha ← match args.get? "--sha" with
      | some s => pure s
      | none =>
        match ctx with
        | some c =>
          match ← headSha? c with
          | some s => pure s
          | none =>
            throw <| IO.userError s!"{root}: the repository has no HEAD; pass --sha"
        | none =>
          throw <| IO.userError s!"{root}: not inside a git work tree; pass --sha"
    let date ← match args.get? "--date" with
      | some d => pure d
      | none =>
        match ctx with
        | some c =>
          match ← commitDate? c sha with
          | some d => pure d
          | none => todayISO
        | none => todayISO
    let (e, n) ← historyAdd dir snap sha date
    IO.println s!"history: {dir}/{sha}.json ({e.date}, {e.summary.fraction} proved); \
      {dir}/index.json now has {n} snapshot(s)"
    return 0
  | _, _ =>
    IO.eprintln "usage: blueprint history add <blueprint.json> --dir <dir> [--sha s] [--date d]"
    return 1

/-! ## Entry point -/

/-- The `--help` text. -/
def usage : String :=
  "blueprint - the informal side of a formalisation project

usage: blueprint <command> [options]

commands:
  check  [--lean] [--view K] [--json]      validate schema, constraints,
                                           references and lints
  build  [-o file] [--facts path]          compile blueprint.json
  new    <kind> <id> [--dir d]             scaffold a source file
  rename <old> <new>                       rewrite references, record an alias
  view   [--collapse K] [--expand ids]     print the quotient graph
         [--json]
  read   <blueprint.json> [-o out]         parse a snapshot and write it back
  extract [modules...] [--root d]          import the modules and write
          [--snapshot f] [--names a,b]     lean-facts.json
          [--out f]
  diff   <A> <B> [--json] [--no-fail]      semantic diff of two snapshots;
                                           each side is a blueprint.json or a
                                           git revision
  log    <id> [--limit n]                  what every commit did to one object
  progress [--since rev] [--facts f]       status counts by kind, and the
                                           change since a revision
  site   [-o dir] [--facts f]              assemble the static website
         [--history dir]
  serve  [--port p] [--site dir]           refresh the site and serve it
         [--history dir]
  history add <blueprint.json> --dir d     file a snapshot in the history
          [--sha s] [--date d]             directory and update its index

global options:
  --root <dir>   project root (default: the working directory)
  --help         this message

exit status is 1 when any error level check fires, and for 'diff' when a
derived status fell back from proved (pass --no-fail to allow it).
"

/-- Dispatch one command. -/
def run (argv : List String) : IO UInt32 := do
  match Args.parse argv with
  | .error e => do IO.eprintln s!"blueprint: {e}"; return 1
  | .ok args =>
    if args.has "--help" || args.positional.isEmpty then
      IO.println usage
      return if args.positional.isEmpty && !args.has "--help" then 1 else 0
    let root : System.FilePath := (args.get? "--root").getD "."
    unless ← root.pathExists do
      IO.eprintln s!"blueprint: {root}: no such directory"
      return 1
    let known : Array String := #["--root"] ++ (match args.positional[0]! with
      | "check" => #["--lean", "--view", "--json"]
      | "build" => #["-o", "--output", "--facts", "--view"]
      | "view" => #["--collapse", "--expand", "--json"]
      | "new" => #["--dir"]
      | "read" => #["-o"]
      | "extract" => #["--snapshot", "--names", "--out"]
      | "diff" => #["--json", "--no-fail"]
      | "log" => #["--limit"]
      | "progress" => #["--since", "--facts"]
      | "site" => #["-o", "--output", "--facts", "--history"]
      | "serve" => #["--port", "--site", "--facts", "--history"]
      | "history" => #["--dir", "--sha", "--date"]
      | _ => #[])
    for o in args.unknown known do
      IO.eprintln s!"blueprint: warning: ignoring unknown option {o}"
    match args.positional[0]! with
    | "check" => cmdCheck root args
    | "build" => cmdBuild root args
    | "view" => cmdView root args
    | "new" => cmdNew root args
    | "rename" => cmdRename root args
    | "read" => cmdRead args
    | "extract" => cmdExtract args
    | "diff" => cmdDiff root args
    | "log" => cmdLog root args
    | "progress" => cmdProgress root args
    | "site" => cmdSite root args
    | "serve" => cmdServe root args
    | "history" => cmdHistory root args
    | c => do
      IO.eprintln s!"blueprint: unknown command '{c}'"
      IO.eprintln usage
      return 1


/-- Run the CLI, reporting errors as `blueprint: ...` on stderr. -/
def cli (argv : List String) : IO UInt32 := do
  try
    run argv
  catch e =>
    IO.eprintln s!"blueprint: {e}"
    return 1

end Blueprint
