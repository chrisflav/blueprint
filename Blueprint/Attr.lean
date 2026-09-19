import Lean

/-!
# The `@[blueprint]` attribute

`DESIGN.md` §5.  A Lean project maps its declarations to blueprint objects
from the Lean side by tagging them:

```lean
@[blueprint "main-theorem"]
theorem mainTheorem : ... := ...

@[blueprint main-theorem]        -- the bare form, same thing
theorem mainTheorem : ... := ...
```

The pairs (constant name, object id) go into a persistent environment
extension, so that `lake exe blueprint extract` sees them again after
`import`.

This module deliberately depends on nothing but Lean core: a user project
imports it, so it must not drag in Lake or the rest of the `Blueprint`
library.
-/

namespace Blueprint

open Lean

/-! ## The environment extension -/

/-- One entry of the map: the tagged constant and the blueprint object it
realises. -/
structure BlueprintEntry where
  /-- The tagged constant. -/
  decl : Name
  /-- The id of the blueprint object. -/
  id : String
  deriving Inhabited, BEq, Repr

/-- The persistent map from constants to blueprint object ids.  Entries of
imported modules are merged in by `addImportedFn`, so the extractor sees the
whole project after importing its root module. -/
initialize blueprintExt : SimplePersistentEnvExtension BlueprintEntry (Array BlueprintEntry) ←
  registerSimplePersistentEnvExtension {
    addEntryFn := Array.push
    addImportedFn := mkStateFromImportedEntries Array.push #[]
  }

/-- Every `(constant, object id)` pair in the environment, from this module
and from every imported one, sorted by constant name. -/
def blueprintEntries (env : Environment) : Array BlueprintEntry :=
  let es := blueprintExt.getState env
  let es := es.qsort fun a b =>
    if a.decl == b.decl then a.id < b.id else Name.lt a.decl b.decl
  es.foldl (init := #[]) fun acc e =>
    if acc.back?.any (fun p => p.decl == e.decl && p.id == e.id) then acc else acc.push e

/-- The object id a constant is tagged with, if any. -/
def blueprintIdFor? (env : Environment) (decl : Name) : Option String :=
  ((blueprintEntries env).find? (·.decl == decl)).map (·.id)

/-! ## The attribute

The argument is either a string literal, `@[blueprint "main-theorem"]`, or a
bare token, `@[blueprint main-theorem]`.  The bare form cannot go through the
Lean tokeniser (`main-theorem` is three tokens, one of them a keyword), so
the argument is read by a raw parser that takes either a quoted string or a
run of slug characters.
-/

/-- Characters a bare blueprint id may consist of.  The same set the parser
of `blueprint check` accepts in `[slug]` links. -/
def isIdChar (c : Char) : Bool :=
  c.isAlphanum || c == '-' || c == '_' || c == '/' || c == '~' || c == '.'

open Lean.Parser in
/-- Raw parser for the argument of `@[blueprint …]`: `"some-id"` or `some-id`. -/
def blueprintIdFn : ParserFn := fun c s =>
  let i := s.pos
  if h : c.atEnd i then s.mkEOIError ["blueprint object id"]
  else if c.get' i h == '"' then
    rawFn (fun c s =>
      let s := satisfyFn (· == '"') "'\"'" c s
      let s := takeWhileFn (fun ch => ch != '"' && ch != '\n') c s
      satisfyFn (· == '"') "'\"'" c s) (trailingWs := true) c s
  else
    rawFn (takeWhile1Fn isIdChar "blueprint object id") (trailingWs := true) c s

open Lean.Parser in
/-- The argument of `@[blueprint …]`, as a single raw atom. -/
def blueprintId : Parser where
  fn := blueprintIdFn
  info := { firstTokens := .unknown }

/-- The id is a single atom, so it prints back as it was written. -/
@[combinator_formatter blueprintId]
def blueprintId.formatter : PrettyPrinter.Formatter :=
  PrettyPrinter.Formatter.visitAtom Name.anonymous

/-- The id never needs parentheses. -/
@[combinator_parenthesizer blueprintId]
def blueprintId.parenthesizer : PrettyPrinter.Parenthesizer :=
  PrettyPrinter.Parenthesizer.visitToken

/-- `@[blueprint "some-id"]` maps a declaration to a blueprint object. -/
syntax (name := blueprint) "blueprint" blueprintId : attr

/-- Read the object id out of the attribute syntax, dropping the quotes of
the string form. -/
def idOfSyntax? (stx : Syntax) : Option String := do
  let raw ← match stx[1] with
    | .atom _ v => some v
    | s => s.isStrLit?
  let raw := if raw.startsWith "\"" && raw.endsWith "\"" && raw.length ≥ 2
    then ((raw.drop 1).dropEnd 1).copy else raw
  if raw.isEmpty then none else some raw

initialize registerBuiltinAttribute {
  name := `blueprint
  descr := "maps this declaration to the blueprint object with the given id"
  add := fun decl stx kind => do
    unless kind == .global do
      throwError "`@[blueprint]` must be global"
    match idOfSyntax? stx with
    | none => throwError "`@[blueprint]` expects an object id, as in `@[blueprint \"main-theorem\"]`"
    | some id =>
      modifyEnv fun env => blueprintExt.addEntry env { decl, id }
}

end Blueprint
