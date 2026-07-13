/**
 * Coordinates user-initiated async switches independently from install
 * tokens. Tokens answer "may this completion commit?"; this helper answers
 * "is work for this target already running?" and "is this still the user's
 * desired target?". Keeping those questions separate is what makes A → B → A
 * safe: the last A reuses the first A promise but receives a fresh token.
 */
export interface SessionSwitches<T> {
  /** Mark target as the latest intent and return its one shared in-flight job. */
  begin(tabId: string, target: string, start: () => Promise<T>): Promise<T>;
  /** True while target is the user's latest switch intent for this tab. */
  isDesired(tabId: string, target: string): boolean;
  /** Clear a completed intent, but never erase a newer target. */
  finish(tabId: string, target: string): void;
  /** The tab is gone; completions should be discarded and detached. */
  invalidate(tabId: string): void;
  /** The client was replaced; no outstanding result belongs to it anymore. */
  invalidateAll(): void;
}

export function createSessionSwitches<T>(): SessionSwitches<T> {
  const desired = new Map<string, string>();
  const inFlight = new Map<string, Map<string, Promise<T>>>();

  return {
    begin(tabId, target, start) {
      desired.set(tabId, target);
      let targets = inFlight.get(tabId);
      if (!targets) {
        targets = new Map();
        inFlight.set(tabId, targets);
      }

      const existing = targets.get(target);
      if (existing) return existing;

      let promise: Promise<T>;
      try {
        promise = start();
      } catch (cause) {
        promise = Promise.reject(cause);
      }
      targets.set(target, promise);
      const clean = () => {
        if (targets?.get(target) === promise) targets.delete(target);
        // A client reset may already have installed a fresh target map for
        // this tab. Cleanup from the old client must never delete that map.
        if (targets?.size === 0 && inFlight.get(tabId) === targets) inFlight.delete(tabId);
      };
      // Handle both outcomes on this derivative so cleanup cannot create an
      // unhandled rejected promise. Callers still observe the original.
      void promise.then(clean, clean);
      return promise;
    },
    isDesired(tabId, target) {
      return desired.get(tabId) === target;
    },
    finish(tabId, target) {
      if (desired.get(tabId) === target) desired.delete(tabId);
    },
    invalidate(tabId) {
      desired.delete(tabId);
      inFlight.delete(tabId);
    },
    invalidateAll() {
      desired.clear();
      inFlight.clear();
    },
  };
}
