// turn-guard v2.4 — gateway-side, incremental history folding for Codex.
// This does not invoke the client's native compaction lifecycle or UI.
//
// At the configured thresholds, ask Magpie for a compaction summary in the
// background. Save the folded raw prefix and splice the expanded summary user
// message into subsequent requests (Magpie runs codexInputAs BEFORE gateway
// hooks, so raw "magpie1:" compaction items injected by a hook are NOT
// expanded by Magpie on passthrough/translated routes and must be decoded
// here). The client continues to send raw history, so exact prefix checks are
// required on every reuse. A native client compaction starts a new key.
//
// State MUST live outside the plugin directory: Magpie's path-plugin watcher
// (pathstamp.go) hashes files inside the plugin folder every second and
// restarts the Bun plugin host whenever one changes, which would kill any
// in-flight background compaction.
//
// Each background job has its own bounded lifetime (compactTimeoutMs); it
// must NOT inherit ctx.signal, which Magpie aborts when the hook returns.
// Near the provider cap, wait within the current hook's actual budget. A
// separate synchronous middleware rejects any still-over-cap history with
// 503 after this hook, even if the host times the hook out. No history is
// silently truncated to force a request through.
//
// Defaults and counter helpers live in turn-guard.shared.js. Install the
// directory package to load BOTH this hook and turn-guard.gateway.js.
// Gateway credentials are read from the Magpie provider section of the
// Codex config at runtime, never persisted in plugin state/options.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULTS, isUserMsg, isAssistantMsg, isClientMsg, isCompaction, isTrigger,
  MODEL_SIDE, TOOL_OUT, countStats, atCap,
} from "./turn-guard.shared.js";

function resolveHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

// Keep state OUTSIDE the plugin directory so writes never trigger Magpie's
// path-plugin hot-reload watcher (which restarts Bun and kills in-flight folds).
const STATE_CANDIDATES = [
  ...(process.env.TURN_GUARD_STATE_PATH ? [process.env.TURN_GUARD_STATE_PATH] : []),
  join(resolveHome(), ".config", "magpie", "turn-guard-state.json"),
  join(resolveHome(), ".cache", "magpie", "turn-guard-state.json"),
  join(tmpdir(), "magpie-turn-guard-state.json"),
];
let statePath = null;
const CODEX_CONFIG = join(resolveHome(), ".codex", "config.toml");

// Official Codex summary prefix & Magpie seal format (matches Magpie's
// internal/codexsummary/codexsummary.go and internal/gateway/codex_backend.go).
const MAGPIE_SEAL_MARK = "magpie1:";
const MAGPIE_LOCAL_FALLBACK_PREFIX = "magpie compacted this conversation without a model (";
export const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. " +
  "You also have access to the state of the tools that were used by that language model. " +
  "Use this to build on the work that has already been done and avoid duplicating work. " +
  "Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

// Folds in flight, by job key, plus failure cooldown by headKey.
const inflight = new Map();
const failedCooldown = new Map();
const NEAR_CAP_WAIT_MS = 25000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

function logWarn(msg) {
  try {
    console.warn("[turn-guard]", msg);
  } catch {}
}

function decodeMagpieSummary(encrypted) {
  if (typeof encrypted !== "string" || !encrypted.startsWith(MAGPIE_SEAL_MARK)) {
    return { ours: false, ok: false, summary: "" };
  }
  try {
    const summary = Buffer.from(encrypted.slice(MAGPIE_SEAL_MARK.length), "base64").toString("utf8");
    const trimmed = summary.trim();
    if (!trimmed || trimmed.startsWith(MAGPIE_LOCAL_FALLBACK_PREFIX)) {
      return { ours: true, ok: false, summary: trimmed };
    }
    return { ours: true, ok: true, summary };
  } catch {
    return { ours: true, ok: false, summary: "" };
  }
}

// Convert a stored compaction item into an input item safe for live upstream
// requests AFTER Magpie's codexInputAs stage. Magpie-sealed ("magpie1:") items
// are decoded into Codex's official summary user message; degraded local
// fallbacks are rejected (return null); native items pass through untouched.
function toLiveItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "compaction" || item.type === "compaction_summary") {
    const enc = item.encrypted_content;
    if (typeof enc !== "string" || !enc) return null;
    const dec = decodeMagpieSummary(enc);
    if (dec.ours) {
      if (!dec.ok) return null;
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_SUMMARY_PREFIX + "\n" + dec.summary }],
      };
    }
    return item;
  }
  if (isUserMsg(item)) return item;
  return null;
}

