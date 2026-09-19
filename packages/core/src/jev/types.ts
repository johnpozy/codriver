/**
 * Request and response types for the Jev decision-model API.
 *
 * This file is the authoritative contract for the client: the Jev research
 * notes document the endpoint and question primitives but not the response
 * body. A response that does not match `JevResult` surfaces as
 * `JevError("parse")` in the client — never a crash.

 * Request body shape: `{"model", "state", "questions": {id: {type,
 * "noul"|"choice"|"score", "instructions", "criteria"}}}`.
 */

/** A yes/no question. `criteria` optionally describes what "yes" means. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: string;
}

/** A single-choice question; criteria maps option id to its description. */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** A spectrum question; criteria is the ordered list of worded levels (2-10). */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Jev evaluates all questions in parallel over a shared, opaque state object. */
export interface JevRequest {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, Question>>;
}

/** Yes/no probability in [0, 1]. */
export interface NoulAnswer {
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  readonly score: number;
  readonly confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** A full Jev response: the answering model, token usage, and answers keyed by question id. */
export interface JevResult {
  readonly model: string;
  readonly usage: JevUsage;
  readonly answers: Record<string, Answer>;
}
