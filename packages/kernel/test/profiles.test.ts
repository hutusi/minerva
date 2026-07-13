import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  Connection,
  createInProcTransportPair,
  MINERVA_METHODS,
  type ProfilesListResult,
  type SessionLoadResult,
  type SessionNewResult,
} from "@minerva/protocol";
import type { ModelProvider, TurnRequest } from "@minerva/providers";
import { createKernel, defaultRuntime, type MinervaKernel, projectDir, type Runtime } from "../src";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** Records each turn's system prompt, then finishes with a scripted reply. */
function capturingProvider(captured: Array<string | undefined>): ModelProvider {
  return {
    id: "test/capturing",
    async *streamTurn(request: TurnRequest) {
      captured.push(request.system);
      yield { type: "text-delta" as const, text: "ok" };
      yield { type: "finish" as const, finishReason: "stop" as const, usage: {} };
    },
  };
}

function writeProjectSettings(cwd: string, settings: object) {
  mkdirSync(join(cwd, ".minerva"), { recursive: true });
  writeFileSync(join(cwd, ".minerva", "settings.json"), JSON.stringify(settings));
}

const kernels: MinervaKernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
});

function boot(dataDir: string, captured: Array<string | undefined>) {
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, {
    dataDir,
    provider: capturingProvider(captured),
  });
  kernels.push(kernel);
  return new Connection(clientTransport);
}

const WRITER_PROMPT = "You are a thoughtful WRITER persona.";
const PROFILE_SETTINGS = {
  profiles: {
    writer: { systemPrompt: WRITER_PROMPT, defaultMode: "plan", model: "bailian/qwen-plus" },
    minimal: {},
  },
};

const prompt = (client: Connection, sessionId: string, text: string) =>
  client.request(AGENT_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text }] });

