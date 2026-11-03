#!/usr/bin/env python3
"""fake-zulip.py: the few calls of the Zulip API that comments-server.py makes,
for test.sh.

    python3 fake-zulip.py <port> <email> <key> <channel> <log>

Answers `get_stream_id`, `GET messages` (narrowed to a channel, a topic and a
sender) and `POST messages`, for the one bot `<email>:<key>`: any other
credentials are refused, as Zulip refuses them.  Every request is appended
to `<log>` as a line of JSON, its Authorization header included, so that a
test can say who asked Zulip what.  Standard library only.
"""

import base64
import json
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, EMAIL, KEY, CHANNEL, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
AUTH = "Basic " + base64.b64encode(f"{EMAIL}:{KEY}".encode()).decode()
STREAM_ID = 7
messages = []  # {id, topic, sender, timestamp, content}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_call(self, method):
        url = urllib.parse.urlsplit(self.path)
        params = dict(urllib.parse.parse_qsl(url.query))
        if method == "POST":
            n = int(self.headers.get("Content-Length", "0"))
            params.update(urllib.parse.parse_qsl(self.rfile.read(n).decode()))
        auth = self.headers.get("Authorization", "")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"method": method, "path": url.path, "auth": auth, "params": params}) + "\n")
        if auth != AUTH:
            return self.reply(401, {"result": "error", "msg": "Invalid API key"})
        if url.path == "/api/v1/get_stream_id":
            if params.get("stream") != CHANNEL:
                return self.reply(400, {"result": "error", "msg": "Invalid channel name"})
            return self.reply(200, {"result": "success", "stream_id": STREAM_ID})
        if url.path == "/api/v1/messages" and method == "POST":
            with lock:
                messages.append({"id": 100 + len(messages), "topic": params.get("topic"), "sender": EMAIL,
                                 "timestamp": 1793606400 + len(messages), "content": params.get("content", "")})
            return self.reply(200, {"result": "success", "id": 100 + len(messages) - 1})
        if url.path == "/api/v1/messages":
            narrow = {d["operator"]: d["operand"] for d in json.loads(params.get("narrow", "[]"))}
            with lock:
                found = [m for m in messages
                         if m["topic"] == narrow.get("topic") and m["sender"] == narrow.get("sender")
                         and narrow.get("channel") == CHANNEL]
            return self.reply(200, {"result": "success", "messages": found})
        return self.reply(404, {"result": "error", "msg": "no such endpoint"})

    def do_GET(self):
        self.handle_call("GET")

    def do_POST(self):
        self.handle_call("POST")


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
