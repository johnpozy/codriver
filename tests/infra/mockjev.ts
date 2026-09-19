/**
 * mockjev — local stand-in for the Jev decision-model API
 * (POST /v1/systemone), used ONLY with `CODRIVER_JEV=http` +
 * `TYPESAFE_API_URL=http://127.0.0.1:<port>/v1` so the REAL
 * HttpJevClient (URL, Bearer header, request body, response parsing) is
 * exercised end-to-end with zero paid calls.
 *
 * Returns a COMPLETE canned response — an answer for EVERY question id the
 * client sent, in the todo-4 inline spec shape:
 *   route      → {choice: <first state.fleet entry>, confidence: 0.9,
 *                 probabilities: {<first fleet entry>: 0.9, fallback: 0.1}}
 *   complexity → {score: 1, confidence: 0.9}
 *   domain     → {choice: "other", confidence: 0.9, probabilities: {other: 0.9}}
 * Response body: {answers, model: "jev-1.13.0", usage: {input_tokens, output_tokens}}.
 *
 * NOTE on `domain`: the todo-4 inline spec shape for a choice answer
 * includes `probabilities` — the real HttpJevClient's parser rejects a
 * choice answer without them (JevError "parse"), so the canned domain
 * answer carries a minimal probabilities record.
 *
 * Every request (method, path, `authorization` header, parsed body) is
 * recorded to an in-memory log the test asserts on. The Bearer value is
 * ignored entirely — the http-mode test sends a DUMMY key that is never
 * a real credential.
 */

/** One logged request. `body` is the parsed JSON body, undefined when unreadable. */
export interface MockjevRequestLogEntry {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface MockjevServer {
  /** The OS-assigned port (Bun.serve was started with port 0). */
  readonly port: number;
  /** Every request received, in order — the request log. */
  readonly requests: readonly MockjevRequestLogEntry[];
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fleet entry ids from the request's `state.fleet`, in order. */
function readFleetIds(state: unknown): string[] {
  if (!isRecord(state)) return [];
  const fleet = state.fleet;
  if (!Array.isArray(fleet)) return [];
  const ids: string[] = [];
  for (const entry of fleet) {
    if (isRecord(entry) && typeof entry.id === "string") ids.push(entry.id);
  }
  return ids;
}

/** The first criteria key of a choice question, if present. */
function firstCriteriaKey(question: unknown): string | undefined {
  if (!isRecord(question)) return undefined;
  const criteria = question.criteria;
  if (!isRecord(criteria)) return undefined;
  return Object.keys(criteria)[0];
}

/** The canned answer for one question id; unknown ids are still answered (completeness). */
function answerQuestion(id: string, question: unknown, fleet: readonly string[]): unknown {
  if (id === "route") {
    const choice = fleet[0] ?? firstCriteriaKey(question) ?? "fallback";
    return { choice, confidence: 0.9, probabilities: { [choice]: 0.9, fallback: 0.1 } };
  }
  if (id === "complexity") return { score: 1, confidence: 0.9 };
  if (id === "domain") return { choice: "other", confidence: 0.9, probabilities: { other: 0.9 } };
  const type = isRecord(question) ? question.type : undefined;
  if (type === "noul") return { noul: 0.5 };
  if (type === "score") return { score: 1, confidence: 0.9 };
  const choice = firstCriteriaKey(question) ?? "fallback";
  return { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
}

/** Fill an answer for EVERY question id in the request body. */
function answerQuestions(body: unknown): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  if (!isRecord(body)) return answers;
  const questions = body.questions;
  if (!isRecord(questions)) return answers;
  const fleet = readFleetIds(body.state);
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = answerQuestion(id, question, fleet);
  }
  return answers;
}

/** Start the mock on 127.0.0.1 with an OS-assigned port. */
export function startMockjev(): MockjevServer {
  const requests: MockjevRequestLogEntry[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const bodyText = await request.text().catch(() => "");
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = undefined;
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (request.method === "POST" && url.pathname === "/v1/systemone") {
        const responseBody = JSON.stringify({
          answers: answerQuestions(body),
          model: "jev-1.13.0",
          usage: { input_tokens: 128, output_tokens: 32 },
        });
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("mockjev failed to bind a TCP port");
  return {
    port,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const server = startMockjev();
  console.log(`[mockjev] listening on http://127.0.0.1:${server.port} (POST /v1/systemone)`);
  process.on("SIGTERM", () => {
    console.log(`[mockjev] SIGTERM — total requests served: ${server.requests.length}`);
    server.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log(`[mockjev] SIGINT — total requests served: ${server.requests.length}`);
    server.stop();
    process.exit(0);
  });
}
