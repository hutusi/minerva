import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ConfigPanel, type ConfigResult, type ProviderChoice } from "../src/config-panel";

const CHOICES: ProviderChoice[] = [
  {
    name: "anthropic",
    defaultModel: "claude-opus-4-8",
    keyVar: "ANTHROPIC_API_KEY",
    keySource: "env",
  },
  {
    name: "bailian",
    defaultModel: "qwen-plus",
    keyVar: "DASHSCOPE_API_KEY",
    keySource: "settings",
  },
];

function renderPanel(
  options: {
    choices?: ProviderChoice[];
    currentModel?: string;
    onSubmit?: (result: ConfigResult) => Promise<void>;
    onCancel?: () => void;
  } = {},
) {
  return render(
    <ConfigPanel
      providers={options.choices ?? CHOICES}
      currentModel={options.currentModel ?? "claude-opus-4-8"}
      firstRun={false}
      onSubmit={options.onSubmit ?? (async () => {})}
      onCancel={options.onCancel ?? (() => {})}
    />,
  );
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function press(ui: { stdin: { write: (s: string) => void } }, keys: string) {
  await Bun.sleep(30);
  ui.stdin.write(keys);
}

async function submitText(ui: { stdin: { write: (s: string) => void } }, text: string) {
  await Bun.sleep(30);
  if (text) ui.stdin.write(text);
  await Bun.sleep(30);
  ui.stdin.write("\r");
}

describe("ConfigPanel", () => {
  test("key status and defaults render for every source", async () => {
    const ui = renderPanel();
    await waitFor(() => (ui.lastFrame() ?? "").includes("Configure model"), "panel");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("key: env $ANTHROPIC_API_KEY");
    expect(frame).toContain("key: saved in settings");
    expect(frame).toContain("custom…");
    ui.unmount();
  });

  test("custom provider flow: k wraps up to custom, keyless endpoint allowed", async () => {
    const results: ConfigResult[] = [];
    const ui = renderPanel({
      onSubmit: async (result) => {
        results.push(result);
      },
    });
    await waitFor(() => (ui.lastFrame() ?? "").includes("custom…"), "panel");

    await press(ui, "k"); // wraps from the first row up to the custom row
    await press(ui, "\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Provider name"), "name step");
    await submitText(ui, "deepseek");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Base URL"), "baseUrl step");
    await submitText(ui, "https://api.deepseek.com/v1");
    await waitFor(() => (ui.lastFrame() ?? "").includes("API key"), "key step");
    expect(ui.lastFrame()).toContain("leave empty if the endpoint needs no key");
    await submitText(ui, ""); // keyless custom endpoint is fine
    await waitFor(() => (ui.lastFrame() ?? "").includes("Model id"), "model step");
    await submitText(ui, "deepseek-chat");

    await waitFor(() => results.length === 1, "submit");
    expect(results[0]).toEqual({
      modelRef: "deepseek/deepseek-chat",
      provider: { name: "deepseek", baseUrl: "https://api.deepseek.com/v1" },
    });
    ui.unmount();
  });

  test("invalid and colliding names are rejected inline", async () => {
    const ui = renderPanel();
    await waitFor(() => (ui.lastFrame() ?? "").includes("custom…"), "panel");
    await press(ui, "j");
    await press(ui, "j"); // down twice: anthropic → bailian → custom
    await press(ui, "\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Provider name"), "name step");

    await submitText(ui, "bailian");
    await waitFor(() => (ui.lastFrame() ?? "").includes("already exists"), "collision error");
    ui.unmount();
  });

  test("a non-http baseUrl is rejected inline", async () => {
    const ui = renderPanel();
    await waitFor(() => (ui.lastFrame() ?? "").includes("custom…"), "panel");
    await press(ui, "k");
    await press(ui, "\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Provider name"), "name step");
    await submitText(ui, "myproxy");
    await waitFor(() => (ui.lastFrame() ?? "").includes("Base URL"), "baseUrl step");
    await submitText(ui, "not-a-url");
    await waitFor(() => (ui.lastFrame() ?? "").includes("http(s) endpoint"), "baseUrl error");
    ui.unmount();
  });

  test("esc steps back and cancels from the provider list", async () => {
    let cancelled = false;
    const ui = renderPanel({
      onCancel: () => {
        cancelled = true;
      },
    });
    await waitFor(() => (ui.lastFrame() ?? "").includes("custom…"), "panel");
    await press(ui, "\r"); // select anthropic
    await waitFor(() => (ui.lastFrame() ?? "").includes("API key"), "key step");
    expect(ui.lastFrame()).toContain("leave empty to keep using $ANTHROPIC_API_KEY");
    await press(ui, ""); // esc → back to the provider list
    await waitFor(() => (ui.lastFrame() ?? "").includes("custom…"), "back to list");
    await press(ui, ""); // esc → cancel
    await waitFor(() => cancelled, "cancel");
    ui.unmount();
  });

  test("an empty key is rejected when the provider has none anywhere", async () => {
    const ui = renderPanel({
      choices: [
        { name: "openai", defaultModel: "gpt-5.2", keyVar: "OPENAI_API_KEY", keySource: "none" },
      ],
    });
    await waitFor(() => (ui.lastFrame() ?? "").includes("no key"), "panel");
    await press(ui, "\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("API key"), "key step");
    await submitText(ui, "");
    await waitFor(() => (ui.lastFrame() ?? "").includes("no existing key"), "key required error");
    ui.unmount();
  });

  test("a rejected save shows the error and keeps the panel open", async () => {
    const ui = renderPanel({
      currentModel: "anthropic/claude-opus-4-8",
      onSubmit: async () => {
        throw new Error("kernel said no");
      },
    });
    await waitFor(() => (ui.lastFrame() ?? "").includes("custom…"), "panel");
    await press(ui, "\r"); // anthropic; current model keeps its id as the prefill
    await waitFor(() => (ui.lastFrame() ?? "").includes("API key"), "key step");
    await submitText(ui, ""); // env key exists — keep it
    await waitFor(() => (ui.lastFrame() ?? "").includes("Model id"), "model step");
    await submitText(ui, "");
    await waitFor(() => (ui.lastFrame() ?? "").includes("kernel said no"), "submit error");
    expect(ui.lastFrame()).toContain("Model id"); // still on the step, input preserved
    ui.unmount();
  });
});
