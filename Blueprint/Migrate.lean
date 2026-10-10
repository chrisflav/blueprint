import Blueprint.Diff
import Blueprint.ImportLatex

/-!
# `blueprint migrate proofs`

Moves a blueprint written before proofs were objects (`DESIGN.md` §2.5) onto
them.  Two steps, each safe to run again:

* **Split.**  Every proof in the body of a definition, lemma or theorem
  (`splitProofs?`) moves into a proof file of its own next to it:
  `<stem>.proof.md` for the first, `<stem>.proof-<k>.md` with the id
  `proof/<id>/<k>` for the `k`-th.  A proof of a restatement under a heading
  of its own (a `Detailed form`) is titled after it, and the restatement
  stays with the statement.
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
        let t := trim ((inner.drop 6).dropEnd 1).copy
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
next heading of the same or a higher level, or a paragraph opened by an
inline marker (`*Proof.*`), up to the next such marker or the next heading
that closes the heading it sits under.  A proof that follows a claim under a
heading of its own (a `Detailed form`) is titled after it; markers inside a
proof are part of it.  `none` when there is no proof. -/
def splitProofs? (body : String) : Option (String × Array CutProof) := Id.run do
  let lines := splitLines body
  let n := lines.size
  let mut stmt : Array String := #[]
  let mut proofs : Array CutProof := #[]
  -- the latest heading that is not a proof's, since the last proof
  let mut claim : Option (String × Nat) := none
  let mut enclosing : Option Nat := none
  let mut i := 0
  for _ in [0 : n] do
    if i ≥ n then break
    let l := lines[i]!
    if isProofHeading l then
      let lvl := (headingLevel? l).getD 2
      let mut stop := n
      for j in [i + 1 : n] do
        if (headingLevel? lines[j]!).any (· ≤ lvl) then
          stop := j
          break
      proofs := proofs.push { title := claim.map (titleAfterHeading ·.1),
                              text := joinBlocks #[lines.extract (i + 1) stop] }
      claim := none
      i := stop
    else if let some (t, rest) := inlineProofMarker? l then
      let closeAt := enclosing.getD 6
      let mut stop := n
      for j in [i + 1 : n] do
        if (headingLevel? lines[j]!).any (· ≤ closeAt) || (inlineProofMarker? lines[j]!).isSome then
          stop := j
          break
      let title := match t with
        | some t => some (if t.startsWith "of " then t else "of " ++ t)
        | none => claim.map (titleAfterHeading ·.1)
      proofs := proofs.push { title, text := joinBlocks #[#[rest], lines.extract (i + 1) stop] }
      claim := none
      i := stop
    else
      if let some lvl := headingLevel? l then
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

/-- Set the `uses` key of a front matter block to `ids`, keeping the line's
own spelling of the key, or remove it when `ids` is empty.  An array spread
over several lines is replaced as a whole. -/
def setUses (front : Array String) (ids : Array String) : Array String := Id.run do
  let render (lhs : String) : String :=
    lhs ++ "= [" ++ String.intercalate ", " (ids.toList.map fun i => "\"" ++ i ++ "\"") ++ "]"
  match front.findIdx? (frontKey? · == some "uses") with
  | none =>
    if ids.isEmpty then return front else return front.push (render "uses ")
  | some i =>
    let mut stop := i
    while stop < front.size && !(front[stop]!.contains ']') do
      stop := stop + 1
    let lhs := (front[i]!.splitOn "=").head!
    let rest := front.extract (stop + 1) front.size
    let head := front.extract 0 i
    return if ids.isEmpty then head ++ rest else (head.push (render lhs)) ++ rest

/-! ## The migration -/

/-- What one run did, or would do. -/
structure MigrateReport where
  /-- Proofs moved to a file of their own: statement file and proof file. -/
  split : Array (String × String) := #[]
  /-- Statements that had more than one proof: file and count. -/
  several : Array (String × Nat) := #[]
  /-- Uses moved from a statement to its proof: statement id and target. -/
  moved : Array (String × String) := #[]
  /-- Statements with a proof in their body and an anonymous proof object
  already, which there is no file to number after: file. -/
  clash : Array String := #[]
  /-- Objects of other kinds with a proof heading, left alone: file. -/
  otherKinds : Array String := #[]
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
    let some (front, body) := splitSource text | continue
    -- the split
    let mut stmtBody := body
    let mut cut : Array CutProof := #[]
    let existing := b.proofsOf o.id
    match splitProofs? body with
    | none => pure ()
    | some (stmt, prfs) =>
      if !canProve o.kind then
        rep := { rep with otherKinds := rep.otherKinds.push o.source.file }
      else if existing.any (·.source.anonymous) then
        rep := { rep with clash := rep.clash.push o.source.file }
      else
        stmtBody := stmt
        cut := prfs
    -- the uses Lean needs only in the proof
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
    for t in toMove do rep := { rep with moved := rep.moved.push (o.id, t) }
    let front := if toMove.isEmpty then front else
      setUses front (sugar.filter (!toMove.contains ·))
    -- the proofs' files: new ones, or the existing one gaining the moved uses
    if !cut.isEmpty then
      let stem := ((o.source.file.splitOn "/").getLast!).dropEnd 3 |>.copy
      let dir := String.intercalate "/" ((o.source.file.splitOn "/").dropLast)
      let relOf (k : Nat) : String :=
        (if dir.isEmpty then "" else dir ++ "/") ++ stem ++
          (if k == 1 then ".proof.md" else s!".proof-{k}.md")
      -- proofs already split off by an earlier run come first
      let before := existing.size
      let total := before + cut.size
      let rels := (Array.range cut.size).map (relOf <| before + · + 1)
      let mut taken := false
      for rel in rels do
        if ← (root / rel).pathExists then taken := true
      if taken then
        rep := { rep with clash := rep.clash.push o.source.file }
        continue
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
      -- an earlier proof without an `order` would sort after the new ones,
      -- and the first of them takes the uses moved off the statement
      let earlier := existing.qsort (fun a c => a.id < c.id)
      for k in [0 : earlier.size] do
        let p := earlier[k]!
        let gains := k == 0 && !toMove.isEmpty
        if (p.attr? "order").isSome && !gains then continue
        let ptext ← IO.FS.readFile (root / p.source.file)
        let some (pfront, pbody) := splitSource ptext | continue
        let mut pfront := pfront
        if (p.attr? "order").isNone then pfront := pfront.push s!"order = {k + 1}"
        if gains then
          let pUses := ((b.ofKind "uses").filter fun e =>
            e.source.file == p.source.file && e.src? == some p.id).filterMap (·.tgt?)
          pfront := setUses pfront (sortDedup (pUses ++ toMove))
        writes := writes.push (root / p.source.file, joinSource pfront pbody)
      if total > 1 then
        rep := { rep with several := rep.several.push (o.source.file, total) }
      writes := writes.push (path, joinSource front stmtBody)
    else
      if toMove.isEmpty then continue
      match existing.find? (!·.source.anonymous) with
      | none => continue
      | some p =>
        let ppath := root / p.source.file
        let ptext ← IO.FS.readFile ppath
        let some (pfront, pbody) := splitSource ptext | continue
        let pUses := ((b.ofKind "uses").filter fun e =>
          e.source.file == p.source.file && e.src? == some p.id).filterMap (·.tgt?)
        writes := writes.push (ppath, joinSource (setUses pfront (sortDedup (pUses ++ toMove))) pbody)
        writes := writes.push (path, joinSource front stmtBody)
  return (writes, rep)

/-- The report as text. -/
def MigrateReport.render (r : MigrateReport) (dryRun : Bool) : String := Id.run do
  let verb := if dryRun then "would split" else "split"
  let mut out := s!"{verb} {r.split.size} proof(s) into files of their own; " ++
    s!"{if dryRun then "would move" else "moved"} {r.moved.size} use(s) from a statement to its proof\n"
  for (f, n) in r.several do
    out := out ++ s!"  {f}: {n} proofs, the later ones titled after what they prove\n"
  for f in r.clash do
    out := out ++ s!"  left alone: {f} has a proof heading and a proof object already\n"
  for f in r.otherKinds do
    out := out ++ s!"  left alone: {f} has a proof heading, but its kind cannot have a proof\n"
  if dryRun then
    for (s, p) in r.split do out := out ++ s!"  split {s} -> {p}\n"
    for (s, t) in r.moved do out := out ++ s!"  move uses {s} -> {t} to its proof\n"
  return out

end Blueprint
