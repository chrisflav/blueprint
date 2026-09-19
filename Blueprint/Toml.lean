import Lake.Toml
import Blueprint.Model

/-!
# A thin wrapper around `Lake.Toml`

The toolchain ships a full TOML parser as part of Lake.  This module is the
only place that mentions it: everything else works with the small `TValue`
tree defined here, so that the TOML backend could be swapped out.
-/

namespace Blueprint

/-- A TOML value, stripped of source positions. -/
inductive TValue where
  /-- A string. -/
  | str (s : String)
  /-- An integer. -/
  | int (n : Int)
  /-- A float. -/
  | float (f : Float)
  /-- A boolean. -/
  | bool (b : Bool)
  /-- A date or time, kept as its source text. -/
  | dateTime (s : String)
  /-- An array. -/
  | arr (xs : Array TValue)
  /-- A table, in source order. -/
  | table (xs : Array (String × TValue))
  deriving Inhabited

namespace TValue

/-- A one line description of the value's shape, for error messages. -/
def typeName : TValue → String
  | .str _ => "string"
  | .int _ => "integer"
  | .float _ => "float"
  | .bool _ => "boolean"
  | .dateTime _ => "date-time"
  | .arr _ => "array"
  | .table _ => "table"

/-- Look up a key in a table value. -/
def get? (v : TValue) (k : String) : Option TValue :=
  match v with
  | .table xs => (xs.find? (·.1 == k)).map (·.2)
  | _ => none

/-- The entries of a table value, in source order. -/
def entries : TValue → Array (String × TValue)
  | .table xs => xs
  | _ => #[]

/-- The value as a string. -/
def asString? : TValue → Option String
  | .str s => some s
  | _ => none

/-- The value as a boolean. -/
def asBool? : TValue → Option Bool
  | .bool b => some b
  | _ => none

/-- The value as a natural number. -/
def asNat? : TValue → Option Nat
  | .int n => if n < 0 then none else some n.toNat
  | _ => none

/-- A string or an array of strings, as an array of strings. -/
def asStrings? : TValue → Option (Array String)
  | .str s => some #[s]
  | .arr xs => xs.foldl (init := some #[]) fun acc v =>
      match acc, v with
      | some acc, .str s => some (acc.push s)
      | _, _ => none
  | _ => none

/-- Convert to an `AttrValue`, if the value has an admissible shape. -/
def toAttr? : TValue → Option AttrValue
  | .str s => some (.str s)
  | .int n => some (.int n)
  | .float f => some (.float f)
  | .bool b => some (.bool b)
  | .arr xs => (TValue.asStrings? (.arr xs)).map .strs
  | _ => none

end TValue

/-- Render a `Lake.Toml` key name as a plain string. -/
private def tomlKeyToString : Lean.Name → String
  | .str .anonymous s => s
  | .str p s => tomlKeyToString p ++ "." ++ s
  | n => n.toString

/-- Convert a `Lake.Toml.Value` to a `TValue`. -/
private def ofTomlValue : Lake.Toml.Value → TValue
  | .string _ s => .str s
  | .integer _ n => .int n
  | .float _ f => .float f
  | .boolean _ b => .bool b
  | .dateTime _ dt => .dateTime (ToString.toString dt)
  | .array _ xs => .arr (xs.attach.map fun ⟨v, _⟩ => ofTomlValue v)
  | .table _ t => .table (t.items.attach.map fun ⟨(k, v), _⟩ => (tomlKeyToString k, ofTomlValue v))
decreasing_by
  · have h := Array.sizeOf_lt_of_mem ‹v ∈ xs›
    simp only [Lake.Toml.Value.array.sizeOf_spec]
    omega
  · have h := Array.sizeOf_lt_of_mem ‹(k, v) ∈ t.items›
    have h2 : sizeOf t.items < sizeOf t := by cases t; simp; omega
    simp only [Lake.Toml.Value.table'.sizeOf_spec] at *
    simp at h
    omega

/-- Parse a TOML document.  `fileName` is used in error messages only. -/
def parseToml (input fileName : String) : IO (Except String TValue) := do
  -- A single trailing digit at the very end of the input trips up the TOML
  -- integer parser of the toolchain, so always end with a newline.
  let input := if input.endsWith "\n" then input else input ++ "\n"
  let ictx := Lean.Parser.mkInputContext input fileName
  match (← (Lake.Toml.loadToml ictx).toBaseIO) with
  | .ok t => return .ok (.table (t.items.map fun (k, v) => (tomlKeyToString k, ofTomlValue v)))
  | .error log =>
    let msgs ← log.toList.mapM (fun m => m.toString)
    return .error (String.intercalate "\n" (msgs.map Blueprint.trim))

end Blueprint
