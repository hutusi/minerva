import type { ConfigSetModelParams } from "@minerva/protocol";

export interface ConfigFormInput {
  /** Effective provider name (builtin selection or trimmed custom name). */
  providerName: string;
  isCustom: boolean;
  /** Trimmed; only meaningful for custom providers. */
  baseUrl: string;
  /** Trimmed; empty = keep the existing env/stored key. */
  apiKey: string;
  /** Trimmed model input; may contain slashes or a pasted full ref. */
  model: string;
}

/**
 * Build the config/set_model params. The ref is ALWAYS qualified with the
 * selected provider (TUI parity) — no slash-sniffing, since a slash inside
 * the model id is legitimate. A pasted full ref for the selected provider is
 * tolerated by stripping its own prefix first. Custom providers persist
 * `requiresApiKey: apiKey !== ""` (also TUI parity), so a keyless endpoint
 * is recorded as such instead of defaulting to key-required.
 */
export function buildSetModelParams(input: ConfigFormInput): ConfigSetModelParams {
  const model = input.model.startsWith(`${input.providerName}/`)
    ? input.model.slice(input.providerName.length + 1)
    : input.model;
  return {
    modelRef: `${input.providerName}/${model}`,
    ...(input.isCustom
      ? {
          provider: {
            name: input.providerName,
            baseUrl: input.baseUrl,
            requiresApiKey: input.apiKey !== "",
          },
        }
      : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
  };
}
