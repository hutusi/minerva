export interface SidecarExitEvent {
  generation: number;
  code: number | null;
}

/**
 * Associates process-exit events with the sidecar generation returned by
 * sidecar_start. A new webview subscribes before invoking start, so it can see
 * the previous kernel's delayed exit; that event must not close the transport
 * for the replacement. Conversely, a newly spawned kernel can die before the
 * invoke resolves, so unmatched early exits are held until activate() reveals
 * which generation this bridge actually owns.
 */
export function createSidecarGenerationGate(deliver: (code: number | null) => void) {
  let active: number | null = null;
  const pending = new Map<number, number | null>();

  return {
    activate(generation: number) {
      active = generation;
      const hasPendingExit = pending.has(generation);
      const code = pending.get(generation) ?? null;
      pending.clear();
      if (hasPendingExit) {
        active = null;
        deliver(code);
      }
    },
    exit(event: SidecarExitEvent) {
      if (event.generation === active) {
        active = null;
        deliver(event.code);
      } else if (active === null) {
        pending.set(event.generation, event.code);
      }
    },
    clear() {
      active = null;
      pending.clear();
    },
  };
}
