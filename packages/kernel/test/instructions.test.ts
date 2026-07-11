import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  Connection,
  createInProcTransportPair,
  type SessionNewResult,
} from "@minerva/protocol";
import type { ModelProvider, TurnRequest } from "@minerva/providers";
import {
  createKernel,
  defaultRuntime,
  loadProjectInstructions,
  MAX_INSTRUCTIONS_CHARS,
} from "../src";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("loadProjectInstructions", () => {
  test("no AGENTS.md anywhere yields empty text and no files", async () => {
    const result = await loadProjectInstructions(
      defaultRuntime,
      tmp("minerva-instr-data-"),
      tmp("minerva-instr-proj-"),
    );
    expect(result.text).toBe("");
    expect(result.files).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("project and global files compose in global-then-project order", async () => {
    const dataDir = tmp("minerva-instr-data-");
    const cwd = tmp("minerva-instr-proj-");
    writeFileSync(join(dataDir, "AGENTS.md"), "Always be terse.");
    writeFileSync(join(cwd, "AGENTS.md"), "Use bun, not npm.");

    const result = await loadProjectInstructions(defaultRuntime, dataDir, cwd);
    expect(result.files.map((f) => f.scope)).toEqual(["global", "project"]);
    expect(result.text).toContain("# Project instructions");
    const globalAt = result.text.indexOf("Always be terse.");
    const projectAt = result.text.indexOf("Use bun, not npm.");
    expect(globalAt).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(globalAt);
  });

  test("a project-only file loads without a global one", async () => {
    const cwd = tmp("minerva-instr-proj-");
    writeFileSync(join(cwd, "AGENTS.md"), "Project rules.");
    const result = await loadProjectInstructions(defaultRuntime, tmp("minerva-instr-data-"), cwd);
    expect(result.files).toEqual([expect.objectContaining({ scope: "project", truncated: false })]);
    expect(result.text).toContain("Project rules.");
  });

  test("an oversized file is truncated with a marker", async () => {
    const cwd = tmp("minerva-instr-proj-");
    writeFileSync(join(cwd, "AGENTS.md"), "x".repeat(MAX_INSTRUCTIONS_CHARS + 100));
    const result = await loadProjectInstructions(defaultRuntime, tmp("minerva-instr-data-"), cwd);
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.text).toContain("[truncated: AGENTS.md is");
  });

  test("an empty file is skipped entirely", async () => {
    const cwd = tmp("minerva-instr-proj-");
    writeFileSync(join(cwd, "AGENTS.md"), "  \n ");
    const result = await loadProjectInstructions(defaultRuntime, tmp("minerva-instr-data-"), cwd);
    expect(result.files).toHaveLength(0);
    expect(result.text).toBe("");
  });

  test("an unreadable file degrades to a warning, not a throw", async () => {
    const cwd = tmp("minerva-instr-proj-");
    // A directory named AGENTS.md fails reads with EISDIR — not ENOENT, so it
    // must surface as a warning rather than silent absence.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, "AGENTS.md"));
    const result = await loadProjectInstructions(defaultRuntime, tmp("minerva-instr-data-"), cwd);
    expect(result.warnings).toHaveLength(1);
    expect(result.files).toHaveLength(0);
  });
});

/** Records each turn's system prompt, then finishes with a scripted reply. */
function createCapturingProvider(captured: Array<string | undefined>): ModelProvider {
  return {
    id: "test/capturing",
    async *streamTurn(request: TurnRequest) {
      captured.push(request.system);
      yield { type: "text-delta" as const, text: "ok" };
      yield { type: "finish" as const, finishReason: "stop" as const, usage: {} };
    },
  };
}

describe("AGENTS.md through the kernel", () => {
  test("instructions reach the system prompt and session/new reports the files", async () => {
    const cwd = tmp("minerva-instr-proj-");
    const dataDir = tmp("minerva-instr-data-");
    writeFileSync(join(cwd, "AGENTS.md"), "Answer only in haiku.");

    const captured: Array<string | undefined> = [];
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createCapturingProvider(captured),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const result = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, { cwd });

    expect(result.instructions?.files).toEqual([
      { path: join(cwd, "AGENTS.md"), scope: "project", truncated: false },
    ]);

    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(captured[0]).toContain("You are Minerva");
    expect(captured[0]).toContain("Answer only in haiku.");
    await kernel.close();
  }, 15_000);

  test("without AGENTS.md the system prompt and result are unchanged", async () => {
    const cwd = tmp("minerva-instr-proj-");
    const dataDir = tmp("minerva-instr-data-");
    const captured: Array<string | undefined> = [];
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createCapturingProvider(captured),
    });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const result = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, { cwd });
    expect(result.instructions).toBeUndefined();

    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    // Regression guard: no instructions = exactly the default prompt.
    expect(captured[0]).not.toContain("# Project instructions");
    expect(captured[0]).toStartWith("You are Minerva");
    await kernel.close();
  }, 15_000);
});
