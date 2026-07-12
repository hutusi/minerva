import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, type MinervaKernel, replayEvents, type SessionEvent } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { MinervaClient } from "../src";

const kernels: MinervaKernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
});

const finish = (inputTokens: number, outputTokens = 5): TurnEvent => ({
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens, outputTokens },
});

/** Scripted provider with a declared context window of 100 tokens. */
function boot(dataDir: string, turns: TurnEvent[][], approveTools = false) {
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  kernels.push(
    createKernel(kernelTransport, {
      dataDir,
      provider: { ...createScriptedProvider(turns), contextWindow: 100 },
    }),
  );
  return new MinervaClient(
    clientTransport,
    approveTools
      ? {
          onPermissionRequest: async () => ({
            outcome: { outcome: "selected", optionId: "allow" },
          }),
        }
      : {},
  );
}

describe("auto-compaction", () => {
  test("replay restores the trigger from the persisted context and resets it on compaction", () => {
    const at = "t";
    const base: SessionEvent[] = [
      { type: "user.message", text: "hi", at },
      { type: "assistant.message", text: "yo", toolCalls: [], at },
      {
        type: "turn.completed",
        stopReason: "end_turn",
        // Cumulative usage deliberately larger than the persisted context —
        // replay must use `context`, never recompute from `usage`.
        usage: { inputTokens: 130, outputTokens: 5, cacheReadTokens: 20 },
        context: 70,
        at,
      },
    ];
    expect(replayEvents(base, []).lastTurnContext).toBe(70);

    // A turn.completed without the field (old logs) leaves the signal alone.
    const withOldTurn = replayEvents(
      [
        ...base,
        { type: "user.message", text: "again", at },
        { type: "assistant.message", text: "ok", toolCalls: [], at },
        { type: "turn.completed", stopReason: "end_turn", usage: { inputTokens: 500 }, at },
      ],
      [],
    );
    expect(withOldTurn.lastTurnContext).toBe(70);

    const compacted = replayEvents(
      [...base, { type: "session.compacted", summary: "short version", at }],
      [],
    );
    expect(compacted.lastTurnContext).toBeUndefined();

    // A turn after the compaction re-arms the signal.
    const after = replayEvents(
      [
        ...base,
        { type: "session.compacted", summary: "short version", at },
        { type: "user.message", text: "more", at },
        { type: "assistant.message", text: "ok", toolCalls: [], at },
        {
          type: "turn.completed",
          stopReason: "end_turn",
          usage: { inputTokens: 30 },
          context: 30,
          at,
        },
      ],
      [],
    );
    expect(after.lastTurnContext).toBe(30);
  });

  test("crossing 80% of the window compacts before the next prompt, exactly once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-autoc-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-autoc-data-"));
    const client = boot(dataDir, [
      [{ type: "text-delta", text: "first reply" }, finish(90)], // 90 > 0.8 × 100
      [{ type: "text-delta", text: "SUMMARY OF SESSION" }, finish(10, 3)], // compaction turn
      [{ type: "text-delta", text: "second reply" }, finish(20)],
      [{ type: "text-delta", text: "third reply" }, finish(25)],
    ]);
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);

    await client.prompt(sessionId, "one");
    expect(store.snapshot.items.some((item) => item.kind === "info")).toBe(false);

    // The over-threshold turn compacts ahead of this prompt.
    await client.prompt(sessionId, "two");
    const session = kernels[0]?.getSession(sessionId);
    expect(JSON.stringify(session?.messages[0])).toContain("SUMMARY OF SESSION");
    const notices = () =>
      store.snapshot.items.filter(
        (item) => item.kind === "info" && item.text.includes("context auto-compacted"),
      );
    expect(notices()).toHaveLength(1);
    expect(JSON.stringify(notices()[0])).toContain("SUMMARY OF SESSION");

    // The compaction turn's own input (10) must NOT re-trigger — the loop
    // hazard. If it did, the third prompt would consume the "third reply"
    // turn as a summary and fail on script exhaustion.
    await client.prompt(sessionId, "three");
    expect(notices()).toHaveLength(1);
    expect(store.snapshot.items.at(-1)).toMatchObject({
      kind: "assistant",
      text: "third reply",
    });
    // Cumulative usage includes the compaction turn's spend.
    expect(store.snapshot.usage?.cumulative.inputTokens).toBe(90 + 10 + 20 + 25);
  }, 15_000);

  test("the trigger survives a restart: resume then prompt compacts first", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-autoc-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-autoc-data-"));
    const first = boot(dataDir, [[{ type: "text-delta", text: "big reply" }, finish(95)]]);
    await first.initialize();
    const { sessionId } = await first.newSession(cwd);
    await first.prompt(sessionId, "one");
    await kernels.pop()?.close();

    const second = boot(dataDir, [
      [{ type: "text-delta", text: "RESUMED SUMMARY" }, finish(12, 3)],
      [{ type: "text-delta", text: "fresh reply" }, finish(30)],
    ]);
    await second.initialize();
    const { store } = await second.loadSession(sessionId, cwd);
    await second.prompt(sessionId, "continue");
    expect(
      store.snapshot.items.some(
        (item) => item.kind === "info" && item.text.includes("context auto-compacted"),
      ),
    ).toBe(true);
    expect(store.snapshot.items.at(-1)).toMatchObject({ text: "fresh reply" });
  }, 15_000);

  test("a tool loop's summed usage does not trigger — the last call is the signal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-autoc-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-autoc-data-"));
    const client = boot(
      dataDir,
      [
        // One prompt, two model calls: 60 + 70 sum to 130 (> window 100),
        // but the real context is the last call's 70 (< 80% threshold).
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo loop" },
          },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 60, outputTokens: 5 },
          },
        ],
        [{ type: "text-delta", text: "tool reply" }, finish(70)],
        // If the sum triggered compaction, this turn would be consumed as the
        // summary and the assertion below would see it as the reply.
        [{ type: "text-delta", text: "follow-up reply" }, finish(20)],
      ],
      true,
    );
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);
    await client.prompt(sessionId, "use the tool");
    await client.prompt(sessionId, "follow up");
    expect(
      store.snapshot.items.some(
        (item) => item.kind === "info" && item.text.includes("context auto-compacted"),
      ),
    ).toBe(false);
    expect(store.snapshot.items.at(-1)).toMatchObject({ text: "follow-up reply" });
  }, 15_000);

  test("cached input tokens are not double-counted into the trigger", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-autoc-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-autoc-data-"));
    const client = boot(dataDir, [
      // inputTokens already INCLUDES the cached tokens (AI SDK semantics):
      // real context 70 < 80. The old code added cacheRead on top (130 > 80).
      [
        { type: "text-delta", text: "cached reply" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 70, outputTokens: 5, cacheReadTokens: 60 },
        },
      ],
      [{ type: "text-delta", text: "next reply" }, finish(20)],
    ]);
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);
    await client.prompt(sessionId, "one");
    await client.prompt(sessionId, "two");
    expect(
      store.snapshot.items.some(
        (item) => item.kind === "info" && item.text.includes("context auto-compacted"),
      ),
    ).toBe(false);
    expect(store.snapshot.items.at(-1)).toMatchObject({ text: "next reply" });
  }, 15_000);

  test("providers without a contextWindow stay inert", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-autoc-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-autoc-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    kernels.push(
      createKernel(kernelTransport, {
        dataDir,
        // No contextWindow — huge turns must never trigger compaction.
        provider: createScriptedProvider([
          [{ type: "text-delta", text: "reply one" }, finish(500_000)],
          [{ type: "text-delta", text: "reply two" }, finish(600_000)],
        ]),
      }),
    );
    const client = new MinervaClient(clientTransport);
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);
    await client.prompt(sessionId, "one");
    await client.prompt(sessionId, "two");
    expect(store.snapshot.items.filter((item) => item.kind === "info")).toHaveLength(0);
  }, 15_000);
});
