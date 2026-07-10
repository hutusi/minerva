import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTool,
  defaultRuntime,
  editFileTool,
  readFileTool,
  resolveWithinWorkspace,
  Session,
} from "../src";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "minerva-regr-"));
}

const ctx = (cwd: string, signal?: AbortSignal) => ({ cwd, runtime: defaultRuntime, signal });

describe("edit_file input handling", () => {
  test("$-replacement patterns in new_string are inserted literally", async () => {
    const cwd = tempProject();
    const file = join(cwd, "Makefile");
    writeFileSync(file, "run:\n\techo hi\n");
    const result = await editFileTool.execute(
      { path: "Makefile", old_string: "echo hi", new_string: "echo $$PID and $& and $'" },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("run:\n\techo $$PID and $& and $'\n");
  });

  test("non-string new_string is rejected, not treated as deletion", async () => {
    const cwd = tempProject();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "keep me");
    expect(
      editFileTool.execute({ path: "a.txt", old_string: "keep me", new_string: 42 }, ctx(cwd)),
    ).rejects.toThrow("new_string");
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });

  test("empty-string new_string is a legal deletion", async () => {
    const cwd = tempProject();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "drop this. keep this.");
    const result = await editFileTool.execute(
      { path: "a.txt", old_string: "drop this. ", new_string: "" },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("keep this.");
  });
});

describe("read_file workspace confinement", () => {
  test("paths escaping the workspace are rejected", async () => {
    const cwd = tempProject();
    expect(readFileTool.execute({ path: "/etc/passwd" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
    expect(readFileTool.execute({ path: "../../etc/passwd" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
  });

  test("absolute paths inside the workspace are allowed", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "ok.txt"), "fine");
    const result = await readFileTool.execute({ path: join(cwd, "ok.txt") }, ctx(cwd));
    expect(result.output).toBe("fine");
    expect(resolveWithinWorkspace(cwd, "sub/../ok.txt")).toBe(join(cwd, "ok.txt"));
  });
});

describe("bash hardening", () => {
  test("timeout_ms of 0 / NaN falls back to the default instead of instant kill", async () => {
    const result = await bashTool.execute(
      { command: "echo survived", timeout_ms: 0 },
      ctx(tempProject()),
    );
    expect(result.isError).toBe(false);
    expect(result.output.trim()).toBe("survived");
  });

  test("a backgrounded child holding the pipes does not hang exec", async () => {
    const started = Date.now();
    const result = await bashTool.execute(
      { command: "sleep 30 & echo started" },
      ctx(tempProject()),
    );
    expect(result.output).toContain("started");
    // exit fires immediately; the pipe grace period is 1s.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("aborting the signal kills the running command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await bashTool.execute(
      { command: "sleep 10; echo not-reached" },
      ctx(tempProject(), controller.signal),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cancelled by user");
  }, 10_000);
});

describe("session event log resilience", () => {
  test("one failed write does not poison later appends; flush throws once", async () => {
    const cwd = tempProject();
    const dataDir = tempProject();
    let failNext = false;
    const flakyRuntime = {
      ...defaultRuntime,
      appendTextFile: (path: string, content: string) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("disk full"));
        }
        return defaultRuntime.appendTextFile(path, content);
      },
    };
    const session = await Session.create({
      cwd,
      dataDir,
      providerId: "test",
      runtime: flakyRuntime,
    });

    failNext = true;
    session.append({ type: "user.message", text: "lost", at: "t1" });
    session.append({ type: "user.message", text: "recorded", at: "t2" });

    expect(session.flush()).rejects.toThrow("disk full");
    // The chain survived: the later event landed and future flushes succeed.
    await session.flush();
    const lines = readFileSync(session.logPath, "utf8").trim().split("\n");
    const texts = lines.map((line) => JSON.parse(line)).map((event) => event.text ?? event.type);
    expect(texts).toEqual(["session.created", "recorded"]);
  });
});
