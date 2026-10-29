#!/usr/bin/env python3
"""comments-server.py: serve the blueprint site, keep comments on it, and
make PDFs of it.

`blueprint serve` runs this in place of a plain static file server.  It
serves the assembled site exactly as `python3 -m http.server` would, plus

    GET  /api/comments/<id>   -> {"comments": [{"n", "name", "body", "date"}, ...]}
    POST /api/comments/<id>   <- {"name": "...", "body": "..."}   (JSON)

for the comment section at the foot of every object page.  The comments of
one object are one file, `<comments dir>/<id, percent-encoded>.json`, written
atomically, so the directory can be read, edited, backed up or put under
version control by hand.  Only ids the site's `blueprint.json` knows are
accepted.

    GET  /api/export          -> {"available": true|false, "reason": "..."}
    POST /api/export          <- {"snapshot": "blueprint.json" | "data/<sha>.json",
                                  "sha256": "...", "collapse": "refines",
                                  "scope": "<id>" | null, "depth": "all" | n,
                                  "appendices": true}
                              -> {"ok": true, "base": "data/exports/<hash>/",
                                  "entry": {"pdf": "...", "tex": "...", ...}}

for the website's Export PDF dialog, when the site was not built with every
PDF prepared (`blueprint site --pdf`).  It runs `export/cli.mjs prepare`
from the site under node, which writes the export where a prepared one would
be, `data/exports/<snapshot hash>/`, and so serves it like any other file.
The request names a snapshot only as the site does (its `blueprint.json`, or
a `file` of its `data/index.json`, which the script checks) and the part by
its object id: no path, no command line and no TeX ever comes from the
browser.  At most `EXPORT_JOBS` run at once, the same request twice runs once,
and each is killed after `EXPORT_TIMEOUT` seconds.

Standard library only.  It listens on 127.0.0.1 unless told otherwise.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "/api/comments/"
MAX_NAME = 100
MAX_BODY = 20000
MAX_REQUEST = 64 * 1024
MAX_ID = 200

EXPORT_PATH = "/api/export"
EXPORT_JOBS = 2  # compilations at once
EXPORT_TIMEOUT = 180  # seconds for one export, TeX included
MAX_EXPORT_REQUEST = 4096

write_lock = threading.Lock()


class KnownIds:
    """The object ids of the site's blueprint.json, reread when it changes."""

    def __init__(self, path):
        self.path = path
        self.mtime = None
        self.ids = set()
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            try:
                mtime = os.stat(self.path).st_mtime
            except OSError:
                return None
            if mtime != self.mtime:
                with open(self.path, encoding="utf-8") as f:
                    snap = json.load(f)
                self.ids = {o.get("id") for o in snap.get("objects", []) if isinstance(o, dict)}
                self.mtime = mtime
            return self.ids


