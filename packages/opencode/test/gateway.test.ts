import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockllm, type MockllmServer } from "../../../tests/infra/mockllm.js";
import type { AutoConfig, AutoProvider } from "../src/config.js";
import { stashConfig } from "../src/stash.js";
import { gatewayUrl, startGateway, stopGateway } from "../src/gateway.js";

const ENV_KEYS: readonly string[] = [
  "CODRIVER_CONFIG",
  "CODRIVER_JEV",
  "CODRIVER_JEV_SCENARIO",
  "TYPESAFE_API_KEY",
  "XDG_DATA_HOME",
  "CODRIVER_UPSTREAM_BASE_URL",
  "CODRIVER_UPSTREAM_API_KEY",
  "CODEX_KEY_TEST",
];

const savedEnv: Record<string, string | undefined> = {};
let tmp: string;
let mockllm: MockllmServer;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmp = mkdtempSync(join(tmpdir(), "codriver-gateway-"));
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.CODRIVER_JEV_SCENARIO;
  delete process.env.CODRIVER_UPSTREAM_BASE_URL;
  delete process.env.CODRIVER_UPSTREAM_API_KEY;
  delete process.env.CODEX_KEY_TEST;
  process.env.CODRIVER_CONFIG = join(tmp, "missing.json");
  process.env.XDG_DATA_HOME = tmp;
  mockllm = startMockllm();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  stashConfig(undefined);
  stopGateway();
  mockllm.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(config: object): string {
  const path = join(tmp, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function writeAuthJson(entries: Record<string, { type: string; key: string }>): void {
  mkdirSync(join(tmp, "opencode"), { recursive: true });
  writeFileSync(join(tmp, "opencode", "auth.json"), JSON.stringify(entries));
}

function stashProvider(
  name: string,
  baseURL: string,
  apiKey?: string | { env: string },
): void {
  const provider: AutoProvider = {
    name,
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL, ...(apiKey !== undefined ? { apiKey } : {}) },
    models: { "any": { name: "any" } },
  };
  const cfg: AutoConfig = { provider: { [name]: provider } };
  stashConfig(cfg);
}

function fleet(...ids: string[]): { id: string; description: string }[] {
  return ids.map((id) => ({ id, description: `model ${id}` }));
}

async function postTurn(body: object): Promise<Response> {
  const url = gatewayUrl();
  if (url === undefined) throw new Error("gateway not started");
  return fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", stream: true, messages: [], ...body }),
  });
}

function decisions(): Record<string, unknown>[] {
  const path = join(tmp, "decisions.jsonl");
  const text = readFileSync(path, "utf8").trim();
  if (text === "") return [];
  return text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("routes the turn: rewrites the upstream model, pipes the SSE reply, logs the decision", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a", "beta/model-b"),
    fallback: "beta/model-b",
    log_path: join(tmp, "decisions.jsonl"),
  });
  process.env.CODRIVER_UPSTREAM_BASE_URL = `http://127.0.0.1:${mockllm.port}/v1`;
  process.env.CODRIVER_UPSTREAM_API_KEY = "gateway-test-dummy";
  await startGateway();

  const response = await postTurn({
    messages: [{ role: "user", content: "hello gateway" }],
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const text = await response.text();
  expect(text).toContain("data: [DONE]");
  // The fixture client answers the FIRST route option.
  expect(mockllm.requests.at(-1)?.model).toBe("alpha/model-a");
  const last = decisions().at(-1);
  expect(last).toMatchObject({
    reason: "jev-choice",
    usedFallback: false,
    model: { providerID: "alpha", modelID: "model-a" },
  });
});

test("extracts the text from the LAST user message, array content form", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    fallback: "alpha/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  process.env.CODRIVER_UPSTREAM_BASE_URL = `http://127.0.0.1:${mockllm.port}/v1`;
  await startGateway();

  await postTurn({
    messages: [
      { role: "user", content: "old greeting" },
      { role: "assistant", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "Refactor this 500-line module" },
          { type: "text", text: "into a clean state machine" },
        ],
      },
    ],
  });

  const last = decisions().at(-1);
  expect(last?.statePreview).toBe("Refactor this 500-line module\ninto a clean state machine");
});

