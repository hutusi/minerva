import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, type MinervaKernel, projectDir } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { MinervaClient } from "../src";

const FINISH_TOOLS: TurnEvent = {
  type: "finish",
  finishReason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 5 },
};
const FINISH_STOP: TurnEvent = {
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens: 20, outputTokens: 8 },
};

function boot(
  dataDir: string,
  turns: TurnEvent[][],
): { client: MinervaClient; kernel: MinervaKernel } {
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, {
    dataDir,
    provider: createScriptedProvider(turns),
  });
  const client = new MinervaClient(clientTransport, {
    onPermissionRequest: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
  });
  return { client, kernel };
}

describe("session resume across kernel restarts", () => {
  test("load rebuilds the transcript and the conversation continues", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-resume-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-resume-data-"));

    // First process lifetime: one prompt with an approved tool call.
    const first = boot(dataDir, [
      [
        { type: "text-delta", text: "Running." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "echo persisted" },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "Done." }, FINISH_STOP],
    ]);
    await first.client.initialize();
    const { sessionId } = await first.client.newSession(cwd);
    await first.client.prompt(sessionId, "run echo");
    first.client.close();

    // Second process lifetime: same dataDir, fresh kernel + client.
    const second = boot(dataDir, [[{ type: "text-delta", text: "Welcome back." }, FINISH_STOP]]);
    await second.client.initialize();

    const sessions = await second.client.listSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId, preview: "run echo" });

    const { store } = await second.client.loadSession(sessionId, cwd);
    expect(store.snapshot.items).toEqual([
      { kind: "user", text: "run echo" },
      { kind: "assistant", text: "Running.", streaming: false },
      {
        kind: "tool",
        toolCallId: "c1",
        title: "echo persisted",
        toolKind: "execute",
        status: "completed",
        output: "persisted\n",
      },
      { kind: "assistant", text: "Done.", streaming: false },
    ]);

    // Session-lifetime usage is rebuilt from the log: both model turns of
    // the first lifetime, announced without a lastTurn.
    expect(store.snapshot.usage).toEqual({
      lastTurn: undefined,
      cumulative: { inputTokens: 30, outputTokens: 13 },
    });

    // The resumed session carries the prior context into the next turn.
    const resumed = second.kernel.getSession(sessionId);
    expect(resumed?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const stopReason = await second.client.prompt(sessionId, "hello again");
    expect(stopReason).toBe("end_turn");
    expect(store.snapshot.items.at(-1)).toEqual({
      kind: "assistant",
      text: "Welcome back.",
      streaming: false,
    });
    // The post-resume turn keeps counting on top of the rebuilt total.
    expect(store.snapshot.usage).toEqual({
      lastTurn: { inputTokens: 20, outputTokens: 8 },
      cumulative: { inputTokens: 50, outputTokens: 21 },
    });
  });

  test("a turn killed mid-tool-call resumes with synthesized results and a torn line ignored", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-kill9-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-kill9-data-"));

    const first = boot(dataDir, []);
    await first.client.initialize();
    const { sessionId } = await first.client.newSession(cwd);
    first.client.close();

    // Simulate kill -9 mid-turn: the assistant message with a tool call was
    // logged, the result never arrived, and the final line is torn. The
    // kernel's own log writes are async — give session.created a beat to
    // land first so the synthetic events append in realistic order.
    const dir = projectDir(dataDir, cwd);
    await Bun.sleep(30);
    const logPath = join(dir, `${sessionId}.jsonl`);
    appendFileSync(
      logPath,
      `${JSON.stringify({ type: "user.message", text: "long task", at: "t" })}\n` +
        `${JSON.stringify({
          type: "assistant.message",
          text: "Starting",
          toolCalls: [{ toolCallId: "c9", toolName: "bash", input: { command: "sleep 999" } }],
          at: "t",
        })}\n` +
        `${JSON.stringify({ type: "tool.call", toolCallId: "c9", toolName: "bash", input: { command: "sleep 999" }, at: "t" })}\n` +
        '{"type":"tool.res', // torn write
    );

    const second = boot(dataDir, [[{ type: "text-delta", text: "Recovered." }, FINISH_STOP]]);
    await second.client.initialize();
    const { store } = await second.client.loadSession(sessionId, cwd);

    const tool = store.snapshot.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ toolCallId: "c9", status: "failed" });

    // History is well-formed: the dangling tool call has a synthesized result.
    const resumed = second.kernel.getSession(sessionId);
    const toolMessage = resumed?.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: "tool" });
    expect(JSON.stringify(toolMessage)).toContain("interrupted");

    const stopReason = await second.client.prompt(sessionId, "continue");
    expect(stopReason).toBe("end_turn");
  });

  test("a session cannot be loaded from a slug-colliding foreign cwd", async () => {
    const base = mkdtempSync(join(tmpdir(), "minerva-slug-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-slug-data-"));
    // proj.a and proj-a collapse to the same project slug.
    const cwdA = join(base, "proj.a");
    const cwdB = join(base, "proj-a");
    mkdirSync(cwdA);
    mkdirSync(cwdB);

    const first = boot(dataDir, []);
    await first.client.initialize();
    const { sessionId } = await first.client.newSession(cwdA);
    await Bun.sleep(20); // let the async session.created write land
    first.client.close();

    const second = boot(dataDir, []);
    await second.client.initialize();
    await expect(second.client.loadSession(sessionId, cwdB)).rejects.toThrow("belongs to");
  });

  test("setMode round-trips into the store", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mode-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mode-data-"));
    const { client } = boot(dataDir, []);
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);
    expect(store.snapshot.currentModeId).toBe("default");
    await client.setMode(sessionId, "plan");
    await Bun.sleep(0);
    expect(store.snapshot.currentModeId).toBe("plan");
    await expect(client.setMode(sessionId, "yolo")).rejects.toThrow("unknown mode");
  });
});
