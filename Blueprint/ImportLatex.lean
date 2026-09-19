import Blueprint.Parse
import Std.Data.HashMap

/-!
# Importing a `leanblueprint` LaTeX blueprint

`blueprint import-latex <entry.tex> --out <dir>` converts a LaTeX blueprint of
the shape `leanblueprint` produces into the Markdown-plus-TOML sources of
`docs/cli.md`.

The pipeline is four linear passes over the document:

1. **expand** — read the entry file, strip comments, splice `\input{...}`
   recursively (relative to the entry file's directory, as `leanblueprint`
   resolves them), and turn the result into one `Array Char`;
2. **declarations** — collect every `\newcommand`, `\renewcommand`,
   `\providecommand`, `\DeclareMathOperator[*]` (for `[katex.macros]`) and
   every `\newtheorem` (for the set of theorem-like environments);
3. **structure** — split the document into sectioning commands, theorem-like
   environments, `proof` environments and loose prose;
4. **convert and emit** — assign ids, resolve `\uses`, turn each LaTeX body
   into Markdown and write one file per object.

Nothing is expanded: macros are handed to KaTeX, maths is copied verbatim.
Everything the converter does not understand is counted and reported, so that
the loss is visible rather than silent.
-/

namespace Blueprint

open Std

/-! ## Characters

The whole document is held as one `Array Char` so that the scanners below can
index in constant time and stay linear; `String.Pos` arithmetic would work too
but is much easier to get wrong. -/

/-- A LaTeX document, as characters. -/
abbrev Chars := Array Char

/-- The characters of a string. -/
def toChars (s : String) : Chars := s.toList.toArray

/-- The character at `i`, or a space past the end. -/
@[inline] def chAt (cs : Chars) (i : Nat) : Char := cs.getD i ' '

/-- Does `cs` have `pat` at position `i`? -/
def matchAt (cs : Chars) (i : Nat) (pat : Chars) : Bool := Id.run do
  if i + pat.size > cs.size then return false
  for h : k in [0:pat.size] do
    if cs.getD (i + k) ' ' != pat[k] then return false
  return true

/-- The first position ≥ `i` and < `stop` at which `pat` occurs, else `stop`. -/
partial def findPat (cs : Chars) (i stop : Nat) (pat : Chars) : Nat :=
  if i ≥ stop then stop
  else if matchAt cs i pat then i
  else findPat cs (i + 1) stop pat

/-- The first unescaped occurrence of `c` at or after `i`, else `stop`. -/
partial def findChar (cs : Chars) (i stop : Nat) (c : Char) : Nat :=
  if i ≥ stop then stop
  else
    let d := chAt cs i
    if d == '\\' then findChar cs (i + 2) stop c
    else if d == c then i
    else findChar cs (i + 1) stop c

/-- Skip spaces, tabs and newlines. -/
partial def skipWs (cs : Chars) (i stop : Nat) : Nat :=
  if i ≥ stop then i
  else if (chAt cs i).isWhitespace then skipWs cs (i + 1) stop else i

/-- Read the letters at `i`. -/
partial def readLetters (cs : Chars) (i : Nat) (acc : String) : String × Nat :=
  if i < cs.size && (chAt cs i).isAlpha then readLetters cs (i + 1) (acc.push (chAt cs i))
  else (acc, i)

/-- Read a command name, `i` pointing just past the backslash.  A command is
either a run of letters (optionally followed by `*`) or one other character. -/
def readCmdName (cs : Chars) (i : Nat) : String × Nat :=
  if i ≥ cs.size then ("", i)
  else if (chAt cs i).isAlpha then
    let (nm, j) := readLetters cs i ""
    if chAt cs j == '*' then (nm ++ "*", j + 1) else (nm, j)
  else (String.singleton (chAt cs i), i + 1)

/-- `i` points at `{`: the content range and the position after the closing
brace.  Escaped braces do not count. -/
partial def matchBrace (cs : Chars) (i : Nat) : Option (Nat × Nat) :=
  if chAt cs i != '{' then none else go (i + 1) 0
where
  /-- Scan for the matching brace at nesting depth `d`. -/
  go (j d : Nat) : Option (Nat × Nat) :=
    if j ≥ cs.size then none
    else
      let c := chAt cs j
      if c == '\\' then go (j + 2) d
      else if c == '{' then go (j + 1) (d + 1)
      else if c == '}' then (if d == 0 then some (j, j + 1) else go (j + 1) (d - 1))
      else go (j + 1) d

/-- `i` points at `[`: the content range and the position after the closing
bracket.  Brackets inside braces do not close the argument. -/
partial def matchBracket (cs : Chars) (i : Nat) : Option (Nat × Nat) :=
  if chAt cs i != '[' then none else go (i + 1) 0 0
where
  /-- Scan for the closing bracket at brace depth `b` and bracket depth `d`. -/
  go (j b d : Nat) : Option (Nat × Nat) :=
    if j ≥ cs.size then none
    else
      let c := chAt cs j
      if c == '\\' then go (j + 2) b d
      else if c == '{' then go (j + 1) (b + 1) d
      else if c == '}' then go (j + 1) (if b == 0 then 0 else b - 1) d
      else if c == '[' && b == 0 then go (j + 1) b (d + 1)
      else if c == ']' && b == 0 then (if d == 0 then some (j, j + 1) else go (j + 1) b (d - 1))
      else go (j + 1) b d

/-- The text of a character range. -/
def slice (cs : Chars) (a b : Nat) : String := Id.run do
  let mut s := ""
  for k in [a:min b cs.size] do
    s := s.push (chAt cs k)
  return s

/-- Read a braced argument at `i`, skipping intervening whitespace; returns the
argument's range and the position after it. -/
def braceArg (cs : Chars) (i : Nat) : Option (Nat × Nat × Nat) :=
  let j := skipWs cs i cs.size
  match matchBrace cs j with
  | some (e, n) => some (j + 1, e, n)
  | none => none

/-- Read a braced argument that must start immediately at `i`. -/
def braceArgHere (cs : Chars) (i : Nat) : Option (Nat × Nat × Nat) :=
  match matchBrace cs i with
  | some (e, n) => some (i + 1, e, n)
  | none => none

/-- Skip an optional `[...]` argument at `i`, returning its range if there was
one and the position after it. -/
def optArg (cs : Chars) (i : Nat) : Option (Nat × Nat) × Nat :=
  if chAt cs i == '[' then
    match matchBracket cs i with
    | some (e, n) => (some (i + 1, e), n)
    | none => (none, i)
  else (none, i)

/-! ## Comments and `\input` -/

/-- Drop `%` comments, keeping `\%`.  The newline is kept, so that line
structure — which is what tells paragraphs apart — survives. -/
def stripComments (text : String) : String := Id.run do
  let cs := toChars text
  let mut out := ""
  let mut i := 0
  let mut skipping := false
  while i < cs.size do
    let c := cs[i]!
    if c == '\n' then
      out := out.push '\n'; skipping := false; i := i + 1
    else if skipping then
      i := i + 1
    else if c == '\\' then
      out := out.push c
      if i + 1 < cs.size then out := out.push cs[i + 1]!
      i := i + 2
    else if c == '%' then
      skipping := true; i := i + 1
    else
      out := out.push c; i := i + 1
  return out

/-- Resolve an `\input` path the way `leanblueprint` does: relative to the
directory of the entry file, with `.tex` supplied when it is missing. -/
def resolveInput (srcRoot here : System.FilePath) (arg : String) : IO (Option System.FilePath) := do
  let arg := trim arg
  let cands : Array System.FilePath :=
    #[srcRoot / arg, srcRoot / (arg ++ ".tex"), here / arg, here / (arg ++ ".tex")]
  for c in cands do
    if ← c.pathExists then
      unless ← c.isDir do return some c
  return none

