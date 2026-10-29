#!/usr/bin/env python3
"""cua-driver 0.38.0 vs Orca's computer-use runtimes: background bench for Windows and Linux (X11).

A frontmost "user" sentinel window receives one 'q' every 200 ms while each engine drives a target
window that sits fully behind it. Per action and engine it records delivery (read back from the app),
focus/z-order/pointer/clipboard side effects, lost or redirected user keystrokes, latency, what the
engine reported, and snapshot sizes. Usage: bench.py --target fixture|editor|electron --cua <exe> --out <dir>
"""
import argparse
import json
import os
import platform
import queue
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time

WIN = sys.platform == "win32"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
if WIN:
    import obs_win as obs
else:
    import obs_x11 as obs

POLL_MS = 1000
SETTLE_MS = 400
TEXT = "hello world"
SET_TEXT = "set by value"


def now():
    return time.perf_counter() * 1000


def log(*a):
    print(*a, flush=True)


def jread(path, default=None):
    for _ in range(30):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            time.sleep(0.005)
    return default if default is not None else {}


# ------------------------------------------------------------------ engines
class Cua:
    """cua-driver over MCP stdio, `mcp --direct` (the process owns the runtime on Windows/Linux)."""

    def __init__(self, exe, home, logf):
        env = dict(os.environ)
        env.update({
            "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0", "CUA_TELEMETRY_ENABLED": "0", "DO_NOT_TRACK": "1",
            "CUA_DRIVER_RS_UPDATE_CHECK": "0", "CUA_DRIVER_RS_HOME": home, "CUA_HOME": home,
            "CUA_DRIVER_TELEMETRY_HOME": home,
            # Disposable CI desktop, as in cua's own live-smoke workflow: no interactive approvals.
            "CUA_DRIVER_PERMISSION_MODE": "unrestricted", "CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS": "1",
        })
        os.makedirs(home, exist_ok=True)
        t0 = now()
        self.p = subprocess.Popen([exe, "mcp", "--direct", "--no-overlay"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=logf, env=env)
        self.pid = self.p.pid
        self.q = {}
        self.cv = threading.Condition()
        self.nid = 0
        threading.Thread(target=self._reader, daemon=True).start()
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "orca-bench", "version": "0"}}, timeout=60)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.startup_ms = round(now() - t0, 1)
        self.server_info = (init or {}).get("serverInfo")

    def _reader(self):
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if "id" in m:
                with self.cv:
                    self.q[m["id"]] = (m, len(line))
                    self.cv.notify_all()

    def _send(self, obj):
        self.p.stdin.write((json.dumps(obj) + "\n").encode())
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=30):
        with self.cv:
            self.nid += 1
            i = self.nid
        self._send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        end = time.time() + timeout
        with self.cv:
            while i not in self.q:
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError(method)
                self.cv.wait(left)
            m, n = self.q.pop(i)
        self.last_raw = n
        if "error" in m:
            return {"_rpc_error": m["error"]}
        return m["result"]

    def call(self, tool, args, timeout=30):
        t0 = now()
        r = self.rpc("tools/call", {"name": tool, "arguments": args}, timeout)
        r["_ms"] = now() - t0
        r["_raw"] = self.last_raw
        return r

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()


def cua_text(r):
    return "\n".join(c.get("text", "") for c in r.get("content") or [] if c.get("type") == "text")


def cua_sc(r):
    return r.get("structuredContent") or {}


class OrcaWin:
    """runtime.ps1 -Serve over NDJSON, as DesktopScriptRuntimeHost runs it."""

    def __init__(self, logf):
        script = os.path.join(REPO, "native", "computer-use-windows", "runtime.ps1")
        t0 = now()
        self.p = subprocess.Popen(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                   "-File", script, "-Serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=logf,
                                  creationflags=0x08000000)
        self.pid = self.p.pid
        self.lines = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        ready = self.lines.get(timeout=120)
        if '"ready"' not in ready:
            raise RuntimeError("runtime.ps1 did not announce readiness: " + ready[:200])
        self.startup_ms = round(now() - t0, 1)
        self.rid = 0

    def _reader(self):
        for line in self.p.stdout:
            self.lines.put(line.decode("utf-8", "replace").strip())

    def op(self, req, timeout=30):
        self.rid += 1
        req = {**req, "requestId": self.rid}
        t0 = now()
        self.p.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
        self.p.stdin.flush()
        end = time.time() + timeout
        while True:
            line = self.lines.get(timeout=max(0.01, end - time.time()))
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("requestId") == self.rid:
                return m, now() - t0, len(line)

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()


