import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
import { createScriptedProvider } from "@minerva/providers";
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
