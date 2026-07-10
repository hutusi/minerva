import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanEntry } from "@minerva/protocol";
import { defaultRuntime, editFileTool, globTool, grepTool, todoTool, writeFileTool } from "../src";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "minerva-t2-"));
}

const ctx = (cwd: string, updateTodos?: (entries: PlanEntry[]) => void) => ({
  cwd,
  runtime: defaultRuntime,
  updateTodos,
});

describe("write_file", () => {
  test("creates parent directories and writes content", async () => {
    const cwd = tempProject();
    const result = await writeFileTool.execute(
      { path: "deep/nested/new.txt", content: "hello" },
      ctx(cwd),
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(cwd, "deep/nested/new.txt"), "utf8")).toBe("hello");
  });

  test("non-string content is rejected", async () => {
    const cwd = tempProject();
    await expect(
      writeFileTool.execute({ path: "a.txt", content: { nested: true } }, ctx(cwd)),
    ).rejects.toThrow("content");
  });

  test("writes and edits are confined to the workspace", async () => {
    const cwd = tempProject();
    await expect(
      writeFileTool.execute({ path: "/tmp/outside.txt", content: "x" }, ctx(cwd)),
    ).rejects.toThrow("outside the workspace");
    await expect(
      editFileTool.execute({ path: "../outside.txt", old_string: "a", new_string: "b" }, ctx(cwd)),
    ).rejects.toThrow("outside the workspace");
  });
});

describe("glob", () => {
  test("matches files and ignores node_modules", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "");
    writeFileSync(join(cwd, "src/b.md"), "");
    writeFileSync(join(cwd, "node_modules/pkg/c.ts"), "");

    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx(cwd));
    expect(result.output).toBe("src/a.ts");
  });

  test("search base is confined to the workspace", async () => {
    await expect(globTool.execute({ pattern: "*", path: "/" }, ctx(tempProject()))).rejects.toThrow(
      "outside the workspace",
    );
  });

  test("escaping patterns are rejected for glob and grep", async () => {
    const cwd = tempProject();
    await expect(globTool.execute({ pattern: "../**" }, ctx(cwd))).rejects.toThrow(
      "inside the workspace",
    );
    await expect(globTool.execute({ pattern: "/etc/*" }, ctx(cwd))).rejects.toThrow(
      "inside the workspace",
    );
    await expect(grepTool.execute({ pattern: "x", include: "../../*" }, ctx(cwd))).rejects.toThrow(
      "inside the workspace",
    );
  });
});

describe("grep", () => {
  test("returns path:line matches and respects include filter", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
    writeFileSync(join(cwd, "b.md"), "alpha in markdown\n");

    const all = await grepTool.execute({ pattern: "alpha" }, ctx(cwd));
    expect(all.output).toContain("a.ts:1: const alpha = 1;");
    expect(all.output).toContain("b.md:1: alpha in markdown");

    const filtered = await grepTool.execute({ pattern: "alpha", include: "**/*.ts" }, ctx(cwd));
    expect(filtered.output).toBe("a.ts:1: const alpha = 1;");
  });

  test("invalid regex is an error result, not a crash", async () => {
    const result = await grepTool.execute({ pattern: "([unclosed" }, ctx(tempProject()));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid regular expression");
  });
});

describe("todo_write", () => {
  test("validates entries and hands them to the loop hook", async () => {
    let received: PlanEntry[] = [];
    const result = await todoTool.execute(
      {
        todos: [
          { content: "build the thing", status: "in_progress", priority: "high" },
          { content: "test the thing", status: "pending" },
        ],
      },
      ctx(tempProject(), (entries) => {
        received = entries;
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(received).toEqual([
      { content: "build the thing", status: "in_progress", priority: "high" },
      { content: "test the thing", status: "pending", priority: "medium" },
    ]);
  });

  test("bad status is rejected", async () => {
    await expect(
      todoTool.execute(
        { todos: [{ content: "x", status: "done" }] },
        ctx(tempProject(), () => {}),
      ),
    ).rejects.toThrow("status");
  });
});
