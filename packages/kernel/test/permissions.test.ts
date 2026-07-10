import { describe, expect, test } from "bun:test";
import {
  bashTool,
  editFileTool,
  formatRule,
  PermissionEngine,
  permissionValue,
  readFileTool,
  ruleMatches,
} from "../src";

const engine = (rules: Partial<{ allow: string[]; deny: string[]; ask: string[] }> = {}) =>
  new PermissionEngine({ allow: [], deny: [], ask: [], ...rules });

describe("rule matching", () => {
  test("bare tool name matches every call of that tool", () => {
    expect(ruleMatches("bash", "bash", "rm -rf /")).toBe(true);
    expect(ruleMatches("bash", "edit_file", "x")).toBe(false);
  });

  test("wildcard patterns match the permission value", () => {
    expect(ruleMatches("bash(git *)", "bash", "git status")).toBe(true);
    expect(ruleMatches("bash(git *)", "bash", "gitx")).toBe(false);
    expect(ruleMatches("bash(git *)", "bash", "npm install")).toBe(false);
    expect(ruleMatches("edit_file(src/*)", "edit_file", "src/deep/nested.ts")).toBe(true);
    expect(ruleMatches("edit_file(src/*)", "edit_file", "test/x.ts")).toBe(false);
  });

  test("regex metacharacters in patterns are literal", () => {
    expect(ruleMatches("bash(echo (hi))", "bash", "echo (hi)")).toBe(true); // nested parens stay literal
    expect(ruleMatches("bash(git add .)", "bash", "git add .")).toBe(true);
    expect(ruleMatches("bash(git add .)", "bash", "git add x")).toBe(false);
  });

  test("permissionValue picks command for bash and path for file tools", () => {
    expect(permissionValue({ command: "ls -la" })).toBe("ls -la");
    expect(permissionValue({ path: "a.ts", old_string: "x" })).toBe("a.ts");
    expect(formatRule("bash", "git status")).toBe("bash(git status)");
  });
});

describe("engine verdicts", () => {
  test("deny outranks everything, including read-only policy", () => {
    const e = engine({ deny: ["read_file(secrets/*)"], allow: ["read_file"] });
    const verdict = e.evaluate(readFileTool, { path: "secrets/key.pem" }, "auto");
    expect(verdict).toMatchObject({ action: "deny", rule: "read_file(secrets/*)" });
  });

  test("read-only tools are allowed in every mode", () => {
    for (const mode of ["plan", "default", "acceptEdits", "auto"] as const) {
      expect(engine().evaluate(readFileTool, { path: "a.ts" }, mode).action).toBe("allow");
    }
  });

  test("allow rule grants without asking; ask rule outranks allow", () => {
    const e = engine({ allow: ["bash(git *)"], ask: ["bash(git push*)"] });
    expect(e.evaluate(bashTool, { command: "git status" }, "default")).toMatchObject({
      action: "allow",
      rule: "bash(git *)",
    });
    expect(e.evaluate(bashTool, { command: "git push origin" }, "default").action).toBe("ask");
  });

  test("modes decide unmatched mutating calls", () => {
    const e = engine();
    expect(e.evaluate(bashTool, { command: "ls" }, "plan").action).toBe("deny");
    expect(e.evaluate(bashTool, { command: "ls" }, "default").action).toBe("ask");
    expect(e.evaluate(bashTool, { command: "ls" }, "auto").action).toBe("allow");
    expect(e.evaluate(editFileTool, { path: "a" }, "acceptEdits").action).toBe("allow");
    expect(e.evaluate(bashTool, { command: "ls" }, "acceptEdits").action).toBe("ask");
  });

  test("addAllowRule takes effect immediately", () => {
    const e = engine();
    expect(e.evaluate(bashTool, { command: "bun test" }, "default").action).toBe("ask");
    e.addAllowRule("bash(bun test)");
    expect(e.evaluate(bashTool, { command: "bun test" }, "default").action).toBe("allow");
  });
});
