import { describe, expect, test } from "bun:test";
import { RpcError } from "@minerva/protocol";
import { ensureTabSession, isStaleSessionError as isStale } from "../src/lib/tab-session";

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
      isStale,
    );
    expect(result).toEqual({ session: "loaded", resumed: true });
    expect(calls).toEqual(["load:ses_1:/proj"]);
  });

  test("falls back to a fresh session only for a stale id", async () => {
    // The real message family for a missing log; the full round-trip against
    // an actual kernel lives in stale-session.test.ts.
    const result = await ensureTabSession(
      {
        load: async () => {
          throw new RpcError(-32602, "no persisted session ses_gone for /proj");
        },
        create: async (cwd) => `created:${cwd}`,
      },
      { id: "t", cwd: "/proj", sessionId: "ses_gone" },
      isStale,
    );
    expect(result).toEqual({ session: "created:/proj", resumed: false });
  });

  test("non-stale load failures surface instead of replacing the conversation", async () => {
    const failures = [
      new RpcError(-32600, "cannot load a session while a prompt is running in it"),
      new RpcError(-32603, "cannot reload session: pending writes failed (EIO)"),
      new Error("session ses_1 is already open in this client"),
    ];
    for (const failure of failures) {
      let created = false;
      await expect(
        ensureTabSession(
          {
            load: async () => {
              throw failure;
            },
            create: async () => {
              created = true;
              return "created";
            },
          },
          { id: "t", cwd: "/proj", sessionId: "ses_1" },
          isStale,
        ),
      ).rejects.toBe(failure);
      expect(created).toBe(false);
    }
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
      isStale,
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
        isStale,
      ),
    ).rejects.toThrow("kernel gone");
  });
});
