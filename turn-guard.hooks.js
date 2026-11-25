// turn-guard — magpie gateway hook (Bun, async request hook), v2
//
// Purpose: some relays (e.g. xingchi) reject a Responses request whose
// history has grown past a provider cap — xingchi (verified 2026-11-25):
// more than 20 user messages, or more than 100 model turns, in the
// request's `input` gets a 400 session_turn_limit_exceeded before the
// model ever sees it. Codex only compacts on a token budget, so a long
// session with many small turns dies on the turn count long before the
// token limit — and once it is over the cap even Codex's own /compact
// dies, because the compaction request carries the same over-cap
// history. The fold has to happen BEFORE the cap, which is this hook.
//
// Mechanism: Codex's OWN compaction, not a hand-written summary. When
// the user-message count or the model-turn count of a request reaches
// the configured threshold, the hook sends the older history plus a
// `compaction_trigger` item to the same gateway as a side request.
// magpie answers a trigger for one of its models itself: it swaps the
// trigger for Codex's official compact prompt, the model writes the
// handoff summary, and magpie seals it into a `compaction` item
// (encrypted_content "magpie1:...") returned in the response. The hook
// splices that item into the live request in place of the folded
// history; on later requests magpie expands the item back into the
// official summary user message, so upstream sees a short history:
// head + one summary user message + the recent tail.
//
// Timing: the splice is asynchronous. magpie bounds the whole
// request-hook chain to roughly 30 s (a hook's gatewayTimeoutMs is
// clamped to 100–30000 ms), and a compaction side request over a long
// history routinely takes longer — a hook that waits for it is timed
// out and its rewritten body discarded (learned the hard way,
// 2026-11-25: folds completed in the background while the gateway
// kept the original requests, and the session died at the cap). So
// crossing a threshold only STARTS the fold in the background; the
// request goes out as it came, and once the fold has landed in
// state, later requests splice it in with no model call. The one
// exception: when the counts are about to hit the cap itself, the
// hook waits for the in-flight fold (25 s, inside the budget) and
// splices it into that request — the cap is the one place a late
// fold is worthless.
//
// Incremental: the client resends its full raw history every request,
// so the hook remembers, per conversation, how many leading items are
// already folded into the stored compaction item (the "frontier").
// Later requests just splice [head, item, ...unfolded tail] with NO
// model call; a new compaction runs only when the spliced request
// would itself reach a threshold — and then the trigger request
// carries the previous item (magpie expands it), so the new summary
// merges the old one with the newly folded turns. A compaction side
// request must itself stay under the caps, so a history that is
// already far over them (the hook was off, the session predates it)
// is folded in slices: each slice's request carries the previous
// slice's item, and the final item covers everything. The client's own
// token-based compaction is untouched: it puts a compaction item of
// its own in the history, counts restart after it, and this hook's
// state for the old history simply stops matching and is dropped.
//
// Counting: a "model turn" is one model response — a run of model-side
// items (reasoning / assistant message / tool calls) ended by a user or
// developer message or a tool output. On a real 190-call Codex session
// this count came out at 189. A compaction item counts as one user
// message (what it expands to upstream) and zero turns. The provider's
// exact turn unit is its own; both thresholds are configurable, and
// the near-cap wait is the backstop when the margin runs out.
//
// Recursion: a request already containing a compaction_trigger (this
// hook's side request, or Codex's own /compact) passes through
// untouched.
//
// Fail-open: any error returns undefined and the request goes out as-is.
//
// Options (magpie plugin options <path> '{...}'):
//   providers:       ["xingchi"]  provider id prefixes to guard
//   userThreshold:   19           start folding at this many user msgs
//   turnThreshold:   95           start folding at this many model turns
//   userCap:         20           provider hard cap on user messages
//   turnCap:         100          provider hard cap on model turns
//   keepRecentUsers: 3            user turns kept verbatim in the tail
//   keepRecentTurns: 20           model turns kept verbatim in the tail
//   compactModel:    ""           model for the compaction side request;
//                                 "" = the request's own model
//   gatewayUrl:      "http://127.0.0.1:3425/v1"  this magpie's gateway
//   gatewayTimeoutMs: (magpie hook option, set alike — the host clamps
//                                 it to at most 30000 ms, which bounds
//                                 the whole hook chain; folding itself
//                                 runs in the background, see below)
// The gateway bearer token is read at runtime from ~/.codex/config.toml
// ([model_providers.magpie] experimental_bearer_token) so no secret is
// stored in the plugin or its options.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// State lives beside the hook file first (always writable: the host
// loaded the file from there; a GUI app's host may have a HOME that
// isn't the user's, which silently lost state on the Mac build), with
// ~/.config/magpie as fallback.
const STATE_CANDIDATES = [
  import.meta.dir + "/turn-guard-state.json",
  homedir() + "/.config/magpie/turn-guard-state.json",
];
let statePath = null;
const CODEX_CONFIG = homedir() + "/.codex/config.toml";

