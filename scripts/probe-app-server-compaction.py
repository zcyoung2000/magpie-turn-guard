#!/usr/bin/env python3
"""Exercise native compaction through a real, isolated Codex App Server.

All inference goes to a loopback fixture. HOME, CODEX_HOME, XDG directories,
credentials, config, history and the working directory are temporary. This
does not connect to, compact, or change any existing client session.

The cap cases count expanded, unmerged fixture input. They do not execute
Magpie's message merging and cannot establish its final upstream user count.
"""

import argparse
import contextlib
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time


OLD_ASSISTANT = "RAW_ASSISTANT_HISTORY_BEFORE_COMPACTION"
SUMMARY = "SUMMARY_CHECKPOINT_READY: continue the fixture task and reply PROBE_OK."


def input_stats(items):
    """Count expanded, unmerged fixture items, not final Magpie wire messages."""
    users = turns = 0
    in_turn = False
    for item in items:
        kind, role = item.get("type"), item.get("role")
        if role == "user" or kind in ("compaction", "compaction_summary"):
            users += 1
            in_turn = False
        elif role == "assistant" or kind in (
            "reasoning", "function_call", "custom_tool_call", "tool_search_call"
        ):
            if not in_turn:
                turns += 1
                in_turn = True
        elif role in ("system", "developer") or kind in (
            "function_call_output", "custom_tool_call_output", "tool_search_output"
        ):
            in_turn = False
    return {"users": users, "turns": turns}


def is_compaction(body):
    # Check the final user message, not arbitrary historical text: a completed
    # summary can itself quote the compaction prompt.
    items = body.get("input", [])
    if any(item.get("type") == "compaction_trigger" for item in items):
        return True
    users = [item for item in items if item.get("role") == "user"]
    text = json.dumps(users[-1] if users else {}).lower()
    return "context checkpoint" in text or "compacting a conversation" in text


