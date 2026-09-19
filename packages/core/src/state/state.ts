/**
 * The routing state sent to Jev: a small, hard-capped digest of the current
 * user turn plus the routable fleet. This schema is the cross-adapter
 * contract — it carries only primitives, never agent-specific types.
 */

/** Hard cap on the message preview: the only raw user text Jev ever sees. */
export const MESSAGE_PREVIEW_CAP = 512;

/** Hard cap on the code-language list derived from the message. */
export const CODE_LANGUAGES_CAP = 5;

/** A fleet entry as embedded in the routing state (structurally a config FleetEntry). */
export interface FleetSummary {
  readonly id: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

/** The hard-capped digest of one user turn, plus the routable fleet. */
export interface RoutingState {
  readonly agent: string;
  readonly mode?: string;
  /** First 512 chars of the turn's text; the ONLY raw text sent to Jev. */
  readonly messagePreview: string;
  /** Full character count of the turn's text (a number, not the text). */
  readonly messageChars: number;
  readonly hasCodeBlocks: boolean;
  /** Distinct fenced-code language names, first 5 in order of appearance. */
  readonly codeLanguages: readonly string[];
  readonly fleet: readonly FleetSummary[];
}

export interface RoutingStateInput {
  readonly agent: string;
  readonly mode?: string;
  /** The FIRST text part of the latest user message ONLY — never file contents, never history. */
  readonly text: string;
  /** The catalog-valid fleet entries offered to Jev this turn. */
  readonly catalog: readonly FleetSummary[];
}

/** A fence opening line, with or without a language tag. */
const FENCE_OPEN = /^```/m;
/** A fence opening line with a language tag; captures the language NAME, never code content. */
const FENCE_LANGUAGE = /^```(\w+)/gm;

export function buildRoutingState(input: RoutingStateInput): RoutingState {
  const messagePreview = input.text.slice(0, MESSAGE_PREVIEW_CAP);
  // Hard cap, enforced by slice + assert: if the invariant ever breaks, fail
  // loudly rather than leak text past the cap.
  if (messagePreview.length > MESSAGE_PREVIEW_CAP) {
    throw new Error(`messagePreview cap violated: ${messagePreview.length} > ${MESSAGE_PREVIEW_CAP}`);
  }
  return {
    agent: input.agent,
    mode: input.mode,
    messagePreview,
    messageChars: input.text.length,
    hasCodeBlocks: FENCE_OPEN.test(input.text),
    codeLanguages: scanCodeLanguages(input.text),
    fleet: input.catalog,
  };
}

/** Distinct language names in order of first appearance, capped at 5. */
function scanCodeLanguages(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(FENCE_LANGUAGE)) {
    const language = match[1];
    if (language !== undefined) seen.add(language);
    if (seen.size >= CODE_LANGUAGES_CAP) break;
  }
  return [...seen];
}
