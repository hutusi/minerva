import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAiSdkProvider, createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./ai-sdk";
import type { ModelProvider } from "./types";

/**
 * Model references select both provider and model: "openai/gpt-5.2",
 * "bailian/qwen-plus". A bare model id defaults to Anthropic, keeping
 * slice-1 invocations (--model claude-opus-4-8) working.
 *
 * Providers are a registry: built-ins plus user-defined OpenAI-compatible
 * endpoints from settings (see buildProviderRegistry).
 */

export const DEFAULT_OPENAI_MODEL = "gpt-5.2";

export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

export interface ProviderDef {
  kind: ProviderKind;
  /** Environment variable consulted for the API key, e.g. DASHSCOPE_API_KEY. */
  apiKeyEnv: string;
  /** Endpoint; required for openai-compatible, optional override for the rest. */
  baseURL?: string | undefined;
  /** Prefill for the config panel; never used to complete bare refs. */
  defaultModel?: string | undefined;
  /** Known model ids — config-panel suggestions, never a restriction. */
  models?: string[] | undefined;
  /** false = the endpoint needs no key (e.g. a local server). Default true. */
  requiresApiKey?: boolean | undefined;
}

export type ProviderRegistry = Record<string, ProviderDef>;

export const BUILTIN_PROVIDERS: ProviderRegistry = {
  anthropic: {
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
  },
  openai: {
    kind: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  // Alibaba Bailian (DashScope), OpenAI-compatible mode. China endpoint;
  // override baseUrl in settings for dashscope-intl.aliyuncs.com. Bailian
  // hosts third-party models too (e.g. Zhipu's GLM), hence the mixed list.
  bailian: {
    kind: "openai-compatible",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "glm-5.2"],
  },
};

/** A provider entry as written in settings.json. */
export interface CustomProviderConfig {
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  defaultModel?: string | undefined;
  models?: string[] | undefined;
  requiresApiKey?: boolean | undefined;
}

// Names must survive ref parsing ("name/model") and env-var derivation.
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Merge user-defined providers over the built-ins. Overriding a built-in
 * keeps its kind (an endpoint override must not change the wire protocol);
 * a new name defines an OpenAI-compatible provider and requires a baseUrl.
 */
export function buildProviderRegistry(
  custom?: Record<string, CustomProviderConfig>,
): ProviderRegistry {
  const registry: ProviderRegistry = { ...BUILTIN_PROVIDERS };
  for (const [name, config] of Object.entries(custom ?? {})) {
    const builtin = BUILTIN_PROVIDERS[name];
    if (builtin) {
      registry[name] = {
        ...builtin,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
        ...(config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {}),
        ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
        ...(config.models !== undefined ? { models: config.models } : {}),
        ...(config.requiresApiKey !== undefined ? { requiresApiKey: config.requiresApiKey } : {}),
      };
      continue;
    }
    if (!PROVIDER_NAME_PATTERN.test(name)) {
      throw new Error(
        `invalid provider name "${name}" — use lowercase letters, digits, and dashes`,
      );
    }
    if (!config.baseUrl) {
      throw new Error(`custom provider "${name}" needs a baseUrl (an OpenAI-compatible endpoint)`);
    }
    registry[name] = {
      kind: "openai-compatible",
      apiKeyEnv: config.apiKeyEnv ?? `${name.toUpperCase().replaceAll("-", "_")}_API_KEY`,
      baseURL: config.baseUrl,
      ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
      ...(config.models !== undefined ? { models: config.models } : {}),
      ...(config.requiresApiKey !== undefined ? { requiresApiKey: config.requiresApiKey } : {}),
    };
  }
  return registry;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export function parseModelRef(
  ref: string,
  providers: ProviderRegistry = BUILTIN_PROVIDERS,
): ModelRef {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    // "--model openai" would otherwise become an Anthropic model literally
    // named "openai" and fail confusingly at request time.
    if (providers[ref]) {
      throw new Error(`"${ref}" is a provider, not a model — use ${ref}/<model-id>`);
    }
    return { provider: "anthropic", model: ref };
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (!providers[provider]) {
    throw new Error(
      `unknown provider "${provider}" — supported: ${Object.keys(providers).join(", ")}`,
    );
  }
  if (!model) {
    throw new Error(`model reference "${ref}" is missing a model id`);
  }
  return { provider, model };
}

function providerDef(provider: string, providers: ProviderRegistry): ProviderDef {
  const def = providers[provider];
  if (!def) {
    throw new Error(
      `unknown provider "${provider}" — supported: ${Object.keys(providers).join(", ")}`,
    );
  }
  return def;
}

/** The environment variable holding the API key for a provider. */
export function apiKeyEnvVar(
  provider: string,
  providers: ProviderRegistry = BUILTIN_PROVIDERS,
): string {
  return providerDef(provider, providers).apiKeyEnv;
}

export interface ResolveApiKeyOptions {
  /** Key passed programmatically (e.g. just entered in the config panel). */
  explicit?: string | undefined;
  env?: Record<string, string | undefined>;
  /** Keys persisted in global settings, by provider name. */
  storedKeys?: Record<string, string | undefined>;
}

/**
 * Precedence: explicit > provider's env var > key stored in settings.
 * Blank (empty/whitespace) values count as absent at every level — an
 * exported-but-empty env var must not mask a stored key.
 */
export function resolveApiKey(
  provider: string,
  providers: ProviderRegistry,
  options: ResolveApiKeyOptions = {},
): string | undefined {
  const def = providerDef(provider, providers);
  const env = options.env ?? process.env;
  return (
    nonBlank(options.explicit) ??
    nonBlank(env[def.apiKeyEnv]) ??
    nonBlank(options.storedKeys?.[provider])
  );
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

export interface ProviderFromRefOptions {
  apiKey?: string;
  providers?: ProviderRegistry;
}

export function createProviderFromRef(
  ref: string,
  options: ProviderFromRefOptions = {},
): ModelProvider {
  const providers = options.providers ?? BUILTIN_PROVIDERS;
  const { provider, model } = parseModelRef(ref, providers);
  const def = providerDef(provider, providers);
  switch (def.kind) {
    case "openai": {
      const openai = createOpenAI({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(def.baseURL ? { baseURL: def.baseURL } : {}),
      });
      const modelId = model || DEFAULT_OPENAI_MODEL;
      return createAiSdkProvider(openai(modelId), `${provider}/${modelId}`);
    }
    case "openai-compatible": {
      if (!def.baseURL) {
        throw new Error(`provider "${provider}" needs a baseUrl`);
      }
      const compatible = createOpenAICompatible({
        name: provider,
        baseURL: def.baseURL,
        // DashScope and most compatible endpoints only report token usage
        // on streams when explicitly asked (stream_options.include_usage).
        includeUsage: true,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      });
      return createAiSdkProvider(compatible(model), `${provider}/${model}`);
    }
    default: {
      const modelId = model || DEFAULT_ANTHROPIC_MODEL;
      return createAnthropicProvider({
        model: modelId,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(def.baseURL ? { baseURL: def.baseURL } : {}),
      });
    }
  }
}