class Fixture:
    def __init__(self, protocol):
        self.protocol = protocol
        self.phase = "seed"
        self.records = []
        self.fail_compaction = False
        self.enforce_caps = False
        self.tool_sent = False
        self.continuation_started = threading.Event()
        self.release_continuation = threading.Event()
        self.compaction_started = threading.Event()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                try:
                    self.respond()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when compaction cancels an active turn.

            def respond(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                compact = is_compaction(body)
                record = {
                    "phase": owner.phase, "path": self.path,
                    "compaction": compact, "body": body,
                    "stats": input_stats(body.get("input", [])),
                    "time": time.monotonic(),
                }
                # Expansion-only simulation. Magpie's real translated path can
                # also merge adjacent user messages; this fixture does not.
                if any(item.get("type") == "compaction_trigger"
                       for item in body.get("input", [])):
                    record["stats"]["users"] += 1
                owner.records.append(record)
                if compact:
                    owner.compaction_started.set()
                if owner.enforce_caps and (
                    record["stats"]["users"] > 20 or record["stats"]["turns"] > 100
                ):
                    record["rejected"] = "fixture_input_cap"
                elif compact and owner.fail_compaction:
                    record["rejected"] = "fixture_compaction_failure"
                if record.get("rejected"):
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": {
                        "type": "invalid_request_error",
                        "code": record["rejected"],
                        "message": "isolated compaction fixture: " + record["rejected"],
                    }}).encode())
                    return

                tool = owner.phase == "busy" and not compact and not owner.tool_sent
                if tool:
                    owner.tool_sent = True
                elif owner.phase == "busy" and not compact:
                    owner.continuation_started.set()
                    if not owner.release_continuation.wait(15):
                        raise TimeoutError("fixture continuation was not released")

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def emit(kind, **fields):
                    event = {"type": kind, **fields}
                    self.wfile.write(("event: " + kind + "\ndata: " +
                                      json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()

                number = len(owner.records)
                response = {
                    "id": f"resp_app_probe_{number}", "object": "response",
                    "model": body["model"], "status": "in_progress", "output": [],
                }
                emit("response.created", response=response)
                if tool:
                    item = {
                        "id": f"fc_app_probe_{number}", "type": "function_call",
                        "status": "completed", "call_id": f"call_app_probe_{number}",
                        "name": "update_plan", "arguments": json.dumps({"plan": [{
                            "step": "Exercise isolated app-server continuation",
                            "status": "in_progress",
                        }]}),
                    }
                    emit("response.output_item.added", output_index=0, item=item)
                    emit("response.output_item.done", output_index=0, item=item)
                elif compact and owner.protocol == "v2":
                    # Opaque fixture data only: this tests the client's protocol
                    # and history installation, not model summary quality.
                    item = {
                        "id": f"cmp_app_probe_{number}", "type": "compaction",
                        "encrypted_content": "fixture-not-real-ciphertext:" + SUMMARY,
                    }
                    emit("response.output_item.added", output_index=0, item=item)
                    emit("response.output_item.done", output_index=0, item=item)
                else:
                    text = SUMMARY if compact else OLD_ASSISTANT + " PROBE_OK"
                    item = {
                        "id": f"msg_app_probe_{number}", "type": "message",
                        "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": text,
                                     "annotations": []}],
                    }
                    emit("response.output_item.added", output_index=0,
                         item={**item, "content": []})
                    emit("response.output_text.delta", output_index=0, content_index=0,
                         item_id=item["id"], delta=text)
                    emit("response.output_item.done", output_index=0, item=item)
                emit("response.completed", response={
                    **response, "status": "completed", "output": [item],
                    "usage": {"input_tokens": 100, "output_tokens": 10,
                              "total_tokens": 110},
                })

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.release_continuation.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class AppServer:
    def __init__(self, binary, root, fixture, label="primary"):
        self.root = root
        self.events = []
        self.inbox = queue.Queue()
        self.serial = 0
        codex_home, home, work = root / "codex", root / "home", root / "work"
        for path in (codex_home, home, work):
            path.mkdir(parents=True, exist_ok=True)
        # An allowlist avoids inheriting API keys, app session handles and agent
        # runtime settings. These processes have no real model credentials.
        env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL")
               if key in os.environ}
        env.update({"HOME": str(home), "CODEX_HOME": str(codex_home),
                    "XDG_CONFIG_HOME": str(home / ".config"),
                    "XDG_DATA_HOME": str(home / ".local/share"),
                    "XDG_CACHE_HOME": str(home / ".cache")})
        config = {
            "model": "gpt-5.4", "model_provider": "probe",
            "model_providers.probe.name": "Isolated app-server probe",
            "model_providers.probe.base_url":
                f"http://127.0.0.1:{fixture.server.server_port}/v1",
            "model_providers.probe.wire_api": "responses",
            "model_providers.probe.requires_openai_auth": False,
            "model_providers.probe.supports_websockets": False,
            "model_providers.probe.stream_max_retries": 0,
            "model_providers.probe.request_max_retries": 0,
            "model_context_window": 200000,
            "model_auto_compact_token_limit": 180000,
            "analytics.enabled": False, "feedback.enabled": False,
            "approval_policy": "never", "sandbox_mode": "read-only",
        }
        if fixture.protocol == "v2":
            config["model_providers.probe.capabilities.remote_compaction"] = "v2"
        command = [binary, "app-server", "--listen", "stdio://"]
        for key, value in config.items():
            command += ["-c", key + "=" + json.dumps(value)]
        self.log = (root / (label + ".stderr.log")).open("w")
        self.proc = subprocess.Popen(command, cwd=work, env=env, text=True,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.log, bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.rpc("initialize", {"clientInfo": {
            "name": "turn_guard_probe", "version": "0.1.0",
        }})
        self.send({"method": "initialized", "params": {}})

    def _read(self):
        for line in self.proc.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                message = {"nonJsonOutput": line.rstrip()}
            self.events.append(message)
            self.inbox.put(message)
        self.inbox.put({"processExited": True})

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def wait(self, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("app-server event timeout")
            try:
                message = self.inbox.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("app-server event timeout") from None
            if message.get("processExited"):
                raise RuntimeError("app-server exited; inspect its stderr log")
            if "id" in message and "method" in message:
                # The fixture uses update_plan only, so approvals and external
                # calls are unexpected and must not be accepted silently.
                self.send({"id": message["id"], "error": {
                    "code": -32601, "message": "isolated fixture rejects server calls",
                }})
            if predicate(message):
                return message

    def rpc(self, method, params):
        self.serial += 1
        serial = self.serial
        self.send({"id": serial, "method": method, "params": params})
        message = self.wait(lambda event: event.get("id") == serial)
        if "error" in message:
            raise RuntimeError(method + ": " + json.dumps(message["error"]))
        return message.get("result")

    def start_thread(self):
        result = self.rpc("thread/start", {
            "cwd": str(self.root / "work"), "model": "gpt-5.4",
            "modelProvider": "probe", "sandbox": "read-only",
            "approvalPolicy": "never", "baseInstructions": "Run the local probe.",
            "developerInstructions": "Reply PROBE_OK. Use update_plan if requested.",
        })
        return result["thread"]["id"]

    def start_turn(self, thread_id, text):
        return self.rpc("turn/start", {"threadId": thread_id, "input": [
            {"type": "text", "text": text},
        ]})["turn"]["id"]

    def finish_turn(self, turn_id=None):
        return self.wait(lambda event: event.get("method") == "turn/completed" and
                         (turn_id is None or
                          event.get("params", {}).get("turn", {}).get("id") == turn_id))

    def turn(self, thread_id, text):
        return self.finish_turn(self.start_turn(thread_id, text))

    def compact(self, thread_id):
        start = len(self.events)
        ack = self.rpc("thread/compact/start", {"threadId": thread_id})
        done = self.finish_turn()
        return {"ack": ack, "completion": done, "events": self.events[start:]}

    def close(self):
        with contextlib.suppress(BrokenPipeError, OSError):
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        self.reader.join(timeout=3)
        self.proc.stdout.close()
        self.log.close()


def checkpoints(root):
    entries = []
    for path in (root / "codex/sessions").rglob("*.jsonl"):
        for line in path.read_text().splitlines():
            entry = json.loads(line)
            if entry.get("type") == "compacted":
                entries.append(entry)
    return entries


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run_case(binary, mode, root, protocol):
    root.mkdir(parents=True)
    fixture = Fixture(protocol)
    app = sidecar = None
    result = {"case": mode, "protocol": protocol,
              "counting_scope": "expanded_unmerged_fixture_not_magpie_upstream"}
    try:
        app = AppServer(binary, root, fixture)
        thread_id = app.start_thread()
        fixture.enforce_caps = mode in ("user_cap", "user_cap_early")
        seed_count = {"user_cap": 19, "user_cap_early": 17}.get(mode, 3)
        for number in range(seed_count):
            event = app.turn(thread_id, f"OLD_USER_{number}: continue the probe.")
            require(event["params"]["turn"]["status"] == "completed", "seed failed")

        if mode == "busy":
            fixture.phase = "busy"
            active_turn = app.start_turn(thread_id, "Exercise update_plan, then finish.")
            require(fixture.continuation_started.wait(10), "did not reach tool continuation")
            start = len(app.events)
            ack = app.rpc("thread/compact/start", {"threadId": thread_id})
            started_while_blocked = fixture.compaction_started.wait(1)
            fixture.release_continuation.set()
            # Observe both the original turn and the compaction turn. Acks are
            # not evidence that either operation succeeded or that work resumed.
            app.wait(lambda event: event.get("method") == "item/completed" and
                     event.get("params", {}).get("item", {}).get("type") ==
                     "contextCompaction")
            compact_done = app.finish_turn()
            observed = app.events[start:]
            completions = [event["params"]["turn"] for event in observed
                           if event.get("method") == "turn/completed"]
            require(any(turn["id"] == active_turn and turn["status"] == "interrupted"
                        for turn in completions),
                    "active turn was not interrupted as expected; inspect changed behavior")
            require(compact_done["params"]["turn"]["status"] == "completed",
                    "busy compaction failed")
            require(any(item.get("type") == "function_call_output"
                        for record in fixture.records
                        for item in record["body"].get("input", [])),
                    "fixture did not reach an actual tool continuation")
            result.update({
                "ack": ack, "active_turn_id": active_turn,
                "compaction_started_before_continuation_release": started_while_blocked,
                "turn_completions": completions,
                "compaction_completion": compact_done,
            })
        else:
            fixture.phase = "compact"
            fixture.fail_compaction = mode == "failure"
            target = app
            if mode == "sidecar":
                sidecar = AppServer(binary, root, fixture, label="sidecar")
                try:
                    sidecar.rpc("thread/resume", {"threadId": thread_id})
                    target = sidecar
                except RuntimeError as exc:
                    result["sidecar_resume_error"] = str(exc)
                    require("active writer" in str(exc), "unexpected sidecar resume failure")
                    target = None
            if target:
                operation = target.compact(thread_id)
                result["compaction"] = operation
            fixture.fail_compaction = False

        fixture.phase = "after_compact"
        continued = app.turn(thread_id, "Continue the same probe task.")
        normal = [record for record in fixture.records
                  if record["phase"] == "after_compact" and not record["compaction"]]
        require(normal, "missing post-compaction inference request")
        body = json.dumps(normal[-1]["body"].get("input", []))
        saved = checkpoints(root)
        result.update({
            "post_compaction_turn_status": continued["params"]["turn"]["status"],
            "post_compaction_input_stats": normal[-1]["stats"],
            "post_compaction_contains_summary": SUMMARY in body,
            "post_compaction_contains_old_assistant": OLD_ASSISTANT in body,
            "post_compaction_contains_old_user": "OLD_USER_0" in body,
            "persisted_checkpoints": len(saved),
        })
        if mode == "user_cap_early":
            fixture.phase = "after_compact_next_user"
            next_turn = app.turn(thread_id, "One more short user message.")
            result["next_user_turn_status"] = next_turn["params"]["turn"]["status"]
            result["next_user_input_stats"] = fixture.records[-1]["stats"]
            require(result["post_compaction_turn_status"] == "completed",
                    "early compaction did not permit the first follow-up")
            require(result["next_user_turn_status"] == "failed" and
                    fixture.records[-1].get("rejected") == "fixture_input_cap",
                    "expected the next follow-up to exceed the synthetic input cap")
        if mode == "failure":
            require(result["compaction"]["completion"]["params"]["turn"]["status"] ==
                    "failed", "compaction failure was not reported to the controller")
            require(not saved, "failed compaction installed a checkpoint")
            require(OLD_ASSISTANT in body, "failed compaction lost original history")
            require(result["post_compaction_turn_status"] == "completed",
                    "could not continue after failed compaction")
        elif mode == "sidecar":
            if result.get("sidecar_resume_error"):
                require(not saved and OLD_ASSISTANT in body,
                        "rejected sidecar changed the original history")
            else:
                require(saved, "sidecar compaction did not persist")
                # Record whether the original process actually reloads the change.
        elif mode == "user_cap":
            require(not saved, "rejected compaction unexpectedly installed a checkpoint")
            require(any(record.get("rejected") == "fixture_input_cap" and
                        record["compaction"] for record in fixture.records),
                    "compaction request did not reproduce the synthetic input cap")
            require(result["post_compaction_turn_status"] == "failed",
                    "over-cap follow-up unexpectedly succeeded")
        else:
            require(saved, "native compaction checkpoint was not persisted")
            require(SUMMARY in body, "same process did not use compacted history")
            require(OLD_ASSISTANT not in body, "old assistant history was not removed")
            lifecycle = [event for event in app.events
                         if event.get("method") in ("item/started", "item/completed")
                         and event.get("params", {}).get("item", {}).get("type") ==
                         "contextCompaction"]
            require(len(lifecycle) >= 2, "missing native compaction lifecycle")
        result["passed"] = True
    except Exception as exc:
        result.update({"passed": False, "error": type(exc).__name__ + ": " + str(exc)})
    finally:
        fixture.release_continuation.set()
        if sidecar:
            sidecar.close()
        if app:
            app.close()
        fixture.close()
        result["request_sequence"] = [
            {key: record[key] for key in ("phase", "compaction", "stats", "rejected")
             if key in record} for record in fixture.records]
        report = {**result, "requests": fixture.records,
                  "events": app.events if app else [],
                  "sidecar_events": sidecar.events if sidecar else []}
        (root / "report.json").write_text(json.dumps(report, indent=2))
    summary = {key: value for key, value in result.items()
               if key not in ("compaction", "compaction_completion", "turn_completions")}
    if "turn_completions" in result:
        summary["turn_completions"] = [
            {"id": turn["id"], "status": turn["status"]}
            for turn in result["turn_completions"]]
    summary["report"] = str(root / "report.json")
    print(json.dumps(summary), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--case", action="append", choices=[
        "idle", "busy", "failure", "user_cap", "user_cap_early", "sidecar",
    ])
    parser.add_argument("--protocol", choices=["local", "v2"], default="v2",
                        help="v2 matches the compaction_trigger protocol used with Magpie")
    args = parser.parse_args()
    binary = shutil.which(args.codex) or str(Path(args.codex).resolve())
    root = Path(tempfile.mkdtemp(prefix="turn-guard-app-server-probe-"))
    version = subprocess.check_output([binary, "--version"], text=True).strip()
    print(json.dumps({"version": version, "root": str(root)}), flush=True)
    results = [run_case(binary, mode, root / mode, args.protocol)
               for mode in (args.case or ["idle", "busy", "failure", "user_cap",
                                          "user_cap_early", "sidecar"])]
    (root / "summary.json").write_text(json.dumps({
        "version": version, "results": results,
    }, indent=2))
    raise SystemExit(0 if all(result["passed"] for result in results) else 1)


if __name__ == "__main__":
    main()
