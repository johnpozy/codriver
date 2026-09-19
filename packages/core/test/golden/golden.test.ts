/**
 * Golden routing-policy fixtures — the CORE-ONLY policy regression surface.
 *
 * Each `NN-name.json` file in this directory pins ONE routing decision: the
 * config (written to a tmp file and loaded through the real `loadConfig`),
 * the per-run catalog, a canned Jev scenario, and the expected
 * `{model, usedFallback, reason}` triple, asserted EXACTLY. Future adapters
 * inherit this set as their policy regression net; adapter behavior itself
 * is covered by the opencode adapter's unit tests (todo 9) and integration
 * tests (todo 10) — there are no adapter cases here.
 *
 * Scenario encoding (JSON → JevScenario):
 * - `{ "error": { "kind": "timeout"|"http"|"no-key"|"parse", "message": "..." } }`
 *   decodes to a `JevError`, which FixtureJevClient re-throws on evaluate.
 * - Anything else decodes to a `JevResult`: `{ model, usage, answers }` with
 *   choice/score/noul answers keyed by question id (route/complexity/domain).
 *
 * Scope freeze: exactly 24 fixtures in v1 — the count never grows past 24.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Imported from the ROOT barrel so every run also exercises the aggregation.
import { FixtureJevClient, JevError, loadConfig, route } from "../../src/index.js";
import type { Answer, JevErrorKind, JevResult, JevScenario, RoutingDecision } from "../../src/index.js";

const GOLDEN_DIR = import.meta.dir;
const TMP_DIR = mkdtempSync(join(tmpdir(), "codriver-golden-"));

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

interface GoldenFixture {
  readonly file: string;
  readonly name: string;
  readonly agent: string;
  readonly mode: string | undefined;
  readonly text: string;
  readonly config: Record<string, unknown>;
  readonly catalog: readonly string[];
  readonly scenario: JevScenario;
  readonly expectedModel: { readonly providerID: string; readonly modelID: string };
  readonly expectedUsedFallback: boolean;
  readonly expectedReason: RoutingDecision["reason"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!isRecord(value)) {
    throw new Error(`fixture field \`${field}\` is missing or not an object`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`fixture field \`${field}\` is missing or not a string`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") {
    throw new Error(`fixture field \`${field}\` is missing or not a number`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`fixture field \`${field}\` is missing or not a boolean`);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new Error(`fixture field \`${field}\` is missing or not an array`);
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`fixture field \`${field}\` has a non-string item`);
    }
    items.push(item);
  }
  return items;
}

function isJevErrorKind(value: unknown): value is JevErrorKind {
  return value === "timeout" || value === "http" || value === "no-key" || value === "parse";
}

function isDecisionReason(value: unknown): value is RoutingDecision["reason"] {
  return (
    value === "jev-choice" ||
    value === "no-fit" ||
    value === "low-confidence" ||
    value === "timeout" ||
    value === "error" ||
    value === "no-key" ||
    value === "no-valid-fleet" ||
    value === "no-targets"
  );
}

function decodeScenario(raw: unknown): JevScenario {
  if (!isRecord(raw)) {
    throw new Error("fixture field `scenario` is missing or not an object");
  }
  const error = raw["error"];
  if (error !== undefined) {
    const errorRecord = recordField(raw, "error");
    const kind = errorRecord["kind"];
    if (!isJevErrorKind(kind)) {
      throw new Error("fixture field `scenario.error.kind` is not a JevError kind");
    }
    return new JevError(kind, stringField(errorRecord, "message"));
  }
  const usage = recordField(raw, "usage");
  const answers = recordField(raw, "answers");
  const decodedAnswers: Record<string, Answer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    decodedAnswers[id] = decodeAnswer(id, answer);
  }
  const result: JevResult = {
    model: stringField(raw, "model"),
    usage: { input_tokens: numberField(usage, "input_tokens"), output_tokens: numberField(usage, "output_tokens") },
    answers: decodedAnswers,
  };
  return result;
}

function decodeAnswer(id: string, raw: unknown): Answer {
  if (!isRecord(raw)) {
    throw new Error(`fixture scenario answer \`${id}\` is not an object`);
  }
  const choice = raw["choice"];
  if (typeof choice === "string") {
    const probabilitiesRecord = recordField(raw, "probabilities");
    const probabilities: Record<string, number> = {};
    for (const [option, probability] of Object.entries(probabilitiesRecord)) {
      if (typeof probability !== "number") {
        throw new Error(`fixture scenario answer \`${id}\` has a non-numeric probability for \`${option}\``);
      }
      probabilities[option] = probability;
    }
    return { choice, confidence: numberField(raw, "confidence"), probabilities };
  }
  const score = raw["score"];
  if (typeof score === "number") {
    return { score, confidence: numberField(raw, "confidence") };
  }
  const noul = raw["noul"];
  if (typeof noul === "number") {
    return { noul };
  }
  throw new Error(`fixture scenario answer \`${id}\` matches no answer shape (choice/score/noul)`);
}

function loadFixture(file: string, raw: unknown): GoldenFixture {
  if (!isRecord(raw)) {
    throw new Error(`fixture ${file} is not a JSON object`);
  }
  const stateInput = recordField(raw, "stateInput");
  const expected = recordField(raw, "expected");
  const expectedModel = recordField(expected, "model");
  const mode = stateInput["mode"];
  const reason = stringField(expected, "reason");
  if (!isDecisionReason(reason)) {
    throw new Error(`fixture ${file} field \`expected.reason\` is not a routing decision reason`);
  }
  return {
    file,
    name: stringField(raw, "name"),
    agent: stringField(stateInput, "agent"),
    mode: typeof mode === "string" ? mode : undefined,
    text: stringField(stateInput, "text"),
    config: recordField(raw, "config"),
    catalog: stringArrayField(raw, "catalog"),
    scenario: decodeScenario(raw["scenario"]),
    expectedModel: { providerID: stringField(expectedModel, "providerID"), modelID: stringField(expectedModel, "modelID") },
    expectedUsedFallback: booleanField(expected, "usedFallback"),
    expectedReason: reason,
  };
}

const fixtures: GoldenFixture[] = [];
for (const file of readdirSync(GOLDEN_DIR).filter((name) => name.endsWith(".json")).sort()) {
  const parsed: Record<string, unknown> = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf8"));
  fixtures.push(loadFixture(file, parsed));
}

test("golden set freeze: exactly 24 fixtures in v1 (scope bound)", () => {
  expect(fixtures.length).toBe(24);
});

let passed = 0;

for (const fixture of fixtures) {
  test(`${fixture.file}: ${fixture.name}`, async () => {
    const configPath = join(TMP_DIR, fixture.file);
    writeFileSync(configPath, JSON.stringify(fixture.config));
    const config = loadConfig({ CODRIVER_CONFIG: configPath });
    const client = new FixtureJevClient({ scenarios: { g: fixture.scenario }, matcher: () => "g" });
    const decision = await route({
      config,
      catalog: new Set(fixture.catalog),
      client,
      stateInput: { agent: fixture.agent, mode: fixture.mode, text: fixture.text, catalog: [] },
    });
    expect(decision.model).toEqual(fixture.expectedModel);
    expect(decision.usedFallback).toBe(fixture.expectedUsedFallback);
    expect(decision.reason).toBe(fixture.expectedReason);
    passed += 1;
    console.log(`  ${fixture.file} ${decision.reason} -> ${decision.model.providerID}/${decision.model.modelID}`);
  });
}

test("golden summary", () => {
  console.log(`${passed}/${fixtures.length} golden fixtures passed`);
});
