/**
 * The codriver loopback gateway (proxy mode).
 *
 * WHY this exists: opencode's TUI model indicator follows the persisted
 * message model, and the `chat.message` rewrite changes exactly that model —
 * so in rewrite mode the picker drifts off Auto after the first routed turn
 * (opencode issue #18667, closed as not planned). In proxy mode the message
 * model is NEVER rewritten: `codriver/auto` stays the persisted model and the
 * indicator stays on Auto. Instead, the injected provider points at THIS
 * loopback OpenAI-compatible server, which receives every completion request
 * for "auto", asks Jev which fleet entry fits the turn, and forwards the
 * request to that entry's upstream with the `model` field rewritten, piping
 * the (streaming) response back byte-for-byte. The routed model is announced
 * on the console and recorded in the decision log on every turn.
 *
 * Fleet ids are `"<upstream>/<model>"`: the FIRST path segment names the
 * upstream, the rest is the model string forwarded to it. Upstream
 * resolution for the prefix, in order:
 *   1. the opencode provider of the same name from the stashed cfg — its
 *      `options.baseURL` (and `options.apiKey`, literal or `{env: VAR}`),
 *      so any custom provider works;
 *   2. a builtin gateway registry entry (vercel, openrouter) — the key then
 *      comes from opencode's `auth.json` for that provider name;
 *   3. no prefix match → the WHOLE id is forwarded to the default upstream
 *      (CODRIVER_UPSTREAM_BASE_URL, key CODRIVER_UPSTREAM_API_KEY) — the
 *      single-gateway behavior.
 *
 * Keys are read lazily per request, only from `type: "api"` auth.json
 * entries (OAuth tokens belong to opencode), and never logged.
 *
 * Loopback-bound on purpose: it forwards with real credentials and must
 * never be reachable from the network.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROUTE_THRESHOLD,
  DEFAULT_ROUTE_TIMEOUT_MS,
  FixtureJevClient,
  HttpJevClient,
  jevMode,
  loadConfig,
  logDecision,
  route,
  type CodriverConfig,
  type JevClient,
} from "@johnpozy/codriver";
import { AUTO_MODEL } from "./auto.js";
import type { AutoConfig, AutoProvider } from "./config.js";
import { stashedConfig } from "./stash.js";

interface GatewayEnv {
  readonly [key: string]: string | undefined;
  readonly TYPESAFE_API_KEY?: string;
  readonly CODRIVER_JEV?: string;
  readonly CODRIVER_UPSTREAM_BASE_URL?: string;
  readonly CODRIVER_UPSTREAM_API_KEY?: string;
  readonly XDG_DATA_HOME?: string;
}

type JsonRecord = Record<string, unknown>;

/**
 * Gateways whose base URLs the stashed cfg cannot supply — opencode's built-in providers are invisible to the config hook.
 * The vercel entry is the gateway's OpenAI-compatible surface (PROBED: /v1/chat/completions answers 200 with the
 * auth.json key; /v4/ai/* is @ai-sdk/gateway's own protocol, NOT OpenAI-compatible, and ai.gateway.dev is not Vercel).
 */
const BUILTIN_UPSTREAMS: Readonly<Record<string, string>> = {
  vercel: "https://ai-gateway.vercel.sh/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

interface UpstreamTarget {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly via: string;
}

let gateway: Server | undefined;
let gatewayUrlValue: string | undefined;

/** Proxy mode is on when CODRIVER_UPSTREAM_BASE_URL is set to a non-empty value. */
export function upstreamConfigured(env: GatewayEnv): boolean {
  const base = env.CODRIVER_UPSTREAM_BASE_URL;
  return base !== undefined && base.trim() !== "";
}

/**
 * Proxy-mode activation: explicit (CODRIVER_UPSTREAM_BASE_URL set) OR auto
 * (any fleet entry prefixed with a builtin gateway name — "vercel/…"/"openrouter/…"
 * ids are unambiguous gateway intent, so no env var is needed to switch on).
 */
export function proxyModeActive(env: GatewayEnv, config: CodriverConfig): boolean {
  if (upstreamConfigured(env)) return true;
  return config.fleet.some((entry) => {
    const slash = entry.id.indexOf("/");
    return slash !== -1 && BUILTIN_UPSTREAMS[entry.id.slice(0, slash)] !== undefined;
  });
}

/** The live gateway URL ("http://127.0.0.1:<port>/v1"), undefined until started. */
export function gatewayUrl(): string | undefined {
  return gatewayUrlValue;
}

/** Start the loopback server (idempotent). Throws only on bind failure. */
export async function startGateway(): Promise<void> {
  if (gateway !== undefined) return;
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      respondJson(res, 502, { error: `codriver gateway: ${String(error)}` });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.on("error", (error) => {
    console.warn(`codriver: gateway server error: ${String(error)}`);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("gateway: unexpected listen address");
  }
  gateway = server;
  gatewayUrlValue = `http://127.0.0.1:${address.port}/v1`;
}

/** Stop and reset the singleton (test seam). */
export function stopGateway(): void {
  if (gateway !== undefined) {
    gateway.close();
    gateway = undefined;
    gatewayUrlValue = undefined;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 404, { error: "codriver gateway: POST only" });
    return;
  }
  const bodyText = await readBody(req);
  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(bodyText) as JsonRecord;
  } catch {
    respondJson(res, 400, { error: "codriver gateway: request body is not valid JSON" });
    return;
  }

  let config: CodriverConfig;
  try {
    config = loadConfig(process.env);
  } catch {
    config = {
      fleet: [],
      route_threshold: DEFAULT_ROUTE_THRESHOLD,
      route_timeout_ms: DEFAULT_ROUTE_TIMEOUT_MS,
    };
  }
  const catalog = new Set(config.fleet.map((entry) => entry.id));
  const useFixture = jevMode(process.env) === "fixture" || !process.env.TYPESAFE_API_KEY;
  const client: JevClient = useFixture ? new FixtureJevClient() : new HttpJevClient();

  const decision = await route({
    config,
    catalog,
    client,
    stateInput: { agent: "unknown", text: lastUserText(parsed), catalog: [] },
  });
  logDecision(decision, { agent: "unknown", config: { log_path: config.log_path } });

  if (decision.reason === "no-targets") {
    console.warn("codriver: empty fleet and no fallback — add fleet entries to the codriver config");
    respondJson(res, 503, {
      error: "codriver gateway: empty fleet and no fallback — add fleet entries to the codriver config",
    });
    return;
  }

  const routedId = wholeModelId(decision);
  const target = resolveUpstream(routedId, process.env, stashedConfig());
  if (target === undefined) {
    const prefix = routedId.slice(0, routedId.indexOf("/"));
    const message =
      `codriver gateway: no upstream for "${routedId}" — prefix "${prefix}" is not a configured provider ` +
      "or builtin gateway, and CODRIVER_UPSTREAM_BASE_URL is not set";
    console.warn(`codriver: ${message}`);
    respondJson(res, 503, { error: message });
    return;
  }

  parsed.model = target.model;
  if (target.apiKey === undefined) {
    console.warn(`codriver: no API key found for upstream "${target.via}" — forwarding without Authorization`);
  }
  console.warn(`codriver: auto → ${target.model} via ${target.via} (${decision.reason}, ${decision.confidence})`);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.apiKey !== undefined) headers.authorization = `Bearer ${target.apiKey}`;
  const accept = req.headers.accept;
  if (typeof accept === "string") headers.accept = accept;

  const upstream = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(parsed),
  });
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  const reader = upstream.body?.getReader();
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(value);
    }
  }
  res.end();
}

