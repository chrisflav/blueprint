#!/usr/bin/env bash
# Acceptance tests: build the tool, then run it over the three example
# blueprints in examples/ and check what comes out.  Phase 2 adds the
# extractor, which runs over the `BlueprintExamples` library in this repo.
set -u

cd "$(dirname "$0")"
ROOT="$(pwd)"
BP="$ROOT/.lake/build/bin/blueprint"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok ()   { pass=$((pass + 1)); echo "  ok   $1"; }
bad ()  { fail=$((fail + 1)); echo "  FAIL $1"; }
head_ () { echo; echo "== $1"; }

# Collapse a pretty printed JSON document onto one line, so that a test can
# grep for a whole field with -F.
norm () { tr -s ' \n' ' ' < "$1"; }

# `wants <file> <fragment>...`: each fragment must occur in the normalised
# JSON of <file>.
wants () {
  local file="$1"; shift
  local text
  text="$(norm "$file")"
  local want
  for want in "$@"; do
    if [ "${text#*"$want"}" != "$text" ]; then
      ok "$(basename "$file") contains $want"
    else
      bad "$(basename "$file") contains $want"
    fi
  done
}

head_ "lake build"
if lake build 2>&1 | tee "$TMP/build.log" | grep -qE '^error'; then
  bad "lake build"
  cat "$TMP/build.log"
  exit 1
fi
ok "lake build"
if grep -qE '^warning' "$TMP/build.log"; then
  bad "lake build emitted warnings"
  grep -E '^warning' "$TMP/build.log"
else
  ok "lake build is warning free"
fi

# `blueprint extract` imports the project's oleans, which it finds through
# LEAN_PATH.  `lake exe blueprint` sets that; the tests run the binary
# directly, so set it here the same way Lake would.
LEAN_PATH="$(lake env printenv LEAN_PATH)"
export LEAN_PATH

# ---------------------------------------------------------------- good ones
for ex in minimal induction; do
  head_ "examples/$ex"
  if "$BP" check --root "examples/$ex" > "$TMP/$ex.check" 2>&1; then
    ok "check exits 0"
  else
    bad "check exits 0"; cat "$TMP/$ex.check"
  fi

  if "$BP" build --root "examples/$ex" -o "$TMP/$ex.json" > "$TMP/$ex.build" 2>&1; then
    ok "build exits 0"
  else
    bad "build exits 0"; cat "$TMP/$ex.build"
  fi

  if [ -s "$TMP/$ex.json" ] && grep -q '"version": 1' "$TMP/$ex.json" \
     && grep -q '"objects"' "$TMP/$ex.json"; then
    ok "build produced a version 1 snapshot"
  else
    bad "build produced a version 1 snapshot"
  fi

  if "$BP" view --root "examples/$ex" > "$TMP/$ex.view" 2>&1 \
     && grep -q '^collapse kind: refines' "$TMP/$ex.view"; then
    ok "view prints the quotient graph"
  else
    bad "view prints the quotient graph"; cat "$TMP/$ex.view"
  fi

  if "$BP" view --root "examples/$ex" --json > "$TMP/$ex.view.json" 2>&1 \
     && grep -q '"consistency"' "$TMP/$ex.view.json"; then
    ok "view --json prints JSON"
  else
    bad "view --json prints JSON"; cat "$TMP/$ex.view.json"
  fi

  # determinism: the same input gives byte identical output
  "$BP" build --root "examples/$ex" -o "$TMP/$ex.again.json" > /dev/null 2>&1
  if cmp -s "$TMP/$ex.json" "$TMP/$ex.again.json"; then
    ok "build is deterministic"
  else
    bad "build is deterministic"
  fi
done

head_ "examples/induction: features"
for want in \
  'commutes/uses~main-theorem~key-prop/uses~key-prop~compactness/uses~main-theorem~compactness' \
  'generalises/uses~base-case~compactness/uses~main-theorem~key-prop' \
  '"depth": 2'
do
  if grep -qF "$want" "$TMP/induction.json"; then
    ok "snapshot contains $want"
  else
    bad "snapshot contains $want"
  fi
done
for want in multi-parent undeclared-edge unwitnessed-edge; do
  if grep -q "\[$want\]" "$TMP/induction.check"; then
    ok "check reports $want"
  else
    bad "check reports $want"
  fi
done

head_ "examples/minimal: proofs"
wants "$TMP/minimal.json" \
  '"id": "proof/add-comm"' \
  '"boundary": [{"role": "of", "id": "add-comm"}]' \
  '"id": "uses/proof~add-comm/add-assoc"'
if grep -q 'refines/proof~add-comm' "$TMP/minimal.json"; then
  bad "a proof does not refine the section of its directory"
else
  ok "a proof does not refine the section of its directory"
fi
"$BP" view --root examples/minimal --expand basics > "$TMP/minimal.proof.view" 2>&1
if grep -q 'proof/add-comm : proof  \[internal\]' "$TMP/minimal.proof.view" \
   && grep -q 'uses/proof~add-comm/add-assoc : uses \[visible\]  src={add-comm}' "$TMP/minimal.proof.view" \
   && grep -q 'uses: add-comm -> add-assoc  declared only' "$TMP/minimal.proof.view"; then
  ok "a proof's uses stand for its statement's, and are declared"
else
  bad "a proof's uses stand for its statement's, and are declared"; cat "$TMP/minimal.proof.view"
fi
"$BP" view --root examples/minimal > "$TMP/minimal.proof.view" 2>&1
if grep -q '^consistency (0)' "$TMP/minimal.proof.view"; then
  ok "collapsed with its statement, a proof's uses are internal"
else
  bad "collapsed with its statement, a proof's uses are internal"; cat "$TMP/minimal.proof.view"
fi

head_ "kinds: the arrow display hint"
if [ "$(grep -c '"arrow"' "$TMP/induction.json")" = 1 ] \
   && grep -q '"arrow": "reverse"' "$TMP/induction.json"; then
  ok "only uses carries an arrow hint, and it is reverse"
else
  bad "only uses carries an arrow hint, and it is reverse"
fi
cp -r examples/minimal "$TMP/arrow"
printf '\n[kinds.uses]\narrow = "forward"\n' >> "$TMP/arrow/blueprint.toml"
if "$BP" build --root "$TMP/arrow" -o "$TMP/arrow.json" > /dev/null 2>&1 \
   && ! grep -q '"arrow"' "$TMP/arrow.json"; then
  ok "blueprint.toml can turn uses back to forward"
else
  bad "blueprint.toml can turn uses back to forward"
fi
printf '\n[kinds.implies]\narrow = "sideways"\n' >> "$TMP/arrow/blueprint.toml"
if ! "$BP" check --root "$TMP/arrow" > "$TMP/arrow.check" 2>&1 \
   && grep -q "unknown arrow 'sideways'" "$TMP/arrow.check"; then
  ok "an unknown arrow is rejected"
else
  bad "an unknown arrow is rejected"; cat "$TMP/arrow.check"
fi

head_ "kinds: the graph display hint, appendix and hidden"
if [ "$(grep -c '"graph"' "$TMP/induction.json")" = 2 ] \
   && grep -q '"graph": "optional"' "$TMP/induction.json" \
   && grep -q '"graph": "never"' "$TMP/induction.json"; then
  ok "only appendix and hidden carry a graph hint, optional and never"
else
  bad "only appendix and hidden carry a graph hint, optional and never"
fi
cp -r examples/minimal "$TMP/graph"
mkdir -p "$TMP/graph/blueprint/appendix"
printf '+++\nkind = "appendix"\ntitle = "Appendix"\n+++\nDetails.\n' \
  > "$TMP/graph/blueprint/appendix/_section.md"
printf '+++\nkind = "lemma"\n+++\nA detail.\n' > "$TMP/graph/blueprint/appendix/detail.md"
printf '+++\nkind = "hidden"\ntitle = "Reading guide"\n+++\nRead on.\n' \
  > "$TMP/graph/blueprint/guide.md"