const DEFAULTS = {
  providers: ["xingchi"],
  userThreshold: 19,
  turnThreshold: 95,
  userCap: 20,
  turnCap: 100,
  keepRecentUsers: 3,
  keepRecentTurns: 20,
  compactModel: "",
  gatewayUrl: "http://127.0.0.1:3425/v1",
};

// Folds in flight, by conversation key: the compaction side requests
// run in the background (the hook chain's budget is far shorter than
// a compaction), and the finished item is picked up from state by
// later requests. One job per conversation at a time.
// NEAR_CAP_WAIT_MS stays inside the host's hook budget (~30 s).
const inflight = new Map();
const NEAR_CAP_WAIT_MS = 25000;

function loadState() {
  for (const p of STATE_CANDIDATES) {
    try {
      if (existsSync(p)) {
        statePath = p;
        return JSON.parse(readFileSync(p, "utf8"));
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
    try {
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, JSON.stringify(state));
      statePath = p;
      return;
    } catch {}
  }
}

function gatewayToken() {
  try {
    const toml = readFileSync(CODEX_CONFIG, "utf8");
    const section = toml.split("[model_providers.magpie]")[1] || "";
    const m = section.match(/experimental_bearer_token\s*=\s*"([^"]+)"/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function isUserMsg(item) {
  return item && item.role === "user" && (item.type === "message" || item.type === undefined);
}

function isAssistantMsg(item) {
  return item && item.role === "assistant" && (item.type === "message" || item.type === undefined);
}

function isClientMsg(item) {
  // user / developer / system message: client-side, ends a model turn
  return (
    item &&
    (item.type === "message" || item.type === undefined) &&
    (item.role === "user" || item.role === "developer" || item.role === "system")
  );
}

function isCompaction(item) {
  return item && (item.type === "compaction" || item.type === "compaction_summary");
}

function isTrigger(item) {
  return item && item.type === "compaction_trigger";
}

const MODEL_SIDE = new Set(["reasoning", "function_call", "custom_tool_call", "tool_search_call"]);
const TOOL_OUT = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);

function isSysDev(item) {
  return item && (item.role === "system" || item.role === "developer");
}

// User messages and model turns in items[start..]. A compaction item
// counts as one user message (it expands to the summary user message
// upstream) and no turn.
function countStats(items, start) {
  let users = 0;
  let turns = 0;
  let inTurn = false;
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object") continue;
    if (isUserMsg(it)) {
      users++;
      inTurn = false;
    } else if (isCompaction(it)) {
      users++;
      inTurn = false;
    } else if (isAssistantMsg(it) || MODEL_SIDE.has(it.type)) {
      if (!inTurn) {
        turns++;
        inTurn = true;
      }
    } else if (TOOL_OUT.has(it.type) || isClientMsg(it)) {
      inTurn = false;
    }
  }
  return { users, turns };
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
      if (lastClean === i && i > lastUserIdx) return i; // first clean cut past the last user turn that fits
    }
  }
  return lastClean;
}

function hashItems(items) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

