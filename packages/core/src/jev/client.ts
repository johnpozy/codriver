import type { Answer, JevRequest, JevResult } from "./types.js";

/** The pinned Jev model. Never `jev-latest` — it moves. */
export const JEV_MODEL = "jev-1.13.0";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1";

/** Default request timeout in ms; Jev is observed at 70-500ms. */
export const DEFAULT_JEV_TIMEOUT_MS = 1500;

export type JevErrorKind = "timeout" | "http" | "no-key" | "parse";

/**
 * Typed Jev failure. Callers fail over to their fallback model on any
 * variant. The message never contains the API key.
 */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  /** HTTP status; present only on `kind === "http"`. */
  readonly status?: number;

  constructor(
    kind: JevErrorKind,
    message: string,
    options?: { readonly status?: number; readonly cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "JevError";
    this.kind = kind;
    this.status = options?.status;
  }
}

/** The exact request shape HttpJevClient sends; injectable for test interception. */
export interface JevFetchRequestInit {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type FetchLike = (url: string, init: JevFetchRequestInit) => Promise<Response>;

export interface HttpJevClientOptions {
  /** Injectable fetcher; defaults to the global fetch. */
  readonly fetcher?: FetchLike;
  /** Request timeout in milliseconds; defaults to 1500. */
  readonly timeoutMs?: number;
}

export interface JevClient {
  evaluate(req: JevRequest): Promise<JevResult>;
}

export class HttpJevClient implements JevClient {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: HttpJevClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  }

  /**
   * One POST to `${TYPESAFE_API_URL ?? default}/systemone`, no retries —
   * fail-to-fallback is the retry strategy. Env (key and URL) is read at
   * call time, never cached in a field.
   */
  async evaluate(req: JevRequest): Promise<JevResult> {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      throw new JevError("no-key", "TYPESAFE_API_KEY is not set; cannot call Jev");
    }
    const baseUrl = (process.env.TYPESAFE_API_URL ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, "");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race (not the abort signal) guarantees the deadline: a fetcher that
    // never settles must still produce JevError("timeout").
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new JevError("timeout", `Jev request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    const work = (async () => {
      const response = await this.fetcher(`${baseUrl}/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: JEV_MODEL, ...req }),
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    })();
    try {
      const { response, text } = await Promise.race([work, timeoutPromise]);
      if (!response.ok) {
        throw new JevError("http", `Jev responded with HTTP ${response.status}: ${excerpt(text)}`, {
          status: response.status,
        });
      }
      return parseJevResponse(text);
    } catch (err) {
      if (err instanceof JevError) throw err;
      if (controller.signal.aborted) {
        throw new JevError("timeout", `Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw new JevError("http", `Jev request failed: ${errorText(err)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function excerpt(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the response body into a JevResult; any mismatch is JevError("parse"). */
function parseJevResponse(text: string): JevResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new JevError("parse", `Malformed JSON in Jev response: ${errorText(err)}`, { cause: err });
  }
  if (!isRecord(raw)) {
    throw new JevError("parse", "Jev response is not a JSON object");
  }
  const { model, usage, answers } = raw;
  if (typeof model !== "string") {
    throw new JevError("parse", "Jev response field `model` is missing or not a string");
  }
  if (!isRecord(usage)) {
    throw new JevError("parse", "Jev response field `usage` is not an object");
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new JevError("parse", "Jev response field `usage` is missing token counts");
  }
  if (!isRecord(answers)) {
    throw new JevError("parse", "Jev response field `answers` is not an object");
  }
  const parsedAnswers: Record<string, Answer> = {};
  for (const [id, rawAnswer] of Object.entries(answers)) {
    parsedAnswers[id] = parseAnswer(id, rawAnswer);
  }
  return {
    model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    answers: parsedAnswers,
  };
}

function parseAnswer(id: string, raw: unknown): Answer {
  if (!isRecord(raw)) {
    throw new JevError("parse", `Jev answer \`${id}\` is not an object`);
  }
  if (typeof raw.noul === "number") {
    return { noul: raw.noul };
  }
  if (typeof raw.choice === "string") {
    const confidence = raw.confidence;
    if (typeof confidence !== "number") {
      throw new JevError("parse", `Jev answer \`${id}\` (choice) is missing a numeric confidence`);
    }
    const rawProbabilities = raw.probabilities;
    if (!isRecord(rawProbabilities)) {
      throw new JevError("parse", `Jev answer \`${id}\` (choice) is missing probabilities`);
    }
    const probabilities: Record<string, number> = {};
    for (const [option, probability] of Object.entries(rawProbabilities)) {
      if (typeof probability !== "number") {
        throw new JevError("parse", `Jev answer \`${id}\` (choice) has a non-numeric probability for \`${option}\``);
      }
      probabilities[option] = probability;
    }
    return { choice: raw.choice, confidence, probabilities };
  }
  if (typeof raw.score === "number") {
    const confidence = raw.confidence;
    if (typeof confidence !== "number") {
      throw new JevError("parse", `Jev answer \`${id}\` (score) is missing a numeric confidence`);
    }
    return { score: raw.score, confidence };
  }
  throw new JevError("parse", `Jev answer \`${id}\` matches no known answer shape (noul/choice/score)`);
}
