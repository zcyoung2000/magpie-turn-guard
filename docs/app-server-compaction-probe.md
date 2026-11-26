# Active native compaction through Codex App Server

Verified on 2026-11-25 with:

- `codex-cli 0.172.0` from the local CLI installation.
- ChatGPT-bundled `codex-cli 0.171.0-alpha.13`.

## Decision

An integration that owns the current App Server connection can explicitly
start native compaction with `thread/compact/start`. The successful operation
updates that server's live history, emits the native compaction lifecycle,
and persists a checkpoint. This is stronger than gateway-only folding.

It does **not** make a standalone Codex plugin a replacement for turn-guard:

1. Compacting during a tool continuation interrupts the original turn.
   The original turn ends as `interrupted`; the compaction is a separate,
   completed turn. Our successful follow-up is a new explicit `turn/start`,
   not automatic continuation of the interrupted task.
2. Starting a second App Server and resuming a thread owned by the first
   fails with `already has an active writer`. Sharing a thread ID and
   `CODEX_HOME` is not a supported way to take over the live session.
3. Both tested compaction protocols retain the short original user messages
   in Codex's outgoing input. This does **not** establish the final upstream
   message count: Magpie's translated Responses path merges adjacent user
   messages. The real-gateway follow-up below found 2 upstream user messages
   for the full captured request and 20 for a minimal request. The request's
   processing path matters.
4. The compaction request itself must fit the provider's actual wire-level
   limits; direct fixture counts are not sufficient to verify that.

Keep the current gateway protection. A future native integration needs a
supported control channel in the owning host, scheduling at an appropriate
boundary, an explicit continuation policy, and end-to-end verification of
the specific provider's limits. The earlier claim that native compaction
cannot reduce Magpie's upstream user-message count is withdrawn.

## Scope and isolation

This is an integration test of real Codex executables, their public App Server
protocol, live-history replacement, and persistent rollouts. A local HTTP/SSE
fixture supplies model responses; no real model or Xingchi endpoint is called.

Each case gets temporary `HOME`, `CODEX_HOME`, XDG directories, configuration,
working directory and history. Subprocesses inherit only an allowlist of basic
environment variables. No existing session, provider credential, Magpie
configuration or installed plugin is changed. The fake summary and opaque
compaction item test protocol behavior, not model summarization quality.

Two native compaction protocols are tested explicitly:

- `local`: a normal Responses request containing Codex's summarization prompt.
- `v2`: the custom provider capability `remote_compaction = "v2"` sends a
  `compaction_trigger`; the fixture returns an opaque `compaction` item.
  This matches the trigger/item protocol handled by Magpie. For synthetic cap
  checking, the fixture counts each trigger and each stored compaction item
  as one user message, but does not execute Magpie's subsequent message merging.

The synthetic input-cap fixture accepts at most 20 expanded, unmerged user
items and 100 model turns. It rejects counts **greater than** those limits.
These cap cases are not a faithful simulation of final Magpie-to-provider
serialization. The fixture counts include context and summary items and must
not be reported as observed upstream wire-message counts. The production guard
also counts before final serialization and rejects at `>= userCap` / `>= turnCap`.

## Observed cases

All six cases produced the same outcome on both binaries with both protocols:
24 App Server regression scenarios passed. A passing regression means the
observed outcome was verified, including the expected rejection cases.

| Case | Observation | Integration consequence |
| --- | --- | --- |
| Idle compaction | Native `contextCompaction` start/completion events; one persisted checkpoint; the next request contains the summary and no old assistant marker | Native history replacement works when controlling the owning server |
| Compaction during tool continuation | The fixture reaches `function_call_output`; the active turn becomes `interrupted`; a new compaction turn completes | The controller must handle task interruption and continuation explicitly |
| Failed compaction | Acknowledgement is still `{}`, but completion reports `failed`; no checkpoint is installed; original history remains usable | Wait for completion/error events rather than trusting the acknowledgement |
| Synthetic unmerged input cap | The expansion-only fixture counts 20 existing user items and 21 with the compaction prompt/trigger, and rejects | Reproduces this fixture's assumed cap only; not proof of a real Magpie upstream rejection |
| Earlier compaction, synthetic cap | Expansion-only fixture counts progress from 18 to 19, 20, then 21 | These figures are not final upstream counts; see the gateway follow-up |
| Separate-process sidecar | A second App Server's `thread/resume` is rejected because the first server owns the active writer; the original remains usable | A plugin cannot assume it can control an existing session by resuming its rollout |

