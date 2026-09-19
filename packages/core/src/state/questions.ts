import type { Question } from "../jev/types.js";
import type { FleetSummary, RoutingState } from "./state.js";

/** The route option id used when no fleet entry is clearly suitable. */
export const FALLBACK_OPTION = "fallback";
export const FALLBACK_DESCRIPTION = "no fleet option is clearly suitable";

/** The fixed domain taxonomy — exactly eight, one of each, no more, ever. */
const DOMAIN_OPTIONS: Readonly<Record<string, string>> = {
  "implement-feature": "building a new feature or capability",
  refactor: "restructuring existing code without changing behavior",
  debug: "diagnosing or fixing a bug, error, or failure",
  "explain-question": "asking how something works or seeking an explanation",
  docs: "writing or updating documentation",
  planning: "planning, designing, or breaking down work",
  "data-processing": "transforming, analyzing, or querying data",
  other: "none of the other categories",
};

const COMPLEXITY_LEVELS: readonly string[] = ["routine", "moderate", "complex"];

/**
 * The three questions Codriver asks Jev on every Auto turn — exactly three:
 * route (which fleet model), complexity (how hard), domain (what kind of work).
 * All derivation is local; nothing here consults an LLM.
 */
export function buildQuestionPack(state: RoutingState): Record<string, Question> {
  return {
    route: {
      type: "choice",
      instructions: "Pick the model from the fleet that should handle this user turn",
      criteria: routeCriteria(state.fleet),
    },
    complexity: {
      type: "score",
      instructions: "How complex is this user turn?",
      criteria: COMPLEXITY_LEVELS,
    },
    domain: {
      type: "choice",
      instructions: "Classify the primary domain of this user turn",
      criteria: DOMAIN_OPTIONS,
    },
  };
}

/** One option per fleet entry (description + optional tags), plus `fallback` last. */
function routeCriteria(fleet: readonly FleetSummary[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const entry of fleet) {
    criteria[entry.id] =
      entry.tags === undefined || entry.tags.length === 0
        ? entry.description
        : `${entry.description} (tags: ${entry.tags.join(", ")})`;
  }
  criteria[FALLBACK_OPTION] = FALLBACK_DESCRIPTION;
  return criteria;
}
