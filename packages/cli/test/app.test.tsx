import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import { createKernel, type KernelOptions, type MinervaKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
// ink-testing-library is pinned exactly: 4.0.0 predates ink 6 / React 19 and
// no compatible major exists yet — these tests are the compatibility proof,
// so an unreviewed 4.x bump must not slip in via install.
import { render } from "ink-testing-library";
import { App, clipLines, thoughtTail } from "../src/app";
import type { ProviderChoice } from "../src/config-panel";
import { createPermissionBridge } from "../src/permission-bridge";

const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };
const FINISH_TOOLS: TurnEvent = { type: "finish", finishReason: "tool-calls", usage: {} };

const kernels: MinervaKernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
});

describe("line clipping helpers", () => {
  test("clipLines keeps the first lines with a remaining-count marker", () => {
    const text = "a\nb\nc\nd\ne";
    expect(clipLines(text, 2, "first")).toBe("a\nb\n… (3 more lines)");
    expect(clipLines(text, 10, "first")).toBe(text);
  });

  test("clipLines keeps the last lines with a leading ellipsis", () => {
    const text = "a\nb\nc\nd\ne";
    expect(clipLines(text, 2, "last")).toBe("… d\ne");
    expect(clipLines(text, 10, "last")).toBe(text);
  });

  test("thoughtTail caps a long unbroken paragraph by terminal width", () => {
    const paragraph = "x".repeat(5000); // no newlines: under the line cap
    const columns = 80;
    const tail = thoughtTail(paragraph, columns);
    const budget = 4 * (columns - 4);
    // Bounded to the width budget plus the "… " prefix, keeping the tail end.
    expect(tail.length).toBeLessThanOrEqual(budget + 2);
    expect(tail.startsWith("… ")).toBe(true);
    expect(paragraph.endsWith(tail.slice(2))).toBe(true);
  });

  test("thoughtTail leaves a short thought untouched", () => {
    expect(thoughtTail("brief thought", 80)).toBe("brief thought");
  });
});

/** Full-stack TUI harness: real App + client + kernel, scripted provider. */
function renderTui(
  turns: TurnEvent[][],
  options: {
    resolveProvider?: KernelOptions["resolveProvider"];
    providers?: ProviderChoice[];
    needsConfig?: boolean;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-ui-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-ui-data-"));
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  kernels.push(
    createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider(turns),
      ...(options.resolveProvider ? { resolveProvider: options.resolveProvider } : {}),
    }),
  );
  const bridge = createPermissionBridge();
  const client = new MinervaClient(clientTransport, {
    onPermissionRequest: bridge.onPermissionRequest,
  });
  const ui = render(
    <App
      client={client}
      bridge={bridge}
      model="scripted"
      cwd={cwd}
      resume={null}
      providers={options.providers ?? []}
      needsConfig={options.needsConfig ?? false}
    />,
  );
  return { ...ui, cwd, dataDir };
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

async function pressEnter(ui: { stdin: { write: (s: string) => void } }) {
  await Bun.sleep(50);
  ui.stdin.write("\r");
}

const BAILIAN_CHOICE: ProviderChoice = {
  name: "bailian",
  defaultModel: "qwen-plus",
  keyVar: "DASHSCOPE_API_KEY",
  keySource: "none",
};

/** Harness stand-in for the entrypoint's resolveProvider factory. */
const swappedProvider: KernelOptions["resolveProvider"] = (modelRef) => ({
  ...createScriptedProvider([[{ type: "text-delta", text: "hello from qwen" }, FINISH_STOP]]),
  id: modelRef,
});

/** Drive the panel: select bailian → enter a key → accept the prefilled model. */
async function completeConfigPanel(ui: {
  stdin: { write: (s: string) => void };
  lastFrame: () => string | undefined;
}) {
  await waitFor(() => (ui.lastFrame() ?? "").includes("Configure model"), "config panel");
  await pressEnter(ui); // bailian is the first (highlighted) row
  await waitFor(() => (ui.lastFrame() ?? "").includes("API key"), "api key step");
  await type(ui, "sk-dashscope-test");
  await waitFor(() => (ui.lastFrame() ?? "").includes("Model id"), "model step");
  await pressEnter(ui); // accept the prefilled qwen-plus
  await waitFor(
    () => (ui.lastFrame() ?? "").includes("model set to bailian/qwen-plus"),
    "config saved",
  );
}