class Exporter:
    """Runs `export/cli.mjs prepare`: a bounded number at once, one per request."""

    def __init__(self, site, assets_root):
        self.site = site
        self.assets_root = assets_root
        self.slots = threading.BoundedSemaphore(EXPORT_JOBS)
        self.lock = threading.Lock()
        self.running = {}  # request key -> (event, [result])

    def availability(self, tex=True):
        node = shutil.which("node")
        script = os.path.join(self.site, "export", "cli.mjs")
        if not node:
            return False, "node is not installed on the machine serving the site"
        if not os.path.isfile(script):
            return False, "the site has no export/cli.mjs"
        if tex and not (shutil.which("pdflatex") or os.environ.get("BLUEPRINT_PDFLATEX")):
            return False, "TeX (pdflatex) is not installed on the machine serving the site"
        return True, None

    def run(self, req):
        key = json.dumps(req, sort_keys=True)
        with self.lock:
            pending = self.running.get(key)
            if pending is None:
                pending = (threading.Event(), [])
                self.running[key] = pending
                mine = True
            else:
                mine = False
        event, box = pending
        if not mine:
            # The same export is being made: wait for it rather than run it twice.
            event.wait(EXPORT_TIMEOUT + 10)
            return box[0] if box else (504, {"ok": False, "error": "the export did not finish in time"})
        try:
            box.append(self._run(req))
        finally:
            event.set()
            with self.lock:
                self.running.pop(key, None)
        return box[0]

    def _run(self, req):
        # TeX is not looked for here: the script checks the request first, so
        # a part that does not exist is a 400 whether TeX is installed or not.
        ok, reason = self.availability(tex=False)
        if not ok:
            return 503, {"ok": False, "error": reason}
        args = [shutil.which("node"), os.path.join(self.site, "export", "cli.mjs"), "prepare",
                "--site", self.site, "--snapshot-file=" + req["snapshot"],
                "--depth=" + str(req["depth"]), "--timeout", str(EXPORT_TIMEOUT - 30)]
        if req.get("sha256"):
            args.append("--sha256=" + req["sha256"])
        if req.get("collapse"):
            args.append("--collapse=" + req["collapse"])
        if req.get("scope") is None:
            args.append("--whole")
        else:
            args.append("--scope=" + req["scope"])
        if req.get("appendices") is False:
            args.append("--no-appendices")
        if self.assets_root:
            args += ["--assets-root", self.assets_root]
        if not self.slots.acquire(timeout=EXPORT_TIMEOUT):
            return 503, {"ok": False, "error": "the server is busy making other PDFs; try again"}
        try:
            proc = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                                  timeout=EXPORT_TIMEOUT, cwd=self.site)
        except subprocess.TimeoutExpired:
            return 504, {"ok": False, "error": f"the export did not finish within {EXPORT_TIMEOUT} s"}
        finally:
            self.slots.release()
        out = proc.stdout.decode("utf-8", "replace").strip().splitlines()
        err = proc.stderr.decode("utf-8", "replace").strip()
        try:
            payload = json.loads(out[-1]) if out else None
        except json.JSONDecodeError:
            payload = None
        if payload is None:
            message = err.splitlines()[-1] if err else f"the export stopped with status {proc.returncode}"
            payload = {"ok": False, "error": message.removeprefix("export: ")}
        if proc.returncode == 3:
            # No TeX engine: said as GET api/export says it.
            payload["error"] = self.availability()[1] or payload.get("error")
        status = {0: 200, 1: 422, 2: 409 if payload.get("stale") else 400, 3: 503}.get(proc.returncode, 500)
        return status, payload


SNAPSHOT_RE = re.compile(r"^(?:blueprint\.json|data/[A-Za-z0-9._-]{1,200}\.json)$")
KIND_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def export_request(data):
    """The export a POST asks for, checked for shape (the script checks the rest), or an error."""
    if not isinstance(data, dict):
        return None, "the request is not a JSON object"
    snapshot = data.get("snapshot")
    if not isinstance(snapshot, str) or not SNAPSHOT_RE.match(snapshot):
        return None, "snapshot must be blueprint.json or a data/<name>.json of the site"
    sha = data.get("sha256")
    if sha is not None and (not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha)):
        return None, "sha256 must be 64 hexadecimal digits"
    collapse = data.get("collapse")
    if collapse is not None and (not isinstance(collapse, str) or not KIND_RE.match(collapse)):
        return None, "collapse must be the name of a kind"
    scope = data.get("scope")
    if scope is not None and (not isinstance(scope, str) or not scope or len(scope) > MAX_ID
                              or any(c in scope for c in "\0\r\n")):
        return None, "scope must be null or an object id"
    depth = data.get("depth", "all")
    if isinstance(depth, bool) or not (depth == "all" or (isinstance(depth, int) and 1 <= depth <= 100)
                                       or (isinstance(depth, str) and re.fullmatch(r"[1-9][0-9]?", depth))):
        return None, "depth must be 'all' or a number of levels from 1 to 100"
    appendices = data.get("appendices", True)
    if not isinstance(appendices, bool):
        return None, "appendices must be true or false"
    return {"snapshot": snapshot, "sha256": sha, "collapse": collapse, "scope": scope,
            "depth": depth, "appendices": appendices}, None


def comment_file(directory, object_id):
    return os.path.join(directory, urllib.parse.quote(object_id, safe="") + ".json")


def read_comments(directory, object_id):
    try:
        with open(comment_file(directory, object_id), encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    comments = data.get("comments", []) if isinstance(data, dict) else []
    return [c for c in comments if isinstance(c, dict)]


def write_comments(directory, object_id, comments):
    os.makedirs(directory, exist_ok=True)
    target = comment_file(directory, object_id)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"id": object_id, "comments": comments}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, target)
    except BaseException:
        os.unlink(tmp)
        raise


