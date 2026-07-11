import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRuntime, isNotFoundError } from "../src";

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
    expect(result).toEqual({ text: "hello world", truncated: false, totalBytes: 11 });
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
