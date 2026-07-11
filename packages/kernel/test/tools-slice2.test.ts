import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanEntry } from "@minerva/protocol";
import {
  defaultRuntime,
  editFileTool,
  globTool,
  grepTool,
  locateRg,
  resolveRgPath,
  todoTool,
  writeFileTool,
} from "../src";

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

describe("ripgrep resolution", () => {
  test("resolves an existing rg executable (dev fallback)", async () => {
    const rg = await resolveRgPath();
    expect(existsSync(rg)).toBe(true);
    expect(rg.endsWith("rg") || rg.endsWith("rg.exe")).toBe(true);
  });

  // locateRg's three branches are otherwise unreachable: a real release binary
  // exits 137 locally, so the sidecar/not-found paths can only be driven via
  // the injected env seam.
  test("prefers a sidecar next to the executable", async () => {
    const rg = await locateRg({
      execPath: "/opt/minerva/minerva",
      exists: (p) => p === "/opt/minerva/rg" || p === "/opt/minerva/rg.exe",
      importRgPath: async () => {
        throw new Error("sidecar should win before @vscode/ripgrep is consulted");
      },
    });
    expect(rg).toBe(process.platform === "win32" ? "/opt/minerva/rg.exe" : "/opt/minerva/rg");
  });

  test("falls back to @vscode/ripgrep when there is no sidecar", async () => {
    const rg = await locateRg({
      execPath: "/opt/minerva/minerva",
      exists: (p) => p === "/node_modules/rg",
      importRgPath: async () => "/node_modules/rg",
    });
    expect(rg).toBe("/node_modules/rg");
  });

  test("throws when neither a sidecar nor @vscode/ripgrep is present", async () => {
    await expect(
      locateRg({
        execPath: "/opt/minerva/minerva",
        exists: () => false,
        importRgPath: async () => undefined,
      }),
    ).rejects.toThrow("ripgrep (rg) was not found");
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

  test("a slashless pattern matches its basename at any depth (ripgrep semantics)", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src", "deep"), { recursive: true });
    writeFileSync(join(cwd, "root.ts"), "");
    writeFileSync(join(cwd, "src", "deep", "nested.ts"), "");

    // Documented, intentional: `*.ts` is a basename match, so it reaches nested
    // files too — unlike a shell glob. Scope with `**/` or a path segment.
    const result = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
    expect(result.output.split("\n").sort()).toEqual(["root.ts", "src/deep/nested.ts"]);
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
    expect(result.output).toContain("Invalid search");
  });

  test("a catastrophic-backtracking pattern returns promptly (no ReDoS)", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), `${"a".repeat(60)}!\n`);
    const started = Date.now();
    // (a+)+$ hangs the JS engine on this input; ripgrep's linear engine can't.
    const result = await grepTool.execute({ pattern: "(a+)+$" }, ctx(cwd));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.isError).toBeUndefined();
  });

  test("grep excludes nested node_modules and .git, not just root-level", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "nested", "node_modules"), { recursive: true });
    mkdirSync(join(cwd, "nested", ".git"), { recursive: true });
    writeFileSync(join(cwd, "nested", "node_modules", "dep.ts"), "MARKER here\n");
    writeFileSync(join(cwd, "nested", ".git", "config.ts"), "MARKER here\n");
    writeFileSync(join(cwd, "src.ts"), "MARKER here\n");
    const result = await grepTool.execute({ pattern: "MARKER" }, ctx(cwd));
    expect(result.output).toContain("src.ts");
    expect(result.output).not.toContain("node_modules");
    expect(result.output).not.toContain(".git");
  });

  test("grep does not follow a symlink that escapes the workspace", async () => {
    const cwd = tempProject();
    const outside = tempProject();
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET marker\n");
    symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
    const result = await grepTool.execute({ pattern: "TOPSECRET" }, ctx(cwd));
    expect(result.output).toBe("No matches found.");
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
