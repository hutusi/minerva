import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  type SessionUpdateParams,
} from "@minerva/protocol";
import type { ModelProvider, TurnEvent } from "@minerva/providers";
import { createScriptedProvider } from "@minerva/providers";
import {
  bashTool,
  chunkReplayUpdates,
  createKernel,
  defaultRuntime,
  editFileTool,
  globTool,
  grepTool,
  loadSettings,
  migrateDataDirPermissions,
  parseEventLog,
  persistAllowRule,
  projectDir,
  type Runtime,
  readFileTool,
  replayEvents,
  Session,
  type SessionEvent,
  todoTool,
  writeFileTool,
} from "../src";

const FINISH_TOOLS: TurnEvent = { type: "finish", finishReason: "tool-calls", usage: {} };
const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };

function harness(provider: ModelProvider) {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-gaps-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-gaps-data-"));
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, { dataDir, provider });
  const client = new Connection(clientTransport);
  const updates: SessionUpdateParams[] = [];
  client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
    updates.push(params as SessionUpdateParams);
  });
  client.handleRequest(CLIENT_METHODS.sessionRequestPermission, () => ({
    outcome: { outcome: "selected", optionId: "allow" },
  }));
  return { cwd, kernel, client, updates };
}

describe("tool titles", () => {
  test("every built-in produces a human title from valid input", () => {
    expect(readFileTool.title({ path: "a.ts" })).toBe("Read a.ts");
    expect(writeFileTool.title({ path: "b.ts" })).toBe("Write b.ts");
    expect(editFileTool.title({ path: "c.ts" })).toBe("Edit c.ts");
    expect(globTool.title({ pattern: "**/*.ts" })).toBe("Glob **/*.ts");
    expect(grepTool.title({ pattern: "TODO" })).toBe("Grep /TODO/");
    expect(bashTool.title({ command: "ls -la" })).toBe("ls -la");
    expect(todoTool.title({ todos: [{ content: "x", status: "completed" }] })).toBe(
      "Update todos (1/1 done)",
    );
  });

  test("titles throw on malformed input (the loop falls back to the tool name)", () => {
    expect(() => bashTool.title({})).toThrow();
    expect(() => todoTool.title({ todos: "nope" })).toThrow();
  });
});

describe("runtime + settings edges", () => {
  test("exec rejects when the spawn itself fails (bad cwd)", async () => {
    await expect(
      defaultRuntime.exec("echo hi", { cwd: "/nonexistent-dir-xyz", timeoutMs: 5000 }),
    ).rejects.toThrow();
  });

  test("todo_write without a loop hook fails loudly", async () => {
    await expect(
      todoTool.execute(
        { todos: [] },
        { cwd: mkdtempSync(join(tmpdir(), "gaps-")), runtime: defaultRuntime },
      ),
    ).rejects.toThrow("not available");
  });

  test("corrupt settings JSON fails loudly instead of silently dropping rules", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-settings-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(join(cwd, ".minerva", "settings.json"), "{not json");
    await expect(
      loadSettings(defaultRuntime, mkdtempSync(join(tmpdir(), "gaps-data-")), cwd),
    ).rejects.toThrow("invalid JSON");
  });

  test("an unreadable settings file fails loudly instead of dropping the deny list", async () => {
    // A permissions/IO error (not a missing file) must not be mistaken for
    // "no settings" — that would silently run with an empty deny list.
    const eaccesRuntime: Runtime = {
      ...defaultRuntime,
      readTextFile: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
    };
    await expect(
      loadSettings(
        eaccesRuntime,
        mkdtempSync(join(tmpdir(), "gaps-data-")),
        mkdtempSync(join(tmpdir(), "gaps-cwd-")),
      ),
    ).rejects.toThrow("cannot read settings");
  });

  test("a missing settings file still yields defaults (ENOENT is normal)", async () => {
    const settings = await loadSettings(
      defaultRuntime,
      mkdtempSync(join(tmpdir(), "gaps-data-")),
      mkdtempSync(join(tmpdir(), "gaps-empty-")),
    );
    expect(settings.rules).toEqual({ allow: [], deny: [], ask: [] });
  });

  test("a string permission field fails closed instead of spreading into chars", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-badperm-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({ permissions: { deny: "bash" } }),
    );
    await expect(
      loadSettings(defaultRuntime, mkdtempSync(join(tmpdir(), "gaps-data-")), cwd),
    ).rejects.toThrow("permissions.deny must be an array of strings");
  });

  test("a non-string element in a permission array fails closed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-badperm2-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({ permissions: { allow: [1, 2] } }),
    );
    await expect(
      loadSettings(defaultRuntime, mkdtempSync(join(tmpdir(), "gaps-data-")), cwd),
    ).rejects.toThrow("permissions.allow must be an array of strings");
  });

  test("well-formed permission arrays still load", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-goodperm-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({ permissions: { deny: ["bash(rm -rf *)"] } }),
    );
    const settings = await loadSettings(
      defaultRuntime,
      mkdtempSync(join(tmpdir(), "gaps-data-")),
      cwd,
    );
    expect(settings.rules.deny).toContain("bash(rm -rf *)");
  });
});