describe("TUI (ink-testing-library, full stack)", () => {
  test("/help lists the command palette; unknown commands hint at it", async () => {
    const ui = renderTui([]);
    await ready(ui);

    await type(ui, "/help");
    await waitFor(() => (ui.lastFrame() ?? "").includes("/compact"), "help text");
    for (const cmd of ["/config", "/mode", "/sessions", "/new", "/exit"]) {
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

  test("an edit permission previews the diff; arrow keys navigate the options", async () => {
    const ui = renderTui([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "edit_file",
          input: { path: "code.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "Understood." }, FINISH_STOP],
    ]);
    writeFileSync(join(ui.cwd, "code.ts"), "const a = 1;\n");
    await ready(ui);

    await type(ui, "bump the constant");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Permission required"), "permission");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("- const a = 1;");
    expect(frame).toContain("+ const a = 2;");
    expect(frame).toContain("❯ Allow");

    // ↓ ↓ walks to Reject; enter selects the highlighted option.
    await Bun.sleep(50);
    ui.stdin.write("[B[B");
    await waitFor(() => (ui.lastFrame() ?? "").includes("❯ Reject"), "reject highlighted");
    ui.stdin.write("\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Understood."), "turn continued");
    expect(ui.lastFrame()).toContain("[failed]");
    ui.unmount();
  }, 20_000);

  test("an approved edit renders its file diff in the transcript", async () => {
    const ui = renderTui([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "edit_file",
          input: { path: "code.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
        },
        FINISH_TOOLS,
      ],
      [{ type: "text-delta", text: "Edited." }, FINISH_STOP],
    ]);
    writeFileSync(join(ui.cwd, "code.ts"), "const a = 1;\nconst keep = true;\n");
    await ready(ui);

    await type(ui, "bump the constant");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Permission required"), "permission");
    ui.stdin.write("y");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Edited."), "turn finished");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("[completed]");
    expect(frame).toContain("- const a = 1;");
    expect(frame).toContain("+ const a = 2;");
    expect(frame).toContain("  const keep = true;");
    ui.unmount();
  }, 20_000);

  test("/config switches the provider live and persists to global settings", async () => {
    const ui = renderTui([], {
      providers: [BAILIAN_CHOICE],
      resolveProvider: swappedProvider,
    });
    await ready(ui);

    await type(ui, "/config");
    await completeConfigPanel(ui);
    expect(ui.lastFrame()).toContain("bailian/qwen-plus"); // header live-updated

    await type(ui, "say hi");
    await waitFor(() => (ui.lastFrame() ?? "").includes("hello from qwen"), "swapped provider");

    const path = join(ui.dataDir, "settings.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      model?: string;
      providers?: Record<string, { apiKey?: string }>;
    };
    expect(settings.model).toBe("bailian/qwen-plus");
    expect(settings.providers?.bailian?.apiKey).toBe("sk-dashscope-test");
    ui.unmount();
  }, 20_000);

  test("arrow+enter arriving as one input batch still selects the highlighted row", async () => {
    const ui = renderTui([], {
      providers: [
        {
          name: "anthropic",
          defaultModel: "claude-opus-4-8",
          keyVar: "ANTHROPIC_API_KEY",
          keySource: "none",
        },
        { name: "openai", defaultModel: "gpt-5.2", keyVar: "OPENAI_API_KEY", keySource: "none" },
        BAILIAN_CHOICE,
      ],
      resolveProvider: swappedProvider,
    });
    await ready(ui);
    await type(ui, "/config");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Configure model"), "config panel");
    await Bun.sleep(50);
    // One chunk: ↓ ↓ enter — processed in a single React batch, which used
    // to select the stale (previously highlighted) row.
    ui.stdin.write("[B[B\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("DASHSCOPE_API_KEY"), "bailian selected");
    await type(ui, "sk-batched");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Model id"), "model step");
    expect(ui.lastFrame()).toContain("qwen-plus"); // bailian's prefill, not a stale row's
    await pressEnter(ui);
    await waitFor(
      () => (ui.lastFrame() ?? "").includes("model set to bailian/qwen-plus"),
      "config saved",
    );
    ui.unmount();
  }, 20_000);

  test("first run without a key opens the panel; finishing it reveals the composer", async () => {
    const ui = renderTui([], {
      providers: [BAILIAN_CHOICE],
      needsConfig: true,
      resolveProvider: swappedProvider,
    });
    await waitFor(() => (ui.lastFrame() ?? "").includes("No API key found"), "first-run panel");

    await completeConfigPanel(ui);
    await waitFor(() => (ui.lastFrame() ?? "").includes(">"), "composer after config");
    expect(statSync(join(ui.dataDir, "settings.json")).mode & 0o777).toBe(0o600);

    // Reopening /config after setup must not re-show the first-run banner or
    // treat the just-configured provider as keyless (stale startup snapshot).
    await type(ui, "/config");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Configure model"), "config reopened");
    expect(ui.lastFrame()).not.toContain("No API key found");
    ui.unmount();
  }, 20_000);

  test("assistant markdown renders as terminal formatting", async () => {
    const ui = renderTui([[{ type: "text-delta", text: "# Done\n\n- x" }, FINISH_STOP]]);
    await ready(ui);

    await type(ui, "summarize");
    await waitFor(() => (ui.lastFrame() ?? "").includes("• x"), "markdown list");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Done");
    expect(frame).not.toContain("# Done"); // heading marker consumed by the renderer
    ui.unmount();
  }, 20_000);

  test("a thought streams dimmed, then collapses to a summary line", async () => {
    const thought = "Weighing the options before answering.";
    const ui = renderTui([
      [
        { type: "reasoning-delta", text: thought },
        { type: "text-delta", text: "Answer: A." },
        FINISH_STOP,
      ],
    ]);
    await ready(ui);

    await type(ui, "choose one");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Answer: A."), "answer text");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain(`✻ thought · ${thought.length} chars`);
    expect(frame).not.toContain("Weighing the options");
    // The streaming state showed the raw thought before the collapse.
    expect(ui.frames.some((f) => f.includes("✻ Weighing the options"))).toBe(true);
    ui.unmount();
  }, 20_000);

  test("token usage footer shows last-turn and session totals", async () => {
    const ui = renderTui([
      [
        { type: "text-delta", text: "First answer." },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 100 },
        },
      ],
      [
        { type: "text-delta", text: "Second answer." },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 250, outputTokens: 8 } },
      ],
    ]);
    await ready(ui);
    // Nothing reported yet — no footer.
    expect(ui.lastFrame()).not.toContain("tokens ·");

    await type(ui, "first");
    await waitFor(() => (ui.lastFrame() ?? "").includes("tokens ·"), "usage footer");
    expect(ui.lastFrame()).toContain("last 1k in / 5 out");
    expect(ui.lastFrame()).toContain("session 1k in / 5 out (100 cached)");

    await type(ui, "second");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Second answer."), "second turn");
    expect(ui.lastFrame()).toContain("last 250 in / 8 out");
    expect(ui.lastFrame()).toContain("session 1.3k in / 13 out (100 cached)");
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
