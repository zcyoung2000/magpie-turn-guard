#!/usr/bin/env python3
"""Native compaction at idle boundaries via Codex's public proxy command."""

import argparse
import base64
from collections import deque
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid


DEFAULTS = {"enabled": True, "allowedModels": ["xingchi/gpt-6.1-sol"],
            "userThreshold": 18, "modelThreshold": 90,
            "idleWaitSeconds": 60, "compactTimeoutSeconds": 270,
            "idleGraceSeconds": 0.5, "retryCooldownSeconds": 30,
            "codexBinary": "codex", "socketPath": None}
SESSION = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def data_root():
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    root = Path(os.environ.get("TURN_GUARD_DATA", str(home / "magpie-turn-guard")))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


def load_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def atomic_json(path, value):
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("x", encoding="utf-8") as handle:
            os.chmod(tmp, 0o600)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def settings():
    return {**DEFAULTS, **load_json(data_root() / "settings.json", {})}


@contextlib.contextmanager
def state(session):
    if not isinstance(session, str) or not SESSION.fullmatch(session):
        raise ValueError("Invalid session ID")
    root = data_root()
    path = root / (session + ".json")
    with (root / (session + ".lock")).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        value = load_json(path, {"session": session, "users": 0, "models": 0,
                                 "generation": 0, "rootTurns": [], "transport": "unverified"})
        yield value
        value["updatedAt"] = time.time()
        atomic_json(path, value)


def journal(session, event, **details):
    line = {"time": time.time(), "session": session, "event": event, **details}
    # One short write under a file lock; never log prompts, credentials or wire bodies.
    path = data_root() / "events.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        os.chmod(path, 0o600)
        handle.write(json.dumps(line, ensure_ascii=False) + "\n")


class RpcError(RuntimeError):
    pass


