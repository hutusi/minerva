import { describe, expect, test } from "bun:test";
import { apiKeyEnvVar, createProviderFromRef, parseModelRef } from "../src";

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
  });

  test("unknown providers and empty models are rejected", () => {
    expect(() => parseModelRef("mistral/large")).toThrow("unknown provider");
    expect(() => parseModelRef("openai/")).toThrow("missing a model id");
  });

  test("a bare provider name is rejected with a hint", () => {
    expect(() => parseModelRef("openai")).toThrow("openai/<model-id>");
    expect(() => parseModelRef("anthropic")).toThrow("anthropic/<model-id>");
  });

  test("createProviderFromRef builds ids with the provider prefix", () => {
    expect(createProviderFromRef("openai/gpt-5.2", { apiKey: "sk-test" }).id).toBe(
      "openai/gpt-5.2",
    );
    expect(createProviderFromRef("claude-opus-4-8", { apiKey: "sk-test" }).id).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  test("each provider maps to its key env var", () => {
    expect(apiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
  });
});
