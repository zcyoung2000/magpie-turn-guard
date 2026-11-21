# magpie-turn-guard

A [magpie](https://github.com/yetone/magpie) async gateway hook that keeps
long Codex sessions alive on providers whose gateway caps the number of
`role=user` messages per request.

## Why

Some gateways (e.g. Xingchi) reject a request once its `input` array holds
more than 10 user messages (`session_turn_limit_exceeded`), long before any
token limit is reached. Codex always sends the full history and only compacts
on a token budget, so a session with many small turns dies on the turn count.

## What it does

Installed as an `onRequest` gateway hook, for the configured providers it
watches the user-turn count of each session:

- Below the threshold, requests pass through untouched.
- At the threshold, the older history is summarized by a model into a single
  user message; the environment context and the most recent turns are kept
  verbatim.
- Folding is **incremental**: the hook remembers the folded frontier per
  session, so later requests only splice (no model call) until the spliced
  history would again exceed the cap — only then is the old summary merged
  with the new turns and re-summarized. A long session therefore pays a
  summary call only every few turns, not on every request.
- If a client's own token-based compaction rewrites the history, the session
  fingerprint changes and counting simply restarts on the new history.
- Fail-open: any error leaves the original request untouched.

Codex's native token compaction is not modified.

## Install

```sh
magpie plugin add /path/to/turn-guard.hooks.js
magpie plugin options /path/to/turn-guard.hooks.js '{"gatewayTimeoutMs":30000}'
```

The gateway bearer token is read at runtime from `~/.codex/config.toml`
(`[model_providers.magpie] experimental_bearer_token`); no secret is stored
in the plugin. Fold state is kept in `turn-guard-state.json` next to the hook
file (falling back to `~/.config/magpie/`).

## Options

Set via magpie plugin options (JSON):

| Option | Default | Meaning |
|---|---|---|
| `providers` | `["xingchi"]` | Model-name prefixes the guard applies to |
| `threshold` | `9` | User-turn count at which the first fold happens |
| `maxUsers` | `10` | Hard cap the rewritten request must stay within |
| `keepRecent` | `3` | Most recent user turns kept verbatim |
| `summaryModel` | `xingchi/gpt-6.1-sol` | Model used to write summaries |
| `gatewayUrl` | `http://127.0.0.1:3425/v1` | Gateway base URL for the summary call |
| `gatewayTimeoutMs` | (host option) | Must allow a summary call; 30000 recommended |

## Test

`test_gateway.py` sends a synthetic 12-user-turn request through a running
gateway and checks that it returns 200 with the planted codeword recalled:

```sh
python3 test_gateway.py ~/.codex/config.toml http://127.0.0.1:3425/v1 CODEWORD-1
```