class OrcaLinux:
    """runtime.py one operation per process, as execBridge runs it."""

    pid = None
    startup_ms = None

    def __init__(self, logf):
        self.script = os.path.join(REPO, "native", "computer-use-linux", "runtime.py")
        self.logf = logf
        self.dir = tempfile.mkdtemp(prefix="orca-bench-op-")

    def op(self, req, timeout=30):
        path = os.path.join(self.dir, "operation.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(req, f)
        t0 = now()
        r = subprocess.run(["python3", self.script, path], capture_output=True, text=True, timeout=timeout)
        ms = now() - t0
        if r.stderr:
            self.logf.write(r.stderr.encode())
        try:
            return json.loads(r.stdout), ms, len(r.stdout)
        except ValueError:
            return {"ok": False, "error": "invalid json: " + (r.stdout or r.stderr)[:300]}, ms, len(r.stdout)

    def close(self):
        pass


def orca_tree_text(snapshot):
    """renderTreeText from src/main/computer/desktop-script-snapshot-rendering.ts."""
    app = snapshot.get("app") or {}
    ref = app.get("bundleId") or app.get("bundleIdentifier") or app.get("name")
    clean = lambda v: str(v).replace("\n", " ").replace("\r", " ")
    lines = [f"App={ref} (pid {app.get('pid')})",
             f'Window: "{clean(snapshot.get("windowTitle") or app.get("name"))}", App: {clean(app.get("name"))}.', "",
             *(snapshot.get("treeLines") or [])]
    if snapshot.get("selectedText"):
        lines += ["", f"Selected text: [{clean(snapshot['selectedText'])}]"]
    elif snapshot.get("focusedSummary"):
        lines += ["", f"The focused UI element is {clean(snapshot['focusedSummary'])}."]
    return "\n".join(lines)


# ------------------------------------------------------------------ element lookup
ROLE_KEYS = ("role", "control_type", "role_description", "localized_role", "subrole", "controlType", "localizedControlType")
LABEL_KEYS = ("label", "name", "title", "description", "value", "automation_id", "automationId", "help", "placeholder")


def norm(e):
    return (" ".join(str(e.get(k) or "") for k in ROLE_KEYS).lower(), " ".join(str(e.get(k) or "") for k in LABEL_KEYS).lower())


def find(elements, sel):
    role_re, label_re = sel
    for e in elements:
        role, label = norm(e)
        if re.search(role_re, role, re.I) and re.search(label_re, label, re.I):
            return e
    return None


def md_rows(text, snapshot_id):
    out = []
    for line in (text or "").splitlines():
        m = re.match(r"\s*-\s*\[(\d+)\]\s*(.*)", line)
        if m:
            body = m.group(2)
            role = re.split(r'["\[(]', body, maxsplit=1)[0].strip()
            out.append({"role": role, "label": body[len(role):], "element_token": f"{snapshot_id}:{m.group(1)}"})
    return out


# ------------------------------------------------------------------ targets
class FileTarget:
    """Fixture or Electron: state.json written by the app, commands through cmd."""

    def __init__(self, kind, state_dir):
        self.kind = kind
        self.dir = state_dir
        self.state_path = os.path.join(state_dir, "state.json")
        self.cmd_path = os.path.join(state_dir, "cmd")
        open(self.cmd_path, "w").close()

    def st(self):
        return jread(self.state_path)

    def cmd(self, c, ok, timeout=2.0):
        with open(self.cmd_path, "w") as f:
            f.write(c)
        end = time.time() + timeout
        while time.time() < end:
            if ok(self.st()):
                return True
            time.sleep(0.01)
        return False

    def prepare(self, action):
        if action in ("return", "ctrl_a"):
            return self.cmd("setHello", lambda s: s.get("text") == "hello" and s.get("returns") == 0 and s.get("selLen") == 0)
        return self.cmd("reset", lambda s: s.get("text") == "" and s.get("count") == 0 and not s.get("check")
                        and (s.get("top") or 0) == 0 and s.get("combo") in ("Red", None) and s.get("menuHits", 0) == 0)

    def check(self, action):
        s = self.st()
        return {
            "click_button": lambda: s.get("count", 0) >= 1,
            "click_checkbox": lambda: s.get("check") is True,
            "menu": lambda: s.get("menuHits", 0) >= 1,
            "type": lambda: s.get("text") == TEXT,
            "return": lambda: s.get("returns", 0) >= 1,
            "ctrl_a": lambda: s.get("selStart") == 0 and s.get("selLen") == 5,
            "scroll": lambda: (s.get("top") or 0) > 0,
            "set_value_text": lambda: s.get("text") == SET_TEXT,
            "set_value_combo": lambda: s.get("combo") == "Blue",
        }[action]()

    def stray(self):
        s = self.st()
        return str(s.get("text") or "").count("q")

    def snapshot_state(self):
        return self.st()


class NotepadTarget:
    def __init__(self, hwnd):
        self.edit = obs.edit_child(hwnd)
        if not self.edit:
            raise RuntimeError("no Edit/RichEdit child in Notepad")
        self.lines = "\n".join(f"line {i}" for i in range(400)).replace("\n", "\r\n")

    def text(self):
        return obs.edit_text(self.edit).replace("\r\n", "\n").replace("\r", "\n")

    def prepare(self, action):
        if action in ("return", "ctrl_a"):
            obs.edit_set(self.edit, "hello", 5)
        elif action == "scroll":
            obs.edit_set(self.edit, self.lines, 0)
        else:
            obs.edit_set(self.edit, "", 0)
        time.sleep(0.05)
        return True

    def check(self, action):
        return {
            "type": lambda: self.text() == TEXT,
            "return": lambda: self.text() == "hello\n",
            "ctrl_a": lambda: obs.edit_sel(self.edit) == (0, 5),
            "scroll": lambda: obs.edit_first_line(self.edit) > 0,
            "set_value_text": lambda: self.text() == SET_TEXT,
        }[action]()

    def stray(self):
        return self.text().count("q")

    def snapshot_state(self):
        return {"text": self.text()[:80], "sel": obs.edit_sel(self.edit), "first": obs.edit_first_line(self.edit)}


class GeditTarget:
    def __init__(self, pid):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.A = Atspi
        self.pid = pid
        self.node = None
        end = time.time() + 30
        while time.time() < end and self.node is None:
            self.node = self._find()
            time.sleep(0.5)
        if self.node is None:
            raise RuntimeError("no editable text in gedit over AT-SPI")
        self.lines = "\n".join(f"line {i}" for i in range(400))

    def _find(self):
        A = self.A
        desk = A.get_desktop(0)
        for i in range(desk.get_child_count()):
            app = desk.get_child_at_index(i)
            try:
                if app is None or app.get_process_id() != self.pid:
                    continue
            except Exception:
                continue
            stack, seen = [app], 0
            while stack and seen < 4000:
                n = stack.pop()
                seen += 1
                try:
                    states = n.get_state_set()
                    if n.get_role() == A.Role.TEXT and states.contains(A.StateType.EDITABLE) and states.contains(A.StateType.MULTI_LINE):
                        return n
                    stack.extend(n.get_child_at_index(j) for j in range(n.get_child_count()))
                except Exception:
                    pass
        return None

    def text(self):
        t = self.node.get_text_iface()
        return self.A.Text.get_text(t, 0, -1)

    def set(self, value, caret):
        self.A.EditableText.set_text_contents(self.node.get_editable_text_iface(), value)
        self.A.Text.set_caret_offset(self.node.get_text_iface(), caret)

    def prepare(self, action):
        if action in ("return", "ctrl_a"):
            self.set("hello", 5)
        elif action == "scroll":
            self.set(self.lines, 0)
        else:
            self.set("", 0)
        time.sleep(0.1)
        if action == "scroll":
            self.top0 = self.top_offset()
        return True

    def top_offset(self):
        A = self.A
        ext = A.Component.get_extents(self.node.get_component_iface(), A.CoordType.SCREEN)
        return A.Text.get_offset_at_point(self.node.get_text_iface(), ext.x + 8, ext.y + 8, A.CoordType.SCREEN)

    def selection(self):
        t = self.node.get_text_iface()
        if self.A.Text.get_n_selections(t) < 1:
            return None
        r = self.A.Text.get_selection(t, 0)
        return (r.start_offset, r.end_offset)

    def check(self, action):
        return {
            "type": lambda: self.text() == TEXT,
            "return": lambda: self.text() == "hello\n",
            "ctrl_a": lambda: self.selection() == (0, 5),
            "scroll": lambda: self.top_offset() > getattr(self, "top0", 0),
            "set_value_text": lambda: self.text() == SET_TEXT,
        }[action]()

    def stray(self):
        return self.text().count("q")

    def snapshot_state(self):
        return {"text": self.text()[:80], "sel": self.selection(), "top": self.top_offset()}


# ------------------------------------------------------------------ selectors and actions
SEL = {
    "fixture": {
        "click_button": (r"button", r"\bincrement\b"),
        "click_checkbox": (r"check", r"check me"),
        "field": (r"edit|text|entry", r"\bfield\b"),
        "set_value_combo": (r"combo", r"\bcolor\b"),
        "scroll": (r"list|scroll", r"\blist\b"),
        "menu_top": (r"menu ?item", r"^\s*edit\b|\bedit\b"),
        "menu_item": (r"menu ?item", r"\bbump\b"),
    },
    "editor": {
        "field": (r"\bedit\b|document|^\s*text\b|\btext\b", r""),
        "scroll": (r"\bedit\b|document|^\s*text\b|\btext\b", r""),
    },
    "electron": {
        "click_button": (r"button", r"\bincrement\b"),
        "field": (r"edit|text|entry", r"\bfield\b"),
        "set_value_combo": (r"combo|popup|list ?box|menu ?button", r"\bcolor\b"),
        "scroll": (r"document|web", r""),
    },
}
ACTIONS = {
    "fixture": ["click_button", "click_checkbox", "menu", "type", "return", "ctrl_a", "scroll", "set_value_text", "set_value_combo"],
    "editor": ["type", "return", "ctrl_a", "scroll", "set_value_text"],
    "electron": ["click_button", "type", "return", "ctrl_a", "scroll", "set_value_text", "set_value_combo"],
}
ELEMENT_OF = {"type": "field", "return": "field", "ctrl_a": "field", "set_value_text": "field"}
CUA_FG_TOOLS = {"click", "type_text", "press_key", "hotkey", "scroll"}


class CuaEngine:
    name = "cua"

    def __init__(self, c, pid, wid):
        self.c, self.pid, self.wid = c, pid, wid
        self.elements = []

    def snapshot(self):
        r = self.c.call("get_window_state", {"pid": self.pid, "window_id": self.wid, "include_screenshot": False, "full_output": True})
        s = cua_sc(r)
        self.elements = s.get("elements") or md_rows(s.get("tree_markdown") or cua_text(r), s.get("snapshot_id"))
        self.last_snapshot = r
        return self.elements

    def ref(self, sel):
        e = find(self.elements, sel)
        return e and e.get("element_token")

    def act(self, action, refs, escalate):
        base = {"pid": self.pid, "window_id": self.wid}
        tok = refs.get(ELEMENT_OF.get(action, action))
        if action == "menu":
            tool, args = "invoke_menu", {**base, "path": ["Edit", "Bump"]}
        elif action.startswith("click"):
            tool, args = "click", {**base, "element_token": tok}
        elif action == "type":
            tool, args = "type_text", {**base, "element_token": tok, "text": TEXT}
        elif action == "return":
            tool, args = "press_key", {**base, "element_token": tok, "key": "return"}
        elif action == "ctrl_a":
            tool, args = "hotkey", {**base, "element_token": tok, "keys": ["ctrl", "a"]}
        elif action == "scroll":
            tool, args = "scroll", {**base, "element_token": tok, "direction": "down", "amount": 3}
        elif action == "set_value_text":
            tool, args = "set_value", {**base, "element_token": tok, "value": SET_TEXT}
        elif action == "set_value_combo":
            tool, args = "set_value", {**base, "element_token": tok, "value": "Blue"}
        if escalate:
            args["delivery_mode"] = "foreground"
        if "element_token" in args and not args["element_token"]:
            return {"ms": 0, "reported": "no_element", "detail": "selector found no element", "error": True}
        r = self.c.call(tool, args)
        if "_rpc_error" in r:
            return {"ms": r["_ms"], "reported": "rpc_error", "detail": json.dumps(r["_rpc_error"])[:300], "error": True}
        s = cua_sc(r)
        err = bool(r.get("isError"))
        code = s.get("code") or (s["error"].get("code") if isinstance(s.get("error"), dict) else None)
        effect = s.get("effect")
        reported = effect or (("error:" + str(code)) if err else "ok(no effect field)")
        if err and effect:
            reported = f"{effect}(isError)"
        return {"ms": r["_ms"], "reported": reported, "error": err, "route": s.get("route"),
                "delivery": (s.get("delivery") or {}).get("mode") if isinstance(s.get("delivery"), dict) else s.get("delivery"),
                "code": code, "detail": (s.get("summary") or cua_text(r))[:300]}

    def can_escalate(self, action):
        return action not in ("menu", "set_value_text", "set_value_combo")

    def read(self):
        r = self.c.call("get_window_state", {"pid": self.pid, "window_id": self.wid, "include_screenshot": False})
        return {"ms": r["_ms"], "chars": len(cua_text(r)), "raw": r["_raw"], "text": cua_text(r), "error": bool(r.get("isError"))}

    def read_full(self):
        r = self.c.call("get_window_state", {"pid": self.pid, "window_id": self.wid, "include_screenshot": False, "full_output": True})
        return {"ms": r["_ms"], "chars": len(cua_text(r)), "raw": r["_raw"]}


class OrcaEngine:
    name = "orca"

    def __init__(self, o, pid):
        self.o, self.app = o, f"pid:{pid}"
        self.target = {}
        self.elements = []

    def snapshot(self):
        r, ms, n = self.o.op({"tool": "get_app_state", "app": self.app, "noScreenshot": True})
        if not r.get("ok"):
            raise RuntimeError("orca get_app_state: " + str(r.get("error"))[:300])
        snap = r["snapshot"]
        self.elements = snap.get("elements") or []
        # Mirror desktopActionWindowTarget: Windows targets by id, Linux by index.
        self.target = {"windowId": snap.get("windowId")} if snap.get("windowId") is not None else {"windowIndex": snap.get("windowIndex")}
        self.last_snapshot = snap
        return self.elements

    def ref(self, sel):
        return find(self.elements, sel)

    def _req(self, tool, element=None, escalate=False, **extra):
        req = {"tool": tool, "app": self.app, "element": element, "windowBounds": None, **self.target,
               "noScreenshot": True, "restoreWindow": bool(escalate)}
        req.update(extra)
        return req

    def act(self, action, refs, escalate):
        el = refs.get(ELEMENT_OF.get(action, action))
        if action == "menu":
            top = refs.get("menu_top")
            if not top:
                return {"ms": 0, "reported": "no_element", "error": True, "detail": "no Edit menu item in tree"}
            r, ms, _ = self.o.op(self._req("click", top, escalate))
            if not r.get("ok"):
                return {"ms": ms, "reported": "error", "error": True, "detail": str(r.get("error"))[:300]}
            item = find((r.get("snapshot") or {}).get("elements") or [], SEL["fixture"]["menu_item"])
            if not item:
                return {"ms": ms, "reported": "error:item_not_in_tree", "error": True, "detail": "Bump not in the window tree after opening Edit",
                        "path": (r.get("action") or {}).get("path")}
            r2, ms2, _ = self.o.op(self._req("click", item, escalate))
            return self._result(r2, ms + ms2)
        if action != "menu" and el is None and action not in ("return", "ctrl_a"):
            return {"ms": 0, "reported": "no_element", "error": True, "detail": "selector found no element"}
        if action.startswith("click"):
            req = self._req("click", el, escalate)
        elif action == "type":
            req = self._req("type_text", el, escalate, text=TEXT)
        elif action == "return":
            req = self._req("press_key", el, escalate, key="return")
        elif action == "ctrl_a":
            req = self._req("hotkey", el, escalate, key="ctrl+a")
        elif action == "scroll":
            req = self._req("scroll", el, escalate, direction="down", pages=1)
        elif action == "set_value_text":
            req = self._req("set_value", el, escalate, value=SET_TEXT)
        elif action == "set_value_combo":
            req = self._req("set_value", el, escalate, value="Blue")
        r, ms, _ = self.o.op(req)
        return self._result(r, ms)

    def _result(self, r, ms):
        if not r.get("ok"):
            return {"ms": ms, "reported": "error", "error": True, "detail": str(r.get("error"))[:300]}
        a = r.get("action") or {}
        v = (a.get("verification") or {}).get("state")
        return {"ms": ms, "reported": v or "ok(no verification)", "error": False, "route": a.get("path"), "detail": json.dumps(a)[:300]}

    def can_escalate(self, action):
        return True

    def read(self):
        r, ms, n = self.o.op({"tool": "get_app_state", "app": self.app, "noScreenshot": True})
        if not r.get("ok"):
            return {"ms": ms, "chars": 0, "raw": n, "text": str(r.get("error")), "error": True}
        t = orca_tree_text(r["snapshot"])
        return {"ms": ms, "chars": len(t), "raw": n, "text": t, "error": False}


# ------------------------------------------------------------------ bench
class Bench:
    def __init__(self, args):
        self.args = args
        self.out = args.out
        os.makedirs(self.out, exist_ok=True)
        self.state = tempfile.mkdtemp(prefix="bench-state-")
        self.rows = []
        self.meta = {"os": platform.platform(), "target": args.target, "n": args.n, "image": os.environ.get("ImageOS"),
                     "image_version": os.environ.get("ImageVersion"), "python": sys.version.split()[0], "started": time.time()}
        self.logf = open(os.path.join(self.out, "engines.log"), "ab")
        self.procs = []
        self.t_start = time.time()

    # -- setup
    def spawn(self, cmd, env=None, **kw):
        p = subprocess.Popen(cmd, env=env, stdout=self.logf, stderr=self.logf, **kw)
        self.procs.append(p)
        return p

    def wait_window(self, pid, title=None, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            if WIN:
                h = obs.find_window(pid=pid, title=title)
            else:
                h = obs.find_client(pid, title)
            if h:
                return h
            time.sleep(0.25)
        return 0

    def launch_target(self):
        a = self.args
        env = dict(os.environ)
        if a.target == "fixture":
            if WIN:
                p = self.spawn(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File",
                                os.path.join(HERE, "fixture_win.ps1"), "-StateDir", self.state], creationflags=0x08000000)
            else:
                p = self.spawn(["python3", os.path.join(HERE, "fixture_gtk.py"), self.state])
            self.tpid = p.pid
            self.tw = self.wait_window(p.pid, "BenchTarget")
            self.target = FileTarget("fixture", self.state)
        elif a.target == "electron":
            env["BENCH_STATE_DIR"] = self.state
            flags = ["--force-renderer-accessibility"] + ([] if WIN else ["--no-sandbox"])
            p = self.spawn([a.electron, *flags, os.path.join(HERE, "electron", "main.js")], env=env)
            self.tpid = p.pid
            self.tw = self.wait_window(p.pid, "BenchElectron")
            self.target = FileTarget("electron", self.state)
        else:
            doc = os.path.join(self.state, "bench-doc.txt")
            with open(doc, "w") as f:
                f.write("seed")
            if WIN:
                p = self.spawn(["notepad.exe", doc])
                self.tpid = p.pid
                self.tw = self.wait_window(p.pid, timeout=15)
                if not self.tw:
                    self.tw = obs.find_window(cls="Notepad") or obs.find_window(title="bench-doc")
                    self.tpid = obs.pid_of(self.tw) if self.tw else p.pid
                self.target = NotepadTarget(self.tw)
                self.meta["notepad"] = {**obs.describe(self.tw), "edit_class": obs.class_of(self.target.edit)}
            else:
                p = self.spawn(["gedit", "--standalone", doc])
                self.tpid = p.pid
                self.tw = self.wait_window(p.pid)
                self.target = GeditTarget(p.pid)
                self.meta["gedit"] = subprocess.run(["gedit", "--version"], capture_output=True, text=True).stdout.strip()
        if not self.tw:
            raise RuntimeError("target window never appeared")
        time.sleep(2.0)
        obs.place(self.tw, 60, 60, 760, 560)
        time.sleep(0.5)

    def launch_sentinel(self):
        self.sent_path = os.path.join(self.state, "sentinel.json")
        py = sys.executable if WIN else "python3"
        p = self.spawn([py, os.path.join(HERE, "sentinel.py"), self.sent_path, "880x660+20+20"])
        self.spid = p.pid
        self.sw = self.wait_window(p.pid, "BenchSentinel")
        if not self.sw:
            raise RuntimeError("sentinel window never appeared")
        time.sleep(1.0)
        ok = obs.force_foreground(self.sw)
        self.meta["sentinel_front_at_start"] = ok
        if not WIN:
            d = obs.main_display()
            focus = d.focus()
            self.meta["x11_start"] = {"active": d.active(), "focus": focus, "focus_in_sentinel": focus in d.descendants(self.sw),
                                      "stacking": d.stacking(), "sentinel": self.sw, "target": self.tw}
        self.typer = obs.Typer()
        self.typer.start()
        time.sleep(1.0)

    def sent_counts(self):
        s = jread(self.sent_path)
        return s.get("q", 0), s.get("other", 0)

    def sync(self, timeout=0.6):
        end = time.time() + timeout
        s0 = self.typer.sent
        while time.time() < end:
            q, o = self.sent_counts()
            if q >= s0:
                break
            time.sleep(0.02)
        return self.typer.sent, *self.sent_counts()

    def ensure_front(self):
        if WIN:
            if obs.foreground() == self.sw and not obs.owned_above(self.sw, self.tpid):
                return False
        else:
            d = obs.main_display()
            st = d.stacking()
            tws = d.windows_of(self.tpid) or [self.tw]
            if d.active() == self.sw and (self.sw in st and all(st.index(w) < st.index(self.sw) for w in tws if w in st)):
                return False
        obs.force_foreground(self.sw)
        time.sleep(0.15)
        return True

    # -- trials
    def trial(self, engine, action, refs, escalate, i):
        prepared = self.target.prepare(action)
        refronted = self.ensure_front()
        sent0, q0, o0 = self.sync()
        stray0 = self.target.stray()
        sm = obs.Sampler(self.sw, self.tw, self.tpid)
        sm.start()
        t0 = now()
        try:
            if action == "_idle":
                time.sleep(0.6)
                res = {"ms": 600, "reported": "-", "error": False}
            elif action == "_steal":
                obs.force_foreground(self.tw)
                res = {"ms": now() - t0, "reported": "-", "error": False}
            else:
                res = engine.act(action, refs, escalate)
        except Exception as e:  # noqa: BLE001 - a crashed call is a data point
            res = {"ms": now() - t0, "reported": "exception", "error": True, "detail": repr(e)[:300]}
        t_call = now() - t0
        delivered, t_eff = False, None
        if not action.startswith("_"):
            while now() < t0 + t_call + POLL_MS:
                try:
                    if self.target.check(action):
                        delivered, t_eff = True, now() - t0
                        break
                except Exception:
                    pass
                time.sleep(0.01)
        while now() < t0 + t_call + SETTLE_MS:
            time.sleep(0.01)
        o = sm.stop()
        end = time.time() + 0.6
        while time.time() < end:
            q1, o1 = self.sent_counts()
            if q1 - q0 >= self.typer.sent - sent0:
                break
            time.sleep(0.02)
        sent1 = self.typer.sent
        q1, o1 = self.sent_counts()
        row = {
            "engine": engine.name + ("+escalated" if escalate else "") if engine else "control", "action": action, "i": i,
            "delivered": delivered, "t_call_ms": round(t_call, 1), "t_effect_ms": round(t_eff, 1) if t_eff else None,
            "reported": res.get("reported"), "error": res.get("error"), "route": res.get("route"), "code": res.get("code"),
            "detail": res.get("detail"), "prepared": prepared, "refronted_before": refronted,
            "keys_sent": sent1 - sent0, "keys_received": q1 - q0, "keys_lost": max(0, (sent1 - sent0) - (q1 - q0)),
            "keys_redirected_into_target": max(0, self.target.stray() - stray0), "agent_text_in_sentinel": o1 - o0,
            **o, "target_state": self._tstate(),
        }
        self.rows.append(row)
        return row

    def _tstate(self):
        try:
            return self.target.snapshot_state()
        except Exception as e:  # noqa: BLE001
            return {"error": repr(e)[:120]}

    def group(self, engine, action, refs, escalate=False, n=None):
        n = n or self.args.n
        rows = [self.trial(engine, action, refs, escalate, i) for i in range(n)]
        summarize_print(rows)
        return rows

    def resolve_refs(self, engine):
        sels = SEL[self.args.target]
        end = time.time() + 20
        while True:
            engine.snapshot()
            refs = {k: engine.ref(v) for k, v in sels.items()}
            missing = [k for k, v in refs.items() if not v and k != "menu_item"]
            if not missing or time.time() > end:
                return refs, missing
            time.sleep(1.0)

    def run_engine(self, engine):
        refs, missing = self.resolve_refs(engine)
        self.meta.setdefault("missing_elements", {})[engine.name] = missing
        with open(os.path.join(self.out, f"elements_{engine.name}.json"), "w") as f:
            json.dump(engine.elements, f, indent=1, default=str)
        log(f"[{engine.name}] refs: " + ", ".join(f"{k}={'ok' if v else 'MISSING'}" for k, v in refs.items()))
        for action in ACTIONS[self.args.target]:
            if self.over_budget():
                log("budget exhausted; skipping", engine.name, action)
                self.meta.setdefault("skipped", []).append(f"{engine.name}:{action}")
                continue
            rows = self.group(engine, action, refs)
            if sum(r["delivered"] for r in rows) < len(rows) and engine.can_escalate(action):
                self.group(engine, action, refs, escalate=True, n=max(5, self.args.n // 2))
        self.snapshot_bench(engine)

    def snapshot_bench(self, engine):
        reads = []
        for i in range(self.args.n):
            self.ensure_front()
            sm = obs.Sampler(self.sw, self.tw, self.tpid)
            sm.start()
            r = engine.read()
            o = sm.stop()
            reads.append({**{k: v for k, v in r.items() if k != "text"}, **o})
            if i == 0:
                with open(os.path.join(self.out, f"snapshot_{engine.name}.txt"), "w", encoding="utf-8") as f:
                    f.write(r["text"])
        extra = engine.read_full() if hasattr(engine, "read_full") else None
        self.meta.setdefault("snapshots", {})[engine.name] = {
            "median_ms": round(statistics.median(x["ms"] for x in reads), 1),
            "median_chars": statistics.median(x["chars"] for x in reads),
            "median_raw_bytes": statistics.median(x["raw"] for x in reads),
            "errors": sum(x["error"] for x in reads),
            "lost_focus": sum(x["sentinel_lost_focus"] for x in reads), "raised": sum(x["target_raised"] for x in reads),
            "full_output": extra,
        }
        log(f"[{engine.name}] snapshot", self.meta["snapshots"][engine.name])

    def over_budget(self):
        return time.time() - self.t_start > self.args.budget

    def run(self):
        a = self.args
        self.meta["cua_version"] = subprocess.run([a.cua, "--version"], capture_output=True, text=True).stdout.strip()
        if WIN:
            self.meta["foreground_lock_timeout_ms"] = obs.lock_timeout()
            self.meta["session_id"] = obs.session_id()
        try:
            dr = subprocess.run([a.cua, "doctor"], capture_output=True, text=True, timeout=90,
                                env={**os.environ, "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0", "DO_NOT_TRACK": "1", "CUA_DRIVER_RS_UPDATE_CHECK": "0"})
            with open(os.path.join(self.out, "cua-doctor.txt"), "w", encoding="utf-8") as f:
                f.write(dr.stdout + "\n--- stderr\n" + dr.stderr)
        except Exception as e:  # noqa: BLE001
            self.meta["doctor_error"] = repr(e)
        self.launch_target()
        self.launch_sentinel()
        self.meta["windows"] = {"target": self.tw, "sentinel": self.sw, "target_pid": self.tpid}
        if WIN:
            self.meta["windows"].update({"target_desc": obs.describe(self.tw), "sentinel_desc": obs.describe(self.sw)})
        log("target", self.tw, "sentinel", self.sw, "front", self.meta["sentinel_front_at_start"])
        self.group(None, "_idle", {}, n=5)
        self.group(None, "_steal", {}, n=3)
        orca = (OrcaWin if WIN else OrcaLinux)(self.logf)
        self.meta["orca_startup_ms"] = orca.startup_ms
        try:
            self.run_engine(OrcaEngine(orca, self.tpid))
        except Exception as e:  # noqa: BLE001
            log("orca engine failed:", repr(e))
            self.meta["orca_error"] = repr(e)
        finally:
            orca.close()
        home = tempfile.mkdtemp(prefix="cua-home-")
        cua = Cua(a.cua, home, self.logf)
        self.meta["cua_startup_ms"] = cua.startup_ms
        self.meta["cua_server_info"] = cua.server_info
        try:
            wins = cua_sc(cua.call("list_windows", {"pid": self.tpid})).get("windows") or []
            self.meta["cua_windows"] = wins[:5]
            wid = next((w.get("window_id") for w in wins if w.get("window_id") is not None
                        and ("Bench" in str(w.get("title")) or "bench-doc" in str(w.get("title")) or "Notepad" in str(w.get("title")))),
                       wins[0].get("window_id") if wins else None)
            self.run_engine(CuaEngine(cua, self.tpid, wid))
        except Exception as e:  # noqa: BLE001
            log("cua engine failed:", repr(e))
            self.meta["cua_error"] = repr(e)
        finally:
            cua.close()
        self.group(None, "_idle", {}, n=5)

    def finish(self):
        self.typer.stop() if hasattr(self, "typer") else None
        for p in self.procs:
            try:
                p.kill()
            except Exception:
                pass
        self.meta["elapsed_s"] = round(time.time() - self.t_start, 1)
        summary = summarize(self.rows)
        with open(os.path.join(self.out, "results.json"), "w") as f:
            json.dump({"meta": self.meta, "summary": summary, "rows": self.rows}, f, indent=1, default=str)
        md = markdown(self.meta, summary)
        with open(os.path.join(self.out, "summary.md"), "w", encoding="utf-8") as f:
            f.write(md)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
                f.write(md + "\n")
        log(md)


# ------------------------------------------------------------------ reporting
def summarize(rows):
    groups = {}
    for r in rows:
        groups.setdefault((r["engine"], r["action"]), []).append(r)
    out = []
    for (eng, act), rs in groups.items():
        calls = [r["t_call_ms"] for r in rs]
        effs = [r["t_effect_ms"] for r in rs if r["t_effect_ms"]]
        rep = {}
        for r in rs:
            k = f'{r["reported"]}/{"Y" if r["delivered"] else "N"}'
            rep[k] = rep.get(k, 0) + 1
        out.append({
            "engine": eng, "action": act, "n": len(rs), "delivered": sum(r["delivered"] for r in rs),
            "call_ms": round(statistics.median(calls), 1), "effect_ms": round(statistics.median(effs), 1) if effs else None,
            "lost_focus": sum(r["sentinel_lost_focus"] for r in rs), "lost_ms_max": max(r["lost_ms"] for r in rs),
            "raised": sum(r["target_raised"] for r in rs), "activated": sum(r["target_activated"] for r in rs),
            "keys_lost": sum(r["keys_lost"] for r in rs), "keys_sent": sum(r["keys_sent"] for r in rs),
            "keys_redirected": sum(r["keys_redirected_into_target"] for r in rs),
            "agent_text_in_sentinel": sum(r["agent_text_in_sentinel"] for r in rs),
            "pointer_moved": sum(r["pointer_moved"] for r in rs), "clipboard_changed": sum(r["clipboard_changed"] for r in rs),
            "primary_changed": sum(r.get("primary_changed", False) for r in rs),
            "reported": rep, "routes": sorted({str(r["route"]) for r in rs}),
            "example": next((r["detail"] for r in rs if r.get("detail")), None),
        })
    return out


def summarize_print(rows):
    s = summarize(rows)[0]
    log(f'{s["engine"]:<16} {s["action"]:<16} ok {s["delivered"]}/{s["n"]} call {s["call_ms"]} eff {s["effect_ms"]} '
        f'lost {s["lost_focus"]} raised {s["raised"]} keysLost {s["keys_lost"]}/{s["keys_sent"]} redir {s["keys_redirected"]} '
        f'leak {s["agent_text_in_sentinel"]} ptr {s["pointer_moved"]} clip {s["clipboard_changed"]} rep {s["reported"]} | {str(s["example"])[:160]}')


def markdown(meta, summary):
    osn = "Windows" if WIN else "Linux"
    lines = [f"## {osn} / {meta['target']}", "",
             f"cua `{meta.get('cua_version')}`, image `{meta.get('image')} {meta.get('image_version')}`, n={meta['n']}, elapsed {meta.get('elapsed_s')} s", ""]
    for k in ("foreground_lock_timeout_ms", "session_id", "sentinel_front_at_start", "orca_startup_ms", "cua_startup_ms",
              "missing_elements", "orca_error", "cua_error", "skipped", "notepad", "gedit"):
        if k in meta:
            lines.append(f"- {k}: `{json.dumps(meta[k], default=str)}`")
    lines += ["", "| action | engine | delivered | call ms | effect ms | sentinel lost focus (max ms) | target raised | user keys lost / sent | keys into target | agent text in sentinel | pointer moved | clipboard changed | reported/delivered |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in sorted(summary, key=lambda s: (s["action"], s["engine"])):
        rep = ", ".join(f"{k}×{v}" for k, v in s["reported"].items())
        lines.append(f'| {s["action"]} | {s["engine"]} | {s["delivered"]}/{s["n"]} | {s["call_ms"]} | {s["effect_ms"] if s["effect_ms"] is not None else "–"} | '
                     f'{s["lost_focus"]} ({s["lost_ms_max"]}) | {s["raised"]} | {s["keys_lost"]}/{s["keys_sent"]} | {s["keys_redirected"]} | '
                     f'{s["agent_text_in_sentinel"]} | {s["pointer_moved"]} | {s["clipboard_changed"]} | {rep} |')
    snaps = meta.get("snapshots") or {}
    if snaps:
        lines += ["", "| snapshot | median ms | median chars | median raw bytes | full_output chars | lost focus | raised |", "|---|---|---|---|---|---|---|"]
        for eng, v in snaps.items():
            fo = (v.get("full_output") or {}).get("chars", "–")
            lines.append(f'| {eng} | {v["median_ms"]} | {v["median_chars"]} | {v["median_raw_bytes"]} | {fo} | {v["lost_focus"]} | {v["raised"]} |')
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["fixture", "editor", "electron"], required=True)
    ap.add_argument("--cua", required=True)
    ap.add_argument("--electron")
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--budget", type=int, default=840, help="seconds before remaining groups are skipped")
    b = Bench(ap.parse_args())
    try:
        b.run()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        b.meta["fatal"] = repr(e)
    finally:
        b.finish()


if __name__ == "__main__":
    main()
