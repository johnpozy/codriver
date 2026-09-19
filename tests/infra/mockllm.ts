/**
 * mockllm — minimal OpenAI-compatible SSE mock for end-to-end pipeline
 * tests. Promoted from spikes/model-rewrite/mockllm.ts (spike B, PROVEN
 * against opencode v1.18.31 with @ai-sdk/openai-compatible).
 *
 * POST /v1/chat/completions streams EXACTLY the spike-B SSE shape:
 *   data: {id, object:"chat.completion.chunk", created, model,
 *          choices:[{index:0, delta:{content:"ok"}, finish_reason:null}]}
 *   data: {…same sync fields, choices:[{index:0, delta:{}, finish_reason:"stop"}]}
 *   data: [DONE]
 * with `content-type: text/event-stream`. No `delta.role` is needed.
 *
 * In-process use (preferred — no child-process lifecycle): the test calls
 * `startMockllm()`, reads `server.port` (Bun.serve on 127.0.0.1:0), asserts
 * on `server.requests`, and calls `server.stop()` when done. Standalone
 * use: `bun run tests/infra/mockllm.ts` — prints the chosen port.
 */

/** One logged completion request. */
export interface MockllmRequest {
  /** The `model` field of the request body; "unknown" when absent or unreadable. */
  readonly model: string;
  readonly bodyBytes: number;
}

export interface MockllmServer {
  /** The OS-assigned port (Bun.serve was started with port 0). */
  readonly port: number;
  /** Every completion served, in order — the request log. */
  readonly requests: readonly MockllmRequest[];
  stop(): void;
}

function sseChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, string>,
  finishReason: string | null,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The request body's `model` field, or "unknown" — the mock answers regardless. */
function readModelField(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed)) return "unknown";
  const model = parsed.model;
  return typeof model === "string" ? model : "unknown";
}

/** Start the mock on 127.0.0.1 with an OS-assigned port. */
export function startMockllm(): MockllmServer {
  const requests: MockllmRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await request.text().catch(() => "");
        const model = readModelField(body);
        requests.push({ model, bodyBytes: body.length });
        const id = `chatcmpl-mockllm-${requests.length}`;
        const created = Math.floor(Date.now() / 1000);
        const stream =
          `data: ${sseChunk(id, created, model, { content: "ok" }, null)}\n\n` +
          `data: ${sseChunk(id, created, model, {}, "stop")}\n\n` +
          "data: [DONE]\n\n";
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("mockllm failed to bind a TCP port");
  return {
    port,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const server = startMockllm();
  console.log(`[mockllm] listening on http://127.0.0.1:${server.port} (POST /v1/chat/completions)`);
  process.on("SIGTERM", () => {
    console.log(`[mockllm] SIGTERM — total completions served: ${server.requests.length}`);
    server.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log(`[mockllm] SIGINT — total completions served: ${server.requests.length}`);
    server.stop();
    process.exit(0);
  });
}
