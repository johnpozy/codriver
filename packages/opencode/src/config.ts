/**
 * The opencode `config` hook: inject the synthetic `codriver` provider with
 * its `auto` model so the user can pick "Auto" in the model picker.
 *
 * Contract (spike A, docs/notes/spike-a.md — verified against opencode
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
import { loadConfig, type EnvLike } from "codriver";
import { AUTO_MODEL } from "./auto.js";

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
  };
  models: Record<string, AutoProviderModel>;
}

export interface AutoConfig {
  provider?: Record<string, AutoProvider>;
}

/** Display name of the injected model. */
const AUTO_MODEL_NAME = "Auto — routed by Codriver";

/** One-time warn guard: config-load failures must never throw, and must not spam. */
let warned = false;

/**
 * Inject the `codriver` provider + `auto` model into `cfg` in place.
 *
 * Gating: only when the codriver config (todo 5's `loadConfig`) has ≥1
 * fleet entry. A missing or malformed config file yields no fleet → no
 * injection. A schema-violating config throws `ConfigError` → caught below
 * → no injection. ANY failure = no injection, one-time warn, never throw.
 *
 * Idempotent: an already-injected `cfg.provider.codriver` is left alone.
 * Never touches `cfg.model` or any user default; never reads an API key.
 */
export function injectAuto(cfg: AutoConfig, env: EnvLike): void {
  try {
    if (cfg.provider?.[AUTO_MODEL.providerID] !== undefined) return;
    const config = loadConfig(env);
    if (config.fleet.length < 1) return;
    cfg.provider ??= {};
    cfg.provider[AUTO_MODEL.providerID] = {
      name: "Codriver",
      npm: "@ai-sdk/openai-compatible",
      options: {
        // Dummy endpoint on port 9 (discard): proven safe by spike A —
        // registration is lazy, enumeration never dials it.
        baseURL: "http://127.0.0.1:9/v1",
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
