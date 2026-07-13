import { MinervaClient } from "@minerva/client";
import type { ConfigStateResult } from "@minerva/protocol";
import { createPermissionQueue, type PermissionQueue } from "./permission-queue";
import type { SidecarBridge } from "./sidecar-bridge";
import { createSidecarTransport } from "./tauri-transport";

type KernelPhase = "starting" | "ready" | "restarting" | "down";

interface KernelSnapshot {
  phase: KernelPhase;
  /** Non-null only when ready. Identity changes on every restart — a dead
   * Connection's pending state is unrecoverable, so recovery builds a fresh
   * client and consumers must re-load sessions against it. */
  client: MinervaClient | null;
  config: ConfigStateResult | null;
  /** The kernel's last exit code, while restarting/down. */
  exitCode: number | null;
  /** Startup failure detail, when down. */
  error: string | null;
}

export interface KernelManager {
  /** One queue across restarts: the dialog survives, requests don't. */
  permissions: PermissionQueue;
  subscribe(listener: () => void): () => void;
  readonly snapshot: KernelSnapshot;
  /** Begin connecting, or manually retry from "down". No-op while live. */
  start(): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`kernel did not respond within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/**
 * Owns the kernel lifecycle on the webview side: spawn (via the bridge),
 * client construction, and crash recovery. One automatic respawn per death —
 * a kernel that dies twice in a row stays down until the user retries, so a
 * crash loop can't spin. All policy is here; the Rust side is a dumb pipe.
 */
export function createKernelManager(
  bridge: SidecarBridge,
  options: { handshakeTimeoutMs?: number } = {},
): KernelManager {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
  const permissions = createPermissionQueue();
  const listeners = new Set<() => void>();
  let snapshot: KernelSnapshot = {
    phase: "starting",
    client: null,
    config: null,
    exitCode: null,
    error: null,
  };
  let started = false;
  let autoRestarts = 0;
  let generation = 0;

  const update = (patch: Partial<KernelSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  async function run(phase: "starting" | "restarting"): Promise<void> {
    const gen = ++generation;
    update({ phase, client: null, error: null });
    let client: MinervaClient | null = null;
    try {
      await bridge.start();
      // An exit can arrive while start() is waiting (including one buffered by
      // the generation-aware Tauri bridge). If it already launched recovery,
      // this attempt must not attach a second client to the replacement.
      if (gen !== generation) return;
      const fresh = new MinervaClient(createSidecarTransport(bridge), {
        onPermissionRequest: permissions.handler,
      });
      client = fresh;
      // A kernel that spawns but never answers (bad build, protocol
      // mismatch, deadlock) must not wedge the app in "starting" forever —
      // bound the handshake, and treat expiry like any other dead start.
      const config = await withTimeout(
        (async () => {
          await fresh.initialize();
          return await fresh.getConfigState();
        })(),
        handshakeTimeoutMs,
      );
      if (gen !== generation) return; // superseded by a newer attempt
      // Note: the auto-restart allowance is NOT replenished here — only a
      // manual start() resets it. Replenishing on ready would let a kernel
      // that dies shortly after every boot restart forever.
      update({ phase: "ready", client, config, exitCode: null, error: null });
    } catch (cause) {
      if (gen !== generation) return; // the exit path already took over
      // The half-connected state is unusable: drop the client and make sure
      // no wedged process lingers behind the "down" banner. AWAIT the kill —
      // it resolves only once the old kernel is fully gone (drain + reap),
      // so the restart button can never spawn a successor that races the
      // dying process. Intentional shutdowns emit no exit event (the Rust
      // side is generation-guarded), so this cannot trigger crash recovery.
      try {
        client?.close();
      } catch {
        // Transport already closed.
      }
      await bridge.kill().catch(() => {});
      if (gen !== generation) return;
      update({
        phase: "down",
        client: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  bridge.onExit((code) => {
    // Whoever was waiting on the dead kernel must not wait forever.
    permissions.cancelAll();
    try {
      snapshot.client?.close();
    } catch {
      // Already closed by the transport's own exit handling.
    }
    if (autoRestarts < 1) {
      autoRestarts++;
      update({ client: null, exitCode: code });
      void run("restarting");
    } else {
      generation++; // cancel any in-flight attempt
      update({ phase: "down", client: null, exitCode: code });
    }
  });

  return {
    permissions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get snapshot() {
      return snapshot;
    },
    start() {
      if (!started) {
        started = true;
        void run("starting");
        return;
      }
      if (snapshot.phase === "down") {
        autoRestarts = 0;
        void run("restarting");
      }
    },
  };
}
