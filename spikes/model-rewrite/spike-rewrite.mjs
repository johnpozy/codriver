// Spike B plugin — hardcoded chat.message model rewrite (codriver/auto -> mockllm/mock-model).
// Investigative proof only: no Jev call, no logging, no config hook.
// Loaded via the "plugin": ["./spike-rewrite.mjs"] entry in the adjacent opencode.json
// (legacy v1 plugin format: each export is a plugin function returning a hooks object).
export const SpikeRewrite = async () => ({
  "chat.message": async (_input, output) => {
    if (output.message.model?.modelID === "auto") {
      output.message.model = { providerID: "mockllm", modelID: "mock-model" }
    }
  },
})
