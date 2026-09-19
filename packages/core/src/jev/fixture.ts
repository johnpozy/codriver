import { JEV_MODEL, JevError } from "./client.js";
import type { JevClient } from "./client.js";
import type { Answer, JevRequest, JevResult, Question } from "./types.js";

/**
 * A canned scenario: a `JevResult` is returned (deep-copied, so callers cannot
 * corrupt the fixture by mutating a result); any `Error` — `JevError` or a
 * plain exception — is re-thrown as-is on every call.
 */
export type JevScenario = JevResult | JevError;

export interface FixtureJevClientOptions {
  /** Scenario name → canned outcome. */
  readonly scenarios?: Record<string, JevScenario>;
  /**
   * Selects a scenario name for a request. `undefined` falls through to
   * `CODRIVER_JEV_SCENARIO`, then to the default template evaluator.
   */
  readonly matcher?: (req: JevRequest) => string | undefined;
}

/**
 * Standard scenario names recognized by a bare `new FixtureJevClient()`.
 * These map 1:1 to the `JevError` kinds so the documented
 * `CODRIVER_JEV_SCENARIO` env var works in the wired plugin path (which
 * constructs the client with no explicit scenario table). `route()` folds
 * `http`/`parse` into reason "error"; `timeout`/`no-key` map to their own
 * reasons. A name NOT in this table still throws loudly (see evaluate).
 */
const DEFAULT_SCENARIOS: Record<string, JevScenario> = {
  timeout: new JevError("timeout", "Jev request timed out (fixture)"),
  "no-key": new JevError("no-key", "Jev API key missing (fixture)"),
  http: new JevError("http", "Jev HTTP error (fixture)", { status: 500 }),
  parse: new JevError("parse", "Jev response parse error (fixture)"),
};

/**
 * Deterministic in-process Jev stand-in for zero-paid-call testing.
 * Same input → same output; no randomness, no network. A bare client
 * (no explicit `scenarios`) recognizes the standard scenario names via
 * `DEFAULT_SCENARIOS`, so `CODRIVER_JEV_SCENARIO` works out of the box.
 */
export class FixtureJevClient implements JevClient {
  private readonly scenarios: Record<string, JevScenario>;
  private readonly matcher: ((req: JevRequest) => string | undefined) | undefined;

  constructor(options: FixtureJevClientOptions = {}) {
    this.scenarios = options.scenarios ?? DEFAULT_SCENARIOS;
    this.matcher = options.matcher;
  }

  async evaluate(req: JevRequest): Promise<JevResult> {
    const name = this.matcher?.(req) ?? process.env.CODRIVER_JEV_SCENARIO;
    if (name !== undefined) {
      const scenario = this.scenarios[name];
      if (scenario === undefined) {
        // Loud, not silent: a typo'd scenario name must not quietly fall back
        // to the default template (that would be a misleading success).
        throw new Error(`Unknown Jev fixture scenario: "${name}"`);
      }
      if (scenario instanceof Error) {
        throw scenario;
      }
      return structuredClone(scenario);
    }
    return templateResult(req);
  }
}

/**
 * Default mode: fully answer whatever questions were asked.
 * choice → first option at confidence 0.9 (remaining probability split
 * evenly); score → middle level; noul → neutral 0.5.
 */
function templateResult(req: JevRequest): JevResult {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    answers[id] = templateAnswer(question);
  }
  return { model: JEV_MODEL, usage: { input_tokens: 0, output_tokens: 0 }, answers };
}

function templateAnswer(question: Question): Answer {
  switch (question.type) {
    case "noul":
      return { noul: 0.5 };
    case "choice": {
      const options = Object.keys(question.criteria);
      const first = options[0] ?? "";
      const probabilities: Record<string, number> = {};
      for (const option of options) {
        probabilities[option] = option === first ? 0.9 : 0.1 / Math.max(options.length - 1, 1);
      }
      return { choice: first, confidence: 0.9, probabilities };
    }
    case "score":
      return { score: Math.floor((question.criteria.length - 1) / 2), confidence: 0.9 };
  }
}