describe("sessions/list edges", () => {
  test("an unreadable session index surfaces instead of reporting no sessions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-list-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-list-data-"));
    // Fail only the index read; everything else (settings, logs) is normal.
    const flakyRuntime: Runtime = {
      ...defaultRuntime,
      readTextFile: (path) =>
        path.endsWith("index.jsonl")
          ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
          : defaultRuntime.readTextFile(path),
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([]),
      runtime: flakyRuntime,
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    await expect(client.request("minerva/sessions/list", { cwd })).rejects.toThrow(
      "cannot read session index",
    );
  });

  test("a resumed session sorts most-recent, with its preview served from the index", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-mru-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-mru-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [{ type: "text-delta", text: "a" }, FINISH_STOP],
        [{ type: "text-delta", text: "b" }, FINISH_STOP],
      ]),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    const { sessionId: a } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId: a,
      prompt: [{ type: "text", text: "first prompt for A" }],
    });
    const { sessionId: b } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId: b,
      prompt: [{ type: "text", text: "prompt for B" }],
    });
    // Resuming A must move it to the front of the most-recently-used list.
    await client.request(AGENT_METHODS.sessionLoad, { sessionId: a, cwd });

    const { sessions } = await client.request<{
      sessions: Array<{ sessionId: string; preview?: string }>;
    }>("minerva/sessions/list", { cwd });
    expect(sessions.map((s) => s.sessionId)).toEqual([a, b]);
    expect(sessions[0]?.preview).toContain("first prompt for A");
  });

  test("a missing session index lists nothing (ENOENT is normal)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-list2-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-list2-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    const result = await client.request<{ sessions: unknown[] }>("minerva/sessions/list", { cwd });
    expect(result.sessions).toEqual([]);
  });
});

