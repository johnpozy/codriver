/**
 * The routing policy engine: one never-throw orchestration from
 * (config, catalog, client, turn) to a concrete `RoutingDecision`.
 *
 * Contract invariants:
 * - ALWAYS returns a decision object — never throws, never blocks (D7).
 * - `model` is always the `{providerID, modelID}` object, never a raw
 *   "provider/model" string (the TYPE RULE).
 * - The fallback chain is closed: every path resolves to a concrete model
 *   or the documented `no-targets` passthrough marker — there is no
 *   undefined target anywhere in the chain.
 */

import type { CodriverConfig } from "../config/config.js";
import { DEFAULT_ROUTE_THRESHOLD } from "../config/config.js";
import { JEV_MODEL, JevError } from "../jev/client.js";
import type { JevClient } from "../jev/client.js";
import type { ChoiceAnswer, JevResult } from "../jev/types.js";
import { FALLBACK_OPTION, buildQuestionPack } from "../state/questions.js";
import { buildRoutingState } from "../state/state.js";
import type { RoutingStateInput } from "../state/state.js";

/** A concrete model reference — the TYPE RULE shape (never a raw string). */
interface ModelId {
  readonly providerID: string;
  readonly modelID: string;
}

/** The outcome of one routing turn; structurally assignable to `DecisionLogInput`. */
export interface RoutingDecision {
  readonly model: ModelId;
  /** False only for `reason: "jev-choice"` — every other path is a fallback outcome. */
  readonly usedFallback: boolean;
  readonly reason:
    | "jev-choice"
    | "no-fit"
    | "low-confidence"
    | "timeout"
    | "error"
    | "no-key"
    | "no-valid-fleet"
    | "no-targets";
  /** The route answer's confidence when one exists; 0 otherwise. */
  readonly confidence: number;
  /** The route answer's distribution; non-empty only on `jev-choice`. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The pinned Jev model this policy evaluates through, on every path. */
  readonly jevModel: string;
  /** Wall time of the `client.evaluate` call; 0 when no call was made. */
  readonly latencyMs: number;
  readonly stateDigest: { readonly messagePreview: string };
}

/** Everything `route()` needs for one turn. */
export interface RouteInput {
  readonly config: CodriverConfig;
  /** "provider/model" ids valid in THIS run; fleet entries outside it are unroutable. */
  readonly catalog: Set<string>;
  readonly client: JevClient;
  /** Turn digest source; its `catalog` field is superseded by the valid fleet derived here. */
  readonly stateInput: RoutingStateInput;
}

/**
 * Split a "provider/model" id on the FIRST `/`. A string with no `/`
 * yields `{providerID: <raw>, modelID: ""}` — never throws.
 */