/-- Read `path`, strip its comments and splice in every `\input`, depth first.
`seen` guards against an input cycle. -/
partial def expandInputs (srcRoot : System.FilePath) (path : System.FilePath)
    (seen : Array String) (missing : IO.Ref (Array String)) : IO String := do
  let key := path.toString
  if seen.contains key then return ""
  let seen := seen.push key
  let text ← IO.FS.readFile path
  let cs := toChars (stripComments text)
  let here := path.parent.getD "."
  let inputPat := toChars "\\input"
  let mut chunks : Array String := #[]
  let mut i := 0
  let mut last := 0
  while i < cs.size do
    if cs[i]! == '\\' && matchAt cs i inputPat then
      let (_, j) := readCmdName cs (i + 1)
      if j == i + 6 then
        match braceArg cs j with
        | some (a, b, n) =>
          chunks := chunks.push (slice cs last i)
          let arg := slice cs a b
          match ← resolveInput srcRoot here arg with
          | some p => chunks := chunks.push (← expandInputs srcRoot p seen missing)
          | none => missing.modify (·.push arg)
          i := n; last := n
        | none => i := j
      else i := j
    else i := i + 1
  chunks := chunks.push (slice cs last cs.size)
  return String.intercalate "\n" chunks.toList

/-! ## Slugs -/

/-- Is `c` allowed in an id as it stands? -/
def slugOk (c : Char) : Bool :=
  (c ≥ 'a' && c ≤ 'z') || (c ≥ '0' && c ≤ '9') || c == '-' || c == '_' || c == '.'

/-- Lowercase, every other character to `-`, repeats collapsed, ends trimmed. -/
def slugify (s : String) : String := Id.run do
  let mut out := ""
  let mut dash := true
  for c in s.toList do
    let c := c.toLower
    if slugOk c && c != '-' then
      out := out.push c; dash := false
    else if !dash then
      out := out.push '-'; dash := true
  while out.endsWith "-" do out := (out.dropEnd 1).copy
  return (if out.isEmpty then "x" else out)

/-- Strip LaTeX markup crudely, for turning a title into a slug. -/
def plainish (s : String) : String := Id.run do
  let cs := toChars s
  let mut out := ""
  let mut i := 0
  while i < cs.size do
    let c := cs[i]!
    if c == '\\' then
      let (_, j) := readCmdName cs (i + 1)
      out := out.push ' '; i := j
    else if c == '{' || c == '}' || c == '$' then i := i + 1
    else
      out := out.push c; i := i + 1
  return out

/-! ## Declarations collected from the source -/

/-- What the declaration pass finds. -/
structure Decls where
  /-- KaTeX macros, in source order; a later definition wins. -/
  macros : Array (String × String) := #[]
  /-- Environment names introduced by `\newtheorem`. -/
  theorems : Array String := #[]
  deriving Inhabited

/-- Commands that introduce a KaTeX macro. -/
def macroCmds : Array String :=
  #["newcommand", "renewcommand", "providecommand", "DeclareMathOperator",
    "DeclareMathOperator*", "newcommand*", "renewcommand*", "providecommand*",
    "def", "newtheorem", "newtheorem*", "newcounter", "setcounter", "theoremstyle",
    "usepackage", "documentclass", "RequirePackage", "DeclareRobustCommand"]

