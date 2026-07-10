import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, defaultRuntime, editFileTool, readFileTool } from "../src";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "minerva-tools-"));
}

const ctx = (cwd: string) => ({ cwd, runtime: defaultRuntime });

describe("read_file", () => {
  test("reads a file relative to cwd", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "hello.txt"), "hi there\n");
    const result = await readFileTool.execute({ path: "hello.txt" }, ctx(cwd));
    expect(result.output).toBe("hi there\n");
    expect(result.isError).toBeUndefined();
  });

  test("missing file surfaces as a thrown error for the loop to catch", async () => {
    const cwd = tempProject();
    await expect(readFileTool.execute({ path: "nope.txt" }, ctx(cwd))).rejects.toThrow();
  });
});

describe("edit_file", () => {
  test("replaces a unique occurrence", async () => {
    const cwd = tempProject();
    const file = join(cwd, "code.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "const b = 2;", new_string: "const b = 3;" },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(await defaultRuntime.readTextFile(file)).toBe("const a = 1;\nconst b = 3;\n");
  });

  test("rejects ambiguous matches without touching the file", async () => {
    const cwd = tempProject();
    const file = join(cwd, "dup.txt");
    writeFileSync(file, "x\nx\n");
    const result = await editFileTool.execute(
      { path: "dup.txt", old_string: "x", new_string: "y" },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(await defaultRuntime.readTextFile(file)).toBe("x\nx\n");
  });

  test("rejects when old_string is absent", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "abc");
    const result = await editFileTool.execute(
      { path: "a.txt", old_string: "zzz", new_string: "y" },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
  });
});

describe("bash", () => {
  test("captures stdout and exit code 0", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, ctx(tempProject()));
    expect(result.output.trim()).toBe("hello");
    expect(result.isError).toBe(false);
  });

  test("nonzero exit is an error result with stderr", async () => {
    const result = await bashTool.execute({ command: "echo oops >&2; exit 3" }, ctx(tempProject()));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("oops");
    expect(result.output).toContain("[exit code: 3]");
  });

  test("times out runaway commands", async () => {
    const result = await bashTool.execute(
      { command: "sleep 5", timeout_ms: 100 },
      ctx(tempProject()),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out");
  }, 5000);

  test("runs in the session cwd", async () => {
    const cwd = tempProject();
    const result = await bashTool.execute({ command: "pwd" }, ctx(cwd));
    // macOS tmpdir may resolve through /private; compare suffix.
    expect(result.output.trim().endsWith(cwd.replace("/private", ""))).toBe(true);
  });
});
