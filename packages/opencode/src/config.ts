/**
 * The opencode `config` hook: inject the synthetic `codriver` provider with
 * its `auto` model so the user can pick "Auto" in the model picker.
 *
 * Contract (spike A — verified against opencode
 * v1.18.31):
 * - the hook mutates the cached cfg in place BEFORE provider.ts reads
 *   `cfg.provider`, so the injected provider becomes enumerable;
 * - the only de-facto required field is ≥1 entry in `models`; `npm` and
 *   `options.baseURL` are optional but set explicitly — the dummy port-9
 *   baseURL is proven safe because registration is lazy (the AI SDK is only
 *   instantiated at request time, never at config load);
 * - catalog validity is deliberately NOT checked here: this hook runs
 *   before provider catalog assembly. Per-turn validation and the terminal
 *   fallback live in route() (todo 6).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type CodriverConfig, type EnvLike, type FleetEntry } from "@johnpozy/codriver";
import { AUTO_MODEL } from "./auto.js";
import { gatewayUrl, proxyModeActive } from "./gateway.js";
import { stashConfig, stashedConfig } from "./stash.js";

export { stashConfig, stashedConfig } from "./stash.js";

/**
 * Minimal structural view of the opencode config object — only the fields
 * this hook touches. Deliberately NOT imported from opencode's types: the
 * adapter is loaded by opencode's plugin loader, and structural typing
 * keeps the contract explicit and dependency-free.
 */
export interface AutoProviderModel {
  name: string;
}

export interface AutoProvider {
  name: string;
  npm: string;
  options: {
    baseURL: string;
    /** A literal key, or opencode's `{env: VAR}` indirection (resolved by the gateway). */
    apiKey?: string | { env: string };
  };
  models: Record<string, AutoProviderModel>;
}

export interface AutoConfig {
  provider?: Record<string, AutoProvider>;
}

/** Display name of the injected model. */
const AUTO_MODEL_NAME = "Auto — routed by Codriver";

/**
 * Default starter fleet used when the user has no fleet and no custom
 * providers with models. opencode's config hook cannot see the built-in
 * catalog, so we seed a common coding fleet the user can edit.
 */
const DEFAULT_FLEET: CodriverConfig = {
  fleet: [
    {
      id: "vercel/anthropic/claude-sonnet-4.5",
      description: "fast everyday coding, debugging, and explanations",
      tags: ["fast", "coding"],
    },
    {
      id: "vercel/anthropic/claude-opus-4",
      description: "deep reasoning, hard refactors, architecture work",
      tags: ["hard", "reasoning"],
    },
    {
      id: "vercel/openai/gpt-5",
      description: "broad general knowledge and docs",
      tags: ["docs"],
    },
  ],
  fallback: "vercel/anthropic/claude-sonnet-4.5",
};

/**
 * Starter fleet for proxy mode: fleet ids are UPSTREAM model ids (forwarded
 * verbatim as the upstream `model` field), so provider-derived "provider/model"
 * ids and opencode-provider-prefixed defaults would be rejected by the
 * upstream. Gateway-style "provider/model" ids (e.g. Vercel AI Gateway) only.
 */
const PROXY_DEFAULT_FLEET: CodriverConfig = {
  fleet: [
    {
      id: "anthropic/claude-sonnet-4.5",
      description: "fast everyday coding, debugging, and explanations",
      tags: ["fast", "coding"],
    },
    {
      id: "anthropic/claude-opus-4",
      description: "deep reasoning, hard refactors, architecture work",
      tags: ["hard", "reasoning"],
    },
    {
      id: "openai/gpt-5",
      description: "broad general knowledge and docs",
      tags: ["docs"],
    },
  ],
  fallback: "anthropic/claude-sonnet-4.5",
};

/** One-time warn guard: config-load failures must never throw, and must not spam. */
let warned = false;

/**
 * Resolve the codriver config file path from env — mirrors the core's
 * `configPath` (see `packages/core/src/config/config.ts`). Re-implemented
 * here on purpose: the core keeps its `configPath` private, and the adapter
 * must not widen the core's public API just to write a file.
 */
