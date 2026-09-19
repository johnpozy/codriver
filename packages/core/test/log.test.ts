import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDecision } from "../src/log/index.js";
import type { DecisionLogInput } from "../src/log/index.js";

const ENV_KEYS = ["TYPESAFE_API_KEY", "XDG_DATA_HOME"] as const;

let savedEnv: Record<string, string | undefined> = {};
let tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codriver-log-test-"));
  tempDirs.push(dir);
  return dir;
}

function readLines(logPath: string): string[] {
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) throw new Error(`expected a log line at index ${index}`);
  return line;
}

function parseLine(line: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = JSON.parse(line);
  return parsed;
}

const baseDecision: DecisionLogInput = {
  reason: "jev-choice",
  usedFallback: false,
  model: { providerID: "anthropic", modelID: "claude-opus" },
  confidence: 0.9,
  probabilities: { "anthropic/claude-opus": 0.9, fallback: 0.1 },
  jevModel: "jev-1.13.0",
  latencyMs: 412,
  stateDigest: { messagePreview: "refactor the auth module" },
};

test("logDecision appends one JSON line that re-parses with the specified shape", () => {
  process.env.TYPESAFE_API_KEY = "sk-test-key";
  const logPath = join(makeTempDir(), "decisions.jsonl");
  logDecision(baseDecision, { agent: "build", config: { log_path: logPath } });
  const lines = readLines(logPath);
  expect(lines.length).toBe(1);
  const parsed = parseLine(lineAt(lines, 0));
  expect(Object.keys(parsed).sort()).toEqual(
    ["agent", "confidence", "jevModel", "latencyMs", "model", "probabilities", "reason", "statePreview", "ts", "usedFallback"].sort(),
  );
  expect(parsed.agent).toBe("build");
  expect(parsed.reason).toBe("jev-choice");
  expect(parsed.usedFallback).toBe(false);
  expect(parsed.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  expect(parsed.confidence).toBe(0.9);
  expect(parsed.probabilities).toEqual({ "anthropic/claude-opus": 0.9, fallback: 0.1 });
  expect(parsed.jevModel).toBe("jev-1.13.0");
  expect(parsed.latencyMs).toBe(412);
  expect(parsed.statePreview).toBe("refactor the auth module");
  expect(Number.isNaN(Date.parse(String(parsed.ts)))).toBe(false);
});

test("statePreview caps the state digest preview at 128 chars", () => {
  process.env.TYPESAFE_API_KEY = "sk-test-key";
  const logPath = join(makeTempDir(), "decisions.jsonl");
  logDecision(
    { ...baseDecision, stateDigest: { messagePreview: "x".repeat(300) } },
    { agent: "build", config: { log_path: logPath } },
  );
  const parsed = parseLine(lineAt(readLines(logPath), 0));
  expect(parsed.statePreview).toBe("x".repeat(128));
});

test("logDecision redacts the API key from string fields and probability keys", () => {
  const canary = "sk-canary-DO-NOT-LEAK-7f3a91";
  process.env.TYPESAFE_API_KEY = canary;
  const logPath = join(makeTempDir(), "decisions.jsonl");
  logDecision(
    {
      ...baseDecision,
      reason: `routed by ${canary}`,
      probabilities: { [canary]: 0.9, fallback: 0.1 },
      stateDigest: { messagePreview: `user asked about ${canary} rotation` },
    },
    { agent: "build", config: { log_path: logPath } },
  );
  const content = readFileSync(logPath, "utf8");
  console.log("sanitized line:", content.trim());
  expect(content).toContain("[REDACTED]");
  expect(content).not.toContain(canary);
  const parsed = parseLine(lineAt(readLines(logPath), 0));
  expect(parsed.reason).toBe("routed by [REDACTED]");
  expect(parsed.probabilities).toEqual({ "[REDACTED]": 0.9, fallback: 0.1 });
  expect(parsed.statePreview).toBe("user asked about [REDACTED] rotation");
});

test("sanitizer reads the key from env at write time, not at module load", () => {
  const canary = "sk-canary-STALE-PROBE";
  const logPath = join(makeTempDir(), "decisions.jsonl");
  process.env.TYPESAFE_API_KEY = canary;
  logDecision({ ...baseDecision, reason: `first ${canary}` }, { agent: "build", config: { log_path: logPath } });
  delete process.env.TYPESAFE_API_KEY;
  logDecision({ ...baseDecision, reason: `second ${canary}` }, { agent: "build", config: { log_path: logPath } });
  const lines = readLines(logPath);
  expect(lines.length).toBe(2);
  expect(parseLine(lineAt(lines, 0)).reason).toBe("first [REDACTED]");
  expect(parseLine(lineAt(lines, 1)).reason).toBe(`second ${canary}`);
});

test("logDecision returns undefined without throwing when the log path is impossible", () => {
  process.env.TYPESAFE_API_KEY = "sk-test-key";
  let returned: unknown;
  expect(() => {
    returned = logDecision(baseDecision, { agent: "build", config: { log_path: "/proc/definitely-no/write" } });
  }).not.toThrow();
  expect(returned).toBeUndefined();
});

test("50 concurrent decision appends yield 50 intact JSONL lines", async () => {
  process.env.TYPESAFE_API_KEY = "sk-test-key";
  const logPath = join(makeTempDir(), "decisions.jsonl");
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      Promise.resolve().then(() =>
        logDecision(
          { ...baseDecision, latencyMs: index, stateDigest: { messagePreview: `turn ${index}` } },
          { agent: "build", config: { log_path: logPath } },
        ),
      ),
    ),
  );
  const lines = readLines(logPath);
  expect(lines.length).toBe(50);
  const latencies = new Set<number>();
  for (const line of lines) {
    const latency = parseLine(line).latencyMs;
    if (typeof latency !== "number") throw new Error("expected numeric latencyMs in every line");
    latencies.add(latency);
  }
  expect(latencies.size).toBe(50);
});

test("without log_path, decisions land under $XDG_DATA_HOME/codriver/decisions.jsonl (mkdir -p)", () => {
  process.env.TYPESAFE_API_KEY = "sk-test-key";
  const dir = makeTempDir();
  const dataHome = join(dir, "xdg-data");
  process.env.XDG_DATA_HOME = dataHome;
  logDecision(baseDecision, { agent: "plan", config: {} });
  const logPath = join(dataHome, "codriver", "decisions.jsonl");
  const parsed = parseLine(lineAt(readLines(logPath), 0));
  expect(parsed.agent).toBe("plan");
});
