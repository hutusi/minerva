import { describe, expect, test } from "bun:test";
import type { RequestPermissionParams } from "@minerva/protocol";
import { createPermissionQueue } from "../src/lib/permission-queue";

function request(id: string): RequestPermissionParams {
  return {
    sessionId: "ses_test",
    toolCall: { toolCallId: id, title: `tool ${id}`, kind: "execute" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
}

describe("createPermissionQueue", () => {
  test("stacked requests answer in FIFO order", async () => {
    const queue = createPermissionQueue();
    const first = queue.handler(request("a"));
    const second = queue.handler(request("b"));

    expect(queue.snapshot.depth).toBe(2);
    expect(queue.snapshot.current?.request.toolCall.toolCallId).toBe("a");

    queue.snapshot.current?.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(await first).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(queue.snapshot.depth).toBe(1);
    expect(queue.snapshot.current?.request.toolCall.toolCallId).toBe("b");

    queue.snapshot.current?.resolve({ outcome: { outcome: "cancelled" } });
    expect(await second).toEqual({ outcome: { outcome: "cancelled" } });
    expect(queue.snapshot).toEqual({ current: null, depth: 0 });
  });

  test("notifies subscribers on enqueue and resolve, with fresh snapshots", () => {
    const queue = createPermissionQueue();
    let notified = 0;
    const seen: Array<number> = [];
    const unsubscribe = queue.subscribe(() => {
      notified++;
      seen.push(queue.snapshot.depth);
    });

    void queue.handler(request("a"));
    const before = queue.snapshot;
    queue.snapshot.current?.resolve({ outcome: { outcome: "cancelled" } });
    expect(notified).toBe(2);
    expect(seen).toEqual([1, 0]);
    // Snapshot identity changes per transition (useSyncExternalStore contract).
    expect(queue.snapshot).not.toBe(before);

    unsubscribe();
    void queue.handler(request("b"));
    expect(notified).toBe(2);
  });

  test("double-resolving one entry is ignored", async () => {
    const queue = createPermissionQueue();
    const result = queue.handler(request("a"));
    const entry = queue.snapshot.current;
    entry?.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    entry?.resolve({ outcome: { outcome: "cancelled" } });
    expect(await result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(queue.snapshot.depth).toBe(0);
  });
});