test("Jev timeout: falls back to the configured fallback model and still serves the turn", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a", "beta/model-b"),
    fallback: "beta/model-b",
    log_path: join(tmp, "decisions.jsonl"),
  });
  process.env.CODRIVER_JEV = "fixture";
  process.env.CODRIVER_JEV_SCENARIO = "timeout";
  process.env.CODRIVER_UPSTREAM_BASE_URL = `http://127.0.0.1:${mockllm.port}/v1`;
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("data: [DONE]");
  expect(mockllm.requests.at(-1)?.model).toBe("beta/model-b");
  const last = decisions().at(-1);
  expect(last).toMatchObject({ reason: "timeout", usedFallback: true });
});

test("empty fleet: 503 with a JSON error, zero upstream calls", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({ fleet: [], log_path: join(tmp, "decisions.jsonl") });
  process.env.CODRIVER_UPSTREAM_BASE_URL = `http://127.0.0.1:${mockllm.port}/v1`;
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain("empty fleet");
  expect(mockllm.requests.length).toBe(0);
  expect(decisions().at(-1)).toMatchObject({ reason: "no-targets" });
});

test("no upstream configured: 503, zero upstream calls", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    log_path: join(tmp, "decisions.jsonl"),
  });
  delete process.env.CODRIVER_UPSTREAM_BASE_URL;
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain("CODRIVER_UPSTREAM_BASE_URL");
  expect(mockllm.requests.length).toBe(0);
});

test("cfg-provider prefix: routes to the provider baseURL, tail as the model, no default upstream needed", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    fallback: "alpha/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashProvider("alpha", `http://127.0.0.1:${mockllm.port}/v1`);
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(200);
  expect(mockllm.requests.at(-1)?.model).toBe("model-a");
});

test("auth.json key: type api entry becomes the Bearer credential", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    fallback: "alpha/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashProvider("alpha", `http://127.0.0.1:${mockllm.port}/v1`);
  writeAuthJson({ alpha: { type: "api", key: "auth-json-key" } });
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(200);
  expect(mockllm.requests.at(-1)?.authorization).toBe("Bearer auth-json-key");
});

test("inline apiKey beats auth.json (precedence)", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    fallback: "alpha/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashProvider("alpha", `http://127.0.0.1:${mockllm.port}/v1`, "inline-key");
  writeAuthJson({ alpha: { type: "api", key: "auth-json-key" } });
  await startGateway();

  await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(mockllm.requests.at(-1)?.authorization).toBe("Bearer inline-key");
});

test("apiKey {env: VAR} form: the named env var becomes the Bearer credential", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    fallback: "alpha/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  process.env.CODEX_KEY_TEST = "env-form-key";
  stashProvider("alpha", `http://127.0.0.1:${mockllm.port}/v1`, { env: "CODEX_KEY_TEST" });
  await startGateway();

  await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(mockllm.requests.at(-1)?.authorization).toBe("Bearer env-form-key");
});

test("auth.json oauth entries are ignored: forwarded without Authorization", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("alpha/model-a"),
    fallback: "alpha/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  stashProvider("alpha", `http://127.0.0.1:${mockllm.port}/v1`);
  writeAuthJson({ alpha: { type: "oauth", key: "oauth-token-must-not-be-used" } });
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(200);
  expect(mockllm.requests.at(-1)?.authorization).toBeUndefined();
});

test("unknown prefix with no default upstream: 503 naming the prefix", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({
    fleet: fleet("unknown/model-a"),
    fallback: "unknown/model-a",
    log_path: join(tmp, "decisions.jsonl"),
  });
  await startGateway();

  const response = await postTurn({ messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('prefix "unknown"');
  expect(mockllm.requests.length).toBe(0);
});

test("GET is rejected: 404, zero upstream calls", async () => {
  process.env.CODRIVER_CONFIG = writeConfig({ fleet: fleet("alpha/model-a") });
  process.env.CODRIVER_UPSTREAM_BASE_URL = `http://127.0.0.1:${mockllm.port}/v1`;
  await startGateway();
  const url = gatewayUrl();
  if (url === undefined) throw new Error("gateway not started");

  const response = await fetch(`${url}/models`);

  expect(response.status).toBe(404);
  expect(mockllm.requests.length).toBe(0);
});
