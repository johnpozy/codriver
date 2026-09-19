import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_TIMEOUT_MS,
  FixtureJevClient,
  HttpJevClient,
  JEV_MODEL,
  JevError,
} from "../src/jev/index.js";
import type { FetchLike, JevRequest, JevResult } from "../src/jev/index.js";

const ENV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_API_URL", "CODRIVER_JEV_SCENARIO"] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const sampleRequest: JevRequest = {
  state: { agent: "build", messagePreview: "refactor the auth module" },
  questions: {
    route: {
      type: "choice",
      instructions: "Pick the model from the fleet that should handle this user turn",
      criteria: {
        "anthropic/claude-opus": "deep reasoning",
        "openai/gpt-5.5": "fast coding",
        fallback: "no fleet option is clearly suitable",
      },
    },
    complexity: {
      type: "score",
      instructions: "How complex is this turn?",
      criteria: ["routine", "moderate", "complex"],
    },
    needs_context: {
      type: "noul",
      instructions: "Does this turn require repo context?",
    },
  },
};

const emptyResult: JevResult = {
  model: JEV_MODEL,
  usage: { input_tokens: 10, output_tokens: 0 },
  answers: {},
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedCall {
  url: string;
  init: Parameters<FetchLike>[1];
}

function capturingFetcher(respond: () => Response | Promise<Response>): {
  fetcher: FetchLike;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetcher: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { fetcher, calls };
}

const neverResolve: FetchLike = () => new Promise<Response>(() => {});

async function rejectWithJevError(promise: Promise<JevResult>): Promise<JevError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof JevError) return err;
    throw new Error(`expected JevError, got: ${String(err)}`);
  }
  throw new Error("expected the promise to reject");
}

test("HttpJevClient pins the model in the request body", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const { fetcher, calls } = capturingFetcher(() => jsonResponse(emptyResult));
  const client = new HttpJevClient({ fetcher });
  await client.evaluate(sampleRequest);
  expect(calls.length).toBe(1);
  const body: { model?: unknown; state?: unknown; questions?: unknown } = JSON.parse(calls[0]!.init.body);
  console.log("pinning: model:", JSON.stringify(body.model));
  expect(body.model).toBe("jev-1.13.0");
  expect(body.state).toEqual(sampleRequest.state);
  expect(body.questions).toEqual(sampleRequest.questions);
});

test("HttpJevClient reads the Bearer key from env at call time", async () => {
  process.env.TYPESAFE_API_KEY = "key-one";
  const { fetcher, calls } = capturingFetcher(() => jsonResponse(emptyResult));
  const client = new HttpJevClient({ fetcher });
  await client.evaluate(sampleRequest);
  process.env.TYPESAFE_API_KEY = "key-two";
  await client.evaluate(sampleRequest);
  expect(calls[0]!.init.headers.authorization).toBe("Bearer key-one");
  expect(calls[1]!.init.headers.authorization).toBe("Bearer key-two");
});

test("HttpJevClient reads the base URL from env at call time", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const { fetcher, calls } = capturingFetcher(() => jsonResponse(emptyResult));
  const client = new HttpJevClient({ fetcher });
  await client.evaluate(sampleRequest);
  expect(calls[0]!.url).toBe(`${DEFAULT_JEV_BASE_URL}/systemone`);
  process.env.TYPESAFE_API_URL = "http://localhost:9999/v1";
  await client.evaluate(sampleRequest);
  expect(calls[1]!.url).toBe("http://localhost:9999/v1/systemone");
});

test("HttpJevClient surfaces a never-resolving fetch as JevError(timeout)", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const client = new HttpJevClient({ fetcher: neverResolve, timeoutMs: 10 });
  const err = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(err.kind).toBe("timeout");
});

test("HttpJevClient surfaces HTTP 500 as JevError(http)", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const { fetcher } = capturingFetcher(() => new Response("upstream exploded", { status: 500 }));
  const client = new HttpJevClient({ fetcher });
  const err = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(err.kind).toBe("http");
  expect(err.status).toBe(500);
});

test("HttpJevClient surfaces a missing key as JevError(no-key) without fetching", async () => {
  delete process.env.TYPESAFE_API_KEY;
  let fetchCalls = 0;
  const fetcher: FetchLike = () => {
    fetchCalls += 1;
    return Promise.resolve(jsonResponse(emptyResult));
  };
  const client = new HttpJevClient({ fetcher });
  const err = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(err.kind).toBe("no-key");
  expect(fetchCalls).toBe(0);
});

test("HttpJevClient surfaces malformed JSON as JevError(parse)", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const { fetcher } = capturingFetcher(() => new Response("not-json {{{", { status: 200 }));
  const client = new HttpJevClient({ fetcher });
  const err = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(err.kind).toBe("parse");
});

test("HttpJevClient surfaces a shape mismatch as JevError(parse)", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const { fetcher } = capturingFetcher(() =>
    jsonResponse({ model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 0 } }),
  );
  const client = new HttpJevClient({ fetcher });
  const err = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(err.kind).toBe("parse");
});

