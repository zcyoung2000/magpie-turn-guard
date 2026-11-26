#!/usr/bin/env python3
"""Replay a synthetic Codex report through real Magpie gateway source tests.

Go's source overlay adds the probe without editing the Magpie checkout. Its
existing fake-upstream helpers capture what the gateway actually forwards.
No running app, installed plugin, real provider or credentials are used.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


GO_PROBE = r'''package gateway

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"
    "testing"

    "github.com/yetone/magpie/internal/codexsummary"
    "github.com/yetone/magpie/internal/provider"
)

func TestTurnGuardProbeActualForwarding(t *testing.T) {
    raw, err := os.ReadFile(os.Getenv("TURN_GUARD_PROBE_REPORT"))
    if err != nil { t.Fatal(err) }
    var report struct { Requests []struct {
        Phase string `json:"phase"`
        Body map[string]any `json:"body"`
    } `json:"requests"` }
    if err := json.Unmarshal(raw, &report); err != nil { t.Fatal(err) }
    tested := 0
    for _, phase := range []string{"after_compact", "after_compact_next_user"} {
        for _, variant := range []string{"full", "minimal"} {
            t.Run(phase+"/"+variant, func(t *testing.T) {
                setHome(t, t.TempDir())
                f := &fake{t: t, reply: sse(
                    `data: {"type":"response.created","response":{"id":"resp_probe","status":"in_progress","output":[]}}`,
                    `data: {"type":"response.completed","response":{"id":"resp_probe","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":1,"total_tokens":101}}}`)}
                setup(t, provider.Responses, f)
                var request map[string]any
                for _, row := range report.Requests {
                    if row.Phase == phase {
                        copyJSON, _ := json.Marshal(row.Body)
                        if err := json.Unmarshal(copyJSON, &request); err != nil { t.Fatal(err) }
                        break
                    }
                }
                if request == nil { t.Fatal("missing report phase: " + phase) }
                request["model"], request["stream"] = "fake/m1", true
                beforeUsers, beforeCompactions := 0, 0
                for _, rawItem := range request["input"].([]any) {
                    item := rawItem.(map[string]any)
                    if item["role"] == "user" { beforeUsers++ }
                    if item["type"] == "compaction" {
                        beforeCompactions++
                        item["encrypted_content"] = codexsummary.Encrypted("REAL_GATEWAY_FORWARDING_PROBE_SUMMARY")
                    }
                }
                if variant == "minimal" {
                    request = map[string]any{"model": "fake/m1", "stream": true, "input": request["input"]}
                }
                body, err := json.Marshal(request)
                if err != nil { t.Fatal(err) }
                code, _ := post(t, "/v1/responses", string(body))
                if code != 200 { t.Fatalf("gateway returned %d", code) }
                if f.calls != 1 { t.Fatalf("got %d upstream calls", f.calls) }
                var received struct { Input []map[string]any `json:"input"` }
                if err := json.Unmarshal(f.got, &received); err != nil { t.Fatal(err) }
                users, compactions := 0, 0
                for _, item := range received.Input {
                    if item["role"] == "user" { users++ }
                    if item["type"] == "compaction" { compactions++ }
                }
                oldContents := strings.Count(string(f.got), "OLD_USER_")
                summaryPresent := strings.Contains(string(f.got), "REAL_GATEWAY_FORWARDING_PROBE_SUMMARY")
                capture := filepath.Join(os.Getenv("TURN_GUARD_PROBE_DIR"), phase+"-"+variant+".json")
                if err := os.WriteFile(capture, f.got, 0600); err != nil { t.Fatal(err) }
                wantUsers := beforeUsers + beforeCompactions
                if variant == "full" {
                    wantUsers = 2
                    if phase == "after_compact_next_user" { wantUsers = 3 }
                }
                if users != wantUsers || oldContents != 17 || compactions != 0 || !summaryPresent {
                    t.Fatalf("before_users=%d before_compactions=%d upstream_users=%d want_users=%d old_contents=%d compactions=%d summary=%v; capture=%s",
                        beforeUsers, beforeCompactions, users, wantUsers, oldContents, compactions, summaryPresent, capture)
                }
                t.Logf("before_users=%d before_compactions=%d upstream_users=%d old_user_contents=%d summary=%v capture=%s",
                    beforeUsers, beforeCompactions, users, oldContents, summaryPresent, capture)
                tested++
            })
        }
    }
    if tested != 4 { t.Fatal(fmt.Sprintf("tested %d cases, want 4", tested)) }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--magpie-source", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path,
                        help="report.json from the app-server user_cap_early case")
    args = parser.parse_args()
    repo, report = args.magpie_source.resolve(), args.report.resolve()
    if not (repo / "internal/gateway/gateway_test.go").is_file():
        parser.error("--magpie-source must be a Magpie source checkout")
    data = json.loads(report.read_text())
    if data.get("case") != "user_cap_early" or not data.get("passed"):
        parser.error("--report must be a successful synthetic user_cap_early report")
    root = Path(tempfile.mkdtemp(prefix="turn-guard-real-forward-probe-"))
    source = root / "forwarding_probe_test.go"
    source.write_text(GO_PROBE)
    overlay = root / "overlay.json"
    overlay.write_text(json.dumps({"Replace": {
        str(repo / "internal/gateway/zz_turn_guard_probe_test.go"): str(source),
    }}))
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL")
           if key in os.environ}
    for name in ("GOCACHE", "GOMODCACHE", "GOPATH"):
        env[name] = subprocess.check_output(["go", "env", name], text=True).strip()
    for name, folder in (("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                         ("XDG_CACHE_HOME", "cache"), ("XDG_DATA_HOME", "data"),
                         ("CODEX_HOME", "codex")):
        path = root / folder
        path.mkdir()
        env[name] = str(path)
    env.update({"MAGPIE_NO_ACCOUNTS": "1", "TURN_GUARD_PROBE_REPORT": str(report),
                "TURN_GUARD_PROBE_DIR": str(root)})
    print(json.dumps({"capture_directory": str(root)}), flush=True)
    # The first build may need to download the checkout's Go dependencies.
    process = subprocess.run([
        "go", "test", "-overlay", str(overlay), "./internal/gateway",
        "-run", "^TestTurnGuardProbeActualForwarding$", "-count=1", "-v",
        "-timeout=90s",
    ], cwd=repo, env=env, capture_output=True, text=True)
    (root / "stdout.log").write_text(process.stdout)
    (root / "stderr.log").write_text(process.stderr)
    print(process.stdout, end="")
    if process.returncode:
        print(process.stderr[-4000:])
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