if "$BP" check --root "$TMP/graph" > "$TMP/graph.check" 2>&1 \
   && "$BP" build --root "$TMP/graph" -o "$TMP/graph.json" > /dev/null 2>&1; then
  ok "an appendix with contents and a hidden object check clean"
else
  bad "an appendix with contents and a hidden object check clean"; cat "$TMP/graph.check"
fi
wants "$TMP/graph.json" '"id": "refines/detail/appendix"' '"kind": "hidden"'
printf '\n[kinds.remark]\ngraph = "never"\n' >> "$TMP/graph/blueprint.toml"
if "$BP" build --root "$TMP/graph" -o "$TMP/graph.json" > /dev/null 2>&1 \
   && [ "$(grep -c '"graph"' "$TMP/graph.json")" = 3 ]; then
  ok "blueprint.toml can keep another kind out of the graph"
else
  bad "blueprint.toml can keep another kind out of the graph"
fi
printf '\n[kinds.concept]\ngraph = "sometimes"\n' >> "$TMP/graph/blueprint.toml"
if ! "$BP" check --root "$TMP/graph" > "$TMP/graph.check" 2>&1 \
   && grep -q "unknown graph 'sometimes'" "$TMP/graph.check"; then
  ok "an unknown graph hint is rejected"
else
  bad "an unknown graph hint is rejected"; cat "$TMP/graph.check"
fi

head_ "examples/induction: snapshot round trip"
if "$BP" read "$TMP/induction.json" -o "$TMP/induction.rt.json" > /dev/null 2>&1 \
   && cmp -s "$TMP/induction.json" "$TMP/induction.rt.json"; then
  ok "blueprint.json survives a read/write round trip"
else
  bad "blueprint.json survives a read/write round trip"
  diff "$TMP/induction.json" "$TMP/induction.rt.json" | head -20
fi

head_ "examples/induction: Lean facts"
if "$BP" check --root examples/induction --lean > "$TMP/induction.lean" 2>&1; then
  ok "check --lean exits 0"
else
  bad "check --lean exits 0"; cat "$TMP/induction.lean"
fi
for code in declared-not-actual actual-not-declared; do
  if grep -q "\[$code\]" "$TMP/induction.lean"; then
    ok "check --lean reports $code"
  else
    bad "check --lean reports $code"
  fi
done
# `main-theorem -> compactness` is declared but Lean only reaches
# `Topology.compactness` through `Induction.keyProp`, where the dependency
# walk stops; `compactness-lemma` is mapped by the attribute alone and its
# Lean dependencies are not declared anywhere.
for want in \
  "'uses' edge main-theorem -> compactness is declared" \
  "'compactness-lemma' depends on 'notation'"
do
  if grep -qF "$want" "$TMP/induction.lean"; then
    ok "check --lean says: $want"
  else
    bad "check --lean says: $want"
  fi
done

# ----------------------------------------------------------------- extract
head_ "blueprint extract"

if "$BP" extract BlueprintExamples --root examples/induction \
     --out "$TMP/facts.json" > "$TMP/extract.log" 2>&1; then
  ok "extract exits 0"
else
  bad "extract exits 0"; cat "$TMP/extract.log"
fi

if [ -s "$TMP/facts.json" ] && grep -q '"version": 1' "$TMP/facts.json" \
   && grep -q '"attrMap"' "$TMP/facts.json" && grep -q '"decls"' "$TMP/facts.json"; then
  ok "extract produced a version 1 lean-facts document"
else
  bad "extract produced a version 1 lean-facts document"
fi

if cmp -s "$TMP/facts.json" examples/induction/lean-facts.json; then
  ok "examples/induction/lean-facts.json is what the extractor produces"
else
  bad "examples/induction/lean-facts.json is what the extractor produces"
  diff "$TMP/facts.json" examples/induction/lean-facts.json | head -20
fi

"$BP" extract BlueprintExamples --root examples/induction \
  --out "$TMP/facts.again.json" > /dev/null 2>&1
if cmp -s "$TMP/facts.json" "$TMP/facts.again.json"; then
  ok "extract is deterministic"
else
  bad "extract is deterministic"
fi

# Without `--root` the working directory is the root: run from inside the
# example, a bare `extract` takes its modules from `blueprint.toml` and the
# lean names from its sources, as `--root` does.
(cd examples/induction && "$BP" extract --out "$TMP/facts.cwd.json") \
  > "$TMP/extract.cwd.log" 2>&1
if cmp -s "$TMP/facts.json" "$TMP/facts.cwd.json"; then
  ok "extract defaults the root to the working directory"
else
  bad "extract defaults the root to the working directory"; cat "$TMP/extract.cwd.log"
fi

# One status of each kind, including the two that only the extractor can
# tell apart: a custom axiom and a `sorry`.
wants "$TMP/facts.json" \
  '"Topology.dim": {"valueDeps": [], "typeDeps": [], "status": "proved",' \
  '"Topology.compactness": {"valueDeps": [], "typeDeps": [], "status": "proved",' \
  '"status": "proved_with_axioms", "signature": "theorem Topology.compactnessLemma' \
  '"status": "proved", "signature": "theorem Induction.keyProp' \
  '"status": "stated", "signature": "theorem Induction.mainTheorem'

# Deps split into what the type needs and what the value needs: `keyProp`
# mentions `compactness` in its statement, `mainTheorem` needs `keyProp`
# only in its proof.
wants "$TMP/facts.json" \
  '"Induction.mainTheorem": {"valueDeps": ["Induction.keyProp"], "typeDeps": [],' \
  '"Induction.keyProp": {"valueDeps": ["Topology.compactness"], "typeDeps": ["Topology.compactness"],'

# Deps stop at mapped constants: `mainTheorem` reaches `Topology.compactness`
# only through `keyProp`, so it is not among its deps; `compactnessLemma`
# reaches `dim` through the unmapped axiom `coverChoice`, so it is.
wants "$TMP/facts.json" \
  '"deps": ["Induction.keyProp"], "axioms": ["sorryAx"]}' \
  '"deps": ["Topology.compactness", "Topology.dim"], "axioms": ["Topology.coverChoice"]}' \
  '"deps": ["Topology.compactness"], "axioms": []}' \
  '"kind": "theorem"' \
  '"kind": "definition"' \
  '"file": "BlueprintExamples/Topology.lean"'

# Both directions of the mapping, and the deliberate overlap: the text of
# `main-theorem.md` and the attribute name the same constant.
wants "$TMP/facts.json" \
  '"attrMap": {"Topology.dim": "notation", "Topology.compactnessLemma": "compactness-lemma", "Induction.mainTheorem": "main-theorem"}'

"$BP" build --root examples/induction -o "$TMP/ind.facts.json" > /dev/null 2>&1
wants "$TMP/ind.facts.json" \
  '"main-theorem": "stated"' \
  '"notation": "proved"' \
  '"compactness-lemma": "proved_with_axioms"' \
  '"key-prop": "proved"'

# With proofs, the statement's uses are held against the type and the
# proof's against the value.  `main-theorem` declares `key-prop`, which Lean
# needs only in the proof; `key-prop`'s proof declares `compactness`, which
# Lean already needs to state it.
head_ "check --lean: statements against types, proofs against values"
rm -rf "$TMP/split"
cp -r examples/induction "$TMP/split"
cp "$TMP/facts.json" "$TMP/split/lean-facts.json"
printf '+++\nkind = "proof"\nof   = "main-theorem"\n+++\nBy [key-prop].\n' \
  > "$TMP/split/blueprint/induction/main-theorem.proof.md"
printf '+++\nkind = "proof"\nof   = "key-prop"\nuses = ["compactness"]\n+++\nImmediate.\n' \
  > "$TMP/split/blueprint/induction/key-prop.proof.md"
