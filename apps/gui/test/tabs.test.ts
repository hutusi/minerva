import { describe, expect, test } from "bun:test";
import {
  deserializeTabs,
  EMPTY_TABS,
  serializeTabs,
  type TabsState,
  tabsReducer,
} from "../src/lib/tabs";

const open = (state: TabsState, id: string, cwd: string) =>
  tabsReducer(state, { type: "open", tabId: id, cwd });

describe("tabsReducer", () => {
  test("open appends and activates", () => {
    let state = open(EMPTY_TABS, "a", "/one");
    state = open(state, "b", "/two");
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.activeTabId).toBe("b");
  });

  test("closing the active tab activates its right neighbor, then the last", () => {
    let state = open(open(open(EMPTY_TABS, "a", "/1"), "b", "/2"), "c", "/3");
    state = tabsReducer(state, { type: "activate", tabId: "b" });
    state = tabsReducer(state, { type: "close", tabId: "b" });
    expect(state.activeTabId).toBe("c");
    state = tabsReducer(state, { type: "close", tabId: "c" });
    expect(state.activeTabId).toBe("a");
    state = tabsReducer(state, { type: "close", tabId: "a" });
    expect(state).toEqual({ tabs: [], activeTabId: null });
  });

  test("closing a background tab keeps the active one", () => {
    let state = open(open(EMPTY_TABS, "a", "/1"), "b", "/2");
    state = tabsReducer(state, { type: "close", tabId: "a" });
    expect(state.activeTabId).toBe("b");
  });

  test("activate ignores unknown tabs", () => {
    const state = open(EMPTY_TABS, "a", "/1");
    expect(tabsReducer(state, { type: "activate", tabId: "nope" })).toBe(state);
  });

  test("attach-session refuses a session already shown in another tab", () => {
    let state = open(open(EMPTY_TABS, "a", "/1"), "b", "/2");
    state = tabsReducer(state, { type: "attach-session", tabId: "a", sessionId: "ses_1" });
    const rejected = tabsReducer(state, { type: "attach-session", tabId: "b", sessionId: "ses_1" });
    expect(rejected).toBe(state);
    // Re-attaching to the same tab and clearing are both fine.
    state = tabsReducer(state, { type: "attach-session", tabId: "a", sessionId: "ses_1" });
    state = tabsReducer(state, { type: "attach-session", tabId: "a", sessionId: null });
    expect(state.tabs[0]?.sessionId).toBeNull();
  });
});

describe("tab persistence", () => {
  test("round-trips through serialize/deserialize", () => {
    let state = open(open(EMPTY_TABS, "a", "/1"), "b", "/2");
    state = tabsReducer(state, { type: "attach-session", tabId: "a", sessionId: "ses_1" });
    state = tabsReducer(state, { type: "activate", tabId: "a" });
    expect(deserializeTabs(serializeTabs(state))).toEqual(state);
  });

  test("rejects garbage and heals a stale active id", () => {
    expect(deserializeTabs(null)).toBeNull();
    expect(deserializeTabs("not json")).toBeNull();
    expect(deserializeTabs(JSON.stringify({ tabs: "nope" }))).toBeNull();
    expect(deserializeTabs(JSON.stringify({ tabs: [], activeTabId: null }))).toBeNull();
    const healed = deserializeTabs(
      JSON.stringify({
        tabs: [{ id: "a", cwd: "/1", sessionId: null }, { bogus: true }],
        activeTabId: "gone",
      }),
    );
    expect(healed).toEqual({ tabs: [{ id: "a", cwd: "/1", sessionId: null }], activeTabId: "a" });
  });
});
