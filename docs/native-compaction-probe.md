# Native compaction via an overflow signal

Verified on 2026-11-25 with `codex-cli 0.172.0` and the ChatGPT-bundled
`codex-cli 0.171.0-alpha.13`.

## Intended behavior

Before the provider's message/turn cap, the gateway would return
`context_length_exceeded`. The desired result was for Codex to compact its own
history, persist the checkpoint, and continue the interrupted task automatically,
using the same lifecycle as token-triggered auto-compaction.

## Result

The error signal does **not** produce that behavior in the tested versions.
Both error formats terminate the current user turn. On the next user turn,
Codex performs native compaction and then inference. That checkpoint is real,
but the required extra user turn makes this unsuitable as a transparent
replacement for token auto-compaction.

| Fixture | Current turn | Native compaction | Local checkpoint |
| --- | --- | --- | --- |
| HTTP 400, `error.code = context_length_exceeded` | Fails | At the next user turn | Persisted then |
| HTTP 200 SSE, `response.failed`, `response.error.code = context_length_exceeded` | Fails | At the next user turn | Persisted then |
| Native token threshold (positive control) | Completes | Before inference on the next turn, without an intervening failure | Persisted |

The HTTP/SSE error cases start from an existing session with a successful model
reply, rather than testing only an empty thread. The probe also exercises
overflow during a tool continuation, after a harmless `update_plan` call.
The token control establishes that native auto-compaction works in the same
isolated setup. It uses synthetic usage in a local fixture only; falsifying
usage in production is not proposed as a solution.

This is a CLI protocol test, not an observation of the graphical UI or a real
provider. It verifies the emitted turn lifecycle, the requests Codex makes, and
the `compacted` record in its local rollout. The custom fixture provider uses
Codex's fallback model metadata with explicit context/compaction limits; no
Magpie model catalog or remote compaction service is involved.

## Reproduce

```sh
python3 scripts/probe-native-compaction.py

python3 scripts/probe-native-compaction.py --codex \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
```

The script creates temporary Codex homes and working directories, binds its mock
Responses service only to loopback, and makes no calls to a real model. It does
not load the user's config, credentials, MCP servers, or sessions, and does not
change Magpie or the installed plugin. Each case prints its report path, request
sequence, exit codes, and persisted checkpoint count. Reports contain the local
fixture requests and Codex's JSON events. It exits unsuccessfully if the observed
behavior no longer matches these findings, so changed client behavior is visible.

## Why

In the matching official source, a context overflow in normal sampling marks
the token budget as full and returns the error. The normal user-turn error
handler emits the error and ends that turn. A later turn can therefore take
the token-limit auto-compaction path. The inline overflow-recovery branch for
a Guardian review budget is specialized and does not apply to ordinary chats.

- [Codex 0.172.0 normal turn and sampling](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/session/turn.rs)
- [Codex 0.172.0 native compaction and checkpoint installation](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/compact.rs)

Magpie's `ctx.reject(status, message)` can reject a middleware request, but uses
the HTTP error writer. It cannot synthesize a successful streaming response
through that API. Switching to a stream error would not fix the demonstrated
client lifecycle anyway.

Relevant read-only Magpie source paths:

- `internal/gateway/middleware.go`: rejected middleware requests use `writeError`.
- `internal/gateway/gateway.go`: HTTP/SSE overflow error encoding.
- `internal/agent/codex_compact_held.go`, `internal/codexcat/codexcat.go`: the
  settings/catalog values Codex reads for its own token auto-compaction.

## Implementation decision

No overflow middleware was enabled or shipped: it would interrupt the user's
task instead of satisfying the automatic-compaction requirement. The existing
hook and live configuration are unchanged.

To preserve native compaction and resume the same task, further work needs a
client/host integration that invokes native compaction at a safe boundary, or
a Codex change that retries a normal sampling step after native compaction on
overflow. The actual compaction request must also stay under the provider's
caps. Simply replacing the provider's error code does not solve both problems.