/** The fleet id a decision points at, rebuilt from its split form (splitModelId drops no characters). */
function wholeModelId(decision: { model: { providerID: string; modelID: string } }): string {
  return decision.model.modelID === ""
    ? decision.model.providerID
    : `${decision.model.providerID}/${decision.model.modelID}`;
}

/**
 * Resolve a routed fleet id to its upstream. A prefix match (cfg provider →
 * builtin gateway) splits the id; otherwise the WHOLE id goes to the
 * default upstream. Undefined = no upstream exists for the id at all.
 */
function resolveUpstream(id: string, env: GatewayEnv, cfg: AutoConfig | undefined): UpstreamTarget | undefined {
  const slash = id.indexOf("/");
  if (slash !== -1) {
    const prefix = id.slice(0, slash);
    const tail = id.slice(slash + 1);
    const provider = cfg?.provider?.[prefix];
    const customBase = provider?.options.baseURL;
    if (
      provider !== undefined &&
      customBase !== undefined &&
      customBase.trim() !== "" &&
      prefix !== AUTO_MODEL.providerID
    ) {
      return {
        baseUrl: customBase,
        model: tail,
        apiKey: providerApiKey(provider, env) ?? authJsonKey(prefix, env),
        via: prefix,
      };
    }
    const builtinBase = BUILTIN_UPSTREAMS[prefix];
    if (builtinBase !== undefined) {
      return { baseUrl: builtinBase, model: tail, apiKey: authJsonKey(prefix, env), via: prefix };
    }
  }
  const defaultBase = env.CODRIVER_UPSTREAM_BASE_URL?.trim();
  if (defaultBase === undefined || defaultBase === "") return undefined;
  const defaultKey = env.CODRIVER_UPSTREAM_API_KEY?.trim();
  return {
    baseUrl: defaultBase,
    model: id,
    apiKey: defaultKey === undefined || defaultKey === "" ? undefined : defaultKey,
    via: "default",
  };
}

/** The provider's inline apiKey: a literal string, or opencode's `{env: VAR}` indirection. */
function providerApiKey(provider: AutoProvider, env: GatewayEnv): string | undefined {
  const apiKey = provider.options.apiKey;
  if (apiKey === undefined) return undefined;
  if (typeof apiKey === "string") return apiKey.trim() === "" ? undefined : apiKey;
  const value = env[apiKey.env];
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** opencode's stored API key for a provider (`type: "api"` entries ONLY — OAuth tokens are never used). */
function authJsonKey(provider: string, env: GatewayEnv): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authJsonPath(env), "utf8"));
    if (!isRecord(parsed)) return undefined;
    const entry = parsed[provider];
    if (!isRecord(entry) || entry.type !== "api") return undefined;
    const key = entry.key;
    return typeof key === "string" && key.trim() !== "" ? key : undefined;
  } catch {
    return undefined;
  }
}

function authJsonPath(env: GatewayEnv): string {
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.trim() !== ""
      ? env.XDG_DATA_HOME
      : join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

/** The FIRST text part of the LAST user message — the only raw text Jev ever sees. */
function lastUserText(parsed: JsonRecord): string {
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part): part is JsonRecord & { text: string } =>
            isRecord(part) && part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
      if (text !== "") return text;
    }
  }
  return "";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: JsonRecord): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
