import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FixtureJevClient,
  JEV_MODEL,
  type JevClient,
  type JevRequest,
  type JevResult,
} from "@johnpozy/codriver";
import { AUTO_MODEL } from "../src/auto.js";
import { stashConfig } from "../src/config.js";
import {
  createChatMessageHandler,
  validCatalogFromConfig,
  type ChatMessageOutput,
} from "../src/chat.js";

/**
 * Minimal structural view of the opencode config object — the fields the
 * stash touches. Local on purpose (no opencode type imports): the adapter
 * contract is structural, and this fake proves it.
 */
interface FakeProvider {
  name: string;
  npm: string;
  options: { baseURL: string };
  models: Record<string, { name: string }>;
}

interface FakeConfig {
  provider?: Record<string, FakeProvider>;
}

const ENV_KEYS: readonly string[] = [
  "CODRIVER_CONFIG",
  "CODRIVER_JEV",
  "CODRIVER_JEV_SCENARIO",
  "TYPESAFE_API_KEY",
  "XDG_DATA_HOME",
];

const savedEnv: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmp = mkdtempSync(join(tmpdir(), "codriver-chat-"));
  // Known starting point: keyless, no scenario pin, no config override
  // (a missing file = loadConfig's no-fleet return), decision logs under tmp.
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.CODRIVER_JEV_SCENARIO;
  process.env.CODRIVER_CONFIG = join(tmp, "missing.json");
  process.env.XDG_DATA_HOME = tmp;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  stashConfig(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(config: object): string {
  const path = join(tmp, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function fleet(...ids: string[]): { id: string; description: string }[] {
  return ids.map((id) => ({ id, description: `model ${id}` }));
}

/** Stash a fake cfg whose catalog contains exactly the given "provider/model" ids. */
function stashCatalog(...models: string[]): void {
  const provider: Record<string, FakeProvider> = {};
  for (const model of models) {
    const slash = model.indexOf("/");
    if (slash === -1) throw new Error(`fixture model must be provider/model: ${model}`);
    const providerID = model.slice(0, slash);
    const modelID = model.slice(slash + 1);
    provider[providerID] = {
      name: providerID,
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1" },
      models: { [modelID]: { name: model } },
    };
  }
  const cfg: FakeConfig = { provider };
  stashConfig(cfg);
}

function makeOutput(
  model: { providerID: string; modelID: string } = { ...AUTO_MODEL },
): ChatMessageOutput {
  return {
    message: { model: { ...model } },
    parts: [{ type: "text", text: "hello, route me" }],
  };
}

/** Capture console.warn output around an async run (the loud-log probe). */
async function captureWarns(run: () => Promise<void>): Promise<string[]> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warns;
}

function readDecisions(logPath: string): Record<string, unknown>[] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const parsed: Record<string, unknown> = JSON.parse(line);
      return parsed;
    });
}

/** A JevResult answering the route question with a fixed choice at 0.9. */
function choiceScenario(choice: string): JevResult {
  return {
    model: JEV_MODEL,
    usage: { input_tokens: 0, output_tokens: 0 },
    answers: {
      route: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
    },
  };
}

/** Spy: counts evaluate calls, delegates to an inner client. */
class CountingClient implements JevClient {
  calls = 0;
  readonly inner: JevClient;

  constructor(inner: JevClient) {
    this.inner = inner;
  }

  async evaluate(req: JevRequest): Promise<JevResult> {
    this.calls += 1;
    return this.inner.evaluate(req);
  }
}

/** Poison 1: evaluate throws synchronously (non-async method body). */
class SyncThrowClient implements JevClient {
  evaluate(_req: JevRequest): Promise<JevResult> {
    throw new Error("poison: synchronous throw");
  }
}

/** Poison 2: evaluate returns an already-rejected promise. */
class RejectedClient implements JevClient {
  evaluate(_req: JevRequest): Promise<JevResult> {
    return Promise.reject(new Error("poison: rejected promise"));
  }
}

/** Poison 3: accessing the evaluate property itself throws (getter). */
class GetterThrowClient implements JevClient {
  get evaluate(): (req: JevRequest) => Promise<JevResult> {
    throw new Error("poison: throwing getter");
  }
}

