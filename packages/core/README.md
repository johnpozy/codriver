# codriver

The framework-agnostic routing core for
[Codriver](../../README.md): the Jev client (HTTP + deterministic fixture),
fleet config loading, the hard-capped routing state, the never-throw routing
policy, and the JSONL decision logger. Zero agent-specific imports.

- Entry: `dist/index.js` (ESM), types at `dist/index.d.ts`.
- Runtime dependencies: none.
- Config: `~/.config/codriver/config.json` (`CODRIVER_CONFIG` to override).
- The Jev model is pinned to `jev-1.13.0`.

MIT © 2026 johnp — see [LICENSE](LICENSE).
