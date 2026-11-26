// bun scripts/test-hook-compaction.js — isolated HOME/state, no real gateway.
// Accelerates only the hook's 25s foreground wait to 5ms. Job expiry tests use
// their own small compactTimeoutMs; source files are copied without alteration.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const scenarios = [
  "control",
  "second-user",
  "second-user-no-session",
  "pending-second-user",
  "expired-fetch",
  "expired-body",
  "short-hook-budget",
  "request-cancelled",
  "different-branch",
  "incremental",
  "sliced-history",
  "parallel-slices",
  "legacy-cache",
  "guard",
  "state-outside-plugin-dir",
  "reject-local-fallback",
  "side-request-shape",
  "failure-backoff",
  "tool-turn-counting",
];
const scenario = process.argv[2];
if (!scenario) {
  for (const name of scenarios) {
    const childRoot = mkdtempSync(join(tmpdir(), "turn-guard-test-"));
    const childHome = join(childRoot, "home");
    mkdirSync(childHome, { recursive: true });
    try {
      const child = spawnSync(process.execPath, [import.meta.path, name, childRoot], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, HOME: childHome, TURN_GUARD_STATE_PATH: "" },
      });
      process.stdout.write(child.stdout || "");
      process.stderr.write(child.stderr || "");
      assert.equal(child.status, 0, `${name} failed: ${child.error || ""}`);
    } finally {
      rmSync(childRoot, { recursive: true, force: true });
    }
  }
  console.log(`Passed ${scenarios.length} isolated compaction scenarios.`);
} else {
  assert(scenarios.includes(scenario));
  const ownRoot = !process.argv[3];
  const rootDir = process.argv[3] || mkdtempSync(join(tmpdir(), "turn-guard-test-"));
  const homeDir = join(rootDir, "home");
  const pluginDir = join(rootDir, "plugin");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env.TURN_GUARD_STATE_PATH;

  const timer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 25000 ? 5 : ms, ...args);
  const tick = (ms = 0) => new Promise((r) => timer(r, ms));
  const user = (text) => ({ role: "user", content: text });
  const round = (n) => [
    { type: "function_call", name: "fixture", call_id: `call_${n}`, arguments: "{}" },
    { type: "function_call_output", call_id: `call_${n}`, output: "ok" },
  ];
  const rounds = (count, start = 0) => Array.from({ length: count }, (_, i) => round(start + i)).flat();
  const body = {
    model: "xingchi/fixture",
    instructions: "You are Codex.",
    input: [user("first user"), ...rounds(100)],
    stream: true,
  };
  const ctx = { options: { gatewayTimeoutMs: 30000 }, session: "fixture-session" };
  const statePath = join(homeDir, ".config", "magpie", "turn-guard-state.json");
  const seal = (text) => "magpie1:" + Buffer.from(text, "utf8").toString("base64");
  const responseText = (text) => new Response(JSON.stringify({
    output: [{ type: "compaction", encrypted_content: seal(text) }],
  }), { headers: { "Content-Type": "application/json" } });
  const response = (n) => responseText(`fixture summary ${n}`);
  const summaryTexts = (value) => (value?.input || [])
    .filter((it) => it && it.role === "user" && Array.isArray(it.content))
    .flatMap((it) => it.content.map((p) => p?.text || ""));

  let calls = 0;
  let fetchImpl;
  const requests = [];
  const signals = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    requests.push(JSON.parse(init.body));
    signals.push(init.signal);
    return fetchImpl ? fetchImpl(calls, init) : response(calls);
  };
  try {
    for (const file of ["turn-guard.hooks.js", "turn-guard.gateway.js", "turn-guard.shared.js"]) {
      copyFileSync(resolve(import.meta.dir, "..", file), join(pluginDir, file));
    }
    const { onRequest, CODEX_SUMMARY_PREFIX } = await import(pathToFileURL(join(pluginDir, "turn-guard.hooks.js")).href);
    const { onRequest: guard } = await import(pathToFileURL(join(pluginDir, "turn-guard.gateway.js")).href);
    const { countStats, DEFAULTS } = await import(pathToFileURL(join(pluginDir, "turn-guard.shared.js")).href);
    const hasExpandedSummary = (value, marker = "") => {
      if (!value?.input) return false;
      // Hook-injected magpie1: items must never reach upstream unexpanded.
      if (value.input.some((it) => it?.type === "compaction" && String(it.encrypted_content || "").startsWith("magpie1:"))) {
        return false;
      }
      return summaryTexts(value).some((t) => t.startsWith(CODEX_SUMMARY_PREFIX + "\n") && (!marker || t.includes(marker)));
    };
    const rejection = (b, context = ctx) => {
      let status = 0;
      guard(b, { ...context, reject: (code) => { status = code; } });
      return status;
    };
    const applied = async (b, context = ctx, marker = "") => {
      const result = await onRequest(b, context);
      assert(hasExpandedSummary(result, marker), "an expanded summary user message must replace the folded raw prefix");
      assert.equal(rejection(result, context), 0, "rewritten request must fit below both caps");
      return result;
    };

    if (scenario === "control") {
      const result = await applied(body, ctx, "fixture summary 1");
      assert.deepEqual(countStats(result.input), { users: 2, turns: 20 });
      assert.equal(result.input.find((it) => it.type === "function_call").call_id, "call_80");
      assert.equal(result.input.some((it) => it.call_id === "call_0"), false);
      await applied(body, ctx, "fixture summary 1");
      const restarted = await import(pathToFileURL(join(pluginDir, "turn-guard.hooks.js")).href + "?restart");
      assert(hasExpandedSummary(await restarted.onRequest(body, ctx), "fixture summary 1"), "persisted state must survive host restart");
      assert.equal(calls, 1);
    } else if (scenario === "second-user" || scenario === "second-user-no-session") {
      const context = scenario.endsWith("no-session") ? { ...ctx, session: "" } : ctx;
      await applied(body, context);
      fetchImpl = () => { throw new Error("summary service unavailable"); };
      await applied({ ...body, input: [...body.input, user("second user")] }, context);
      assert.equal(calls, 1, "a second user message must not invalidate an existing summary");
    } else if (scenario === "pending-second-user") {
      let release;
      fetchImpl = () => new Promise((r) => { release = r; });
      const context = { ...ctx, session: "" };
      assert.equal(await onRequest(body, context), undefined);
      const next = { ...body, input: [...body.input, user("second user")] };
      assert.equal(await onRequest(next, context), undefined);
      assert.equal(calls, 1, "the pending one-user job must survive user #2 too");
      release(response(1));
      await tick();
      await applied(next, context);
      assert.equal(calls, 1);
    } else if (scenario === "expired-fetch" || scenario === "expired-body") {
      let release;
      fetchImpl = (n) => n > 1 ? response(n) : scenario === "expired-fetch"
        ? new Promise((r) => { release = () => r(response(1)); })
        : { ok: true, text: () => new Promise((r) => { release = () => r(JSON.stringify({ output: [
          { type: "compaction", encrypted_content: seal("late old summary") },
        ] })); }) };
      const context = { ...ctx, options: { ...ctx.options, compactTimeoutMs: 40 } };
      for (const extra of [0, 5]) {
        const next = { ...body, input: [...body.input, ...rounds(extra, 100)] };
        assert.equal(await onRequest(next, context), undefined);
        assert.equal(rejection(next, context), 503, "100/105 raw turns must never reach the provider");
      }
      assert.equal(calls, 1);
      assert(signals[0] instanceof AbortSignal);
      await tick(45);
      assert.equal(signals[0].aborted, true);
      await applied(body, context, "fixture summary 2");
      assert.equal(calls, 2, "an expired job must be replaced by a fresh attempt");
      const saved = readFileSync(statePath, "utf8");
      release();
      await tick();
      assert.equal(readFileSync(statePath, "utf8"), saved, "late results must not overwrite the new summary");
    } else if (scenario === "short-hook-budget" || scenario === "request-cancelled") {
      let release;
      fetchImpl = () => new Promise((r) => { release = r; });
      const ctl = new AbortController();
      const context = { ...ctx, signal: ctl.signal,
        options: { ...ctx.options, gatewayTimeoutMs: scenario === "short-hook-budget" ? 100 : 30000 } };
      const short = scenario === "request-cancelled" ? { ...body, input: [user("first user"), ...rounds(DEFAULTS.turnThreshold)] } : body;
      const start = performance.now();
      assert.equal(await onRequest(short, context), undefined);
      if (scenario === "short-hook-budget") assert(performance.now() - start < 90);
      else assert.equal(rejection(short), 0, "below-cap traffic can proceed while a summary runs");
      ctl.abort(); // Magpie does this even after the hook has returned successfully.
      assert.equal(signals[0].aborted, false, "request lifetime must not cancel a background fold");
      release(response(1));
      await tick();
      await applied(body);
    } else if (scenario === "different-branch") {
      let release;
      fetchImpl = (n) => n === 1 ? new Promise((r) => { release = r; }) : response(n);
      assert.equal(await onRequest(body, ctx), undefined);
      const branch = structuredClone(body);
      branch.input[2].output = "different branch result";
      await applied(branch, ctx, "fixture summary 2");
      assert.equal(calls, 2, "same session/opening does not make incompatible snapshots reusable");
      release(response(1));
      await tick();
      await applied(branch, ctx, "fixture summary 2");
      assert.equal(calls, 2, "a late incompatible job must not replace the usable branch's cache");
      assert.equal(rejection(body), 503);
    } else if (scenario === "incremental") {
      const withInstructions = { ...body, input: [body.input[0],
        { role: "developer", content: "fixture instruction" }, ...body.input.slice(1)] };
      await applied(withInstructions, ctx, "fixture summary 1");
      const grown = { ...withInstructions, input: [...withInstructions.input, ...rounds(80, 100)] };
      const result = await applied(grown, ctx, "fixture summary 2");
      assert.equal(calls, 2);
      assert(summaryTexts(requests[1]).some((t) => t.includes("fixture summary 1")));
      assert(requests.every((r) => r.input.some((it) => it.role === "developer")));
      assert(result.input.some((it) => it.role === "developer"));
      await applied(grown, ctx, "fixture summary 2");
      assert.equal(calls, 2);
    } else if (scenario === "sliced-history") {
      const long = { ...body, input: [user("first user"), ...Array.from({ length: 30 }, (_, i) => [
        user(`task ${i}`), ...rounds(10, i * 10),
      ]).flat()] };
      fetchImpl = async (n) => {
        const side = requests[n - 1];
        assert.equal(rejection(side), 0, "each side request must reserve space for the compact prompt");
        assert.equal(await onRequest(side, ctx), undefined, "side requests must not recurse");
        return response(n);
      };
      const result = await applied(long);
      assert(calls > 1);
      assert.deepEqual(countStats(result.input), { users: 4, turns: 20 });
      const folded = requests.flatMap((r) => r.input.filter((it) => it.type === "function_call").map((it) => it.call_id));
      assert.equal(new Set(folded).size, 280);
      assert.equal(folded.length, 280, "each old tool round must be folded exactly once");
    } else if (scenario === "parallel-slices") {
      const parallel = { ...body, input: [user("first user"), ...Array.from({ length: 250 }, (_, i) => [
        ...round(i * 2).slice(0, 1), ...round(i * 2 + 1).slice(0, 1),
        ...round(i * 2).slice(1), ...round(i * 2 + 1).slice(1),
      ]).flat()] };
      fetchImpl = (n) => {
        const input = requests[n - 1].input;
        const fcs = input.filter((it) => it.type === "function_call").map((it) => it.call_id);
        const fcos = input.filter((it) => it.type === "function_call_output").map((it) => it.call_id);
        assert.deepEqual(fcos, fcs, "a slice must contain every parallel call's output");
        assert.equal(rejection(requests[n - 1]), 0);
        return response(n);
      };
      const result = await applied(parallel);
      assert.equal(calls, 3);
      assert.deepEqual(countStats(result.input), { users: 2, turns: 20 });
    } else if (scenario === "legacy-cache") {
      const raw = { ...body, input: [body.input[0], user("second user"), ...body.input.slice(1)] };
      const hash = (items) => createHash("sha256").update(JSON.stringify(items)).digest("hex");
      mkdirSync(join(homeDir, ".config", "magpie"), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ sessions: { [hash(raw.input.slice(0, 2))]: {
        v: 2, compactionItem: { type: "compaction", encrypted_content: seal("legacy summary") },
        frontierItems: 161, prefixHash: hash(raw.input.slice(1, 162)), folds: 1, updatedAt: Date.now(),
      } } }));
      const result = await applied(raw, ctx, "legacy summary");
      assert.equal(calls, 0, "compatible v2 state must remain reusable and expanded");
    } else if (scenario === "guard") {
      assert.equal(rejection(body), 503);
      assert.equal(rejection({ ...body, model: "other/fixture" }), 0);
      assert.equal(rejection({ ...body, input: [user("first"), ...rounds(99)] }), 0);
      assert.equal(rejection({ ...body, input: Array.from({ length: 20 }, (_, i) => user(`${i}`)) }), 503);
      assert.equal(rejection({ ...body, input: [...Array.from({ length: 19 }, (_, i) => user(`${i}`)),
        { type: "compaction_trigger" }] }), 503);
      assert.equal(rejection({ ...body, input: [user("first"), { type: "compaction", encrypted_content: "native" }, ...rounds(20)] }), 0);
      assert.equal(DEFAULTS.turnThreshold, 90);
      assert.equal(DEFAULTS.userThreshold, 18);
    } else if (scenario === "state-outside-plugin-dir") {
      const beforeFiles = readdirSync(pluginDir).sort();
      await applied(body, ctx, "fixture summary 1");
      await applied(body, ctx, "fixture summary 1");
      const afterFiles = readdirSync(pluginDir).sort();
      assert.deepEqual(afterFiles, beforeFiles, "state writes must never touch the plugin directory (avoids Magpie pathstamp restarts)");
      assert.equal(existsSync(statePath), true, "state must be written under ~/.config/magpie");
    } else if (scenario === "reject-local-fallback") {
      fetchImpl = (n) => n === 1
        ? responseText("magpie compacted this conversation without a model (no summary came in 4m0s), so this is no summary")
        : responseText("real model summary");
      const noCooldown = { ...ctx, options: { ...ctx.options, retryCooldownMs: 0 } };
      assert.equal(await onRequest(body, noCooldown), undefined, "Magpie local fallback summary must be rejected");
      assert.equal(existsSync(statePath), false, "degraded local fallback must never be persisted");
      await applied(body, noCooldown, "real model summary");
      assert.equal(calls, 2);
      // Poisoned legacy state entry must also be ignored and replaced.
      const st = JSON.parse(readFileSync(statePath, "utf8"));
      for (const entry of Object.values(st.sessions)) {
        entry.compactionItem.encrypted_content = seal("magpie compacted this conversation without a model (cut), so this is no summary");
      }
      writeFileSync(statePath, JSON.stringify(st));
      await applied(body, noCooldown, "real model summary");
      assert.equal(calls, 3, "cached degraded local fallback must not be reused");
    } else if (scenario === "side-request-shape") {
      await applied(body, ctx, "fixture summary 1");
      assert.equal(calls, 1);
      assert.equal(requests[0].stream, true);
      assert.equal(requests[0].store, false);
      assert.equal(requests[0].instructions, "You are Codex.");
      assert.deepEqual(requests[0].reasoning, { effort: "low" });
      assert.equal(requests[0].input.at(-1).type, "compaction_trigger");
    } else if (scenario === "failure-backoff") {
      fetchImpl = () => new Response("bad request", { status: 400 });
      const context = { ...ctx, options: { ...ctx.options, retryCooldownMs: 60000 } };
      assert.equal(await onRequest(body, context), undefined);
      assert.equal(await onRequest(body, context), undefined);
      assert.equal(calls, 1, "fast upstream failure must back off instead of hammering compaction");
    } else if (scenario === "tool-turn-counting") {
      const mixed = [
        user("start"),
        { type: "web_search_call", id: "ws_1" },
        { type: "assistant", role: "assistant", content: "found" },
        { type: "local_shell_call", call_id: "sh_1" },
        { type: "local_shell_call_output", call_id: "sh_1", output: "ok" },
        { type: "mcp_call", call_id: "m_1" },
      ];
      assert.deepEqual(countStats(mixed), { users: 1, turns: 2 });
    }
    console.log(`PASS ${scenario} (${calls} summary calls)`);
  } finally {
    globalThis.setTimeout = timer;
    if (ownRoot) rmSync(rootDir, { recursive: true, force: true });
  }
}