The existing gateway regression suite also passed all 14 isolated compaction
scenarios after adding this probe.

## Correction: actual gateway forwarding

The first App Server probe bypassed Magpie and treated summary expansion as the
last serialization step. That was an incomplete model of the gateway. It
incorrectly supported the earlier statement that the first post-compaction
request would contain 20 upstream user messages.

A follow-up replays the captured synthetic Codex requests through the actual
Magpie gateway source and captures the HTTP body at its local fake provider.
The probe uses the real `codexInputAs`, Responses parsing, message merging and
Responses serialization paths, without the turn-guard hook. Its provider is a
temporary Responses provider; it is not the live installed gateway or Xingchi.

The opaque fixture compaction item is replaced with a correctly encoded
Magpie-owned summary item for this test. Both the full captured body and a
minimal body containing only model, input and stream are exercised.

| Request | User items in Codex input | Compaction items | User messages received by fake upstream |
| --- | --- | --- | --- |
| Full captured first follow-up | 19 | 1 | 2 |
| Full captured next follow-up | 20 | 1 | 3 |
| Minimal first follow-up | 19 | 1 | 20 |
| Minimal next follow-up | 20 | 1 | 21 |

All 17 original `OLD_USER_*` text markers still reach the fake upstream inside
content parts. The summary also arrives as text. Thus retained **content** and
retained **message count** must be distinguished. In this translated path,
native compaction followed by Magpie serialization substantially reduces the
user-message count even though the user's earlier text is still sent. The
minimal request preserves separate user items instead; merging must not be
assumed for every forwarding path.

This corrects the user-count objection to native integration. The separately
observed active-turn interruption, writer ownership, and missing public host
control command still apply.

## Integration boundary

A controller must connect to the App Server that owns the loaded thread. A
separate App Server cannot safely take over a thread that another server owns.
The included Codex plugin therefore uses the public
`codex app-server proxy` command and only acts on threads already loaded in that
shared server. Hosts without this control channel report that native
compaction is unavailable; they do not launch a sidecar server or resume an
active thread elsewhere.

## Reproduce

```sh
# Default: Magpie-compatible remote compaction protocol, all six cases.
python3 scripts/probe-app-server-compaction.py

# Local summarization protocol.
python3 scripts/probe-app-server-compaction.py --protocol local

# The same matrix against the ChatGPT-bundled CLI.
python3 scripts/probe-app-server-compaction.py --codex \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex

python3 scripts/probe-app-server-compaction.py --protocol local --codex \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex

# Existing gateway coverage.
bun run test

# Replay the printed user_cap_early/report.json through real Magpie source.
python3 scripts/probe-magpie-forwarding.py \
  --magpie-source /path/to/magpie \
  --report /path/to/user_cap_early/report.json
```

Use `--case idle`, `--case busy`, `--case failure`, `--case user_cap`,
`--case user_cap_early`, or `--case sidecar` to select individual cases;
`--case` can be repeated. The script prints each temporary `report.json` path
and writes `summary.json` under its temporary run root. Reports include the
synthetic wire requests, client notifications, observations and assertions.

The probe exits nonzero on an unexpected result. A future Codex change that
alters interruption, retention, or writer ownership therefore requires review
of the evidence rather than silently preserving these conclusions.

## Primary references

- [Official App Server guide](https://developers.openai.com/codex/app-server/)
  documents `thread/compact/start`, its immediate acknowledgement, and the
  subsequent `contextCompaction` lifecycle.
- [Codex 0.172.0 compaction task](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/tasks/compact.rs)
  selects local or remote-v2 compaction from the provider capability.
- [Codex 0.172.0 local history replacement](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/compact.rs)
  preserves user messages subject to a token budget and appends the summary.
- [Codex 0.172.0 remote-v2 retained items](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/compact_remote_v2.rs)
  also retains user messages in the replacement history.
- [Custom provider capabilities](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/model-provider-info/src/capabilities.rs)
  defines the `v2` capability used by the probe.
