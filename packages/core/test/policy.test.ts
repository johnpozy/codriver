import { afterEach, beforeEach, expect, test } from "bun:test";
// Imported from the ROOT barrel so every run also exercises the aggregation.
import {
  DEFAULT_ROUTE_THRESHOLD,
  FixtureJevClient,
  JEV_MODEL,
  JevError,
  route,
  splitModelId,
} from "../src/index.js";
import type {
  CodriverConfig,
  DecisionLogInput,
  FleetEntry,
  JevClient,
  JevResult,
  JevScenario,
  RoutingDecision,
  RoutingStateInput,
} from "../src/index.js";

let savedScenario: string | undefined;

beforeEach(() => {
  savedScenario = process.env.CODRIVER_JEV_SCENARIO;
});

afterEach(() => {
  if (savedScenario === undefined) delete process.env.CODRIVER_JEV_SCENARIO;
  else process.env.CODRIVER_JEV_SCENARIO = savedScenario;
});

const FLEET: readonly FleetEntry[] = [
  { id: "anthropic/claude-opus", description: "deep reasoning", tags: ["reasoning"] },
  { id: "openai/gpt-5.5", description: "fast coding" },
  { id: "google/gemini-3-pro", description: "long context" },
];

const FULL_CATALOG = new Set(["anthropic/claude-opus", "openai/gpt-5.5", "google/gemini-3-pro"]);

// route() supersedes stateInput.catalog with the fleet derived from
// config + catalog — the empty catalog here proves that override: if it
// were used, the question pack would offer only the fallback option.
const STATE_INPUT: RoutingStateInput = {
  agent: "build",
  text: "refactor the auth module to use anyio",
  catalog: [],
};

function choiceResult(choice: string, confidence: number): JevResult {
  return {
    model: JEV_MODEL,
    usage: { input_tokens: 12, output_tokens: 3 },
    answers: {
      route: { choice, confidence, probabilities: { [choice]: confidence, fallback: 1 - confidence } },
    },
  };
}

const SCENARIOS: Record<string, JevScenario> = {
  "happy-opus": choiceResult("anthropic/claude-opus", 0.9),
  "low-confidence": choiceResult("anthropic/claude-opus", 0.4),
  "no-fit-option": choiceResult("fallback", 0.9),
  "filtered-choice": choiceResult("google/gemini-3-pro", 0.9),
  timeout: new JevError("timeout", "fixture timeout"),
  "no-key": new JevError("no-key", "fixture no-key"),
  http: new JevError("http", "fixture http 500", { status: 500 }),
  parse: new JevError("parse", "fixture parse"),
  "no-route-answer": { model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 0 }, answers: {} },
  "wrong-shape-route": {
    model: JEV_MODEL,
    usage: { input_tokens: 1, output_tokens: 0 },
    answers: { route: { noul: 0.5 } },
  },
};

function scenarioClient(): FixtureJevClient {
  return new FixtureJevClient({ scenarios: SCENARIOS });
}

/** Every matrix decision is recorded for the cross-case TYPE-RULE assertion. */
const recorded: RoutingDecision[] = [];

function record(decision: RoutingDecision): RoutingDecision {
  recorded.push(decision);
  return decision;
}

test("happy choice: the fixture template routes the first fleet entry with jev-choice", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: FLEET, route_threshold: DEFAULT_ROUTE_THRESHOLD },
      catalog: FULL_CATALOG,
      client: new FixtureJevClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.usedFallback).toBe(false);
  expect(decision.reason).toBe("jev-choice");
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  expect(decision.confidence).toBe(0.9);
});

test("low confidence: a choice below route_threshold falls back with reason low-confidence", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "low-confidence";
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.usedFallback).toBe(true);
  expect(decision.reason).toBe("low-confidence");
  // No config.fallback: the chain lands on the first valid fleet entry.
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  // The rejected answer's confidence is carried; its probabilities are not.
  expect(decision.confidence).toBe(0.4);
  expect(decision.probabilities).toEqual({});
});

test("no-fit: choice === fallback option routes to the fallback chain", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "no-fit-option";
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-fit");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  expect(decision.confidence).toBe(0.9);
});

test("timeout: a Jev timeout fails over to the fallback chain with reason timeout", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "timeout";
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("timeout");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  expect(decision.confidence).toBe(0);
});

test("no-key: a missing API key fails over with reason no-key", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "no-key";
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-key");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
});

test("http and parse Jev errors fail over with reason error", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "http";
  const httpDecision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(httpDecision.reason).toBe("error");
  process.env.CODRIVER_JEV_SCENARIO = "parse";
  const parseDecision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(parseDecision.reason).toBe("error");
});

class ThrowingClient implements JevClient {
  evaluate(): Promise<JevResult> {
    throw new Error("evaluate exploded synchronously");
  }
}

test("sync throw: a client whose evaluate throws synchronously still yields a decision with reason error", async () => {
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: new ThrowingClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("error");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
});

test("catalog filtering: fleet entries outside the catalog never reach the Jev question pack", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const captured: unknown[] = [];
  const client = new FixtureJevClient({
    matcher: (req) => {
      captured.push(req.state);
      return undefined; // fall through to the default template
    },
  });
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: new Set(["openai/gpt-5.5"]),
      client,
      stateInput: STATE_INPUT,
    }),
  );
  expect(captured.length).toBe(1);
  expect(captured[0]).toMatchObject({ fleet: [{ id: "openai/gpt-5.5" }] });
  expect(decision.reason).toBe("jev-choice");
  expect(decision.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
});