test("non-Auto model: zero Jev calls, model and parts untouched", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5"),
    fallback: "openai/gpt-5.5",
  });
  stashCatalog("openai/gpt-5.5");
  const spy = new CountingClient(new FixtureJevClient());
  const handler = createChatMessageHandler({ client: spy });
  const output = makeOutput({ providerID: "openai", modelID: "gpt-5.5" });
  const partsBefore = JSON.stringify(output.parts);
  await handler({ agent: "build" }, output);
  console.log("no-op evaluate calls:", spy.calls);
  expect(spy.calls).toBe(0);
  expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  expect(JSON.stringify(output.parts)).toBe(partsBefore);
});

test("happy rewrite: fixture choice X → out model X, exact {providerID, modelID} shape", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5", "anthropic/claude-opus-4.6"),
    fallback: "openai/gpt-5.5",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashCatalog("openai/gpt-5.5", "anthropic/claude-opus-4.6");
  const spy = new CountingClient(
    new FixtureJevClient({
      scenarios: { pick: choiceScenario("anthropic/claude-opus-4.6") },
      matcher: () => "pick",
    }),
  );
  const handler = createChatMessageHandler({ client: spy });
  const output = makeOutput();
  await handler({ agent: "build" }, output);
  console.log("happy-path evaluate calls:", spy.calls);
  expect(spy.calls).toBe(1);
  const model = output.message.model;
  expect(model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4.6" });
  expect(Object.keys(model ?? {})).toEqual(["providerID", "modelID"]);
  expect(model ?? {}).not.toHaveProperty("variant");
  const decisions = readDecisions(join(tmp, "decisions.jsonl"));
  expect(decisions[0]?.reason).toBe("jev-choice");
  expect(decisions[0]?.usedFallback).toBe(false);
});

test("fallback-on-error: client throws → model rewritten to fallback, no throw escapes", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5"),
    fallback: "openai/gpt-5.5",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashCatalog("openai/gpt-5.5");
  const handler = createChatMessageHandler({ client: new SyncThrowClient() });
  const output = makeOutput();
  await expect(handler({ agent: "build" }, output)).resolves.toBeUndefined();
  expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  const decisions = readDecisions(join(tmp, "decisions.jsonl"));
  expect(decisions[0]?.reason).toBe("error");
  expect(decisions[0]?.usedFallback).toBe(true);
});

test("env-fixture rewrite: CODRIVER_JEV=fixture with no TYPESAFE_API_KEY routes via fixture", async () => {
  process.env.CODRIVER_JEV = "fixture";
  delete process.env.TYPESAFE_API_KEY;
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5", "anthropic/claude-opus-4.6"),
    fallback: "anthropic/claude-opus-4.6",
  });
  stashCatalog("openai/gpt-5.5", "anthropic/claude-opus-4.6");
  const handler = createChatMessageHandler();
  const output = makeOutput();
  await handler({ agent: "build" }, output);
  // The fixture template answers the FIRST route option (first fleet
  // entry); a keyless HttpJevClient would have failed over to the
  // configured fallback instead — a different model.
  expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
});

test("never-leave-auto: poisoned clients throwing in three different places", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5"),
    fallback: "openai/gpt-5.5",
  });
  stashCatalog("openai/gpt-5.5");
  const poisons: JevClient[] = [
    new SyncThrowClient(),
    new RejectedClient(),
    new GetterThrowClient(),
  ];
  for (const [index, poison] of poisons.entries()) {
    const handler = createChatMessageHandler({ client: poison });
    const output = makeOutput();
    await expect(handler({ agent: "build" }, output)).resolves.toBeUndefined();
    const model = output.message.model;
    console.log(`poison ${index} result model:`, JSON.stringify(model));
    expect(model?.providerID).not.toBe(AUTO_MODEL.providerID);
    expect(model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  }
});

