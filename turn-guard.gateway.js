import { DEFAULTS, atCap } from "./turn-guard.shared.js";

// Runs AFTER the async hook, including when Magpie discarded a timed-out hook.
// Async hooks cannot reject; this separate middleware is the final safety check.
export function onRequest(body, ctx) {
  const opts = { ...DEFAULTS, ...(ctx.options || {}) };
  if (!body || !Array.isArray(body.input) || typeof body.model !== "string") return;
  if (!opts.providers.includes(body.model.split("/")[0])) return;
  if (atCap(body.input, opts)) {
    ctx.reject(503, "turn-guard: no usable context summary is ready for this history. Retry shortly while compaction runs; the over-limit history was not sent to the provider.");
  }
}
