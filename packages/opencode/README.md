# codriver-opencode

The [opencode](https://opencode.ai) adapter for
[Codriver](../../README.md) — a per-turn model-routing plugin. It injects a
synthetic `codriver` provider whose single **Auto** model is rewritten, each
turn, to the concrete model the routing core picks.

Local install (from a clone):

```bash
npx nx run codriver-opencode:build
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/codriver/packages/opencode/dist/index.js"
  ]
}
```

Post-publish: `"plugin": ["codriver-opencode"]`.

Requires the `codriver` core (peer dependency) and a fleet config at
`~/.config/codriver/config.json`. Tested against opencode v1.18.31 — see the
repo root README for the full config reference, cost and privacy notes.

MIT © 2026 johnp — see [LICENSE](LICENSE).
