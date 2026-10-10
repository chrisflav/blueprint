import Blueprint.Diff
import Blueprint.ImportLatex

/-!
# `blueprint migrate`

Moves a blueprint written before proofs were objects (`DESIGN.md` §2.5) onto
them.  Three steps, in one pass over the sources, each safe to run again:

* **Sketches.**  A section whose body opens with `*Proposition (sketch).*`
  (any kind of the schema in place of `Proposition`) is that statement, at
  the level of a sketch: it becomes an object of that kind, tagged `sketch`,
  without the lead-in.  It keeps its id, its file and whatever refines it.
* **Split.**  Every proof in the body of a statement the `proof` kind may
  attach to (`splitProofs?`) moves into a proof file of its own next to it:
  `<stem>.proof.md` for the first, `<stem>.proof-<k>.md` with the id
  `proof/<id>/<k>` for the `k`-th, the stem being the id for a directory's
  `_section.md`.  A proof of a restatement under a heading of its own (a
  `Detailed form`) is titled after it, and the restatement stays with the
  statement.  Proofs found after an earlier run are numbered after it.
* **Move uses.**  When the Lean facts split each declaration's dependencies
  into type and value, a `uses` the statement's sugar key declares and Lean
  needs only in the proof moves to the proof.  A use the facts do not decide
  stays on the statement, and so does every edge written out in a file of
  its own.
-/

namespace Blueprint

/-! ## Text surgery -/

/-- The level of a Markdown ATX heading line, if it is one. -/
def headingLevel? (line : String) : Option Nat :=
  let hashes := (line.toList.takeWhile (· == '#')).length
  if hashes == 0 || hashes > 6 then none
  else match line.toList.drop hashes with
    | [] => some hashes
    | c :: _ => if c == ' ' || c == '\t' then some hashes else none

/-- Is this line a heading that opens a proof: `## Proof` or `## Proof.`? -/
def isProofHeading (line : String) : Bool :=
  (headingLevel? line).isSome &&
    let text := trim (String.ofList (line.toList.dropWhile (· == '#')))
    text == "Proof" || text == "Proof."

/-- Join blocks of lines with exactly one blank line between nonempty ones. -/
def joinBlocks (blocks : Array (Array String)) : String :=
  let texts := blocks.filterMap fun ls =>
    let t := trim (String.intercalate "\n" ls.toList)
    if t.isEmpty then none else some t
  String.intercalate "\n\n" texts.toList

/-- One proof cut out of a statement's body. -/
structure CutProof where
  /-- What it proves, when that is not simply the statement: `of the
  detailed form`, `of (i)`. -/
  title : Option String
  /-- Its text. -/
  text : String
  deriving Inhabited

/-- `*Proof.*`, `**Proof.**`, `_Proof._` or `*Proof of (i).*` opening a line:
the title the marker gives (`of (i)`, or none) and the rest of the line. -/
def inlineProofMarker? (line : String) : Option (Option String × String) := Id.run do
  for d in ["**", "*", "_"] do
    if !(line.startsWith (d ++ "Proof")) then continue
    let after := (line.drop d.length).copy
    match after.splitOn d with
    | inner :: rest@(_ :: _) =>
      let inner := trim inner
      if inner == "Proof" || inner == "Proof." then
        return some (none, trim (d.intercalate rest))
      if inner.startsWith "Proof " && inner.endsWith "." then
        -- `Proof of (i).` says what it proves; `Proof sketch.` or
        -- `Proof (sketch).` says what kind of proof it is
        let t := trim ((inner.drop 6).dropEnd 1).copy
        let t := if t.startsWith "(" && t.endsWith ")" then trim ((t.drop 1).dropEnd 1).copy else t
        return some (some t, trim (d.intercalate rest))
    | _ => pure ()
  return none

/-- The title of a proof that follows a claim set under its own heading:
`Detailed form` gives `of the detailed form`. -/
def titleAfterHeading (heading : String) : String :=
  let h := trim (String.ofList (heading.toList.dropWhile (· == '#')))
  let lowered := match h.toList with
    | c :: d :: cs => if d.isUpper then h else String.ofList (c.toLower :: d :: cs)
    | _ => h.toLower
  if lowered.startsWith "the " then "of " ++ lowered else "of the " ++ lowered

