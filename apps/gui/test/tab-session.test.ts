import { describe, expect, test } from "bun:test";
import { ensureTabSession } from "../src/lib/tab-session";

describe("ensureTabSession", () => {
  test("resumes the tab's persisted session", async () => {
    const calls: string[] = [];
    const result = await ensureTabSession(
      {
        load: async (id, cwd) => {
          calls.push(`load:${id}:${cwd}`);
          return "loaded";
        },
        create: async () => {
          calls.push("create");
          return "created";
        },
      },
      { id: "t", cwd: "/proj", sessionId: "ses_1" },
    );
    expect(result).toEqual({ session: "loaded", resumed: true });
    expect(calls).toEqual(["load:ses_1:/proj"]);
  });

  test("falls back to a fresh session when the resume fails", async () => {
    const result = await ensureTabSession(
      {
        load: async () => {
          throw new Error("no such session");
        },
        create: async (cwd) => `created:${cwd}`,
      },
      { id: "t", cwd: "/proj", sessionId: "ses_gone" },
    );
    expect(result).toEqual({ session: "created:/proj", resumed: false });
  });

  test("creates directly for a fresh tab", async () => {
    const result = await ensureTabSession(
      {
        load: async () => {
          throw new Error("must not be called");
        },
        create: async (cwd) => `created:${cwd}`,
      },
      { id: "t", cwd: "/proj", sessionId: null },
    );
    expect(result).toEqual({ session: "created:/proj", resumed: false });
  });

  test("a failing create propagates — the caller owns that error", async () => {
    await expect(
      ensureTabSession(
        {
          load: async () => "unused",
          create: async () => {
            throw new Error("kernel gone");
          },
        },
        { id: "t", cwd: "/proj", sessionId: null },
      ),
    ).rejects.toThrow("kernel gone");
  });
});
