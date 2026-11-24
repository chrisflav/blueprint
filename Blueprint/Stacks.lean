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
and a chapter, a section or an item of a list as something else.
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
snapshot's `stacks`. -/
def StacksStatement.toJson (s : StacksStatement) : Json :=
  Json.mkObj [("kind", Json.str s.kind), ("html", Json.str s.html)]

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
    | some t, some kind, some html => if t == tag then some { tag, kind, html } else none
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
anything else is said in words. -/
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
  else if "<li".isPrefixOf b then .error "an item of a statement's list; link to the statement it is in"
  else .error "not a statement of the Stacks project"

/-- Ask the Stacks project for the statement of `tag`, with `curl`. -/
def fetchStacksStatement (tag : String) : IO (Except String StacksStatement) := do
  let out ← IO.Process.output { cmd := "curl", args := #["-fsS", "--max-time", "30",
    "-A", "blueprint (https://github.com/chrisflav/blueprint)", stacksApiUrl tag] }
  if out.exitCode != 0 then
    return .error s!"could not fetch {stacksApiUrl tag}: {trim out.stderr}"
  return readStacksAnswer tag out.stdout

end Blueprint
