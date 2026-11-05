#!/usr/bin/env python3
"""comments-server.py: serve the blueprint site, keep comments on it, and
make PDFs of it.

`blueprint serve` runs this in place of a plain static file server.  It
serves the assembled site exactly as `python3 -m http.server` would, plus

    GET  /api/comments/<id>   -> {"comments": [{"n", "name", "title", "body", "date",
                                                 "topic" (on Zulip only)}, ...],
                                  "maxBody": n, "zulip": {...} (on Zulip only)}
    POST /api/comments/<id>   <- {"name": "...", "title": "...", "body": "...",
                                  "visibility": "public" | "private", "page": "<url>"}
                              -> {"comments": [...], "shown": true | false}

for the comment section at the foot of every object page and of every page
of the document.  A comment is public, listed below the page, or private,
kept but never listed: a GET answers with the public comments alone, numbered
among themselves.  Only ids the site's `blueprint.json` knows are accepted,
and `DOCUMENT_THREAD`, the thread of the top page of the document.

The comments are kept in one of two places.  By default the comments of one
object are one file, `<comments dir>/<id, percent-encoded>.json`, private ones
included, written atomically, so the directory can be read, edited, backed up
or put under version control by hand.  When the site's `comments-config.json`
names a Zulip (`blueprint site` writes it for `[site.comments]`) and this
process has a bot in its environment, `BLUEPRINT_ZULIP_EMAIL` and
`BLUEPRINT_ZULIP_KEY`, every comment is a message of that bot in the
channel, public and private alike, in a topic of its own named by the
comment's title; its first line names the object by its id, and a GET lists
the public messages of the bot that name the object (and, as they were kept
before titles, those of the object's own topic): the server relays between
the page and Zulip, so the bot's key never leaves it.  `--allow-origin` lets a site
served elsewhere (a static host that cannot keep a secret) use this server
for its comments, `[site.comments] server` saying where it is.

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
import base64
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "/api/comments/"
MAX_NAME = 100
MAX_TITLE = 60  # a comment's title, which on Zulip is its topic
MAX_BODY = 20000
MAX_REQUEST = 64 * 1024
MAX_ID = 200
# The thread of the top page of the document, which is no object.  A colon is
# no slug character (`isIdChar` in Blueprint/Attr.lean), so no blueprint is
# expected to have an object so named.  The site's comments.js names it too.
DOCUMENT_THREAD = ":document"
VISIBILITIES = ("public", "private")
MAX_PAGE = 2000  # the address of the page a comment was written on
PAGE_RE = re.compile(r"^https?://[^\s()<>]+$")

# Zulip: a message holds 10000 characters, its first line included.
ZULIP_MAX_BODY = 9000
ZULIP_TIMEOUT = 15  # seconds for one call to the Zulip server
MAX_TOPIC = 60  # Zulip's default limit on the length of a topic

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
        self.titles = {}
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
                objects = [o for o in snap.get("objects", []) if isinstance(o, dict)]
                self.ids = {o.get("id") for o in objects}
                self.titles = {o.get("id"): (o.get("attrs") or {}).get("title") for o in objects}
                self.mtime = mtime
            return self.ids

    def title(self, object_id):
        """How a comment's first line names its object: its title, or its id."""
        if object_id == DOCUMENT_THREAD:
            return "the document"
        self.get()
        t = self.titles.get(object_id)
        return t if isinstance(t, str) and t else object_id


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


def public_list(comments):
    """The public comments of a thread, numbered among themselves, as a GET lists them."""
    out = []
    for c in comments:
        if c.get("visibility", "public") != "public":
            continue
        out.append({"n": len(out) + 1, "name": c.get("name", ""), "title": c.get("title") or None,
                    "body": c.get("body", ""), "date": c.get("date")})
    return out


def clean_title(title):
    """A comment's title on one line, its runs of space as one space."""
    return re.sub(r"\s+", " ", str(title or "")).strip()


