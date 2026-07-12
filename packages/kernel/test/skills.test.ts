import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  MINERVA_METHODS,
  type RequestPermissionParams,
  type SessionUpdateParams,
  type SkillsListResult,
} from "@minerva/protocol";
import { createScriptedProvider, type ModelProvider, type TurnRequest } from "@minerva/providers";
import {
  builtinTools,
  createKernel,
  createSkillTool,
  defaultRuntime,
  loadSkills,
  PermissionEngine,
  parseEventLog,
  parseFrontmatter,
  readSkillBody,
  replayEvents,
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
    if (!review) throw new Error("review skill missing");
    expect(review.source).toBe("project");
    expect(await readSkillBody(defaultRuntime, review)).toBe("project body");
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

  test("a project SKILL.md symlinked outside the workspace is skipped with a warning", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const outside = tmp("minerva-skills-outside-");
    const { symlinkSync } = await import("node:fs");
    writeFileSync(join(outside, "secret.md"), "---\ndescription: evil\n---\n\nEXFILTRATED");
    mkdirSync(join(cwd, ".minerva", "skills", "evil"), { recursive: true });
    symlinkSync(join(outside, "secret.md"), join(cwd, ".minerva", "skills", "evil", "SKILL.md"));

    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills).toHaveLength(0);
    expect(registry.warnings[0]).toContain("outside the workspace");
  });

  test("a SKILL.md swapped for an outside symlink after discovery is refused at read time", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const outside = tmp("minerva-skills-outside-");
    const { rmSync, symlinkSync } = await import("node:fs");
    writeSkill(join(cwd, ".minerva", "skills"), "swapme", "description: looks fine");
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    const skill = registry.skills.find((s) => s.name === "swapme");
    if (!skill) throw new Error("skill missing");

    writeFileSync(join(outside, "secret.md"), "EXFILTRATED");
    rmSync(skill.path);
    symlinkSync(join(outside, "secret.md"), skill.path);

    await expect(readSkillBody(defaultRuntime, skill)).rejects.toThrow("outside the workspace");
  });

  test("a global skill symlink is exempt from confinement (user-owned)", async () => {
    const dataDir = tmp("minerva-skills-data-");
    const dotfiles = tmp("minerva-skills-dotfiles-");
    const { symlinkSync } = await import("node:fs");
    writeFileSync(
      join(dotfiles, "SKILL.md"),
      "---\ndescription: from dotfiles\n---\n\nDotfile body",
    );
    mkdirSync(join(dataDir, "skills", "dot"), { recursive: true });
    symlinkSync(join(dotfiles, "SKILL.md"), join(dataDir, "skills", "dot", "SKILL.md"));

    const registry = await loadSkills(defaultRuntime, dataDir, tmp("minerva-skills-proj-"));
    const skill = registry.skills.find((s) => s.name === "dot");
    if (!skill) throw new Error("skill missing");
    expect(await readSkillBody(defaultRuntime, skill)).toBe("Dotfile body");
  });

  test("frontmatter not closed within the prefix is skipped with a clear warning", async () => {
    const cwd = tmp("minerva-skills-proj-");
    mkdirSync(join(cwd, ".minerva", "skills", "huge"), { recursive: true });
    writeFileSync(
      join(cwd, ".minerva", "skills", "huge", "SKILL.md"),
      `---\ndescription: ${"x".repeat(10_000)}\n---\n\nbody`,
    );
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills).toHaveLength(0);
    expect(registry.warnings[0]).toContain("frontmatter not closed");
  });

  test("descriptions are clipped at 500 characters", async () => {
    const cwd = tmp("minerva-skills-proj-");
    writeSkill(join(cwd, ".minerva", "skills"), "wordy", `description: ${"d".repeat(600)}`);
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills[0]?.description.length).toBe(501); // 500 + ellipsis
    expect(registry.skills[0]?.description.endsWith("…")).toBe(true);
  });

  test("a directory with too many entries is capped with a warning", async () => {
    const cwd = tmp("minerva-skills-proj-");
    for (let i = 0; i < 65; i++) {
      writeSkill(
        join(cwd, ".minerva", "skills"),
        `skill-${String(i).padStart(3, "0")}`,
        "description: d",
      );
    }
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    expect(registry.skills).toHaveLength(64);
    expect(registry.warnings[0]).toContain("only the first 64");
  });

  test("a body past the char cap gets a truncation marker", async () => {
    const cwd = tmp("minerva-skills-proj-");
    writeSkill(join(cwd, ".minerva", "skills"), "big", "description: d", "b".repeat(60_000));
    const registry = await loadSkills(defaultRuntime, tmp("minerva-skills-data-"), cwd);
    const skill = registry.skills[0];
    if (!skill) throw new Error("skill missing");
    const body = await readSkillBody(defaultRuntime, skill);
    expect(body).toContain("[truncated: SKILL.md is");
    expect(body.length).toBeLessThan(51_000);
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

  test("a /name prompt expands for the provider while the transcript keeps the literal", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(
      join(cwd, ".minerva", "skills"),
      "haiku",
      "description: Answer in haiku",
      "Respond only in haiku form.",
    );

    const requests: TurnRequest[] = [];
    const capturing: ModelProvider = {
      id: "test/capturing",
      async *streamTurn(request) {
        requests.push(request);
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };

    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: capturing });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "/haiku describe the moon" }],
    });

    // The model sees the skill body plus the user's arguments…
    const sent = requests[0]?.messages.find((m) => m.role === "user");
    expect(sent && "content" in sent ? sent.content : "").toContain("Respond only in haiku form.");
    expect(sent && "content" in sent ? sent.content : "").toContain("describe the moon");

    // …while the log keeps what the user typed, and replay rebuilds the
    // provider context from the expanded text.
    const session = kernel.getSession(sessionId);
    if (!session) throw new Error("session missing");
    await session.flush();
    const events = parseEventLog(readFileSync(session.logPath, "utf8"));
    const userEvent = events.find((event) => event.type === "user.message");
    expect(userEvent).toMatchObject({ text: "/haiku describe the moon" });
    const replay = replayEvents(events, []);
    const replayedUser = replay.messages.find((m) => m.role === "user");
    expect(replayedUser && "content" in replayedUser ? replayedUser.content : "").toContain(
      "Respond only in haiku form.",
    );
    const rendered = replay.updates.find((u) => u.sessionUpdate === "user_message_chunk");
    expect(JSON.stringify(rendered)).toContain("/haiku describe the moon");
    expect(JSON.stringify(rendered)).not.toContain("Respond only in haiku");

    await kernel.close();
  }, 15_000);

  test("a slash line matching no skill passes through to the model unchanged", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    const requests: TurnRequest[] = [];
    const capturing: ModelProvider = {
      id: "test/capturing",
      async *streamTurn(request) {
        requests.push(request);
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: capturing });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "/typo do thing" }],
    });
    const sent = requests[0]?.messages.find((m) => m.role === "user");
    expect(sent && "content" in sent ? sent.content : "").toBe("/typo do thing");
    await kernel.close();
  }, 15_000);

  test("a skill added after session establish still expands (registry refresh on miss)", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    const requests: TurnRequest[] = [];
    const capturing: ModelProvider = {
      id: "test/capturing",
      async *streamTurn(request) {
        requests.push(request);
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: capturing });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    // The skill arrives only after the session was established.
    writeSkill(join(cwd, ".minerva", "skills"), "late", "description: Added late", "Late body.");
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "/late do it" }],
    });
    const sent = requests[0]?.messages.find((m) => m.role === "user");
    expect(sent && "content" in sent ? sent.content : "").toContain("Late body.");
    // The refreshed registry also advertises the skill tool in the same turn.
    expect(requests[0]?.tools.some((tool) => tool.name === "skill")).toBe(true);
    await kernel.close();
  }, 15_000);

  test("a project override added after establish shadows the cached global on /name", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(join(dataDir, "skills"), "demo", "description: global demo", "GLOBAL BODY");
    const requests: TurnRequest[] = [];
    const capturing: ModelProvider = {
      id: "test/capturing",
      async *streamTurn(request) {
        requests.push(request);
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: capturing });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    // The override arrives after the session cached the global registry.
    writeSkill(
      join(cwd, ".minerva", "skills"),
      "demo",
      "description: project demo",
      "PROJECT BODY",
    );
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "/demo run" }],
    });
    const sent = requests[0]?.messages.find((m) => m.role === "user");
    const content = sent && "content" in sent ? sent.content : "";
    expect(content).toContain("PROJECT BODY");
    expect(content).not.toContain("GLOBAL BODY");
    await kernel.close();
  }, 15_000);

  test("a project override deleted after establish falls back to the global skill", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(join(dataDir, "skills"), "demo", "description: global demo", "GLOBAL BODY");
    writeSkill(
      join(cwd, ".minerva", "skills"),
      "demo",
      "description: project demo",
      "PROJECT BODY",
    );
    const requests: TurnRequest[] = [];
    const capturing: ModelProvider = {
      id: "test/capturing",
      async *streamTurn(request) {
        requests.push(request);
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, { dataDir, provider: capturing });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    const { rmSync } = await import("node:fs");
    rmSync(join(cwd, ".minerva", "skills", "demo"), { recursive: true });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "/demo run" }],
    });
    const sent = requests[0]?.messages.find((m) => m.role === "user");
    expect(sent && "content" in sent ? sent.content : "").toContain("GLOBAL BODY");
    await kernel.close();
  }, 15_000);

  test("a deny rule blocks /name invocation while plain prompts still work", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(join(cwd, ".minerva", "skills"), "blocked", "description: d");
    mkdirSync(join(cwd, ".minerva"), { recursive: true });
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({ permissions: { deny: ["skill"] } }),
    );
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [
          { type: "text-delta", text: "plain ok" },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
      ]),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await expect(
      client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "/blocked go" }],
      }),
    ).rejects.toThrow("blocked by a deny permission rule");
    // The lease was released on the deny path: a normal prompt still runs.
    const plain = await client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(plain.stopReason).toBe("end_turn");
    await kernel.close();
  }, 15_000);

  test("a host-injected skill tool is not duplicated by the generated one", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(join(cwd, ".minerva", "skills"), "demo", "description: d");
    const requests: TurnRequest[] = [];
    const capturing: ModelProvider = {
      id: "test/capturing",
      async *streamTurn(request) {
        requests.push(request);
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
    const hostSkillTool = createSkillTool({
      skills: [{ name: "host-only", description: "host's own", source: "global", path: "/x" }],
      warnings: [],
    });
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: capturing,
      tools: [...builtinTools(), hostSkillTool],
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    const skillDefs = requests[0]?.tools.filter((tool) => tool.name === "skill") ?? [];
    expect(skillDefs).toHaveLength(1);
    expect(skillDefs[0]?.description).toContain("host-only");
    await kernel.close();
  }, 15_000);

  test("minerva/skills/list returns names, descriptions, and sources", async () => {
    const cwd = tmp("minerva-skills-proj-");
    const dataDir = tmp("minerva-skills-data-");
    writeSkill(join(cwd, ".minerva", "skills"), "deploy", "description: Ship it");
    writeSkill(join(dataDir, "skills"), "review", "description: Review it");

    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const result = await client.request<SkillsListResult>(MINERVA_METHODS.skillsList, { cwd });
    expect(result.skills).toEqual([
      { name: "deploy", description: "Ship it", source: "project" },
      { name: "review", description: "Review it", source: "global" },
    ]);
  });

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
