#!/usr/bin/env python3
"""comments-server.py: serve the blueprint site, and keep comments on it.

`blueprint serve` runs this in place of a plain static file server.  It
serves the assembled site exactly as `python3 -m http.server` would, plus

    GET  /api/comments/<id>   -> {"comments": [{"n", "name", "body", "date"}, ...]}
    POST /api/comments/<id>   <- {"name": "...", "body": "..."}   (JSON)

for the comment section at the foot of every object page.  The comments of
one object are one file, `<comments dir>/<id, percent-encoded>.json`, written
atomically, so the directory can be read, edited, backed up or put under
version control by hand.  Only ids the site's `blueprint.json` knows are
accepted.

Standard library only.  It listens on 127.0.0.1 unless told otherwise.
"""

import argparse
import datetime
import json
import os
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

    def do_GET(self):
        if not self.is_api():
            return super().do_GET()
        object_id = self.object_id()
        if object_id is not None:
            self.send_json(200, {"comments": read_comments(self.comments_dir, object_id)})

    def do_POST(self):
        if not self.is_api():
            return self.send_json(405, {"error": "only comments can be posted"})
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
    args = p.parse_args(argv)

    site = os.path.abspath(args.directory)
    Handler.comments_dir = os.path.abspath(args.comments)
    Handler.known = KnownIds(os.path.join(site, "blueprint.json"))
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
