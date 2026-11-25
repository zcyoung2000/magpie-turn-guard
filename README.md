# magpie-turn-guard

A [magpie](https://github.com/yetone/magpie) async gateway hook that keeps
long Codex sessions alive on providers whose gateway caps the size of a
request's history.

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

Installed as an `onRequest` gateway hook, for the configured providers it
watches two counters of each request — user messages and model turns
(one model response = one turn) — and folds the history with **Codex's
own compaction** when either reaches its threshold:

- The hook sends the older history plus a `compaction_trigger` item to
  the same gateway as a side request. Magpie answers a trigger for one
  of its models itself: it swaps the trigger for Codex's official
  compact prompt, the model writes the handoff summary, and magpie
  seals it into a `compaction` item, which the hook splices into the
  live request in place of the folded history. On later requests
  magpie expands the item back into the official summary user message,
  so upstream sees a short history: head + one summary + recent tail.
  No hand-written summary prompt anywhere.
- Folding is **incremental**: the hook remembers the folded frontier
  per session, so later requests only splice (no model call) until the
  spliced history would again reach a threshold — then a new
  compaction merges the previous item with the newly folded turns.
- A compaction side request must itself stay under the caps, so a
  history that is already far over them (the hook was off, the session
  predates it) is folded **in slices**: each slice's request carries
  the previous slice's item, and the final item covers everything.
- Requests already containing a `compaction_trigger` (Codex's own
  `/compact`, the hook's side requests) pass through untouched.
- If the client's own token-based compaction rewrites the history, its
  compaction item restarts the counts and this hook's state for the
  old history stops matching and is dropped.
- Fail-open: any error leaves the original request untouched.

## Install

The plugin is a directory package: `package.json` declares
`magpie.name` ("turn-guard", the name the magpie GUI shows),
`magpie.hooks` (the hook file) and `magpie.options` (the template the
GUI's options editor starts from).

```sh
magpie plugin add /path/to/magpie-turn-guard
magpie plugin options /path/to/magpie-turn-guard '{"gatewayTimeoutMs":180000,"userThreshold":16,"turnThreshold":70}'
```

Options can also be edited in the magpie GUI: Plugins page → the
"turn-guard" row → options editor (JSON, prefilled from the package
template or the saved values).

The gateway bearer token is read at runtime from `~/.codex/config.toml`
(`[model_providers.magpie] experimental_bearer_token`); no secret is stored
in the plugin. Fold state is kept in `turn-guard-state.json` next to the
hook file (falling back to `~/.config/magpie/`).

## Options

Set via magpie plugin options (JSON):

| Option | Default | Meaning |
|---|---|---|
| `providers` | `["xingchi"]` | Model-name prefixes the guard applies to |
| `userThreshold` | `16` | Fold when user messages reach this |
| `turnThreshold` | `70` | Fold when model turns reach this |
| `userCap` | `20` | Provider hard cap on user messages |
| `turnCap` | `100` | Provider hard cap on model turns |
| `keepRecentUsers` | `3` | User turns kept verbatim in the tail |
| `keepRecentTurns` | `20` | Model turns kept verbatim in the tail |
| `compactModel` | `""` | Model for the compaction side request; empty = the request's own model |
| `gatewayUrl` | `http://127.0.0.1:3425/v1` | Gateway base URL for the side request |
| `gatewayTimeoutMs` | (host option) | Must allow a full compaction; 180000 recommended |

## Test

`test_gateway.py` is the v1-era end-to-end check (hand-written summary
path) and no longer applies to v2. To verify v2, watch a long session on
a guarded provider: at the thresholds one request takes noticeably
longer (the compaction), and the provider's turn-limit error never
appears; `turn-guard-state.json` next to the hook gains a `v: 2` entry
with a `compactionItem`.
