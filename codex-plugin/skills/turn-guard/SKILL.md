---
name: turn-guard
description: Inspect or configure Magpie Turn Guard's native Codex compaction, show connection failures and recent results, or request a compact of an idle session.
---

Resolve `../../scripts/turn_guard.py` relative to this skill directory.

- For status, run `python3 <resolved-script> status`. Report observed hook counts,
  model allowlist, thresholds, connection status, and the last compaction result. Installation
  alone is not evidence that hooks are trusted or native compaction worked.
- Only exact model names in `allowedModels` are eligible. The default is
  `["xingchi/gpt-6.1-sol"]`; other or unknown models do not count, inject context,
  or queue compaction. To replace the allowlist at the user's request, run
  `configure --allow-model MODEL` (repeat the flag for multiple models).
  The controller rechecks the live model before requesting compaction and
  reports `skipped_model` for unlisted models. Explicit `compact` requests
  also respect the model allowlist.
- To change thresholds at the user's request, run `configure --user-threshold N
  --model-threshold N`. These count observed user submissions and completed
  model requests since the last checkpoint, not upstream wire messages.
- To disable or enable automatic requests, run `configure --disabled` or
  `configure --enabled` when requested.
- For an explicit compact request, use `compact --session SESSION_ID` with an
  actual session ID from the status output. The controller waits for idle and
  refuses to resume a thread that is not loaded in the connected server.

Automatic compaction runs after a completed user turn through the public
`codex app-server proxy` command. A CLI using the shared daemon can support it;
an embedded host may not. Report `unavailable` honestly. Do not start another
server, edit rollouts, fabricate usage, bypass hook trust, or interrupt an
active task to make the plugin appear to work. A daemon-less CLI and hosts
without this control channel need a separate integration.