# ---------------------------------------------------------------- Zulip

def hash8(s):
    """FNV-1a of the UTF-8 bytes, as eight hex digits: tells apart ids cut to the same topic."""
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def topic_of(object_id):
    """The Zulip topic of an object's comments as they were kept before titles,
    and of a comment posted without one: its id, cut to fit with a hash."""
    t = "document (top page)" if object_id == DOCUMENT_THREAD else object_id
    if len(t) <= MAX_TOPIC:
        return t
    return t[:MAX_TOPIC - 10] + "\u2026 " + hash8(t)


def topic_of_title(title):
    """The Zulip topic of a comment with a title: the title, cut to fit."""
    t = clean_title(title)
    return t if len(t) <= MAX_TOPIC else t[:MAX_TOPIC - 1].rstrip() + "\u2026"


MARKS = {"public": "\U0001F310 **Public**", "private": "\U0001F512 **Private**"}
# The first line ends with the object's id, as code, when the comment has a
# topic of its own; the messages of an object's own topic, from before titles,
# have none.
HEAD_RE = re.compile("^(?:\U0001F310|\U0001F512) \\*\\*(Public|Private)\\*\\* comment by \\*\\*([^*\n]*)\\*\\* "
                     "on [^\n]*?(?: \u00b7 `([^`\n]+)`)?[ \t]*(?:\n+|$)")


def head_line(visibility, name, title, url, object_id=None):
    """The first line of a comment's message, which `parse_message` reads back:
    with `object_id`, which names the object for a comment in a topic of its own."""
    label = re.sub(r"([\[\]\\])", r"\\\1", title)
    where = f"[{label}]({url})" if url else label
    tail = f" \u00b7 `{object_id}`" if object_id else ""
    return f"{MARKS[visibility]} comment by **{name}** on {where}{tail}"


def parse_message(content):
    """(visibility, name, body, object id or None) of a message posted for a comment, or None."""
    m = HEAD_RE.match(content)
    if not m:
        return None
    return m.group(1).lower(), m.group(2), content[m.end():], m.group(3)


class ZulipError(Exception):
    pass


