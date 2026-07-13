import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  MINERVA_METHODS,
  PROTOCOL_VERSION,
  type SessionUpdateParams,
} from "@minerva/protocol";
import type { ModelProvider, TurnEvent } from "@minerva/providers";
import { buildProviderRegistry, createScriptedProvider } from "@minerva/providers";
import {
  createKernel,
  globalSettingsPath,
  type KernelOptions,
  type MinervaSettings,
  projectDir,
} from "../src";

const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };

function textTurn(text: string): TurnEvent[] {
  return [{ type: "text-delta", text }, FINISH_STOP];
}

function scripted(id: string, turns: TurnEvent[][]): ModelProvider {
  return { ...createScriptedProvider(turns), id };
}

async function setup(options: {
  provider: ModelProvider;
  resolveProvider?: KernelOptions["resolveProvider"];
}) {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-config-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-config-data-"));
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, {
    provider: options.provider,
    dataDir,
    ...(options.resolveProvider ? { resolveProvider: options.resolveProvider } : {}),
  });
  const client = new Connection(clientTransport);
  const updates: SessionUpdateParams[] = [];
  client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
    updates.push(params as SessionUpdateParams);
  });
  await client.request(AGENT_METHODS.initialize, { protocolVersion: PROTOCOL_VERSION });
  const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
    cwd,
  });
  return { client, updates, sessionId, cwd, dataDir, kernel };
}

function agentText(updates: SessionUpdateParams[]): string {
  return updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => (u.update as { content: { text: string } }).content.text)
    .join("");
}

describe("minerva/config/set_model", () => {
  test("persists config, swaps the live provider, and logs the switch", async () => {
    const h = await setup({
      provider: scripted("anthropic/claude-opus-4-8", [textTurn("from anthropic")]),
      resolveProvider: (modelRef) => scripted(modelRef, [textTurn("from bailian")]),
    });

    await h.client.request(AGENT_METHODS.sessionPrompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    const result = await h.client.request<{ providerId: string }>(MINERVA_METHODS.configSetModel, {
      modelRef: "bailian/qwen-plus",
      provider: { name: "bailian" },
      apiKey: "sk-dashscope-test",
    });
    expect(result.providerId).toBe("bailian/qwen-plus");

    await h.client.request(AGENT_METHODS.sessionPrompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "hi again" }],
    });
    expect(agentText(h.updates)).toBe("from anthropicfrom bailian");

    const path = globalSettingsPath(h.dataDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(path, "utf8")) as MinervaSettings;
    expect(settings.model).toBe("bailian/qwen-plus");
    expect(settings.providers?.bailian?.apiKey).toBe("sk-dashscope-test");

    await h.kernel.getSession(h.sessionId)?.flush();
    const log = readFileSync(join(projectDir(h.dataDir, h.cwd), `${h.sessionId}.jsonl`), "utf8");
    expect(log).toContain('"session.model_changed"');
    expect(log).toContain('"bailian/qwen-plus"');
  });

  test("a host without resolveProvider rejects the method", async () => {
    const h = await setup({ provider: scripted("scripted", [textTurn("hello")]) });
    await expect(
      h.client.request(MINERVA_METHODS.configSetModel, { modelRef: "bailian/qwen-plus" }),
    ).rejects.toThrow("not supported");
  });

  test("a resolver failure surfaces as an error and rolls back the model ref", async () => {
    const h = await setup({
      provider: scripted("scripted", [textTurn("hello")]),
      resolveProvider: () => {
        throw new Error('unknown provider "nope"');
      },
    });
    await expect(
      h.client.request(MINERVA_METHODS.configSetModel, { modelRef: "nope/some-model" }),
    ).rejects.toThrow("unknown provider");

    const settings = JSON.parse(
      readFileSync(globalSettingsPath(h.dataDir), "utf8"),
    ) as MinervaSettings;
    expect(settings.model).toBeUndefined();
  });

  test("an invalid provider name is rejected without persisting (no startup brick)", async () => {
    const h = await setup({
      provider: scripted("scripted", [textTurn("hello")]),
      resolveProvider: (ref) => scripted(ref, []),
    });
    await expect(
      h.client.request(MINERVA_METHODS.configSetModel, {
        modelRef: "BAD!/model",
        provider: { name: "BAD!", baseUrl: "https://example.com/v1" },
      }),
    ).rejects.toThrow();

    // Nothing was persisted, so the next startup's buildProviderRegistry
    // (which the CLI runs unguarded) still succeeds.
    let providers: Record<string, unknown> = {};
    try {
      providers =
        (JSON.parse(readFileSync(globalSettingsPath(h.dataDir), "utf8")) as MinervaSettings)
          .providers ?? {};
    } catch {
      // settings.json may not exist at all — also fine.
    }
    expect(providers["BAD!"]).toBeUndefined();
    expect(() => buildProviderRegistry(providers as Record<string, never>)).not.toThrow();
  });

  test("a keyless custom provider definition persists requiresApiKey", async () => {
    const h = await setup({
      provider: scripted("scripted", [textTurn("hello")]),
      resolveProvider: (ref) => scripted(ref, []),
    });
    await h.client.request(MINERVA_METHODS.configSetModel, {
      modelRef: "ollama/llama4",
      provider: { name: "ollama", baseUrl: "http://localhost:11434/v1", requiresApiKey: false },
    });
    const settings = JSON.parse(
      readFileSync(globalSettingsPath(h.dataDir), "utf8"),
    ) as MinervaSettings;
    expect(settings.providers?.ollama).toEqual({
      baseUrl: "http://localhost:11434/v1",
      requiresApiKey: false,
    });
  });

  test("modelRef is required", async () => {
    const h = await setup({
      provider: scripted("scripted", [textTurn("hello")]),
      resolveProvider: (ref) => scripted(ref, []),
    });
    await expect(h.client.request(MINERVA_METHODS.configSetModel, {})).rejects.toThrow(
      "requires modelRef",
    );
  });
});

