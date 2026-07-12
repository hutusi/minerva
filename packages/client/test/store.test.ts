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

  test("tool items retain rawInput and the result's diff block", () => {
    const store = new SessionStore();
    store.apply({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Edit a.ts",
      kind: "edit",
      status: "pending",
      rawInput: { path: "a.ts", old_string: "1", new_string: "2" },
    });
    store.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [
        { type: "diff", path: "a.ts", oldText: "const a = 1;\n", newText: "const a = 2;\n" },
        { type: "content", content: { type: "text", text: "Edited a.ts" } },
      ],
    });

    expect(store.snapshot.items[0]).toMatchObject({
      kind: "tool",
      status: "completed",
      rawInput: { path: "a.ts", old_string: "1", new_string: "2" },
      diff: { path: "a.ts", oldText: "const a = 1;\n", newText: "const a = 2;\n" },
      output: "Edited a.ts",
    });

    // A later status-only update must not drop the retained diff.
    store.apply({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
    expect(store.snapshot.items[0]).toMatchObject({
      diff: { path: "a.ts", oldText: "const a = 1;\n", newText: "const a = 2;\n" },
    });
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

  test("addError appends an error item distinct from info", () => {
    const store = new SessionStore();
    store.addInfo("heads up");
    store.addError("boom");
    expect(store.snapshot.items).toEqual([
      { kind: "info", text: "heads up" },
      { kind: "error", text: "boom" },
    ]);
  });

  test("current_mode_update is handled", () => {
    const store = new SessionStore();
    store.apply({ sessionUpdate: "current_mode_update", currentModeId: "auto" });
    expect(store.snapshot.currentModeId).toBe("auto");
  });

  test("thought chunks coalesce and finalize when the answer starts", () => {
    const store = new SessionStore();
    store.apply({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Consider " },
    });
    store.apply({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "carefully." },
    });
    expect(store.snapshot.items).toEqual([
      { kind: "thought", text: "Consider carefully.", streaming: true },
    ]);

    // The first answer chunk collapses the thought and opens a new item.
    store.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    expect(store.snapshot.items).toEqual([
      { kind: "thought", text: "Consider carefully.", streaming: false },
      { kind: "assistant", text: "Done.", streaming: true },
    ]);
  });

  test("tool calls and setBusy(false) finalize a streaming thought", () => {
    const store = new SessionStore();
    store.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    store.apply({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "ls",
      kind: "execute",
      status: "pending",
    });
    expect(store.snapshot.items[0]).toEqual({ kind: "thought", text: "hm", streaming: false });

    // Cancel path: nothing follows the thought except the busy flip.
    store.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "more" } });
    store.setBusy(false);
    expect(store.snapshot.items.at(-1)).toEqual({
      kind: "thought",
      text: "more",
      streaming: false,
    });
  });

  test("applyBatch yields the same transcript as one-at-a-time apply, in one notify", () => {
    const updates = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "ls",
        kind: "execute",
        status: "pending",
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
    ] as const;

    const oneByOne = new SessionStore();
    for (const u of updates) oneByOne.apply(u);

    const batched = new SessionStore();
    let notified = 0;
    batched.subscribe(() => {
      notified += 1;
    });
    const before = batched.snapshot;
    batched.applyBatch([...updates]);

    expect(notified).toBe(1); // one transition for the whole replay
    expect(before.items).toHaveLength(0); // prior snapshot untouched (immutable)
    expect(batched.snapshot.items).toEqual(oneByOne.snapshot.items);
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
