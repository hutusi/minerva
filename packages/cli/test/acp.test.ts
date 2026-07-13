import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import {
  AGENT_METHODS,
  Connection,
  createStreamTransport,
  PROTOCOL_VERSION,
} from "@minerva/protocol";
import type { TurnEvent } from "@minerva/providers";

const CLI_DIR = join(import.meta.dir, "..");
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function spawnHost(entry: string, args: string[], env: Record<string, string>) {
  const child = spawn("bun", ["run", entry, ...args], {
    cwd: CLI_DIR,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(child);
  if (!child.stdout || !child.stdin) throw new Error("child streams missing");
  return createStreamTransport(child.stdout, child.stdin);
}

describe("minerva acp over a real process boundary", () => {
  test("scripted host: full prompt flow with permission round-trip", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-acp-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-acp-data-"));
    const turns: TurnEvent[][] = [
      [
        { type: "text-delta", text: "Checking the workspace." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "echo across-stdio" },
        },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ],
      [
        { type: "text-delta", text: "It works." },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ];
    const transport = spawnHost("test/fixtures/acp-scripted.ts", [], {
      MINERVA_DATA_DIR: dataDir,
      MINERVA_TEST_TURNS: JSON.stringify(turns),
    });

    const approved: string[] = [];
    const client = new MinervaClient(transport, {
      onPermissionRequest: async (request) => {
        approved.push(request.toolCall.title);
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });

    const init = await client.initialize();
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentCapabilities.loadSession).toBe(true);

    const { sessionId, store } = await client.newSession(cwd);
    const stopReason = await client.prompt(sessionId, "try the echo");

    expect(stopReason).toBe("end_turn");
    expect(approved).toEqual(["echo across-stdio"]);
    const tool = store.snapshot.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ status: "completed", output: "across-stdio\n" });

    client.close();
  }, 20_000);

  test("real entrypoint: `minerva acp` answers initialize and session/new", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-acp2-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-acp2-data-"));
    const transport = spawnHost("src/index.tsx", ["acp"], {
      MINERVA_DATA_DIR: dataDir,
      ANTHROPIC_API_KEY: "sk-ant-test-not-used",
    });
    const connection = new Connection(transport);

    const init = await connection.request<{ protocolVersion: number }>(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    const session = await connection.request<{
      sessionId: string;
      modes: { currentModeId: string };
    }>(AGENT_METHODS.sessionNew, { cwd });
    expect(session.sessionId).toStartWith("ses_");
    expect(session.modes.currentModeId).toBe("default");

    connection.close();
  }, 20_000);

  // Every provider key scrubbed: blank env values count as absent.
  const NO_KEYS = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", DASHSCOPE_API_KEY: "" };

  test("real entrypoint: keyless `acp --allow-unconfigured` still hosts the protocol", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-acp3-data-"));
    const transport = spawnHost("src/index.tsx", ["acp", "--allow-unconfigured"], {
      MINERVA_DATA_DIR: dataDir,
      ...NO_KEYS,
    });
    const connection = new Connection(transport);

    // The GUI host's first-run flow: the kernel must be reachable before any
    // key exists so the config dialog can drive minerva/config/set_model.
    const init = await connection.request<{ protocolVersion: number }>(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    connection.close();
  }, 20_000);

  test("real entrypoint: keyless `acp` without the flag exits nonzero", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-acp4-data-"));
    const child = spawn("bun", ["run", "src/index.tsx", "acp"], {
      cwd: CLI_DIR,
      env: { ...process.env, MINERVA_DATA_DIR: dataDir, ...NO_KEYS },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.push(child);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
  }, 20_000);
});
