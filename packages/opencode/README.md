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

Requires the `codriver` core (peer dependency) and a fleet config at
`~/.config/codriver/config.json`. Tested against opencode v1.18.31 — see the
repo root README for the full config reference, cost and privacy notes.

MIT © 2026 johnp — see [LICENSE](LICENSE).
