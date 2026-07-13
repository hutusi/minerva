import { describe, expect, test } from "bun:test";
import { splitModelRef } from "../src/model-ref";

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
