# Spike B — `chat.message` model rewrite survives persistence (end-to-end)

**Verdict: PROVEN.** A plugin's `chat.message` hook rewriting `output.message.model` from the
synthetic `codriver/auto` to a concrete mock provider model (`mockllm/mock-model`) survives
message persistence and drives the session loop. Verified against local opencode **v1.18.31**
(`/home/johnp/.opencode/bin/opencode`) with zero paid calls — the only LLM endpoint ever
contacted was the local mockllm server on `127.0.0.1:9371`.

## Artifacts

`spikes/model-rewrite/`:

- `mockllm.ts` — Bun.serve SSE mock on `127.0.0.1:9371`, `POST /v1/chat/completions`,
  request counter + log, `MOCKLLM_FAIL=1` env switches every completion to HTTP 500.
- `spike-rewrite.mjs` — the plugin. Legacy v1 format (named function export returning a
  hooks object). Hook body is hardcoded: if `output.message.model?.modelID === "auto"`,
  set `output.message.model = { providerID: "mockllm", modelID: "mock-model" }`.
- `opencode.json` — scratch config: synthetic `codriver` provider (model `auto`,
  `@ai-sdk/openai-compatible`, baseURL `http://127.0.0.1:9372/v1` — a deliberately dead
  local port so the negative control fails locally and deterministically) + real `mockllm`
  provider (baseURL `http://127.0.0.1:9371/v1`, apiKey `none`, model `mock-model`) +
  `"plugin": ["./spike-rewrite.mjs"]`.
- `inspect-db.ts` — verification helper: dumps `session` + `message` rows from an isolated
  `opencode.db`.

## Run invocation

From `spikes/model-rewrite/`, with a **fresh** temp dir per run (stale-state guard) and the
mockllm server running (`bun run mockllm.ts`, backgrounded):

```bash
TMP=$(mktemp -d /tmp/opencode/spike-b-runN.XXXXXX)
env XDG_DATA_HOME=$TMP XDG_CONFIG_HOME=$TMP XDG_STATE_HOME=$TMP \
    XDG_CACHE_HOME=/tmp/opencode/spike-b/cache \
    timeout 180 /home/johnp/.opencode/bin/opencode run --print-logs \
    --model codriver/auto "hi"
```

Real `HOME` retained; only the four XDG vars are redirected per child process.
`XDG_CACHE_HOME` (not in the task's mandatory three) was also redirected, shared across
runs — opencode's own test harness (`packages/opencode/test/preload.ts`) uses the same
four-var pattern.

## Results matrix

| Run | Hook | Rewrite variant | Exit | stdout | mockllm requests | Persisted user-message model |
|---|---|---|---|---|---|---|
| 1 | enabled | omitted | 0 | `ok` | 2 (title + main) | `mockllm/mock-model` |
| 2 | enabled | `variant:"default"` set | 0 | `ok` | 2 | `mockllm/mock-model` (variant=default) |
| 3 | **disabled** (file renamed) | — | 1 | empty | **0** | `codriver/auto` (untouched) |
| 4 | restored | omitted | 0 | `ok` | 2 | `mockllm/mock-model` |
| 5 | enabled, mockllm→500 | omitted | 1 | empty | 9 (all 500) | `mockllm/mock-model` |

## Verdicts

### Rewrite-survival verdict: SURVIVES

The persisted user message records the rewritten model. Raw grep of the SQLite bytes:

```
$ grep -a -o '"model":{"providerID":"mockllm","modelID":"mock-model"}' \
    $TMP/opencode/opencode.db | uniq -c
      4 "model":{"providerID":"mockllm","modelID":"mock-model"}
```

(4 occurrences: user message, assistant message, and internal prompt/history copies.)
`inspect-db.ts` output for the happy run:

```
session ses_f45d9b1dcffeZYH8yBuvEW3AW6: model={"id":"auto","providerID":"codriver","variant":"default"}
message msg_0ba264e47001SpKt1XaMHT9lva: role=user agent=build model=mockllm/mock-model
message msg_0ba264f82001lr51SIs5Rlq3su: role=assistant agent=build model=mockllm/mock-model
```

Note the split: the **session-level** model stays `codriver/auto` (it is written by
`setAgentModel` *before* the hook fires), while the **message-level** model carries the
rewrite. The session loop resolves its model from the last *user message*
(`getModel(lastUser.model.providerID, lastUser.model.modelID)`), so the rewritten value is
what reaches `llm.stream` — confirmed by the log lines
`stream providerID=mockllm modelID=mock-model ... small=false agent=build` and by mockllm's
counter. This split is benign for codriver (the picker/session view keeps showing "auto"),
but implementers must know persisted *session* state and *message* state diverge.

### Variant verdict: OPTIONAL — both omitted and set survive

- Omitted (`{ providerID, modelID }`): run succeeds, persisted as
  `"model":{"providerID":"mockllm","modelID":"mock-model"}`, no schema-validation errors.
- Set (`variant: "default"`): run succeeds, persisted with the variant, no
  schema-validation errors.

`variant` is optional on `UserMessage.model` and is not consulted by `getModel`; it only
propagates to assistant-message metadata. **Contract for codriver: omit `variant` in the
rewritten model** (the natural form; committed spike uses it).

### `.mjs` loading verdict: `.mjs` LOADS AS-IS

Plain `.mjs` with a named function export loaded directly via the config
`"plugin": ["./spike-rewrite.mjs"]` entry (legacy v1 format — each module export is a plugin
function `(input, options) => Promise<Hooks>`). No adjacent `package.json` needed; the
built-style `.js` + `{"type":"module"}` fallback was not required. Path resolution is
`path.resolve(spec)` — relative to the opencode process CWD, so run from the spike dir.

### SSE shape that satisfied `@ai-sdk/openai-compatible`

```
data: {"id":"chatcmpl-mockllm-N","object":"chat.completion.chunk","created":<unix-sec>,"model":"mock-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"chatcmpl-mockllm-N","object":"chat.completion.chunk","created":<unix-sec>,"model":"mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

```

Headers: `content-type: text/event-stream`. Two data chunks + `[DONE]`, each event
terminated by a blank line. No sync JSON path needed (opencode streams). The sync fields
`id`/`object`/`created`/`model` are present in every chunk. `delta.role` is not required.

## Storage path + XDG isolation

- Session/message storage is **SQLite**: `$XDG_DATA_HOME/opencode/opencode.db`
  (WAL mode; `-wal`/`-shm` siblings exist while running, checkpointed on clean exit —
  after exit all evidence was in the main `.db`).
- **XDG isolation honored**: config loads logged from `$TMP/opencode/…`, the DB, snapshot
  git repos, and logs all landed under `$TMP/opencode/`. The real DB
  (`~/.local/share/opencode/opencode.db`, 143 sessions) contains **zero** sessions with a
  spike directory and none of the five spike session IDs. `grep` hits for "mockllm" in real
  storage are this very agent session's own tool-output recording, not spike writes.
- One network fetch besides mockllm: the models.dev catalog (`models.json`, 4.5 MB) cached
  under `XDG_CACHE_HOME/opencode/`. `@ai-sdk/openai-compatible` itself resolved from the
  binary's bundled modules — no npm install happened (no `node_modules` anywhere in the
  isolated tree).

