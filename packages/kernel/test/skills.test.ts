import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  type RequestPermissionParams,
  type SessionUpdateParams,
} from "@minerva/protocol";
import { createScriptedProvider } from "@minerva/providers";
import {
  createKernel,
  createSkillTool,
  defaultRuntime,
  loadSkills,
  PermissionEngine,
  parseFrontmatter,
  readSkillBody,
  type SessionEvent,
} from "../src";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(root: string, dir: string, frontmatter: string, body = "Do the thing.") {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("parseFrontmatter", () => {
  test("parses key: value pairs and strips quotes", () => {
    const { meta, body } = parseFrontmatter(
      '---\nname: deploy\ndescription: "Ship it safely"\n---\n\nSteps here.\n',
    );
    expect(meta).toEqual({ name: "deploy", description: "Ship it safely" });
    expect(body.trim()).toBe("Steps here.");
  });

  test("a file without a fence is all body", () => {
    const { meta, body } = parseFrontmatter("just markdown\n");
    expect(meta).toEqual({});
    expect(body).toBe("just markdown\n");
  });

  test("an unterminated fence is treated as body, not swallowed", () => {
    const { meta, body } = parseFrontmatter("---\nname: x\nno closing fence\n");
    expect(meta).toEqual({});
    expect(body).toContain("no closing fence");
  });
});

describe("loadSkills", () => {
  test("discovers project and global skills; project wins name collisions", async () => {
    const dataDir = tmp("minerva-skills-data-");
    const cwd = tmp("minerva-skills-proj-");
    writeSkill(join(dataDir, "skills"), "review", "description: Global review", "global body");
    writeSkill(join(dataDir, "skills"), "deploy", "description: Deploy stuff");
    writeSkill(
      join(cwd, ".minerva", "skills"),
      "review",
      "description: Project review",
      "project body",
    );

    const registry = await loadSkills(defaultRuntime, dataDir, cwd);
    expect(registry.skills.map((s) => s.name)).toEqual(["deploy", "review"]);
    const review = registry.skills.find((s) => s.name === "review");
    expect(review?.source).toBe("project");
    expect(await readSkillBody(defaultRuntime, review!)).toBe("project body");
    expect(registry.warnings).toHaveLength(0);
  });

  test("frontmatter name overrides the directory name", async () => {
    const cwd = tmp("minerva-skills-proj-");
    writeSkill(join(cwd, ".minerva", "skills"), "some-dir", "name: renamed\ndescription: d");
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills.map((s) => s.name)).toEqual(["renamed"]);
  });

  test("invalid names and missing descriptions warn and skip", async () => {
    const cwd = tmp("minerva-skills-proj-");
    writeSkill(join(cwd, ".minerva", "skills"), "bad name!", "description: d");
    writeSkill(join(cwd, ".minerva", "skills"), "nodesc", "name: nodesc");
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills).toHaveLength(0);
    expect(registry.warnings).toHaveLength(2);
  });

  test("a skill shadowing a built-in command loads with a warning", async () => {
    const cwd = tmp("minerva-skills-proj-");
    writeSkill(join(cwd, ".minerva", "skills"), "help", "description: custom help");
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills.map((s) => s.name)).toEqual(["help"]);
    expect(registry.warnings[0]).toContain("shadows a built-in");
  });

  test("no skills directories yields an empty registry", async () => {
    const registry = await loadSkills(
      defaultRuntime,
      tmp("minerva-skills-data-"),
      tmp("minerva-skills-proj-"),
    );
    expect(registry.skills).toHaveLength(0);
    expect(registry.warnings).toHaveLength(0);
  });
});

describe("the skill tool", () => {
  test("deny rules can target it despite readOnly", () => {
    const tool = createSkillTool({
      skills: [{ name: "demo", description: "d", source: "project", path: "/x" }],
      warnings: [],
    });
    const engine = new PermissionEngine({ allow: [], deny: ["skill"], ask: [] });
    expect(engine.evaluate(tool, { name: "demo" }, "default").action).toBe("deny");
  });

  test("model-invoked skill returns the body without a permission prompt", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(
      join(cwd, ".minerva", "skills"),
      "release-checklist",
      "description: Steps for cutting a release",
      "1. Tag it.\n2. Ship it.",
    );

    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [
          {
            type: "tool-call",
            toolCallId: "s1",
            toolName: "skill",
            input: { name: "release-checklist" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "Following the checklist." },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
      ]),
    });

    const client = new Connection(clientTransport);
    const updates: SessionUpdateParams[] = [];
    const permissionRequests: RequestPermissionParams[] = [];
    client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
      updates.push(params as SessionUpdateParams);
    });
    client.handleRequest(CLIENT_METHODS.sessionRequestPermission, (params) => {
      permissionRequests.push(params as RequestPermissionParams);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });

    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    const result = await client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "cut a release" }],
    });

    expect(result.stopReason).toBe("end_turn");
    // readOnly ⇒ auto-allowed: loading instructions must not interrupt.
    expect(permissionRequests).toHaveLength(0);
    const completed = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("Tag it.");

    // The invocation is audited like any other tool call.
    const session = kernel.getSession(sessionId);
    if (!session) throw new Error("session missing");
    await session.flush();
    const events = readFileSync(session.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    const toolCall = events.find((event) => event.type === "tool.call");
    expect(toolCall).toMatchObject({ toolName: "skill", input: { name: "release-checklist" } });

    await kernel.close();
  }, 15_000);

  test("an unknown skill name returns a tool error listing what exists", async () => {
    const tool = createSkillTool({
      skills: [{ name: "demo", description: "d", source: "project", path: "/nope" }],
      warnings: [],
    });
    const result = await tool.execute({ name: "ghost" }, { cwd: "/", runtime: defaultRuntime });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("demo");
  });
});
