import Blueprint.Model

/-!
# Running git

`blueprint diff`, `log`, `progress` and `history add` read history out of the
git repository the project lives in.  Everything that shells out lives here,
so that the rest of the tool sees plain data.

Nothing in this module assumes that there *is* a repository: every entry
point either returns an `Option` or says in its error message what it wanted.
-/

namespace Blueprint

/-! ## Processes -/

/-- What running an external command produced. -/
structure ProcResult where
  /-- The exit code. -/
  exitCode : UInt32
  /-- Everything the command wrote to stdout. -/
  stdout : String
  /-- Everything the command wrote to stderr. -/
  stderr : String
  deriving Inhabited

/-- Run `cmd args`, capturing stdout and stderr.  A command that is not on
`PATH` is reported as such rather than as a raw spawn failure. -/
def runProcess (cmd : String) (args : Array String)
    (cwd : Option System.FilePath := none) : IO ProcResult := do
  let out ← try
      IO.Process.output { cmd, args, cwd }
    catch e =>
      throw <| IO.userError s!"could not run '{cmd}': {e}"
  return { exitCode := out.exitCode, stdout := out.stdout, stderr := out.stderr }

/-- Does `s` contain `sub`? -/
def containsSubstr (s sub : String) : Bool := (s.splitOn sub).length > 1

/-- What `IO.Process.output` reports for a command that is not on `PATH`: on
Linux the child exits 255 with this on stderr rather than an exception being
raised, so looking for it is the portable test. -/
def notAnExecutable : String := "could not execute external process"

/-- Is this executable on `PATH`?  Asked by running it with a harmless
argument, since there is no portable `which` in core Lean.  A command that
runs and complains about the probe still counts as present. -/
def haveExe (cmd : String) (probe : Array String := #["--version"]) : IO Bool := do
  try
    let out ← IO.Process.output { cmd, args := probe }
    return !(out.exitCode == 255 && containsSubstr out.stderr notAnExecutable)
  catch _ =>
    return false

/-! ## git -/

/-- Run git and return its stdout, failing loudly. -/
def git (args : Array String) : IO String := do
  let r ← runProcess "git" args
  if r.exitCode != 0 then
    throw <| IO.userError
      s!"git {String.intercalate " " args.toList}: {trim r.stderr}"
  return r.stdout

/-- Run git and return its stdout, or `none` when it failed — including when
there is no git at all, so that a project outside a repository, or on a
machine without git, simply has no history. -/
def git? (args : Array String) : IO (Option String) := do
  try
    let r ← runProcess "git" args
    return if r.exitCode == 0 then some r.stdout else none
  catch _ =>
    return none

/-- A git work tree, together with where the project root sits inside it. -/
structure GitContext where
  /-- The root of the work tree. -/
  toplevel : System.FilePath
  /-- The project root relative to `toplevel`: `""` at the top, else a path
  ending in `/`, exactly as `git rev-parse --show-prefix` writes it. -/
  prefixPath : String
  deriving Inhabited

namespace GitContext

/-- A path relative to the project root, as git spells it. -/
def repoPath (c : GitContext) (rel : String) : String := c.prefixPath ++ rel

end GitContext

/-- The git work tree `root` lives in, if any. -/
def gitContext? (root : System.FilePath) : IO (Option GitContext) := do
  match ← git? #["-C", root.toString, "rev-parse", "--show-toplevel", "--show-prefix"] with
  | none => return none
  | some out =>
    let lines := splitLines out
    let top := trim (lines[0]?.getD "")
    if top.isEmpty then return none
    -- `--show-prefix` prints an empty line when the root *is* the top level.
    return some { toplevel := top, prefixPath := trim (lines[1]?.getD "") }

/-- The git work tree `root` lives in, or a clear error. -/
def gitContext (root : System.FilePath) : IO GitContext := do
  match ← gitContext? root with
  | some c => return c
  | none =>
    throw <| IO.userError
      s!"{root}: not inside a git work tree (needed to read history)"

/-- Resolve a revision the way `git rev-parse` does. -/
def resolveRev? (c : GitContext) (rev : String) : IO (Option String) := do
  match ← git? #["-C", c.toplevel.toString, "rev-parse", "--verify", "--quiet", rev] with
  | none => return none
  | some out => let s := trim out; return if s.isEmpty then none else some s

/-- The current `HEAD`, if there is one. -/
def headSha? (c : GitContext) : IO (Option String) := resolveRev? c "HEAD"

/-- The committer date of a revision, `YYYY-MM-DD`. -/
def commitDate? (c : GitContext) (rev : String) : IO (Option String) := do
  match ← git? #["-C", c.toplevel.toString, "log", "-1", "--format=%cI", rev] with
  | none => return none
  | some out =>
    let s := trim out
    return if s.isEmpty then none else some (s.take 10).copy

/-- Materialise the tree of `rev` below `work`, and return the directory it
went into.  This is `git archive <rev> | tar -x`, written as two steps so
that no shell is involved. -/
def materialiseRev (c : GitContext) (rev : String) (work : System.FilePath) :
    IO System.FilePath := do
  let tree := work / "tree"
  let tar := work / "tree.tar"
  IO.FS.createDirAll tree
  discard <| git #["-C", c.toplevel.toString, "archive", "--format=tar",
                   "-o", tar.toString, rev]
  let r ← runProcess "tar" #["-xf", tar.toString, "-C", tree.toString]
  if r.exitCode != 0 then
    throw <| IO.userError s!"tar -xf {tar}: {trim r.stderr}"
  IO.FS.removeFile tar
  return tree

/-! ## Commits -/

/-- One line of `git log`. -/
structure Commit where
  /-- The full object name. -/
  sha : String
  /-- The committer date, `YYYY-MM-DD`. -/
  date : String
  /-- The subject line of the commit message. -/
  subject : String
  deriving Inhabited

namespace Commit

/-- The abbreviated sha used in output. -/
def short (c : Commit) : String := (c.sha.take 8).copy

end Commit

/-- `git log --first-parent` over a set of paths, newest first. -/
def logCommits (c : GitContext) (paths : Array String) (limit : Option Nat) :
    IO (Array Commit) := do
  let limitArgs := match limit with
    | some n => #["-n", toString n]
    | none => #[]
  let args := #["-C", c.toplevel.toString, "log", "--first-parent",
                "--format=%H%x09%cI%x09%s"] ++ limitArgs ++ #["--"] ++ paths
  let out ← git args
  let mut cs : Array Commit := #[]
  for line in splitLines out do
    if trim line |>.isEmpty then continue
    match line.splitOn "\t" with
    | sha :: date :: rest =>
      cs := cs.push { sha := trim sha, date := ((trim date).take 10).copy,
                      subject := trim (String.intercalate "\t" rest) }
    | _ => pure ()
  return cs

/-- The contents of one file at one revision, `none` when it is not there. -/
def showFile? (c : GitContext) (rev : String) (path : String) : IO (Option String) :=
  git? #["-C", c.toplevel.toString, "show", s!"{rev}:{path}"]

end Blueprint
