import { describe, expect, test } from "bun:test";
import {
  apiKeyEnvVar,
  buildProviderRegistry,
  createProviderFromRef,
  parseModelRef,
  resolveApiKey,
} from "../src";

describe("model references", () => {
  test("bare model ids default to anthropic", () => {
    expect(parseModelRef("claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  test("provider/model refs parse", () => {
    expect(parseModelRef("openai/gpt-5.2")).toEqual({ provider: "openai", model: "gpt-5.2" });
    expect(parseModelRef("anthropic/claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(parseModelRef("bailian/qwen-plus")).toEqual({
      provider: "bailian",
      model: "qwen-plus",
    });
  });

  test("unknown providers and empty models are rejected", () => {
    expect(() => parseModelRef("mistral/large")).toThrow("unknown provider");
    expect(() => parseModelRef("mistral/large")).toThrow("bailian");
    expect(() => parseModelRef("openai/")).toThrow("missing a model id");
  });

  test("a bare provider name is rejected with a hint", () => {
    expect(() => parseModelRef("openai")).toThrow("openai/<model-id>");
    expect(() => parseModelRef("anthropic")).toThrow("anthropic/<model-id>");
    expect(() => parseModelRef("bailian")).toThrow("bailian/<model-id>");
  });

  test("custom registry providers parse in refs", () => {
    const providers = buildProviderRegistry({
      deepseek: { baseUrl: "https://api.deepseek.com/v1" },
    });
    expect(parseModelRef("deepseek/deepseek-chat", providers)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(() => parseModelRef("deepseek", providers)).toThrow("deepseek/<model-id>");
  });

  test("createProviderFromRef builds ids with the provider prefix", () => {
    expect(createProviderFromRef("openai/gpt-5.2", { apiKey: "sk-test" }).id).toBe(
      "openai/gpt-5.2",
    );
    expect(createProviderFromRef("claude-opus-4-8", { apiKey: "sk-test" }).id).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(createProviderFromRef("bailian/qwen-plus", { apiKey: "sk-test" }).id).toBe(
      "bailian/qwen-plus",
    );
  });

  test("each provider maps to its key env var", () => {
    expect(apiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvVar("bailian")).toBe("DASHSCOPE_API_KEY");
  });
});

describe("provider registry", () => {
  test("custom providers default kind, apiKeyEnv, and merge over builtins", () => {
    const providers = buildProviderRegistry({
      "my-proxy": { baseUrl: "https://llm.example.com/v1", defaultModel: "some-model" },
    });
    expect(providers["my-proxy"]).toEqual({
      kind: "openai-compatible",
      apiKeyEnv: "MY_PROXY_API_KEY",
      baseURL: "https://llm.example.com/v1",
      defaultModel: "some-model",
    });
  });

  test("overriding a builtin keeps its kind (intl bailian endpoint)", () => {
    const providers = buildProviderRegistry({
      bailian: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    });
    expect(providers.bailian).toEqual({
      kind: "openai-compatible",
      apiKeyEnv: "DASHSCOPE_API_KEY",
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen-plus",
    });
  });

  test("a custom provider without a baseUrl is rejected", () => {
    expect(() => buildProviderRegistry({ deepseek: {} })).toThrow("needs a baseUrl");
  });

  test("invalid provider names are rejected", () => {
    expect(() => buildProviderRegistry({ "Bad Name": { baseUrl: "https://x" } })).toThrow(
      "invalid provider name",
    );
    expect(() => buildProviderRegistry({ "1x": { baseUrl: "https://x" } })).toThrow(
      "invalid provider name",
    );
  });

  test("resolveApiKey precedence: explicit > env > stored", () => {
    const providers = buildProviderRegistry();
    const env = { DASHSCOPE_API_KEY: "from-env" };
    const storedKeys = { bailian: "from-settings" };
    expect(resolveApiKey("bailian", providers, { explicit: "from-panel", env, storedKeys })).toBe(
      "from-panel",
    );
    expect(resolveApiKey("bailian", providers, { env, storedKeys })).toBe("from-env");
    expect(resolveApiKey("bailian", providers, { env: {}, storedKeys })).toBe("from-settings");
    expect(resolveApiKey("bailian", providers, { env: {} })).toBeUndefined();
    expect(() => resolveApiKey("nope", providers, { env: {} })).toThrow("unknown provider");
  });
});
