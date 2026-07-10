import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { render } from "ink-testing-library";
import { App } from "../src/app";
import { createPermissionBridge } from "../src/permission-bridge";

const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };
const FINISH_TOOLS: TurnEvent = { type: "finish", finishReason: "tool-calls", usage: {} };

/** Full-stack TUI harness: real App + client + kernel, scripted provider. */
function renderTui(turns: TurnEvent[][]) {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-ui-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-ui-data-"));
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  createKernel(kernelTransport, { dataDir, provider: createScriptedProvider(turns) });
  const bridge = createPermissionBridge();
  const client = new MinervaClient(clientTransport, {
    onPermissionRequest: bridge.onPermissionRequest,
  });
  const ui = render(
    <App client={client} bridge={bridge} model="scripted" cwd={cwd} resume={null} />,
  );
  return { ...ui, cwd };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(10);
  }
}

async function ready(ui: { lastFrame: () => string | undefined }) {
  await waitFor(() => (ui.lastFrame() ?? "").includes(">"), "input prompt");
  // Let Ink finish attaching its stdin listeners — an immediate write after
  // the first frame can be dropped.
  await Bun.sleep(50);
}

/** Type text and press Enter as separate keystrokes — a single chunk that
 * includes \r is treated by TextInput as a paste, not a submission. */
async function type(ui: { stdin: { write: (s: string) => void } }, text: string) {
  // Settle before and between writes: TextInput remounts after each turn and
  // a write that lands before its stdin listener attaches is dropped.
  await Bun.sleep(50);
  ui.stdin.write(text);
  await Bun.sleep(30);
  ui.stdin.write("\r");
}

describe("TUI (ink-testing-library, full stack)", () => {
  test("/help lists the command palette; unknown commands hint at it", async () => {
    const ui = renderTui([]);
    await ready(ui);

    await type(ui, "/help");
    await waitFor(() => (ui.lastFrame() ?? "").includes("/compact"), "help text");
    for (const cmd of ["/mode", "/sessions", "/new", "/exit"]) {
      expect(ui.lastFrame()).toContain(cmd);
    }

    await type(ui, "/frobnicate");
    await waitFor(() => (ui.lastFrame() ?? "").includes("unknown command"), "unknown-command");
    expect(ui.lastFrame()).toContain("/frobnicate");
    ui.unmount();
  }, 20_000);

  test("prompt streams text, asks permission, and renders the completed tool", async () => {
    const ui = renderTui([
      [
        { type: "text-delta", text: "Let me check." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "echo ui-e2e" },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "All done here." }, FINISH_STOP],
    ]);
    await ready(ui);

    await type(ui, "run the echo");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Permission required"), "permission");
    expect(ui.lastFrame()).toContain("echo ui-e2e");

    ui.stdin.write("y");
    await waitFor(() => (ui.lastFrame() ?? "").includes("All done here."), "final text");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Let me check.");
    expect(frame).toContain("[completed]");
    expect(frame).toContain("ui-e2e");
    ui.unmount();
  }, 20_000);

  test("rejecting a permission marks the tool failed and the turn continues", async () => {
    const ui = renderTui([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "rm -rf /" },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "Understood, skipping that." }, FINISH_STOP],
    ]);
    await ready(ui);

    await type(ui, "try something scary");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Permission required"), "permission");
    ui.stdin.write("n");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Understood"), "denial handled");
    expect(ui.lastFrame()).toContain("[failed]");
    ui.unmount();
  }, 20_000);

  test("todo_write renders the plan checklist and /mode shows the indicator", async () => {
    const ui = renderTui([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "todo_write",
          input: {
            todos: [
              { content: "first step", status: "completed" },
              { content: "second step", status: "in_progress" },
            ],
          },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "Plan is up." }, FINISH_STOP],
    ]);
    await ready(ui);

    await type(ui, "plan it");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Todos"), "todo checklist");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Plan is up."), "turn end");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("☑ first step");
    expect(frame).toContain("◐ second step");

    await type(ui, "/mode plan");
    await waitFor(() => (ui.lastFrame() ?? "").includes("[plan]"), "mode indicator");
    ui.unmount();
  }, 20_000);
});