describe("ACP replay compatibility", () => {
  test("a generic client (no batch capability) gets standard session/update replay", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-acp-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-acp-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([[{ type: "text-delta", text: "hi there" }, FINISH_STOP]]),
    });
    const client = new Connection(clientTransport);
    const individual: string[] = [];
    let batches = 0;
    client.handleNotification(CLIENT_METHODS.sessionUpdate, (p) => {
      individual.push((p as SessionUpdateParams).update.sessionUpdate);
    });
    client.handleNotification("minerva/session/update_batch", () => {
      batches += 1;
    });
    // Initialize WITHOUT advertising batchReplay — a stock ACP client.
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    individual.length = 0;
    await client.request(AGENT_METHODS.sessionLoad, { sessionId, cwd });
    // Replay arrived as standard notifications, not the custom batch.
    expect(batches).toBe(0);
    expect(individual).toContain("user_message_chunk");
    expect(individual).toContain("agent_message_chunk");
  });

  test("replay batches stay under the frame cap without dropping updates", () => {
    // ~1 MB per update, so a handful crosses the 4 MB batch budget and must
    // split — the failure mode is a stdio client disconnecting on one huge batch.
    const big = "x".repeat(1024 * 1024);
    const updates = Array.from({ length: 6 }, (_, i) => ({ n: i, payload: big }));
    const chunks = chunkReplayUpdates(updates);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk), "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    // The batches are additive: concatenated, they reproduce the transcript
    // exactly (same order, nothing lost or duplicated).
    expect(chunks.flat()).toEqual(updates);
  });

  test("an update larger than the budget still ships alone", () => {
    const huge = { payload: "y".repeat(5 * 1024 * 1024) };
    const chunks = chunkReplayUpdates([{ small: 1 }, huge]);
    expect(chunks.flat()).toEqual([{ small: 1 }, huge]);
    // The oversized update can't be split, but it isn't dropped or merged.
    expect(chunks.some((c) => c.length === 1 && c[0] === huge)).toBe(true);
  });
});

describe("session store hardening", () => {
  test("a traversal session id is rejected before touching the filesystem", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-trav-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-trav-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    await expect(
      client.request(AGENT_METHODS.sessionLoad, { sessionId: "../../../outside", cwd }),
    ).rejects.toThrow("invalid session id");
  });

  test("new session logs and index are created owner-only (0600)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-mode-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-mode-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([]),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    const session = kernel.getSession(sessionId);
    await session?.flush();

    const logPath = session?.logPath as string;
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(projectDir(dataDir, cwd), "index.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(projectDir(dataDir, cwd)).mode & 0o777).toBe(0o700);
  });

  test("migration tightens a pre-existing world-readable log", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-mig-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-mig-data-"));
    const dir = projectDir(dataDir, cwd);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "ses_old.jsonl");
    writeFileSync(stale, "{}\n");
    chmodSync(stale, 0o644);

    await migrateDataDirPermissions(defaultRuntime, dataDir);
    expect(statSync(stale).mode & 0o777).toBe(0o600);
  });
});

describe("session reload durability", () => {
  test("a failed pending write surfaces on reload instead of a silent stale rebuild", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-reload-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-reload-data-"));
    let failAppends = false;
    const flakyRuntime: Runtime = {
      ...defaultRuntime,
      appendTextFile: (path, content) =>
        failAppends && path.endsWith(".jsonl") && !path.endsWith("index.jsonl")
          ? Promise.reject(new Error("disk full"))
          : defaultRuntime.appendTextFile(path, content),
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([]),
      runtime: flakyRuntime,
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    // Queue an append that will fail, without flushing it, then reload.
    failAppends = true;
    kernel.getSession(sessionId)?.append({ type: "user.message", text: "lost?", at: "t" });

    await expect(client.request(AGENT_METHODS.sessionLoad, { sessionId, cwd })).rejects.toThrow(
      "pending writes failed",
    );
  });

  test("close() flushes a session's pending appends to disk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-close-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-close-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    // A fire-and-forget append with no explicit flush (as happens for a model
    // switch right before quitting).
    const session = kernel.getSession(sessionId);
    session?.append({ type: "session.model_changed", provider: "other", at: "t" });

    await kernel.close();

    const logPath = session?.logPath as string;
    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    expect(events.some((e) => e.type === "session.model_changed")).toBe(true);
  });
});

