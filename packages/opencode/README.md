# codriver-opencode

The [opencode](https://opencode.ai) adapter for
[Codriver](../../README.md) — a per-turn model-routing plugin. It injects a
synthetic `codriver` provider whose single **Auto** model is rewritten, each
turn, to the concrete model the routing core picks.

### Install (published package)

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

Local install (from a clone):

```bash
npx nx run opencode:build
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/codriver/packages/opencode/dist/index.js"
  ]
}
```

### Set your Jev API key (optional)

For real Jev routing decisions, set `TYPESAFE_API_KEY` in your shell profile:

```bash
# ~/.bashrc or ~/.zshrc
export TYPESAFE_API_KEY="your-typesafe-ai-key"
```

If the key is unset, Codriver falls back to a deterministic fixture client —
routing still works end-to-end for testing, but decisions are canned rather
than from Jev.

Requires the `codriver` core (peer dependency). Tested against opencode
v1.18.31 — see the repo root README for the full config reference, cost and
privacy notes.

### Proxy mode (keep the model picker on Auto)

Proxy mode activates automatically when any fleet entry is prefixed with a
builtin gateway name (`vercel/…`, `openrouter/…`), or explicitly via
`CODRIVER_UPSTREAM_BASE_URL`: the chat.message rewrite is disabled, the
picker stays on **Auto**, and the plugin's loopback gateway routes each
turn. Fleet ids are `"<upstream>/<model>"` — the prefix resolves to an
upstream (your opencode provider's `baseURL` and `apiKey`, a builtin
gateway registry entry keyed by opencode's `auth.json`, or the env-var
default upstream), the tail is the model string forwarded there. See the
repo root README ("Proxy mode") for the full resolution order and examples.

On first run, if `~/.config/codriver/config.json` is missing or has an empty
fleet, the plugin auto-creates a starter fleet. It prefers models from your
custom opencode providers (providers you define in `opencode.json` with a
`models` field), and falls back to a built-in default fleet of common coding
models if you have none. You can edit the file afterward to add descriptions,
tags, or remove models.

MIT © 2026 johnp — see [LICENSE](LICENSE).
