// Spike A, failure QA variant 1 — provider injected WITHOUT the `npm` field.
// Probes whether opencode rejects/strips a provider missing `npm`, or fills
// the default "@ai-sdk/openai-compatible" (provider.ts apiNpm fallback chain).

export const SpikeProviderPlugin = async () => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider["codriver"] = {
        name: "Codriver",
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
