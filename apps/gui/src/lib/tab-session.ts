import type { Tab } from "./tabs";

/** The two session operations tab attachment needs, injected for testability. */
export interface TabSessionOps<S> {
  load(sessionId: string, cwd: string): Promise<S>;
  create(cwd: string): Promise<S>;
}

/**
 * Materialize the session a tab should show: resume its persisted session,
 * falling back to a fresh one when the resume fails (deleted log, session id
 * from another data dir, kernel restarted mid-life). The fallback is what
 * makes crash recovery and stale persistence self-healing — a tab can always
 * open, worst case as a new session in the same project.
 */
export async function ensureTabSession<S>(
  ops: TabSessionOps<S>,
  tab: Tab,
): Promise<{ session: S; resumed: boolean }> {
  if (tab.sessionId) {
    try {
      return { session: await ops.load(tab.sessionId, tab.cwd), resumed: true };
    } catch {
      // Fall through to a fresh session in the tab's project.
    }
  }
  return { session: await ops.create(tab.cwd), resumed: false };
}
