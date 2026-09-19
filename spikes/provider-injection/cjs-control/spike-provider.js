// Spike A, module-format negative control — identical ESM content to
// built-style/spike-provider.js, but with NO adjacent package.json. The
// nearest package.json is the repo root (no "type" field -> CommonJS).
// If this fails to load while built-style/spike-provider.js succeeds, the
// adjacent {"type": "module"} is proven load-bearing for .js entry files.

export const SpikeProviderPlugin = async () => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider["codriver"] = {
        name: "Codriver",
        npm: "@ai-sdk/openai-compatible",
        options: {
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
