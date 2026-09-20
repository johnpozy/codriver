import { injectAuto, stashConfig, type AutoConfig } from "./config.js";
import { createChatMessageHandler } from "./chat.js";
import { startGateway } from "./gateway.js";

/**
 * Codriver opencode plugin — legacy v1 format (spike A, verified against
 * opencode v1.18.31): EXACTLY ONE export, an async function returning the
 * hooks object. The loader treats every module export value as a plugin
 * and throws `Plugin export is not a function` on non-function exports, so
 * AUTO_MODEL lives in ./auto.js, not here.
 */
export const CodriverPlugin = async () => {
  // The gateway must be up before the config hook injects the provider
  // baseURL: in proxy mode codriver/auto points at this loopback server.
  try {
    await startGateway();
  } catch (error) {
    console.warn(`codriver: gateway failed to start — proxy mode unavailable: ${String(error)}`);
  }
  return {
    config: async (cfg: AutoConfig) => {
      // Stash FIRST, unconditionally — before any gating or try-catch: the
      // chat.message hook receives no cfg parameter and reads the stash to
      // derive the per-turn catalog.
      stashConfig(cfg);
      injectAuto(cfg, process.env);
    },
    "chat.message": createChatMessageHandler(),
  };
};
