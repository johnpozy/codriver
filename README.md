# Codriver

> The model drives, Codriver calls the turn.

## What / Why

Codriver is a per-turn model-routing plugin for
[opencode](https://opencode.ai). Instead of locking a whole session to one
model, you pick **Auto** in the model picker — and for every turn, Codriver
asks [Jev](https://typesafe.ai) (TypeSafe AI's non-generating "System One"
decision model) which concrete model from *your* fleet fits THIS turn, then
rewrites the message to that model before it is sent.

Model choice is a per-turn decision, not a session setting: a quick question
does not need the same model as a gnarly refactor. Codriver makes that call
automatically, in ~70–500 ms per turn, and never blocks — every failure path
lands on a documented fallback.

## Quickstart

From a clone of this repo, build the adapter (this builds the `codriver` core
first, then the opencode adapter):

```bash
npx nx run codriver-opencode:build
```

The built adapter entry is `packages/opencode/dist/index.js`. Reference it
from your opencode config (`~/.config/opencode/opencode.json`, or a project
`opencode.json`) with a `file://` absolute URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/johnp/Documents/codriver/packages/opencode/dist/index.js"
  ]
}
```

(Adjust the path to your clone — it must be absolute.)

Then define a fleet (see the next section) — Auto is only injected once at
least one fleet entry exists — and verify:

```bash
opencode models   # the list must contain: codriver/auto
```

Pick **Auto — routed by Codriver** in the model picker and send a message.
No `TYPESAFE_API_KEY`? The plugin runs keyless on a deterministic fixture
client, so you can try the flow before signing up.

Once published to npm, the file URL is replaced by the package name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@johnpozy/codriver-opencode"]
}
```

## Codriver config

Codriver reads its own config — deliberately outside any agent's config, so
every adapter shares one fleet — from `~/.config/codriver/config.json`:

```json
{
  "fleet": [
    {
      "id": "anthropic/claude-opus-4-6",
      "description": "deep reasoning, hard refactors, architecture work",
      "tags": ["hard", "reasoning"]
    },
    {
      "id": "anthropic/claude-sonnet-4-5",
      "description": "fast everyday coding"
    },
    {
      "id": "openai/gpt-6",
      "description": "broad general knowledge, docs and Q&A",
      "tags": ["docs"]
    }
  ],
  "fallback": "anthropic/claude-sonnet-4-5",
  "route_threshold": 0.55,
  "route_timeout_ms": 1500,
  "log_path": "/home/johnp/.local/share/codriver/decisions.jsonl"
}
```

- `fleet` — the routable models. Each entry is `{ id, description, tags? }`;
  `id` is the `"provider/model"` string exactly as opencode knows it,
  `description` and `tags` are what Jev routes on. Entries whose `id` is not a
  model your opencode can actually reach this turn are unroutable (see
  degraded modes below).
- `fallback` — the `"provider/model"` used when routing does not commit to a
  fleet entry (low confidence, timeout, error, or no key).
- `route_threshold` — minimum Jev confidence for a routed choice
  (default `0.55`; below it, the turn falls back).
- `route_timeout_ms` — Jev request timeout in ms (default `1500`; exceeded,
  the turn falls back).
- `log_path` — where the JSONL decision log is written. Default:
  `${XDG_DATA_HOME:-~/.local/share}/codriver/decisions.jsonl`.

The config is re-read from disk on every turn — edit the fleet and the next
message already uses it.

Environment variables:

| Variable | Read | Effect |
|---|---|---|
| `TYPESAFE_API_KEY` | per turn, at client selection (and at log-write time for redaction) | Jev API key. Set → real Jev calls. Unset → the deterministic fixture client: the plugin works end-to-end keyless. |
| `CODRIVER_CONFIG` | per turn, at config load | Full path of the config file (default `~/.config/codriver/config.json`). |
| `CODRIVER_JEV` | per turn, at client selection | `fixture` forces the fixture client even when a key exists; anything else → the HTTP client. |
| `CODRIVER_JEV_SCENARIO` | per request, by the fixture client | Selects a canned fixture scenario by name (testing). An unknown name fails loudly, never silently. |

## How Auto works

1. The plugin injects a synthetic `codriver` provider with a single `auto`
   model — no API key, no backend, no credentials.
2. On each turn sent with Auto, Codriver builds a hard-capped digest of the
   turn (see Privacy) and makes ONE Jev call (~70–500 ms) asking which fleet
   entry fits.
3. At or above `route_threshold` confidence, the message is rewritten to
   that fleet entry. Below it — or on timeout, error, or missing key — the
   documented fallback chain applies: the catalog-valid `fallback`, else the
   first valid fleet entry.
4. Every decision is appended as one JSON line (reason, chosen model,
   confidence, probabilities, latency, a short state preview) to `log_path`
   (default `${XDG_DATA_HOME:-~/.local/share}/codriver/decisions.jsonl`).
   The API key is redacted from every logged string and object key.

Cost: the routing state is small (well under ~2k tokens). At $0.042/MTok
input with output free, one routing decision costs on the order of
$0.0001 per turn.

Degraded modes — what you see when the fleet is misconfigured:

- `no-valid-fleet` — no fleet entry matches a model your opencode can
  actually route to this turn. The turn is still rewritten to the
  `fallback` (or first fleet entry) target, so the model slot is always
  concrete, and the decision log records the reason.
- `no-targets` — nothing routable exists at all (empty fleet, no fallback).
  The `codriver/auto` sentinel is left in place, a loud warning is printed,
  and opencode surfaces its own model error for the turn. Nothing crashes;
  fix the fleet and the next turn routes again.

## Compatibility

- Tested against opencode **v1.18.31**.
- The adapter talks to opencode only through its plugin hooks, which are
  structurally typed and never throw: if a future opencode release changes
  the hook shape, the plugin no-ops and logs — it never blocks a session.
- After upgrading opencode, verify the injection still enumerates
  (`opencode models` shows `codriver/auto`) before relying on Auto, or pin
  your opencode version between verifications.

## Privacy / Security

What Jev receives, per turn:

- the agent name,
- the first 512 characters of the current message — the only raw text,
- the message's character count and a has-code-blocks flag,
- code-language NAMES from fenced blocks (first 5) — never code contents,
- the fleet summaries (id, description, tags).

Never sent: file contents, conversation history, or anything beyond the
digest above. Note the trusted-codebase assumption: Jev does not treat state
as hostile, and Codriver keeps the surface minimal regardless. The Jev model
is pinned to `jev-1.13.0` (never `jev-latest`), and the `TYPESAFE_API_KEY`
value is redacted from the decision log.

## License

MIT © 2026 johnp — see [LICENSE](packages/core/LICENSE). The packages are
published to GitHub Packages as `@johnpozy/codriver` and
`@johnpozy/codriver-opencode` (scope = GitHub owner).
