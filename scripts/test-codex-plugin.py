#!/usr/bin/env python3
"""End-to-end native-plugin checks using real Codex and a local fake model."""

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[1]
TARGET_MODEL = "xingchi/gpt-6.1-sol"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fixture_module = module("fixture", REPO / "scripts/probe-app-server-compaction.py")
guard = module("guard", REPO / "codex-plugin/scripts/turn_guard.py")


def wait_until(predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for the expected plugin state")


class Setup:
    def __init__(self, name, default_endpoint=False, model=TARGET_MODEL):
        self.root = Path(tempfile.mkdtemp(prefix="tg-plugin-" + name + "-", dir="/tmp"))
        for folder in ["codex", "home", "work", "data"]:
            (self.root / folder).mkdir()
        self.fixture = fixture_module.Fixture("v2")
        self.socket = self.root / "s"
        self.env = {key: os.environ[key] for key in ["PATH", "TMPDIR", "LANG"]
                    if key in os.environ}
        self.env.update(HOME=str(self.root / "home"), CODEX_HOME=str(self.root / "codex"),
                        XDG_CONFIG_HOME=str(self.root / "home/.config"),
                        TURN_GUARD_DATA=str(self.root / "data"))
        self.clients = []
        self.original_env = os.environ.copy()
        os.environ.clear()
        os.environ.update(self.env)
        for command in [
            ["codex", "plugin", "marketplace", "add", str(REPO), "--json"],
            ["codex", "plugin", "add", "magpie-turn-guard@magpie-turn-guard", "--json"],
        ]:
            subprocess.run(command, env=self.env, cwd=self.root, check=True,
                           capture_output=True, text=True, timeout=30)
        self.config = {**guard.DEFAULTS, "userThreshold": 2, "modelThreshold": 90,
                       "idleGraceSeconds": 0.1, "idleWaitSeconds": 2,
                       "socketPath": None if default_endpoint else str(self.socket)}
        guard.atomic_json(self.root / "data/settings.json", self.config)
        config = {
            "model": model, "model_provider": "probe",
            "model_providers.probe.name": "Isolated plugin probe",
            "model_providers.probe.base_url":
                f"http://127.0.0.1:{self.fixture.server.server_port}/v1",
            "model_providers.probe.wire_api": "responses",
            "model_providers.probe.requires_openai_auth": False,
            "model_providers.probe.supports_websockets": False,
            "model_providers.probe.capabilities.remote_compaction": "v2",
            "model_providers.probe.stream_max_retries": 0,
            "model_providers.probe.request_max_retries": 0,
            "model_context_window": 200000,
            "model_auto_compact_token_limit": 180000,
            "analytics.enabled": False, "feedback.enabled": False,
            "approval_policy": "never", "sandbox_mode": "read-only",
        }
        command = ["codex", "app-server",
                   "--listen", "unix://" + ("" if default_endpoint else str(self.socket))]
        for key, value in config.items():
            command += ["-c", key + "=" + json.dumps(value)]
        self.log = (self.root / "server.log").open("w")
        self.server = subprocess.Popen(command, env=self.env, cwd=self.root / "work",
                                       stdin=subprocess.DEVNULL, stdout=self.log,
                                       stderr=self.log)
        if default_endpoint:
            def connect():
                try:
                    return guard.ProxyClient(self.config)
                except guard.RpcError:
                    return None
            self.client = wait_until(connect, seconds=8)
        else:
            wait_until(lambda: self.socket.exists(), seconds=8)
            self.client = guard.ProxyClient(self.config)
        self.clients.append(self.client)
        hooks = self.client.call("hooks/list", {"cwds": [str(self.root / "work")]})["data"][0]["hooks"]
        assert len(hooks) == 6 and all(item["pluginId"] == "magpie-turn-guard@magpie-turn-guard"
                                      for item in hooks)
        # Approve only these exact, vetted hook hashes in this isolated test
        # thread. The real user install keeps Codex's normal hook-review gate.
        trust = {}
        for item in hooks:
            definition, separator, content = item["currentHash"].partition("/")
            trust[item["key"]] = {"enabled": True, "trusted_hash": definition}
            if separator:
                trust[item["key"]]["trusted_content_hash"] = content
        self.session = self.client.call("thread/start", {
            "cwd": str(self.root / "work"), "model": model,
            "modelProvider": "probe", "sandbox": "read-only",
            "approvalPolicy": "never", "baseInstructions": "Run the local fixture.",
            "config": {"hooks.state": trust},
        })["thread"]["id"]

    def saved(self):
        return guard.load_json(self.root / ("data/" + self.session + ".json"), {})

    def start_turn(self, text, model=None):
        params = {"threadId": self.session, "input": [{"type": "text", "text": text}]}
        if model is not None:
            params["model"] = model
        return self.client.call("turn/start", params)["turn"]["id"]

    def finish_turn(self, turn_id):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            event = self.client.notification(deadline - time.monotonic())
            if event.get("method") == "turn/completed":
                turn = event.get("params", {}).get("turn", {})
                if turn.get("id") == turn_id:
                    return turn["status"]
        raise AssertionError("Missing target turn completion")

    def turn(self, text, model=None):
        assert self.finish_turn(self.start_turn(text, model=model)) == "completed"

    def close(self):
        # Reap any detached worker before tearing down the fixture endpoint.
        self.config["enabled"] = False
        guard.atomic_json(self.root / "data/settings.json", self.config)
        for client in self.clients:
            client.close()
        self.server.terminate()
        try:
            self.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait()
        self.log.close()
        self.fixture.close()
        os.environ.clear()
        os.environ.update(self.original_env)


def idle_compaction():
    setup = Setup("idle", default_endpoint=True)
    try:
        setup.turn("FIRST")
        saved = setup.saved()
        assert saved.get("users") == 1 and saved.get("models") == 1, saved
        setup.turn("SECOND")
        saved = wait_until(lambda: setup.saved() if setup.saved().get("phase") == "idle"
                           and setup.saved().get("lastCompactionAt") else None)
        assert saved["transport"] == "connected" and saved["users"] == 0, saved
        assert len(fixture_module.checkpoints(setup.root)) == 1
        setup.fixture.phase = "after_compact"
        setup.turn("CONTINUE_WITH_CHECKPOINT")
        after = [row for row in setup.fixture.records if row["phase"] == "after_compact"]
        assert after and fixture_module.SUMMARY in json.dumps(after[-1]["body"]["input"])
        assert fixture_module.OLD_ASSISTANT not in json.dumps(after[-1]["body"]["input"])
        assert setup.saved()["users"] == 1
        print(json.dumps({"case": "idle_auto_compaction", "passed": True,
                          "root": str(setup.root)}), flush=True)
    finally:
        setup.close()


def busy_boundary():
    setup = Setup("busy")
    try:
        setup.config.update(userThreshold=1)
        guard.atomic_json(setup.root / "data/settings.json", setup.config)
        setup.fixture.phase = "busy"
        turn = setup.start_turn("Call update_plan, then finish the task.")
        assert setup.fixture.continuation_started.wait(10)
        assert not any(row["compaction"] for row in setup.fixture.records)
        setup.fixture.release_continuation.set()
        assert setup.finish_turn(turn) == "completed"
        wait_until(lambda: setup.saved().get("lastCompactionAt"))
        assert len(fixture_module.checkpoints(setup.root)) == 1
        print(json.dumps({"case": "busy_task_finishes_before_compaction", "passed": True,
                          "root": str(setup.root)}), flush=True)
    finally:
        setup.close()


def unavailable():
    setup = Setup("unavailable")
    try:
        setup.config.update(userThreshold=1, socketPath=str(setup.root / "missing"))
        guard.atomic_json(setup.root / "data/settings.json", setup.config)
        setup.turn("NO_CONTROLLER_AVAILABLE")
        saved = wait_until(lambda: setup.saved() if setup.saved().get("phase") == "unavailable" else None)
        assert saved["users"] == 1 and saved["lastError"], saved
        assert not fixture_module.checkpoints(setup.root)
        print(json.dumps({"case": "unsupported_transport_is_visible", "passed": True,
                          "root": str(setup.root)}), flush=True)
    finally:
        setup.close()


def failed_compaction():
    setup = Setup("failure")
    try:
        setup.config.update(userThreshold=1)
        guard.atomic_json(setup.root / "data/settings.json", setup.config)
        setup.fixture.fail_compaction = True
        setup.turn("KEEP_ORIGINAL_HISTORY")
        saved = wait_until(lambda: setup.saved() if setup.saved().get("phase") == "failed" else None)
        assert saved["users"] == 1 and saved["models"] == 1, saved
        assert not fixture_module.checkpoints(setup.root)
        setup.config["enabled"] = False
        guard.atomic_json(setup.root / "data/settings.json", setup.config)
        setup.fixture.fail_compaction = False
        setup.fixture.phase = "after_failure"
        setup.turn("CONTINUE_AFTER_FAILED_COMPACT")
        body = json.dumps(setup.fixture.records[-1]["body"]["input"])
        assert fixture_module.OLD_ASSISTANT in body
        print(json.dumps({"case": "failed_compaction_preserves_original_history", "passed": True,
                          "root": str(setup.root)}), flush=True)
    finally:
        setup.close()


def exact_model_filter():
    setup = Setup("model-filter", model="gpt-6.1-sol")
    try:
        for model in (None, "", "gpt-6.1-sol", "xingchi/gpt-6.1-sol-extra",
                      "other/gpt-6.1-sol", "xingchi/gpt-6.1-sol "):
            assert not guard.model_allowed(model, setup.config), model
        assert guard.model_allowed(TARGET_MODEL, setup.config)
        assert not guard.model_allowed(TARGET_MODEL, {"allowedModels": TARGET_MODEL})
        setup.turn("UNLISTED_FIRST")
        setup.turn("UNLISTED_SECOND")
        assert not setup.saved(), setup.saved()
        assert not fixture_module.checkpoints(setup.root)
        setup.turn("TARGET_FIRST", model=TARGET_MODEL)
        assert setup.saved()["users"] == 1 and setup.saved()["models"] == 1, setup.saved()
        for model in ("xingchi/gpt-6.1-sol-extra", "other/gpt-6.1-sol", "gpt-6.1-sol"):
            setup.turn("UNLISTED_SWITCH", model=model)
            saved = setup.saved()
            assert saved["users"] == 1 and saved["models"] == 1, saved
            assert saved["model"] == model and saved["phase"] == "skipped_model", saved
        assert guard.run_worker(setup.session, force=True)["status"] == "skipped_model"
        assert not fixture_module.checkpoints(setup.root)
        setup.turn("TARGET_SECOND", model=TARGET_MODEL)
        wait_until(lambda: setup.saved().get("lastCompactionAt"))
        assert len(fixture_module.checkpoints(setup.root)) == 1
        print(json.dumps({"case": "only_exact_allowlisted_model_counts_and_compacts",
                          "passed": True, "root": str(setup.root)}), flush=True)
    finally:
        setup.close()


def switch_cancels_queued_compaction():
    setup = Setup("model-switch")
    try:
        setup.config.update(userThreshold=1, idleGraceSeconds=1.5, idleWaitSeconds=4)
        guard.atomic_json(setup.root / "data/settings.json", setup.config)
        setup.turn("QUEUE_TARGET_COMPACTION")
        wait_until(lambda: setup.saved().get("phase") == "waiting_for_idle")
        setup.turn("SWITCH_AWAY", model="gpt-6.1-sol")
        wait_until(lambda: setup.saved().get("phase") == "skipped_model")
        # Wait for the actual worker's lock to be released, not merely a hook's
        # skipped status, so a still-queued compaction cannot pass this test.
        def worker_done():
            with (setup.root / ("data/" + setup.session + ".worker.lock")).open("a") as lock:
                try:
                    guard.fcntl.flock(lock, guard.fcntl.LOCK_EX | guard.fcntl.LOCK_NB)
                    return True
                except BlockingIOError:
                    return False
        wait_until(worker_done)
        assert not fixture_module.checkpoints(setup.root)
        assert not any(row["compaction"] for row in setup.fixture.records)
        assert setup.saved()["users"] == 1 and setup.saved()["models"] == 1, setup.saved()
        print(json.dumps({"case": "model_switch_cancels_queued_compaction", "passed": True,
                          "root": str(setup.root)}), flush=True)
    finally:
        setup.close()


def main():
    idle_compaction()
    busy_boundary()
    unavailable()
    failed_compaction()
    exact_model_filter()
    switch_cancels_queued_compaction()


if __name__ == "__main__":
    main()
