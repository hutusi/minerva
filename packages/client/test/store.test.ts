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
