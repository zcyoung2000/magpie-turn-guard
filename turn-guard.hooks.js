// turn-guard — magpie gateway hook (Bun, async request hook)
//
// Purpose: some relays (e.g. xingchi) reject a Responses request whose
// `input` contains more than N user messages (xingchi: 10 max, the 11th
// gets a 400 session_turn_limit_exceeded before the model ever sees it).
// Codex only compacts on a token budget, so a long session with many
// small turns dies on the turn count long before the token limit.
//
// This hook runs before routing. For configured providers (matched by
// the model name's provider prefix, e.g. "xingchi/gpt-6.1-sol"), when
// the user-turn count reaches `threshold`, it folds the older turns
// into one summary user message — the same shape Codex's own compaction
// produces (environment context + summary + recent turns verbatim).
//
// Incremental: the client resends its full raw history every request,
// so the hook remembers, per conversation, how many leading items are
// already folded into the stored summary (the "frontier"). Later
// requests just splice [head, summary, ...unfolded tail] with NO model
// call; a new summary is written only when the spliced request would
// itself exceed `maxUsers` — roughly one summary call per
// (maxUsers - keepRecent - 1) new turns instead of one per turn.
// The fold call merges the previous summary with the newly folded
// turns, so facts survive repeated folds. The client's own token-based
// compaction is untouched (it changes the history's head, which this
// hook detects as a new conversation and starts over).
//
// Fail-open: any error returns undefined and the request goes out as-is.
//
// Options (magpie plugin options <path> '{...}'):
//   providers:    ["xingchi"]            provider id prefixes to guard
//   threshold:    9                      first fold when user turns >= this
//   maxUsers:     10                     never send more user msgs than this
//   keepRecent:   3                      newest user turns kept verbatim
//   summaryModel: "xingchi/gpt-6.1-sol"  model asked to write summaries
//   gatewayUrl:   "http://127.0.0.1:3425/v1"  this magpie's own gateway
//   gatewayTimeoutMs: 30000              (magpie hook option, set alike)
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
  threshold: 9,
  maxUsers: 10,
  keepRecent: 3,
  summaryModel: "xingchi/gpt-6.1-sol",
  gatewayUrl: "http://127.0.0.1:3425/v1",
};

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

function countUsers(items) {
  let n = 0;
  for (const it of items) if (isUserMsg(it)) n++;
  return n;
}

