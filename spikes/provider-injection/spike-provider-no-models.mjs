// Spike A, failure QA variant 2 — provider injected WITHOUT the `models` map.
// Probes the real validation boundary: a config provider with zero models is
// registered in the provider list but contributes no enumerable model lines,
// making it invisible to `opencode models` and the TUI picker.

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
      }
    },
  }
}
