import type { SessionStore } from "@minerva/client";
import { useSessionStore } from "../hooks/use-session-store";
import type { Tab } from "../lib/tabs";

export function ProjectTabs({
  tabs,
  activeTabId,
  stores,
  onActivate,
  onCloseTab,
  onAddTab,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  /** Live store per tab id, when that tab's session is materialized. */
  stores: ReadonlyMap<string, SessionStore>;
  onActivate: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b bg-muted/30 px-2 pt-1.5">
      {tabs.map((tab) => {
        const store = stores.get(tab.id);
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`flex items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-xs ${
              active ? "bg-background font-medium" : "bg-muted/40 text-muted-foreground"
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(tab.id)}
              title={tab.cwd}
              className="flex items-center gap-1.5"
            >
              {store ? <BusyDot store={store} /> : null}
              {tab.cwd.split("/").filter(Boolean).at(-1) ?? tab.cwd}
            </button>
            <button
              type="button"
              onClick={() => onCloseTab(tab.id)}
              title="Close tab"
              className="rounded px-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAddTab}
        title="Open a project folder in a new tab"
        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
      >
        +
      </button>
    </div>
  );
}

function BusyDot({ store }: { store: SessionStore }) {
  const vm = useSessionStore(store);
  if (!vm.busy) return null;
  return <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" />;
}
