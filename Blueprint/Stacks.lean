import Blueprint.Git
import Lean.Data.Json

/-!
# Stacks project tags

A link to a statement of the Stacks project (https://stacks.math.columbia.edu),
`[text](stacks:00DV)` in prose or `\href{stacks:00DV}{…}` in a formula, which
the website shows as the words around it, a click with Ctrl held opening a
card with the statement.  The website cannot ask the Stacks project for it
(its API does not let another site's pages read it), so `blueprint stacks`
fetches the statements once, into `stacks.json` next to `blueprint.toml`, and
the snapshot carries the ones linked to.

A tag is four digits and capital letters.  Only a statement's tag will do, a
lemma's, a definition's and so on: the API hands out those as an `<article>`,
and a chapter or a section as something else.  The tag of an item of a
statement's list, `00DW` in Nakayama's lemma `00DV`, stands for the whole
statement, the website marking the item: the API hands out the item alone,
and says nothing of the statement it is in, which the Stacks project's
sources on GitHub do (`stacksItemParent`).
-/

namespace Blueprint

open Lean (Json)

/-- The tag of a Stacks link's address after `stacks:`, in capitals, when it
is one: four digits and letters, either case. -/
def stacksTag? (s : String) : Option String :=
  if s.length == 4 && s.toList.all Char.isAlphanum then some s.toUpper else none

/-- The page of a tag on the Stacks project. -/
def stacksTagUrl (tag : String) : String := s!"https://stacks.math.columbia.edu/tag/{tag}"

/-- Where the Stacks project's API hands out the statement of a tag, without
its proof. -/
def stacksApiUrl (tag : String) : String :=
  s!"https://stacks.math.columbia.edu/data/tag/{tag}/content/statement"

/-- A statement as JSON, the value of its tag in `stacks.json` and in the
snapshot's `stacks`; an item's says the statement it is in as `in`. -/
def StacksStatement.toJson (s : StacksStatement) : Json :=
  Json.mkObj ([("kind", Json.str s.kind), ("html", Json.str s.html)] ++
    (if s.parent.isEmpty then [] else [("in", Json.str s.parent)]))

/-- Statements as a JSON object from tag to statement. -/
def stacksJson (xs : Array StacksStatement) : Json :=
  Json.mkObj (xs.toList.map fun s => (s.tag, s.toJson))

/-- The statements of a JSON object from tag to statement, sorted by tag; an
entry that is not a tag and a statement is left out. -/
def stacksOfJson (j : Json) : Array StacksStatement :=
  let entries := match j.getObj? with
    | .ok o => o.toArray
    | .error _ => #[]
  let xs := entries.filterMap fun (tag, v) =>
    let str (k : String) := ((v.getObjVal? k).bind (·.getStr?)).toOption
    match stacksTag? tag, str "kind", str "html" with
    | some t, some kind, some html =>
      if t == tag then some { tag, kind, html, parent := ((str "in").bind stacksTag?).getD "" } else none
    | _, _, _ => none
  xs.qsort (fun a b => a.tag < b.tag)

/-- `stacks.json`, as `blueprint stacks` writes it. -/
def renderStacksFile (xs : Array StacksStatement) : String :=
  (Json.mkObj [
    ("about", Json.str "Statements of the Stacks project, https://stacks.math.columbia.edu, \
      fetched by 'blueprint stacks' for the tags the blueprint links to"),
    ("tags", stacksJson xs)]).pretty ++ "\n"

/-- Read `stacks.json`. -/
def parseStacksFile (text : String) : Except String (Array StacksStatement) := do
  let j ← Json.parse text
  match j.getObjVal? "tags" with
  | .ok t => return stacksOfJson t
  | .error _ => throw "expected an object with 'tags'"

/-- What the Stacks project's API answered for `tag`, read: the statement, or
why there is none.  A statement is an `<article class="env-…">` (not a proof);
anything else is said in words, an item of a list among them, which
`fetchStacksStatement` takes further. -/
def readStacksAnswer (tag body : String) : Except String StacksStatement :=
  let b := trim body
  let head := String.ofList (b.toList.take 300)
  let art := "<article class=\"env-"
  if art.isPrefixOf b then
    let kind := String.ofList ((b.toList.drop art.length).takeWhile (· != '"'))
    if kind.isEmpty || kind == "proof" then .error "a proof, not a statement"
    else if !containsSubstr head s!"id=\"{tag}\"" then .error "the Stacks project answered with another tag"
    else .ok { tag, kind, html := b }
  else if "This tag does not exist".isPrefixOf b then .error "the Stacks project has no such tag"
  else if containsSubstr head "tex-part" then .error "a part of the Stacks project, not a statement"
  else if containsSubstr head "tex-chapter" then .error "a chapter of the Stacks project, not a statement"
  else if containsSubstr head "tex-subsection" then .error "a subsection, not a statement"
  else if containsSubstr head "tex-section" then .error "a section, not a statement"
  else if "<li".isPrefixOf b then .error "an item of a list"
  else .error "not a statement of the Stacks project"

/-- Fetch `url` with `curl`. -/
def curlGet (url : String) : IO (Except String String) := do
  let out ← IO.Process.output { cmd := "curl", args := #["-fsSL", "--max-time", "60",
    "-A", "blueprint (https://github.com/chrisflav/blueprint)", url] }
  if out.exitCode != 0 then
    return .error s!"could not fetch {url}: {trim out.stderr}"
  return .ok out.stdout

/-- The Stacks project's sources on GitHub that finding an item's statement
needs, each fetched once in a run of `blueprint stacks`: the `tags` file,
from tag to label, and the chapters' LaTeX, by chapter. -/
structure StacksSources where
  /-- `tags/tags`, once fetched. -/
  tags : IO.Ref (Option String)
  /-- `<chapter>.tex`, once fetched. -/
  chapters : IO.Ref (Array (String × String))

/-- Nothing fetched yet. -/
def StacksSources.new : IO StacksSources :=
  return { tags := ← IO.mkRef none, chapters := ← IO.mkRef #[] }

/-- A file of the Stacks project's sources on GitHub. -/
def stacksSourceUrl (file : String) : String :=
  s!"https://raw.githubusercontent.com/stacks/stacks-project/master/{file}"

/-- `file` of the sources, fetched once. -/
private def StacksSources.get (src : StacksSources) (file : String) : IO (Except String String) := do
  if file == "tags/tags" then
    if let some t ← src.tags.get then return .ok t
  else if let some (_, t) := (← src.chapters.get).find? (·.1 == file) then return .ok t
  let r ← curlGet (stacksSourceUrl file)
  if let .ok t := r then
    if file == "tags/tags" then src.tags.set (some t) else src.chapters.modify (·.push (file, t))
  return r

/-- The LaTeX environments of the Stacks project's statements: what holds an
item that a tag names.  Not `reference` or `history`, which sit inside one. -/
def stacksStatementEnvironments : List String :=
  ["lemma", "proposition", "theorem", "definition", "remark", "remarks", "example",
   "exercise", "situation", "conjecture", "question", "notation"]

/-- The tag of the statement the item `tag` is in, from the Stacks project's
sources: the `tags` file gives the item's label, `<chapter>-item-<name>`; in
`<chapter>.tex`, the statement is the nearest `\begin{lemma}` (or another of
`stacksStatementEnvironments`) before `\label{item-<name>}`, its label the
first `\label` after it, and the `tags` file gives that label's tag.  An
item in a proof, or in a section's own text, is in no statement: the error
then says where it is, "in a proof".  The caller makes sure the statement
does hold the item. -/
def stacksItemParent (src : StacksSources) (tag : String) : IO (Except String String) := do
  let tags ← match ← src.get "tags/tags" with
    | .ok t => pure t
    | .error e => return .error e
  let lines := (tags.splitOn "\n").map fun l => String.ofList (l.toList.filter (· != '\r'))
  let some line := lines.find? (·.startsWith (tag ++ ",")) |
    return .error "the Stacks project's tags file does not list it"
  let label := String.ofList (line.toList.drop 5)
  let (chapter, name) ← match label.splitOn "-item-" with
    | c :: n :: more => pure (c, String.intercalate "-item-" (n :: more))
    | _ => return .error s!"its label, {label}, is not an item's"
  let tex ← match ← src.get (chapter ++ ".tex") with
    | .ok t => pure t
    | .error e => return .error e
  let before ← match tex.splitOn ("\\label{item-" ++ name ++ "}") with
    | b :: _ :: _ => pure b
    | _ => return .error s!"{chapter}.tex has no label item-{name}"
  -- An item of a list in a proof, or in a section's own text, is in no
  -- statement: the nearest statement before it ended before it.
  let openIn (env : String) : Bool :=
    match (before.splitOn ("\\begin{" ++ env ++ "}")).getLast? with
    | some after => before.length != after.length && !containsSubstr after ("\\end{" ++ env ++ "}")
    | none => false
  if openIn "proof" then return .error "in a proof"
  let envOf (p : String) := String.ofList (p.toList.takeWhile (· != '}'))
  let some piece := (before.splitOn "\\begin{").reverse.find?
      (stacksStatementEnvironments.contains <| envOf ·) |
    return .error "in the text of a section"
  unless openIn (envOf piece) do
    return .error "in the text of a section"
  let some parentLabel := (match piece.splitOn "\\label{" with
      | _ :: l :: _ => some (String.ofList (l.toList.takeWhile (· != '}')))
      | _ => none) |
    return .error s!"the {envOf piece} before it in {chapter}.tex has no label"
  let full := chapter ++ "-" ++ parentLabel
  let some pline := lines.find? (·.endsWith ("," ++ full)) |
    return .error s!"the Stacks project's tags file does not list {full}"
  return .ok (String.ofList (pline.toList.take 4))

/-- Ask the Stacks project for the statement of `tag`, with `curl`: for an
item of a statement's list, the statement it is in (`stacksItemParent`),
which must hold it. -/
def fetchStacksStatement (src : StacksSources) (tag : String) : IO (Except String StacksStatement) := do
  let body ← match ← curlGet (stacksApiUrl tag) with
    | .ok b => pure b
    | .error e => return .error e
  match readStacksAnswer tag body with
  | .ok s => return .ok s
  | .error e =>
    unless "<li".isPrefixOf (trim body) do return .error e
    let parent ← match ← stacksItemParent src tag with
      | .ok p => pure p
      | .error e => return .error <|
        if "in ".isPrefixOf e then s!"an item of a list {e}, not of a statement"
        else s!"an item of a list, whose statement could not be found: {e}"
    let pbody ← match ← curlGet (stacksApiUrl parent) with
      | .ok b => pure b
      | .error e => return .error e
    match readStacksAnswer parent pbody with
    | .error e => return .error s!"an item of a list in {parent}, which is {e}"
    | .ok s =>
      unless containsSubstr s.html s!"id=\"{tag}\"" do
        return .error s!"an item of a list, which the statement {parent} found for it does not hold"
      return .ok { s with tag, parent }

end Blueprint