function loadState() {
  for (const p of statePath ? [statePath, ...STATE_CANDIDATES.filter((c) => c !== statePath)] : STATE_CANDIDATES) {
    try {
      if (existsSync(p)) {
        const state = JSON.parse(readFileSync(p, "utf8"));
        if (state && state.sessions && typeof state.sessions === "object" && !Array.isArray(state.sessions)) {
          statePath = p;
          return state;
        }
      }
    } catch {}
  }
  return { sessions: {} };
}

function saveState(state) {
  const entries = Object.entries(state.sessions || {});
  if (entries.length > 24) {
    entries.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    state.sessions = Object.fromEntries(entries.slice(entries.length - 24));
  }
  for (const p of statePath ? [statePath] : STATE_CANDIDATES) {
    const tmp = p + "." + randomUUID() + ".tmp";
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, p);
      statePath = p;
      return true;
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      logWarn(`failed to write state to ${p}: ${err?.code || err?.message || "unknown error"}`);
    }
  }
  return false;
}

function gatewayToken() {
  try {
    const toml = readFileSync(CODEX_CONFIG, "utf8");
    const idx = toml.indexOf("[model_providers.magpie]");
    if (idx < 0) return "";
    const after = toml.slice(idx + "[model_providers.magpie]".length);
    const nextSection = after.search(/\r?\n\[/);
    const section = nextSection >= 0 ? after.slice(0, nextSection) : after;
    const m = section.match(/experimental_bearer_token\s*=\s*"([^"]+)"/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function isSysDev(item) {
  return item && (item.role === "system" || item.role === "developer");
}

// A clean place to cut the history: the tail may start here without
// orphaning a tool output (its call folded away) — a client message, a
// developer message, or a model-side item that begins a fresh turn
// (the previous item is a tool output or a client message).
function isCleanCut(items, i) {
  if (i <= 0 || i >= items.length) return i === items.length;
  const it = items[i];
  if (!it || typeof it !== "object") return false;
  if (isClientMsg(it)) return true;
  if (isAssistantMsg(it) || MODEL_SIDE.has(it.type)) {
    const prev = items[i - 1];
    return !!prev && (TOOL_OUT.has(prev.type) || isClientMsg(prev));
  }
  return false;
}

// Smallest clean cut index in (from, lastUserIdx] whose tail satisfies
// both keep budgets; if none does, the smallest clean cut after
// lastUserIdx that satisfies the turn budget (a single user turn with
// more tool rounds than the budget); if still none, the last clean cut.
function chooseCut(items, from, lastUserIdx, opts) {
  let lastClean = -1;
  for (let i = from; i <= items.length; i++) {
    if (!isCleanCut(items, i)) continue;
    lastClean = i;
    const s = countStats(items, i);
    if (s.users <= opts.keepRecentUsers && s.turns <= opts.keepRecentTurns) {
      if (i <= lastUserIdx) return i;
      return i; // first clean cut past the last user turn that fits
    }
  }
  return lastClean;
}

function hashItems(items) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

// Background work outlives ctx.signal: Magpie aborts that signal even after a
// successful onRequest return. Give each job its own bounded lifetime instead.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("compaction aborted"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function waitForJob(promise, ms, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => finish(null);
    if (signal?.aborted) { finish(null); return; }
    timer = setTimeout(aborted, ms);
    signal?.addEventListener("abort", aborted, { once: true });
    promise.then(finish, () => finish(null));
  });
}

