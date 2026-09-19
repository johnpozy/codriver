# Spike A — synthetic provider injection survives opencode config-load

**Status: PASSED (both module formats)** — verified against LOCAL opencode
`v1.18.31` at `/home/johnp/.opencode/bin/opencode` on 2026-09-19.

Question: can a third-party plugin's `config` hook inject a synthetic
`codriver` provider with an `auto` model that (a) survives opencode's
config-load, (b) is enumerable without touching the TUI, and (c) works in
both `.mjs` and built-style `.js` + `package.json {"type":"module"}` module
formats?

Answer: **yes to all three.** The `codriver/auto` entry appears in
`opencode models` output alongside real providers, in both module formats,
with no schema validation exception and no credentials.

## Mechanism (verified against v1.18.31 source + runtime)

- Plugin loading (`packages/opencode/src/plugin/index.ts`): after external
  plugins are imported, opencode runs every hook's `config` hook —
  `hook.config?.(cfg)` — where `cfg` is the **same cached config object**
  (`config.get()`) that everything else reads. Hook failures are logged and
  ignored, so a silently failing hook still exits 0 — enumeration output is
  the only trustworthy gate (see "misleading success" below).
- Ordering contract (`packages/opencode/src/provider/provider.ts`, comment
  above the `plugin.list()` call): *"load plugins first so config() hook runs
  before reading cfg.provider"*. `cfg.provider` is read AFTER the hook ran,
  so in-place mutation (`cfg.provider["codriver"] = {...}`) is visible.
- Config providers are merged into the provider database unconditionally
  (`source: "config"`) — no env var, no auth, no API key required to be
  listed. The AI SDK is only instantiated in `getLanguage()` at request
  time.
- Proof the mutation persists on the cached cfg: `opencode debug config`
  run from the spike dir prints the injected `codriver` block inside the
  resolved `provider` map.

## Plugin file format that worked

Legacy v1 plugin format — a single exported async function returning a
hooks object (`spikes/provider-injection/spike-provider.mjs`):

```js
export const SpikeProviderPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider["codriver"] = {
      name: "Codriver",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1" },
      models: { auto: { name: "Auto" } },
    }
  },
})
```

Notes: exactly ONE export — the loader treats every module export value as
a plugin and throws `Plugin export is not a function` on non-function
exports. The newer `{ id, server() }` default-export format also exists in
1.18.31 (`readV1Plugin`), but the legacy function export is what the current
docs describe and what this spike proves.

## Required schema fields (checked list)

Injected via the hook, the provider block is parsed leniently by
provider.ts — every field below was probed empirically:

- [x] `models` map with **at least one entry** — **the only de-facto
  required field for enumerability**. A provider with zero models is
  registered, then deleted from the provider list (provider.ts final
  filter: `if (Object.keys(provider.models).length === 0) delete
  providers[providerID]`). Observed: `opencode models codriver` →
  `Error: Provider not found: codriver`, exit 1.
- [x] `models.auto.name` — display name; optional (defaults to the model
  ID), but we want "Auto".
- [x] `npm` — **NOT required**: omitted → defaults to
  `@ai-sdk/openai-compatible` (probed; provider still enumerated, verbose
  output shows the default filled).
- [x] `options.baseURL` — optional; only used at request time. Dummy
  `http://127.0.0.1:9/v1` (nothing listens) did not affect enumeration.
- [x] `name` (provider display name) — optional, defaults to the provider
  ID.
- [x] Everything else (cost, limit, capabilities, status…) — optional with
  defaults (cost 0, limit 0, `toolcall: true`, text in/out, `status:
  "active"`). `opencode models codriver --verbose` prints the fully
  defaulted Model object.

No schema validation exception occurs for injected providers: the config
schema (ConfigProviderV1) validated the config FILE before the hook ran;
the hook mutates the already-parsed object, and provider.ts re-parses
leniently. The config-file schema itself also has every provider field
optional — `npm`, `models`, `options` included.

## Eager vs lazy verdict: LAZY

Enumeration (`opencode models`, `opencode models codriver`) succeeds with:

- no API key / env var / auth entry for `codriver`, and
- an unreachable `baseURL` (`http://127.0.0.1:9/v1` — port 9, nothing
  listening).

The provider is registered and listed without ever instantiating the AI SDK
(`resolveSDK`/`getLanguage` run only when a model is actually used). This
satisfies the gap-analysis constraint: the synthetic provider passes config
validation WITHOUT eager instantiation.

## Enumeration command (no TUI)

```bash
cd spikes/provider-injection/dev-config
opencode models                 # full list; contains the line: codriver/auto
opencode models codriver        # filtered: prints "codriver/auto", exit 0
opencode models codriver --verbose   # full defaulted Model JSON
opencode debug config           # shows injected provider in resolved cfg
```

