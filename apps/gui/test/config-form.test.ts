import { describe, expect, test } from "bun:test";
import { buildSetModelParams, splitModelRef } from "../src/lib/config-form";

describe("splitModelRef", () => {
  test("splits on the FIRST slash — model ids may contain slashes", () => {
    expect(splitModelRef("openrouter/meta-llama/llama-3")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3",
    });
    expect(splitModelRef("bailian/qwen-plus")).toEqual({ provider: "bailian", model: "qwen-plus" });
  });

  test("a bare id has no provider", () => {
    expect(splitModelRef("claude-opus-4-8")).toEqual({ provider: null, model: "claude-opus-4-8" });
  });
});

describe("buildSetModelParams", () => {
  test("always qualifies with the selected provider — slashes in the model survive", () => {
    expect(
      buildSetModelParams({
        providerName: "openrouter",
        isCustom: false,
        baseUrl: "",
        apiKey: "",
        model: "meta-llama/llama-3",
      }),
    ).toEqual({ modelRef: "openrouter/meta-llama/llama-3" });
  });

  test("a pasted full ref for the selected provider is not double-prefixed", () => {
    expect(
      buildSetModelParams({
        providerName: "bailian",
        isCustom: false,
        baseUrl: "",
        apiKey: "",
        model: "bailian/qwen-plus",
      }),
    ).toEqual({ modelRef: "bailian/qwen-plus" });
  });

  test("a keyed submission carries the key without a provider upsert for builtins", () => {
    expect(
      buildSetModelParams({
        providerName: "bailian",
        isCustom: false,
        baseUrl: "",
        apiKey: "sk-dashscope",
        model: "qwen-plus",
      }),
    ).toEqual({ modelRef: "bailian/qwen-plus", apiKey: "sk-dashscope" });
  });

  test("a keyless custom provider persists requiresApiKey: false", () => {
    expect(
      buildSetModelParams({
        providerName: "local-llm",
        isCustom: true,
        baseUrl: "http://localhost:8080/v1",
        apiKey: "",
        model: "llama4",
      }),
    ).toEqual({
      modelRef: "local-llm/llama4",
      provider: { name: "local-llm", baseUrl: "http://localhost:8080/v1", requiresApiKey: false },
    });
  });

  test("a keyed custom provider persists requiresApiKey: true and the key", () => {
    expect(
      buildSetModelParams({
        providerName: "acme",
        isCustom: true,
        baseUrl: "https://acme.test/v1",
        apiKey: "sk-acme",
        model: "acme-1",
      }),
    ).toEqual({
      modelRef: "acme/acme-1",
      provider: { name: "acme", baseUrl: "https://acme.test/v1", requiresApiKey: true },
      apiKey: "sk-acme",
    });
  });
});
