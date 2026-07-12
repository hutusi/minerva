import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  Connection,
  createInProcTransportPair,
  MINERVA_METHODS,
} from "@minerva/protocol";
import { createScriptedProvider } from "@minerva/providers";
import { createKernel, defaultRuntime, parseEventLog, Session } from "../src";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const ONE_TURN = [
  [
    { type: "text-delta" as const, text: "ok" },
    { type: "finish" as const, finishReason: "stop" as const, usage: {} },
  ],
];

describe("prompt lease concurrency", () => {
  test("two same-tick prompts: exactly one runs, the other is rejected", async () => {
    const cwd = tmp("minerva-lease-proj-");
    const dataDir = tmp("minerva-lease-data-");
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    // Two scripts so a pre-fix double-run fails on assertions, not provider
    // exhaustion.
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([...ONE_TURN, ...ONE_TURN]),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    // Fire both in the same tick — no await between the two sends.
    const settled = await Promise.allSettled([
      client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "first" }],
      }),
      client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "second" }],
      }),
    ]);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "a prompt is already running",
    );

    const session = kernel.getSession(sessionId);
    if (!session) throw new Error("session missing");
    await session.flush();
    const events = parseEventLog(readFileSync(session.logPath, "utf8"));
    expect(events.filter((e) => e.type === "user.message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    await kernel.close();
  }, 15_000);

  test("same-tick prompt + compact: compact is rejected, no compaction event", async () => {
    const cwd = tmp("minerva-lease-proj-");
    const dataDir = tmp("minerva-lease-data-");
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([...ONE_TURN, ...ONE_TURN]),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    // Compact requires history; run one prompt to completion first.
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "warmup" }],
    });

    const settled = await Promise.allSettled([
      client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      }),
      client.request(MINERVA_METHODS.sessionCompact, { sessionId }),
    ]);
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("rejected");
    expect(String((settled[1] as PromiseRejectedResult).reason)).toContain(
      "cannot compact while a prompt is running",
    );

    const session = kernel.getSession(sessionId);
    if (!session) throw new Error("session missing");
    await session.flush();
    const events = parseEventLog(readFileSync(session.logPath, "utf8"));
    expect(events.some((e) => e.type === "session.compacted")).toBe(false);
    await kernel.close();
  }, 15_000);

  test("a throwing host systemPrompt does not leak the lease", async () => {
    const cwd = tmp("minerva-lease-proj-");
    const dataDir = tmp("minerva-lease-data-");
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    let calls = 0;
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([...ONE_TURN]),
      // Host-supplied callbacks are outside our control: the first call
      // blows up, the retry works — the session must survive the first.
      systemPrompt: (promptCwd) => {
        calls++;
        if (calls === 1) throw new Error("system boom");
        return `You are Minerva. Working directory: ${promptCwd}.`;
      },
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    expect(
      client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "first" }],
      }),
    ).rejects.toThrow("system boom");

    const retry = await client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "second" }],
    });
    expect(retry.stopReason).toBe("end_turn");
    await kernel.close();
  }, 15_000);

  test("beginPrompt throws while active and works again after endPrompt", async () => {
    const cwd = tmp("minerva-lease-proj-");
    const dataDir = tmp("minerva-lease-data-");
    const session = await Session.create({
      cwd,
      dataDir,
      providerId: "test/x",
      runtime: defaultRuntime,
    });
    session.beginPrompt();
    expect(() => session.beginPrompt()).toThrow("a prompt is already running");
    session.endPrompt();
    expect(() => session.beginPrompt()).not.toThrow();
    session.endPrompt();
    await session.flush();
  });
});