/-- Read one macro-defining command starting just after its name at `i`.
Returns what was declared and the position after the whole declaration. -/
def readDecl (cs : Chars) (name : String) (i : Nat) : (Option (Sum (String × String) String)) × Nat :=
  if name == "newtheorem" || name == "newtheorem*" then
    match braceArg cs i with
    | none => (none, i)
    | some (a, b, n) =>
      let (_, n) := optArg cs n
      let n := match braceArg cs n with | some (_, _, n') => n' | none => n
      let (_, n) := optArg cs n
      (some (.inr (trim (slice cs a b))), n)
  else if name.startsWith "DeclareMathOperator" then
    -- `\DeclareMathOperator{\Sh}{Sh}` and `\DeclareMathOperator\Sh{Sh}`
    let starred := name.endsWith "*"
    let j := skipWs cs i cs.size
    let (nm, j) :=
      if chAt cs j == '{' then
        match braceArgHere cs j with
        | some (a, b, n) => (trim (slice cs a b), n)
        | none => ("", j)
      else if chAt cs j == '\\' then
        let (n, j') := readCmdName cs (j + 1)
        ("\\" ++ n, j')
      else ("", j)
    match braceArg cs j with
    | none => (none, j)
    | some (a, b, n) =>
      let body := trim (slice cs a b)
      if nm.isEmpty then (none, n)
      else (some (.inl (nm, (if starred then "\\operatorname*{" else "\\operatorname{") ++ body ++ "}")), n)
  else if name.startsWith "newcommand" || name.startsWith "renewcommand"
       || name.startsWith "providecommand" || name == "DeclareRobustCommand" || name == "def" then
    let j := skipWs cs i cs.size
    let (nm, j) :=
      if chAt cs j == '{' then
        match braceArgHere cs j with
        | some (a, b, n) => (trim (slice cs a b), n)
        | none => ("", j)
      else if chAt cs j == '\\' then
        let (n, j') := readCmdName cs (j + 1)
        ("\\" ++ n, j')
      else ("", j)
    let (_, j) := optArg cs j        -- argument count
    let (_, j) := optArg cs j        -- default for the first argument
    match braceArg cs j with
    | none => (none, j)
    | some (a, b, n) =>
      if nm.isEmpty || !nm.startsWith "\\" then (none, n)
      else (some (.inl (nm, trim (slice cs a b))), n)
  else
    -- `\newcounter`, `\setcounter`, `\theoremstyle`, `\usepackage`, …: skip the
    -- arguments so that they do not leak into the prose.
    let (_, j) := optArg cs i
    let j := match braceArg cs j with | some (_, _, n) => n | none => j
    let j := if name == "setcounter" then
        (match braceArg cs j with | some (_, _, n) => n | none => j)
      else j
    (none, j)

/-- Collect every macro and `\newtheorem` in a document. -/
def collectDecls (cs : Chars) (init : Decls) : Decls := Id.run do
  let mut d := init
  let mut i := 0
  while i < cs.size do
    if cs[i]! == '\\' then
      let (nm, j) := readCmdName cs (i + 1)
      if macroCmds.contains nm then
        let (res, n) := readDecl cs nm j
        match res with
        | some (.inl m) => d := { d with macros := d.macros.push m }
        | some (.inr t) => d := { d with theorems := d.theorems.push t }
        | none => pure ()
        i := max n (i + 1)
      else
        i := max j (i + 1)
    else i := i + 1
  return d

/-! ## Environments and kinds -/

/-- Theorem-like environments understood without a `\newtheorem`. -/
def builtinTheoremEnvs : Array String :=
  #["theorem", "proposition", "lemma", "corollary", "definition", "construction",
    "openproblem", "conditionaltheorem", "remark", "example", "warning",
    "convention", "notation", "claim", "conjecture", "fact", "question",
    "observation", "assumption", "axiom", "problem"]

/-- Which blueprint kind a LaTeX environment becomes. -/
def kindOfEnv (e : String) : String :=
  if e == "theorem" || e == "proposition" || e == "corollary"
     || e == "conditionaltheorem" || e == "conjecture" || e == "claim"
     || e == "fact" || e == "problem" then "theorem"
  else if e == "lemma" then "lemma"
  else if e == "definition" || e == "construction" || e == "notation"
          || e == "convention" then "definition"
  else if e == "remark" || e == "example" || e == "warning" || e == "openproblem"
          || e == "question" || e == "observation" || e == "assumption"
          || e == "axiom" then "remark"
  else if containsSub e "theorem" || containsSub e "thm" then "theorem"
  else if containsSub e "lemma" then "lemma"
  else if containsSub e "defin" || containsSub e "construct" then "definition"
  else "remark"
where
  /-- Is `pat` a substring of `s`? -/
  containsSub (s pat : String) : Bool := (s.splitOn pat).length > 1

/-! ## The structure pass -/

/-- One piece of the document, in source order. -/
inductive Item where
  /-- A sectioning command: level (1 = chapter), raw title, optional label. -/
  | sec (level : Nat) (title : String) (label : Option String)
  /-- A theorem-like environment: name, optional `[title]`, raw body. -/
  | env (name : String) (title : Option String) (raw : String)
  /-- A `proof` environment. -/
  | proof (raw : String)
  /-- Loose prose. -/
  | prose (raw : String)
  deriving Inhabited

/-- Sectioning commands and their levels. -/
def sectionLevel (nm : String) : Option Nat :=
  if nm == "chapter" || nm == "chapter*" then some 1
  else if nm == "section" || nm == "section*" then some 2
  else if nm == "subsection" || nm == "subsection*" then some 3
  else if nm == "subsubsection" || nm == "subsubsection*" then some 4
  else none

/-- The end of the environment `name` opened at `i`, honouring nesting.
Returns the position of `\end{name}` and the position after it. -/
partial def envEnd (cs : Chars) (i : Nat) (name : String) : Nat × Nat :=
  go (toChars ("\\begin{" ++ name ++ "}")) (toChars ("\\end{" ++ name ++ "}")) i 0
where
  /-- Scan forward at nesting depth `d`. -/
  go (b e : Chars) (j d : Nat) : Nat × Nat :=
    if j ≥ cs.size then (cs.size, cs.size)
    else if matchAt cs j e then
      if d == 0 then (j, j + e.size) else go b e (j + e.size) (d - 1)
    else if matchAt cs j b then go b e (j + b.size) (d + 1)
    else go b e (j + 1) d

/-- Split the document into sections, theorem-like environments, proofs and
prose. -/
def scanDoc (thmEnvs : Array String) (cs : Chars) : Array Item := Id.run do
  let mut items : Array Item := #[]
  let mut buf := ""
  let mut i := 0
  let labelPat := toChars "\\label"
  while i < cs.size do
    let c := cs[i]!
    if c != '\\' then
      buf := buf.push c; i := i + 1
    else
      let (nm, j) := readCmdName cs (i + 1)
      if let some lvl := sectionLevel nm then
        if !(trim buf).isEmpty then items := items.push (.prose buf)
        buf := ""
        let (_, j) := optArg cs j
        match braceArg cs j with
        | none => i := j
        | some (a, b, n) =>
          let title := slice cs a b
          -- a `\label` directly after the heading belongs to the section
          let k := skipWs cs n cs.size
          let mut label : Option String := none
          let mut n := n
          if matchAt cs k labelPat then
            let (lnm, lj) := readCmdName cs (k + 1)
            if lnm == "label" then
              match braceArg cs lj with
              | some (la, lb, ln) => label := some (trim (slice cs la lb)); n := ln
              | none => pure ()
          items := items.push (.sec lvl title label)
          i := n
      else if nm == "begin" then
        match braceArg cs j with
        | none => buf := buf ++ "\\begin"; i := j
        | some (a, b, n) =>
          let env := trim (slice cs a b)
          if thmEnvs.contains env then
            if !(trim buf).isEmpty then items := items.push (.prose buf)
            buf := ""
            let (opt, n) := optArg cs n
            let title := opt.map fun (oa, ob) => slice cs oa ob
            let (ce, after) := envEnd cs n env
            items := items.push (.env env title (slice cs n ce))
            i := after
          else if env == "proof" then
            if !(trim buf).isEmpty then items := items.push (.prose buf)
            buf := ""
            let (_, n) := optArg cs n
            let (ce, after) := envEnd cs n env
            items := items.push (.proof (slice cs n ce))
            i := after
          else
            buf := buf ++ "\\begin{" ++ env ++ "}"; i := n
      else if macroCmds.contains nm then
        let (_, n) := readDecl cs nm j
        i := max n (i + 1)
      else
        buf := buf ++ "\\" ++ nm
        i := max j (i + 1)
  if !(trim buf).isEmpty then items := items.push (.prose buf)
  return items


/-! ## LaTeX to Markdown

The converter is deliberately shallow: maths is copied out verbatim, a fixed
table of prose commands and environments is translated, and everything else
keeps its argument text and is counted.  Nothing is ever dropped without the
report saying so.
-/

/-- What the converter needs to know about the rest of the document. -/
structure Ctx where
  /-- Raw LaTeX label to object id. -/
  labels : HashMap String String := {}
  deriving Inhabited

/-- Converter state: the text so far, the whitespace owed before the next
character, the stack of open list environments, and the report counters. -/
structure Conv where
  /-- Markdown emitted so far. -/
  out : String := ""
  /-- Owed separator: 0 none, 1 space, 2 newline, 3 blank line. -/
  pend : Nat := 0
  /-- Open `itemize` / `enumerate` / `description` environments. -/
  lists : Array String := #[]
  /-- Inside a Markdown code span, where a backslash is literal and the
  Markdown escapes must not be written. -/
  code : Bool := false
  /-- Inside a `tabular`, where `&` and `\\` separate cells and rows. -/
  table : Bool := false
  /-- Commands dropped, by name. -/
  cmds : HashMap String Nat := {}
  /-- Environments not understood, by name. -/
  envs : HashMap String Nat := {}

instance : Inhabited Conv := ⟨{}⟩

namespace Conv

/-- Write out the owed separator. -/
def flush (st : Conv) : Conv :=
  if st.pend == 0 then st
  else if st.out.isEmpty then { st with pend := 0 }
  else
    let s := if st.pend == 1 then " " else if st.pend == 2 then "\n" else "\n\n"
    { st with out := st.out ++ s, pend := 0 }

/-- Append text after the owed separator. -/
def emit (st : Conv) (s : String) : Conv :=
  if s.isEmpty then st else
    let st := st.flush
    { st with out := st.out ++ s }

/-- Append one character. -/
def emitC (st : Conv) (c : Char) : Conv :=
  let st := st.flush
  { st with out := st.out.push c }

/-- Owe at least this much separation.  Inside a list a blank line would end
the item, so paragraph breaks become plain newlines there. -/
def want (st : Conv) (n : Nat) : Conv :=
  let n := if st.lists.isEmpty then n else min n 2
  { st with pend := max st.pend n }

/-- Append without any separator logic. -/
def hard (st : Conv) (s : String) : Conv := { st with out := st.out ++ s, pend := 0 }

/-- Count a command whose name was dropped. -/
def dropCmd (st : Conv) (n : String) : Conv :=
  { st with cmds := st.cmds.alter n (fun v => some (v.getD 0 + 1)) }

/-- Count an environment that was not understood. -/
def dropEnv (st : Conv) (n : String) : Conv :=
  { st with envs := st.envs.alter n (fun v => some (v.getD 0 + 1)) }

end Conv

/-- Commands that carry no prose and are dropped without a report entry: the
blueprint's own annotations and pure typesetting. -/
def silentCmds : Array String :=
  #["label", "uses", "lean", "leanok", "notready", "mathlibok", "proves", "alsoIn",
    "discussion", "noindent", "indent", "smallskip", "medskip", "bigskip",
    "centering", "raggedright", "raggedleft", "sloppy", "fussy", "clearpage",
    "newpage", "pagebreak", "nopagebreak", "hfill", "vfill", "maketitle",
    "tableofcontents", "listoffigures", "listoftables", "toprule", "midrule",
    "bottomrule", "hline", "small", "footnotesize", "scriptsize", "normalsize",
    "large", "Large", "LARGE", "huge", "Huge", "rm", "sf", "sl", "em",
    "appendix", "frontmatter", "mainmatter", "backmatter", "protect",
    "allowbreak", "relax", "ignorespaces", "leavevmode", "unskip", "endinput",
    "nagataUsesAnnotations", "restorecolor", "checked", "aftergroup"]

/-- Commands whose braced argument is a length, a counter name or a file name
rather than prose: dropped along with the argument, but still counted. -/
def discardArgCmds : Array String :=
  #["Needspace", "vspace", "vspace*", "hspace", "hspace*", "vskip", "hskip",
    "setlength", "addtolength", "settowidth", "refstepcounter", "addtocounter",
    "stepcounter", "rule", "includegraphics", "hypertarget", "index",
    "phantomsection", "addcontentsline", "markboth", "markright"]

/-- Commands whose braced argument is kept as plain text. -/
def plainCmds : Array String :=
  #["textsc", "textsf", "textnormal", "textrm", "textup", "textmd", "text",
    "mbox", "hbox", "makebox", "normalfont", "uppercase", "lowercase"]

/-- Accents: the accent command, the base letter, and the result. -/
def accentTable : Array (String × Char × String) :=
  #[("'", 'a', "á"), ("'", 'e', "é"), ("'", 'i', "í"), ("'", 'o', "ó"),
    ("'", 'u', "ú"), ("'", 'y', "ý"), ("'", 'c', "ć"), ("'", 'n', "ń"),
    ("'", 's', "ś"), ("'", 'z', "ź"),
    ("'", 'A', "Á"), ("'", 'E', "É"), ("'", 'I', "Í"), ("'", 'O', "Ó"),
    ("'", 'U', "Ú"),
    ("`", 'a', "à"), ("`", 'e', "è"), ("`", 'i', "ì"), ("`", 'o', "ò"),
    ("`", 'u', "ù"), ("`", 'A', "À"), ("`", 'E', "È"),
    ("\"", 'a', "ä"), ("\"", 'e', "ë"), ("\"", 'i', "ï"), ("\"", 'o', "ö"),
    ("\"", 'u', "ü"), ("\"", 'y', "ÿ"), ("\"", 'A', "Ä"), ("\"", 'O', "Ö"),
    ("\"", 'U', "Ü"),
    ("^", 'a', "â"), ("^", 'e', "ê"), ("^", 'i', "î"), ("^", 'o', "ô"),
    ("^", 'u', "û"),
    ("~", 'a', "ã"), ("~", 'n', "ñ"), ("~", 'o', "õ"),
    ("=", 'a', "ā"), ("=", 'e', "ē"), ("=", 'o', "ō"), ("=", 'u', "ū"),
    (".", 'z', "ż"), (".", 'e', "ė"),
    ("v", 's', "š"), ("v", 'c', "č"), ("v", 'z', "ž"), ("v", 'r', "ř"),
    ("v", 'e', "ě"), ("v", 'S', "Š"), ("v", 'C', "Č"), ("v", 'Z', "Ž"),
    ("c", 'c', "ç"), ("c", 's', "ş"),
    ("H", 'o', "ő"), ("H", 'u', "ű")]