function itemText(item) {
  const c = item && item.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : p.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function hashItems(items) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function serialize(items) {
  const lines = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message" || item.role) {
      const t = itemText(item).slice(0, 2000);
      if (t) lines.push(`${item.role || "user"}: ${t}`);
    } else if (item.type === "function_call") {
      lines.push(`assistant tool_call ${item.name}(${(item.arguments || "").slice(0, 300)})`);
    } else if (item.type === "function_call_output") {
      lines.push(`tool_output: ${(item.output || "").slice(0, 500)}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > 60000) {
    text = text.slice(0, 40000) + "\n[... middle truncated for summarization ...]\n" + text.slice(-20000);
  }
  return text;
}

async function callSummaryModel(promptText, opts) {
  const token = gatewayToken();
  const res = await fetch(opts.gatewayUrl + "/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({
      model: opts.summaryModel,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: promptText }] }],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error("summary request failed: " + res.status);
  const data = await res.json();
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) return part.text;
    }
  }
  throw new Error("summary response had no text");
}

function summarizeFresh(items, opts) {
  return callSummaryModel(
    "Summarize the following conversation excerpt so the conversation can continue " +
      "without the original turns. Preserve every fact, name, number, decision, " +
      "constraint, identifier and codeword exactly. Be compact but complete.\n\n" +
      serialize(items),
    opts,
  );
}

function summarizeFold(prevSummary, items, opts) {
  return callSummaryModel(
    "Here is the summary of the earlier part of a conversation, followed by more turns. " +
      "Merge them into ONE updated summary so the conversation can continue without the " +
      "original turns. Preserve every fact, name, number, decision, constraint, " +
      "identifier and codeword exactly. Be compact but complete.\n\n" +
      "=== Previous summary ===\n" +
      prevSummary +
      "\n\n=== More turns ===\n" +
      serialize(items),
    opts,
  );
}

// Index in `items` where the last `k` user turns begin (item index of the
// k-th-from-last user message). Returns items.length if fewer than k.
function tailStartIndex(items, k) {
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (isUserMsg(items[i])) {
      seen++;
      if (seen === k) return i;
    }
  }
  return 0;
}

export async function onRequest(body, ctx) {
  try {
    const opts = { ...DEFAULTS, ...(ctx.options || {}) };
    if (!body || !Array.isArray(body.input) || typeof body.model !== "string") return undefined;
    const provider = body.model.split("/")[0];
    if (!opts.providers.includes(provider)) return undefined;

    const input = body.input;
    const totalUsers = countUsers(input);
    if (totalUsers < opts.threshold) return undefined;

    const firstUser = input.findIndex(isUserMsg);
    if (firstUser < 0) return undefined;
    const headEnd = firstUser + 1; // leading system/developer items + first user (env context)
    const head = input.slice(0, headEnd);
    const headUsers = countUsers(head); // normally 1

    // Conversation identity: hash of the head plus the first real turn,
    // stable across the session's requests, changed by client compaction.
    const secondUser = input.findIndex((it, i) => i > firstUser && isUserMsg(it));
    const headKey = hashItems(secondUser >= 0 ? [input[firstUser], input[secondUser]] : [input[firstUser]]);

    const state = loadState();
    const sess = state.sessions[headKey];

    const summaryMsg = (text) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[Earlier conversation compacted automatically by turn-guard]\n" + text }],
    });

    // --- Fast path: frontier still matches, splice without a model call
    // unless the spliced request would itself exceed maxUsers.
    if (sess && sess.frontierItems > 0) {
      const folded = input.slice(headEnd, headEnd + sess.frontierItems);
      if (folded.length === sess.frontierItems && hashItems(folded) === sess.prefixHash) {
        const rest = input.slice(headEnd + sess.frontierItems);
        const splicedUsers = headUsers + 1 + countUsers(rest);
        if (splicedUsers <= opts.maxUsers) {
          sess.updatedAt = Date.now();
          saveState(state);
          return { ...body, input: [...head, summaryMsg(sess.summary), ...rest] };
        }
        // Fold more: keep the last keepRecent user turns of `rest` verbatim,
        // merge the old summary with everything before them.
        const tIdx = tailStartIndex(rest, opts.keepRecent);
        const foldItems = rest.slice(0, tIdx);
        const tail = rest.slice(tIdx);
        if (foldItems.length) {
          const keptSys = foldItems.filter((it) => it && (it.role === "system" || it.role === "developer"));
          const toFold = foldItems.filter((it) => !(it && (it.role === "system" || it.role === "developer")));
          const newSummary = toFold.length ? await summarizeFold(sess.summary, toFold, opts) : sess.summary;
          const newFrontier = sess.frontierItems + foldItems.length;
          state.sessions[headKey] = {
            summary: newSummary,
            frontierItems: newFrontier,
            prefixHash: hashItems(input.slice(headEnd, headEnd + newFrontier)),
            folds: (sess.folds || 1) + 1,
            updatedAt: Date.now(),
          };
          saveState(state);
          return { ...body, input: [...head, ...keptSys, summaryMsg(newSummary), ...tail] };
        }
      }
      // Frontier mismatch (history changed under us): fall through to a
      // fresh fold of the whole conversation.
    }

    // --- Fresh fold: summarize everything except the last keepRecent turns.
    const restAll = input.slice(headEnd);
    const tIdx = tailStartIndex(restAll, opts.keepRecent);
    const foldItems = restAll.slice(0, tIdx);
    const tail = restAll.slice(tIdx);
    if (!foldItems.length) return undefined;
    const keptSys = foldItems.filter((it) => it && (it.role === "system" || it.role === "developer"));
    const toFold = foldItems.filter((it) => !(it && (it.role === "system" || it.role === "developer")));
    if (!toFold.length) return undefined;
    const summary = await summarizeFresh(toFold, opts);
    state.sessions[headKey] = {
      summary,
      frontierItems: foldItems.length,
      prefixHash: hashItems(foldItems),
      folds: 1,
      updatedAt: Date.now(),
    };
    saveState(state);
    return { ...body, input: [...head, ...keptSys, summaryMsg(summary), ...tail] };
  } catch {
    return undefined; // fail open: send the request as it came
  }
}
