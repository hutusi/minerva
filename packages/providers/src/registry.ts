import { createOpenAI } from "@ai-sdk/openai";
import { createAiSdkProvider, createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./ai-sdk";
import type { ModelProvider } from "./types";

/**
 * Model references select both provider and model: "openai/gpt-5.2",
 * "anthropic/claude-opus-4-8". A bare model id defaults to Anthropic,
 * keeping slice-1 invocations (--model claude-opus-4-8) working.
 */

export const DEFAULT_OPENAI_MODEL = "gpt-5.2";

export type ProviderName = "anthropic" | "openai";

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    // "--model openai" would otherwise become an Anthropic model literally
    // named "openai" and fail confusingly at request time.
    if (ref === "anthropic" || ref === "openai") {
      throw new Error(`"${ref}" is a provider, not a model — use ${ref}/<model-id>`);
    }
    return { provider: "anthropic", model: ref };
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(`unknown provider "${provider}" — supported: anthropic, openai`);
  }
  if (!model) {
    throw new Error(`model reference "${ref}" is missing a model id`);
  }
  return { provider, model };
}

/** The environment variable holding the API key for a provider. */
export function apiKeyEnvVar(provider: ProviderName): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

export interface ProviderFromRefOptions {
  apiKey?: string;
}

export function createProviderFromRef(
  ref: string,
  options: ProviderFromRefOptions = {},
): ModelProvider {
  const { provider, model } = parseModelRef(ref);
  switch (provider) {
    case "openai": {
      const openai = createOpenAI(options.apiKey ? { apiKey: options.apiKey } : {});
      const modelId = model || DEFAULT_OPENAI_MODEL;
      return createAiSdkProvider(openai(modelId), `openai/${modelId}`);
    }
    default: {
      const modelId = model || DEFAULT_ANTHROPIC_MODEL;
      return createAnthropicProvider({ model: modelId, ...options });
    }
  }
}