describe("settings + index write hardening", () => {
  test("concurrent allow-rule persists do not clobber each other", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-persist-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-persist-data-"));
    // Fired concurrently, an unlocked read-modify-write would lose one rule.
    await Promise.all([
      persistAllowRule(defaultRuntime, cwd, "bash(git status)"),
      persistAllowRule(defaultRuntime, cwd, "bash(ls)"),
    ]);
    const settings = await loadSettings(defaultRuntime, dataDir, cwd);
    expect(settings.rules.allow).toContain("bash(git status)");
    expect(settings.rules.allow).toContain("bash(ls)");
  });

  test("the session index compacts once it grows past the threshold", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-index-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-index-data-"));
    const opts = { cwd, dataDir, providerId: "test", runtime: defaultRuntime };
    const session = await Session.create(opts);
    await session.flush(); // ensure the session log exists for the reload

    const indexPath = join(projectDir(dataDir, cwd), "index.jsonl");
    const bloat = `${Array.from({ length: 600 }, () =>
      JSON.stringify({ sessionId: session.id, cwd, createdAt: "t" }),
    ).join("\n")}\n`;
    writeFileSync(indexPath, bloat);

    // A resume triggers the opportunistic compaction on the next index write.
    await Session.load(session.id, opts, []);
    const lines = readFileSync(indexPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.trim());
    // All entries share one session id, so compaction collapses them to one.
    expect(lines).toHaveLength(1);
  });
});

describe("shutdown draining", () => {
  test("close() cancels and drains an in-flight prompt, persisting its trailing events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-drain-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-drain-data-"));
    // Streams a chunk, then blocks until the turn is cancelled, then finishes.
    const blockingProvider: ModelProvider = {
      id: "blocking",
      async *streamTurn(request) {
        yield { type: "text-delta", text: "working" } as const;
        await new Promise<void>((res) => {
          if (request.abortSignal?.aborted) return res();
          request.abortSignal?.addEventListener("abort", () => res(), { once: true });
        });
        yield { type: "finish", finishReason: "stop", usage: {} } as const;
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: blockingProvider });
    const client = new Connection(clientTransport);
    const updates: SessionUpdateParams[] = [];
    client.handleNotification(CLIENT_METHODS.sessionUpdate, (p) => {
      updates.push(p as SessionUpdateParams);
    });
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    // Fire the prompt without awaiting; it will block mid-stream.
    const pending = client
      .request(AGENT_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "go" }] })
      .catch(() => {});
    // Wait until it has actually started streaming.
    for (
      let i = 0;
      i < 100 && !updates.some((u) => u.update.sessionUpdate === "agent_message_chunk");
      i++
    ) {
      await Bun.sleep(5);
    }

    await kernel.close();
    await pending;

    const session = kernel.getSession(sessionId);
    expect(session?.promptActive).toBe(false);
    const events = readFileSync(session?.logPath as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    // The partial answer and the terminal turn event survived shutdown.
    expect(events.some((e) => e.type === "assistant.message")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  test("a provider that ignores abort cannot hang shutdown; the timeout is reported", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-stuck-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-stuck-data-"));
    const stuckProvider: ModelProvider = {
      id: "stuck",
      async *streamTurn() {
        yield { type: "text-delta", text: "working" } as const;
        await new Promise<void>(() => {}); // never resolves — ignores the abort
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: stuckProvider,
      shutdownDrainMs: 20,
    });
    const client = new Connection(clientTransport);
    const updates: SessionUpdateParams[] = [];
    client.handleNotification(CLIENT_METHODS.sessionUpdate, (p) => {
      updates.push(p as SessionUpdateParams);
    });
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    const pending = client
      .request(AGENT_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "go" }] })
      .catch(() => {});
    for (
      let i = 0;
      i < 100 && !updates.some((u) => u.update.sessionUpdate === "agent_message_chunk");
      i++
    ) {
      await Bun.sleep(5);
    }

    const started = Date.now();
    // Bounded by shutdownDrainMs, and the unfinished drain is reported.
    await expect(kernel.close()).rejects.toThrow(/shutdown incomplete/);
    expect(Date.now() - started).toBeLessThan(1000);
    await pending;
  });

  test("a failed session flush makes close() reject with an aggregate durability error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-durab-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-durab-data-"));
    let failAppends = false;
    const flakyRuntime: Runtime = {
      ...defaultRuntime,
      appendTextFile: (path, content) =>
        failAppends && path.endsWith(".jsonl") && !path.endsWith("index.jsonl")
          ? Promise.reject(new Error("disk full"))
          : defaultRuntime.appendTextFile(path, content),
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([]),
      runtime: flakyRuntime,
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });

    failAppends = true;
    kernel.getSession(sessionId)?.append({ type: "user.message", text: "lost?", at: "t" });

    await expect(kernel.close()).rejects.toThrow(/shutdown incomplete/);
  });
});

