import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { withFileLock } from "../src/file-lock";

/** A manually-resolvable gate, to hold a lock open from the test. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "minerva-lock-")), "file.json");

describe("withFileLock", () => {
  test("same-path tasks run strictly one at a time, in call order", async () => {
    const path = tmpPath();
    const events: string[] = [];
    const first = gate();

    const a = withFileLock(path, async () => {
      events.push("a:start");
      await first.opened;
      events.push("a:end");
    });
    const b = withFileLock(path, async () => {
      events.push("b:start");
      events.push("b:end");
    });

    // b must not have started while a holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["a:start"]);

    first.open();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("a rejecting task propagates to its caller without stalling the queue", async () => {
    const path = tmpPath();
    const failing = withFileLock(path, async () => {
      throw new Error("boom");
    });
    const after = withFileLock(path, async () => "still runs");

    await expect(failing).rejects.toThrow("boom");
    // The very point of the settled-tolerant tail: the next caller proceeds.
    await expect(after).resolves.toBe("still runs");
  });

  test("distinct paths never contend", async () => {
    const holdA = gate();
    const events: string[] = [];

    const a = withFileLock(tmpPath(), async () => {
      events.push("a:start");
      await holdA.opened;
    });
    const b = withFileLock(tmpPath(), async () => {
      events.push("b:done");
    });

    // b completes while a is still holding its (different-path) lock.
    await b;
    expect(events).toEqual(["a:start", "b:done"]);
    holdA.open();
    await a;
  });

  test("return values pass through", async () => {
    await expect(withFileLock(tmpPath(), async () => 42)).resolves.toBe(42);
  });

  test("relative and absolute spellings of one file share a lock", async () => {
    const absolute = tmpPath();
    const viaRelative = relative(process.cwd(), absolute);
    const events: string[] = [];
    const hold = gate();

    const a = withFileLock(absolute, async () => {
      events.push("abs:start");
      await hold.opened;
      events.push("abs:end");
    });
    const b = withFileLock(viaRelative, async () => {
      events.push("rel:start");
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The map keys on resolve(path) — the relative caller must be queued.
    expect(events).toEqual(["abs:start"]);
    hold.open();
    await Promise.all([a, b]);
    expect(events).toEqual(["abs:start", "abs:end", "rel:start"]);
  });

  test("a drained queue leaves no state behind: a fresh lock still works", async () => {
    const path = tmpPath();
    await withFileLock(path, async () => "first wave");
    // Let the cleanup microtask run (entry removal is post-drain).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(withFileLock(path, async () => "second wave")).resolves.toBe("second wave");
  });

  test("many concurrent read-modify-write callers lose no update", async () => {
    const path = tmpPath();
    await Bun.write(path, "0");
    await Promise.all(
      Array.from({ length: 25 }, () =>
        withFileLock(path, async () => {
          const current = Number(await Bun.file(path).text());
          // Yield mid-critical-section — unlocked, interleaving would lose counts.
          await new Promise((resolve) => setTimeout(resolve, 1));
          await Bun.write(path, String(current + 1));
        }),
      ),
    );
    expect(Number(await Bun.file(path).text())).toBe(25);
  });
});
