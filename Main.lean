import Blueprint

/-- The `blueprint` executable. -/
def main (argv : List String) : IO UInt32 :=
  Blueprint.cli argv
