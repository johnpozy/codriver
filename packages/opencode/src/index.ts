import { injectAuto, type AutoConfig } from "./config.js";

/**
 * Codriver opencode plugin — legacy v1 format (spike A, verified against
 * opencode v1.18.31): EXACTLY ONE export, an async function returning the
 * hooks object. The loader treats every module export value as a plugin
 * and throws `Plugin export is not a function` on non-function exports, so
 * AUTO_MODEL lives in ./auto.js, not here.
 */
export const CodriverPlugin = async () => ({
  config: async (cfg: AutoConfig) => {
    injectAuto(cfg, process.env);
  },
  "chat.message": async () => {
    // no-op placeholder — todo 9 implements the model rewrite
  },
});