// Ask the gateway to compact `inputItems` with Codex's own compaction
// and return the sealed compaction item. Forward instructions, store: false,
// stream: true, and a low reasoning effort so ChatGPT-backend relays (e.g.
// Xingchi) accept the request cleanly and finish well within budget.
async function callCompaction(inputItems, model, reqMeta, opts, signal) {
  signal.throwIfAborted();
  if (atCap([...inputItems, { type: "compaction_trigger" }], opts)) {
    throw new Error("no compaction slice fits below the provider caps");
  }
  const token = gatewayToken();
  const payloadBody = {
    model,
    input: [...inputItems, { type: "compaction_trigger" }],
    stream: true,
    store: false,
  };
  if (typeof reqMeta.instructions === "string" && reqMeta.instructions) {
    payloadBody.instructions = reqMeta.instructions;
  }
  const effort = typeof opts.compactReasoningEffort === "string" ? opts.compactReasoningEffort.trim() : "";
  if (effort) {
    payloadBody.reasoning = { effort };
  }
  const res = await abortable(fetch(opts.gatewayUrl + "/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(payloadBody),
  }), signal);
  if (!res.ok) throw new Error("compaction request failed: HTTP " + res.status);
  const text = await abortable(res.text(), signal);
  let item = null;
  const take = (o) => {
    if (o && o.type === "compaction" && typeof o.encrypted_content === "string" && o.encrypted_content) {
      item = o;
    }
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.type === "response.output_item.done") take(ev.item);
    if (ev.type === "response.completed" && ev.response && Array.isArray(ev.response.output)) {
      for (const o of ev.response.output) take(o);
    }
  }
  if (!item && text.trim().startsWith("{")) {
    try {
      const data = JSON.parse(text);
      for (const o of data.output || []) take(o);
    } catch {}
  }
  if (!item) throw new Error("compaction response had no compaction item");
  const dec = decodeMagpieSummary(item.encrypted_content);
  if (dec.ours && !dec.ok) {
    throw new Error("compaction returned degraded local fallback summary");
  }
  const out = { type: "compaction", encrypted_content: item.encrypted_content };
  if (item.id) out.id = item.id;
  return out;
}