describe("minerva/config/state", () => {
  /** Like setup(), but with global settings seeded before the kernel exists. */
  async function setupWithSettings(providerId: string, settings: Partial<MinervaSettings>) {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-cfgstate-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-cfgstate-data-"));
    writeFileSync(globalSettingsPath(dataDir), JSON.stringify(settings), { mode: 0o600 });
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      provider: scripted(providerId, [textTurn("unused")]),
      dataDir,
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: PROTOCOL_VERSION });
    return { client, cwd, dataDir, kernel };
  }

  const ACME = {
    baseUrl: "https://acme.test/v1",
    apiKeyEnv: "MINERVA_TEST_ACME_KEY",
    defaultModel: "acme-1",
  };

  test("reports the live model, provider rows, and stored-key sources", async () => {
    const h = await setupWithSettings("acme/acme-1", {
      providers: { acme: { ...ACME, apiKey: "sk-stored" } },
    });
    const state = await h.client.request<{
      model: string;
      needsApiKey: boolean;
      providers: Array<{ name: string; keyVar: string; keySource: string; baseUrl?: string }>;
    }>(MINERVA_METHODS.configState, {});

    expect(state.model).toBe("acme/acme-1");
    // The stored key satisfies the live provider.
    expect(state.needsApiKey).toBe(false);
    const acme = state.providers.find((p) => p.name === "acme");
    expect(acme).toMatchObject({
      keyVar: "MINERVA_TEST_ACME_KEY",
      keySource: "settings",
      baseUrl: "https://acme.test/v1",
    });
    // Builtins are always selectable alongside custom providers.
    for (const name of ["anthropic", "openai", "bailian", "ollama"]) {
      expect(state.providers.some((p) => p.name === name)).toBe(true);
    }
  });

  test("needsApiKey flags a keyless required provider; env keys count (blank-aware)", async () => {
    const h = await setupWithSettings("acme/acme-1", { providers: { acme: ACME } });
    const read = () =>
      h.client.request<{
        needsApiKey: boolean;
        providers: Array<{ name: string; keySource: string }>;
      }>(MINERVA_METHODS.configState, {});

    process.env.MINERVA_TEST_ACME_KEY = "  ";
    try {
      // Blank env value counts as absent — the first-run signal fires.
      let state = await read();
      expect(state.needsApiKey).toBe(true);
      expect(state.providers.find((p) => p.name === "acme")?.keySource).toBe("none");

      process.env.MINERVA_TEST_ACME_KEY = "sk-env";
      state = await read();
      expect(state.needsApiKey).toBe(false);
      expect(state.providers.find((p) => p.name === "acme")?.keySource).toBe("env");
    } finally {
      delete process.env.MINERVA_TEST_ACME_KEY;
    }
  });

  test("a live provider outside the registry never demands a key", async () => {
    // A namespaced ref whose provider isn't in the registry (bare ids like
    // "scripted" instead default to anthropic, whose key state is env-truth).
    const h = await setupWithSettings("not-in-registry/model-x", {});
    const state = await h.client.request<{ model: string; needsApiKey: boolean }>(
      MINERVA_METHODS.configState,
      {},
    );
    expect(state.model).toBe("not-in-registry/model-x");
    expect(state.needsApiKey).toBe(false);
  });
});
