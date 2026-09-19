/**
 * The synthetic model the config hook injects and the chat.message hook
 * (todo 9) rewrites. Shared by both hooks.
 *
 * Lives in its own module on purpose: the opencode plugin loader treats
 * EVERY module export value as a plugin and throws `Plugin export is not a
 * function` on non-function exports (spike A), so index.ts may export only
 * the plugin function itself.
 */
export interface AutoModel {
  readonly providerID: string;
  readonly modelID: string;
}

export const AUTO_MODEL: AutoModel = {
  providerID: "codriver",
  modelID: "auto",
};