All exit 0. Raw outputs are in `.omo/evidence/task-2-codriver.log`.

## `file:` plugin syntax that worked (v1.18.31)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/johnp/Documents/codriver/spikes/provider-injection/spike-provider.mjs"
  ]
}
```

- `file://` + absolute path (also accepted: `./relative`, bare absolute
  paths — `isPathPluginSpec` in `packages/opencode/src/plugin/shared.ts`).
- The scratch config lives in `spikes/provider-injection/dev-config/`;
  running opencode with that CWD makes it the project config. No
  `opencode.json` exists anywhere else in the repo, so only the scratch
  project sees the plugin. The user's global config
  (`~/.config/opencode/`) is loaded read-only as a lower-precedence layer
  and was NOT modified (mtime + checksum evidence in the evidence log).

## Module-format experiment (decides dist entry for todos 1/13)

| Variant | Entry file | Adjacent package.json | Result |
|---|---|---|---|
| 1 | `spike-provider.mjs` | none | **works** — `codriver/auto` enumerated, exit 0 |
| 2 | `built-style/spike-provider.js` | `{"type": "module"}` | **works** — `codriver/auto` enumerated, exit 0 |
| 3 (control) | `cjs-control/spike-provider.js` | none (nearest: repo root, no `type` → CJS) | **also works** — Bun leniency, see below |

**Verdict: the loader DOES honor package.json module resolution for a
`.js` file** — a built-style `.js` entry with an adjacent
`{"type": "module"}` loads as ESM and the injection works. The opencode
binary is Bun-compiled, and its `await import(fileUrl)` follows the
standard nearest-package.json `type` rule.

Caveat recorded from control 3 + a direct Bun probe: Bun additionally
content-sniffs ESM syntax in `.js` files even when the nearest package.json
says `"type": "commonjs"` (direct test: `import()` of an EMS-syntax `.js`
under explicit `{"type":"commonjs"}` succeeds in Bun 1.4). That leniency is
Bun-specific — Node would reject it — and must NOT be relied upon.

**Dist entry decision for todos 1/13: `dist/index.js` + `{"type": "module"}`
in the published `package.json`.** Both `.mjs` and `.js`+`type:module` are
proven to load; `.js`+`type:module` is chosen because it is the standard
tsc NodeNext output shape (no emit extension rewriting needed) and is
unambiguous under both Bun and Node. `.mjs` remains the documented fallback
if the package.json ever stops being controlled by us.

## Adversarial probes (observable results)

- **stale_state**: negative control — running `opencode models` from
  `dev-config-control/` (config without the plugin) lists 53 lines with NO
  `codriver`; the dev-config run lists 54 lines including `codriver/auto`.
  The injection is fresh per run, not cached state.
- **misleading_success_output**: exit 0 alone is insufficient (a failing
  config hook is logged-and-ignored, still exit 0). Gate used instead:
  `grep codriver` on the actual `opencode models` output — captured in the
  evidence log.
- **dirty_worktree**: `~/.config/opencode/` untouched — mtime listing +
  md5 checksums of all config files identical before/after all runs
  (evidence log).
- **hung_commands**: every opencode invocation ran under `timeout 90`;
  none hung; `opencode serve` was not needed (`opencode models` sufficed).
- Not applicable: malformed_input (no user input parsed), prompt_injection
  (no untrusted text), cancel_resume (no resumable flow), flaky_tests (no
  tests in a spike), repeated_interrupts (no mid-operation state).

## Failure QA (real validation boundary)

- Omitted `npm` (`spike-provider-no-npm.mjs`): NOT rejected — still
  enumerated, `api.npm` filled with `@ai-sdk/openai-compatible`.
- Omitted `models` (`spike-provider-no-models.mjs`): provider stripped —
  absent from `opencode models`, `opencode models codriver` fails with
  `Provider not found: codriver` (exit 1).
- Boundary summary: **the only hard requirement for an enumerable synthetic
  provider is ≥1 entry in `models`**; everything else defaults. Validation
  is lenient parsing, not schema rejection — garbage that yields zero
  models is silently dropped, never a load error.

## Spike artifacts

```
spikes/provider-injection/
  spike-provider.mjs                 # experiment 1 (.mjs)
  built-style/spike-provider.js      # experiment 2 (.js built-style)
  built-style/package.json           # {"type": "module"} exactly
  cjs-control/spike-provider.js      # module-format negative control
  spike-provider-no-npm.mjs          # failure QA: npm omitted
  spike-provider-no-models.mjs       # failure QA: models omitted
  dev-config/opencode.json           # scratch config → .mjs
  dev-config-js/opencode.json        # scratch config → built-style .js
  dev-config-cjs-control/opencode.json
  dev-config-control/opencode.json   # negative control (no plugin)
  dev-config-no-npm/opencode.json
  dev-config-no-models/opencode.json
```
