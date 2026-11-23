+++
kind  = "definition"
title = "Addition"
uses  = ["nat"]
+++
Addition on [nat] is defined by recursion on the second argument:

```lean
/-- Addition, by recursion on the second argument. -/
def add : ℕ → ℕ → ℕ
  | m, 0 => m
  | m, n + 1 => add m n + 1

@[simp] theorem add_zero (m : ℕ) : add m 0 = m := by
  simp [add]  -- the `[add]` of Lean, not a reference: code is kept as written
```
