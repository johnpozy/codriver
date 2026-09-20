/**
 * The cfg stash: the config hook's opencode cfg reference, read by the
 * gateway to resolve per-prefix upstreams (custom provider baseURL/apiKey).
 *
 * Lives in its own module (not config.ts) because the gateway cannot import
 * config.ts — config.ts imports the gateway for the proxy-mode baseURL, so
 * putting the stash there would close an import cycle. The AutoConfig import
 * is type-only and erased at runtime.
 */
import type { AutoConfig } from "./config.js";

let stashed: AutoConfig | undefined;

/** Stash the cfg reference; the config hook's first, unconditional action. */
export function stashConfig(cfg: AutoConfig | undefined): void {
  stashed = cfg;
}

/** The cfg stashed by the config hook; undefined if that hook never ran. */
export function stashedConfig(): AutoConfig | undefined {
  return stashed;
}
