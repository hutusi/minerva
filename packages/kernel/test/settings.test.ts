import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultRuntime,
  globalSettingsPath,
  loadSettings,
  type MinervaSettings,
  persistAllowRule,
  projectSettingsPath,
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

  test("the atomic write leaves no temp file behind", async () => {
    const { dataDir } = tempDirs();
    await updateGlobalSettings(defaultRuntime, dataDir, (current) => ({
      ...current,
      model: "bailian/qwen-plus",
    }));
    // The temp name is randomized, so scan the directory for any *.tmp residue
    // rather than probing the old fixed `${path}.tmp` name.
    const dir = dirname(globalSettingsPath(dataDir));
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("atomic write symlink safety", () => {
  test("a planted settings.json.tmp symlink cannot redirect the write", async () => {
    const { cwd } = tempDirs();
    const outside = mkdtempSync(join(tmpdir(), "minerva-outside-"));
    const target = join(outside, "victim.txt");
    writeFileSync(target, "do not touch");
    mkdirSync(join(cwd, ".minerva"));
    // Attacker plants the (predictable, in the old code) temp name as a symlink
    // pointing at an external file.
    symlinkSync(target, `${projectSettingsPath(cwd)}.tmp`);

    await persistAllowRule(defaultRuntime, cwd, "bash(ls)");

    // The external file is untouched, and settings.json is a real file.
    expect(readFileSync(target, "utf8")).toBe("do not touch");
    const settingsPath = projectSettingsPath(cwd);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toContain("bash(ls)");
  });

  test("a planted settings.json symlink is replaced, not written through", async () => {
    const { cwd } = tempDirs();
    const outside = mkdtempSync(join(tmpdir(), "minerva-outside-"));
    const target = join(outside, "victim.json");
    writeFileSync(target, "{}");
    mkdirSync(join(cwd, ".minerva"));
    symlinkSync(target, projectSettingsPath(cwd)); // settings.json → external

    await persistAllowRule(defaultRuntime, cwd, "bash(ls)");

    // rename replaced the link with a real file; the external target is intact.
    expect(readFileSync(target, "utf8")).toBe("{}");
    const settingsPath = projectSettingsPath(cwd);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toContain("bash(ls)");
  });
});
