/**
 * Project-tab state: a pure reducer plus (de)serialization for restart
 * persistence. Sessions themselves live elsewhere — a tab only records which
 * cwd it shows and which persisted session it is (or should be) attached to,
 * which is exactly what survives a kernel crash or an app restart.
 */

export interface Tab {
  id: string;
  cwd: string;
  /** Persisted kernel session shown in this tab; null = fresh tab that will
   * create one on first activation. */
  sessionId: string | null;
}

export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

export type TabsAction =
  | { type: "open"; tabId: string; cwd: string }
  | { type: "close"; tabId: string }
  | { type: "activate"; tabId: string }
  | { type: "attach-session"; tabId: string; sessionId: string | null };

export const EMPTY_TABS: TabsState = { tabs: [], activeTabId: null };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      const tab: Tab = { id: action.tabId, cwd: action.cwd, sessionId: null };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      // Closing the active tab activates its right neighbor (or the new last).
      const activeTabId =
        state.activeTabId === action.tabId
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : state.activeTabId;
      return { tabs, activeTabId };
    }
    case "activate": {
      if (!state.tabs.some((tab) => tab.id === action.tabId)) return state;
      return { ...state, activeTabId: action.tabId };
    }
    case "attach-session": {
      // One session, one tab: a store can only feed a single transcript view
      // (the client refuses duplicate registrations for the same reason).
      if (
        action.sessionId !== null &&
        state.tabs.some((tab) => tab.sessionId === action.sessionId && tab.id !== action.tabId)
      ) {
        return state;
      }
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, sessionId: action.sessionId } : tab,
        ),
      };
    }
  }
}

export function serializeTabs(state: TabsState): string {
  return JSON.stringify(state);
}

/** Parse persisted tab state, dropping anything malformed — a corrupt blob
 * must degrade to a fresh start, never a crash loop. */
export function deserializeTabs(raw: string | null): TabsState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TabsState;
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter(
      (tab): tab is Tab =>
        typeof tab === "object" &&
        tab !== null &&
        typeof tab.id === "string" &&
        typeof tab.cwd === "string" &&
        (tab.sessionId === null || typeof tab.sessionId === "string"),
    );
    if (tabs.length === 0) return null;
    const activeTabId = tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : (tabs[0]?.id ?? null);
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}