class ProxyClient:
    """WebSocket JSON-RPC over the byte-stream `app-server proxy` command.

    The Unix App Server listener uses HTTP Upgrade and WebSocket framing.
    The CLI proxy transports bytes; it is not a JSONL-to-WebSocket adapter.
    """

    def __init__(self, config):
        binary = shutil.which(config["codexBinary"])
        if not binary:
            raise RpcError("Codex CLI is not on PATH")
        command = [binary, "app-server", "proxy"]
        if config.get("socketPath"):
            command += ["--sock", config["socketPath"]]
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.inbox = queue.Queue()
        self.pending = deque(maxlen=2048)
        self.serial = 0
        self.write_lock = threading.Lock()
        self.key = base64.b64encode(os.urandom(16)).decode()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        request = ("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                   "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                   "Sec-WebSocket-Key: " + self.key + "\r\n\r\n")
        try:
            self.process.stdin.write(request.encode())
            self.process.stdin.flush()
            item = self._receive(4)
            if item != {"upgraded": True}:
                raise RpcError("Shared App Server did not accept the connection")
            self.call("initialize", {"clientInfo": {
                "name": "magpie_turn_guard", "version": "0.1.1",
            }}, timeout=4)
            self.send({"method": "initialized", "params": {}})
        except Exception:
            self.close()
            raise

    def _exact(self, size):
        output = bytearray()
        while len(output) < size:
            part = self.process.stdout.read(size - len(output))
            if not part:
                raise EOFError("Shared App Server connection closed")
            output.extend(part)
        return bytes(output)

    def _read(self):
        try:
            header = bytearray()
            while not header.endswith(b"\r\n\r\n"):
                if len(header) > 16384:
                    raise RpcError("Invalid WebSocket handshake")
                header.extend(self._exact(1))
            text = header.decode("latin-1")
            accept = base64.b64encode(hashlib.sha1(
                (self.key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            headers = {line.split(":", 1)[0].lower(): line.split(":", 1)[1].strip()
                       for line in text.split("\r\n")[1:] if ":" in line}
            if " 101 " not in text.split("\r\n", 1)[0] or headers.get("sec-websocket-accept") != accept:
                raise RpcError("Shared App Server rejected WebSocket upgrade")
            self.inbox.put({"upgraded": True})
            fragments = bytearray()
            while True:
                first, second = self._exact(2)
                opcode, size = first & 15, second & 127
                if size == 126:
                    size = struct.unpack("!H", self._exact(2))[0]
                elif size == 127:
                    size = struct.unpack("!Q", self._exact(8))[0]
                if size > 64 * 1024 * 1024:
                    raise RpcError("Oversized App Server frame")
                mask = self._exact(4) if second & 128 else None
                payload = self._exact(size)
                if mask:
                    payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
                if opcode == 8:
                    raise EOFError("Shared App Server closed the WebSocket")
                if opcode == 9:
                    self._frame(payload, opcode=10)
                    continue
                if opcode == 10:
                    continue
                if opcode not in (0, 1):
                    raise RpcError("Unexpected App Server frame")
                fragments.extend(payload)
                if len(fragments) > 64 * 1024 * 1024:
                    raise RpcError("Oversized App Server message")
                if first & 128:
                    self.inbox.put(json.loads(fragments))
                    fragments.clear()
        except Exception as exc:
            self.inbox.put(RpcError(str(exc)))

    def _frame(self, payload, opcode=1):
        size = len(payload)
        head = bytes([128 | opcode])
        if size < 126:
            head += bytes([128 | size])
        elif size < 65536:
            head += bytes([128 | 126]) + struct.pack("!H", size)
        else:
            head += bytes([128 | 127]) + struct.pack("!Q", size)
        mask = os.urandom(4)
        encoded = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        with self.write_lock:
            self.process.stdin.write(head + mask + encoded)
            self.process.stdin.flush()

    def send(self, message):
        self._frame(json.dumps(message).encode())

    def _receive(self, timeout):
        try:
            item = self.inbox.get(timeout=max(0.001, timeout))
        except queue.Empty:
            raise RpcError("Shared App Server did not respond before the timeout") from None
        if isinstance(item, Exception):
            raise item
        if "id" in item and "method" in item:
            # This controller never executes tools or grants approvals.
            self.send({"id": item["id"], "error": {
                "code": -32601, "message": "Turn Guard is a compaction controller only",
            }})
        return item

    def call(self, method, params, timeout=5):
        self.serial += 1
        serial = self.serial
        self.send({"id": serial, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            item = self._receive(deadline - time.monotonic())
            if item.get("id") == serial and "method" not in item:
                if "error" in item:
                    raise RpcError(method + ": " + str(item["error"].get("message", "failed")))
                return item.get("result")
            if "method" in item and "id" not in item:
                self.pending.append(item)
        raise RpcError(method + " timed out")

    def notification(self, timeout):
        if self.pending:
            return self.pending.popleft()
        return self._receive(timeout)

    def close(self):
        with contextlib.suppress(OSError):
            self.process.stdin.close()
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        self.reader.join(timeout=1)
        self.process.stdout.close()


def runtime_status(thread):
    value = thread.get("status")
    return value.get("type") if isinstance(value, dict) else value


def due(value, config):
    return value.get("users", 0) >= config["userThreshold"] or value.get("models", 0) >= config["modelThreshold"]


def model_allowed(model, config):
    allowed = config.get("allowedModels")
    return isinstance(model, str) and isinstance(allowed, list) and model in allowed


def skip_model(session, model):
    with state(session) as value:
        value.update(model=model, phase="skipped_model")
    return {"status": "skipped_model", "model": model}


def run_worker(session, force=False):
    config = settings()
    if not config["enabled"] and not force:
        return {"status": "disabled"}
    with (data_root() / (session + ".worker.lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "already_running"}
        with state(session) as value:
            if not model_allowed(value.get("model"), config):
                value["phase"] = "skipped_model"
                return {"status": "skipped_model", "model": value.get("model")}
            if not force and not due(value, config):
                return {"status": "below_threshold"}
            generation = value["generation"]
            value["phase"] = "waiting_for_idle"
        client = None
        requested = False
        try:
            client = ProxyClient(config)
            deadline = time.monotonic() + config["idleWaitSeconds"]
            idle_since = None
            while time.monotonic() < deadline:
                thread = client.call("thread/read", {"threadId": session})["thread"]
                observed = runtime_status(thread)
                if observed in ("notLoaded", "not_loaded", None):
                    raise RpcError("Session is not loaded in this shared App Server; refusing a sidecar resume")
                if not model_allowed(thread.get("model"), settings()):
                    return skip_model(session, thread.get("model"))
                if observed == "idle":
                    if idle_since is None:
                        idle_since = time.monotonic()
                    if time.monotonic() - idle_since >= config["idleGraceSeconds"]:
                        break
                else:
                    idle_since = None
                time.sleep(0.15)
            else:
                with state(session) as value:
                    value.update(phase="deferred_busy", transport="connected")
                journal(session, "deferred_busy")
                return {"status": "deferred_busy"}
            # Attach only to a thread already loaded in THIS server, after
            # observing idle. Never start a second server or resume a rollout
            # into a server that does not own the live thread.
            client.call("thread/resume", {"threadId": session, "excludeTurns": True})
            thread = client.call("thread/read", {"threadId": session})["thread"]
            if runtime_status(thread) != "idle":
                with state(session) as value:
                    value.update(phase="deferred_busy", transport="connected")
                return {"status": "deferred_busy"}
            with state(session) as value:
                if value["generation"] != generation:
                    return {"status": "already_compacted"}
                if not settings()["enabled"] and not force:
                    value["phase"] = "disabled"
                    return {"status": "disabled"}
                config = settings()
                if not model_allowed(thread.get("model"), config) or not model_allowed(value.get("model"), config):
                    value.update(model=thread.get("model"), phase="skipped_model")
                    return {"status": "skipped_model", "model": thread.get("model")}
                value.update(phase="compacting", transport="connected", lastError=None)
            client.pending.clear()
            requested = True
            client.call("thread/compact/start", {"threadId": session})
            compact_turn = None
            checkpoint_complete = False
            deadline = time.monotonic() + config["compactTimeoutSeconds"]
            while time.monotonic() < deadline:
                event = client.notification(deadline - time.monotonic())
                params = event.get("params", {})
                if params.get("threadId") != session:
                    continue
                item = params.get("item", {})
                if item.get("type") == "contextCompaction":
                    compact_turn = params.get("turnId", compact_turn)
                    if event.get("method") == "item/completed":
                        checkpoint_complete = True
                if event.get("method") == "turn/completed":
                    turn = params.get("turn", {})
                    if compact_turn and turn.get("id") != compact_turn:
                        continue
                    if turn.get("status") != "completed" or not checkpoint_complete:
                        raise RpcError("Native compaction did not complete successfully")
                    with state(session) as value:
                        value.update(users=0, models=0, phase="idle", transport="connected",
                                     generation=max(value["generation"], generation + 1),
                                     lastCompactionAt=time.time(), lastError=None)
                    journal(session, "compaction_completed")
                    return {"status": "completed"}
            raise RpcError("Timed out waiting for the native compaction lifecycle")
        except Exception as exc:
            message = str(exc)[:500]
            phase = "failed" if requested else "unavailable"
            with state(session) as value:
                value.update(phase=phase, lastError=message, lastFailureAt=time.time(),
                             transport="unavailable" if client is None else "connected")
            journal(session, "compaction_" + phase, reason=message)
            return {"status": phase, "reason": message}
        finally:
            if client:
                client.close()


def hook(payload):
    session = payload.get("session_id")
    if not isinstance(session, str) or not SESSION.fullmatch(session):
        return {}
    config = settings()
    if not config["enabled"]:
        return {}
    event, turn = payload.get("hook_event_name"), payload.get("turn_id")
    model = payload.get("model")
    if not model_allowed(model, config):
        # Boundary hooks can invalidate a pending worker after a model switch.
        # Do not create counters or inject context for unrelated models, and
        # do not let a subagent's model-request event change the root model.
        if event in ("SessionStart", "UserPromptSubmit", "Stop") and (data_root() / (session + ".json")).exists():
            with state(session) as value:
                value["model"] = model
                if value.get("phase") != "compacting":
                    value["phase"] = "skipped_model"
        return {}
    launch = False
    output = {}
    with state(session) as value:
        if event == "PostModelRequest" and turn not in value.get("rootTurns", []):
            return {}
        value["model"] = model
        value["lastHook"] = event
        if event == "SessionStart":
            if payload.get("source") == "compact":
                value.update(users=0, models=0)
            elif not value.get("announced"):
                value["announced"] = True
                output = {"systemMessage": "Magpie Turn Guard: tracking enabled; native compaction is requested after idle turn boundaries. Shared-server connectivity is shown by the turn-guard status command."}
        elif event == "UserPromptSubmit" and turn:
            turns = value.setdefault("rootTurns", [])
            if turn not in turns:
                value["users"] += 1
                value["rootTurns"] = (turns + [turn])[-128:]
        elif event == "PostModelRequest":
            if payload.get("status") == "completed" and turn in value.get("rootTurns", []) and value.get("phase") != "compacting":
                value["models"] += 1
        elif event == "PostCompact":
            value.update(users=0, models=0, generation=value["generation"] + 1,
                         lastCompactionAt=time.time())
        elif event == "Stop" and turn in value.get("rootTurns", []):
            launch = (due(value, config) and
                      time.time() - value.get("lastFailureAt", 0) >= config["retryCooldownSeconds"])
            if launch:
                value["phase"] = "queued"
    if launch:
        # The parent turn must finish first. The detached worker observes the
        # server's live status instead of compacting synchronously in Stop.
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                          "worker", "--session", session],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True,
                         close_fds=True, cwd=str(Path(__file__).parent))
        journal(session, "compaction_queued")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("hook")
    commands.add_parser("status")
    configure = commands.add_parser("configure")
    configure.add_argument("--user-threshold", type=int)
    configure.add_argument("--model-threshold", type=int)
    configure.add_argument("--allow-model", action="append", metavar="MODEL",
                           help="Replace the exact model allowlist; repeat for multiple models")
    enabled = configure.add_mutually_exclusive_group()
    enabled.add_argument("--enabled", action="store_true")
    enabled.add_argument("--disabled", action="store_true")
    for name in ("worker", "compact"):
        commands.add_parser(name).add_argument("--session", required=True)
    args = parser.parse_args()
    if args.command == "hook":
        try:
            output = hook(json.load(sys.stdin))
        except Exception as exc:
            # Hook failures are advisory and never block the user's turn.
            output = {"systemMessage": "Magpie Turn Guard hook error: " + str(exc)[:240]}
        print(json.dumps(output, ensure_ascii=False))
        return
    if args.command == "status":
        sessions = [load_json(path, {}) for path in data_root().glob("*.json")
                    if path.name != "settings.json"]
        print(json.dumps({"settings": settings(), "dataDirectory": str(data_root()),
                          "sessions": sorted(sessions, key=lambda item: item.get("updatedAt", 0), reverse=True)[:20]}, ensure_ascii=False, indent=2))
    elif args.command == "configure":
        config = settings()
        if args.allow_model is not None:
            models = [model.strip() for model in args.allow_model]
            if not all(models):
                parser.error("allowed model names must not be empty")
            config["allowedModels"] = list(dict.fromkeys(models))
        for name, key in (("user_threshold", "userThreshold"), ("model_threshold", "modelThreshold")):
            value = getattr(args, name)
            if value is not None:
                if value < 1:
                    parser.error("thresholds must be positive integers")
                config[key] = value
        if args.enabled or args.disabled:
            config["enabled"] = args.enabled
        atomic_json(data_root() / "settings.json", config)
        print(json.dumps(config, indent=2))
    else:
        if not SESSION.fullmatch(args.session):
            parser.error("Invalid session ID")
        result = run_worker(args.session, force=args.command == "compact")
        print(json.dumps(result, ensure_ascii=False))
        if result["status"] in ("unavailable", "failed"):
            raise SystemExit(1)


if __name__ == "__main__":
    main()
