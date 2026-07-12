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

/**
 * Request (true) or suppress (false) model thinking. A single boolean applies
 * to every model on the provider; a map lets one provider host model families
 * with opposite defaults (e.g. bailian's Qwen wants true, its GLM wants false).
 * Map keys are model-id patterns with `*` wildcards, e.g. `{ "qwen-*": true }`.
 */
export type ThinkingConfig = boolean | Record<string, boolean>;

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
  /**
   * Per-provider or per-model thinking toggle; unset sends nothing.
   * OpenAI-compatible endpoints only (enable_thinking in the request body).
   */
  thinking?: ThinkingConfig | undefined;
  /** Context window (tokens) of the provider's models; feeds auto-compaction.
   * A per-provider single number — override in settings when a model differs. */
  contextWindow?: number | undefined;
}

export type ProviderRegistry = Record<string, ProviderDef>;

export const BUILTIN_PROVIDERS: ProviderRegistry = {
  anthropic: {
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    contextWindow: 200_000,
  },
  openai: {
    kind: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: DEFAULT_OPENAI_MODEL,
    contextWindow: 200_000,
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
    contextWindow: 131_072,
  },
  // Local Ollama via its OpenAI-compatible endpoint. Keyless by default; no
  // defaultModel/models (whatever is pulled locally is unknowable here) and no
  // contextWindow (it varies per pulled model, so auto-compaction stays inert
  // until providers.ollama.contextWindow is set in settings).
  ollama: {
    kind: "openai-compatible",
    apiKeyEnv: "OLLAMA_API_KEY",
    baseURL: "http://localhost:11434/v1",
    requiresApiKey: false,
  },
};

/** A provider entry as written in settings.json. */
export interface CustomProviderConfig {
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  defaultModel?: string | undefined;
  models?: string[] | undefined;
  requiresApiKey?: boolean | undefined;
  thinking?: ThinkingConfig | undefined;
  contextWindow?: number | undefined;
}

/**
 * Resolve a per-model thinking decision. A boolean applies to every model; a
 * map resolves by the most specific matching key — an exact model id wins,
 * else the longest matching `*`-wildcard pattern (ties broken by insertion
 * order). No match returns undefined, which sends nothing to the endpoint.
 */
export function resolveThinking(
  thinking: ThinkingConfig | undefined,
  model: string,
): boolean | undefined {
  if (thinking === undefined || typeof thinking === "boolean") return thinking;
  if (Object.hasOwn(thinking, model)) return thinking[model];
  let best: { length: number; value: boolean } | undefined;
  for (const [pattern, value] of Object.entries(thinking)) {
    if (!pattern.includes("*") || !matchesPattern(pattern, model)) continue;
    // Specificity ≈ non-wildcard characters; longest wins, first on ties.
    const length = pattern.replaceAll("*", "").length;
    if (!best || length > best.length) best = { length, value };
  }
  return best?.value;
}

function matchesPattern(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

// Names must survive ref parsing ("name/model") and env-var derivation.
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// The AI SDK's own providerOptions-namespace transform (copied — it isn't
// exported). Keying options by the camelCased name avoids the deprecation
// warning it logs for dash/underscore-containing raw keys.
function toCamelCase(name: string): string {
  return name.replace(/[_-]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

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
      // Anthropic thinking needs signature-carrying reasoning replayed on
      // tool loops — unsupported here, so fail at startup, not mid-turn.
      if (config.thinking !== undefined && builtin.kind !== "openai-compatible") {
        throw new Error(
          `provider "${name}": thinking is only supported for OpenAI-compatible providers`,
        );
      }
      registry[name] = {
        ...builtin,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
        ...(config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {}),
        ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
        ...(config.models !== undefined ? { models: config.models } : {}),
        ...(config.requiresApiKey !== undefined ? { requiresApiKey: config.requiresApiKey } : {}),
        ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
        ...(config.contextWindow !== undefined
          ? { contextWindow: validContextWindow(name, config.contextWindow) }
          : {}),
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
      ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
      ...(config.contextWindow !== undefined
        ? { contextWindow: validContextWindow(name, config.contextWindow) }
        : {}),
    };
  }
  return registry;
}

/** A garbage contextWindow would silently arm (or disarm) auto-compaction. */
function validContextWindow(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`provider "${name}": contextWindow must be a positive number of tokens`);
  }
  return value;
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
  /** Override the HTTP client (openai-compatible only); for tests. */
  fetch?: typeof globalThis.fetch;
}

export function createProviderFromRef(
  ref: string,
  options: ProviderFromRefOptions = {},
): ModelProvider {
  const providers = options.providers ?? BUILTIN_PROVIDERS;
  const { provider, model } = parseModelRef(ref, providers);
  const def = providerDef(provider, providers);
  // Streaming providers close over their config, so a spread-copy with the
  // window attached is safe (no `this` in streamTurn).
  const withWindow = (created: ModelProvider): ModelProvider =>
    def.contextWindow !== undefined ? { ...created, contextWindow: def.contextWindow } : created;
  switch (def.kind) {
    case "openai": {
      const openai = createOpenAI({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(def.baseURL ? { baseURL: def.baseURL } : {}),
      });
      const modelId = model || DEFAULT_OPENAI_MODEL;
      return withWindow(createAiSdkProvider(openai(modelId), `${provider}/${modelId}`));
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
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      // Unknown providerOptions keys are spread verbatim into the request
      // body; enable_thinking asks DashScope-style servers to emit
      // reasoning_content (they require streaming for it, which we always
      // do). The namespace is the camelCased provider name: the AI SDK spreads
      // both the raw and camelCased keys but warns (console.warn, which also
      // corrupts the Ink TUI) when a dash/underscore raw key is present.
      const thinking = resolveThinking(def.thinking, model);
      return withWindow(
        createAiSdkProvider(compatible(model), `${provider}/${model}`, {
          ...(thinking !== undefined
            ? { providerOptions: { [toCamelCase(provider)]: { enable_thinking: thinking } } }
            : {}),
        }),
      );
    }
    default: {
      const modelId = model || DEFAULT_ANTHROPIC_MODEL;
      return withWindow(
        createAnthropicProvider({
          model: modelId,
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          ...(def.baseURL ? { baseURL: def.baseURL } : {}),
        }),
      );
    }
  }
}
