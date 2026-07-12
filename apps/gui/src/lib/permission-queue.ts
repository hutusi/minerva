import type { PermissionHandler } from "@minerva/client";
import type { RequestPermissionParams, RequestPermissionResult } from "@minerva/protocol";

interface PendingPermission {
  request: RequestPermissionParams;
  resolve: (result: RequestPermissionResult) => void;
}

interface PermissionQueueSnapshot {
  /** The request the dialog should show; null when nothing is pending. */
  current: PendingPermission | null;
  /** Total pending including current — parallel tool calls stack requests. */
  depth: number;
}

export interface PermissionQueue {
  /** Pass as MinervaClientOptions.onPermissionRequest. */
  handler: PermissionHandler;
  subscribe(listener: () => void): () => void;
  readonly snapshot: PermissionQueueSnapshot;
  /** Resolve everything as cancelled — used when the kernel connection dies:
   * the requester is gone, and a modal must not outlive its kernel. */
  cancelAll(): void;
}

/**
 * The GUI's counterpart of the TUI's permission bridge: the client is
 * constructed before React mounts, so kernel requests land in this queue and
 * the mounted dialog resolves them. Unlike the TUI (one modal at a time by
 * construction), parallel tool calls can stack — requests answer in FIFO
 * order, and each resolve advances the snapshot to the next.
 */
export function createPermissionQueue(): PermissionQueue {
  const pending: PendingPermission[] = [];
  const listeners = new Set<() => void>();
  let snapshot: PermissionQueueSnapshot = { current: null, depth: 0 };

  const publish = () => {
    snapshot = { current: pending[0] ?? null, depth: pending.length };
    for (const listener of listeners) listener();
  };

  return {
    handler: (request) =>
      new Promise<RequestPermissionResult>((resolve) => {
        const entry: PendingPermission = {
          request,
          resolve: (result) => {
            const index = pending.indexOf(entry);
            if (index === -1) return; // already resolved — ignore double answers
            pending.splice(index, 1);
            resolve(result);
            publish();
          },
        };
        pending.push(entry);
        publish();
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get snapshot() {
      return snapshot;
    },
    cancelAll() {
      // resolve() splices the entry out, so iterate over a copy.
      for (const entry of [...pending]) {
        entry.resolve({ outcome: { outcome: "cancelled" } });
      }
    },
  };
}