test("HttpJevClient surfaces a bad answer shape as JevError(parse)", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const { fetcher } = capturingFetcher(() =>
    jsonResponse({
      model: JEV_MODEL,
      usage: { input_tokens: 1, output_tokens: 0 },
      answers: { route: { choice: "x", confidence: "high" } },
    }),
  );
  const client = new HttpJevClient({ fetcher });
  const err = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(err.kind).toBe("parse");
});

test("JevError messages never contain the API key", async () => {
  const key = "sk-super-secret-do-not-leak";
  process.env.TYPESAFE_API_KEY = key;
  const errors: JevError[] = [];
  errors.push(
    await rejectWithJevError(new HttpJevClient({ fetcher: neverResolve, timeoutMs: 5 }).evaluate(sampleRequest)),
  );
  errors.push(
    await rejectWithJevError(
      new HttpJevClient({ fetcher: capturingFetcher(() => new Response("boom", { status: 500 })).fetcher })
        .evaluate(sampleRequest),
    ),
  );
  errors.push(
    await rejectWithJevError(
      new HttpJevClient({ fetcher: capturingFetcher(() => new Response("not-json", { status: 200 })).fetcher })
        .evaluate(sampleRequest),
    ),
  );
  delete process.env.TYPESAFE_API_KEY;
  errors.push(await rejectWithJevError(new HttpJevClient({ fetcher: neverResolve }).evaluate(sampleRequest)));
  expect(errors.length).toBe(4);
  for (const err of errors) {
    expect(String(err)).not.toContain(key);
    expect(err.message).not.toContain(key);
  }
});

test("HttpJevClient default timeout is 1500ms and admits fast responses", async () => {
  expect(DEFAULT_JEV_TIMEOUT_MS).toBe(1500);
  process.env.TYPESAFE_API_KEY = "test-key";
  const delayed: FetchLike = (url, init) =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(jsonResponse(emptyResult)), 20);
    });
  const client = new HttpJevClient({ fetcher: delayed });
  const result = await client.evaluate(sampleRequest);
  expect(result.model).toBe(JEV_MODEL);
});

test("FixtureJevClient default mode is deterministic and answers every question", async () => {
  delete process.env.CODRIVER_JEV_SCENARIO;
  const client = new FixtureJevClient();
  const first = await client.evaluate(sampleRequest);
  const second = await client.evaluate(sampleRequest);
  expect(first).toEqual(second);
  expect(Object.keys(first.answers).sort()).toEqual(["complexity", "needs_context", "route"]);
  const route = first.answers["route"];
  if (route === undefined || !("choice" in route)) throw new Error("expected a choice answer for `route`");
  expect(route.choice).toBe("anthropic/claude-opus");
  expect(route.confidence).toBe(0.9);
  const complexity = first.answers["complexity"];
  if (complexity === undefined || !("score" in complexity)) throw new Error("expected a score answer");
  expect(complexity.score).toBe(1);
  const noul = first.answers["needs_context"];
  if (noul === undefined || !("noul" in noul)) throw new Error("expected a noul answer");
  expect(noul.noul).toBe(0.5);
});

test("FixtureJevClient error scenario rejects deterministically", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "timeout";
  const client = new FixtureJevClient({ scenarios: { timeout: new JevError("timeout", "fixture timeout") } });
  const first = await rejectWithJevError(client.evaluate(sampleRequest));
  const second = await rejectWithJevError(client.evaluate(sampleRequest));
  expect(first.kind).toBe("timeout");
  expect(second.kind).toBe("timeout");
});

test("FixtureJevClient returns a deep copy of the canned scenario", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "custom";
  const canned: JevResult = {
    model: JEV_MODEL,
    usage: { input_tokens: 42, output_tokens: 0 },
    answers: { route: { choice: "fallback", confidence: 0.9, probabilities: { fallback: 0.9 } } },
  };
  const client = new FixtureJevClient({ scenarios: { custom: canned } });
  const first = await client.evaluate(sampleRequest);
  first.answers["route"] = { noul: 0 };
  first.answers["injected"] = { noul: 1 };
  const second = await client.evaluate(sampleRequest);
  expect(second).toEqual(canned);
});

test("FixtureJevClient matcher selects a scenario by request", async () => {
  const resultA: JevResult = { model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 0 }, answers: {} };
  const resultB: JevResult = { model: JEV_MODEL, usage: { input_tokens: 2, output_tokens: 0 }, answers: {} };
  const client = new FixtureJevClient({
    scenarios: { a: resultA, b: resultB },
    matcher: (req) => ("route" in req.questions ? "a" : "b"),
  });
  const withRoute = await client.evaluate(sampleRequest);
  const withoutRoute = await client.evaluate({ state: {}, questions: {} });
  expect(withRoute).toEqual(resultA);
  expect(withoutRoute).toEqual(resultB);
});

test("FixtureJevClient throws loudly on an unknown scenario name", async () => {
  process.env.CODRIVER_JEV_SCENARIO = "does-not-exist";
  const client = new FixtureJevClient({ scenarios: {} });
  let message = "";
  try {
    await client.evaluate(sampleRequest);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("Unknown Jev fixture scenario");
});
