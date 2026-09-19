// Spike B mock provider — minimal OpenAI-compatible SSE server, local only (127.0.0.1:9371).
// Run: bun run mockllm.ts
// MOCKLLM_FAIL=1 makes every completion request return HTTP 500 (failure-QA scenario).
const HOSTNAME = "127.0.0.1"
const PORT = 9371
const FAIL_MODE = process.env.MOCKLLM_FAIL === "1"

let completions = 0

function isModelHolder(value: unknown): value is { model: string } {
  return typeof value === "object" && value !== null && typeof (value as { model?: unknown }).model === "string"
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
  })
}

const server = Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      completions += 1
      const body = await request.text().catch(() => "")
      let model = "unknown"
      try {
        const parsed: unknown = JSON.parse(body)
        if (isModelHolder(parsed)) model = parsed.model
      } catch {
        // non-JSON body — the mock answers regardless
      }
      console.log(`[mockllm] completion #${completions}: model=${model} bodyBytes=${body.length}`)
      if (FAIL_MODE) {
        console.log(`[mockllm] completion #${completions}: returning HTTP 500 (MOCKLLM_FAIL=1)`)
        return new Response("mockllm simulated provider failure", { status: 500 })
      }
      const id = `chatcmpl-mockllm-${completions}`
      const created = Math.floor(Date.now() / 1000)
      const stream =
        `data: ${sseChunk(id, created, model, { content: "ok" }, null)}\n\n` +
        `data: ${sseChunk(id, created, model, {}, "stop")}\n\n` +
        "data: [DONE]\n\n"
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    console.log(`[mockllm] unexpected request: ${request.method} ${url.pathname}`)
    return new Response("not found", { status: 404 })
  },
})

process.on("SIGTERM", () => {
  console.log(`[mockllm] SIGTERM — total completions served: ${completions}`)
  server.stop(true)
  process.exit(0)
})

console.log(`[mockllm] listening on http://${HOSTNAME}:${PORT} (FAIL_MODE=${FAIL_MODE})`)
