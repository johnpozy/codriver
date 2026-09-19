import { expect, test } from "bun:test";
import type { ChoiceQuestion, Question, ScoreQuestion } from "../src/jev/index.js";
import {
  FALLBACK_DESCRIPTION,
  FALLBACK_OPTION,
  buildQuestionPack,
  buildRoutingState,
} from "../src/state/index.js";
import type { FleetSummary } from "../src/state/index.js";

const fleet: readonly FleetSummary[] = [
  { id: "anthropic/claude-opus", description: "deep reasoning" },
  { id: "openai/gpt-5.5", description: "fast coding", tags: ["cheap"] },
];

function packFor(catalog: readonly FleetSummary[] = fleet): Record<string, Question> {
  const state = buildRoutingState({ agent: "build", text: "refactor the auth module", catalog });
  return buildQuestionPack(state);
}

function choiceQuestion(pack: Record<string, Question>, id: string): ChoiceQuestion {
  const question = pack[id];
  if (question === undefined || question.type !== "choice") {
    throw new Error(`expected a choice question for \`${id}\``);
  }
  return question;
}

test("the question pack has exactly three questions: route, complexity, domain", () => {
  const pack = packFor();
  expect(Object.keys(pack).sort()).toEqual(["complexity", "domain", "route"]);
});

test("route is a choice with one criterion per fleet entry plus fallback", () => {
  const route = choiceQuestion(packFor(), "route");
  expect(route.instructions).toBe("Pick the model from the fleet that should handle this user turn");
  expect(Object.keys(route.criteria).length).toBe(fleet.length + 1);
  expect(route.criteria[FALLBACK_OPTION]).toBe(FALLBACK_DESCRIPTION);
  expect(route.criteria[FALLBACK_OPTION]).toBe("no fleet option is clearly suitable");
});

test("route criteria carry the fleet description and pass tags through", () => {
  const route = choiceQuestion(packFor(), "route");
  expect(route.criteria["anthropic/claude-opus"]).toBe("deep reasoning");
  expect(route.criteria["openai/gpt-5.5"]).toBe("fast coding (tags: cheap)");
});

test("route degrades to the fallback-only criterion for an empty fleet", () => {
  const route = choiceQuestion(packFor([]), "route");
  expect(Object.keys(route.criteria)).toEqual([FALLBACK_OPTION]);
});

test("complexity is a score over exactly three levels", () => {
  const question = packFor()["complexity"];
  if (question === undefined || question.type !== "score") {
    throw new Error("expected a score question for `complexity`");
  }
  const complexity: ScoreQuestion = question;
  expect(complexity.criteria).toEqual(["routine", "moderate", "complex"]);
});

test("domain is a choice over exactly the eight fixed taxonomy keys — no more", () => {
  const domain = choiceQuestion(packFor(), "domain");
  expect(Object.keys(domain.criteria).sort()).toEqual([
    "data-processing",
    "debug",
    "docs",
    "explain-question",
    "implement-feature",
    "other",
    "planning",
    "refactor",
  ]);
  expect(Object.keys(domain.criteria).length).toBe(8);
});

test("the domain question is snapshot-frozen (fixed taxonomy, one of each)", () => {
  const domain = choiceQuestion(packFor(), "domain");
  expect(domain).toMatchSnapshot();
});

test("the route question is snapshot-frozen (instructions + criteria shape)", () => {
  const route = choiceQuestion(packFor(), "route");
  expect(route).toMatchSnapshot();
});