test("no-valid-fleet terminal: all-catalog-INVALID fleet → hook rewrites to the terminal fallback model", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5"), // not in the stashed catalog
    fallback: "anthropic/claude-opus-4.6",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashCatalog("anthropic/claude-opus-4.6");
  const handler = createChatMessageHandler();
  const output = makeOutput();
  await handler({ agent: "build" }, output);
  expect(output.message.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4.6" });
  const decisions = readDecisions(join(tmp, "decisions.jsonl"));
  expect(decisions[0]?.reason).toBe("no-valid-fleet");
  expect(decisions[0]?.usedFallback).toBe(true);
});

test("no-valid-fleet terminal: empty fleet + configured fallback → rewrites to splitModelId(fallback)", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: [],
    fallback: "openai/gpt-5.5",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashCatalog("openai/gpt-5.5");
  const handler = createChatMessageHandler();
  const output = makeOutput();
  await handler({ agent: "build" }, output);
  expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  const decisions = readDecisions(join(tmp, "decisions.jsonl"));
  expect(decisions[0]?.reason).toBe("no-valid-fleet");
});

test("no-targets passthrough: empty fleet, no fallback → model UNTOUCHED, loud log, no throw", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({ fleet: [] });
  stashCatalog("openai/gpt-5.5");
  const handler = createChatMessageHandler();
  const output = makeOutput();
  const partsBefore = JSON.stringify(output.parts);
  const warns = await captureWarns(() => handler({ agent: "build" }, output));
  console.log("no-targets captured warns:", JSON.stringify(warns));
  expect(output.message.model).toEqual({ providerID: "codriver", modelID: "auto" });
  expect(warns.length).toBeGreaterThan(0);
  expect(warns.join("\n")).toContain("codriver");
  expect(JSON.stringify(output.parts)).toBe(partsBefore);
});

test("loadConfig failure: missing config file at hook time → empty fleet, decision still returned, no throw", async () => {
  process.env.CODRIVER_CONFIG = join(tmp, "missing.json"); // never written
  stashCatalog("openai/gpt-5.5");
  const handler = createChatMessageHandler();
  const output = makeOutput();
  const warns = await captureWarns(() => handler({ agent: "build" }, output));
  // Missing file → loadConfig's no-fleet return (not a throw) → the
  // no-targets terminal: passthrough + loud log, decision still logged.
  expect(output.message.model).toEqual({ providerID: "codriver", modelID: "auto" });
  expect(warns.length).toBeGreaterThan(0);
  const decisions = readDecisions(join(tmp, "codriver", "decisions.jsonl"));
  expect(decisions[0]?.reason).toBe("no-targets");
});

test("loadConfig failure: schema-violating JSON → ConfigError caught, empty-fleet substitution, no throw", async () => {
  const path = join(tmp, "schema-violation.json");
  writeFileSync(path, JSON.stringify({ fleet: "not-an-array" }));
  process.env.CODRIVER_CONFIG = path;
  stashCatalog("openai/gpt-5.5");
  const handler = createChatMessageHandler();
  const output = makeOutput();
  const warns = await captureWarns(() => handler({ agent: "build" }, output));
  expect(output.message.model).toEqual({ providerID: "codriver", modelID: "auto" });
  expect(warns.length).toBeGreaterThan(0);
  const decisions = readDecisions(join(tmp, "codriver", "decisions.jsonl"));
  expect(decisions[0]?.reason).toBe("no-targets");
});

test("no stashed cfg (config hook never ran): empty catalog → terminal decision still followed", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("openai/gpt-5.5"),
    fallback: "openai/gpt-5.5",
  });
  const handler = createChatMessageHandler();
  const output = makeOutput();
  await handler({}, output);
  expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
});

test("validCatalogFromConfig: derives provider/model ids, excludes the codriver sentinel", () => {
  const cfg: FakeConfig = {
    provider: {
      openai: {
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://api.openai.com/v1" },
        models: {
          "gpt-5.5": { name: "GPT-5.5" },
          "gpt-5.5-mini": { name: "GPT-5.5 Mini" },
        },
      },
      codriver: {
        name: "Codriver",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1" },
        models: { auto: { name: "Auto — routed by Codriver" } },
      },
    },
  };
  const catalog = validCatalogFromConfig(cfg);
  expect([...catalog].sort()).toEqual(["openai/gpt-5.5", "openai/gpt-5.5-mini"]);
});
