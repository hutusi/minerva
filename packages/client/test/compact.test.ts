import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, type MinervaKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { MinervaClient } from "../src";

const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };

function boot(dataDir: string, turns: TurnEvent[][]) {
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel: MinervaKernel = createKernel(kernelTransport, {
    dataDir,
    provider: createScriptedProvider(turns),
  });
  return { kernel, client: new MinervaClient(clientTransport) };
}

describe("/compact", () => {
  test("summarizes, resets model context, survives resume; transcript keeps history", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-compact-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-compact-data-"));

    const first = boot(dataDir, [
      [{ type: "text-delta", text: "Refactored the parser." }, FINISH_STOP],
      // The compaction turn: the scripted "model" produces the summary.
      [{ type: "text-delta", text: "Summary: the user refactored the parser." }, FINISH_STOP],
      [{ type: "text-delta", text: "Continuing from the summary." }, FINISH_STOP],
    ]);
    await first.client.initialize();
    const { sessionId, store } = await first.client.newSession(cwd);
    await first.client.prompt(sessionId, "refactor the parser");

    const summary = await first.client.compact(sessionId);
    expect(summary).toBe("Summary: the user refactored the parser.");
    expect(store.snapshot.busy).toBe(false);

    // Model context is now just the compacted summary…
    const live = first.kernel.getSession(sessionId);
    expect(live?.messages).toHaveLength(1);
    expect(JSON.stringify(live?.messages[0])).toContain("refactored the parser");

    // …and the conversation continues on top of it.
    const stopReason = await first.client.prompt(sessionId, "keep going");
    expect(stopReason).toBe("end_turn");
    first.client.close();

    // Resume in a fresh kernel: replay rebuilds from the compaction point,
    // while the UI transcript still shows the pre-compaction exchange.
    const second = boot(dataDir, []);
    await second.client.initialize();
    const { store: resumedStore } = await second.client.loadSession(sessionId, cwd);
    const resumed = second.kernel.getSession(sessionId);

    expect(JSON.stringify(resumed?.messages[0])).toContain("This session was compacted");
    expect(resumed?.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    const texts = resumedStore.snapshot.items
      .filter((item) => item.kind === "assistant")
      .map((item) => item.text);
    expect(texts).toEqual(["Refactored the parser.", "Continuing from the summary."]);
  });

  test("compact during an active prompt is rejected without touching busy state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-compact3-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-compact3-data-"));
    // Needs its own client: the shared boot() has no permission handler, and
    // this test's slow bash call must actually be approved and run.
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
        [{ type: "text-delta", text: "done" }, FINISH_STOP],
      ]),
    });
    const client = new MinervaClient(clientTransport, {
      onPermissionRequest: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    });
    await client.initialize();
    const { sessionId, store } = await client.newSession(cwd);

    const running = client.prompt(sessionId, "slow one");
    await Bun.sleep(20);
    await expect(client.compact(sessionId)).rejects.toThrow("already running");
    expect(store.snapshot.busy).toBe(true);
    await running;
  });

  test("compacting an empty session is rejected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-compact2-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-compact2-data-"));
    const { client } = boot(dataDir, []);
    await client.initialize();
    const { sessionId } = await client.newSession(cwd);
    await expect(client.compact(sessionId)).rejects.toThrow("nothing to compact");
  });
});
