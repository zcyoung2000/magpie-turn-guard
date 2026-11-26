#!/usr/bin/env python3
"""Probe a real Codex binary against a loopback-only Responses fixture.

No model, credentials, existing sessions, or Magpie configuration are used.
HTTP and SSE overflow signals are compared with native token auto-compaction.
All Codex homes, transcripts, and the JSON report live under a temporary folder.
"""

import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading


def is_compaction(body):
    text = json.dumps(body.get("input", []))
    return (
        "compaction_trigger" in text
        or "context checkpoint" in text.lower()
        or "compacting a conversation" in text.lower()
    )


def probe(binary, mode, root):
    home, work = root / "codex", root / "work"
    home.mkdir(parents=True)
    work.mkdir()
    records = []
    phase = "seed"
    midturn_started = False

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            nonlocal midturn_started
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            compact = is_compaction(body)
            record = {
                "phase": phase,
                "path": self.path,
                "compaction": compact,
                "body": body,
            }
            records.append(record)
            tool_step = (
                phase == "overflow" and mode.endswith("_midturn")
                and not compact and not midturn_started
            )
            if tool_step:
                midturn_started = True
            reject = phase == "overflow" and mode != "token" and not compact and not tool_step
            error = {
                "type": "invalid_request_error",
                "code": "context_length_exceeded",
                "message": "turn-guard probe: compact before the provider turn cap",
            }
            if reject and mode.startswith("http"):
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": error}).encode())
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def emit(kind, **fields):
                event = {"type": kind, **fields}
                self.wfile.write(
                    ("event: " + kind + "\ndata: " + json.dumps(event) + "\n\n").encode()
                )
                self.wfile.flush()

            response = {
                "id": "resp_probe_" + str(len(records)),
                "object": "response",
                "model": body["model"],
                "status": "in_progress",
                "output": [],
            }
            emit("response.created", response=response)
            if reject:
                emit("response.failed", response={**response, "status": "failed", "error": error})
                return

            if tool_step:
                item = {
                    "id": "fc_probe", "type": "function_call", "status": "completed",
                    "call_id": "call_probe", "name": "update_plan",
                    "arguments": json.dumps({"plan": [{
                        "step": "Exercise the local overflow fixture", "status": "in_progress",
                    }]}),
                }
                emit("response.output_item.added", output_index=0, item=item)
                emit("response.output_item.done", output_index=0, item=item)
                emit("response.completed", response={
                    **response, "status": "completed", "output": [item],
                    "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110},
                })
                return

            text = "Native probe summary. The task is to reply PROBE_OK." if compact else "PROBE_OK"
            item = {
                "id": "msg_probe_" + str(len(records)),
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
            emit("response.output_item.added", output_index=0, item={**item, "content": []})
            emit("response.output_text.delta", output_index=0, content_index=0,
                 item_id=item["id"], delta=text)
            emit("response.output_item.done", output_index=0, item=item)
            # A high fixture usage is a positive control for the *real* token
            # trigger, never a recommendation to falsify production usage.
            tokens = 15000 if mode == "token" and phase == "seed" and not compact else 100
            emit("response.completed", response={
                **response, "status": "completed", "output": [item],
                "usage": {"input_tokens": tokens, "output_tokens": 10, "total_tokens": tokens + 10},
            })

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Explicit CODEX_HOME and --ignore-user-config prevent use of the owner's
    # hooks/MCPs/provider keys. Every inference goes only to this local fixture.
    common = [
        "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--json",
        "-m", "gpt-5.4",
    ]
    overrides = {
        "model_provider": "probe",
        "model_providers.probe.name": "Probe",
        "model_providers.probe.base_url": f"http://127.0.0.1:{server.server_port}/v1",
        "model_providers.probe.wire_api": "responses",
        "model_providers.probe.requires_openai_auth": False,
        "model_providers.probe.supports_websockets": False,
        "model_providers.probe.stream_max_retries": 0,
        "model_providers.probe.request_max_retries": 0,
        "model_context_window": 200000,
        "model_auto_compact_token_limit": 10000 if mode == "token" else 180000,
        "analytics.enabled": False,
        "feedback.enabled": False,
    }
    for key, value in overrides.items():
        common += ["-c", key + "=" + json.dumps(value)]
    invocations = []
    session_id = None
    try:
        for phase in ["seed", "overflow", "next_user_turn"]:
            cmd = [binary, "exec"]
            if session_id:
                cmd += ["resume", *common, session_id]
            else:
                cmd += [*common, "-s", "read-only"]
            cmd += ["Reply PROBE_OK."]
            result = subprocess.run(
                cmd, cwd=work, env={**os.environ, "CODEX_HOME": str(home)},
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
            )
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            for event in events:
                if event.get("type") == "thread.started":
                    session_id = event["thread_id"]
            invocations.append({
                "phase": phase, "returncode": result.returncode,
                "events": events, "stderr": result.stderr,
            })
            if not session_id or (phase == "seed" and result.returncode):
                raise RuntimeError("The fixture could not seed a Codex session")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    compacted = []
    for path in home.glob("sessions/**/*.jsonl"):
        for line in path.read_text().splitlines():
            entry = json.loads(line)
            if entry.get("type") == "compacted":
                compacted.append({"timestamp": entry.get("timestamp"), "path": str(path)})
    report = {
        "mode": mode, "binary": binary,
        "version": subprocess.check_output([binary, "--version"], text=True).strip(),
        "invocations": invocations, "requests": records, "compacted_records": compacted,
    }
    (root / "report.json").write_text(json.dumps(report, indent=2))
    summary = {
        "mode": mode, "version": report["version"], "report": str(root / "report.json"),
        "turn_exit_codes": [v["returncode"] for v in invocations],
        "requests": [{"phase": r["phase"], "compaction": r["compaction"]} for r in records],
        "persisted_compactions": len(compacted),
    }
    print(json.dumps(summary), flush=True)
    expected_exits = [0, 0, 0] if mode == "token" else [0, 1, 0]
    expected_phase = "overflow" if mode == "token" else "next_user_turn"
    compact_phases = [r["phase"] for r in records if r["compaction"]]
    if summary["turn_exit_codes"] != expected_exits or compact_phases != [expected_phase] or len(compacted) != 1:
        raise AssertionError("Codex behavior changed; inspect " + summary["report"])
    if mode.endswith("_midturn"):
        outputs = [it for r in records if r["phase"] == "overflow"
                   for it in r["body"].get("input", []) if it.get("type") == "function_call_output"]
        if not outputs:
            raise AssertionError("The fixture did not reach a tool continuation")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default="codex", help="Codex executable to test")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="turn-guard-native-probe-"))
    for mode in ["http", "sse", "http_midturn", "sse_midturn", "token"]:
        probe(args.codex, mode, root / mode)


if __name__ == "__main__":
    main()
