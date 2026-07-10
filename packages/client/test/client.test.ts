import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair, PROTOCOL_VERSION } from "@minerva/protocol";
import { createScriptedProvider } from "@minerva/providers";
import { MinervaClient } from "../src";

describe("MinervaClient against a real kernel", () => {
  test("prompt drives the store through a full tool-using exchange", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-cli-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-cli-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [
          { type: "text-delta", text: "Checking." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo integration" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "It printed integration." },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
      ]),
    });

    const approved: string[] = [];
    const client = new MinervaClient(clientTransport, {
      onPermissionRequest: async (request) => {
        approved.push(request.toolCall.title);
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });

    const init = await client.initialize();
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    const { sessionId, store } = await client.newSession(cwd);
    const stopReason = await client.prompt(sessionId, "run echo");

    expect(stopReason).toBe("end_turn");
    expect(approved).toEqual(["echo integration"]);
    expect(store.snapshot.busy).toBe(false);
    expect(store.snapshot.items).toEqual([
      { kind: "user", text: "run echo" },
      { kind: "assistant", text: "Checking.", streaming: false },
      {
        kind: "tool",
        toolCallId: "c1",
        title: "echo integration",
        toolKind: "execute",
        status: "completed",
        output: "integration\n",
      },
      { kind: "assistant", text: "It printed integration.", streaming: false },
    ]);
  });

  test("default permission handler denies", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-cli-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-cli-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo nope" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "Okay, not running it." },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
      ]),
    });

    const client = new MinervaClient(clientTransport);
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);
    await client.prompt(sessionId, "run echo");

    const tool = store.snapshot.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ status: "failed" });
  });
});
