import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRuntime, execPtyCaptured, isNotFoundError } from "../src";

function tmpFile(content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "minerva-rt-"));
  const path = join(dir, "file.txt");
  writeFileSync(path, content);
  return path;
}

describe("readTextFilePrefix", () => {
  test("a file within the budget comes back whole and untruncated", async () => {
    const path = tmpFile("hello world");
    const result = await defaultRuntime.readTextFilePrefix(path, 1024);
    expect(result).toMatchObject({ text: "hello world", truncated: false, totalBytes: 11 });
    // The fd's identity rides along for confined-read verification.
    expect(result.ino).toBeGreaterThan(0);
  });

  test("a file past the budget is cut with truncated=true and honest totalBytes", async () => {
    const path = tmpFile("a".repeat(5000));
    const result = await defaultRuntime.readTextFilePrefix(path, 100);
    expect(result.text).toBe("a".repeat(100));
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(5000);
  });

  test("a multi-byte character split at the boundary degrades to U+FFFD, not a crash", async () => {
    // "é" is 2 bytes in UTF-8; an odd budget cuts one in half.
    const path = tmpFile("é".repeat(10));
    const result = await defaultRuntime.readTextFilePrefix(path, 5);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("éé")).toBe(true);
    expect(result.text).toContain("�");
  });

  test("missing files reject with ENOENT like readTextFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minerva-rt-"));
    try {
      await defaultRuntime.readTextFilePrefix(join(dir, "absent"), 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect(isNotFoundError(error)).toBe(true);
    }
  });

  test("directories reject with EISDIR like readTextFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minerva-rt-"));
    try {
      await defaultRuntime.readTextFilePrefix(dir, 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("EISDIR");
    }
  });
});

// POSIX-only: the wrapper is script(1); Windows always takes the pipes
// fallback (covered below via the platform override).
describe.if(process.platform !== "win32")("execPty", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "minerva-pty-"));
  const options = (timeoutMs = 10_000) => ({ cwd: cwd(), timeoutMs });

  test("the command sees a TTY on stdin and stdout, merged onto stdout", async () => {
    const result = await defaultRuntime.execPty(
      'test -t 0 && echo IN_TTY; test -t 1 && echo OUT_TTY; echo "to stderr" >&2',
      options(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.ptyFallback).toBeUndefined();
    expect(result.stdout).toContain("IN_TTY");
    expect(result.stdout).toContain("OUT_TTY");
    // A PTY merges the streams; stderr text arrives on stdout.
    expect(result.stdout).toContain("to stderr");
    expect(result.stderr).toBe("");
  });

  test("exit codes propagate through the wrapper", async () => {
    const result = await defaultRuntime.execPty("exit 7", options());
    expect(result.exitCode).toBe(7);
  });

  test("the timeout kills a PTY-wrapped command tree", async () => {
    const result = await defaultRuntime.execPty("sleep 30", options(300));
    expect(result.timedOut).toBe(true);
  }, 10_000);

  test("an abort signal kills a PTY-wrapped command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await defaultRuntime.execPty("sleep 30", {
      cwd: cwd(),
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  }, 10_000);

  test("a missing wrapper degrades to pipes with the fallback flag", async () => {
    const result = await execPtyCaptured("test -t 1 && echo tty; echo ran", options(), {
      wrapper: "/nonexistent/script-binary",
    });
    expect(result.ptyFallback).toBe(true);
    expect(result.stdout).toContain("ran");
    expect(result.stdout).not.toContain("tty"); // pipes: no terminal granted
  });

  test("win32 always takes the pipes fallback", async () => {
    const result = await execPtyCaptured("echo ran", options(), { platform: "win32" });
    expect(result.ptyFallback).toBe(true);
    expect(result.stdout).toContain("ran");
  });
});
