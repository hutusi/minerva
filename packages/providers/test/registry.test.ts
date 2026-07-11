import { describe, expect, test } from "bun:test";
import {
  apiKeyEnvVar,
  buildProviderRegistry,
  createProviderFromRef,
  parseModelRef,
  resolveApiKey,
  type TurnEvent,
} from "../src";

/** A minimal OpenAI-style streaming response: one content delta, then done. */
function sseResponse(): Response {
  const body =
    'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drain(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** A capturing fetch that records the parsed request body, then streams a
 * canned response. Cast to the full fetch type (the SDK wants preconnect). */
function capturingFetch(onBody: (body: Record<string, unknown>) => void): typeof globalThis.fetch {
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    onBody(JSON.parse(init?.body as string));
    return sseResponse();
  };
  return impl as unknown as typeof globalThis.fetch;
}

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
      models: ["qwen-plus", "qwen-max", "qwen-turbo", "glm-5.2"],
    });
  });

  test("bailian lists glm-5.2 among known models, and refs to it resolve", () => {
    const providers = buildProviderRegistry();
    expect(providers.bailian?.models).toContain("glm-5.2");
    expect(createProviderFromRef("bailian/glm-5.2", { providers, apiKey: "sk-test" }).id).toBe(
      "bailian/glm-5.2",
    );
  });

  test("settings can replace a builtin's known-models list", () => {
    const providers = buildProviderRegistry({ bailian: { models: ["glm-5.2"] } });
    expect(providers.bailian?.models).toEqual(["glm-5.2"]);
  });

  test("a custom provider without a baseUrl is rejected", () => {
    expect(() => buildProviderRegistry({ deepseek: {} })).toThrow("needs a baseUrl");
  });

  test("thinking flag is carried for openai-compatible providers", () => {
    const providers = buildProviderRegistry({
      bailian: { thinking: true },
      "my-proxy": { baseUrl: "https://llm.example.com/v1", thinking: false },
    });
    expect(providers.bailian?.thinking).toBe(true);
    expect(providers["my-proxy"]?.thinking).toBe(false);
    // The flag must not break provider construction.
    expect(createProviderFromRef("bailian/qwen-plus", { providers, apiKey: "sk-test" }).id).toBe(
      "bailian/qwen-plus",
    );
  });

  test("the thinking flag reaches the request body as enable_thinking", async () => {
    let body: Record<string, unknown> | undefined;
    const providers = buildProviderRegistry({ bailian: { thinking: true } });
    const provider = createProviderFromRef("bailian/qwen-plus", {
      providers,
      apiKey: "sk-test",
      fetch: capturingFetch((b) => {
        body = b;
      }),
    });

    const events = await drain(
      provider.streamTurn({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    );

    // The seam createProviderFromRef builds — namespace key + body key — must
    // actually put enable_thinking on the wire, and streaming must still work.
    expect(body?.enable_thinking).toBe(true);
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  });

  test("a dash-named provider's thinking reaches the body without a deprecation warning", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      let body: Record<string, unknown> | undefined;
      const providers = buildProviderRegistry({
        "my-proxy": { baseUrl: "https://llm.example.com/v1", thinking: false },
      });
      const provider = createProviderFromRef("my-proxy/some-model", {
        providers,
        apiKey: "sk-test",
        fetch: capturingFetch((b) => {
          body = b;
        }),
      });

      await drain(provider.streamTurn({ messages: [{ role: "user", content: "hi" }], tools: [] }));

      expect(body?.enable_thinking).toBe(false);
      // The AI SDK warns (via console.warn, which corrupts the Ink TUI) when a
      // dash-containing raw providerOptions key is present; the camelCased key
      // must avoid it.
      expect(warnings.join("\n")).not.toContain("providerOptions key");
    } finally {
      console.warn = original;
    }
  });

  test("thinking is rejected for non-openai-compatible providers", () => {
    expect(() => buildProviderRegistry({ anthropic: { thinking: true } })).toThrow(
      "only supported for OpenAI-compatible",
    );
    // false is still a request to control thinking — same guard.
    expect(() => buildProviderRegistry({ openai: { thinking: false } })).toThrow(
      "only supported for OpenAI-compatible",
    );
  });

  test("invalid provider names are rejected", () => {
    expect(() => buildProviderRegistry({ "Bad Name": { baseUrl: "https://x" } })).toThrow(
      "invalid provider name",
    );
    expect(() => buildProviderRegistry({ "1x": { baseUrl: "https://x" } })).toThrow(
      "invalid provider name",
    );
  });

  test("blank keys count as absent — an empty env var must not mask a stored key", () => {
    const providers = buildProviderRegistry();
    const storedKeys = { bailian: "from-settings" };
    expect(
      resolveApiKey("bailian", providers, { env: { DASHSCOPE_API_KEY: "" }, storedKeys }),
    ).toBe("from-settings");
    expect(
      resolveApiKey("bailian", providers, { env: { DASHSCOPE_API_KEY: "   " }, storedKeys }),
    ).toBe("from-settings");
    expect(
      resolveApiKey("bailian", providers, { explicit: "", env: { DASHSCOPE_API_KEY: "from-env" } }),
    ).toBe("from-env");
    expect(
      resolveApiKey("bailian", providers, { env: {}, storedKeys: { bailian: "" } }),
    ).toBeUndefined();
  });

  test("custom providers can declare keyless endpoints", () => {
    const providers = buildProviderRegistry({
      ollama: { baseUrl: "http://localhost:11434/v1", requiresApiKey: false },
    });
    expect(providers.ollama?.requiresApiKey).toBe(false);
    // Unset means required — the safe default.
    expect(buildProviderRegistry().bailian?.requiresApiKey).toBeUndefined();
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
