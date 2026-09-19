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

# One status of each kind, including the two that only the extractor can
# tell apart: a custom axiom and a `sorry`.
wants "$TMP/facts.json" \
  '"Topology.dim": {"status": "proved",' \
  '"Topology.compactness": {"status": "proved",' \
  '"Topology.compactnessLemma": {"status": "proved_with_axioms",' \
  '"Induction.keyProp": {"status": "proved",' \
  '"Induction.mainTheorem": {"status": "stated",'

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
  '"Induction.keyProp": {"status": "proved",' \
  '"Topology.compactness": {"status": "proved",'

# Names from --names, including one that does not exist.
"$BP" extract BlueprintExamples --names "Induction.keyProp,Nowhere.atAll" \
  --out "$TMP/facts.names.json" > /dev/null 2>&1
wants "$TMP/facts.names.json" \
  '"Nowhere.atAll": {"exists": false}' \
  '"Induction.keyProp": {"status": "proved",'

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

if grep -q "wrote 10 file(s)" "$TMP/li.log" \
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

# unresolved `\uses` must not become an edge, and must be visible in the body
if grep -q 'Unresolved dependencies: lem:nowhere' \
     "$TMP/li/blueprint/the-main-theorem/sec-statement/thm-main.md" \
   && ! grep -q '"id": "uses/thm-main/lem:nowhere"' "$TMP/li.json" \
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
   && grep -q 'using \[plus\]' "$TMP/scratch/blueprint/add-comm.md" \
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
perl -0pi -e 's/("Induction\.keyProp":\s*\{"status": ")proved/${1}stated/' \
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

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