function configPath(env: EnvLike): string {
  const override = env.CODRIVER_CONFIG;
  if (override !== undefined && override !== "") return override;
  // env.HOME first (Bun resolves os.homedir() at startup, ignoring later env); homedir() covers a missing HOME.
  return join(env.HOME ?? homedir(), ".config", "codriver", "config.json");
}

/**
 * Derive a codriver fleet from the opencode provider catalog (`cfg.provider`)
 * when the user has no codriver config yet. Skips the synthetic `codriver`
 * provider itself — the router must never route to itself. Each model becomes
 * `{ id: "provider/model", description: model display name or id }`; the
 * first entry becomes the `fallback`. Returns an empty fleet when the catalog
 * is empty or contains only the `codriver` provider.
 */
function bootstrapFleet(cfg: AutoConfig): CodriverConfig {
  const fleet: FleetEntry[] = [];
  for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
    if (providerID === AUTO_MODEL.providerID) continue;
    if (provider?.models === undefined || provider.models === null) continue;
    for (const [modelID, model] of Object.entries(provider.models)) {
      fleet.push({
        id: `${providerID}/${modelID}`,
        description: model.name || `${providerID}/${modelID}`,
      });
    }
  }
  return { fleet, fallback: fleet[0]?.id };
}

/**
 * Inject the `codriver` provider + `auto` model into `cfg` in place.
 *
 * Gating: only when the codriver config (todo 5's `loadConfig`) has ≥1
 * fleet entry. A missing or malformed config file yields no fleet → no
 * injection. A schema-violating config throws `ConfigError` → caught below
 * → no injection. ANY failure = no injection, one-time warn, never throw.
 *
 * Bootstrap: when the config has no fleet, derive one from `cfg.provider`
 * (the opencode provider catalog) and write it to `configPath(env)` so the
 * user can edit it. The synthetic `codriver` provider is skipped. In proxy
 * mode the starter is always the gateway-id default fleet (provider-derived
 * ids are opencode routing ids, never valid upstream model ids). If the
 * catalog yields zero usable models, no injection and no file write.
 *
 * Idempotent: an already-injected `cfg.provider.codriver` is left alone.
 * Never touches `cfg.model` or any user default; never reads an API key.
 */
export function injectAuto(cfg: AutoConfig, env: EnvLike): void {
  try {
    if (cfg.provider?.[AUTO_MODEL.providerID] !== undefined) return;
    let config = loadConfig(env);
    const proxy = proxyModeActive(env, config);
    if (config.fleet.length < 1) {
      let starter: CodriverConfig;
      if (proxy) {
        starter = PROXY_DEFAULT_FLEET;
      } else {
        const bootstrapped = bootstrapFleet(cfg);
        starter = bootstrapped.fleet.length >= 1 ? bootstrapped : DEFAULT_FLEET;
      }
      const path = configPath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(starter, null, 2) + "\n");
      console.warn(
        `codriver: created ${path} with ${starter.fleet.length} model(s). Edit it to match your available models and add descriptions/tags.`,
      );
      config = starter;
    }
    if (config.fleet.length < 1) return;
    cfg.provider ??= {};
    cfg.provider[AUTO_MODEL.providerID] = {
      name: "Codriver",
      npm: "@ai-sdk/openai-compatible",
      options: {
        // Proxy mode points at the live loopback gateway; rewrite mode keeps
        // the dummy port-9 endpoint (discard) — proven safe by spike A:
        // registration is lazy, enumeration never dials it.
        baseURL: proxy ? (gatewayUrl() ?? "http://127.0.0.1:9/v1") : "http://127.0.0.1:9/v1",
        apiKey: "codriver-local",
      },
      models: {
        [AUTO_MODEL.modelID]: { name: AUTO_MODEL_NAME },
      },
    };
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`codriver: config hook skipped Auto injection: ${String(error)}`);
    }
  }
}
