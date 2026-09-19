# Codriver adapter guide

This document is the porting contract for running Codriver against agents other than opencode. The long-term framing (user's words, verbatim from the draft): "this eventually will be use by hermes, openclaw, pi and other agent." This guide exists so a future port is mechanical, not a fresh research project.

The contract below describes what the routing core promises, what an adapter plugs into it, and the worked opencode example with real file and line references you can read next to your own agent's hook surface. Read it end to end before writing a single line of adapter code.

Two things this guide is deliberately not:

- It is markdown only. There is no `Adapter` base class, no SDK, no framework shim, no runtime abstraction layer. Each port writes its own thin, hand-rolled hook code that calls into `@johnpozy/codriver` (the core npm package produced from `packages/core/`). That is the entire integration surface.
- It makes no promises about agents we have not researched. Hermes, openclaw, and pi each need their own hook-surface research pass before any code is committed, the same shape as the librarian run recorded in `.omo/drafts/codriver.md` Findings 1 through 11 for opencode. The checklist at the end is the recipe, not the result.

## Core contract

The public surface of the core is the re-export barrel at `packages/core/src/index.ts` (10 lines; it star-exports `./jev`, `./config`, `./state`, `./policy`, and `./log`). Every symbol an adapter touches comes from that one module. The minimum importable set:

| Symbol | Kind | What it is |
|---|---|---|
| `CodriverConfig` | type | The routed config: `fleet`, optional `fallback`, `route_threshold`, `route_timeout_ms`, `log_path`. Defined in `packages/core/src/config/config.ts:23-33`. |
| `FleetEntry` | type | One routable model: `{ id: "provider/model", description, tags? }`. `packages/core/src/config/config.ts:16-21`. |
| `RoutingState` | type | The hard-capped digest sent to Jev. `packages/core/src/state/state.ts:21-32`. |
| `RoutingStateInput` | type | Caller-side state input. `packages/core/src/state/state.ts:34-41`. |
| `RoutingDecision` | type | The always-concrete decision object. `packages/core/src/policy/policy.ts:30-52`. |
| `RouteInput` | type | The input bag `route()` accepts. `packages/core/src/policy/policy.ts:55-62`. |
| `JevClient` | interface | Anything with `evaluate(req): Promise<JevResult>`. `packages/core/src/jev/client.ts:51-53`. |
| `JevResult` | type | The raw Jev response shape. `packages/core/src/jev/types.ts:66-70`. |
| `route()` | function | The never-throw routing policy. `packages/core/src/policy/policy.ts:78-177`. |
| `loadConfig(env)` | function | Fresh-from-disk config loader, never crashes on a missing file. `packages/core/src/config/config.ts:68-83`. |
| `splitModelId(id)` | function | Parses `"provider/model"` to `{providerID, modelID}`. `packages/core/src/policy/policy.ts:68-72`. |
| `logDecision(d, meta)` | function | Fire-and-forget JSONL logger with key redaction. `packages/core/src/log/log.ts:71-94`. |
| `FixtureJevClient` | class | In-process deterministic Jev stand-in; needs no API key. `packages/core/src/jev/fixture.ts:26-51`. |
| `HttpJevClient` | class | Real HTTP client; needs `TYPESAFE_API_KEY`. `packages/core/src/jev/client.ts:55-116`. |
| `JevError` | class | Typed failure with `kind: timeout \| http \| no-key \| parse`. `packages/core/src/jev/client.ts:17-32`. |
| `JEV_MODEL` | const | The pinned Jev model id (`"jev-1.13.0"`). `packages/core/src/jev/client.ts:4`. |

### Invariant A: never-throw

`route()` never throws and never blocks. Any internal exception, including a poisoned `JevClient` or a malformed config object, yields a real `RoutingDecision` with `reason: "error"`. You can verify this in `packages/core/src/policy/policy.ts:173-176`, where the outer catch falls through to `rescueDecision(input)`. The reason enum is closed at 8 values (`jev-choice`, `no-fit`, `low-confidence`, `timeout`, `error`, `no-key`, `no-valid-fleet`, `no-targets`); every path returns one of them.

The consequence for adapter authors: your hook code does not need its own outer try/catch for correctness. You still want one for logging, but the policy cannot blow up.

### Invariant B: always-concrete-decision

`RoutingDecision.model` is always the object `{ providerID, modelID }`, never a raw `"provider/model"` string. See the TYPE RULE in `packages/core/src/policy/policy.ts:23-27` and the shape pinned in `RoutingDecision.model` at line 31. Parsing happens via `splitModelId` at the boundary. An adapter never has to split strings itself.

### The two terminal decisions

`route()` has exactly two terminal (short-circuit) decisions, both triggered when the catalog-valid fleet is empty:

**`no-valid-fleet`** (`packages/core/src/policy/policy.ts:102-112`). Fires when the fleet has entries but none of them are in the host's current provider catalog, AND a fallback or first-fleet-entry id exists. The adapter STILL rewrites the message model to that decision target. If that target is itself invalid in the host (for example the user removed the provider entirely since the config was written), the host will surface its own model-resolution error for that turn, without corrupting persisted session state. This is degraded, never silent.

**`no-targets`** (`packages/core/src/policy/policy.ts:91-101`). Fires when literally nothing is routable: the fleet is empty AND there is no configured fallback. The decision's `model` field is the sentinel `{ providerID: "codriver", modelID: "auto" }`. This is the ONE DOCUMENTED passthrough: the adapter leaves that sentinel in place on the message and logs loudly via `console.warn`. The host then surfaces its own model-resolution error for that turn; no state is corrupted and no routing loops back on itself.

Every path other than `no-targets` yields a concrete, non-sentinel model id. The adapter rewrites the message model on every one of them.

## What an adapter MUST do

Six obligations, in order. Skip any one of them and the integration is broken in a user-visible way.

1. **Intercept model selection BEFORE the model is resolved.** Find your agent's equivalent of opencode's `chat.message` hook (the point where the user-turn's model id has been chosen by the picker but not yet resolved against the provider catalog). Any later and the routing decision cannot affect this turn; any earlier and you have no user text to route on. This is the single most important choice in the whole port and it is the one that requires per-agent research.

2. **Present an "Auto" entry to the user.** Inject a synthetic provider+model pair into whatever mechanism your agent uses to enumerate selectable models. In opencode this is one `cfg.provider["codriver"] = {...}` block in the config hook (`packages/opencode/src/config.ts:60-84`). The injected entry needs only one model, the display name `"Auto — routed by Codriver"`, and `npm: "@ai-sdk/openai-compatible"` (or your host's nearest equivalent). Lazy registration matters: enumeration must not dial the dummy endpoint. Verified empirically in `docs/notes/spike-a.md`.

3. **Rewrite to a concrete model on every path except the documented `no-targets` passthrough.** When `route()` returns a decision, you overwrite the outgoing message's model field with `{ providerID: decision.model.providerID, modelID: decision.model.modelID }`. No exceptions other than `no-targets`. Reference shape: `packages/opencode/src/chat.ts:155-160` (the happy path) and `packages/opencode/src/chat.ts:151-154` (the passthrough guard).

4. **Never leave the Auto sentinel reaching model resolution.** If your rewrite logic has a bug, the host will call into a synthetic provider with no backend and the user sees an obscure connection error. The two legitimate places the sentinel reaches resolution are the documented `no-targets` passthrough (logged loudly) and a catastrophic bug in routing logic (treated as a bug to fix, not a mode to ship). Treat every non-`no-targets` path that leaves the sentinel untouched as a test failure.

5. **Honor the fallback chain.** `route()` already does this for you. The chain inside the policy is: catalog-valid `config.fallback` if set, else the first catalog-valid fleet entry. See `packages/core/src/policy/policy.ts:117-118` (fallback selection) and `packages/core/src/policy/policy.ts:184-192` (terminal target). Adapters do NOT re-implement this chain. You pass `config` and `catalog` into `route()` and accept the decision. If you catch yourself writing fallback logic in the adapter, stop, it belongs in core.

6. **Wire the decision log + secret sanitizer.** Every routed turn calls `logDecision(decision, { agent, config: { log_path: config.log_path } })`. `logDecision` is fire-and-forget: any filesystem error skips the write silently and routing continues. The sanitizer reads `process.env.TYPESAFE_API_KEY` at write time and replaces every exact occurrence in values AND object keys with `[REDACTED]`. See `packages/core/src/log/log.ts:71-94` and the `redactSecrets` helper at `packages/core/src/log/log.ts:110-122`. Adapters pass the decision through untouched; never re-serialize, never truncate.

## opencode worked example

The only implemented adapter is `packages/opencode/`. Two hooks, composed in `packages/opencode/src/index.ts:11-20`:

```typescript
export const CodriverPlugin = async () => ({
  config: async (cfg: AutoConfig) => {
    stashConfig(cfg);
    injectAuto(cfg, process.env);
  },
  "chat.message": createChatMessageHandler(),
});
```

Single function export per the loader rule documented in `docs/notes/spike-a.md:55-58` (the loader throws on non-function exports). Everything else lives in the imported modules.

### Hook 1: config injection

`packages/opencode/src/config.ts`. The exported `injectAuto(cfg, env)` function at lines 60-84 does three things in order:

1. **Idempotency gate** (`config.ts:62`). If `cfg.provider.codriver` already exists, return without touching disk. opencode may invoke the config hook more than once per process.
2. **Fleet gate** (`config.ts:63-64`). Calls `loadConfig(env)`. If the resulting fleet is empty, return without injecting. This is the feature-inert default: no fleet configured means no Auto entry shows up at all.
3. **In-place mutation** (`config.ts:65-77`). Assigns the synthetic provider block, with `name: "Codriver"`, `npm: "@ai-sdk/openai-compatible"`, a dummy `baseURL` on port 9 (proven safe by spike A, lazy registration), and a models map with exactly one entry, the Auto sentinel.

The catch at `config.ts:78-83` is the never-throw boundary: any failure (including a `ConfigError` on schema-violating JSON) warns once and swallows. Config-load problems must never break opencode startup.

The same file also exports the cfg stash (`config.ts:96-106`). The stash exists because the `chat.message` hook signature carries NO cfg parameter, so the config hook stashes the cfg reference FIRST, unconditionally, before any gating, via `stashConfig(cfg)`. The chat hook reads it back via `stashedConfig()`.

The ordering and lazy registration contracts that make this safe are documented in `docs/notes/spike-a.md:24-34` (plugins run before `provider.ts` reads `cfg.provider`) and `docs/notes/spike-a.md:92-103` (enumeration never dials the baseURL).

### Hook 2: chat.message rewrite

`packages/opencode/src/chat.ts`. The exported `createChatMessageHandler()` factory at lines 92-182 builds an async hook that runs per user message. Steps in order:

1. **Early no-op for non-Auto turns** (`chat.ts:95-101`). If `output.message.model` is not `{ providerID: "codriver", modelID: "auto" }`, return. Zero Jev calls on non-Auto turns; this is asserted by test spy counts.
2. **Catalog derivation excluding the sentinel** (`chat.ts:109-110` calling `validCatalogFromConfig` at lines 67-76). Reads the stashed cfg, builds a `Set<string>` of `"provider/model"` ids from every provider except the synthetic `codriver` one. The sentinel is never a routable target; routing to it would loop back into Auto.
3. **Per-turn loadConfig** (`chat.ts:117-125`). Always re-reads the file, never cached. A schema-violating JSON throws `ConfigError` from `loadConfig`; the inner catch substitutes the no-fleet equivalence so `route()` returns its terminal decision through the normal path.
4. **Mock-first client selection** (`chat.ts:129-131`). `CODRIVER_JEV=fixture` forces the fixture client; absent `TYPESAFE_API_KEY` also forces fixture. The plugin works end-to-end keyless.
5. **Call `route()`** (`chat.ts:136-145`). Note `stateInput.catalog: []` is intentional: `route()` supersedes the caller's catalog with the fleet derived from `config.fleet ∩ catalog`. See the policy comment at `packages/core/src/policy/policy.ts:81-83`.
6. **Rewrite** (`chat.ts:151-160`). On `no-targets`, warn and leave the sentinel. On every other reason, overwrite `output.message.model` with the decision. `variant` is deliberately omitted; both forms survive persistence per `docs/notes/spike-b.md:88-95`.
7. **Decision log** (`chat.ts:163-166`). Fire-and-forget; never throws.
8. **Never-throw catch** (`chat.ts:167-181`). If anything above throws (a poisoned client, a stashed cfg that has been mutated), the hook rewrites to a defensive fallback target if one can be computed, else mirrors the `no-targets` passthrough. Either way, no exception propagates.

The rewrite-mechanism contract that makes step 6 durable is documented in `docs/notes/spike-b.md:133-146`: the `chat.message` hook fires inside `createUserMessage` after part resolution and before persistence, so the mutated `output.message.model` is persisted verbatim and drives the session loop. Session-level state (written before the hook fires) keeps showing `codriver/auto`, which is desired UX, while the message-level model carries the concrete rewrite.

## Config mapping

One config file serves ALL agents. It lives at `~/.config/codriver/config.json` (or `$CODRIVER_CONFIG` if set), NOT inside any agent's own config directory. That placement is deliberate (decision D9 in `.omo/drafts/codriver.md`): the fleet definition is shared across opencode, hermes, openclaw, pi, and any future adapter, so the user edits one file and every agent honors it.

Schema (parsed by `parseConfig` in `packages/core/src/config/config.ts:100-112`):

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `fleet` | `FleetEntry[]` | yes | n/a | Routable models in priority order. `id` must be the host's `provider/model` id. |
| `fallback` | `string` | no | unset | `"provider/model"` used when routing does not commit to a fleet entry. |
| `route_threshold` | `number` | no | `0.55` | Minimum Jev confidence for a routed choice. |
| `route_timeout_ms` | `number` | no | `1500` | Jev request timeout. |
| `log_path` | `string` | no | unset | Override for the JSONL decision log path. |

Env vars honored by the core and adapters:

| Variable | Where read | Effect |
|---|---|---|
| `TYPESAFE_API_KEY` | `packages/core/src/jev/client.ts:70` and sanitizer in `packages/core/src/log/log.ts:84` | Http Jev authorization; the logger redacts every occurrence. If unset, the adapter's client selection forces `FixtureJevClient`. |
| `CODRIVER_CONFIG` | `packages/core/src/config/config.ts:85-90` | Absolute path override for the config file. |
| `CODRIVER_JEV` | `packages/core/src/config/config.ts:53-55` | `"fixture"` forces the fixture client regardless of key presence. |
| `CODRIVER_JEV_SCENARIO` | `packages/core/src/jev/fixture.ts:36` | In fixture mode, names the canned scenario to return. |

Because the file is shared, the same fleet definition drives routing in opencode today and in any future port without reconfiguration.

## Portability gates

Three executable checks an adapter author must pass before considering the work done. All three exist in this repo today.

**Gate 1: core stays agent-agnostic.** The string `opencode` must not appear anywhere in `packages/core/src/`:

```bash
grep -r "opencode" packages/core/src
```

Expected output: empty. Exit code 1 from `grep` (no matches). If you ever see a match, the core has taken a dependency on a specific agent and the portability contract is broken. Currently verified empty at HEAD.

**Gate 2: fixture mode routes without a key.** The end-to-end suite passes with `TYPESAFE_API_KEY` unset and `CODRIVER_JEV=fixture`:

```bash
env -u TYPESAFE_API_KEY CODRIVER_JEV=fixture bun test
```

Expected: all tests pass. This proves the adapter honors the mock-first selector and that `route()` does not require network or credentials to produce a concrete decision.

**Gate 3: the golden set passes unchanged.** The fixtures in `packages/core/test/golden/` are 24 canned scenarios (01-build-code-fence.json through 24-empty-fleet-no-fallback.json) covering every fallback reason in the closed enum. The golden test pins `RoutingDecision` shapes against those fixtures. If your adapter requires a change to any golden file, the routing policy itself has changed and you are doing surgery outside the adapter's scope. Refactor or revert; the golden set is not a suggestion.

## Porting checklist

The numbered steps below are the recipe for the next agent author (hermes, openclaw, pi, or otherwise). Each row names the action, what it produces, and what proves it worked. Skip nothing.

| # | Step | Produces | Proof |
|---|---|---|---|
| 1 | Find the interception point: read the agent's source for where the user-turn's model id is finalized before provider resolution. | A hook or callback signature with access to `{sessionID, agent?, model?}` and a mutable `output.message.model`. | The hook's doc comment cites the agent's source file and line. spike-b.md:133-146 is the opencode shape. |
| 2 | Catalog derivation: enumerate the agent's currently configured providers+models, excluding the synthetic Auto provider you are about to inject. | A `Set<string>` of `"provider/model"` ids per turn. | A unit test with two providers and the sentinel proves the sentinel is excluded. Reference: `packages/opencode/src/chat.ts:67-76`. |
| 3 | Entry injection: add the synthetic provider with an "Auto" model to the agent's config layer. | One mutated config block, idempotent across re-entry. | `opencode models` (or the agent's enumeration command) lists `codriver/auto`; a second invocation is a no-op. Reference: `packages/opencode/src/config.ts:60-84`. |
| 4 | Rewrite mechanism: in the hook, when the chosen model is the sentinel, call `route()` and overwrite the model field. | `output.message.model = { providerID, modelID }` on every path except `no-targets`. | End-to-end: a real user turn routed to a mock provider leaves the mock's id in persisted storage, not the sentinel. spike-b.md:44-82. |
| 5 | Never-block tests including terminal cases: write tests for poisoned clients, schema-violating config, empty fleet with fallback, empty fleet no fallback. | Tests for `no-valid-fleet` rewrite and `no-targets` passthrough with a captured `console.warn`. | The suite passes with `bun test`; spy counts confirm zero Jev calls on non-Auto turns. Reference: `packages/opencode/test/chat.test.ts`. |
| 6 | Golden set reuse: run the core's 24-fixture golden test against your adapter's `route()` invocation. | The same decision shapes the opencode adapter produces. Identical JSON. | `bun test packages/core/test/golden/` is green before and after your adapter is added. |

A plain-spoken caveat: every one of these steps assumes you have ALREADY done the hook-surface research for your specific agent. opencode's was done as the librarian run recorded in `.omo/drafts/codriver.md` Findings 1 through 11, against opencode v1.18.31. Hermes, openclaw, and pi each need the same shape of research before a single line of adapter code. This guide is the recipe, not the research. Do not skip it. Do not promise it works on an un-researched agent. If your agent turns out not to support mutable `output.message.model` at the interception point, stop and pick a different interception point before writing any more code; the failure mode of forcing the wrong point is silent corruption.
