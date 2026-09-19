// Spike A — synthetic provider injection via the opencode `config` hook.
//
// Proves against LOCAL opencode v1.18.31 that:
//   1. a `file://` plugin in legacy v1 format (a single exported async
//      function returning a hooks object) is loaded by PluginLoader, and
//   2. its `config` hook receives the cached config object BEFORE
//      packages/opencode/src/provider/provider.ts reads `cfg.provider`
//      (see the "load plugins first so config() hook runs before reading
//      cfg.provider" comment in that file), so an in-place injected
//      provider becomes enumerable without touching the TUI.
//
// Injected shape follows the config `provider` block opencode itself parses
// in provider.ts: provider-level `npm` (falls back to
// "@ai-sdk/openai-compatible"), `options.baseURL`, and a `models` map whose
// entries need only a display `name` — every other model field has a default.

export const SpikeProviderPlugin = async () => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider["codriver"] = {
        name: "Codriver",
        npm: "@ai-sdk/openai-compatible",
        options: {
          // Dummy endpoint on port 9 (discard). Enumeration must succeed
          // without dialing it — proves registration is lazy, not eager.
          baseURL: "http://127.0.0.1:9/v1",
        },
        models: {
          auto: {
            name: "Auto",
          },
        },
      }
    },
  }
}
