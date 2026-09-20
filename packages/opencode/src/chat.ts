/**
 * The opencode `chat.message` hook: rewrite the synthetic `codriver/auto`
 * model on the outgoing user message to the concrete model the routing
 * core picked for this turn.
 *
 * Contract (spike B — verified against opencode
 * v1.18.31): the hook fires inside createUserMessage AFTER part resolution
 * and BEFORE the message is persisted, so mutating `output.message.model`
 * survives and drives the session loop. The rewritten model is EXACTLY
 * `{ providerID, modelID }` — `variant` omitted (both forms survive
 * persistence; omitted is the committed contract).
 *
 * Never-leave-auto invariant: every code path rewrites the message model
 * to a concrete decision model EXCEPT the two documented passthroughs —
 * the `no-targets` terminal (nothing routable exists at all) and a catch
 * with no fallback target — where `codriver/auto` is left in place and the
 * degradation is logged loudly. Leaving auto anywhere else would surface a
 * provider connection error downstream: the synthetic provider has no
 * backend (spike B negative control).
 */
import {
  DEFAULT_ROUTE_THRESHOLD,
  DEFAULT_ROUTE_TIMEOUT_MS,
  FixtureJevClient,
  HttpJevClient,
  jevMode,
  loadConfig,
  logDecision,
  route,
  splitModelId,
  type CodriverConfig,
  type JevClient,
} from "@johnpozy/codriver";
import { AUTO_MODEL } from "./auto.js";
import { stashedConfig, type AutoConfig } from "./config.js";
import { proxyModeActive } from "./gateway.js";

/** Minimal structural view of the chat.message hook input (spike B). */
export interface ChatMessageInput {
  readonly agent?: string;
}

/** Minimal structural view of the chat.message hook output (spike B). */
export interface ChatMessageOutput {
  readonly message: {
    model?: { providerID?: string; modelID?: string };
  };
  readonly parts: ReadonlyArray<{ type?: string; text?: string }>;
}

/** The wired hook: async because the host awaits it (no async leak). */
export type ChatMessageHandler = (
  input: ChatMessageInput,
  output: ChatMessageOutput,
) => Promise<void>;

/** Test seam: bypass env-based client selection with a fixed client. */
export interface ChatMessageDeps {
  readonly client?: JevClient;
}

/**
 * Derive the catalog of models the host can actually route to this turn:
 * one "providerID/modelID" per cfg.provider model entry. The synthetic
 * `codriver` provider itself is EXCLUDED — the sentinel is never a
 * routable target (routing to it would loop back into auto).
 */
export function validCatalogFromConfig(cfg: AutoConfig): Set<string> {
  const catalog = new Set<string>();
  for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
    if (providerID === AUTO_MODEL.providerID) continue;
    if (provider?.models === undefined || provider.models === null) continue;
    for (const modelID of Object.keys(provider.models)) {
      catalog.add(`${providerID}/${modelID}`);
    }
  }
  return catalog;
}

/** The current user message text, else "" — the only raw text Jev ever sees.
 * We take the LAST text part because opencode passes the full conversation
 * parts array, and the current turn is the final user message. */
function currentTextPart(parts: ChatMessageOutput["parts"]): string {
  let text = "";
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") text = part.text;
  }
  return text;
}

/**
 * Build the chat.message hook. The wired plugin passes no deps: the Jev
 * client is selected per turn from env (fixture when forced OR keyless —
 * the mock-first gate), and the config is re-loaded from disk at hook time
 * so an emptied fleet is observable on the very next turn.
 *
 * Routing gate: the hook routes the Auto sentinel and any model already in
 * the configured fleet. The latter handles opencode carrying the previous
 * turn's concrete model forward into the next message. A model outside the
 * fleet is treated as an explicit user choice and left untouched.
 *
 * Proxy mode (upstream env var set, or a fleet entry prefixed with a
 * builtin gateway name): this hook no-ops entirely. The message model stays
 * codriver/auto (the TUI indicator stays on Auto) and the loopback gateway
 * owns all routing when the request arrives.
 */
export function createChatMessageHandler(deps: ChatMessageDeps = {}): ChatMessageHandler {
  return async (input, output) => {
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

    if (proxyModeActive(process.env, config)) return;

    const cfg = stashedConfig();
    const catalog = cfg !== undefined ? validCatalogFromConfig(cfg) : new Set<string>();
    for (const entry of config.fleet) {
      catalog.add(entry.id);
    }

    const current = output.message.model;
    const currentId =
      current?.providerID !== undefined && current?.modelID !== undefined
        ? `${current.providerID}/${current.modelID}`
        : undefined;
    const isAuto =
      current?.providerID === AUTO_MODEL.providerID &&
      current?.modelID === AUTO_MODEL.modelID;
    if (!isAuto && (currentId === undefined || !catalog.has(currentId))) {
      return;
    }

    try {
      // (4) Mock-first client selection: fixture when forced OR keyless —
      // the plugin works end-to-end keyless.
      const useFixture = jevMode(process.env) === "fixture" || !process.env.TYPESAFE_API_KEY;
      const client: JevClient =
        deps.client ?? (useFixture ? new FixtureJevClient() : new HttpJevClient());

      // (5) route() ALWAYS returns a concrete decision and supersedes
      // stateInput.catalog with the fleet it derives from
      // config.fleet ∩ catalog — passing `catalog: []` here is intentional.
      const decision = await route({
        config,
        catalog,
        client,
        stateInput: {
          agent: input.agent ?? "unknown",
          text: currentTextPart(output.parts),
          catalog: [],
        },
      });

      // (6) The rewrite follows the decision on EVERY path except the sole
      // documented exception: the no-targets passthrough leaves the message
      // model untouched (opencode surfaces a model error for the turn
      // without corrupting state).
      if (decision.reason === "no-targets") {
        console.warn(
          "codriver: no routable model for this turn (empty fleet, no fallback) — leaving codriver/auto in place",
        );
      } else {
        output.message.model = {
          providerID: decision.model.providerID,
          modelID: decision.model.modelID,
        };
      }

      // (7) Fire-and-forget decision log (sync, never throws).
      logDecision(decision, {
        agent: input.agent ?? "unknown",
        config: { log_path: config.log_path },
      });
    } catch (error) {
      // (8) Last resort, without assuming config loaded: rewrite to the
      // fallback target if one exists at all; otherwise mirror the
      // no-targets passthrough. Never throws, never writes a string or
      // undefined into the model slot (splitModelId always returns the
      // {providerID, modelID} object).
      const target = config?.fallback ?? config?.fleet?.[0]?.id;
      if (target !== undefined) {
        output.message.model = splitModelId(target);
      } else {
        console.warn(
          `codriver: chat.message routing failed with no fallback target — leaving codriver/auto in place: ${String(error)}`,
        );
      }
    }
  };
}