export function splitModelId(id: string): ModelId {
  const slash = id.indexOf("/");
  if (slash === -1) return { providerID: id, modelID: "" };
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/**
 * Route one turn to a concrete model. Never throws: any internal
 * exception still yields a fallback decision with `reason: "error"`.
 */
export async function route(input: RouteInput): Promise<RoutingDecision> {
  try {
    const { config, catalog, client, stateInput } = input;
    const validFleet = config.fleet.filter((entry) => catalog.has(entry.id));
    const [firstValid] = validFleet;
    const state = buildRoutingState({ ...stateInput, catalog: validFleet });
    const stateDigest = { messagePreview: state.messagePreview };

    // Terminal cases: no catalog-valid fleet entry remains.
    if (firstValid === undefined) {
      const target = terminalTargetId(config);
      if (target === undefined) {
        // (1b) literally no target: the documented passthrough marker.
        return {
          model: { providerID: "codriver", modelID: "auto" },
          usedFallback: true,
          reason: "no-targets",
          confidence: 0,
          probabilities: {},
          jevModel: JEV_MODEL,
          latencyMs: 0,
          stateDigest,
        };
      }
      // (1a) terminal fallback: a target exists outside the valid fleet.
      return {
        model: splitModelId(target),
        usedFallback: true,
        reason: "no-valid-fleet",
        confidence: 0,
        probabilities: {},
        jevModel: JEV_MODEL,
        latencyMs: 0,
        stateDigest,
      };
    }

    // Deterministic fallback chain for every non-terminal fallback:
    // catalog-valid config.fallback, else the first valid fleet entry.
    const fallbackId =
      config.fallback !== undefined && catalog.has(config.fallback) ? config.fallback : firstValid.id;
    const threshold = config.route_threshold ?? DEFAULT_ROUTE_THRESHOLD;
    const fallbackDecision = (
      reason: RoutingDecision["reason"],
      confidence: number,
      latencyMs: number,
    ): RoutingDecision => ({
      model: splitModelId(fallbackId),
      usedFallback: true,
      reason,
      confidence,
      probabilities: {},
      jevModel: JEV_MODEL,
      latencyMs,
      stateDigest,
    });

    const questions = buildQuestionPack(state);
    const startedAt = Date.now();
    let result: JevResult;
    try {
      result = await client.evaluate({ state, questions });
    } catch (err) {
      // Any Jev failure (no-key, http, timeout, parse, thrown exception)
      // fails over to the fallback chain.
      return fallbackDecision(
        err instanceof JevError ? jevErrorReason(err) : "error",
        0,
        Date.now() - startedAt,
      );
    }
    const latencyMs = Date.now() - startedAt;

    const answer = routeChoiceAnswer(result);
    if (answer === undefined || answer.choice === FALLBACK_OPTION) {
      // No usable choice: unanswered, malformed, or the explicit no-fit option.
      return fallbackDecision("no-fit", answer?.confidence ?? 0, latencyMs);
    }
    if (answer.confidence < threshold) {
      return fallbackDecision("low-confidence", answer.confidence, latencyMs);
    }
    if (!validFleet.some((entry) => entry.id === answer.choice)) {
      // The choice references a model outside the valid fleet.
      return fallbackDecision("no-fit", answer.confidence, latencyMs);
    }
    return {
      model: splitModelId(answer.choice),
      usedFallback: false,
      reason: "jev-choice",
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      jevModel: JEV_MODEL,
      latencyMs,
      stateDigest,
    };
  } catch {
    // Never-throw (D7): any internal exception still yields a decision.
    return rescueDecision(input);
  }
}

/**
 * The terminal-fallback target when no fleet entry is catalog-valid: a
 * `config.fallback` that is set (non-empty after trim), else the first raw
 * fleet entry; undefined means literally no target exists (the passthrough).
 */
function terminalTargetId(config: CodriverConfig): string | undefined {
  const fallback = nonEmpty(config.fallback);
  return fallback !== undefined ? fallback : config.fleet[0]?.id;
}

/** A fallback id counts as set only when non-empty after trimming. */
function nonEmpty(id: string | undefined): string | undefined {
  return id !== undefined && id.trim() !== "" ? id : undefined;
}

/** Map a Jev failure to its decision reason; http/parse fold into "error". */
function jevErrorReason(err: JevError): "timeout" | "no-key" | "error" {
  switch (err.kind) {
    case "timeout":
      return "timeout";
    case "no-key":
      return "no-key";
    case "http":
    case "parse":
      return "error";
  }
}

/** The route answer as a choice, if Jev returned one; anything else is unusable. */
function routeChoiceAnswer(result: JevResult): ChoiceAnswer | undefined {
  const answer = result.answers["route"];
  return answer !== undefined && "choice" in answer ? answer : undefined;
}

/**
 * Last-resort decision for the never-throw invariant: an exception that
 * escapes the main flow (a poisoned client, config, or state input) still
 * yields a concrete decision with reason "error". Recomputes the fallback
 * chain defensively; if even that fails, the no-targets passthrough marker
 * stands in.
 */
function rescueDecision(input: RouteInput): RoutingDecision {
  let model: ModelId = { providerID: "codriver", modelID: "auto" };
  try {
    const { config, catalog } = input;
    const firstValid = config.fleet.find((entry) => catalog.has(entry.id));
    const target =
      config.fallback !== undefined && catalog.has(config.fallback)
        ? config.fallback
        : (firstValid?.id ?? nonEmpty(config.fallback) ?? config.fleet[0]?.id);
    if (target !== undefined) model = splitModelId(target);
  } catch {
    // Even the defensive computation failed; keep the passthrough marker.
  }
  return {
    model,
    usedFallback: true,
    reason: "error",
    confidence: 0,
    probabilities: {},
    jevModel: JEV_MODEL,
    latencyMs: 0,
    stateDigest: { messagePreview: "" },
  };
}
