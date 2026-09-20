# Codriver

<p align="center">
  <img src="docs/images/codriver.png" width="220" alt="Codriver, The model drives, Codriver calls the turn">
</p>

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

This plugin is published to GitHub Packages as
`@johnpozy/codriver-opencode`.

### Part 1 — Install (primary path)

GitHub Packages hosts the package, so npm must be told where the
`@johnpozy` scope lives.

Add to `~/.npmrc` (create it if missing) this block:

```ini
@johnpozy:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:username=YOUR_GITHUB_USERNAME
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

Use a GitHub personal access token (classic) with the `read:packages`
scope, see github.com, Settings, Developer settings, Personal access
tokens.

Then reference the plugin from your opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@johnpozy/codriver-opencode"]
}
```

### Part 2 — Local development (secondary)

**Or run from a local clone (development):**

Build the adapter (this builds the `codriver` core first, then the opencode
adapter):

```bash
npx nx run opencode:build
```

Reference the built adapter entry `packages/opencode/dist/index.js` from
your opencode config with a `file://` absolute URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/codriver/packages/opencode/dist/index.js"
  ]
}
```

(Adjust the path to your clone — it must be absolute.)

The plugin auto-creates a starter fleet on first run: it prefers models from
your custom opencode providers (providers you define in `opencode.json` with a
`models` field), and falls back to a built-in default fleet of common coding
models if you have none. You can edit `~/.config/codriver/config.json`
afterward. Verify:

```bash
opencode models   # the list must contain: codriver/auto
```

### Part 3 — Set your Jev API key (optional)

Codriver routes turns through TypeSafe AI's Jev model. For real routing decisions, set `TYPESAFE_API_KEY` in your shell profile:

```bash
# ~/.bashrc or ~/.zshrc
export TYPESAFE_API_KEY="your-typesafe-ai-key"
```

If the key is unset, Codriver falls back to a deterministic fixture client — routing still works end-to-end for testing, but decisions are canned rather than from Jev.

Pick **Auto — routed by Codriver** in the model picker and send a message.
## Codriver config

Codriver reads its own config — deliberately outside any agent's config, so
every adapter shares one fleet — from `~/.config/codriver/config.json`.

On first run, if this file is missing or has an empty fleet, the plugin
auto-creates a starter fleet. In rewrite mode it prefers models from your
custom opencode providers (providers you define in `opencode.json` with a
`models` field), and falls back to a built-in default fleet of common coding
models if you have none. In proxy mode (see below) the starter fleet always
uses upstream model ids. You can edit the file afterward to add
descriptions, tags, or remove models.

Example config:

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
  "log_path": "~/.local/share/codriver/decisions.jsonl"
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
| `CODRIVER_UPSTREAM_BASE_URL` | at config load, per request | **Explicit proxy-mode switch + default upstream.** Set → proxy mode is on. Unset → proxy mode still activates automatically when any fleet entry is prefixed with a builtin gateway name (`vercel/`, `openrouter/`); otherwise rewrite mode. Also serves as the default upstream fleet ids with no matching prefix are forwarded to. |
| `CODRIVER_UPSTREAM_API_KEY` | per request | The default upstream's API key in proxy mode; sent as `Authorization: Bearer <key>`. Per-prefix upstreams resolve their own keys (see below). |
## Proxy mode (keep the picker on Auto)

Default (rewrite mode): the plugin rewrites each turn's message model, and
opencode's model indicator follows the routed model — opencode currently
offers no plugin API to keep the picker on Auto while rewriting
([#18667](https://github.com/anomalyco/opencode/issues/18667), closed as
not planned).

Proxy mode solves it by not rewriting at all. It activates explicitly (set
`CODRIVER_UPSTREAM_BASE_URL` to any non-empty value) or automatically (any
fleet entry prefixed with a builtin gateway name — `vercel/…`,
`openrouter/…`). The injected `codriver` provider points at a loopback
gateway the plugin runs inside the opencode process. Every completion
request for `auto` arrives there; the gateway asks Jev which fleet entry
fits the turn, resolves that entry's upstream, rewrites the request's
`model` field, forwards it, and pipes the streaming response back
untouched. The indicator stays on **Auto**; each turn's routed model is
printed (`codriver: auto → anthropic/claude-opus-4 via vercel (jev-choice,
0.9)`) and logged to the decision log as usual. Token usage accounting still
works — the upstream response passes through verbatim.

Fleet ids in proxy mode are `"<upstream>/<model>"` — the first path segment
names the upstream, the rest is the model string forwarded to it. These are
the SAME ids as opencode `provider/model` ids in rewrite mode, so one
config file serves both modes:

```json
{
  "fleet": [
    { "id": "vercel/anthropic/claude-opus-4", "description": "deep reasoning, hard refactors" },
    { "id": "vercel/openai/gpt-4o-mini", "description": "trivial tasks" },
    { "id": "openrouter/z-ai/glm-4.6", "description": "fast everyday coding" }
  ],
  "fallback": "openrouter/z-ai/glm-4.6"
}
```

Upstream resolution for the prefix, in order:

1. **The same-named provider in your opencode config** — its `baseURL`, and
   its `apiKey` (inline string or `{env: VAR}`) becomes the Bearer
   credential. Any custom OpenAI-compatible provider works this way.
2. **A builtin gateway registry entry** (`vercel` → `https://ai-gateway.vercel.sh/v1`,
   `openrouter` → `https://openrouter.ai/api/v1`) — the key is read from
   opencode's own `auth.json` for that provider (`type: "api"` entries
   only; OAuth tokens are never touched).
3. **No prefix match** → the WHOLE id is forwarded to the default upstream
   (`CODRIVER_UPSTREAM_BASE_URL`, key `CODRIVER_UPSTREAM_API_KEY`).

So a single-gateway user only needs the two env vars; a mixed
vercel + openrouter user needs NOTHING extra (proxy mode auto-activates on
the `vercel/`/`openrouter/` prefixed ids, and the keys come from `auth.json`
once the providers are configured in opencode); and models scattered
across direct provider APIs can each carry their own prefix. Keys are read
lazily per request and never logged.

Setup — with a `vercel/`- or `openrouter/`-prefixed fleet there is NO extra
setup: proxy mode is automatic. Otherwise, enable it explicitly:

```bash
# ~/.bashrc or ~/.zshrc
export TYPESAFE_API_KEY="your-typesafe-ai-key"
export CODRIVER_UPSTREAM_BASE_URL="https://ai-gateway.vercel.sh/v1"
```
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
