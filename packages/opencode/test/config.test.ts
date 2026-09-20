import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectAuto } from "../src/config.js";
import { gatewayUrl, startGateway, stopGateway } from "../src/gateway.js";

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
let savedUpstreamBase: string | undefined;
let tempDir: string;

beforeEach(() => {
  savedCodriverConfig = process.env.CODRIVER_CONFIG;
  savedUpstreamBase = process.env.CODRIVER_UPSTREAM_BASE_URL;
  delete process.env.CODRIVER_UPSTREAM_BASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "codriver-test-"));
});

afterEach(() => {
  if (savedCodriverConfig === undefined) delete process.env.CODRIVER_CONFIG;
  else process.env.CODRIVER_CONFIG = savedCodriverConfig;
  if (savedUpstreamBase === undefined) delete process.env.CODRIVER_UPSTREAM_BASE_URL;
  else process.env.CODRIVER_UPSTREAM_BASE_URL = savedUpstreamBase;
  rmSync(tempDir, { recursive: true, force: true });
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

function makeEmptyConfig(): FakeConfig {
  return {};
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

test("fleetless: creates default starter fleet and injects codriver/auto", () => {
  const cfgPath = join(tempDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ fleet: [] }));
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg = makeEmptyConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet.length).toBeGreaterThan(0);
  expect(written.fallback).toBeDefined();
  expect(cfg.provider?.["codriver"]).toBeDefined();
  expect(cfg.provider?.["codriver"]?.models["auto"]?.name).toBe("Auto — routed by Codriver");
});

test("missing config file: creates default starter fleet and injects", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg = makeEmptyConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  expect(existsSync(cfgPath)).toBe(true);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet.length).toBeGreaterThan(0);
  expect(written.fallback).toBeDefined();
  expect(cfg.provider?.["codriver"]).toBeDefined();
});

test("malformed JSON: creates default starter fleet and injects", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  writeFileSync(cfgPath, "not json");
  const cfg = makeEmptyConfig();
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet.length).toBeGreaterThan(0);
  expect(cfg.provider?.["codriver"]).toBeDefined();
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

test("bootstrap: missing config + non-empty providers → creates config and injects", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg = makeConfig();
  injectAuto(cfg, process.env);
  expect(existsSync(cfgPath)).toBe(true);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet).toHaveLength(1);
  expect(written.fleet[0].id).toBe("openai/gpt-5.5");
  expect(written.fleet[0].description).toBe("GPT-5.5");
  expect(written.fallback).toBe("openai/gpt-5.5");
  expect(cfg.provider?.["codriver"]).toBeDefined();
  expect(cfg.provider?.["codriver"]?.models["auto"]?.name).toBe("Auto — routed by Codriver");
});

test("bootstrap: provider with missing models is skipped, rest are used", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg: FakeConfig = {
    provider: {
      broken: { name: "Broken", npm: "", options: { baseURL: "" }, models: undefined as unknown as Record<string, { name: string }> },
      openai: { name: "OpenAI", npm: "@ai-sdk/openai", options: { baseURL: "" }, models: { "gpt-5.5": { name: "GPT-5.5" } } },
    },
  };
  injectAuto(cfg, process.env);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet).toHaveLength(1);
  expect(written.fleet[0].id).toBe("openai/gpt-5.5");
  expect(cfg.provider?.["codriver"]).toBeDefined();
});

test("bootstrap: no usable providers → falls back to default fleet and injects", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg: FakeConfig = {
    provider: {
      neuralwatt: { name: "Neuralwatt", npm: "@ai-sdk/openai-compatible", options: { baseURL: "" }, models: undefined as unknown as Record<string, { name: string }> },
    },
  };
  injectAuto(cfg, process.env);
  expect(existsSync(cfgPath)).toBe(true);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet.length).toBeGreaterThan(0);
  expect(written.fallback).toBeDefined();
  expect(cfg.provider?.["codriver"]).toBeDefined();
});

test("bootstrap: only codriver provider → no injection, no crash, no file write", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg: FakeConfig = {
    provider: {
      codriver: {
        name: "Codriver",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1" },
        models: { auto: { name: "Auto — routed by Codriver" } },
      },
    },
  };
  expect(() => injectAuto(cfg, process.env)).not.toThrow();
  expect(existsSync(cfgPath)).toBe(false);
});

test("proxy mode: injects the live gateway baseURL, not the dummy port-9 endpoint", async () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "fleet.json");
  process.env.CODRIVER_UPSTREAM_BASE_URL = "http://127.0.0.1:9/v1";
  await startGateway();
  const gatewayBase = gatewayUrl();
  expect(gatewayBase).toBeDefined();
  const cfg = makeConfig();
  injectAuto(cfg, process.env);
  expect(cfg.provider?.["codriver"]?.options.baseURL).toBe(gatewayBase);
  stopGateway();
});

test("auto proxy mode: gateway-prefixed fleet entry injects the live gateway baseURL, no env var needed", async () => {
  process.env.CODRIVER_CONFIG = join(FIXTURES, "fleet-vercel.json");
  await startGateway();
  const gatewayBase = gatewayUrl();
  expect(gatewayBase).toBeDefined();
  const cfg = makeConfig();
  injectAuto(cfg, process.env);
  expect(cfg.provider?.["codriver"]?.options.baseURL).toBe(gatewayBase);
  stopGateway();
});

test("proxy mode: starter fleet uses upstream model ids, never provider-derived ids", () => {
  const cfgPath = join(tempDir, "config.json");
  process.env.CODRIVER_CONFIG = cfgPath;
  process.env.CODRIVER_UPSTREAM_BASE_URL = "http://127.0.0.1:9/v1";
  const cfg = makeConfig();
  injectAuto(cfg, process.env);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(written.fleet.map((entry: { id: string }) => entry.id)).toEqual([
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4",
    "openai/gpt-5",
  ]);
});

test("bootstrap: existing config with fleet → file NOT overwritten", () => {
  const cfgPath = join(tempDir, "config.json");
  const original = {
    fleet: [{ id: "anthropic/claude-opus", description: "deep reasoning" }],
    fallback: "anthropic/claude-opus",
  };
  writeFileSync(cfgPath, JSON.stringify(original, null, 2));
  process.env.CODRIVER_CONFIG = cfgPath;
  const cfg = makeConfig();
  injectAuto(cfg, process.env);
  const after = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(after).toEqual(original);
  expect(cfg.provider?.["codriver"]).toBeDefined();
});
