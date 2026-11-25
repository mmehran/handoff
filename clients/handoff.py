"""Handoff API client for Python 3.8+. One file, standard library only.

    from handoff import Handoff
    h = Handoff("https://claude.example.com", "hk_...")   # or HANDOFF_URL / HANDOFF_KEY
    turn = h.chat("What changed in my last commit?")     # waits for the answer
    print(turn["text"])
    for ev in h.stream("/chat", {"prompt": "Explain this repo"}):
        if ev["event"] == "text":
            print(ev["data"]["text"], end="", flush=True)

Every method returns the API's JSON as dicts (see /api/v1/docs). Failures raise HandoffError.
"""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

ACTIVE = {"queued", "running", "waiting_for_approval", "waiting_for_answer"}


class HandoffError(Exception):
    def __init__(self, status, code, message, body=None):
        super().__init__(message)
        self.status, self.code, self.body = status, code, body


def file(name, content):
    """A file to attach, from bytes or text: {"name": ..., "data": base64}."""
    data = content.encode("utf-8") if isinstance(content, str) else content
    return {"name": name, "data": base64.b64encode(data).decode("ascii")}


class Handoff:
    def __init__(self, url=None, key=None, timeout=120):
        url = url or os.environ.get("HANDOFF_URL")
        key = key or os.environ.get("HANDOFF_KEY")
        if not url or not key:
            raise ValueError("Handoff needs its address and an API key (or HANDOFF_URL and HANDOFF_KEY).")
        base = url.rstrip("/")
        if base.endswith("/api/v1"):
            base = base[: -len("/api/v1")]
        self.base, self.key, self.timeout = base + "/api/v1", key, timeout

    def _open(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                j = json.loads(text)
            except ValueError:
                j = None
            err = (j or {}).get("error") or {}
            raise HandoffError(e.code, err.get("code", "http_error"), err.get("message", "%s %s" % (e.code, e.reason)), j) from None

    def request(self, method, path, body=None):
        with self._open(method, path, body) as r:
            text = r.read().decode("utf-8")
            return json.loads(text) if text.strip() else None

    def finish(self, t, what="turns"):
        """Waits for a turn (or comparison) to finish, asking again while it is still working."""
        while t and t.get("status") in ACTIVE:
            t = self.request("GET", "/%s/%s?wait=60" % (what, t["id"]))
        return t

    # ----- sending (keyword options: session, project, model, effort, mode, tools, files, plain, ...) -----
    def chat(self, prompt, **opts):
        return self.finish(self.request("POST", "/chat", dict(prompt=prompt, **opts)))

    def new_session(self, prompt, **opts):
        return self.finish(self.request("POST", "/sessions", dict(prompt=prompt, **opts)))

    def send(self, session_id, prompt, **opts):
        return self.finish(self.request("POST", "/sessions/%s/messages" % session_id, dict(prompt=prompt, **opts)))

    def ask(self, session_id, prompt, **opts):
        return self.finish(self.request("POST", "/sessions/%s/ask" % session_id, dict(prompt=prompt, **opts)))

    def compare(self, prompt, models, **opts):
        return self.finish(self.request("POST", "/compare", dict(prompt=prompt, models=models, **opts)), "compare")

    def stream(self, path, body):
        """Server-Sent Events of a send: yields {"event": ..., "data": ...}."""
        with self._open("POST", path, dict(body, stream=True)) as r:
            event, data = None, None
            for raw in r:
                line = raw.decode("utf-8").rstrip("\r\n")
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    data = line[6:]
                elif not line:
                    if event and data and event != "ping":
                        yield {"event": event, "data": json.loads(data)}
                    event, data = None, None

    # ----- reading -----
    def me(self):
        return self.request("GET", "/me")

    def models(self):
        return self.request("GET", "/models")

    def projects(self):
        return self.request("GET", "/projects")

    def sessions(self, **params):
        return self.request("GET", "/sessions?" + urllib.parse.urlencode(params))

    def session(self, session_id):
        return self.request("GET", "/sessions/" + session_id)

    def messages(self, session_id, **params):
        return self.request("GET", "/sessions/%s/messages?%s" % (session_id, urllib.parse.urlencode(params)))

    def turn(self, turn_id, wait=0):
        return self.request("GET", "/turns/%s?wait=%d" % (turn_id, wait))

    def turns(self, **params):
        return self.request("GET", "/turns?" + urllib.parse.urlencode(params))

    # ----- picking a session, approvals -----
    def select(self, session_id):
        return self.request("PUT", "/selection", {"session": session_id}) if session_id else self.request("DELETE", "/selection")

    def approvals(self):
        return self.request("GET", "/approvals")

    def approve(self, approval_id, allow=True, **opts):
        return self.request("POST", "/approvals/" + approval_id, dict(allow=allow, **opts))
