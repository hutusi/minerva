import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTool,
  defaultRuntime,
  editFileTool,
  readFileTool,
  resolveWithinWorkspace,
  Session,
  writeFileTool,
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
    await expect(
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
    await expect(readFileTool.execute({ path: "/etc/passwd" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
    await expect(readFileTool.execute({ path: "../../etc/passwd" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
  });

  test("absolute paths inside the workspace are allowed", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "ok.txt"), "fine");
    const result = await readFileTool.execute({ path: join(cwd, "ok.txt") }, ctx(cwd));
    expect(result.output).toBe("fine");
    // Also covers the macOS /tmp → /private/tmp case: cwd is under mkdtemp, so
    // realpath must resolve both sides consistently or this would false-reject.
    expect(await resolveWithinWorkspace(defaultRuntime, cwd, "sub/../ok.txt")).toBe(
      join(cwd, "ok.txt"),
    );
  });

  test("a symlink escaping the workspace is rejected for reads", async () => {
    const cwd = tempProject();
    const outside = tempProject();
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, join(cwd, "evil")); // cwd/evil → an outside dir
    await expect(readFileTool.execute({ path: "evil/secret.txt" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
  });

  test("a symlink escaping the workspace is rejected for writes to a new file", async () => {
    const cwd = tempProject();
    const outside = tempProject();
    symlinkSync(outside, join(cwd, "evil"));
    // The target file does not exist yet; the symlinked ancestor is caught.
    await expect(
      writeFileTool.execute({ path: "evil/planted.txt", content: "x" }, ctx(cwd)),
    ).rejects.toThrow("outside the workspace");
  });

  test("a symlink pointing inside the workspace is allowed", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "real"));
    writeFileSync(join(cwd, "real", "note.txt"), "hi");
    symlinkSync(join(cwd, "real"), join(cwd, "link")); // stays inside
    const result = await readFileTool.execute({ path: "link/note.txt" }, ctx(cwd));
    expect(result.output).toBe("hi");
  });

  test("a dangling symlink escaping the workspace is rejected for writes", async () => {
    const cwd = tempProject();
    const outside = tempProject();
    // The symlink target does not exist — realpath alone can't see the escape.
    symlinkSync(join(outside, "missing"), join(cwd, "dangling"));
    await expect(
      writeFileTool.execute({ path: "dangling", content: "x" }, ctx(cwd)),
    ).rejects.toThrow("outside the workspace");
  });

  test("a dangling symlink escaping the workspace is rejected for reads", async () => {
    const cwd = tempProject();
    const outside = tempProject();
    symlinkSync(join(outside, "missing"), join(cwd, "dangling"));
    await expect(readFileTool.execute({ path: "dangling" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
  });

  test("a symlink chain that ultimately escapes is rejected", async () => {
    const cwd = tempProject();
    const outside = tempProject();
    symlinkSync(join(outside, "missing"), join(cwd, "b")); // b → outside/missing
    symlinkSync(join(cwd, "b"), join(cwd, "a")); // a → b
    await expect(writeFileTool.execute({ path: "a", content: "x" }, ctx(cwd))).rejects.toThrow(
      "outside the workspace",
    );
  });

  test("a dangling symlink pointing inside the workspace is allowed", async () => {
    const cwd = tempProject();
    // Points at an as-yet-nonexistent path *inside* the workspace — writing
    // through it must land inside, not be over-rejected.
    symlinkSync(join(cwd, "new.txt"), join(cwd, "link"));
    const result = await writeFileTool.execute({ path: "link", content: "ok" }, ctx(cwd));
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("ok");
  });

  test("a new file under a new nested directory is still allowed", async () => {
    const cwd = tempProject();
    const result = await writeFileTool.execute(
      { path: "deep/nested/file.txt", content: "ok" },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(cwd, "deep", "nested", "file.txt"), "utf8")).toBe("ok");
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

    await expect(session.flush()).rejects.toThrow("disk full");
    // The chain survived: the later event landed and future flushes succeed.
    await session.flush();
    const lines = readFileSync(session.logPath, "utf8").trim().split("\n");
    const texts = lines.map((line) => JSON.parse(line)).map((event) => event.text ?? event.type);
    expect(texts).toEqual(["session.created", "recorded"]);
  });
});