describe("named profiles through the kernel", () => {
  test("a profile replaces the base prompt, sets the default mode, and AGENTS.md still appends", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    writeFileSync(join(cwd, "AGENTS.md"), "Answer only in haiku.");
    const captured: Array<string | undefined> = [];
    const client = boot(tmp("minerva-prof-data-"), captured);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    const result = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
      profile: "writer",
    });
    expect(result.profile).toBe("writer");
    expect(result.modes?.currentModeId).toBe("plan");

    await prompt(client, result.sessionId, "hi");
    expect(captured[0]).toContain(WRITER_PROMPT);
    expect(captured[0]).not.toContain("You are Minerva");
    expect(captured[0]).toContain("Answer only in haiku.");
  }, 15_000);

  test("the settings default profile applies when none is requested", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, { ...PROFILE_SETTINGS, profile: "writer" });
    const captured: Array<string | undefined> = [];
    const client = boot(tmp("minerva-prof-data-"), captured);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    const result = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, { cwd });
    expect(result.profile).toBe("writer");
  }, 15_000);

  test("an unknown profile is rejected at session/new and set_profile", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    const client = boot(tmp("minerva-prof-data-"), []);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    await expect(
      client.request(AGENT_METHODS.sessionNew, { cwd, profile: "ghost" }),
    ).rejects.toThrow('unknown profile "ghost"');

    const { sessionId } = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await expect(
      client.request(MINERVA_METHODS.sessionSetProfile, { sessionId, profile: "ghost" }),
    ).rejects.toThrow('unknown profile "ghost"');
  }, 15_000);

  test("set_profile is rejected while a prompt is running", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    // A provider that stalls until we let it finish, keeping the lease held.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir: tmp("minerva-prof-data-"),
      provider: {
        id: "test/stalling",
        async *streamTurn() {
          await gate;
          yield { type: "text-delta" as const, text: "ok" };
          yield { type: "finish" as const, finishReason: "stop" as const, usage: {} };
        },
      },
    });
    kernels.push(kernel);
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    const running = prompt(client, sessionId, "hold the lease");
    await Bun.sleep(20); // let the prompt claim the lease
    await expect(
      client.request(MINERVA_METHODS.sessionSetProfile, { sessionId, profile: "writer" }),
    ).rejects.toThrow("cannot switch profile while a prompt is running");
    release?.();
    await running;
  }, 15_000);

  test("a mid-session switch applies from the next prompt; null clears it", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    const captured: Array<string | undefined> = [];
    const client = boot(tmp("minerva-prof-data-"), captured);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    await prompt(client, sessionId, "one");
    expect(captured[0]).toContain("You are Minerva");

    await client.request(MINERVA_METHODS.sessionSetProfile, { sessionId, profile: "writer" });
    await prompt(client, sessionId, "two");
    expect(captured[1]).toContain(WRITER_PROMPT);

    await client.request(MINERVA_METHODS.sessionSetProfile, { sessionId, profile: null });
    await prompt(client, sessionId, "three");
    expect(captured[2]).toContain("You are Minerva");
  }, 15_000);

  test("concurrent profile changes apply in request order", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    let releaseSettings: (() => void) | undefined;
    let settingsReadStarted: (() => void) | undefined;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const enteredSettingsRead = new Promise<void>((resolve) => {
      settingsReadStarted = resolve;
    });
    let delayNextSettingsRead = false;
    const runtime: Runtime = {
      ...defaultRuntime,
      async readTextFile(path) {
        if (delayNextSettingsRead && path.endsWith("/.minerva/settings.json")) {
          delayNextSettingsRead = false;
          settingsReadStarted?.();
          await settingsGate;
        }
        return defaultRuntime.readTextFile(path);
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const dataDir = tmp("minerva-prof-data-");
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: capturingProvider([]),
      runtime,
    });
    kernels.push(kernel);
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, { cwd });

    delayNextSettingsRead = true;
    const chooseWriter = client.request(MINERVA_METHODS.sessionSetProfile, {
      sessionId,
      profile: "writer",
    });
    await enteredSettingsRead;
    const clearProfile = client.request(MINERVA_METHODS.sessionSetProfile, {
      sessionId,
      profile: null,
    });
    // Let the second request reach the kernel while the first is blocked. The
    // pre-fix implementation applies this clear immediately, then lets the
    // older writer request overwrite it when the gate opens.
    await Bun.sleep(0);
    releaseSettings?.();
    await Promise.all([chooseWriter, clearProfile]);

    expect(kernel.getSession(sessionId)?.profile).toBeUndefined();
    const events = readFileSync(join(projectDir(dataDir, cwd), `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; profile?: string | null })
      .filter((event) => event.type === "session.profile_changed")
      .map((event) => event.profile);
    expect(events).toEqual(["writer", null]);
  }, 15_000);

  test("resume restores the profile by re-resolving its name against settings", async () => {
    const cwd = tmp("minerva-prof-proj-");
    const dataDir = tmp("minerva-prof-data-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    const first = boot(dataDir, []);
    await first.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await first.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
      profile: "writer",
    });
    await prompt(first, sessionId, "hello");
    await kernels.pop()?.close();

    // The prompt body is EDITED between runs; resume must pick up the edit.
    writeProjectSettings(cwd, {
      profiles: { writer: { systemPrompt: "You are WRITER v2." } },
    });
    const captured: Array<string | undefined> = [];
    const second = boot(dataDir, captured);
    await second.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const loaded = await second.request<SessionLoadResult>(AGENT_METHODS.sessionLoad, {
      sessionId,
      cwd,
    });
    expect(loaded.profile).toBe("writer");
    await prompt(second, sessionId, "again");
    expect(captured[0]).toContain("You are WRITER v2.");
  }, 15_000);

  test("a profile's default mode survives resume (creation-time mode wins over settings)", async () => {
    const cwd = tmp("minerva-prof-proj-");
    const dataDir = tmp("minerva-prof-data-");
    // The settings default differs from the profile default, so a resume that
    // fell back to settings would come back as acceptEdits instead of plan.
    writeProjectSettings(cwd, { ...PROFILE_SETTINGS, defaultMode: "acceptEdits" });
    const first = boot(dataDir, []);
    await first.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const created = await first.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
      profile: "writer",
    });
    expect(created.modes?.currentModeId).toBe("plan");
    await kernels.pop()?.close();

    const second = boot(dataDir, []);
    await second.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const loaded = await second.request<SessionLoadResult>(AGENT_METHODS.sessionLoad, {
      sessionId: created.sessionId,
      cwd,
    });
    expect(loaded.modes?.currentModeId).toBe("plan");
  }, 15_000);

  test("a vanished profile degrades to the base persona instead of bricking resume", async () => {
    const cwd = tmp("minerva-prof-proj-");
    const dataDir = tmp("minerva-prof-data-");
    writeProjectSettings(cwd, PROFILE_SETTINGS);
    const first = boot(dataDir, []);
    await first.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await first.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
      profile: "writer",
    });
    await prompt(first, sessionId, "hello");
    await kernels.pop()?.close();

    writeProjectSettings(cwd, { profiles: {} });
    const captured: Array<string | undefined> = [];
    const second = boot(dataDir, captured);
    await second.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const loaded = await second.request<SessionLoadResult>(AGENT_METHODS.sessionLoad, {
      sessionId,
      cwd,
    });
    expect(loaded.profile).toBeUndefined();
    await prompt(second, sessionId, "again");
    expect(captured[0]).toContain("You are Minerva");
  }, 15_000);

  test("profiles/list reports traits and the configured default", async () => {
    const cwd = tmp("minerva-prof-proj-");
    writeProjectSettings(cwd, { ...PROFILE_SETTINGS, profile: "writer" });
    const client = boot(tmp("minerva-prof-data-"), []);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    const result = await client.request<ProfilesListResult>(MINERVA_METHODS.profilesList, { cwd });
    expect(result.default).toBe("writer");
    expect(result.profiles).toEqual([
      {
        name: "writer",
        model: "bailian/qwen-plus",
        defaultMode: "plan",
        hasSystemPrompt: true,
      },
      { name: "minimal", hasSystemPrompt: false },
    ]);
  }, 15_000);
});
