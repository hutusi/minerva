import { describe, expect, test } from "bun:test";
import { createSessionSlots } from "../src/lib/session-slots";
import { createSessionSwitches } from "../src/lib/session-switches";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("createSessionSwitches", () => {
  test("A → B → A reuses A and lets the last intent commit", async () => {
    const switches = createSessionSwitches<{ id: string }>();
    const slots = createSessionSlots();
    const a = deferred<{ id: string }>();
    const b = deferred<{ id: string }>();
    const starts = { a: 0, b: 0 };
    const committed: string[] = [];
    const closed: string[] = [];

    const select = (target: "a" | "b") => {
      const token = slots.begin("tab");
      const pending = switches.begin("tab", target, () => {
        starts[target] += 1;
        return target === "a" ? a.promise : b.promise;
      });
      void pending.then((session) => {
        if (!slots.isCurrent("tab", token)) {
          // An older handler for a REUSED target must not detach the result
          // before the latest handler commits that same store.
          if (!switches.isDesired("tab", target)) closed.push(session.id);
          return;
        }
        switches.finish("tab", target);
        committed.push(session.id);
      });
      return pending;
    };

    const firstA = select("a");
    select("b");
    const lastA = select("a");
    expect(lastA).toBe(firstA);
    expect(starts).toEqual({ a: 1, b: 1 });

    a.resolve({ id: "a" });
    await a.promise;
    await Promise.resolve();
    expect(committed).toEqual(["a"]);
    expect(closed).toEqual([]);

    b.resolve({ id: "b" });
    await b.promise;
    await Promise.resolve();
    expect(closed).toEqual(["b"]);
  });

  test("invalidating a tab makes its reused result disposable", async () => {
    const switches = createSessionSwitches<string>();
    const work = deferred<string>();
    const first = switches.begin("tab", "session", () => work.promise);
    const reused = switches.begin("tab", "session", () => Promise.resolve("duplicate"));
    expect(reused).toBe(first);

    switches.invalidate("tab");
    expect(switches.isDesired("tab", "session")).toBe(false);
    work.resolve("session");
    await work.promise;
  });

  test("a client reset never reuses old work or lets its cleanup erase new work", async () => {
    const switches = createSessionSwitches<string>();
    const oldWork = deferred<string>();
    const newWork = deferred<string>();
    const oldPromise = switches.begin("tab", "session", () => oldWork.promise);

    switches.invalidateAll();
    expect(switches.isDesired("tab", "session")).toBe(false);
    const newPromise = switches.begin("tab", "session", () => newWork.promise);
    expect(newPromise).not.toBe(oldPromise);

    oldWork.resolve("old");
    await oldWork.promise;
    await Promise.resolve();
    const reusedNew = switches.begin("tab", "session", () => Promise.resolve("duplicate"));
    expect(reusedNew).toBe(newPromise);

    newWork.resolve("new");
    await newWork.promise;
  });

  test("a synchronous start failure becomes the shared rejection", async () => {
    const switches = createSessionSwitches<string>();
    const failure = new Error("boom");
    const first = switches.begin("tab", "session", () => {
      throw failure;
    });
    const reused = switches.begin("tab", "session", () => Promise.resolve("duplicate"));
    expect(reused).toBe(first);
    await expect(first).rejects.toBe(failure);
  });
});
