import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTool,
  defaultRuntime,
  editFileTool,
  normalizePtyOutput,
  readFileTool,
  writeFileTool,
} from "../src";

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

  test("success carries a full-file diff block", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "code.ts"), "const a = 1;\n");
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "1", new_string: "2" },
      ctx(cwd),
    );
    expect(result.content).toEqual([
      {
        type: "diff",
        path: join(cwd, "code.ts"),
        oldText: "const a = 1;\n",
        newText: "const a = 2;\n",
      },
    ]);
  });

  test("oversize files fall back to text-only output (no diff block)", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "big.txt"), `marker\n${"x".repeat(49_000)}`);
    const result = await editFileTool.execute(
      { path: "big.txt", old_string: "marker", new_string: "replaced" },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBeUndefined();
  });
});

describe("write_file diff blocks", () => {
  test("a new file diffs against null", async () => {
    const cwd = tempProject();
    const result = await writeFileTool.execute(
      { path: "fresh.txt", content: "brand new\n" },
      ctx(cwd),
    );
    expect(result.content).toEqual([
      { type: "diff", path: join(cwd, "fresh.txt"), oldText: null, newText: "brand new\n" },
    ]);
  });

  test("an overwrite diffs against the previous content", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "note.txt"), "before\n");
    const result = await writeFileTool.execute({ path: "note.txt", content: "after\n" }, ctx(cwd));
    expect(result.content).toEqual([
      { type: "diff", path: join(cwd, "note.txt"), oldText: "before\n", newText: "after\n" },
    ]);
  });

  test("oversize content omits the diff block", async () => {
    const cwd = tempProject();
    const result = await writeFileTool.execute(
      { path: "big.txt", content: "y".repeat(49_000) },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBeUndefined();
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

  test("pty: true routes through execPty and normalizes the output", async () => {
    const calls: string[] = [];
    const runtime = {
      ...defaultRuntime,
      exec: async () => {
        throw new Error("must not use pipes");
      },
      execPty: async (command: string) => {
        calls.push(command);
        return {
          stdout: "\u001b[32mgreen\u001b[0m line\r\ndownloading 10%\rdownloading 100%\r\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      },
    };
    const result = await bashTool.execute(
      { command: "fancy --color", pty: true },
      { cwd: tempProject(), runtime },
    );
    expect(calls).toEqual(["fancy --color"]);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("green line\ndownloading 100%\n");
  });

  test("pty fallback is disclosed in the output", async () => {
    const runtime = {
      ...defaultRuntime,
      execPty: async () => ({
        stdout: "ran\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
        ptyFallback: true,
      }),
    };
    const result = await bashTool.execute(
      { command: "echo ran", pty: true },
      { cwd: tempProject(), runtime },
    );
    expect(result.output).toContain("[pty unavailable on this platform — ran with pipes]");
    expect(result.isError).toBe(false);
  });

  test.if(process.platform !== "win32")("pty: true grants a real TTY end to end", async () => {
    const result = await bashTool.execute(
      { command: "test -t 1 && echo IS_TTY" },
      ctx(tempProject()),
    );
    // Pipes by default: no terminal.
    expect(result.output).not.toContain("IS_TTY");
    const pty = await bashTool.execute(
      { command: "test -t 1 && echo IS_TTY", pty: true },
      ctx(tempProject()),
    );
    expect(pty.output).toContain("IS_TTY");
    expect(pty.isError).toBe(false);
  });
});

describe("normalizePtyOutput", () => {
  test("CRLF, ANSI CSI/OSC, and charset escapes are stripped", () => {
    expect(normalizePtyOutput("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizePtyOutput("\u001b[1;32mok\u001b[0m")).toBe("ok");
    expect(normalizePtyOutput("\u001b]0;window title\u0007body")).toBe("body");
    expect(normalizePtyOutput("\u001b]2;t\u001b\\body")).toBe("body");
    expect(normalizePtyOutput("\u001b(Btext\u001b=more\u001b>")).toBe("textmore");
  });

  test("backspace erasure and the script ^D echo resolve to final state", () => {
    expect(normalizePtyOutput("abc\b\b")).toBe("a");
    // macOS script echoes ^D then erases it with backspaces on stdin EOF.
    expect(normalizePtyOutput("output\n^D\b\b")).toBe("output\n");
  });

  test("carriage-return overwrites keep only the final line state", () => {
    expect(normalizePtyOutput("progress 10%\rprogress 50%\rprogress done\nnext")).toBe(
      "progress done\nnext",
    );
  });

  test("stray control characters go; tabs, newlines, and unicode stay", () => {
    expect(normalizePtyOutput("ab\tc\nd — ✓")).toBe("ab\tc\nd — ✓");
  });

  test("plain output passes through untouched", () => {
    const text = "line one\nline two\n";
    expect(normalizePtyOutput(text)).toBe(text);
  });
});
