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
        rawInput: { command: "echo integration" },
      },
      { kind: "assistant", text: "It printed integration.", streaming: false },
    ]);
  });

  test("listSkills returns the kernel's skill registry for a project", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-cli-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-cli-data-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cwd, ".minerva", "skills", "demo"), { recursive: true });
    writeFileSync(
      join(cwd, ".minerva", "skills", "demo", "SKILL.md"),
      "---\ndescription: A demo skill\n---\n\nBody.\n",
    );
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new MinervaClient(clientTransport);
    await client.initialize();
    expect(await client.listSkills(cwd)).toEqual([
      { name: "demo", description: "A demo skill", source: "project" },
    ]);
  });

  test("newSession surfaces AGENTS.md instructions from the kernel result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-cli-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-cli-data-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cwd, "AGENTS.md"), "Be terse.");
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new MinervaClient(clientTransport);
    await client.initialize();
    const { instructions } = await client.newSession(cwd);
    expect(instructions?.files).toEqual([
      { path: join(cwd, "AGENTS.md"), scope: "project", truncated: false },
    ]);
  });

  test("profile wrappers round-trip: newSession carries it, listProfiles and setProfile work", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-cli-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-cli-data-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cwd, ".minerva"), { recursive: true });
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({
        profile: "writer",
        profiles: { writer: { systemPrompt: "You write.", defaultMode: "plan" } },
      }),
    );
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new MinervaClient(clientTransport);
    await client.initialize();

    const listed = await client.listProfiles(cwd);
    expect(listed.default).toBe("writer");
    expect(listed.profiles).toEqual([
      { name: "writer", defaultMode: "plan", hasSystemPrompt: true },
    ]);

    const { sessionId, profile } = await client.newSession(cwd, { profile: "writer" });
    expect(profile).toBe("writer");
    await client.setProfile(sessionId, null);
    await expect(client.setProfile(sessionId, "ghost")).rejects.toThrow("unknown profile");
  });

  test("default permission handler cancels the turn (ACP cancelled outcome)", async () => {
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
      ]),
    });

    const client = new MinervaClient(clientTransport);
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);
    const stopReason = await client.prompt(sessionId, "run echo");

    expect(stopReason).toBe("cancelled");
    const tool = store.snapshot.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ status: "failed" });
  });

  test("overlapping prompt is rejected without disturbing the store", async () => {
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
            input: { command: "sleep 0.2" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
      ]),
    });

    const client = new MinervaClient(clientTransport, {
      onPermissionRequest: async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    });
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);

    const first = client.prompt(sessionId, "slow one");
    await Bun.sleep(20);
    await expect(client.prompt(sessionId, "second")).rejects.toThrow("already running");
    expect(store.snapshot.busy).toBe(true);
    expect(
      store.snapshot.items.filter((item) => item.kind === "user").map((item) => item.text),
    ).toEqual(["slow one"]);
    await first;
    expect(store.snapshot.busy).toBe(false);
  });
});
