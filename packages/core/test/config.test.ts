import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROUTE_THRESHOLD,
  DEFAULT_ROUTE_TIMEOUT_MS,
  ConfigError,
  jevMode,
  loadConfig,
} from "../src/config/index.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codriver-config-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
  const path = join(tempDir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function expectConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw new Error(`expected ConfigError, got: ${String(err)}`);
  }
  throw new Error("expected loadConfig to throw");
}

test("loadConfig parses a complete config file", () => {
  const path = writeConfig({
    fleet: [
      { id: "anthropic/claude-opus", description: "deep reasoning", tags: ["reasoning", "slow"] },
      { id: "openai/gpt-5.5", description: "fast coding" },
    ],
    fallback: "openai/gpt-5.5",
    route_threshold: 0.7,
    route_timeout_ms: 2000,
    log_path: "/tmp/codriver/decisions.jsonl",
  });
  const config = loadConfig({ CODRIVER_CONFIG: path });
  expect(config.fleet).toEqual([
    { id: "anthropic/claude-opus", description: "deep reasoning", tags: ["reasoning", "slow"] },
    { id: "openai/gpt-5.5", description: "fast coding" },
  ]);
  expect(config.fallback).toBe("openai/gpt-5.5");
  expect(config.route_threshold).toBe(0.7);
  expect(config.route_timeout_ms).toBe(2000);
  expect(config.log_path).toBe("/tmp/codriver/decisions.jsonl");
});

test("loadConfig applies defaults when optional keys are absent", () => {
  const path = writeConfig({ fleet: [{ id: "a/one", description: "first" }] });
  const config = loadConfig({ CODRIVER_CONFIG: path });
  expect(DEFAULT_ROUTE_THRESHOLD).toBe(0.55);
  expect(DEFAULT_ROUTE_TIMEOUT_MS).toBe(1500);
  expect(config.route_threshold).toBe(0.55);
  expect(config.route_timeout_ms).toBe(1500);
  expect(config.fallback).toBeUndefined();
  expect(config.log_path).toBeUndefined();
});

test("loadConfig throws a field-level ConfigError when `fleet` is missing", () => {
  const path = writeConfig({ fallback: "openai/gpt-5.5" });
  const err = expectConfigError(() => loadConfig({ CODRIVER_CONFIG: path }));
  expect(err.message).toContain("fleet");
  expect(err.field).toBe("fleet");
});

test("loadConfig names the exact fleet entry field that is missing", () => {
  const path = writeConfig({ fleet: [{ id: "a/one" }] });
  const err = expectConfigError(() => loadConfig({ CODRIVER_CONFIG: path }));
  expect(err.message).toContain("fleet[0].description");
  expect(err.field).toBe("fleet[0].description");
});

test("loadConfig rejects a non-string fleet id", () => {
  const path = writeConfig({ fleet: [{ id: 42, description: "numeric id" }] });
  const err = expectConfigError(() => loadConfig({ CODRIVER_CONFIG: path }));
  expect(err.message).toContain("fleet[0].id");
});

test("loadConfig rejects fleet tags that are not an array of strings", () => {
  const path = writeConfig({ fleet: [{ id: "a/one", description: "first", tags: [1, 2] }] });
  const err = expectConfigError(() => loadConfig({ CODRIVER_CONFIG: path }));
  expect(err.message).toContain("fleet[0].tags");
});

test("loadConfig rejects a non-numeric route_threshold", () => {
  const path = writeConfig({ fleet: [], route_threshold: "high" });
  const err = expectConfigError(() => loadConfig({ CODRIVER_CONFIG: path }));
  expect(err.message).toContain("route_threshold");
});

test("loadConfig returns the no-fleet outcome for a missing file", () => {
  const config = loadConfig({ CODRIVER_CONFIG: join(tempDir, "does-not-exist.json") });
  expect(config.fleet).toEqual([]);
  expect(config.route_threshold).toBe(0.55);
  expect(config.route_timeout_ms).toBe(1500);
});

test("loadConfig returns the no-fleet outcome for malformed JSON", () => {
  const path = writeConfig("not-json {{{");
  const config = loadConfig({ CODRIVER_CONFIG: path });
  expect(config.fleet).toEqual([]);
});

test("loadConfig respects the CODRIVER_CONFIG env path", () => {
  const pathA = writeConfig({ fleet: [{ id: "a/one", description: "first" }] });
  const pathB = writeConfig({ fleet: [{ id: "b/two", description: "second" }] });
  const configA = loadConfig({ CODRIVER_CONFIG: pathA });
  const configB = loadConfig({ CODRIVER_CONFIG: pathB });
  expect(configA.fleet[0]?.id).toBe("a/one");
  expect(configB.fleet[0]?.id).toBe("b/two");
});

test("loadConfig falls back to ~/.config/codriver/config.json when no env path is set", () => {
  const home = join(tempDir, "home");
  mkdirSync(join(home, ".config", "codriver"), { recursive: true });
  writeFileSync(
    join(home, ".config", "codriver", "config.json"),
    JSON.stringify({ fleet: [{ id: "default/path", description: "from the default path" }] }),
  );
  const config = loadConfig({ HOME: home });
  expect(config.fleet[0]?.id).toBe("default/path");
});

test("loadConfig re-reads the file on every call — no caching", () => {
  const path = writeConfig({ fleet: [{ id: "a/one", description: "first" }] });
  expect(loadConfig({ CODRIVER_CONFIG: path }).fleet.length).toBe(1);
  writeFileSync(path, JSON.stringify({ fleet: [{ id: "a/one", description: "first" }, { id: "b/two", description: "second" }] }));
  expect(loadConfig({ CODRIVER_CONFIG: path }).fleet.length).toBe(2);
});

test("jevMode selects fixture mode only on CODRIVER_JEV=fixture", () => {
  expect(jevMode({ CODRIVER_JEV: "fixture" })).toBe("fixture");
  expect(jevMode({ CODRIVER_JEV: "http" })).toBe("http");
  expect(jevMode({})).toBe("http");
});