class Zulip:
    """The Zulip a site keeps its comments on, and the bot that posts them.

    The bot's email and key are this process's alone: they are read from its
    environment, used on the calls below, and never sent to a browser."""

    def __init__(self, site, channel, email, key):
        self.site = site.rstrip("/")
        self.channel = channel
        self.email = email
        self.auth = "Basic " + base64.b64encode(f"{email}:{key}".encode("utf-8")).decode("ascii")
        self.stream_id = None

    def call(self, method, path, params):
        query = urllib.parse.urlencode(params)
        url = f"{self.site}/api/v1/{path}" + (f"?{query}" if method == "GET" else "")
        req = urllib.request.Request(url, data=None if method == "GET" else query.encode("utf-8"),
                                     method=method, headers={"Authorization": self.auth,
                                                             "User-Agent": "blueprint-comments"})
        if method != "GET":
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=ZULIP_TIMEOUT) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except (ValueError, OSError):
                payload = {}
            raise ZulipError(payload.get("msg") or f"HTTP {e.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ZulipError(str(getattr(e, "reason", e))) from None
        if not isinstance(payload, dict) or payload.get("result") != "success":
            raise ZulipError((payload or {}).get("msg") or "the Zulip server refused the request")
        return payload

    def where(self, topic):
        """What the page says of where its comments go: no credentials.  `topic`
        is the object's own topic, of its comments from before titles."""
        if self.stream_id is None:
            try:
                self.stream_id = self.call("GET", "get_stream_id", {"stream": self.channel}).get("stream_id")
            except ZulipError:
                pass
        return {"site": self.site, "channel": self.channel, "topic": topic, "streamId": self.stream_id}

    def messages(self, *narrow):
        """The bot's messages in the channel, narrowed further by `narrow`."""
        data = self.call("GET", "messages", {
            "anchor": "newest", "num_before": "1000", "num_after": "0", "apply_markdown": "false",
            "narrow": json.dumps([{"operator": "channel", "operand": self.channel},
                                  {"operator": "sender", "operand": self.email}, *narrow]),
        })
        return data.get("messages") or []

    def comments(self, object_id):
        """The bot's public comments of an object, oldest first, as the local
        store lists them: those of topics of their own that name it, found by a
        search for its id, and those of its own topic, from before titles."""
        legacy = topic_of(object_id)
        found = {}
        for m in (self.messages({"operator": "search", "operand": object_id})
                  + self.messages({"operator": "topic", "operand": legacy})):
            c = parse_message(str(m.get("content", "")))
            if not c or c[0] != "public":
                continue
            topic = str(m.get("subject", ""))
            # The search finds words, not the id: keep the messages that name
            # it exactly, and of its own topic those that name no other.
            if c[3] != object_id and not (c[3] is None and topic == legacy):
                continue
            date = datetime.datetime.fromtimestamp(m.get("timestamp", 0), datetime.timezone.utc)
            found[m.get("id")] = {"n": m.get("id"), "name": c[1], "title": topic if c[3] else None,
                                  "body": c[2], "date": date.isoformat(timespec="seconds"),
                                  "topic": topic}
        return [found[k] for k in sorted(found, key=lambda k: (k is None, k or 0))]

    def post(self, topic, content):
        self.call("POST", "messages", {"type": "stream", "to": self.channel, "topic": topic,
                                       "content": content})


def zulip_from(site):
    """The Zulip of the site's comments-config.json with the bot of the environment, or None."""
    try:
        with open(os.path.join(site, "comments-config.json"), encoding="utf-8") as f:
            z = (json.load(f) or {}).get("zulip") or {}
    except (OSError, ValueError, AttributeError):
        return None
    if not (isinstance(z, dict) and z.get("site") and z.get("channel")):
        return None
    email = os.environ.get("BLUEPRINT_ZULIP_EMAIL", "")
    key = os.environ.get("BLUEPRINT_ZULIP_KEY", "")
    if not email or not key:
        print("comments-config.json names a Zulip, but BLUEPRINT_ZULIP_EMAIL or BLUEPRINT_ZULIP_KEY "
              "is not set: the comments are kept here instead", file=sys.stderr, flush=True)
        return None
    return Zulip(str(z["site"]), str(z["channel"]), email, key)


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
    zulip = None  # a Zulip, when the comments are kept there
    allowed_origins = frozenset()  # sites served elsewhere that may use the comment API

    def end_headers(self):
        # The site is rebuilt in place; never let a browser keep a stale copy.
        self.send_header("Cache-Control", "no-cache")
        # A site served elsewhere, named by --allow-origin, may read and post
        # comments here; no other page may.
        origin = self.headers.get("Origin")
        if origin and origin in self.allowed_origins and self.is_api():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        """The preflight of a site named by --allow-origin posting JSON; nothing else."""
        origin = self.headers.get("Origin")
        if not (self.is_api() and origin and origin in self.allowed_origins):
            return self.send_json(403, {"error": "this origin may not use the comment API"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

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
        if ids is not None and object_id not in ids and object_id != DOCUMENT_THREAD:
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
        # answers for the sites of --allow-origin alone.
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
            self.send_comments(200, object_id)

    def send_comments(self, status, object_id, extra=None):
        """The public comments of a thread, and where they are kept."""
        if self.zulip:
            topic = topic_of(object_id)
            try:
                comments = self.zulip.comments(object_id)
            except ZulipError as e:
                return self.send_json(502, {"error": f"Zulip: {e}"})
            payload = {"comments": comments, "maxBody": ZULIP_MAX_BODY, "zulip": self.zulip.where(topic)}
        else:
            payload = {"comments": public_list(read_comments(self.comments_dir, object_id)), "maxBody": MAX_BODY}
        payload.update(extra or {})
        self.send_json(status, payload)

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
        # answers for the sites of --allow-origin alone, so no other page can
        # post comments through a visitor's browser.
        data = self.read_json(MAX_REQUEST)
        if data is None:
            return
        if not isinstance(data, dict):
            return self.send_json(400, {"error": "the request is not a JSON object"})
        name = str(data.get("name", "")).strip()
        title = clean_title(data.get("title", ""))
        body = str(data.get("body", "")).strip()
        visibility = data.get("visibility", "public")
        page = data.get("page")
        limit = ZULIP_MAX_BODY if self.zulip else MAX_BODY
        if not name or not body:
            return self.send_json(400, {"error": "a name and a comment are both needed"})
        if len(name) > MAX_NAME or len(body) > limit:
            return self.send_json(400, {"error": f"at most {MAX_NAME} characters of name and {limit} of comment"})
        if len(title) > MAX_TITLE:
            return self.send_json(400, {"error": f"at most {MAX_TITLE} characters of title"})
        if visibility not in VISIBILITIES:
            return self.send_json(400, {"error": "visibility must be public or private"})
        # The page it was written on, linked from the message on Zulip: a plain
        # web address, or nothing.
        if not (isinstance(page, str) and len(page) <= MAX_PAGE and PAGE_RE.match(page)):
            page = None
        shown = {"shown": visibility == "public"}
        if self.zulip:
            # The name is set in bold on the first line, which `parse_message` reads back.
            who = re.sub(r"[*\r\n]+", " ", name).strip()
            # A comment with a title is a topic of its own, which its first line
            # ties to its object; one without (from a page of before titles)
            # goes to the object's own topic, as before.
            if title:
                topic = topic_of_title(title)
                content = head_line(visibility, who, self.known.title(object_id), page, object_id)
            else:
                topic = topic_of(object_id)
                content = head_line(visibility, who, self.known.title(object_id), page)
            try:
                self.zulip.post(topic, content + "\n\n" + body)
            except ZulipError as e:
                return self.send_json(502, {"error": f"Zulip: {e}"})
            return self.send_comments(201, object_id, shown)
        with write_lock:
            comments = read_comments(self.comments_dir, object_id)
            n = max((c.get("n", 0) for c in comments if isinstance(c.get("n"), int)), default=0) + 1
            comments.append({
                "n": n,
                "name": name,
                **({"title": title} if title else {}),
                "body": body,
                "visibility": visibility,
                "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            })
            write_comments(self.comments_dir, object_id, comments)
        self.send_json(201, {"comments": public_list(comments), "maxBody": MAX_BODY, **shown})


def main(argv=None):
    p = argparse.ArgumentParser(description="Serve the blueprint site with comments.")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--bind", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    p.add_argument("--directory", required=True, help="the assembled site")
    p.add_argument("--comments", required=True, help="where the comment files are kept")
    p.add_argument("--assets-root", default=None,
                   help="the project root, where the images of the current snapshot are read from")
    p.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                   help="a site served elsewhere, such as https://user.github.io, that may use "
                        "the comment API (repeatable)")
    args = p.parse_args(argv)

    site = os.path.abspath(args.directory)
    Handler.comments_dir = os.path.abspath(args.comments)
    Handler.known = KnownIds(os.path.join(site, "blueprint.json"))
    Handler.exporter = Exporter(site, os.path.abspath(args.assets_root) if args.assets_root else None)
    Handler.zulip = zulip_from(site)
    Handler.allowed_origins = frozenset(o.rstrip("/") for o in args.allow_origin)
    server = ThreadingHTTPServer((args.bind, args.port), partial(Handler, directory=site))
    where = (f"on Zulip, {Handler.zulip.site} #{Handler.zulip.channel}" if Handler.zulip
             else f"in {Handler.comments_dir}")
    print(f"serving {site} at http://{args.bind}:{args.port}/ "
          f"with comments {where} (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
