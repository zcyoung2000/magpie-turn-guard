// Pure helpers shared by Bun's asynchronous hook and Magpie's synchronous JS runtime.
export const DEFAULTS = {
  providers: ["xingchi"],
  userThreshold: 18,
  turnThreshold: 90,
  userCap: 20,
  turnCap: 100,
  keepRecentUsers: 3,
  keepRecentTurns: 20,
  compactModel: "",
  compactReasoningEffort: "low",
  compactTimeoutMs: 270000,
  retryCooldownMs: 15000,
  gatewayUrl: "http://127.0.0.1:3425/v1",
};

export function isUserMsg(item) {
  return item && item.role === "user" && (item.type === "message" || item.type === undefined);
}

export function isAssistantMsg(item) {
  return item && item.role === "assistant" && (item.type === "message" || item.type === undefined);
}

export function isClientMsg(item) {
  return item && (item.type === "message" || item.type === undefined) &&
    (item.role === "user" || item.role === "developer" || item.role === "system");
}

export function isCompaction(item) {
  return item && (item.type === "compaction" || item.type === "compaction_summary");
}

export function isTrigger(item) {
  return item && item.type === "compaction_trigger";
}

export const MODEL_SIDE = new Set([
  "reasoning",
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
  "local_shell_call",
  "mcp_call",
]);
export const TOOL_OUT = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
  "local_shell_call_output",
]);

// A compaction item expands to one summary user message upstream.
export function countStats(items, start = 0) {
  let users = 0;
  let turns = 0;
  let inTurn = false;
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object") continue;
    if (isUserMsg(it) || isCompaction(it)) {
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

export function atCap(input, opts) {
  const stats = countStats(input);
  // Magpie replaces a trigger with one more user message (the compact prompt).
  const users = stats.users + (input.some(isTrigger) ? 1 : 0);
  return users >= opts.userCap || stats.turns >= opts.turnCap;
}
