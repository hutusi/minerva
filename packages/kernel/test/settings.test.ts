import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRuntime,
  globalSettingsPath,
  loadSettings,
  type MinervaSettings,
  updateGlobalSettings,
} from "../src";

function tempDirs() {
  return {
    cwd: mkdtempSync(join(tmpdir(), "minerva-settings-proj-")),
    dataDir: mkdtempSync(join(tmpdir(), "minerva-settings-data-")),
  };
}

function writeSettings(path: string, settings: MinervaSettings) {
  writeFileSync(path, JSON.stringify(settings));
}

describe("model + provider settings", () => {
  test("model prefers the project layer; providers merge per name", async () => {
    const { cwd, dataDir } = tempDirs();
    writeSettings(globalSettingsPath(dataDir), {
      model: "bailian/qwen-plus",
      providers: {
        bailian: { apiKey: "sk-global", defaultModel: "qwen-plus" },
        deepseek: { baseUrl: "https://api.deepseek.com/v1" },
      },
    });
    mkdirSync(join(cwd, ".minerva"));
    writeSettings(join(cwd, ".minerva", "settings.json"), {
      model: "anthropic/claude-opus-4-8",
      providers: {
        bailian: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      },
    });

    const settings = await loadSettings(defaultRuntime, dataDir, cwd);
    expect(settings.model).toBe("anthropic/claude-opus-4-8");
    expect(settings.providers.bailian).toEqual({
      apiKey: "sk-global",
      defaultModel: "qwen-plus",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
    expect(settings.providers.deepseek).toEqual({ baseUrl: "https://api.deepseek.com/v1" });
  });

  test("an apiKey in project settings is ignored — keys are global-only", async () => {
    const { cwd, dataDir } = tempDirs();
    mkdirSync(join(cwd, ".minerva"));
    writeSettings(join(cwd, ".minerva", "settings.json"), {
      providers: { bailian: { apiKey: "sk-injected-by-repo", defaultModel: "qwen-max" } },
    });

    const settings = await loadSettings(defaultRuntime, dataDir, cwd);
    expect(settings.providers.bailian).toEqual({ defaultModel: "qwen-max" });
  });
});

describe("updateGlobalSettings", () => {
  test("creates the global file with mode 0600", async () => {
    const { dataDir } = tempDirs();
    await updateGlobalSettings(defaultRuntime, dataDir, (current) => ({
      ...current,
      model: "bailian/qwen-plus",
      providers: { bailian: { apiKey: "sk-secret" } },
    }));

    const path = globalSettingsPath(dataDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const { cwd } = tempDirs();
    const settings = await loadSettings(defaultRuntime, dataDir, cwd);
    expect(settings.model).toBe("bailian/qwen-plus");
    expect(settings.providers.bailian?.apiKey).toBe("sk-secret");
  });

  test("tightens a pre-existing world-readable file and keeps other fields", async () => {
    const { dataDir } = tempDirs();
    const path = globalSettingsPath(dataDir);
    writeSettings(path, { defaultMode: "plan" });
    chmodSync(path, 0o644);

    await updateGlobalSettings(defaultRuntime, dataDir, (current) => ({
      ...current,
      providers: { bailian: { apiKey: "sk-secret" } },
    }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const { cwd } = tempDirs();
    const settings = await loadSettings(defaultRuntime, dataDir, cwd);
    expect(settings.defaultMode).toBe("plan");
    expect(settings.providers.bailian?.apiKey).toBe("sk-secret");
  });
});
