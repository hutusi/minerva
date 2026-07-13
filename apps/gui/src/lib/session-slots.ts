/**
 * Per-tab install tokens for async session results. Every install attempt
 * (lazy ensure or a user-initiated switch) begins a token; a completion may
 * commit only while its token is still the tab's current one. Anything can
 * supersede it meanwhile — a newer switch, the tab closing, the kernel
 * client being replaced — and the stale result must then be discarded (and
 * its session closed) instead of overwriting the newer choice or leaking an
 * invisible registration.
 *
 * Tokens come from a single monotonic counter that never resets: after
 * invalidateAll() clears the map, an old token can never accidentally match
 * a future one.
 */
export interface SessionSlots {
  /** Start an install for this tab; supersedes any in-flight one. */
  begin(tabId: string): number;
  isCurrent(tabId: string, token: number): boolean;
  /** The tab is gone — outstanding installs for it are stale. */
  invalidate(tabId: string): void;
  /** The kernel client was replaced — every outstanding install is stale. */
  invalidateAll(): void;
}

export function createSessionSlots(): SessionSlots {
  let counter = 0;
  const current = new Map<string, number>();
  return {
    begin(tabId) {
      counter += 1;
      current.set(tabId, counter);
      return counter;
    },
    isCurrent(tabId, token) {
      return current.get(tabId) === token;
    },
    invalidate(tabId) {
      current.delete(tabId);
    },
    invalidateAll() {
      current.clear();
    },
  };
}