/-- Is this an accent command? -/
def isAccentCmd (n : String) : Bool :=
  #["'", "`", "\"", "^", "~", "=", ".", "v", "c", "H"].contains n

/-- Display maths environments whose contents go straight into `$$ … $$`. -/
def displayMathEnvs : Array String :=
  #["equation", "equation*", "displaymath", "gather", "gather*", "multline",
    "multline*", "dmath", "dmath*"]

/-- Alignment environments; KaTeX renders `aligned` inside display maths. -/
def alignMathEnvs : Array String :=
  #["align", "align*", "alignat", "alignat*", "flalign", "flalign*",
    "eqnarray", "eqnarray*", "gather*"]

/-- Environments taking a column specification that must not leak into the text. -/
def tabularEnvs : Array String :=
  #["tabular", "tabular*", "tabularx", "longtable", "supertabular", "array"]

/-- Cell separator inside a converted `tabular`. -/
def cellSep : String := ""

/-- Row separator inside a converted `tabular`. -/
def rowSep : String := ""

/-- Turn the marked-up contents of a `tabular` into a GitHub Markdown table.
The first row is taken to be the header, which is what a `tabular` with a
rule under its first row means. -/
def gfmTable (s : String) : String := Id.run do
  let rows := (s.splitOn rowSep).map fun r =>
    (r.splitOn cellSep).map fun c => trim (replaceAll (replaceAll c "\n" " ") "|" "\\|")
  let rows := rows.filter fun cells => cells.any (fun (c : String) => !c.isEmpty)
  if rows.isEmpty then return ""
  let width := rows.foldl (fun w cells => max w cells.length) 0
  let render (cells : List String) : String :=
    let cells := cells ++ List.replicate (width - cells.length) ""
    "| " ++ String.intercalate " | " cells ++ " |"
  let sep := "| " ++ String.intercalate " | " (List.replicate width "---") ++ " |"
  match rows with
  | [] => return ""
  | h :: tl => return String.intercalate "\n" (render h :: sep :: tl.map render)

/-- Tidy a stretch of maths: drop `\label`, which KaTeX cannot parse, and take
out blank lines, which the Markdown renderer would turn into paragraphs in the
middle of a formula. -/
def cleanMath (s : String) (block : Bool) : String := Id.run do
  let cs := toChars s
  let mut out := ""
  let mut i := 0
  while i < cs.size do
    let c := cs[i]!
    if c == '\\' then
      let (nm, j) := readCmdName cs (i + 1)
      if nm == "label" then
        i := match braceArg cs j with | some (_, _, n) => n | none => j
      else
        out := out ++ "\\" ++ nm; i := max j (i + 1)
    else
      out := out.push c; i := i + 1
  let ls := (splitLines out).toList.map trim |>.filter (fun l => !l.isEmpty)
  return String.intercalate (if block then "\n" else " ") ls

/-- Every argument of `\name{…}` in a document, in order. -/
def collectArgs (cs : Chars) (name : String) : Array String := Id.run do
  let mut res : Array String := #[]
  let mut i := 0
  while i < cs.size do
    if cs[i]! == '\\' then
      let (nm, j) := readCmdName cs (i + 1)
      if nm == name then
        match braceArg cs j with
        | some (a, b, n) => res := res.push (slice cs a b); i := n
        | none => i := max j (i + 1)
      else i := max j (i + 1)
    else i := i + 1
  return res

/-- Split a comma separated argument, trimming and dropping empties. -/
def splitCommas (s : String) : Array String :=
  ((s.splitOn ",").toArray.map fun x => trim (replaceAll x "\n" " ")).filter
    fun (x : String) => !x.isEmpty

/-- A Lean name, with every internal space and newline removed: `\lean{…}` is
routinely wrapped over several lines. -/
def cleanLeanName (s : String) : String :=
  let s := replaceAll (replaceAll (replaceAll s "\n" "") "\r" "") "\t" ""
  let s := trim (replaceAll s " " "")
  if s.endsWith "," then (s.dropEnd 1).copy else s

/-- The indentation a list item at the current depth needs, so that nesting
comes out as CommonMark nesting. -/
def listIndent (stack : Array String) : String := Id.run do
  let mut s := ""
  for k in [0:stack.size - 1] do
    s := s ++ (if stack.getD k "" == "enumerate" then "   " else "  ")
  return s

mutual

/-- Convert the characters `[i, stop)` of `cs`, appending to `st`. -/
partial def convSpan (ctx : Ctx) (cs : Chars) (stop : Nat) (i : Nat) (st : Conv) : Conv :=
  if i ≥ stop then st else
  let c := chAt cs i
  if c == '\n' then
    -- count the newlines in this run of whitespace
    let rec run (j n : Nat) : Nat × Nat :=
      if j ≥ stop then (j, n)
      else
        let d := chAt cs j
        if d == '\n' then run (j + 1) (n + 1)
        else if d == ' ' || d == '\t' || d == '\r' then run (j + 1) n
        else (j, n)
    let (j, n) := run i 0
    convSpan ctx cs stop j (st.want (if n ≥ 2 then 3 else 2))
  else if c == ' ' || c == '\t' || c == '\r' then
    convSpan ctx cs stop (i + 1) (st.want 1)
  else if c == '~' then
    convSpan ctx cs stop (i + 1) (st.want 1)
  else if c == '$' then
    if chAt cs (i + 1) == '$' then
      let e := findPat cs (i + 2) stop (toChars "$$")
      let body := cleanMath (slice cs (i + 2) e) true
      let st := ((st.want 3).flush).emit ("$$\n" ++ body ++ "\n$$")
      convSpan ctx cs stop (min stop (e + 2)) (st.want 3)
    else
      let e := findChar cs (i + 1) stop '$'
      let body := cleanMath (slice cs (i + 1) e) false
      let st := st.emit ("$" ++ body ++ "$")
      convSpan ctx cs stop (min stop (e + 1)) st
  else if c == '{' || c == '}' then
    -- a bare brace is a TeX group, not text; `\{` and `\}` are the characters
    convSpan ctx cs stop (i + 1) st
  else if c == '&' && st.table then
    convSpan ctx cs stop (i + 1) ({ st with pend := 0 }.hard cellSep)
  else if c == '-' && !st.code && chAt cs (i + 1) == '-' && i + 1 < stop then
    -- the TeX dash ligatures; `-` inside maths and code spans is left alone
    if chAt cs (i + 2) == '-' && i + 2 < stop then
      convSpan ctx cs stop (i + 3) (st.emit "—")
    else convSpan ctx cs stop (i + 2) (st.emit "–")
  else if c != '\\' then
    convSpan ctx cs stop (i + 1) (st.emitC c)
  else
    let (nm, j) := readCmdName cs (i + 1)
    convCmd ctx cs stop nm j st

