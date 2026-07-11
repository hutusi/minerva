import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src";

describe("SessionStore reducer", () => {
  test("streams assistant chunks into one item, splits around tool calls", () => {
    const store = new SessionStore();
    store.addUserMessage("do the thing");
    store.setBusy(true);
    store.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wor" } });
    store.apply({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "king." },
    });
    store.apply({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "echo hi",
      kind: "execute",
      status: "pending",
    });
    store.apply({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done." },
    });
    store.setBusy(false);

    expect(store.snapshot.busy).toBe(false);
    expect(store.snapshot.items).toEqual([
      { kind: "user", text: "do the thing" },
      { kind: "assistant", text: "Working.", streaming: false },
      { kind: "tool", toolCallId: "c1", title: "echo hi", toolKind: "execute", status: "pending" },
      { kind: "assistant", text: "Done.", streaming: false },
    ]);
  });

  test("setUsage keeps the latest report; a resume announcement clears lastTurn", () => {
    const store = new SessionStore();
    store.setUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 10, outputTokens: 5 });
    expect(store.snapshot.usage).toEqual({
      lastTurn: { inputTokens: 10, outputTokens: 5 },
      cumulative: { inputTokens: 10, outputTokens: 5 },
    });

    store.setUsage(
      { inputTokens: 20, outputTokens: 8, cacheReadTokens: 100 },
      { inputTokens: 30, outputTokens: 13, cacheReadTokens: 100 },
    );
    expect(store.snapshot.usage?.cumulative).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      cacheReadTokens: 100,
    });

    store.setUsage(undefined, { inputTokens: 30, outputTokens: 13 });
    expect(store.snapshot.usage).toEqual({
      lastTurn: undefined,
      cumulative: { inputTokens: 30, outputTokens: 13 },
    });
    // Usage is status state, never a transcript item.
    expect(store.snapshot.items).toEqual([]);
  });

  test("setBusy preserves status state set while the prompt ran", () => {
    const store = new SessionStore();
    store.setBusy(true);
    store.setMode("plan");
    store.setUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 1, outputTokens: 2 });
    store.setBusy(false);

    expect(store.snapshot.currentModeId).toBe("plan");
    expect(store.snapshot.usage?.cumulative).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  test("tool_call_update merges status and text output", () => {
    const store = new SessionStore();
    store.apply({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read a.txt",
      kind: "read",
      status: "pending",
    });
    store.apply({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" });
    store.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file contents" } }],
    });

    expect(store.snapshot.items).toEqual([
      {
        kind: "tool",
        toolCallId: "c1",
        title: "Read a.txt",
        toolKind: "read",
        status: "completed",
        output: "file contents",
      },
    ]);
  });

  test("plan updates replace the single plan item in place; info items append", () => {
    const store = new SessionStore();
    store.addInfo("welcome");
    store.apply({
      sessionUpdate: "plan",
      entries: [{ content: "a", status: "pending", priority: "medium" }],
    });
    store.apply({
      sessionUpdate: "plan",
      entries: [{ content: "a", status: "completed", priority: "medium" }],
    });
    const plans = store.snapshot.items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ entries: [{ content: "a", status: "completed" }] });
    expect(store.snapshot.items[0]).toEqual({ kind: "info", text: "welcome" });
  });

  test("current_mode_update and agent_thought_chunk are handled", () => {
    const store = new SessionStore();
    store.apply({ sessionUpdate: "current_mode_update", currentModeId: "auto" });
    expect(store.snapshot.currentModeId).toBe("auto");
    // Thoughts are not surfaced in slice scope — must not throw or render.
    store.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    expect(store.snapshot.items).toHaveLength(0);
  });

  test("notifies subscribers on every change and snapshots are immutable", () => {
    const store = new SessionStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const before = store.snapshot;
    store.addUserMessage("hello");
    expect(notified).toBe(1);
    expect(store.snapshot).not.toBe(before);
    expect(before.items).toHaveLength(0);
  });
});