/-- Cut every proof out of a statement's body: the statement's remaining text
and the proofs, in order.  A proof is a `Proof` heading's section, up to the
next heading of the same or a higher level, with any markers inside it, or a
paragraph opened by an inline marker (`*Proof.*`), up to the next such marker
or the next heading that closes the heading it sits under.  A proof that
follows a claim under a heading of its own (a `Detailed form`) is titled
after it, `*Proof of (i).*` by what it names.  Fenced code is never cut.
`none` when there is no proof. -/
def splitProofs? (body : String) : Option (String × Array CutProof) := Id.run do
  let lines := splitLines body
  let n := lines.size
  -- lines inside a fenced code block (the fences included) are never
  -- headings or markers
  let mut fenced : Array Bool := #[]
  let mut open_ := false
  for l in lines do
    let t := trim l
    let fence := t.startsWith "```" || t.startsWith "~~~"
    fenced := fenced.push (open_ || fence)
    if fence then open_ := !open_
  let level? (j : Nat) : Option Nat := if fenced[j]! then none else headingLevel? lines[j]!
  let marker? (j : Nat) : Option (Option String × String) :=
    if fenced[j]! then none else inlineProofMarker? lines[j]!
  let mut stmt : Array String := #[]
  let mut proofs : Array CutProof := #[]
  -- the latest heading that is not a proof's, since the last proof
  let mut claim : Option (String × Nat) := none
  let mut enclosing : Option Nat := none
  let mut i := 0
  for _ in [0 : n] do
    if i ≥ n then break
    let l := lines[i]!
    if !fenced[i]! && isProofHeading l then
      let lvl := (headingLevel? l).getD 2
      let mut stop := n
      for j in [i + 1 : n] do
        if (level? j).any (· ≤ lvl) then
          stop := j
          break
      proofs := proofs.push { title := claim.map (titleAfterHeading ·.1),
                              text := joinBlocks #[lines.extract (i + 1) stop] }
      claim := none
      i := stop
    else if let some (t, rest) := marker? i then
      let closeAt := enclosing.getD 6
      let mut stop := n
      for j in [i + 1 : n] do
        if (level? j).any (· ≤ closeAt) || (marker? j).isSome then
          stop := j
          break
      let title := match t with
        | some t => some t
        | none => claim.map (titleAfterHeading ·.1)
      -- text on the marker's line opens the paragraph that follows it
      let opening : Array String := if rest.isEmpty then #[] else #[rest]
      proofs := proofs.push
        { title := title, text := joinBlocks #[opening ++ lines.extract (i + 1) stop] }
      claim := none
      i := stop
    else
      if let some lvl := level? i then
        claim := some (l, lvl)
        enclosing := some lvl
      stmt := stmt.push l
      i := i + 1
  if proofs.isEmpty then return none
  return some (joinBlocks #[stmt], proofs)

/-- Split a source file into its front matter lines and its body. -/
def splitSource (text : String) : Option (Array String × String) :=
  let lines := splitLines text
  let isFence (l : String) := trim l == "+++"
  if !(lines[0]?.any isFence) then none else
    match (lines.toList.drop 1).findIdx? isFence with
    | none => none
    | some i => some (((lines.toList.drop 1).take i).toArray,
                      String.intercalate "\n" (lines.toList.drop (i + 2)))

/-- Reassemble a source file. -/
def joinSource (front : Array String) (body : String) : String :=
  let body := trim body
  "+++\n" ++ String.intercalate "\n" front.toList ++ "\n+++\n" ++
    (if body.isEmpty then "" else body ++ "\n")

/-- The key of a front matter line, if it has one. -/
def frontKey? (line : String) : Option String :=
  match line.splitOn "=" with
  | k :: _ :: _ => some (trim k)
  | _ => none

/-- Set an array key of a front matter block to `ids`, keeping the line's own
spelling of the key, or remove it when `ids` is empty.  An array spread over
several lines is replaced as a whole. -/
def setArrayKey (key : String) (front : Array String) (ids : Array String) :
    Array String := Id.run do
  let render (lhs : String) : String :=
    lhs ++ "= [" ++ String.intercalate ", "
      (ids.toList.map fun i => "\"" ++ tomlEscape i ++ "\"") ++ "]"
  match front.findIdx? (frontKey? · == some key) with
  | none =>
    if ids.isEmpty then return front else return front.push (render (key ++ " "))
  | some i =>
    let line := front[i]!
    let lhs := (line.splitOn "=").head!
    let value := trim (String.intercalate "=" ((line.splitOn "=").drop 1))
    -- only an array can run over several lines; a string value is one line
    let mut stop := i
    if value.startsWith "[" then
      while stop < front.size && !(front[stop]!.contains ']') do
        stop := stop + 1
    -- a comment after a one-line value stays with the line
    let comment :=
      if stop != i then "" else
        let after := if value.startsWith "[" then (value.splitOn "]").getLast! else ""
        if (trim after).startsWith "#" then " " ++ trim after else ""
    let rest := front.extract (stop + 1) front.size
    let head := front.extract 0 i
    return if ids.isEmpty then head ++ rest else (head.push (render lhs ++ comment)) ++ rest

/-- Set the `uses` key of a front matter block. -/
def setUses : Array String → Array String → Array String := setArrayKey "uses"

/-- Set a string key of a front matter block, keeping the line's own spelling
of the key, or add it at the end. -/
def setStringKey (key value : String) (front : Array String) : Array String :=
  match front.findIdx? (frontKey? · == some key) with
  | some i => front.set! i ((front[i]!.splitOn "=").head! ++ "= \"" ++ value ++ "\"")
  | none => front.push (key ++ " = \"" ++ value ++ "\"")

/-- A body that opens with `*Proposition (sketch).*`: the kind its word
names, lower case, and the body without the lead-in. -/
def sketchLead? (body : String) : Option (String × String) := Id.run do
  let lines := splitLines (trim body)
  let some first := lines[0]? | return none
  let first := trim first
  if !(first.startsWith "*") then return none
  let word := String.ofList ((first.toList.drop 1).takeWhile Char.isAlpha)
  let lead := "*" ++ word ++ " (sketch).*"
  if word.isEmpty || !(first.startsWith lead) then return none
  let rest := trim (first.drop lead.length).copy
  -- text on the lead-in's line opens the paragraph that follows it
  return some (word.toLower,
    joinBlocks #[(if rest.isEmpty then #[] else #[rest]) ++ lines.extract 1 lines.size])

/-! ## The migration -/

/-- What one run did, or would do. -/
structure MigrateReport where
  /-- Sections that were sketches of a statement, now that statement: file
  and the kind. -/
  sketches : Array (String × String) := #[]
  /-- Proofs moved to a file of their own: statement file and proof file. -/
  split : Array (String × String) := #[]
  /-- Statements that had more than one proof: file and count. -/
  several : Array (String × Nat) := #[]
  /-- Uses moved from a statement to its proof: statement id and target. -/
  moved : Array (String × String) := #[]
  /-- Statements with a proof in their body and an anonymous proof object
  already, which there is no file to number after: file. -/
  clash : Array String := #[]
  /-- Objects of other kinds with a proof in their body, left alone: file. -/
  otherKinds : Array String := #[]
  /-- Sections opening with a statement word the schema has no kind for. -/
  unknownWords : Array (String × String) := #[]
  deriving Inhabited

/-- Plan the migration of the project at `root`: the files to write, with
their new text, and the report. -/
def planMigration (root : System.FilePath) (facts : Option Facts) :
    IO (Array (System.FilePath × String) × MigrateReport) := do
  let l ← load root
  let b := l.blueprint
  let provable : Array String :=
    match b.schema.kind? "proof" with
    | some k => (k.roles.find? (·.name == "of")).map (·.kinds) |>.getD #[]
    | none => #[]
  let canProve (kind : String) : Bool :=
    (b.schema.kind? "proof").isSome && (provable.isEmpty || provable.contains kind)
  let owners := match facts with
    | some f => leanOwners b f
    | none => {}
  let mut writes : Array (System.FilePath × String) := #[]
  let mut rep : MigrateReport := {}
  for o in b.objects do
    -- a proof's own markers (`*Proof of (i).*`) are parts of it
    if o.source.anonymous || o.kind == "proof" then continue
    let path := root / o.source.file
    let text ← IO.FS.readFile path
    let some (front0, body0) := splitSource text | continue
    let mut front := front0
    let mut body := body0
    let mut kind := o.kind
    -- 1. a section that is the sketch of a statement becomes that statement
    if o.kind == "section" then
      if let some (word, rest) := sketchLead? body then
        if (b.schema.kind? word).any (·.roles.isEmpty) then
          kind := word
          body := rest
          front := setStringKey "kind" word front
          front := setArrayKey "tags" front (sortDedup (o.attrStrings "tags" ++ #["sketch"]))
          rep := { rep with sketches := rep.sketches.push (o.source.file, word) }
        else
          rep := { rep with unknownWords := rep.unknownWords.push (o.source.file, word) }
    -- 2. the proofs in the body
    let mut cut : Array CutProof := #[]
    let existing := b.proofsOf o.id
    match splitProofs? body with
    | none => pure ()
    | some (stmt, prfs) =>
      if !canProve kind then
        rep := { rep with otherKinds := rep.otherKinds.push o.source.file }
      else if existing.any (·.source.anonymous) then
        rep := { rep with clash := rep.clash.push o.source.file }
      else
        body := stmt
        cut := prfs
    -- 3. the uses Lean needs only in the proof
    let hasProof := !cut.isEmpty || !existing.isEmpty
    let sugar : Array String :=
      ((b.ofKind "uses").filter fun e =>
        e.source.anonymous && e.source.file == o.source.file && e.src? == some o.id).filterMap (·.tgt?)
    let toMove : Array String := match facts with
      | some f =>
        if hasProof && !(f.namesOf o).isEmpty && f.splitsDeps o then
          let typeD := dependedOn owners f o (·.typeDeps.getD #[])
          let valueD := dependedOn owners f o (·.valueDeps.getD #[])
          sugar.filter fun t => valueD.contains t && !typeD.contains t
        else #[]
      | none => #[]
    if !toMove.isEmpty then
      front := setUses front (sugar.filter (!toMove.contains ·))
    -- the proofs' files: new ones after any split off before, the first of
    -- which takes the moved uses
    let file := (o.source.file.splitOn "/").getLast!
    let dir := String.intercalate "/" ((o.source.file.splitOn "/").dropLast)
    -- a directory's own object (`_section.md`) names its proofs by its id
    let stem := if file == sectionFileStem ++ ".md" then o.id else (file.dropEnd 3).copy
    let relOf (k : Nat) : String :=
      (if dir.isEmpty then "" else dir ++ "/") ++ stem ++
        (if k == 1 then ".proof.md" else s!".proof-{k}.md")
    let before := existing.size
    let total := before + cut.size
    let rels := (Array.range cut.size).map (relOf <| before + · + 1)
    let mut taken := false
    for rel in rels do
      if ← (root / rel).pathExists then taken := true
    if taken then
      rep := { rep with clash := rep.clash.push o.source.file }
      continue
    for t in toMove do rep := { rep with moved := rep.moved.push (o.id, t) }
    for k in [0 : cut.size] do
      let c := cut[k]!
      let pos := before + k + 1
      -- the first proof gets the derived id `proof/<id>`, the others ids of
      -- their own; with several, `order` keeps them in the body's order
      let pfront : Array String :=
        (if pos == 1 then #[] else #[s!"id    = \"proof/{o.id}/{pos}\""]) ++
        #["kind  = \"proof\"", s!"of    = \"{o.id}\""] ++
        (match c.title with
         | some t => #[s!"title = \"{tomlEscape t}\""]
         | none => #[]) ++
        (if total > 1 then #[s!"order = {pos}"] else #[]) ++
        (if pos == 1 then setUses #[] toMove else #[])
      writes := writes.push (root / rels[k]!, joinSource pfront c.text)
      rep := { rep with split := rep.split.push (o.source.file, rels[k]!) }
    if total > 1 && !cut.isEmpty then
      rep := { rep with several := rep.several.push (o.source.file, total) }
    -- an earlier proof without an `order` would sort after the new ones, and
    -- the first of them takes the moved uses when no new proof does
    let earlier := existing.qsort (fun a c => a.id < c.id)
    for k in [0 : earlier.size] do
      let p := earlier[k]!
      let gains := k == 0 && !toMove.isEmpty
      let needsOrder := (p.attr? "order").isNone && !cut.isEmpty
      if p.source.anonymous || (!gains && !needsOrder) then continue
      let ptext ← IO.FS.readFile (root / p.source.file)
      let some (pfront, pbody) := splitSource ptext | continue
      let mut pfront := pfront
      if needsOrder then pfront := pfront.push s!"order = {k + 1}"
      if gains then
        let pUses := ((b.ofKind "uses").filter fun e =>
          e.source.file == p.source.file && e.src? == some p.id).filterMap (·.tgt?)
        pfront := setUses pfront (sortDedup (pUses ++ toMove))
      writes := writes.push (root / p.source.file, joinSource pfront pbody)
    if front != front0 || body != body0 then
      writes := writes.push (path, joinSource front body)
  return (writes, rep)

/-- The report as text. -/
def MigrateReport.render (r : MigrateReport) (dryRun : Bool) : String := Id.run do
  let w (did would : String) := if dryRun then would else did
  let mut out :=
    s!"{w "turned" "would turn"} {r.sketches.size} sketch section(s) into statements; " ++
    s!"{w "split" "would split"} {r.split.size} proof(s) into files of their own; " ++
    s!"{w "moved" "would move"} {r.moved.size} use(s) from a statement to its proof\n"
  for (f, n) in r.several do
    out := out ++ s!"  {f}: {n} proofs, the later ones titled after what they prove\n"
  for (f, word) in r.unknownWords do
    out := out ++ s!"  left alone: {f} opens with '{word}', which is not a kind of the schema\n"
  for f in r.clash do
    out := out ++ s!"  left alone: {f} has a proof in its body and an unwritten proof object\n"
  for f in r.otherKinds do
    out := out ++ s!"  left alone: {f} has a proof in its body, but its kind cannot have a proof\n"
  if dryRun then
    for (f, k) in r.sketches do out := out ++ s!"  {f} becomes a {k}\n"
    for (s, p) in r.split do out := out ++ s!"  split {s} -> {p}\n"
    for (s, t) in r.moved do out := out ++ s!"  move uses {s} -> {t} to its proof\n"
  return out

end Blueprint
