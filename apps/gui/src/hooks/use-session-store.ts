import type { SessionStore, SessionViewModel } from "@minerva/client";
import { useCallback, useSyncExternalStore } from "react";

/** Render from a SessionStore: snapshot is a stable reference per update. */
export function useSessionStore(store: SessionStore): SessionViewModel {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(subscribe, () => store.snapshot);
}