describe("shutdown handler gating", () => {
  // A runtime whose first mkdirp blocks on a gate, so a session/new can be held
  // inside Session.create while the test drives close() concurrently.
  function gatedKernel() {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-gate-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "gaps-gate-data-"));
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let firstMkdir = true;
    const runtime: Runtime = {
      ...defaultRuntime,
      mkdirp: async (path) => {
        if (firstMkdir) {
          firstMkdir = false;
          await gate;
        }
        return defaultRuntime.mkdirp(path);
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([]),
      runtime,
    });
    const client = new Connection(clientTransport);
    return { cwd, kernel, client, release };
  }

  test("a request arriving during shutdown is rejected", async () => {
    const { cwd, kernel, client, release } = gatedKernel();
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    // Hold one session/new inside Session.create so close() stays mid-drain
    // (transport still open) while we send a second request.
    const held = client.request(AGENT_METHODS.sessionNew, { cwd });
    await Bun.sleep(10);
    const closePromise = kernel.close(); // synchronously sets #closed = true

    await expect(client.request(AGENT_METHODS.sessionNew, { cwd })).rejects.toThrow(
      "shutting down",
    );

    release();
    await closePromise;
    await held.catch(() => {});
  });

  test("an in-flight session/new is drained and flushed before close() returns", async () => {
    const { cwd, kernel, client, release } = gatedKernel();
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });

    const newPromise = client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, { cwd });
    await Bun.sleep(10); // ensure session/new is in-flight and blocked
    const closePromise = kernel.close();
    release(); // let session/new finish while close() drains it
    await closePromise;

    const { sessionId } = await newPromise;
    const session = kernel.getSession(sessionId);
    const events = readFileSync(session?.logPath as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    expect(events.some((e) => e.type === "session.created")).toBe(true);
  });
});

describe("event log parsing", () => {
  const line = (event: object) => JSON.stringify(event);
  const userMsg = { type: "user.message", text: "hi", at: "t" };
  const turnDone = { type: "turn.completed", stopReason: "end_turn", at: "t" };

  test("a torn final line is tolerated (kill -9 mid-write)", () => {
    const raw = `${line(userMsg)}\n${line(turnDone)}\n{"type":"assistant.mess`;
    const events = parseEventLog(raw);
    expect(events.map((e) => e.type)).toEqual(["user.message", "turn.completed"]);
  });

  test("corruption in the middle of the log fails loudly", () => {
    const raw = `${line(userMsg)}\n{"type":"assistant.mess\n${line(turnDone)}`;
    expect(() => parseEventLog(raw)).toThrow("corrupt session event log at line 2");
  });

  test("a clean log with a trailing newline parses fully", () => {
    const raw = `${line(userMsg)}\n${line(turnDone)}\n`;
    expect(parseEventLog(raw).map((e) => e.type)).toEqual(["user.message", "turn.completed"]);
  });

  test("a fully-written malformed final line is corruption, not a torn write", () => {
    // Ends with a newline, so the bad line was completely flushed — that's
    // real corruption, unlike an unterminated fragment.
    const raw = `${line(userMsg)}\n${line(turnDone)}\n{bad\n`;
    expect(() => parseEventLog(raw)).toThrow("corrupt session event log at line 3");
  });
});

