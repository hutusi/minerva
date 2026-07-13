import type { Tab } from "./tabs";

/** The two session operations tab attachment needs, injected for testability. */
export interface TabSessionOps<S> {
  load(sessionId: string, cwd: string): Promise<S>;
  create(cwd: string): Promise<S>;
}

/**
 * Materialize the session a tab should show: resume its persisted session,
 * falling back to a fresh one ONLY when `isStale` says the id itself is dead
 * (deleted log, session from another data dir). Any other load failure —
 * a prompt still running in the session, pending writes that failed to
 * flush, transient I/O — rethrows: the kernel throws those loudly precisely
 * so the previous conversation is never silently replaced by a blank one.
 * The caller surfaces the error, and re-activating the tab retries.
 */
export async function ensureTabSession<S>(
  ops: TabSessionOps<S>,
  tab: Tab,
  isStale: (error: unknown) => boolean,
): Promise<{ session: S; resumed: boolean }> {
  if (tab.sessionId) {
    try {
      return { session: await ops.load(tab.sessionId, tab.cwd), resumed: true };
    } catch (error) {
      if (!isStale(error)) throw error;
      // Dead id — fall through to a fresh session in the tab's project.
    }
  }
  return { session: await ops.create(tab.cwd), resumed: false };
}
