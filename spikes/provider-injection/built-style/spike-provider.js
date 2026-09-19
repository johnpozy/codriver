// Spike A, experiment 2 — same injection as spike-provider.mjs, but as a
// built-style `.js` file: module-ness must come from the adjacent
// package.json {"type": "module"} (what a tsc/bun build emitting .js would
// ship). Records whether the opencode plugin loader (Bun `import()` of the
// file:// entry URL) honors package.json module resolution for a `.js` file.
// This decides the dist entry extension for todos 1/13.

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