describe("agent loop edges", () => {
  test("an unknown tool becomes an error result and the loop continues", async () => {
    const h = harness(
      createScriptedProvider([
        [{ type: "tool-call", toolCallId: "c1", toolName: "not_a_tool", input: {} }, FINISH_TOOLS],
        [{ type: "text-delta", text: "recovered" }, FINISH_STOP],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    const result = await h.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "call something fake" }],
    });
    expect(result.stopReason).toBe("end_turn");
    const failed = h.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
    );
    expect(JSON.stringify(failed)).toContain("Unknown tool");
  });

  test("a tool that throws mid-execution fails that call, not the turn", async () => {
    const h = harness(
      createScriptedProvider([
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "does-not-exist.txt" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "noted" }, FINISH_STOP],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    const result = await h.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "read the missing file" }],
    });
    expect(result.stopReason).toBe("end_turn");
    const failed = h.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
    );
    expect(failed).toBeDefined();
  });

  test("a provider error fails the prompt and logs turn.failed", async () => {
    const h = harness(
      createScriptedProvider([
        [{ type: "error", error: new Error("model exploded") } as TurnEvent],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    await expect(
      h.client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "boom" }],
      }),
    ).rejects.toThrow("model exploded");

    const session = h.kernel.getSession(sessionId);
    if (!session) throw new Error("missing session");
    await session.flush();
    const events = readFileSync(session.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "model exploded" });
  });

  test("a first-token failure leaves no dangling user message (retry alternates)", async () => {
    const h = harness(
      createScriptedProvider([
        [{ type: "error", error: new Error("rate limited") } as TurnEvent],
        [{ type: "text-delta", text: "recovered" }, FINISH_STOP],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    await expect(
      h.client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      }),
    ).rejects.toThrow("rate limited");

    const session = h.kernel.getSession(sessionId);
    // The failed turn's user prompt was rolled out of provider context.
    expect(session?.messages.at(-1)?.role).not.toBe("user");

    // A retry sends a single user message, not [user, user].
    await h.client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "go again" }],
    });
    expect(session?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("a stream that throws after streaming persists the partial output", async () => {
    const throwingProvider: ModelProvider = {
      id: "throwing",
      async *streamTurn() {
        yield { type: "text-delta", text: "partial answer" } as const;
        yield { type: "reasoning-delta", text: "half a thought" } as const;
        throw new Error("stream reset");
      },
    };
    const h = harness(throwingProvider);
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    await expect(
      h.client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "boom" }],
      }),
    ).rejects.toThrow("stream reset");

    const session = h.kernel.getSession(sessionId);
    if (!session) throw new Error("missing session");
    await session.flush();
    const events = readFileSync(session.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    const types = events.map((e) => e.type);
    // Everything streamed to the UI is recorded, in stream order, before the
    // terminal turn.failed.
    expect(types).toEqual([
      "session.created",
      "user.message",
      "assistant.message",
      "assistant.thought",
      "turn.failed",
    ]);
    expect(events.find((e) => e.type === "assistant.message")).toMatchObject({
      text: "partial answer",
    });
    expect(events.find((e) => e.type === "assistant.thought")).toMatchObject({
      text: "half a thought",
    });
  });

  test("a stream error after a tool call synthesizes results before failing", async () => {
    const h = harness(
      createScriptedProvider([
        [
          { type: "text-delta", text: "starting" },
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "echo hi" } },
          { type: "error", error: new Error("boom") } as TurnEvent,
        ],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    await expect(
      h.client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      }),
    ).rejects.toThrow("boom");

    // The recorded assistant message carried a tool call that never ran; its
    // batch is resolved so the live history has no dangling tool use.
    const session = h.kernel.getSession(sessionId);
    expect(session?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(session?.messages.at(-1))).toContain(
      "interrupted by a model stream error",
    );
  });

  test("cancelling mid-turn synthesizes results for pending tool calls", async () => {
    let cancelNow: (() => void) | undefined;
    const slowProvider: ModelProvider = {
      id: "slow",
      async *streamTurn() {
        yield { type: "text-delta", text: "working" } as const;
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "echo never-runs" },
        } as const;
        // Signal the test to cancel, then let the cancellation land before
        // the stream finishes.
        cancelNow?.();
        await Bun.sleep(80);
        yield { type: "finish", finishReason: "tool-calls", usage: {} } as const;
      },
    };
    const h = harness(slowProvider);
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    cancelNow = () => h.client.notify(AGENT_METHODS.sessionCancel, { sessionId });

    const result = await h.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "start something slow" }],
    });
    expect(result.stopReason).toBe("cancelled");

    // The assistant message with its tool call was recorded, and the batch
    // got synthesized cancelled results — no dangling tool_use.
    const session = h.kernel.getSession(sessionId);
    expect(session?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(session?.messages.at(-1))).toContain("cancelled");
  });
});