class Handler(SimpleHTTPRequestHandler):
    comments_dir = None
    known = None
    exporter = None

    def end_headers(self):
        # The site is rebuilt in place; never let a browser keep a stale copy.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def object_id(self):
        """The object id of an /api/comments/<id> request, or an error reply."""
        path = urllib.parse.urlsplit(self.path).path
        object_id = urllib.parse.unquote(path[len(PREFIX):])
        if not object_id or len(object_id) > MAX_ID:
            self.send_json(400, {"error": "bad object id"})
            return None
        ids = self.known.get()
        if ids is not None and object_id not in ids:
            self.send_json(404, {"error": f"no object '{object_id}' in this blueprint"})
            return None
        return object_id

    def is_api(self):
        return urllib.parse.urlsplit(self.path).path.startswith(PREFIX)

    def is_export(self):
        return urllib.parse.urlsplit(self.path).path == EXPORT_PATH

    def read_json(self, limit):
        """The JSON body of a POST, or None after replying with the error."""
        # Only the site's own fetch, which sends JSON: a form on another page
        # cannot set this type without a CORS preflight, which this server
        # never answers.
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.send_json(415, {"error": "send application/json"})
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > limit:
            self.send_json(413 if length > limit else 400, {"error": "bad request size"})
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "the request is not JSON"})
            return None

    def do_GET(self):
        if self.is_export():
            ok, reason = self.exporter.availability()
            return self.send_json(200, {"available": ok, "reason": reason})
        if not self.is_api():
            return super().do_GET()
        object_id = self.object_id()
        if object_id is not None:
            self.send_json(200, {"comments": read_comments(self.comments_dir, object_id)})

    def do_POST(self):
        if self.is_export():
            data = self.read_json(MAX_EXPORT_REQUEST)
            if data is None:
                return
            req, problem = export_request(data)
            if problem:
                return self.send_json(400, {"ok": False, "error": problem})
            status, payload = self.exporter.run(req)
            return self.send_json(status, payload)
        if not self.is_api():
            return self.send_json(405, {"error": "only comments and exports can be posted"})
        object_id = self.object_id()
        if object_id is None:
            return
        # Only the site's own fetch, which sends JSON: a form on another page
        # cannot set this type without a CORS preflight, which this server
        # never answers, so it cannot post comments through a visitor's browser.
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self.send_json(415, {"error": "comments are posted as application/json"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_REQUEST:
            return self.send_json(413 if length > MAX_REQUEST else 400, {"error": "bad request size"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self.send_json(400, {"error": "the request is not JSON"})
        name = str(data.get("name", "")).strip() if isinstance(data, dict) else ""
        body = str(data.get("body", "")).strip() if isinstance(data, dict) else ""
        if not name or not body:
            return self.send_json(400, {"error": "a name and a comment are both needed"})
        if len(name) > MAX_NAME or len(body) > MAX_BODY:
            return self.send_json(400, {"error": f"at most {MAX_NAME} characters of name and {MAX_BODY} of comment"})
        with write_lock:
            comments = read_comments(self.comments_dir, object_id)
            n = max((c.get("n", 0) for c in comments if isinstance(c.get("n"), int)), default=0) + 1
            comments.append({
                "n": n,
                "name": name,
                "body": body,
                "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            })
            write_comments(self.comments_dir, object_id, comments)
        self.send_json(201, {"comments": comments})


def main(argv=None):
    p = argparse.ArgumentParser(description="Serve the blueprint site with comments.")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--bind", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    p.add_argument("--directory", required=True, help="the assembled site")
    p.add_argument("--comments", required=True, help="where the comment files are kept")
    p.add_argument("--assets-root", default=None,
                   help="the project root, where the images of the current snapshot are read from")
    args = p.parse_args(argv)

    site = os.path.abspath(args.directory)
    Handler.comments_dir = os.path.abspath(args.comments)
    Handler.known = KnownIds(os.path.join(site, "blueprint.json"))
    Handler.exporter = Exporter(site, os.path.abspath(args.assets_root) if args.assets_root else None)
    server = ThreadingHTTPServer((args.bind, args.port), partial(Handler, directory=site))
    print(f"serving {site} at http://{args.bind}:{args.port}/ "
          f"with comments in {Handler.comments_dir} (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