sed -i '/^uses   = \["compactness"\]$/d' "$TMP/split/blueprint/induction/key-prop.md"
"$BP" check --root "$TMP/split" --lean > "$TMP/split.check" 2>&1
if grep -q "\[use-belongs-to-proof\].*main-theorem -> key-prop" "$TMP/split.check"; then
  ok "a use Lean needs only in the proof, declared on the statement"
else
  bad "a use Lean needs only in the proof, declared on the statement"; cat "$TMP/split.check"
fi
if grep -q "\[use-belongs-to-statement\].*proof/key-prop -> compactness" "$TMP/split.check"; then
  ok "a use Lean needs to state the theorem, declared on the proof"
else
  bad "a use Lean needs to state the theorem, declared on the proof"; cat "$TMP/split.check"
fi
if grep -q "\[actual-not-declared\].*'key-prop' depends on 'compactness'" "$TMP/split.check"; then
  bad "a use on the wrong half is not also reported missing"
else
  ok "a use on the wrong half is not also reported missing"
fi

# `migrate`: a `## Proof` section becomes a proof file, and a use
# Lean needs only in the proof follows it there.  The promoted edge file is
# removed so that `key-prop` is a plain sugar use of `main-theorem`.
head_ "blueprint migrate"
rm -rf "$TMP/mig"
cp -r examples/induction "$TMP/mig"
rm "$TMP/mig/lean-facts.json" "$TMP/mig/blueprint/induction/main-uses-key.md"
printf '\n## Proof\n\nBy [key-prop].\n\n## Remark\n\nSharp.\n' \
  >> "$TMP/mig/blueprint/induction/main-theorem.md"
# A restatement with a proof of its own, and a proof opened by an inline
# marker rather than a heading.
printf '\n## Proof\n\nShort.\n\n## Detailed form\n\nMore precisely, it is.\n\n## Proof\n\nLong.\n' \
  >> "$TMP/mig/blueprint/induction/key-prop.md"
printf '\n*Proof.* By definition.\n' >> "$TMP/mig/blueprint/induction/base-case.md"
printf '+++\nkind = "remark"\n+++\nThe base case is trivial.\n\n## Proof\n\nThere is nothing in it.\n' \
  > "$TMP/mig/blueprint/induction/base-remark.md"
# A section that is the sketch of a proposition, with a proof and a detail.
mkdir -p "$TMP/mig/blueprint/induction/sketchy"
printf '+++\nid    = "sk-prop"\nkind  = "section"\ntitle = "Sketched"\n+++\n*Proposition (sketch).*\n\nEverything holds.\n\n## Proof\n\nBy [sk-detail].\n' \
  > "$TMP/mig/blueprint/induction/sketchy/_section.md"
printf '+++\nkind  = "lemma"\ntitle = "Detail"\n+++\nA detail.\n' \
  > "$TMP/mig/blueprint/induction/sketchy/sk-detail.md"
# The review's cases: a string-valued key and an escaped array value next to
# the keys the migration rewrites; a marker with text on its line; a lead-in
# with text on its line; a `#` line in fenced code inside a proof.
mkdir -p "$TMP/mig/blueprint/induction/sketchy2"
printf '+++\nid    = "sk-two"\nkind  = "section"\ntags  = "draft"\nuses  = ["key-prop"]\nowner = "a\\\\b"\n+++\n*Lemma (sketch).* All of\nthis holds.\n\n*Proof sketch.* Easy\nenough.\n\n```\n# not a heading\n```\n\nDone.\n' \
  > "$TMP/mig/blueprint/induction/sketchy2/_section.md"
"$BP" migrate --root "$TMP/mig" > "$TMP/mig.1" 2>&1
MP="$TMP/mig/blueprint/induction/main-theorem.proof.md"
KP="$TMP/mig/blueprint/induction/key-prop"
if [ "$(cat "$KP.proof.md")" = "$(printf '+++\nkind  = "proof"\nof    = "key-prop"\norder = 1\n+++\nShort.')" ] \
   && grep -q '^id    = "proof/key-prop/2"$' "$KP.proof-2.md" \
   && grep -q '^title = "of the detailed form"$' "$KP.proof-2.md" \
   && grep -q '^order = 2$' "$KP.proof-2.md" && grep -q '^Long\.$' "$KP.proof-2.md" \
   && grep -q '^## Detailed form$' "$KP.md" && ! grep -q 'Proof' "$KP.md"; then
  ok "every proof of a body gets a file, the restatement's titled after it"
else
  bad "every proof of a body gets a file, the restatement's titled after it"; cat "$TMP/mig.1" "$KP".*
fi
SK="$TMP/mig/blueprint/induction/sketchy"
if grep -q 'turned 2 sketch' "$TMP/mig.1" && grep -q '^kind  = "proposition"$' "$SK/_section.md" \
   && grep -q '^tags = \["sketch"\]$' "$SK/_section.md" && ! grep -q 'sketch)' "$SK/_section.md" \
   && grep -q '^Everything holds\.$' "$SK/_section.md" && grep -q '^of    = "sk-prop"$' "$SK/sk-prop.proof.md" \
   && "$BP" build --root "$TMP/mig" -o "$TMP/mig.json" > /dev/null 2>&1 \
   && grep -q '"id": "refines/sk-detail/sk-prop"' "$TMP/mig.json"; then
  ok "a sketch section becomes its statement, keeps its details, and its proof is split off"
else
  bad "a sketch section becomes its statement, keeps its details, and its proof is split off"; cat "$TMP/mig.1" "$SK/_section.md"
fi
SK2="$TMP/mig/blueprint/induction/sketchy2"
if grep -q '^tags  = \["draft", "sketch"\]$' "$SK2/_section.md" \
   && grep -q '^uses  = \["key-prop"\]$' "$SK2/_section.md" \
   && [ "$(awk 'n >= 2; /^[+][+][+]$/ { n++ }' "$SK2/_section.md")" = "$(printf 'All of\nthis holds.')" ] \
   && grep -q '^title = "sketch"$' "$SK2/sk-two.proof.md" \
   && [ "$(awk 'n >= 2; /^[+][+][+]$/ { n++ }' "$SK2/sk-two.proof.md" | head -3)" = "$(printf 'Easy\nenough.\n')" ] \
   && grep -q '^# not a heading$' "$SK2/sk-two.proof.md" && grep -q '^Done\.$' "$SK2/sk-two.proof.md"; then
  ok "string keys, lead-ins and markers with text, and fenced code survive the migration"
