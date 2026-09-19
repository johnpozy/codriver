import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { injectAuto } from "../src/config.js";

/**
 * Minimal structural view of the opencode config object — the fields the
 * hook touches. Local on purpose (no opencode type imports): the adapter
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

const FIXTURES = join(import.meta.dir, "fixtures");

let savedCodriverConfig: string | undefined;

beforeEach(() => {
  savedCodriverConfig = process.env.CODRIVER_CONFIG;
});

afterEach(() => {
  if (savedCodriverConfig === undefined) delete process.env.CODRIVER_CONFIG;
  else process.env.CODRIVER_CONFIG = savedCodriverConfig;
});

function makeConfig(): FakeConfig {
  return {
    provider: {
      openai: {
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://api.openai.com/v1" },
        models: { "gpt-5.5": { name: "GPT-5.5" } },
      },
    },
  };
}

test("injects codriver/auto when the fleet has entries", () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "fleet.json");
  const cfg = makeConfig();
  const before = JSON.stringify(cfg, null, 2);
  injectAuto(cfg, process.env);
  const after = JSON.stringify(cfg, null, 2);
  console.log("before:\n" + before);
  console.log("after:\n" + after);
  const codriver = cfg.provider?.["codriver"];
  expect(codriver).toBeDefined();
  expect(codriver?.name).toBe("Codriver");
  expect(codriver?.npm).toBe("@ai-sdk/openai-compatible");
  expect(codriver?.options.baseURL).toBe("http://127.0.0.1:9/v1");
  expect(codriver?.models["auto"]?.name).toBe("Auto — routed by Codriver");
  // pre-existing providers untouched
  expect(cfg.provider?.["openai"]?.name).toBe("OpenAI");
});

test("fleetless: no injection, no throw", () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "fleetless.json");
  const cfg = makeConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  expect(cfg.provider?.["codriver"]).toBeUndefined();
});

test("missing config file: no injection, no throw", () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "missing.json");
  const cfg = makeConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  expect(cfg.provider?.["codriver"]).toBeUndefined();
});

test("malformed JSON: no injection, no throw", () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "malformed.json");
  const cfg = makeConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  expect(cfg.provider?.["codriver"]).toBeUndefined();
});

test("schema-violating config: no injection, no throw", () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "schema-violation.json");
  const cfg = makeConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  expect(cfg.provider?.["codriver"]).toBeUndefined();
});

test("idempotent: second call adds nothing", () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "fleet.json");
  const cfg = makeConfig();
  injectAuto(cfg, process.env);
  const snapshot = structuredClone(cfg);
  injectAuto(cfg, process.env);
  expect(cfg).toEqual(snapshot);
  expect(Object.keys(cfg.provider ?? {})).toEqual(["openai", "codriver"]);
});