/-- Handle the command `nm` whose arguments start at `j`. -/
partial def convCmd (ctx : Ctx) (cs : Chars) (stop : Nat) (nm : String) (j : Nat)
    (st : Conv) : Conv :=
  let arg1 : Option (Nat × Nat × Nat) := braceArgHere cs j
  let cont (st : Conv) (n : Nat) := convSpan ctx cs stop (min stop (max n j)) st
  -- maths delimiters
  if nm == "(" then
    let e := findPat cs j stop (toChars "\\)")
    cont (st.emit ("$" ++ cleanMath (slice cs j e) false ++ "$")) (e + 2)
  else if nm == "[" then
    let e := findPat cs j stop (toChars "\\]")
    let st := ((st.want 3).flush).emit ("$$\n" ++ cleanMath (slice cs j e) true ++ "\n$$")
    cont (st.want 3) (e + 2)
  else if nm == ")" || nm == "]" then cont st j
  -- environments
  else if nm == "begin" then
    match braceArg cs j with
    | none => cont (st.dropCmd "begin") j
    | some (a, b, n) => convEnv ctx cs stop (trim (slice cs a b)) n st
  else if nm == "end" then
    match braceArg cs j with
    | none => cont st j
    | some (_, _, n) => cont st n
  -- line and paragraph structure
  else if nm == "\\" then
    let (_, n) := optArg cs j
    if st.table then cont (({ st with pend := 0 }).hard rowSep) n
    else
      let st := ({ st with pend := 0 }).emit "  "
      cont (st.want 2) n
  else if nm == "par" then cont (st.want 3) j
  else if nm == "newline" || nm == "linebreak" || nm == "hfill" then cont (st.want 2) j
  else if nm == "item" then
    let (opt, n) := optArg cs j
    let marker := if st.lists.back? == some "enumerate" then "1." else "-"
    let st := st.flush
    let st := { st with
      out := (if st.out.isEmpty || st.out.endsWith "\n" then st.out else st.out ++ "\n"),
      pend := 0 }
    -- the marker owes a space, so that the item's own leading whitespace does
    -- not double it
    let st := { st.hard (listIndent st.lists ++ marker) with pend := 1 }
    match opt with
    | none => cont st n
    | some (oa, ob) =>
      let (t, st) := convStr ctx cs oa ob st
      cont (if t.isEmpty then st else (st.emit ("**" ++ t ++ "**")).want 1) n
  -- text emphasis
  else if nm == "emph" || nm == "textit" || nm == "textsl" || nm == "it" then
    wrap "*" "*"
  else if nm == "textbf" || nm == "bf" || nm == "strong" then wrap "**" "**"
  else if nm == "texttt" || nm == "tt" || nm == "nolinkurl" || nm == "path"
          || nm == "lstinline" then wrap "`" "`" (code := true)
  else if plainCmds.contains nm then wrap "" ""
  else if nm == "underline" then wrap "" ""
  else if nm == "textcolor" then
    -- `\textcolor{colour}{text}`: drop the colour
    match arg1 with
    | none => cont (st.dropCmd nm) j
    | some (_, _, n) =>
      match braceArgHere cs n with
      | none => cont st n
      | some (a2, b2, n2) => let (t, st) := convStr ctx cs a2 b2 st; cont (st.emit t) n2
  else if nm == "verb" then
    -- `\verb|…|`: the character after the command is the delimiter
    let d := chAt cs j
    let e := findChar cs (j + 1) stop d
    cont (st.emit ("`" ++ slice cs (j + 1) e ++ "`")) (e + 1)
  -- cross references
  else if nm == "ref" || nm == "cref" || nm == "Cref" || nm == "autoref"
          || nm == "eqref" || nm == "pageref" || nm == "nameref" || nm == "labelcref" then
    match arg1 with
    | none => cont (st.dropCmd nm) j
    | some (a, b, n) =>
      let targets := splitCommas (slice cs a b)
      let rendered := targets.toList.map fun t =>
        match ctx.labels.get? t with
        | some id => "[" ++ id ++ "]"
        | none => t
      cont (st.emit (String.intercalate ", " rendered)) n
  else if nm == "cite" || nm == "citep" || nm == "citet" then
    let (_, j') := optArg cs j
    match braceArgHere cs j' with
    | none => cont (st.dropCmd nm) j'
    | some (a, b, n) =>
      let keys := splitCommas (slice cs a b)
      cont (st.emit ("[" ++ String.intercalate ", " keys.toList ++ "]")) n
  else if nm == "url" then
    match arg1 with
    | none => cont (st.dropCmd nm) j
    | some (a, b, n) => let u := trim (slice cs a b); cont (st.emit ("[" ++ u ++ "](" ++ u ++ ")")) n
  else if nm == "href" then
    match arg1 with
    | none => cont (st.dropCmd nm) j
    | some (a, b, n) =>
      let u := trim (slice cs a b)
      match braceArgHere cs n with
      | none => cont (st.emit ("[" ++ u ++ "](" ++ u ++ ")")) n
      | some (a2, b2, n2) =>
        let (t, st) := convStr ctx cs a2 b2 st
        cont (st.emit ("[" ++ (if t.isEmpty then u else t) ++ "](" ++ u ++ ")")) n2
  else if nm == "footnote" || nm == "footnotetext" then
    match arg1 with
    | none => cont (st.dropCmd nm) j
    | some (a, b, n) =>
      let (t, st) := convStr ctx cs a b st
      cont (st.emit (" (" ++ t ++ ")")) n
  -- the project's own prose macros
  else if nm == "statusnote" then note "**Status.** "
  else if nm == "formalizationnote" then note "**Formalization note.** "
  else if nm == "constructedby" then note "*Constructed by:* "
  else if nm == "openobligation" then note "**Open obligation:** "
  else if nm == "retiredobligation" then note "**Retired invalid route:** "
  -- escapes and spacing
  else if nm == "%" then cont (st.emit "%") j
  else if nm == "&" then cont (st.emit "&") j
  else if nm == "{" then cont (st.emit "{") j
  else if nm == "}" then cont (st.emit "}") j
  else if nm == "_" then cont (st.emit (if st.code then "_" else "\\_")) j
  else if nm == "#" then cont (st.emit (if st.code then "#" else "\\#")) j
  else if nm == "$" then cont (st.emit (if st.code then "$" else "\\$")) j
  else if nm == "," || nm == ";" || nm == ":" || nm == "!" || nm == "/" then cont st j
  else if nm == " " || nm == "\n" || nm == "\t" || nm == "\r" then
    -- `\ ` is a control space, and so is a backslash at the end of a line
    cont (st.want 1) j
  else if nm == "quad" || nm == "qquad" || nm == "enspace" || nm == "thinspace"
          || nm == "space" then cont (st.want 1) j
  else if nm == "ldots" || nm == "dots" || nm == "cdots" || nm == "textellipsis" then
    cont (st.emit "...") j
  else if nm == "ss" then cont (st.emit "ß") j
  else if nm == "ae" then cont (st.emit "æ") j
  else if nm == "oe" then cont (st.emit "œ") j
  else if nm == "S" then cont (st.emit "§") j
  else if nm == "P" then cont (st.emit "¶") j
  else if nm == "textbackslash" then cont (st.emit "\\\\") j
  else if nm == "ensuremath" then
    -- the argument is maths whatever the surrounding mode
    match arg1 with
    | none => cont (st.dropCmd nm) j
    | some (a, b, n) => cont (st.emit ("$" ++ cleanMath (slice cs a b) false ++ "$")) n
  else if nm == "paragraph" || nm == "paragraph*" || nm == "subparagraph"
          || nm == "subparagraph*" then
    -- a run-in heading: not deep enough to be a section of its own
    match braceArg cs j with
    | none => cont (st.dropCmd nm) j
    | some (a, b, n) =>
      let (t, st) := convStr ctx cs a b st
      cont (((st.want 3).emit ("**" ++ t ++ "**")).want 3) n
  else if discardArgCmds.contains nm then
    let (_, j') := optArg cs j
    match braceArgHere cs j' with
    | none => cont (st.dropCmd nm) j'
    | some (_, _, n) => cont (st.dropCmd nm) n
  else if isAccentCmd nm then
    -- `\'e` and `\'{e}` both occur
    let (letter, n) :=
      match braceArgHere cs j with
      | some (a, _, n) => (chAt cs a, n)
      | none => (chAt cs j, j + 1)
    match accentTable.find? (fun (x, y, _) => x == nm && y == letter) with
    | some (_, _, r) => cont (st.emit r) n
    | none => cont (st.emitC letter) n
  else if macroCmds.contains nm then
    let (_, n) := readDecl cs nm j
    cont st (max n j)
  else if silentCmds.contains nm then
    match arg1 with
    | some (_, _, n) => if nm == "label" || nm == "uses" || nm == "lean"
                           || nm == "proves" || nm == "discussion" || nm == "alsoIn"
                        then cont st n else cont st j
    | none => cont st j
  else
    -- unknown: keep the argument, drop the name, and count it
    let (_, j') := optArg cs j
    match braceArgHere cs j' with
    | none => cont (st.dropCmd nm) j'
    | some (a, b, n) =>
      let (t, st) := convStr ctx cs a b st
      cont ((st.dropCmd nm).emit t) n
where
  /-- Convert the braced argument and wrap it in Markdown delimiters. -/
  wrap (l r : String) (code : Bool := false) : Conv :=
    match braceArgHere cs j with
    | none => convSpan ctx cs stop (min stop (j + 1)) (st.dropCmd nm)
    | some (a, b, n) =>
      let (t, st') := convStr ctx cs a b { st with code := st.code || code }
      let st := { st' with code := st.code }
      let st := if t.isEmpty then st else st.emit (l ++ t ++ r)
      convSpan ctx cs stop (min stop n) st
  /-- Convert the braced argument into its own paragraph with a lead-in. -/
  note (lead : String) : Conv :=
    match braceArgHere cs j with
    | none => convSpan ctx cs stop (min stop (j + 1)) (st.dropCmd nm)
    | some (a, b, n) =>
      let (t, st) := convStr ctx cs a b st
      let st := ((st.want 3).emit (lead ++ t)).want 3
      convSpan ctx cs stop (min stop n) st

/-- Handle `\begin{env}` whose body starts at `n`. -/
partial def convEnv (ctx : Ctx) (cs : Chars) (stop : Nat) (env : String) (n : Nat)
    (st : Conv) : Conv :=
  let (ce, after) := envEnd cs n env
  let ce := min ce stop
  let after := min stop (max after (n + 1))
  let cont (st : Conv) := convSpan ctx cs stop after st
  if displayMathEnvs.contains env then
    let st := ((st.want 3).flush).emit ("$$\n" ++ cleanMath (slice cs n ce) true ++ "\n$$")
    cont (st.want 3)
  else if alignMathEnvs.contains env then
    let inner := cleanMath (slice cs n ce) true
    let st := ((st.want 3).flush).emit
      ("$$\n\\begin{aligned}\n" ++ inner ++ "\n\\end{aligned}\n$$")
    cont (st.want 3)
  else if env == "itemize" || env == "enumerate" || env == "description" then
    -- `\begin{enumerate}[label=\arabic*.]`: key-value options, not prose
    let (_, n) := optArg cs n
    let outer := st.lists
    -- the separator is owed at the outer nesting, so that a top level list
    -- really is preceded by a blank line
    let st := if outer.isEmpty then st.want 3 else st.want 2
    let st := { st with lists := outer.push env }
    let st := convSpan ctx cs ce (min ce n) st
    let st := { st with lists := outer }
    cont (st.want (if outer.isEmpty then 3 else 2))
  else if env == "quote" || env == "quotation" || env == "displayquote" then
    let (t, st) := convStr ctx cs n ce st
    let quoted := String.intercalate "\n" ((splitLines t).toList.map fun l => "> " ++ l)
    let st := ((st.want 3).emit quoted).want 3
    cont st
  else if env == "verbatim" || env == "lstlisting" || env == "alltt" then
    let body := trim (slice cs n ce)
    let st := ((st.want 3).emit ("```\n" ++ body ++ "\n```")).want 3
    cont (st.dropEnv env)
  else if env == "proof" then
    let (_, n') := optArg cs n
    let st := (st.want 3).emit "**Proof.** "
    let st := convSpan ctx cs ce n' st
    cont (st.want 3)
  else if tabularEnvs.contains env then
    -- the column specification is not prose
    let (_, n') := optArg cs n
    let n' := match braceArg cs n' with | some (_, _, k) => k | none => n'
    let (t, st') := convStr ctx cs (min ce n') ce { st with table := true }
    let st := { st' with table := st.table }
    let st := ((st.want 3).emit (gfmTable t)).want 3
    cont (st.dropEnv env)
  else
    let st := convSpan ctx cs ce n (st.dropEnv env)
    cont st

/-- Convert a range into a string of its own, leaving the caller's output and
owed separator alone but keeping the report counters. -/
partial def convStr (ctx : Ctx) (cs : Chars) (a b : Nat) (st : Conv) : String × Conv :=
  let inner := convSpan ctx cs b a { st with out := "", pend := 0 }
  (trim inner.out, { inner with out := st.out, pend := st.pend })

end

/-- Convert a whole LaTeX fragment to Markdown. -/
def convertBody (ctx : Ctx) (src : String) (st : Conv) : String × Conv := Id.run do
  let cs := toChars src
  let inner := convSpan ctx cs cs.size 0 { st with out := "", pend := 0, lists := #[] }
  let text := trim inner.out
  -- never leave more than one blank line
  let ls := splitLines text
  let mut outLs : Array String := #[]
  let mut blanks := 0
  for l in ls do
    if (trim l).isEmpty then
      blanks := blanks + 1
      if blanks ≤ 1 then outLs := outLs.push ""
    else
      blanks := 0
      outLs := outLs.push l
  return (trim (String.intercalate "\n" outLs.toList),
    { inner with out := st.out, pend := st.pend })

/-! ## From items to objects -/

/-- An object as the structure pass leaves it: the id is fixed, everything
else is still LaTeX. -/
structure RawObj where
  /-- The object's id. -/
  id : String := ""
  /-- The blueprint kind. -/
  kind : String := "section"
  /-- The LaTeX environment it came from, `""` for a section. -/
  env : String := ""
  /-- The raw `[title]` or sectioning argument. -/
  rawTitle : String := ""
  /-- Position in the document. -/
  order : Nat := 0
  /-- The chain of section ids this object lives under, its own id last for a
  section. -/
  path : Array String := #[]
  /-- The raw statement. -/
  raw : String := ""
  /-- The raw proof, `""` when there is none. -/
  proof : String := ""
  /-- Is this a section? -/
  isSection : Bool := false
  /-- Did it carry a `\label`? -/
  labelled : Bool := false
  deriving Inhabited

/-- The first `\label{…}` of a fragment. -/
def firstLabel (cs : Chars) : Option String := Id.run do
  let mut i := 0
  while i < cs.size do
    if cs[i]! == '\\' then
      let (nm, j) := readCmdName cs (i + 1)
      if nm == "label" then
        match braceArg cs j with
        | some (a, b, _) => return some (trim (slice cs a b))
        | none => i := max j (i + 1)
      else i := max j (i + 1)
    else i := i + 1
  return none

/-- A fresh id: `base`, or `base-2`, `base-3`, … if that is taken. -/
def uniqueId (used : HashMap String Unit) (base : String) : String × HashMap String Unit :=
  Id.run do
    if !used.contains base then return (base, used.insert base ())
    for n in [2:100000] do
      let c := base ++ "-" ++ toString n
      if !used.contains c then return (c, used.insert c ())
    return (base, used)

/-- Assign ids and section paths to every item, and build the label map.
Returns the objects in document order, the label map, the labels that were
declared twice, and how many environments had no label. -/
def buildObjects (items : Array Item) :
    Array RawObj × HashMap String String × Array String × Nat := Id.run do
  -- content before the first sectioning command needs a section to live in
  let mut needRoot := false
  for it in items do
    match it with
    | .sec _ _ _ => break
    | .prose p => if !(trim p).isEmpty then needRoot := true
    | _ => needRoot := true
  let items := if needRoot then #[Item.sec 1 "Overview" none] ++ items else items
  let mut objs : Array RawObj := #[]
  let mut labels : HashMap String String := {}
  let mut used : HashMap String Unit := {}
  let mut dups : Array String := #[]
  let mut unlabelled := 0
  let mut path : Array String := #[]
  let mut curSec : Option Nat := none
  let mut lastEnv : Option Nat := none
  let mut ord := 0
  let mut ordinals : HashMap String Nat := {}
  for it in items do
    match it with
    | .sec lvl rawTitle label =>
      let base := match label with
        | some l => slugify l
        | none => slugify (plainish rawTitle)
      let (id, u) := uniqueId used base
      used := u
      if let some l := label then
        if labels.contains l then dups := dups.push l else labels := labels.insert l id
      let depth := min (lvl - 1) path.size
      path := (path.extract 0 depth).push id
      ord := ord + 1
      objs := objs.push { id, kind := "section", rawTitle, order := ord, path,
                          isSection := true, labelled := label.isSome }
      curSec := some (objs.size - 1)
      lastEnv := none
    | .env env title raw =>
      let cs := toChars raw
      let label := firstLabel cs
      let sec := path.back?.getD "x"
      let base ← match label with
        | some l => pure (slugify l)
        | none => do
          unlabelled := unlabelled + 1
          let key := sec ++ "\u0000" ++ env
          let n := ordinals.getD key 0 + 1
          ordinals := ordinals.insert key n
          pure (sec ++ "--" ++ env ++ "-" ++ toString n)
      let (id, u) := uniqueId used base
      used := u
      if let some l := label then
        if labels.contains l then dups := dups.push l else labels := labels.insert l id
      ord := ord + 1
      objs := objs.push { id, kind := kindOfEnv env, env, rawTitle := title.getD "",
                          order := ord, path, raw, labelled := label.isSome }
      lastEnv := some (objs.size - 1)
    | .proof raw =>
      match lastEnv with
      | some k =>
        objs := objs.set! k { objs[k]! with proof := raw }
        lastEnv := none
      | none =>
        if let some k := curSec then
          objs := objs.set! k
            { objs[k]! with raw := objs[k]!.raw ++ "\n\n\\textbf{Proof.} " ++ raw }
    | .prose raw =>
      lastEnv := none
      if let some k := curSec then
        objs := objs.set! k { objs[k]! with raw := objs[k]!.raw ++ "\n\n" ++ raw }
  return (objs, labels, dups, unlabelled)

/-! ## Emitting the Markdown sources -/

/-- Escape a string for a TOML basic string. -/
def tomlEscape (s : String) : String := Id.run do
  let hex := "0123456789abcdef"
  let mut out := ""
  for c in s.toList do
    if c == '\\' then out := out ++ "\\\\"
    else if c == '"' then out := out ++ "\\\""
    else if c == '\n' then out := out ++ "\\n"
    else if c == '\t' then out := out ++ "\\t"
    else if c == '\r' then out := out ++ "\\r"
    else if c.toNat < 32 || c.toNat == 127 then
      let n := c.toNat
      out := out ++ "\\u00" ++ String.singleton (hex.toList.getD (n / 16) '0')
                 ++ String.singleton (hex.toList.getD (n % 16) '0')
    else out := out.push c
  return out

/-- One `key = "value"` front matter line. -/
def fmStr (k v : String) : String := k ++ " = \"" ++ tomlEscape v ++ "\"\n"

/-- One `key = ["a", "b"]` front matter line. -/
def fmArr (k : String) (vs : Array String) : String :=
  k ++ " = [" ++ String.intercalate ", " (vs.toList.map fun v => "\"" ++ tomlEscape v ++ "\"")
    ++ "]\n"

/-- A file the importer is about to write. -/
structure OutFile where
  /-- Path relative to the output directory. -/
  rel : String
  /-- Its whole content. -/
  text : String
  deriving Inhabited

/-- Everything the report says. -/
structure ImportReport where
  /-- Dropped commands, by name. -/
  cmds : Array (String × Nat) := #[]
  /-- Environments passed through, by name. -/
  envs : Array (String × Nat) := #[]
  /-- `\uses` targets that resolved to nothing: object id and target. -/
  unresolved : Array (String × String) := #[]
  /-- Environments without a `\label`. -/
  unlabelled : Nat := 0
  /-- Labels declared more than once. -/
  dupLabels : Array String := #[]
  /-- `\input` paths that did not resolve. -/
  missingInputs : Array String := #[]
  /-- Object counts per kind. -/
  kinds : Array (String × Nat) := #[]
  /-- Number of objects. -/
  objects : Nat := 0
  /-- Number of `uses` edges. -/
  edges : Nat := 0
  /-- Number of Lean names referenced. -/
  leanRefs : Nat := 0
  /-- Number of KaTeX macros collected. -/
  macros : Nat := 0
  /-- Number of files written. -/
  files : Nat := 0
  deriving Inhabited

/-- Counts, biggest first, then alphabetically. -/
def sortCounts (m : HashMap String Nat) : Array (String × Nat) :=
  m.toArray.qsort fun a b => if a.2 != b.2 then a.2 > b.2 else a.1 < b.1

/-- Turn the objects into files.  Returns the files, the converter state (which
carries the report counters) and the report entries the emission itself
produces. -/
def emitFiles (ctx : Ctx) (objs : Array RawObj) : Array OutFile × Conv × ImportReport :=
  Id.run do
    let mut files : Array OutFile := #[]
    let mut st : Conv := {}
    let mut rep : ImportReport := {}
    let mut kinds : HashMap String Nat := {}
    for o in objs do
      let rawCs := toChars o.raw
      let proofCs := toChars o.proof
      -- title
      let (title, st') := convertBody ctx o.rawTitle st
      st := st'
      let title := trim (replaceAll title "\n" " ")
      -- Lean names
      let leanNames := if o.isSection then #[] else
        sortDedup ((collectArgs rawCs "lean").flatMap splitCommas |>.map cleanLeanName
          |>.filter fun (x : String) => !x.isEmpty)
      -- dependencies
      let targets := sortDedup
        (((collectArgs rawCs "uses" ++ collectArgs proofCs "uses").flatMap splitCommas))
      let mut uses : Array String := #[]
      let mut unres : Array String := #[]
      for t in targets do
        match ctx.labels.get? t with
        | some id => if id != o.id then uses := uses.push id
        | none =>
          unres := unres.push t
          rep := { rep with unresolved := rep.unresolved.push (o.id, t) }
      uses := sortDedup uses
      -- tags
      let mut tags : Array String := #[]
      if !o.isSection && o.env != o.kind then tags := tags.push ("latex:" ++ o.env)
      for d in (collectArgs rawCs "discussion" ++ collectArgs proofCs "discussion") do
        tags := tags.push ("discussion:" ++ trim d)
      -- bodies
      let (stmt, st') := convertBody ctx o.raw st
      st := st'
      let (prf, st') := convertBody ctx o.proof st
      st := st'
      let mut body := stmt
      if !prf.isEmpty then
        body := (if body.isEmpty then "" else body ++ "\n\n") ++ "## Proof\n\n" ++ prf
      if !unres.isEmpty then
        body := (if body.isEmpty then "" else body ++ "\n\n")
          ++ "Unresolved dependencies: " ++ String.intercalate ", " unres.toList
      -- front matter
      let mut fm := "+++\n"
      fm := fm ++ fmStr "id" o.id
      fm := fm ++ fmStr "kind" o.kind
      if !title.isEmpty then fm := fm ++ fmStr "title" title
      fm := fm ++ "order = " ++ toString o.order ++ "\n"
      if !leanNames.isEmpty then fm := fm ++ fmArr "lean" leanNames
      if !tags.isEmpty then fm := fm ++ fmArr "tags" tags
      if !uses.isEmpty then fm := fm ++ fmArr "uses" uses
      fm := fm ++ "+++\n"
      let dir := String.intercalate "/" o.path.toList
      let rel := if o.isSection then dir ++ "/_section.md" else dir ++ "/" ++ o.id ++ ".md"
      files := files.push { rel, text := fm ++ body ++ (if body.isEmpty then "" else "\n") }
      kinds := kinds.alter o.kind fun v => some (v.getD 0 + 1)
      rep := { rep with edges := rep.edges + uses.size,
                        leanRefs := rep.leanRefs + leanNames.size }
    let kindCounts := kinds.toArray.qsort (fun a b => a.1 < b.1)
    rep := { rep with objects := objs.size, files := files.size, kinds := kindCounts }
    return (files, st, rep)

/-! ## `blueprint.toml` and the report -/

/-- The `[katex.macros]` table: last definition wins, sorted by name. -/
def katexTable (ms : Array (String × String)) : Array (String × String) := Id.run do
  let mut m : HashMap String String := {}
  for (n, b) in ms do
    if n.startsWith "\\" && n.length > 1 then m := m.insert n b
  return m.toArray.qsort fun a b => a.1 < b.1

/-- Render the table as TOML. -/
def katexTableToml (ms : Array (String × String)) : String := Id.run do
  let mut s := "[katex.macros]\n"
  for (n, b) in ms do
    s := s ++ "\"" ++ tomlEscape n ++ "\" = \"" ++ tomlEscape b ++ "\"\n"
  return s

/-- Replace the `[katex.macros]` table of a `blueprint.toml` (creating the file
if it is not there), leaving everything else untouched. -/
def writeKatexMacros (path : System.FilePath) (ms : Array (String × String)) : IO Unit := do
  let old ← if ← path.pathExists then IO.FS.readFile path else pure ""
  let mut kept : Array String := #[]
  let mut skipping := false
  for l in splitLines old do
    let t := trim l
    if t == "[katex.macros]" then skipping := true
    else if skipping then
      if t.startsWith "[" then skipping := false; kept := kept.push l
    else kept := kept.push l
  while kept.back?.any (fun l => (trim l).isEmpty) do kept := kept.pop
  let head := if kept.isEmpty then "" else String.intercalate "\n" kept.toList ++ "\n\n"
  IO.FS.writeFile path (head ++ katexTableToml ms)

/-- The human readable import report. -/
def renderReport (entry : String) (r : ImportReport) : String := Id.run do
  let mut s := s!"latex import report for {entry}\n\n"
  s := s ++ s!"  objects        {r.objects}\n"
  for (k, n) in r.kinds do
    s := s ++ s!"    {k}: {n}\n"
  s := s ++ s!"  files written  {r.files}\n"
  s := s ++ s!"  uses edges     {r.edges}\n"
  s := s ++ s!"  lean names     {r.leanRefs}\n"
  s := s ++ s!"  katex macros   {r.macros}\n"
  s := s ++ s!"  unlabelled environments  {r.unlabelled}\n"
  s := s ++ s!"  duplicate labels         {r.dupLabels.size}\n"
  for l in r.dupLabels do
    s := s ++ s!"    {l}\n"
  if !r.missingInputs.isEmpty then
    s := s ++ s!"  unresolved \\input        {r.missingInputs.size}\n"
    for l in r.missingInputs do
      s := s ++ s!"    {l}\n"
  s := s ++ s!"  unresolved uses          {r.unresolved.size}\n"
  for (o, t) in r.unresolved do
    s := s ++ s!"    {o} -> {t}\n"
  s := s ++ s!"\n  dropped commands ({r.cmds.size} distinct)\n"
  for (n, c) in r.cmds do
    s := s ++ s!"    {c}  \\{n}\n"
  s := s ++ s!"\n  environments kept but not understood ({r.envs.size} distinct)\n"
  for (n, c) in r.envs do
    s := s ++ s!"    {c}  {n}\n"
  return s

/-! ## The driver -/

/-- Everything `blueprint import-latex` was told. -/
structure ImportOpts where
  /-- The entry `.tex` file. -/
  entry : System.FilePath
  /-- Where the Markdown goes. -/
  out : System.FilePath
  /-- A `blueprint.toml` to write `[katex.macros]` into. -/
  toml : Option System.FilePath := none
  /-- Where the report goes; stderr when absent. -/
  report : Option System.FilePath := none
  /-- Extra macro files. -/
  macros : Array System.FilePath := #[]
  /-- Delete `.md` files under `out` that this import did not write. -/
  clean : Bool := false

/-- Every `.md` file under `dir`, relative to it. -/
partial def listMarkdown (dir : System.FilePath) (rel : String) : IO (Array String) := do
  unless ← dir.pathExists do return #[]
  let mut out : Array String := #[]
  for e in ← dir.readDir do
    let r := if rel.isEmpty then e.fileName else rel ++ "/" ++ e.fileName
    if ← e.path.isDir then out := out ++ (← listMarkdown e.path r)
    else if e.path.extension == some "md" then out := out.push r
  return out

/-- Remove directories under `dir` that hold nothing. -/
partial def pruneEmptyDirs (dir : System.FilePath) : IO Bool := do
  let mut empty := true
  for e in ← dir.readDir do
    if ← e.path.isDir then
      if ← pruneEmptyDirs e.path then
        try IO.FS.removeDirAll e.path catch _ => empty := false
      else empty := false
    else empty := false
  return empty

/-- Run the import. -/
def runImport (o : ImportOpts) : IO ImportReport := do
  unless ← o.entry.pathExists do
    throw <| IO.userError s!"{o.entry}: no such file"
  let srcRoot := o.entry.parent.getD "."
  let missing ← IO.mkRef (#[] : Array String)
  let doc ← expandInputs srcRoot o.entry #[] missing
  -- macro files: the ones named, plus `<src>/macros/common.tex` if it is there
  let mut macroFiles := o.macros
  let common := srcRoot / "macros" / "common.tex"
  if (← common.pathExists) && !macroFiles.contains common then
    macroFiles := #[common] ++ macroFiles
  let mut decls : Decls := {}
  for f in macroFiles do
    unless ← f.pathExists do throw <| IO.userError s!"{f}: no such file"
    decls := collectDecls (toChars (stripComments (← IO.FS.readFile f))) decls
  let cs := toChars doc
  decls := collectDecls cs decls
  let thmEnvs := sortDedup (builtinTheoremEnvs ++ decls.theorems)
  let items := scanDoc thmEnvs cs
  let (objs, labels, dups, unlabelled) := buildObjects items
  let ctx : Ctx := { labels }
  let (files, st, rep) := emitFiles ctx objs
  let macros := katexTable decls.macros
  let miss ← missing.get
  let rep := { rep with
    cmds := sortCounts st.cmds, envs := sortCounts st.envs,
    unlabelled, dupLabels := dups, missingInputs := miss,
    macros := macros.size }
  -- write the sources
  IO.FS.createDirAll o.out
  let mut written : Array String := #[]
  for f in files do
    let p := o.out / f.rel
    IO.FS.createDirAll (p.parent.getD o.out)
    IO.FS.writeFile p f.text
    written := written.push f.rel
  if o.clean then
    for r in ← listMarkdown o.out "" do
      unless written.contains r do IO.FS.removeFile (o.out / r)
    discard <| pruneEmptyDirs o.out
  if let some t := o.toml then
    writeKatexMacros t macros
  let text := renderReport o.entry.toString rep
  match o.report with
  | some p => IO.FS.writeFile p text
  | none => IO.eprint text
  return rep

end Blueprint
