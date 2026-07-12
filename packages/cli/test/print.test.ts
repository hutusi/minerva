import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { runPrintMode } from "../src/print";

const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };
const FINISH_TOOLS: TurnEvent = { type: "finish", finishReason: "tool-calls", usage: {} };

function capture() {
  const state = { out: "", err: "" };
  return {
    state,
    io: {
      stdout: { write: (text: string) => (state.out += text) },
      stderr: { write: (text: string) => (state.err += text) },
    },
  };
}

function run(
  turns: TurnEvent[][],
  overrides: Partial<Parameters<typeof runPrintMode>[0]> = {},
): { code: Promise<number>; state: { out: string; err: string }; cwd: string; dataDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-print-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-print-data-"));
  const { state, io } = capture();
  const code = runPrintMode({
    kernelOptions: { dataDir, provider: createScriptedProvider(turns) },
    cwd,
    prompt: "do the thing",
    io,
    ...overrides,
  });
  return { code, state, cwd, dataDir };
}

describe("print mode", () => {
  test("streams the reply to stdout and exits 0 on end_turn", async () => {
    const { code, state } = run([
      [{ type: "text-delta", text: "Hello " }, { type: "text-delta", text: "world" }, FINISH_STOP],
    ]);
    expect(await code).toBe(0);
    expect(state.out).toBe("Hello world\n");
    expect(state.err).toBe("");
  });

  test("default mode denies tool calls with a note; the model continues", async () => {
    const { code, state } = run([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "rm -rf /" },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "Understood, skipping." }, FINISH_STOP],
    ]);
    expect(await code).toBe(0);
    expect(state.out).toBe("Understood, skipping.\n");
    expect(state.err).toContain("permission denied (non-interactive): rm -rf /");
    expect(state.err).toContain("--mode acceptEdits|auto");
    expect(state.err).toContain("⏺ rm -rf /");
  });

  test("--mode auto executes tools without asking", async () => {
    const { code, state } = run(
      [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo print-auto" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "It printed." }, FINISH_STOP],
      ],
      { mode: "auto" },
    );
    expect(await code).toBe(0);
    expect(state.out).toBe("It printed.\n");
    expect(state.err).toContain("⏺ echo print-auto");
    expect(state.err).not.toContain("permission denied");
  });

  test("an unknown mode exits 1 with the kernel's error", async () => {
    const { code, state } = run([], { mode: "yolo" });
    expect(await code).toBe(1);
    expect(state.err).toContain("unknown mode");
    expect(state.out).toBe("");
  });

  test("resume continues the latest session without re-printing its history", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-print-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-print-data-"));

    // First lifetime: an interactive-style session with one exchange.
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const firstKernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [{ type: "text-delta", text: "history reply" }, FINISH_STOP],
      ]),
    });
    const firstClient = new MinervaClient(clientTransport);
    await firstClient.initialize();
    const { sessionId } = await firstClient.newSession(cwd);
    await firstClient.prompt(sessionId, "history prompt");
    await firstKernel.close();

    const { state, io } = capture();
    const code = await runPrintMode({
      kernelOptions: {
        dataDir,
        provider: createScriptedProvider([
          [{ type: "text-delta", text: "fresh reply" }, FINISH_STOP],
        ]),
      },
      cwd,
      prompt: "continue",
      resume: "latest",
      io,
    });
    expect(code).toBe(0);
    expect(state.out).toBe("fresh reply\n");
    expect(state.out).not.toContain("history reply");
  });

  test("a stop reason other than end_turn exits 1", async () => {
    // Scripted provider exhausted → the turn errors out.
    const { code, state } = run([]);
    expect(await code).toBe(1);
    expect(state.err).toContain("minerva:");
  });
});
