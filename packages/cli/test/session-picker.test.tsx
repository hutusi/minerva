import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@minerva/protocol";
import { render } from "ink-testing-library";
import { relativeTime, SessionPicker } from "../src/session-picker";

describe("relativeTime", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  const at = (iso: string) => relativeTime(iso, now);

  test("buckets by seconds, minutes, hours, and days", () => {
    expect(at("2026-07-12T11:59:40Z")).toBe("just now");
    expect(at("2026-07-12T11:55:00Z")).toBe("5m ago");
    expect(at("2026-07-12T10:00:00Z")).toBe("2h ago");
    expect(at("2026-07-09T12:00:00Z")).toBe("3d ago");
  });

  test("future timestamps clamp to just now; garbage renders empty", () => {
    expect(at("2026-07-12T12:30:00Z")).toBe("just now");
    expect(at("not a date")).toBe("");
  });
});

const SESSIONS: SessionSummary[] = [
  { sessionId: "s-new", cwd: "/p", createdAt: new Date().toISOString(), preview: "newest work" },
  {
    sessionId: "s-old",
    cwd: "/p",
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    preview: "older work",
  },
];

describe("SessionPicker", () => {
  test("renders rows with time, preview, and a (current) marker", () => {
    const ui = render(
      <SessionPicker
        sessions={SESSIONS}
        currentId="s-new"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("❯ just now");
    expect(frame).toContain("newest work");
    expect(frame).toContain("(current)");
    expect(frame).toContain("2h ago");
    expect(frame).toContain("older work");
    ui.unmount();
  });

  test("arrow + enter selects the highlighted row", async () => {
    const selected: string[] = [];
    const ui = render(
      <SessionPicker
        sessions={SESSIONS}
        currentId="s-new"
        onSelect={(id) => selected.push(id)}
        onCancel={() => {}}
      />,
    );
    await Bun.sleep(50);
    ui.stdin.write("[B");
    await Bun.sleep(30);
    ui.stdin.write("\r");
    await Bun.sleep(30);
    expect(selected).toEqual(["s-old"]);
    ui.unmount();
  });

  test("esc cancels without selecting", async () => {
    let cancelled = false;
    const selected: string[] = [];
    const ui = render(
      <SessionPicker
        sessions={SESSIONS}
        currentId="s-new"
        onSelect={(id) => selected.push(id)}
        onCancel={() => {
          cancelled = true;
        }}
      />,
    );
    await Bun.sleep(50);
    ui.stdin.write("");
    await Bun.sleep(30);
    expect(cancelled).toBe(true);
    expect(selected).toEqual([]);
    ui.unmount();
  });
});
