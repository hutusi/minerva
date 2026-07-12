import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The webview's only doorway to the kernel process. The Tauri implementation
 * lives behind this interface so everything downstream (transport, client,
 * UI) is testable with a fake — no other module may import @tauri-apps/api.
 */
export interface SidecarBridge {
  /** Spawn the kernel (idempotent). Resolves once event listeners are live. */
  start(): Promise<void>;
  /** Write one protocol frame (no trailing newline — the host appends it). */
  send(line: string): Promise<void>;
  kill(): Promise<void>;
  onLine(handler: (line: string) => void): () => void;
  onExit(handler: (code: number | null) => void): () => void;
}

export function createTauriSidecarBridge(): SidecarBridge {
  const lineHandlers = new Set<(line: string) => void>();
  const exitHandlers = new Set<(code: number | null) => void>();

  // Subscribe immediately so no frame can slip between spawn and listen;
  // start() awaits this before invoking the spawn command.
  const subscribed = Promise.all([
    listen<string>("minerva://line", (event) => {
      for (const handler of lineHandlers) handler(event.payload);
    }),
    listen<{ code: number | null }>("minerva://exit", (event) => {
      for (const handler of exitHandlers) handler(event.payload.code);
    }),
  ]);

  return {
    async start() {
      await subscribed;
      await invoke("sidecar_start");
    },
    async send(line: string) {
      await invoke("sidecar_send", { line });
    },
    async kill() {
      await invoke("sidecar_kill");
    },
    onLine(handler) {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
}

/** Project directory for the first session until the folder picker lands. */
export function fetchDefaultCwd(): Promise<string> {
  return invoke<string>("default_cwd");
}