test("per-call catalog: an entry valid in one run is filtered in the next (no cached fleet)", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const client = new FixtureJevClient();
  const wide = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client,
      stateInput: STATE_INPUT,
    }),
  );
  expect(wide.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  const narrow = record(
    await route({
      config: { fleet: FLEET },
      catalog: new Set(["openai/gpt-5.5"]),
      client,
      stateInput: STATE_INPUT,
    }),
  );
  expect(narrow.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
});

test("filtered choice: an answer referencing a catalog-filtered model falls back with reason no-fit", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "filtered-choice";
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: new Set(["anthropic/claude-opus", "openai/gpt-5.5"]),
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-fit");
  // The chain lands on the first VALID entry, not the filtered google one.
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
});

test("invalid fallback: a config.fallback outside the catalog falls to the first valid fleet entry", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "timeout";
  const decision = record(
    await route({
      config: { fleet: FLEET, fallback: "moonshot/kimi-k3" },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("timeout");
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
});

test("valid fallback: a catalog-valid config.fallback is the fallback chain target", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "timeout";
  const decision = record(
    await route({
      config: { fleet: FLEET, fallback: "google/gemini-3-pro" },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("timeout");
  expect(decision.model).toEqual({ providerID: "google", modelID: "gemini-3-pro" });
});

test("terminal no-valid-fleet: all fleet entries catalog-invalid with a fallback configured", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: FLEET, fallback: "openai/gpt-5.5" },
      catalog: new Set(["moonshot/kimi-k3"]),
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-valid-fleet");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  expect(decision.confidence).toBe(0);
  expect(decision.probabilities).toEqual({});
});

test("terminal no-valid-fleet without a fallback uses the first raw fleet entry", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: new Set(["moonshot/kimi-k3"]),
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-valid-fleet");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
});

test("terminal no-valid-fleet: empty fleet at route time with a fallback configured", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: [], fallback: "openai/gpt-5.5" },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-valid-fleet");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
});

test("no-targets: empty fleet and no fallback returns the codriver/auto passthrough marker", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: [] },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-targets");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "codriver", modelID: "auto" });
});

test("no-targets: a whitespace-only fallback counts as unset", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: [], fallback: "   " },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.reason).toBe("no-targets");
  expect(decision.model).toEqual({ providerID: "codriver", modelID: "auto" });
});

class PoisonedClient implements JevClient {
  get scenarios(): never {
    throw new Error("poisoned getter");
  }
  evaluate(): Promise<JevResult> {
    throw new Error("poisoned evaluate");
  }
}

test("never-throw: a poisoned client (evaluate throws AND a getter throws) still yields a decision", async () => {
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: new PoisonedClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(typeof decision.model.providerID).toBe("string");
  expect(decision.reason).toBe("error");
  expect(decision.usedFallback).toBe(true);
  expect(decision.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
});

test("malformed answer: a result without a usable route answer falls back with reason no-fit", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "no-route-answer";
  const missing = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(missing.reason).toBe("no-fit");
  expect(missing.confidence).toBe(0);
  process.env.CODRIVER_JEV_SCENARIO = "wrong-shape-route";
  const wrongShape = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: scenarioClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(wrongShape.reason).toBe("no-fit");
});

test("decision carries probabilities, jevModel, and latencyMs; jevModel is the pinned jev-1.13.0", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const decision = record(
    await route({
      config: { fleet: FLEET },
      catalog: FULL_CATALOG,
      client: new FixtureJevClient(),
      stateInput: STATE_INPUT,
    }),
  );
  expect(decision.probabilities["anthropic/claude-opus"]).toBe(0.9);
  expect(decision.jevModel).toBe("jev-1.13.0");
  expect(decision.jevModel).toBe(JEV_MODEL);
  expect(typeof decision.latencyMs).toBe("number");
  expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
});

test("splitModelId splits on the first slash and degrades without one", () => {
  expect(splitModelId("anthropic/claude-opus")).toEqual({ providerID: "anthropic", modelID: "claude-opus" });
  expect(splitModelId("openai/gpt-5.5/mini")).toEqual({ providerID: "openai", modelID: "gpt-5.5/mini" });
  expect(splitModelId("gpt-5.5")).toEqual({ providerID: "gpt-5.5", modelID: "" });
});

test("TYPE RULE: every decision model is a {providerID, modelID} object, never a raw string", () => {
  expect(recorded.length).toBeGreaterThanOrEqual(15);
  for (const decision of recorded) {
    expect(typeof decision.model).toBe("object");
    expect(typeof decision.model.providerID).toBe("string");
    expect(typeof decision.model.modelID).toBe("string");
  }
});

test("RoutingDecision is structurally assignable to DecisionLogInput", () => {
  for (const decision of recorded) {
    const loggable: DecisionLogInput = decision;
    expect(loggable.model.providerID).toBe(decision.model.providerID);
    expect(loggable.stateDigest.messagePreview).toBe(decision.stateDigest.messagePreview);
  }
});
