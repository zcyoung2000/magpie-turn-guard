# magpie-turn-guard

A [magpie](https://github.com/yetone/magpie) gateway plugin that folds long
Codex histories before they hit a provider's message/turn caps. It combines an
asynchronous summary hook with a synchronous check before provider routing.

This hook folds history **inside the gateway**. It does not start the Codex
client's native compaction lifecycle, update its local history, or produce its
compaction UI. Reusing Codex's summary prompt does not provide those behaviors.
An overflow-error replacement was investigated and does not provide automatic
recovery in the tested clients; see [native compaction probe](docs/native-compaction-probe.md).
An explicit App Server compaction probe also found task interruption, retained
user content, and separate-process writer ownership constraints; see
[active compaction integration results](docs/app-server-compaction-probe.md).
The follow-up gateway probe distinguishes retained content from upstream
message counts: Magpie can merge adjacent user messages during translation.

## Why

Some relays (e.g. Xingchi, verified 2026-11-25) reject a Responses request
once its `input` holds more than 20 user messages, or more than 100 model
turns (`session_turn_limit_exceeded`) — long before any token limit.
Codex always sends the full history and only compacts on a token budget,
so a session with many small turns dies on the turn count. Worse, once a
history is over the cap, even Codex's own `/compact` dies with it: the
compaction request carries the same over-cap history. The fold has to
happen *before* the cap.

## What it does

For the configured providers it
watches two counters of each request — user messages and model turns
(one model response = one turn) — and folds the history with **Codex's
summary prompt through Magpie** when either reaches its threshold:

- The hook sends the older history plus a `compaction_trigger` item to
  the same gateway as a side request (forwarding `instructions`, `store: false`,
  `stream: true`, and a low reasoning effort). Magpie answers the trigger by
  swapping it for Codex's official compact prompt and sealing the model's
  handoff summary into a `magpie1:` compaction item. Because Magpie runs
  `codexInputAs` *before* gateway hooks, the hook decodes `magpie1:` itself
  (rejecting Magpie's degraded local-fallback placeholders) and splices the
  official Codex summary user message directly into the live request, so
  upstream always sees a standard short history: head + one summary + recent
  tail.
- Folding is **incremental**: the hook remembers the folded frontier
  per session, so later requests only splice (no model call) until the
  spliced history would again reach a threshold — then a new
  compaction merges the previous item with the newly folded turns.
- Folding is **asynchronous**: magpie bounds the whole request-hook
  chain to ~30 s (a hook's `gatewayTimeoutMs` is clamped to at most
  30000 ms), and a compaction over a long history routinely takes
  longer — a hook that waits for it is timed out and its rewritten
  body discarded. So crossing a threshold only *starts* the fold in
  the background; a request below the caps can proceed, and once the fold
  has landed in the state file, later requests splice it in. The one
  exception: when the counts are about to hit the cap itself, the
  hook waits for the in-flight fold (up to 25 s, shortened to fit the
  configured hook budget) and splices it into that request.
- The synchronous middleware checks the **actual body after the hook**.
  If it is still at/over either cap, it returns HTTP 503 before provider
  routing. This also protects a request whose async hook was discarded by
  Magpie on timeout. The client can retry while the summary finishes; it
  may still end the task if its retry budget expires. No history is dropped
  without a summary, and no token usage is fabricated to trigger compaction.
- Background jobs have an independent timeout (`compactTimeoutMs`, 270 s
  by default), including reading the summary response. Expired jobs are
  cancelled and removed so a later request can start another attempt.
  Returning from the foreground hook does not cancel its background job.
- Session IDs are used when available, with validated legacy cache lookup.
  A second user message no longer loses a first-task summary, even on hosts
  without session IDs. Incompatible branches do not share pending jobs, and
  late results cannot overwrite a concurrently committed summary. State
  files are replaced atomically; compatible v2 caches remain usable.
- A compaction side request must itself stay under the caps, so a
  history that is already far over them (the hook was off, the session
  predates it) is folded **in slices**: each slice's request carries
  the previous slice's item, and the final item covers everything.
- Requests already containing a `compaction_trigger` (Codex's own
  `/compact`, the hook's side requests) pass through untouched —
  unless their history is already at/over a cap, which the provider
  would reject: then the history is folded first and the trigger
  re-appended, so the compaction runs on the folded history.
- If the client's own token-based compaction rewrites the history, its
  compaction item restarts the counts and this hook's state for the
  old history stops matching and is dropped.
- A failed async hook keeps any usable previous fold, or the original body.
  The synchronous check then rejects that body if it still reaches a cap.

## Install the Magpie gateway plugin

The plugin is a directory package: `package.json` declares
`magpie.name` ("turn-guard", the name the magpie GUI shows),
`magpie.hooks` (the hook file) and `magpie.options` (the template the
GUI's options editor starts from), plus `magpie.middleware` (the final
cap check). Install the whole directory, not the hooks file alone, and keep
Magpie's built-in `middleware` plugin enabled. Both entry points are required
for the final cap check; disabling the middleware removes that protection.

```sh
magpie plugin add /path/to/magpie-turn-guard
magpie plugin options /path/to/magpie-turn-guard '{"gatewayTimeoutMs":30000,"userThreshold":18,"turnThreshold":90}'
```

Options can also be edited in the magpie GUI: Plugins page → the
"turn-guard" row → options editor (JSON, prefilled from the package
template or the saved values).

The gateway bearer token is read at runtime from `~/.codex/config.toml`
(`[model_providers.magpie] experimental_bearer_token`); no secret is stored
in the plugin. Fold state is kept outside the plugin directory in
`~/.config/magpie/turn-guard-state.json` (falling back to `~/.cache/magpie/`
or temp dir) so state writes never trigger Magpie's path-plugin hot-reload
watcher (`pathstamp.go`) and kill in-flight background folds.

## Install the Codex native-compaction plugin

This repository also includes a Codex plugin that requests native compaction
after an idle turn boundary through the shared Codex App Server. It is a
separate integration from the Magpie gateway plugin above. It works when the
Codex CLI can connect to the App Server that owns the loaded thread; embedded
hosts without that control channel report the limitation instead of starting a
second server or interrupting an active task.

```sh
codex plugin marketplace add zcyoung2000/magpie-turn-guard
codex plugin add magpie-turn-guard@magpie-turn-guard
```

Codex may ask you to review and trust the plugin hooks. The default model
allowlist is `xingchi/gpt-6.1-sol`; only exact listed model names are counted
or compacted. The plugin's `turn-guard` skill provides status, configuration,
and explicit idle-session compaction commands. Its settings and session state
are stored under `~/.codex/magpie-turn-guard/` (or `TURN_GUARD_DATA` when set).

## Options

Set via magpie plugin options (JSON):

| Option | Default | Meaning |
|---|---|---|
| `providers` | `["xingchi"]` | Model-name prefixes the guard applies to |
| `userThreshold` | `18` | Start a background fold at this many user messages |
| `turnThreshold` | `90` | Start a background fold at this many model turns |
| `userCap` | `20` | Provider hard cap on user messages |
| `turnCap` | `100` | Provider hard cap on model turns |
| `keepRecentUsers` | `3` | User turns kept verbatim in the tail |
| `keepRecentTurns` | `20` | Model turns kept verbatim in the tail |
| `compactModel` | `""` | Model for the compaction side request; empty = the request's own model |
| `compactReasoningEffort` | `"low"` | Reasoning effort for compaction side requests; empty = omit |
| `compactTimeoutMs` | `270000` | Total lifetime of one background fold, including all slices and reading responses |
| `retryCooldownMs` | `15000` | Backoff window after a non-timeout compaction failure to avoid tripping Magpie's 3-strike lockout |
| `gatewayUrl` | `http://127.0.0.1:3425/v1` | Gateway base URL for the side request |
| `gatewayTimeoutMs` | (host option) | The host clamps it to at most 30000 ms — that is the whole hook chain's budget. Folding itself runs in the background (see below), so 30000 is right. |

Earlier defaults were 19 users / 95 model turns. The new defaults allow more
time for a summary to finish. Saved plugin options override package defaults;
update those thresholds explicitly when upgrading if they still use the old values.

## Test

`test_gateway.py` is the v1-era end-to-end check (hand-written summary
path) and no longer applies to v2.

```sh
bun run test
```

The gateway regression suite copies the actual modules into isolated temporary
homes and uses fake summary responses. It checks that folded raw history
disappears from the outgoing request, that cached summaries survive another user
message and host restart, that stalled jobs expire, that late jobs cannot
overwrite a new summary, that incremental/sliced compaction preserves
instructions and tool boundaries, and that raw 100/105-turn requests get 503
instead of reaching the provider. Only the 25 s foreground wait is accelerated
to 5 ms; no real model, credentials, Magpie state, or user session is used.

The Codex plugin has a separate integration suite, which requires the Codex CLI
on `PATH` and uses an isolated temporary home plus a local fake model:

```sh
python3 scripts/test-codex-plugin.py
```

A saved `compactionItem` alone is not proof of application: verify that the
outgoing request contains it and has removed its folded prefix. The client UI
will still show the original history because this is gateway-side folding.

## License

This project is released under the [MIT License](LICENSE).
