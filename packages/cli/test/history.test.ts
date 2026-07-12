import { describe, expect, test } from "bun:test";
import { InputHistory } from "../src/history";

describe("InputHistory", () => {
  test("prev walks back through entries and stays on the oldest", () => {
    const history = new InputHistory(["one", "two", "three"]);
    expect(history.prev("")).toBe("three");
    expect(history.prev("")).toBe("two");
    expect(history.prev("")).toBe("one");
    expect(history.prev("")).toBe("one"); // pinned at the oldest
  });

  test("next steps forward and restores the stashed draft past the newest", () => {
    const history = new InputHistory(["one", "two"]);
    expect(history.prev("half-typed draft")).toBe("two");
    expect(history.prev("ignored — already browsing")).toBe("one");
    expect(history.next()).toBe("two");
    expect(history.next()).toBe("half-typed draft"); // stash restored
    expect(history.next()).toBeNull(); // not browsing anymore
  });

  test("prev/next on empty history do nothing", () => {
    const history = new InputHistory();
    expect(history.prev("draft")).toBeNull();
    expect(history.next()).toBeNull();
  });

  test("push dedupes consecutive repeats but keeps distant ones", () => {
    const history = new InputHistory();
    history.push("a");
    history.push("a");
    history.push("b");
    history.push("a");
    expect(history.prev("")).toBe("a");
    expect(history.prev("")).toBe("b");
    expect(history.prev("")).toBe("a");
    expect(history.prev("")).toBe("a"); // only three entries total
  });

  test("push resets browsing so the next prev starts at the newest", () => {
    const history = new InputHistory(["old"]);
    expect(history.prev("")).toBe("old");
    history.push("new");
    expect(history.prev("")).toBe("new");
  });

  test("caps at 500 entries, dropping the oldest", () => {
    const history = new InputHistory();
    for (let i = 0; i < 505; i++) history.push(`entry-${i}`);
    let current = history.prev("");
    let steps = 1;
    while (true) {
      const next = history.prev("");
      if (next === current) break;
      current = next;
      steps++;
    }
    expect(steps).toBe(500);
    expect(current).toBe("entry-5"); // 0–4 were evicted
  });

  test("the constructor keeps only the newest 500 seed entries", () => {
    const seed = Array.from({ length: 600 }, (_, i) => `seed-${i}`);
    const history = new InputHistory(seed);
    expect(history.prev("")).toBe("seed-599");
    for (let i = 0; i < 600; i++) history.prev("");
    expect(history.prev("")).toBe("seed-100");
  });
});