export async function onRequest(body, ctx) {
  try {
    const opts = { ...DEFAULTS, ...(ctx.options || {}) };
    if (!body || !Array.isArray(body.input) || typeof body.model !== "string") return undefined;
    const provider = body.model.split("/")[0];
    if (!opts.providers.includes(provider)) return undefined;

    let input = body.input;

    // Anti-recursion guard for any compaction_trigger request that reaches the
    // hook (note: Magpie normally intercepts compaction_trigger in codexInputAs
    // before hooks, except for providers configured with native compaction).
    let triggerItem = null;
    if (input.some(isTrigger)) {
      const histStats = countStats(input.filter((it) => !isTrigger(it)), 0);
      if (histStats.users + 1 < opts.userCap && histStats.turns < opts.turnCap) return undefined;
      triggerItem = input.find(isTrigger);
      input = input.filter((it) => !isTrigger(it));
      body = { ...body, input };
    }
    const out = (b) => (triggerItem && b ? { ...b, input: [...b.input, triggerItem] } : b);

    const firstUser = input.findIndex(isUserMsg);
    if (firstUser < 0) return undefined;

    // If the client compacted natively, its item sits in the history
    // and counts restart after it; everything up to and including it
    // is the untouchable prefix for folding purposes.
    let nativeIdx = -1;
    for (let i = input.length - 1; i > firstUser; i--) {
      if (isCompaction(input[i])) {
        nativeIdx = i;
        break;
      }
    }
    const headEnd = nativeIdx >= 0 ? nativeIdx + 1 : firstUser + 1;
    const head = input.slice(0, headEnd);

    // Prefer the gateway's stable session ID. On older hosts without one,
    // retain the two-user key for separation, but also look up the one-user
    // key so the first marathon task's saved/pending fold survives user #2.
    const secondUser = input.findIndex((it, i) => i > firstUser && isUserMsg(it));
    const keyParts = secondUser >= 0 ? [input[firstUser], input[secondUser]] : [input[firstUser]];
    if (nativeIdx >= 0) keyParts.push(input[nativeIdx]);
    const oneUserParts = [input[firstUser], ...(nativeIdx >= 0 ? [input[nativeIdx]] : [])];
    const legacyKey = hashItems(keyParts);
    const oneUserKey = hashItems(oneUserParts);
    const headKey = ctx.session
      ? hashItems([provider, ctx.session, ...oneUserParts])
      : legacyKey;
    const keys = [...new Set([headKey, legacyKey, oneUserKey])];
    const headHash = hashItems(head);
    const matches = (s) => s && s.compactionItem && !!toLiveItem(s.compactionItem) && s.frontierItems > 0 &&
      (!s.headHash || s.headHash === headHash) &&
      headEnd + s.frontierItems <= input.length &&
      hashItems(input.slice(headEnd, headEnd + s.frontierItems)) === s.prefixHash;

    const state = loadState();
    const sess = keys.map((key) => state.sessions[key]).filter(matches)
      .sort((a, b) => b.frontierItems - a.frontierItems)[0];

    // Reuse only a saved item whose folded prefix matches item for item
    // and whose decoded summary is valid (not a Magpie local fallback).
    let priorItem = null;
    let priorLive = null;
    let priorFolded = 0;
    if (sess) {
      priorItem = sess.compactionItem;
      priorLive = toLiveItem(priorItem);
      priorFolded = sess.frontierItems;
    }

    const restStart = headEnd + priorFolded;
    const rest = input.slice(restStart);
    const keptSysPrior = priorLive && Array.isArray(sess.keptSys) ? sess.keptSys : [];
    const effective = priorLive ? [...head, ...keptSysPrior, priorLive, ...rest] : input;
    const effStats = countStats(effective, 0);

    // Below both thresholds: send the spliced history if we have one,
    // the raw request if we don't. Avoid rewriting state on every cache hit.
    if (effStats.users < opts.userThreshold && effStats.turns < opts.turnThreshold) {
      if (priorLive) {
        if (Date.now() - (sess.updatedAt || 0) > TOUCH_INTERVAL_MS) {
          sess.updatedAt = Date.now();
          saveState(state);
        }
        return out({ ...body, input: effective });
      }
      return undefined;
    }

    const nearCap =
      effStats.users >= opts.userCap - 1 || effStats.turns >= opts.turnCap - 3;

    // Never reuse a job for a different history branch just because the
    // opening messages/session match. Appending to its snapshot is safe.
    let pending = [...inflight.values()].find((entry) => keys.includes(entry.headKey) &&
      entry.cut <= input.length && hashItems(input.slice(0, entry.cut)) === entry.snapshotHash);
    if (!pending) {
      // Back off after a recent non-timeout failure so retries do not spam
      // upstream and trip Magpie's 3-strike 5-minute compaction circuit breaker.
      const cooldownMs = Number.isFinite(opts.retryCooldownMs) && opts.retryCooldownMs >= 0
        ? opts.retryCooldownMs : DEFAULTS.retryCooldownMs;
      const lastFail = failedCooldown.get(headKey);
      if (lastFail && cooldownMs > 0 && Date.now() - lastFail < cooldownMs) {
        return priorLive ? out({ ...body, input: effective }) : undefined;
      }

      let lastUserIdx = -1;
      for (let i = input.length - 1; i >= restStart; i--) {
        if (isUserMsg(input[i])) {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) lastUserIdx = firstUser;

      const cut = chooseCut(input, restStart + 1, lastUserIdx, opts);
      if (cut <= restStart) return priorLive ? out({ ...body, input: effective }) : undefined;

      const foldRaw = input.slice(restStart, cut);
      if (!foldRaw.length) return priorLive ? out({ ...body, input: effective }) : undefined;

      const keptSys = [...keptSysPrior, ...foldRaw.filter(isSysDev)];
      const toFold = foldRaw.filter((it) => !isSysDev(it));
      if (!toFold.length) return priorLive ? out({ ...body, input: effective }) : undefined;

      const snapshot = input;
      const baseItem = priorItem;
      const baseFolds = priorItem ? sess.folds || 1 : 0;
      const reqMeta = {
        instructions: typeof body.instructions === "string" ? body.instructions : "",
      };
      const revision = (entry) => hashItems([entry?.prefixHash, entry?.compactionItem]);
      const baseRevision = revision(state.sessions[headKey]);
      const controller = new AbortController();
      const timeoutMs = Number.isFinite(opts.compactTimeoutMs) && opts.compactTimeoutMs > 0
        ? opts.compactTimeoutMs : DEFAULTS.compactTimeoutMs;
      let timedOut = false;
      const expiry = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("compaction timed out"));
      }, timeoutMs);
      const snapshotHash = hashItems(snapshot.slice(0, cut));
      const jobKey = headKey + ":" + snapshotHash;
      const targetModel = opts.compactModel || body.model;
      const promise = (async () => {
        try {
          let item = baseItem;
          const ends = [];
          for (let i = 1; i <= toFold.length; i++) {
            if (isCleanCut(toFold, i)) ends.push(i);
          }
          let pos = 0;
          let slices = 0;
          while (pos < toFold.length) {
            if (++slices > 32) {
              throw new Error("compaction exceeded max slice count");
            }
            const carryItem = item ? toLiveItem(item) : null;
            let chosen = -1;
            for (const e of ends) {
              if (e <= pos) continue;
              const s = countStats([...head, ...(carryItem ? [carryItem] : []), ...toFold.slice(pos, e)], 0);
              if (s.users <= opts.userCap - 2 && s.turns <= opts.turnCap - 5) {
                chosen = e;
              } else {
                if (chosen < 0) chosen = e;
                break;
              }
            }
            if (chosen < 0) {
              throw new Error("no clean cut available for compaction slice");
            }
            item = await callCompaction(
              [...head, ...keptSys, ...(carryItem ? [carryItem] : []), ...toFold.slice(pos, chosen)],
              targetModel,
              reqMeta,
              opts,
              controller.signal,
            );
            pos = chosen;
          }
          if (!item || pos < toFold.length) return null;
          controller.signal.throwIfAborted();

          const newFrontier = priorFolded + foldRaw.length;
          const st = loadState();
          const current = st.sessions[headKey];
          if (current && revision(current) !== baseRevision) {
            return matches(current) ? current.compactionItem : null;
          }
          st.sessions[headKey] = {
            v: 2,
            compactionItem: item,
            keptSys,
            frontierItems: newFrontier,
            prefixHash: hashItems(snapshot.slice(headEnd, headEnd + newFrontier)),
            headHash,
            folds: baseFolds + 1,
            updatedAt: Date.now(),
          };
          if (!saveState(st)) return null;
          failedCooldown.delete(headKey);
          return item;
        } catch (err) {
          if (!timedOut) {
            failedCooldown.set(headKey, Date.now());
          }
          logWarn(`background fold failed (${targetModel}, users=${effStats.users}, turns=${effStats.turns}): ${err?.message || "unknown error"}`);
          return null;
        }
      })();
      pending = { headKey, cut, snapshotHash, promise };
      inflight.set(jobKey, pending);
      const done = () => {
        clearTimeout(expiry);
        if (inflight.get(jobKey) === pending) inflight.delete(jobKey);
      };
      promise.then(done, done);
    }

    // A previous fold keeps serving while the new one brews.
    if (priorLive && !nearCap) return out({ ...body, input: effective });
    if (!nearCap) return undefined;

    // About to hit the cap: wait for the fold, within the hook
    // budget, and splice it into this request if it lands in time.
    const hookBudget = Number.isInteger(opts.gatewayTimeoutMs)
      ? Math.max(100, Math.min(30000, opts.gatewayTimeoutMs)) : 1000;
    const landed = await waitForJob(pending.promise,
      Math.min(NEAR_CAP_WAIT_MS, Math.max(0, hookBudget - 200)), ctx.signal);
    if (!landed) {
      ctx.report?.("unavailable");
      return priorLive ? out({ ...body, input: effective }) : undefined;
    }
    const st2 = loadState();
    const s2 = [...new Set([...keys, pending.headKey])].map((key) => st2.sessions[key]).filter(matches)
      .sort((a, b) => b.frontierItems - a.frontierItems)[0];
    const live2 = s2 ? toLiveItem(s2.compactionItem) : null;
    if (s2 && live2) {
      const kept2 = Array.isArray(s2.keptSys) ? s2.keptSys : [];
      return out({
        ...body,
        input: [...head, ...kept2, live2, ...input.slice(headEnd + s2.frontierItems)],
      });
    }
    return priorLive ? out({ ...body, input: effective }) : undefined;
  } catch (err) {
    logWarn(`onRequest error: ${err?.message || "unknown error"}`);
    return undefined; // The synchronous middleware still checks the final body.
  }
}