else
  bad "string keys, lead-ins and markers with text, and fenced code survive the migration"; cat "$SK2"/*
fi
if grep -q '^By definition\.$' "$TMP/mig/blueprint/induction/base-case.proof.md" \
   && ! grep -q 'Proof' "$TMP/mig/blueprint/induction/base-case.md"; then
  ok "an inline *Proof.* marker opens a proof too"
else
  bad "an inline *Proof.* marker opens a proof too"; cat "$TMP/mig.1"
fi
if grep -q '^of    = "base-remark"$' "$TMP/mig/blueprint/induction/base-remark.proof.md" \
   && ! grep -q 'Proof' "$TMP/mig/blueprint/induction/base-remark.md"; then
  ok "a remark's proof is split off too"
else
  bad "a remark's proof is split off too"; cat "$TMP/mig.1"
fi
if grep -q 'split 7 proof' "$TMP/mig.1" && grep -q '^of    = "main-theorem"$' "$MP" \
   && grep -q '^By \[key-prop\]\.$' "$MP" && ! grep -q '^uses' "$MP" \
   && ! grep -q 'Proof' "$TMP/mig/blueprint/induction/main-theorem.md" \
   && grep -q '^Sharp\.$' "$TMP/mig/blueprint/induction/main-theorem.md"; then
  ok "without facts, the proof moves to a file of its own and every use stays"
else
  bad "without facts, the proof moves to a file of its own and every use stays"; cat "$TMP/mig.1" "$MP"
fi
cp "$TMP/facts.json" "$TMP/mig/lean-facts.json"
"$BP" migrate --root "$TMP/mig" > "$TMP/mig.2" 2>&1
if grep -q 'moved 1 use' "$TMP/mig.2" && grep -q '^uses = \["key-prop"\]$' "$MP" \
   && grep -q '^uses   = \["compactness"\]$' "$TMP/mig/blueprint/induction/main-theorem.md"; then
  ok "with split facts, a use Lean needs only in the proof moves to it"
else
  bad "with split facts, a use Lean needs only in the proof moves to it"; cat "$TMP/mig.2" "$MP"
fi
# A body that gains a further proof after an earlier run: numbered after the
# proof already there, which is given an order so that it stays first.
printf '\n## Claim\n\nAlso this.\n\n*Proof.* Clear.\n' >> "$TMP/mig/blueprint/induction/main-theorem.md"
"$BP" migrate --root "$TMP/mig" > "$TMP/mig.25" 2>&1
if grep -q '^id    = "proof/main-theorem/2"$' "$TMP/mig/blueprint/induction/main-theorem.proof-2.md" \
   && grep -q '^title = "of the claim"$' "$TMP/mig/blueprint/induction/main-theorem.proof-2.md" \
   && grep -q '^order = 1$' "$MP" && grep -q '^## Claim$' "$TMP/mig/blueprint/induction/main-theorem.md"; then
  ok "a proof found later is numbered after the one split off before"
else
  bad "a proof found later is numbered after the one split off before"; cat "$TMP/mig.25" "$MP"
fi
"$BP" migrate --root "$TMP/mig" > "$TMP/mig.3" 2>&1
if grep -q 'turned 0 sketch.*split 0 proof.*moved 0 use' "$TMP/mig.3"; then
  ok "migrating again changes nothing"
else
  bad "migrating again changes nothing"; cat "$TMP/mig.3"
fi

head_ "blueprint extract: the other ways in"

# No modules on the command line: they come from `[lean] modules`.
if "$BP" extract --root examples/induction --out "$TMP/facts.toml.json" > /dev/null 2>&1 \
   && cmp -s "$TMP/facts.toml.json" "$TMP/facts.json"; then
  ok "modules default to '[lean] modules' of blueprint.toml"
else
  bad "modules default to '[lean] modules' of blueprint.toml"
fi

# Names from a snapshot rather than from the sources.
"$BP" extract BlueprintExamples --snapshot "$TMP/induction.json" \
  --out "$TMP/facts.snap.json" > /dev/null 2>&1
wants "$TMP/facts.snap.json" \
  '"status": "proved", "signature": "theorem Induction.keyProp' \
  '"status": "proved", "signature": "def Topology.compactness'

# Names from --names, including one that does not exist.
"$BP" extract BlueprintExamples --names "Induction.keyProp,Nowhere.atAll" \
  --out "$TMP/facts.names.json" > /dev/null 2>&1
wants "$TMP/facts.names.json" \
  '"Nowhere.atAll": {"exists": false}' \
  '"status": "proved", "signature": "theorem Induction.keyProp'

# The dependency walk stays inside the project.  `Induction.Decomposable` is
# `X.points ≤ 1`: it names `LE.le` itself, and reaches `Nat.le` only through
# core's `instLENat`, so with both mapped its deps are `LE.le` alone.  Letting
# the walk descend into `Init` as well brings `Nat.le` back.
"$BP" extract BlueprintExamples --names "Induction.Decomposable,LE.le,Nat.le" \
  --out "$TMP/facts.walk.json" > /dev/null 2>&1
wants "$TMP/facts.walk.json" '"deps": ["LE.le"], "axioms": []'
"$BP" extract BlueprintExamples --names "Induction.Decomposable,LE.le,Nat.le" \
  --descend "BlueprintExamples,Init" --out "$TMP/facts.descend.json" > /dev/null 2>&1
wants "$TMP/facts.descend.json" '"deps": ["LE.le", "Nat.le"], "axioms": []'

# The attribute survives `import`: BlueprintExamples.Induction imports
# BlueprintExamples.Topology, and the tags of the latter must still be there.
"$BP" extract BlueprintExamples.Induction --out "$TMP/facts.import.json" > /dev/null 2>&1
wants "$TMP/facts.import.json" \
  '"attrMap": {"Topology.dim": "notation", "Topology.compactnessLemma": "compactness-lemma", "Induction.mainTheorem": "main-theorem"}'

# Nothing to import and nothing configured.
"$BP" extract --root examples/minimal --out "$TMP/facts.none.json" > /dev/null 2>&1
if [ $? -eq 1 ] && [ ! -f "$TMP/facts.none.json" ]; then
  ok "extract with no modules exits 1"
else
  bad "extract with no modules exits 1"
fi

head_ "check --lean against a stale attrMap"
rm -rf "$TMP/stale"
cp -r examples/induction "$TMP/stale"
sed 's/"notation"/"no-such-object"/' examples/induction/lean-facts.json \
  > "$TMP/stale/lean-facts.json"
"$BP" check --root "$TMP/stale" --lean > "$TMP/stale.check" 2>&1
status=$?
if [ "$status" -eq 1 ] && grep -q 'error: \[dangling-ref\]' "$TMP/stale.check"; then
  ok "a @[blueprint] tag naming no object is a dangling-ref error"
else
  bad "a @[blueprint] tag naming no object is a dangling-ref error (exit $status)"
  cat "$TMP/stale.check"
fi

# ------------------------------------------------------------------ broken
head_ "examples/broken"
"$BP" check --root examples/broken --lean > "$TMP/broken.check" 2>&1
status=$?
if [ "$status" -eq 1 ]; then
  ok "check exits 1"
else
  bad "check exits 1 (got $status)"
fi

for code in unknown-kind unknown-attr bad-boundary boundary-cycle dangling-ref \
            constraint-acyclic constraint-unique duplicate-id missing-lean
do
  if grep -q "error: \[$code\]" "$TMP/broken.check"; then
    ok "reports $code"
  else
    bad "reports $code"
  fi
done
if grep -q "warning: \[bad-link\]" "$TMP/broken.check"; then
  ok "reports bad-link"
else
  bad "reports bad-link"
fi

"$BP" build --root examples/broken -o "$TMP/broken.json" > /dev/null 2>&1
status=$?
if [ "$status" -eq 1 ] && [ -s "$TMP/broken.json" ]; then
  ok "build exits 1 but still writes a snapshot"
else
  bad "build exits 1 but still writes a snapshot (got $status)"
fi

# `Broken.nope` is named by the blueprint and deliberately never declared in
# `BlueprintExamples`, so the extractor is what proves it missing.
if "$BP" extract --root examples/broken --out "$TMP/broken.facts.json" > /dev/null 2>&1 \
   && cmp -s "$TMP/broken.facts.json" examples/broken/lean-facts.json; then
  ok "examples/broken/lean-facts.json is what the extractor produces"
else
  bad "examples/broken/lean-facts.json is what the extractor produces"
  diff "$TMP/broken.facts.json" examples/broken/lean-facts.json | head -10
fi
wants "$TMP/broken.facts.json" '"decls": {"Broken.nope": {"exists": false}}'

# ------------------------------------------------------------ import-latex
head_ "blueprint import-latex"
# A proof after an environment read as a remark (here `example`) is a proof
# file too.
mkdir -p "$TMP/lirem"
printf '\\chapter{One}\n\\section{Two}\n\\begin{example}\\label{ex:a}\nA claim.\n\\end{example}\n\\begin{proof}\nClear.\n\\end{proof}\n' \
  > "$TMP/lirem/in.tex"
"$BP" import-latex "$TMP/lirem/in.tex" --out "$TMP/lirem/out/blueprint" > /dev/null 2>&1
if grep -q '^of = "ex-a"$' "$TMP/lirem/out/blueprint/one/two/ex-a.proof.md" \
   && grep -q '^kind = "remark"$' "$TMP/lirem/out/blueprint/one/two/ex-a.md" \
   && ! grep -q 'Proof' "$TMP/lirem/out/blueprint/one/two/ex-a.md"; then
  ok "a proof after an example is a proof file of its own"
else
  bad "a proof after an example is a proof file of its own"; cat "$TMP/lirem/in.tex"; find "$TMP/lirem/out"
fi

rm -rf "$TMP/li"
if "$BP" import-latex examples/latex-import/src/content.tex --out "$TMP/li/blueprint" \
     --toml "$TMP/li/blueprint.toml" --report "$TMP/li/report.txt" \
     > "$TMP/li.log" 2>&1; then
  ok "import-latex exits 0"
else
  bad "import-latex exits 0"; cat "$TMP/li.log"
fi

if diff -r "$TMP/li" examples/latex-import/expected > "$TMP/li.diff" 2>&1; then
  ok "the import is examples/latex-import/expected"
else
  bad "the import is examples/latex-import/expected"; head -40 "$TMP/li.diff"
fi

if grep -q "wrote 11 file(s)" "$TMP/li.log" \
   && grep -q '3 uses edges' "$TMP/li.log" \
   && grep -q '1 unresolved uses' "$TMP/li.log"; then
  ok "import-latex summarises what it wrote"
else
  bad "import-latex summarises what it wrote"; cat "$TMP/li.log"
fi

if "$BP" check --root "$TMP/li" > "$TMP/li.check" 2>&1 \
   && grep -q '0 error(s)' "$TMP/li.check"; then
  ok "check on the imported blueprint has no errors"
else
  bad "check on the imported blueprint has no errors"; cat "$TMP/li.check"
fi

# a second import over the same directory must not change a byte
"$BP" import-latex examples/latex-import/src/content.tex --out "$TMP/li/blueprint" \
  --toml "$TMP/li/blueprint.toml" --report "$TMP/li/report.txt" --clean \
  > /dev/null 2>&1
if diff -r "$TMP/li" examples/latex-import/expected > /dev/null 2>&1; then
  ok "re-importing is idempotent"
else
  bad "re-importing is idempotent"
fi

if "$BP" build --root "$TMP/li" -o "$TMP/li.json" > /dev/null 2>&1; then
  wants "$TMP/li.json" '"katexMacros"' '"\\Spec": "\\operatorname{Spec}"' \
        '"\\colim": "\\operatorname*{colim}"'
else
  bad "build of the imported blueprint"
fi

# `[site] theme` reaches the snapshot as `project.theme`, and is left out
# when the project names none
cp -r examples/minimal "$TMP/themed"
printf '\n[site]\ntheme = "outline"\n' >> "$TMP/themed/blueprint.toml"
if "$BP" build --root "$TMP/themed" -o "$TMP/themed.json" > /dev/null 2>&1 \
   && grep -q '"theme": "outline"' "$TMP/themed.json" \
   && "$BP" build --root examples/minimal -o "$TMP/unthemed.json" > /dev/null 2>&1 \
   && ! grep -q '"theme"' "$TMP/unthemed.json"; then
  ok "[site] theme reaches the snapshot, and only when given"
else
  bad "[site] theme reaches the snapshot, and only when given"
fi
cp -r examples/minimal "$TMP/badtheme"
printf '\n[site]\ntheme = 3\n' >> "$TMP/badtheme/blueprint.toml"
if ! "$BP" build --root "$TMP/badtheme" -o "$TMP/badtheme.json" > "$TMP/badtheme.out" 2>&1 \
   && grep -q "'\[site\] theme' must be a string" "$TMP/badtheme.out"; then
  ok "a [site] theme that is not a string is refused"
else
  bad "a [site] theme that is not a string is refused"; cat "$TMP/badtheme.out"
fi

# `[site.intro]` reaches the snapshot as `project.intro`, its body inline or
# read from a file, with its duration in milliseconds; `[site] assets` is
# copied into the site as `assets/`
cp -r examples/minimal "$TMP/intro"
mkdir -p "$TMP/intro/pictures/sub"
printf 'png' > "$TMP/intro/pictures/logo.png"
printf 'svg' > "$TMP/intro/pictures/sub/mark.svg"
printf '# Welcome\n\n![logo](assets/logo.png)\n' > "$TMP/intro/intro.md"
printf '\n[site]\nassets = "pictures"\n\n[site.intro]\nfile = "intro.md"\nduration = 2.5\n' \
  >> "$TMP/intro/blueprint.toml"
if "$BP" site --root "$TMP/intro" -o "$TMP/intro.site" > "$TMP/intro.out" 2>&1 \
   && grep -q '"body": "# Welcome\\n\\n!\[logo\](assets/logo.png)\\n"' "$TMP/intro.site/blueprint.json" \
   && grep -q '"durationMs": 2500' "$TMP/intro.site/blueprint.json" \
   && [ "$(cat "$TMP/intro.site/assets/logo.png")" = png ] \
   && [ "$(cat "$TMP/intro.site/assets/sub/mark.svg")" = svg ] \
   && [ -f "$TMP/intro.site/intro.js" ] \
   && ! grep -q '"intro"' "$TMP/unthemed.json"; then
  ok "[site.intro] reaches the snapshot, and [site] assets the site"
else
  bad "[site.intro] reaches the snapshot, and [site] assets the site"
  cat "$TMP/intro.out"; grep -A2 '"intro"' "$TMP/intro.site/blueprint.json"
fi
cp -r examples/minimal "$TMP/introbody"
printf '\n[site.intro]\nbody = """\nHello $x$\n"""\n' >> "$TMP/introbody/blueprint.toml"
if "$BP" build --root "$TMP/introbody" -o "$TMP/introbody.json" > /dev/null 2>&1 \
   && grep -q '"body": "Hello \$x\$\\n"' "$TMP/introbody.json" \
   && ! grep -q '"durationMs"' "$TMP/introbody.json"; then
  ok "[site.intro] body is the intro, with the website's default duration"
else
  bad "[site.intro] body is the intro, with the website's default duration"
  grep -A2 '"intro"' "$TMP/introbody.json"
fi
for bad_intro in 'file = "nowhere.md"|no .*nowhere.md' \
                 'body = "x"\nfile = "intro.md"|not both' \
                 'duration = 3|needs a .body' \
                 'body = "x"\nduration = 0|must be positive' \
                 'body = "x"\nduration = "3s"|must be a number of seconds'; do
  conf="${bad_intro%%|*}"; want="${bad_intro#*|}"
  rm -rf "$TMP/badintro"; cp -r examples/minimal "$TMP/badintro"
  printf "\n[site.intro]\n$conf\n" >> "$TMP/badintro/blueprint.toml"
  if ! "$BP" build --root "$TMP/badintro" -o "$TMP/badintro.json" > "$TMP/badintro.out" 2>&1 \
     && grep -q "$want" "$TMP/badintro.out"; then
    ok "a [site.intro] with $(printf "$conf" | tr '\n' ' ') is refused"
  else
    bad "a [site.intro] with $(printf "$conf" | tr '\n' ' ') is refused"; cat "$TMP/badintro.out"
  fi
done
rm -rf "$TMP/badassets"; cp -r examples/minimal "$TMP/badassets"
printf '\n[site]\nassets = "nowhere"\n' >> "$TMP/badassets/blueprint.toml"
if ! "$BP" site --root "$TMP/badassets" -o "$TMP/badassets.site" > "$TMP/badassets.out" 2>&1 \
   && grep -q "is not a directory" "$TMP/badassets.out"; then
  ok "a [site] assets that is not a directory is refused"
else
  bad "a [site] assets that is not a directory is refused"; cat "$TMP/badassets.out"
fi

# unresolved `\uses` must not become an edge, and must be visible in the body
# it was written in: here the proof, which is a file of its own
if grep -q 'Unresolved dependencies: lem:nowhere' \
     "$TMP/li/blueprint/the-main-theorem/sec-statement/thm-main.proof.md" \
   && ! grep -q '"id": "uses/thm-main/lem:nowhere"' "$TMP/li.json" \
   && ! grep -q '"id": "uses/proof~thm-main/lem:nowhere"' "$TMP/li.json" \
   && ! grep -q '"id": "lem:nowhere"' "$TMP/li.json"; then
  ok "an unresolved \\uses is reported but never an edge"
else
  bad "an unresolved \\uses is reported but never an edge"
fi

# ------------------------------------------------------------- new / rename
head_ "new and rename"
cp -r examples/minimal "$TMP/scratch"
if "$BP" new theorem add-left-cancel --root "$TMP/scratch" > /dev/null 2>&1 \
   && [ -f "$TMP/scratch/blueprint/add-left-cancel.md" ]; then
  ok "new scaffolds a file"
else
  bad "new scaffolds a file"
fi
if "$BP" rename add plus --root "$TMP/scratch" > /dev/null 2>&1 \
   && grep -q 'uses   = \["plus"\]' "$TMP/scratch/blueprint/add-comm.md" \
   && grep -q 'unfolding \[plus\]' "$TMP/scratch/blueprint/add-comm.proof.md" \
   && grep -q 'aliases' "$TMP/scratch/blueprint/add.md"; then
  ok "rename rewrites front matter, links and records an alias"
else
  bad "rename rewrites front matter, links and records an alias"
fi
if "$BP" check --root "$TMP/scratch" > /dev/null 2>&1; then
  ok "the renamed project still checks out"
else
  bad "the renamed project still checks out"
fi

# ------------------------------------------------------------------- diff
# Two copies of examples/induction, one of them edited, exercise every
# category of the semantic diff at once: a renamed object (through the alias
# `blueprint rename` records), an added one, a removed one, and a derived
# status that fell back from proved to stated.
head_ "blueprint diff: file against file"
rm -rf "$TMP/dA" "$TMP/dB"
cp -r examples/induction "$TMP/dA"
cp -r examples/induction "$TMP/dB"
"$BP" rename base-case first-step --root "$TMP/dB" > /dev/null 2>&1
"$BP" new theorem brand-new --dir induction --root "$TMP/dB" > /dev/null 2>&1
rm "$TMP/dB/blueprint/induction/inductive-step.md"
# `Induction.keyProp` loses its proof: the status-regression case.
perl -0pi -e 's/("Induction\.keyProp":\s*\{[^{}]*?"status": ")proved/${1}stated/' \
  "$TMP/dB/lean-facts.json"
"$BP" build --root "$TMP/dA" -o "$TMP/dA.json" > /dev/null 2>&1
"$BP" build --root "$TMP/dB" -o "$TMP/dB.json" > /dev/null 2>&1

"$BP" diff "$TMP/dA.json" "$TMP/dB.json" > "$TMP/diff.txt" 2>&1
status=$?
if [ "$status" -eq 1 ]; then
  ok "diff exits 1 on a status regression"
else
  bad "diff exits 1 on a status regression (got $status)"; cat "$TMP/diff.txt"
fi
for want in \
  '+ brand-new  [theorem]' \
  '- inductive-step  [lemma]' \
  '~ base-case -> first-step' \
  '! key-prop  proved -> stated' \
  'error: [status-regression]' \
  'summary: '
do
  if grep -qF -- "$want" "$TMP/diff.txt"; then
    ok "diff reports $want"
  else
    bad "diff reports $want"; cat "$TMP/diff.txt"
  fi
done
if grep -qE '^summary: .*proved 2/6 -> 1/6$' "$TMP/diff.txt"; then
  ok "diff counts proved/total before and after"
else
  bad "diff counts proved/total before and after"; grep '^summary' "$TMP/diff.txt"
fi

if "$BP" diff "$TMP/dA.json" "$TMP/dB.json" --no-fail > /dev/null 2>&1; then
  ok "diff --no-fail exits 0"
else
  bad "diff --no-fail exits 0"
fi

"$BP" diff "$TMP/dA.json" "$TMP/dB.json" --json --no-fail > "$TMP/diff.json" 2>/dev/null
wants "$TMP/diff.json" \
  '"code": "status-regression"' \
  '"regression": true' \
  '"renamed":' \
  '"from": "base-case"' \
  '"to": "first-step"' \
  '"kind": "file"'

# A snapshot diffed against itself says so.
"$BP" diff "$TMP/dA.json" "$TMP/dA.json" > "$TMP/diff.same" 2>&1
if [ $? -eq 0 ] && grep -q '^no changes$' "$TMP/diff.same"; then
  ok "a snapshot does not differ from itself"
else
  bad "a snapshot does not differ from itself"; cat "$TMP/diff.same"
fi

# ---------------------------------------------------- diff / log over git
# A throwaway repository in the temporary directory, never the project's own.
head_ "blueprint diff, log and progress over git history"
REPO="$TMP/repo"
rm -rf "$REPO"
mkdir -p "$REPO"
cp -r examples/induction/. "$REPO/"
git init -q -b main "$REPO"
git -C "$REPO" config user.email blueprint@example.invalid
git -C "$REPO" config user.name "Blueprint tests"
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" add -A
git -C "$REPO" commit -qm "initial blueprint"
sed -i 's/Key proposition/Key proposition, sharpened/' "$REPO/blueprint/induction/key-prop.md"
git -C "$REPO" commit -qam "sharpen the key proposition"
"$BP" rename base-case first-step --root "$REPO" > /dev/null 2>&1
git -C "$REPO" commit -qam "rename base-case to first-step"

if "$BP" diff HEAD~2 HEAD --root "$REPO" > "$TMP/gitdiff.txt" 2>&1; then
  ok "diff between two revisions exits 0"
else
  bad "diff between two revisions exits 0"; cat "$TMP/gitdiff.txt"
fi
for want in \
  '~ base-case -> first-step' \
  '! key-prop  title: "Key proposition" -> "Key proposition, sharpened"' \
  '+ uses/first-step/compactness  [uses]'
do
  if grep -qF -- "$want" "$TMP/gitdiff.txt"; then
    ok "diff of revisions reports $want"
  else
    bad "diff of revisions reports $want"; cat "$TMP/gitdiff.txt"
  fi
done

# A snapshot file on one side and a revision on the other.
if "$BP" diff HEAD "$TMP/dA.json" --root "$REPO" --no-fail > "$TMP/mixed.txt" 2>&1 \
   && grep -q '^summary: ' "$TMP/mixed.txt"; then
  ok "diff mixes a revision and a file"
else
  bad "diff mixes a revision and a file"; cat "$TMP/mixed.txt"
fi

"$BP" diff no-such-rev HEAD --root "$REPO" > "$TMP/badrev.txt" 2>&1
if [ $? -eq 1 ] && grep -q "neither a file nor a revision" "$TMP/badrev.txt"; then
  ok "an argument that is neither a file nor a revision is an error"
else
  bad "an argument that is neither a file nor a revision is an error"
  cat "$TMP/badrev.txt"
fi

"$BP" log first-step --root "$REPO" > "$TMP/log.txt" 2>&1
if [ $? -eq 0 ] && grep -q 'renamed: base-case -> first-step' "$TMP/log.txt" \
   && grep -q '+ added' "$TMP/log.txt"; then
  ok "log follows an object backwards through its rename"
else
  bad "log follows an object backwards through its rename"; cat "$TMP/log.txt"
fi

"$BP" log key-prop --root "$REPO" --limit 1 > "$TMP/log1.txt" 2>&1
if grep -q 'stopped at --limit 1' "$TMP/log1.txt" \
   && grep -qF 'title: "Key proposition" -> "Key proposition, sharpened"' "$TMP/log1.txt"; then
  ok "log honours --limit and reports what a commit changed"
else
  bad "log honours --limit and reports what a commit changed"; cat "$TMP/log1.txt"
fi

if "$BP" log no-such-object --root "$REPO" > "$TMP/log2.txt" 2>&1; then
  bad "log of an unknown id exits 1"
else
  ok "log of an unknown id exits 1"
fi

"$BP" progress --root "$REPO" > "$TMP/prog.txt" 2>&1
if [ $? -eq 0 ] && grep -q 'countable objects proved' "$TMP/prog.txt" \
   && grep -qE '^theorem\*' "$TMP/prog.txt"; then
  ok "progress prints status counts by kind"
else
  bad "progress prints status counts by kind"; cat "$TMP/prog.txt"
fi

"$BP" progress --root "$REPO" --since HEAD~2 > "$TMP/prog2.txt" 2>&1
if [ $? -eq 0 ] && grep -q '^since HEAD~2' "$TMP/prog2.txt" \
   && grep -q 'summary: ' "$TMP/prog2.txt"; then
  ok "progress --since compares against a revision"
else
  bad "progress --since compares against a revision"; cat "$TMP/prog2.txt"
fi

# ---------------------------------------------------------------- history
head_ "blueprint history add"
HIST="$TMP/history"
rm -rf "$HIST"
"$BP" history add "$TMP/dA.json" --dir "$HIST" --sha bbbb --date 2026-05-05 > /dev/null 2>&1
"$BP" history add "$TMP/dB.json" --dir "$HIST" --sha aaaa --date 2026-01-01 > /dev/null 2>&1
"$BP" history add "$TMP/dA.json" --dir "$HIST" --sha cccc --date 2026-09-09 > /dev/null 2>&1
if [ -f "$HIST/aaaa.json" ] && [ -f "$HIST/bbbb.json" ] && [ -f "$HIST/cccc.json" ]; then
  ok "history add copies each snapshot to <sha>.json"
else
  bad "history add copies each snapshot to <sha>.json"; ls "$HIST"
fi
order="$(grep -o '"sha": "[a-z]*"' "$HIST/index.json" | tr -d ' ' | tr '\n' ' ')"
if [ "$order" = '"sha":"aaaa" "sha":"bbbb" "sha":"cccc" ' ]; then
  ok "the index is sorted by date"
else
  bad "the index is sorted by date (got $order)"
fi
wants "$HIST/index.json" \
  '"file": "data/aaaa.json"' \
  '"proved": 1' \
  '"total": 6' \
  '"byStatus"'
"$BP" history add "$TMP/dA.json" --dir "$HIST" --sha bbbb --date 2026-05-05 > /dev/null 2>&1
if [ "$(grep -c '"sha"' "$HIST/index.json")" -eq 3 ]; then
  ok "adding the same sha twice does not duplicate it"
else
  bad "adding the same sha twice does not duplicate it"
  grep '"sha"' "$HIST/index.json"
fi
# Defaults: inside a repository the sha and date come from HEAD.
"$BP" build --root "$REPO" -o "$TMP/repo.json" > /dev/null 2>&1
"$BP" history add "$TMP/repo.json" --dir "$TMP/hist2" --root "$REPO" > "$TMP/hadd.txt" 2>&1
head_sha="$(git -C "$REPO" rev-parse HEAD)"
if [ -f "$TMP/hist2/$head_sha.json" ]; then
  ok "history add defaults to git rev-parse HEAD"
else
  bad "history add defaults to git rev-parse HEAD"; cat "$TMP/hadd.txt"
fi

# ------------------------------------------------------------------- site
head_ "blueprint site"
rm -rf "$TMP/site"
if "$BP" site --root examples/induction -o "$TMP/site" > "$TMP/site.log" 2>&1; then
  ok "site exits 0"
else
  bad "site exits 0"; cat "$TMP/site.log"
fi
for f in index.html blueprint.json app.js model.js style.css; do
  if [ -s "$TMP/site/$f" ]; then
    ok "site wrote $f"
  else
    bad "site wrote $f"
  fi
done
if [ ! -e "$TMP/site/sample" ] && [ ! -e "$TMP/site/test" ] && [ ! -e "$TMP/site/README.md" ]; then
  ok "site leaves out the fixtures, the tests and the README"
else
  bad "site leaves out the fixtures, the tests and the README"; ls "$TMP/site"
fi
if grep -q '"version": 1' "$TMP/site/blueprint.json" \
   && grep -q '"main-theorem"' "$TMP/site/blueprint.json"; then
  ok "site's blueprint.json is the snapshot of the project"
else
  bad "site's blueprint.json is the snapshot of the project"
fi

# `BLUEPRINT_WEB_DIR` wins over everything else.
rm -rf "$TMP/site.env"
if BLUEPRINT_WEB_DIR="$ROOT/web" "$BP" site --root examples/induction \
     -o "$TMP/site.env" > "$TMP/site.env.log" 2>&1 \
   && grep -qF "from $ROOT/web" "$TMP/site.env.log"; then
  ok "BLUEPRINT_WEB_DIR selects the website"
else
  bad "BLUEPRINT_WEB_DIR selects the website"; cat "$TMP/site.env.log"
fi
if BLUEPRINT_WEB_DIR="$TMP" "$BP" site --root examples/induction \
     -o "$TMP/site.bad" > "$TMP/site.bad.log" 2>&1; then
  bad "a BLUEPRINT_WEB_DIR without index.html is an error"
else
  ok "a BLUEPRINT_WEB_DIR without index.html is an error"
fi

rm -rf "$TMP/site.hist"
"$BP" site --root "$REPO" -o "$TMP/site.hist" --history "$HIST" > "$TMP/site.hist.log" 2>&1
if [ -f "$TMP/site.hist/data/index.json" ] && [ -f "$TMP/site.hist/data/aaaa.json" ]; then
  ok "site --history copies the history to data/"
else
  bad "site --history copies the history to data/"; cat "$TMP/site.hist.log"
fi
if grep -qF '"file": "blueprint.json"' "$TMP/site.hist/data/index.json" \
   && [ "$(grep -c '"sha"' "$TMP/site.hist/data/index.json")" -eq 4 ]; then
  ok "site --history adds the current snapshot to the index"
else
  bad "site --history adds the current snapshot to the index"
  cat "$TMP/site.hist/data/index.json"
fi

# ------------------------------------------------------------------ serve
head_ "blueprint serve"
# There is no telling which static file server, if any, this machine has, so
# only the fallback is tested: with nothing on PATH, `serve` still assembles
# the site and then says what to run.
rm -rf "$TMP/serve"
env PATH=/nonexistent "$BP" serve --root examples/induction --site "$TMP/serve" \
  --port 9999 > "$TMP/serve.log" 2>&1
status=$?
if [ "$status" -eq 1 ] && grep -q 'no static file server found' "$TMP/serve.log" \
   && grep -q 'python3 -m http.server 9999' "$TMP/serve.log" \
   && grep -q 'busybox httpd -f -p 9999' "$TMP/serve.log"; then
  ok "serve falls back to instructions when no server is installed"
else
  bad "serve falls back to instructions when no server is installed (exit $status)"
  cat "$TMP/serve.log"
fi
if [ -s "$TMP/serve/index.html" ] && [ -s "$TMP/serve/blueprint.json" ]; then
  ok "serve refreshes the site before serving it"
else
  bad "serve refreshes the site before serving it"
fi

# ---------------------------------------------------------- web fixtures
head_ "web fixtures"
"$BP" build --root examples/induction --facts examples/induction/lean-facts.json \
  -o "$TMP/real.json" > /dev/null 2>&1
if cmp -s "$TMP/real.json" web/sample/real/blueprint.json; then
  ok "web/sample/real/blueprint.json is what 'build --facts' produces"
else
  bad "web/sample/real/blueprint.json is what 'build --facts' produces"
  diff "$TMP/real.json" web/sample/real/blueprint.json | head -10
fi

"$BP" build --root examples/paper -o "$TMP/paper.json" > /dev/null 2>&1
if cmp -s "$TMP/paper.json" web/sample/paper/blueprint.json; then
  ok "web/sample/paper/blueprint.json is what 'build --root examples/paper' produces"
else
  bad "web/sample/paper/blueprint.json is what 'build --root examples/paper' produces"
  diff "$TMP/paper.json" web/sample/paper/blueprint.json | head -10
fi

# ------------------------------------------------------------- PDF export
head_ "blueprint export"
if command -v node > /dev/null 2>&1; then
  # The committed samples are what the command writes: the whole blueprint, a
  # section with a lemma it shares with another, and a refined theorem.
  rm -rf "$TMP/export"
  for scope in "" products thm-fip; do
    "$BP" export --root examples/paper ${scope:+--scope "$scope"} --tex-only -o "$TMP/export" \
      > "$TMP/export.log" 2>&1 || { bad "export --tex-only ${scope:-(whole)}"; cat "$TMP/export.log"; }
  done
  for f in examples/paper/export/*.tex; do
    if cmp -s "$f" "$TMP/export/$(basename "$f")"; then
      ok "$f is what 'blueprint export' writes"
    else
      bad "$f is what 'blueprint export' writes"
      diff "$f" "$TMP/export/$(basename "$f")" | head -10
    fi
  done
  if cmp -s examples/paper/export/assets/*-cover.png examples/paper/blueprint/appendix/cover.png \
     && [ -s "$TMP/export/paper-whole-source.zip" ]; then
    ok "export packages the image a body names with the TeX"
  else
    bad "export packages the image a body names with the TeX"
  fi
  "$BP" export --root examples/paper --scope no-such-part --tex-only -o "$TMP/export" > "$TMP/export.bad" 2>&1
  status=$?
  if [ "$status" -eq 2 ] && grep -q "there is no object 'no-such-part'" "$TMP/export.bad"; then
    ok "export refuses a part that does not exist (exit 2)"
  else
    bad "export refuses a part that does not exist (exit $status)"; cat "$TMP/export.bad"
  fi
  "$BP" export --root examples/paper --scope proof/lem-tube --tex-only -o "$TMP/export" > "$TMP/export.bad" 2>&1
  status=$?
  if [ "$status" -eq 2 ] && grep -q "is read as part of 'lem-tube'" "$TMP/export.bad"; then
    ok "export says a proof is read with its statement (exit 2)"
  else
    bad "export says a proof is read with its statement (exit $status)"; cat "$TMP/export.bad"
  fi
  if "$BP" export --root examples/paper --list > "$TMP/export.list" 2>&1 \
     && grep -q "^refines	thm-fip	2.2.2	Compactness by closed sets	2 level(s)" "$TMP/export.list"; then
    ok "export --list lists the parts with their levels"
  else
    bad "export --list lists the parts with their levels"; cat "$TMP/export.list"
  fi
  env PATH="$(dirname "$(command -v node)")" "$BP" export --root examples/paper --scope products \
    -o "$TMP/export.notex" > "$TMP/export.notex.log" 2>&1
  status=$?
  if [ "$status" -eq 3 ] && grep -q 'no TeX engine' "$TMP/export.notex.log" \
     && [ -s "$TMP/export.notex/paper-3-products.tex" ] && [ ! -e "$TMP/export.notex/paper-3-products.pdf" ]; then
    ok "export without TeX writes the .tex, no PDF, and exits 3"
  else
    bad "export without TeX writes the .tex, no PDF, and exits 3 (exit $status)"; cat "$TMP/export.notex.log"
  fi

  if command -v pdflatex > /dev/null 2>&1; then
    rm -rf "$TMP/site.pdf"
    if "$BP" site --root examples/paper -o "$TMP/site.pdf" --pdf > "$TMP/site.pdf.log" 2>&1 \
       && grep -q 'exports: 25 made, 0 already there, 0 failed' "$TMP/site.pdf.log"; then
      ok "site --pdf prepares every export the dialog offers"
    else
      bad "site --pdf prepares every export the dialog offers"; cat "$TMP/site.pdf.log"
    fi
    if "$BP" site --root examples/paper -o "$TMP/site.pdf" --pdf > "$TMP/site.pdf.log" 2>&1 \
       && grep -q 'exports: 0 made, 25 already there, 0 failed' "$TMP/site.pdf.log"; then
      ok "site --pdf again reuses what is prepared for the same snapshot"
    else
      bad "site --pdf again reuses what is prepared for the same snapshot"; cat "$TMP/site.pdf.log"
    fi
  else
    echo "  skip site --pdf (no pdflatex on PATH; nix-shell -p texliveMedium runs it)"
  fi

  # The local server's export API checks what it is asked before it runs
  # anything.  Without TeX on its PATH it says so; with it, it makes the PDF.
  if command -v python3 > /dev/null 2>&1; then
    rm -rf "$TMP/site.api"
    "$BP" site --root examples/paper -o "$TMP/site.api" > /dev/null 2>&1
    port=$((20000 + RANDOM % 20000))
    python3 web/comments-server.py --port "$port" --directory "$TMP/site.api" \
      --comments "$TMP/comments.api" --assets-root examples/paper > "$TMP/api.log" 2>&1 &
    api=$!
    for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$port/api/export" > /dev/null 2>&1 && break; sleep 0.1; done
    post () { curl -s -o "$TMP/api.out" -w '%{http_code}' -H 'Content-Type: application/json' \
      --data "$1" "http://127.0.0.1:$port/api/export"; }
    if [ "$(post '{"snapshot":"../../etc/passwd","depth":"all"}')" = 400 ] \
       && [ "$(post '{"snapshot":"blueprint.json","depth":"; rm -rf /"}')" = 400 ] \
       && [ "$(post '{"snapshot":"blueprint.json","scope":"no-such"}')" = 400 ] \
       && [ "$(curl -s -o /dev/null -w '%{http_code}' --data 'x' "http://127.0.0.1:$port/api/export")" = 415 ]; then
      ok "the export API refuses a bad request before running anything"
    else
      bad "the export API refuses a bad request before running anything"; cat "$TMP/api.out"; tail "$TMP/api.log"
    fi
    if command -v pdflatex > /dev/null 2>&1; then
      code=$(post '{"snapshot":"blueprint.json","scope":"products","depth":"all","appendices":true}')
      pdf=$(sed -n 's/.*"pdf": *"\([^"]*\)".*/\1/p' "$TMP/api.out")
      base=$(sed -n 's/.*"base": *"\([^"]*\)".*/\1/p' "$TMP/api.out")
      if [ "$code" = 200 ] && [ -n "$pdf" ] \
         && [ "$(curl -s "http://127.0.0.1:$port/$base$pdf" | head -c 5)" = '%PDF-' ]; then
        ok "the export API makes the PDF and the site serves it"
      else
        bad "the export API makes the PDF and the site serves it ($code)"; cat "$TMP/api.out"
      fi
    else
      code=$(post '{"snapshot":"blueprint.json","scope":"products"}')
      if [ "$code" = 503 ] && grep -q 'not installed' "$TMP/api.out"; then
        ok "the export API says when TeX is not installed (503)"
      else
        bad "the export API says when TeX is not installed ($code)"; cat "$TMP/api.out"
      fi
    fi
    kill "$api" 2> /dev/null
    wait "$api" 2> /dev/null
  fi
else
  echo "  skip blueprint export (no node on PATH)"
fi

# The website's own tests, when node is available (it is on GitHub's runners; on
# a NixOS host without it, `nix-shell -p nodejs_22 --run ./test.sh` runs them).
# export-compile.test.mjs needs pdflatex as well, and says so when it is not there.
if command -v node > /dev/null 2>&1; then
  for t in web/test/model.test.mjs web/test/app.test.mjs web/test/export.test.mjs web/test/export-compile.test.mjs; do
    if node "$t" > "$TMP/$(basename "$t").txt" 2>&1; then
      ok "$t: $(tail -1 "$TMP/$(basename "$t").txt")"
    else
      bad "$t"
      tail -15 "$TMP/$(basename "$t").txt"
    fi
  done
else
  echo "  skip web/test/*.mjs (no node on PATH)"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