## Hook-firing-path observations

- `chat.message` fires inside `createUserMessage` **after** part resolution and
  **before** `decodeMessageInfo` + `sessions.updateMessage(info)` — mutation of
  `output.message` (including `.model`) is persisted verbatim.
- Hook signature (v1.18.31, `packages/plugin/src/index.ts`):
  `(input: { sessionID, agent?, model?, messageID?, variant? }, output: { message: UserMessage, parts: Part[] })`.
- The rewritten model must exist in the provider catalog (`getModel` →
  `provider.getModel`) — `mockllm/mock-model` is config-defined, so it resolves.
- Title generation (`small=true agent=title`) also runs through the rewritten model's
  provider — expect **2 LLM calls per turn** (title + main) in single-turn `opencode run`.
- `--print-logs` (stderr) is the cheapest way to observe the chain:
  `stream providerID=… modelID=…` lines show the routed model directly.

## Negative control + failure run

- **Hook disabled** (plugin file renamed): run exits 1, stdout empty, mockllm receives
  **zero** requests, persisted user message stays `codriver/auto`, error:
  `Cannot connect to API: Unable to connect. Is the computer able to access the url?`
  (the synthetic provider's dead local baseURL). The task's hypothesized ModelNotFoundError
  did not occur — `codriver/auto` *is* in the catalog via config, so the failure surfaces
  later, at the provider HTTP call. Either way the rewrite is proven load-bearing: without
  it the synthetic model has no backend.
- **mockllm → HTTP 500**: run exits 1, error
  `Internal Server Error: mockllm simulated provider failure` surfaces to the user,
  opencode retried (9 requests), and the persisted session stayed well-formed
  (user + assistant messages intact, model `mockllm/mock-model`).

## Adversarial-class results

- **stale_state**: fresh `$TMP` per run; every DB inspected belonged to that run's session
  ID only. PASS.
- **misleading_success_output**: exit 0 + "ok" was never trusted alone — SQLite bytes
  grepped for `"providerID":"mockllm"` / `"modelID":"mock-model"` (4 hits, happy run).
  PASS.
- **dirty_worktree**: real opencode storage verified untouched (no spike sessions in real
  DB; cache traces predate the spike). PASS.
- **hung_commands**: `timeout 180` on every opencode run; mockllm killed with receipt.
  PASS.
- **cancel_resume / repeated_interrupts**: failed runs (3 and 5) left well-formed
  persisted sessions (inspect-db exits 0, both messages present). PASS.
- **malformed_input**: N/A — no user input parsing in this spike.
- **prompt_injection**: N/A — no untrusted text processed.
- **flaky_tests**: N/A — spike, no test suite.

## Implications for codriver (todos 8-10)

1. The `chat.message` rewrite mechanism is safe to build on: mutate
   `output.message.model = { providerID, modelID }` (omit `variant`) and the decision
   persists and routes.
2. The synthetic `codriver` provider needs a `npm` + `baseURL` in config for the catalog
   to accept it; a dead/local baseURL is fine because the rewrite must fire before any
   LLM call. If the rewrite ever fails to fire, the user sees a provider connection
   error — the fallback chain (D7) must therefore be inside the hook, never after it.
3. Session-level model stays `codriver/auto` — the picker keeps showing "Auto" across
   turns, which is the desired UX.
4. Title generation follows the rewritten provider: codriver's fleet models will receive
   title-gen traffic too (small-model selection applies per provider).