// Ask the gateway to compact `inputItems` with Codex's own compaction
// and return the sealed compaction item. magpie answers the trigger
// itself with an SSE stream whose output item is the compaction item;
// a plain JSON response carrying one is accepted too.
async function callCompaction(inputItems, model, opts) {
  const token = gatewayToken();
  const res = await fetch(opts.gatewayUrl + "/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({
      model,
      input: [...inputItems, { type: "compaction_trigger" }],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error("compaction request failed: " + res.status);
  const text = await res.text();
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

    const input = body.input;

    // Already a compaction request (Codex's own /compact, or this
    // hook's side request coming back through the gateway): untouched.
    if (input.some(isTrigger)) return undefined;

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

    // Conversation identity: hash of the first two user messages (plus
    // the client's own compaction item when present), stable across
    // the session's requests, changed by client-side compaction.
    const secondUser = input.findIndex((it, i) => i > firstUser && isUserMsg(it));
    const keyParts = secondUser >= 0 ? [input[firstUser], input[secondUser]] : [input[firstUser]];
    if (nativeIdx >= 0) keyParts.push(input[nativeIdx]);
    const headKey = hashItems(keyParts);

    const state = loadState();
    const sess = state.sessions[headKey];

    // Prior fold state counts only if it is a v2 entry and the folded
    // prefix still matches the raw history item for item.
    let priorItem = null;
    let priorFolded = 0;
    if (
      sess &&
      sess.compactionItem &&
      sess.frontierItems > 0 &&
      headEnd + sess.frontierItems <= input.length &&
      hashItems(input.slice(headEnd, headEnd + sess.frontierItems)) === sess.prefixHash
    ) {
      priorItem = sess.compactionItem;
      priorFolded = sess.frontierItems;
    }

    const restStart = headEnd + priorFolded;
    const rest = input.slice(restStart);
    // System/developer items lifted out of the folded region in earlier
    // folds; they keep their place before the compaction item on every
    // splice, so the effective history does not change shape between
    // the fold request and the requests after it.
    const keptSysPrior = priorItem && Array.isArray(sess.keptSys) ? sess.keptSys : [];
    const effective = priorItem ? [...head, ...keptSysPrior, priorItem, ...rest] : input;
    const effStats = countStats(effective, 0);

    // Below both thresholds: send the spliced history if we have one,
    // the raw request if we don't.
    if (effStats.users < opts.userThreshold && effStats.turns < opts.turnThreshold) {
      if (priorItem) {
        sess.updatedAt = Date.now();
        saveState(state);
        return { ...body, input: effective };
      }
      return undefined;
    }

    // --- Over a threshold. Folding is asynchronous: magpie gives the
    // whole request-hook chain a hard budget (a hook's
    // gatewayTimeoutMs is clamped to at most 30 s by the host), and a
    // compaction side request over a long history routinely takes
    // longer — a hook that waits for it is timed out and its result
    // discarded ("gateway request hook failed or timed out; keeping
    // request"). So the fold runs in the background: this request
    // goes out as it came (or with the previous fold spliced in), the
    // finished fold is saved to state, and later requests splice it
    // in on the fast path above. Only when the counts are about to
    // hit the provider cap do we wait — within the budget — for an
    // in-flight fold, rather than let the request die at the cap.
    const nearCap =
      effStats.users >= opts.userCap - 1 || effStats.turns >= opts.turnCap - 3;

    let job = inflight.get(headKey);
    if (!job) {
      // Plan the fold from this request's snapshot: keep a tail
      // within the keep budgets, compact the rest.
      let lastUserIdx = -1;
      for (let i = input.length - 1; i >= restStart; i--) {
        if (isUserMsg(input[i])) {
          lastUserIdx = i;
          break;
        }
      }
      // No user message after the frontier — one marathon user turn
      // whose tool rounds alone crossed the threshold. Fold its older
      // rounds anyway (the tail keeps the recent ones); anchoring the
      // cut search at the head user message is safe, the cut itself
      // still has to be a clean one.
      if (lastUserIdx < 0) lastUserIdx = firstUser;

      const cut = chooseCut(input, restStart + 1, lastUserIdx, opts);
      if (cut <= restStart) return priorItem ? { ...body, input: effective } : undefined;

      const foldRaw = input.slice(restStart, cut);
      if (!foldRaw.length) return priorItem ? { ...body, input: effective } : undefined;

      // Mid-history system/developer items keep their place in the
      // live request (before the compaction item); the rest is
      // compacted.
      const keptSys = [...keptSysPrior, ...foldRaw.filter(isSysDev)];
      const toFold = foldRaw.filter((it) => !isSysDev(it));
      if (!toFold.length) return priorItem ? { ...body, input: effective } : undefined;

      const snapshot = input;
      const baseItem = priorItem;
      const baseFolds = priorItem ? sess.folds || 1 : 0;
      job = (async () => {
        try {
          // Compact the fold portion, in slices if needed: a
          // compaction side request must itself stay under the caps
          // (magpie adds the compact prompt as one more user message,
          // and the provider counts the turns it is shown), so a
          // history that is already far over the cap is folded slice
          // by slice — each slice's request carries the previous
          // slice's item, which magpie expands, so the final item
          // covers everything. With the default thresholds a fold is
          // a single slice.
          let item = baseItem;
          // Slice ends: indices of toFold where a turn has just ended
          // (or the end of the array) — a slice never cuts a turn in
          // half.
          const ends = [];
          {
            let inTurn = false;
            for (let i = 0; i < toFold.length; i++) {
              const it = toFold[i];
              if (!it || typeof it !== "object") continue;
              if (isAssistantMsg(it) || MODEL_SIDE.has(it.type)) inTurn = true;
              else if (TOOL_OUT.has(it.type) || isClientMsg(it) || isCompaction(it)) {
                if (inTurn) ends.push(i + 1);
                inTurn = false;
              }
            }
            if (!ends.length || ends[ends.length - 1] !== toFold.length) ends.push(toFold.length);
          }
          let pos = 0;
          let slices = 0;
          while (pos < toFold.length) {
            if (++slices > 32) return null;
            // Largest slice end whose side request stays under the
            // caps; the first end past pos if even that does not fit
            // (best effort: one whole turn is the smallest unit).
            let chosen = -1;
            for (const e of ends) {
              if (e <= pos) continue;
              const s = countStats([...head, ...(item ? [item] : []), ...toFold.slice(pos, e)], 0);
              if (s.users <= opts.userCap - 1 && s.turns <= opts.turnCap - 5) {
                chosen = e;
              } else {
                if (chosen < 0) chosen = e;
                break;
              }
            }
            if (chosen < 0) return null;
            item = await callCompaction(
              [...head, ...(item ? [item] : []), ...toFold.slice(pos, chosen)],
              opts.compactModel || body.model,
              opts,
            );
            pos = chosen;
          }
          if (!item || pos < toFold.length) return null;

          const newFrontier = priorFolded + foldRaw.length;
          const st = loadState();
          st.sessions[headKey] = {
            v: 2,
            compactionItem: item,
            keptSys,
            frontierItems: newFrontier,
            prefixHash: hashItems(snapshot.slice(headEnd, headEnd + newFrontier)),
            folds: baseFolds + 1,
            updatedAt: Date.now(),
          };
          saveState(st);
          return item;
        } catch {
          return null;
        }
      })();
      inflight.set(headKey, job);
      const done = () => {
        if (inflight.get(headKey) === job) inflight.delete(headKey);
      };
      job.then(done, done);
    }

    // A previous fold keeps serving while the new one brews.
    if (priorItem && !nearCap) return { ...body, input: effective };
    if (!nearCap) return undefined;

    // About to hit the cap: wait for the fold, within the hook
    // budget, and splice it into this request if it lands in time.
    const landed = await Promise.race([
      job,
      new Promise((r) => setTimeout(() => r(null), NEAR_CAP_WAIT_MS)),
    ]);
    if (!landed) return priorItem ? { ...body, input: effective } : undefined;
    const st2 = loadState();
    const s2 = st2.sessions[headKey];
    if (
      s2 &&
      s2.compactionItem &&
      s2.frontierItems > 0 &&
      headEnd + s2.frontierItems <= input.length &&
      hashItems(input.slice(headEnd, headEnd + s2.frontierItems)) === s2.prefixHash
    ) {
      const kept2 = Array.isArray(s2.keptSys) ? s2.keptSys : [];
      return {
        ...body,
        input: [...head, ...kept2, s2.compactionItem, ...input.slice(headEnd + s2.frontierItems)],
      };
    }
    return priorItem ? { ...body, input: effective } : undefined;
  } catch {
    return undefined; // fail open: send the request as it came
  }
}
