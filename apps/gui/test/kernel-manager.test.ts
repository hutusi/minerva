import { describe, expect, test } from "bun:test";
import type { JsonRpcRequest } from "@minerva/protocol";
import { createKernelManager } from "../src/lib/kernel-manager";
import type { SidecarBridge } from "../src/lib/sidecar-bridge";

/** Fake bridge that answers like a kernel: initialize + minerva/config/state.
 * `alive` controls whether a (re)start boots a responsive kernel. */
function createFakeKernelBridge() {
  const lineHandlers = new Set<(line: string) => void>();
  const exitHandlers = new Set<(code: number | null) => void>();
  let nextStartGate: Promise<void> | null = null;
  const respond = (message: unknown) => {
    queueMicrotask(() => {
      for (const handler of lineHandlers) handler(JSON.stringify(message));
    });
  };
  const bridge = {
    starts: 0,
    kills: 0,
    alive: true,
    /** True = accept writes but never answer (a wedged kernel). */
    mute: false,
    async start() {
      bridge.starts++;
      if (!bridge.alive) throw new Error("spawn failed");
      const gate = nextStartGate;
      nextStartGate = null;
      if (gate) await gate;
    },
    async send(line: string) {
      if (!bridge.alive) throw new Error("kernel is not running");
      if (bridge.mute) return;
      const message = JSON.parse(line) as JsonRpcRequest;
      if (!("id" in message)) return;
      if (message.method === "initialize") {
        respond({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "minerva/config/state") {
        respond({
          jsonrpc: "2.0",
          id: message.id,
          result: { model: "acme/one", needsApiKey: false, providers: [] },
        });
      } else if (message.method === "session/prompt") {
        // Held open forever — lets tests park a request across a crash.
      } else {
        respond({ jsonrpc: "2.0", id: message.id, result: null });
      }
    },
    async kill() {
      // Contract with the real bridge: an intentional kill resolves once the
      // child is gone and emits NO exit event (the Rust side is
      // generation-guarded), so crash recovery never fires for it.
      bridge.kills++;
    },
    onLine(handler: (line: string) => void) {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onExit(handler: (code: number | null) => void) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    crash(code: number) {
      for (const handler of [...exitHandlers]) handler(code);
    },
    blockNextStart(gate: Promise<void>) {
      nextStartGate = gate;
    },
    lineHandlerCount() {
      return lineHandlers.size;
    },
  } satisfies SidecarBridge & Record<string, unknown>;
  return bridge;
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("createKernelManager", () => {
  test("start reaches ready with a client and config", async () => {
    const bridge = createFakeKernelBridge();
    const manager = createKernelManager(bridge);
    const phases: string[] = [];
    manager.subscribe(() => phases.push(manager.snapshot.phase));
    manager.start();
    await until(() => manager.snapshot.phase === "ready", "ready");
    expect(manager.snapshot.client).not.toBeNull();
    expect(manager.snapshot.config?.model).toBe("acme/one");
    expect(phases.at(-1)).toBe("ready");
    // start() is a no-op while live — no second spawn.
    manager.start();
    expect(bridge.starts).toBe(1);
  });

  test("one crash auto-restarts with a fresh client; pending permissions cancel", async () => {
    const bridge = createFakeKernelBridge();
    const manager = createKernelManager(bridge);
    manager.start();
    await until(() => manager.snapshot.phase === "ready", "ready");
    const firstClient = manager.snapshot.client;

    const pending = manager.permissions.handler({
      sessionId: "ses_x",
      toolCall: { toolCallId: "t1", title: "write file", kind: "edit" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    bridge.crash(1);
    expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
    await until(() => manager.snapshot.phase === "ready", "auto-restart ready");
    expect(bridge.starts).toBe(2);
    // Recovery must build a fresh client — the old Connection is dead.
    expect(manager.snapshot.client).not.toBe(firstClient);
  });

  test("an exit during start supersedes the attempt before it creates a client", async () => {
    const bridge = createFakeKernelBridge();
    let releaseStart: (() => void) | undefined;
    bridge.blockNextStart(
      new Promise<void>((resolve) => {
        releaseStart = resolve;
      }),
    );
    const manager = createKernelManager(bridge);
    manager.start();
    await until(() => bridge.starts === 1, "blocked first start");

    bridge.crash(1);
    await until(() => manager.snapshot.phase === "ready", "replacement ready");
    releaseStart?.();
    await Bun.sleep(0);

    // Only the replacement attempt owns a transport. Without the post-start
    // generation check, the superseded attempt attaches a leaked second one.
    expect(bridge.lineHandlerCount()).toBe(1);
  });

  test("a second crash stays down until a manual start", async () => {
    const bridge = createFakeKernelBridge();
    const manager = createKernelManager(bridge);
    manager.start();
    await until(() => manager.snapshot.phase === "ready", "ready");
    bridge.crash(1);
    await until(() => manager.snapshot.phase === "ready", "auto-restart");
    bridge.crash(9);
    expect(manager.snapshot.phase).toBe("down");
    expect(manager.snapshot.exitCode).toBe(9);

    manager.start();
    await until(() => manager.snapshot.phase === "ready", "manual restart");
    expect(bridge.starts).toBe(3);
  });

  test("a spawn failure lands in down with the error", async () => {
    const bridge = createFakeKernelBridge();
    bridge.alive = false;
    const manager = createKernelManager(bridge);
    manager.start();
    await until(() => manager.snapshot.phase === "down", "down");
    expect(manager.snapshot.error).toContain("spawn failed");
  });

  test("a hung handshake times out to down and kills the wedged kernel", async () => {
    const bridge = createFakeKernelBridge();
    bridge.mute = true;
    const manager = createKernelManager(bridge, { handshakeTimeoutMs: 20 });
    manager.start();
    await until(() => manager.snapshot.phase === "down", "handshake timeout");
    expect(manager.snapshot.error).toContain("did not respond");
    expect(bridge.kills).toBe(1);

    // The manual restart escape hatch works once the kernel behaves.
    bridge.mute = false;
    manager.start();
    await until(() => manager.snapshot.phase === "ready", "recovery after timeout");
  });
});