describe("replay edges", () => {
  test("orphan tool results and unknown events are tolerated", () => {
    const events = [
      { type: "user.message", text: "hi", at: "t" },
      // Result with no expected call (foreign log shape).
      { type: "tool.result", toolCallId: "ghost", output: "x", isError: false, at: "t" },
      // Unknown future event type must not crash replay.
      { type: "someday.new_event", at: "t" } as unknown,
      // A tool.call for a tool that no longer exists → title falls back.
      {
        type: "assistant.message",
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "gone_tool", input: {} }],
        at: "t",
      },
      { type: "tool.call", toolCallId: "c1", toolName: "gone_tool", input: {}, at: "t" },
      { type: "tool.result", toolCallId: "c1", output: "ok", isError: false, at: "t" },
    ] as SessionEvent[];

    const replay = replayEvents(events, []);
    expect(replay.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const toolStart = replay.updates.find((u) => u.sessionUpdate === "tool_call");
    expect(toolStart).toMatchObject({ title: "gone_tool" });
  });

  test("a failed turn's unanswered user is dropped on replay (no [user,user] retry)", () => {
    const events = [
      { type: "session.created", sessionId: "ses_x", cwd: "/x", provider: "p", at: "t" },
      { type: "user.message", text: "boom", at: "t" },
      { type: "turn.failed", error: "rate limited", at: "t" },
    ] as SessionEvent[];
    const replay = replayEvents(events, []);
    // Provider context has no trailing user (a retry would send a single user).
    expect(replay.messages).toHaveLength(0);
    // The UI transcript still shows the prompt.
    expect(replay.updates.some((u) => u.sessionUpdate === "user_message_chunk")).toBe(true);
  });

  test("a partial-output failed turn keeps its assistant message on replay", () => {
    const events = [
      { type: "user.message", text: "hi", at: "t" },
      { type: "assistant.message", text: "partial", toolCalls: [], at: "t" },
      { type: "turn.failed", error: "dropped mid-stream", at: "t" },
    ] as SessionEvent[];
    const replay = replayEvents(events, []);
    expect(replay.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("cumulative usage sums completed turns and survives compaction", () => {
    const events = [
      { type: "user.message", text: "hi", at: "t" },
      {
        type: "turn.completed",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 },
        at: "t",
      },
      // Old logs predate usage on turn.completed — they contribute nothing.
      { type: "turn.completed", stopReason: "end_turn", at: "t" },
      // Compaction resets the model context, not the session's spend, and its
      // own summarization turn's tokens survive resume.
      {
        type: "session.compacted",
        summary: "so far",
        usage: { inputTokens: 7, outputTokens: 3 },
        at: "t",
      },
      { type: "user.message", text: "more", at: "t" },
      {
        type: "turn.completed",
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 8 },
        at: "t",
      },
    ] as SessionEvent[];

    const replay = replayEvents(events, []);
    // 10+20 from the two turns, plus 7 from the compaction turn.
    expect(replay.usage).toEqual({
      inputTokens: 37,
      outputTokens: 16,
      cacheReadTokens: 100,
      cacheWriteTokens: undefined,
    });
  });
});
