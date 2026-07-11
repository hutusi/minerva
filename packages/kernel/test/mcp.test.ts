import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { createKernel, type SessionEvent } from "../src";

const MCP_FIXTURE = join(import.meta.dir, "fixtures", "mcp-server.ts");

describe("MCP tools through the kernel", () => {
  test("configured server's tool executes behind a permission prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcp-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mcp-data-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({
        mcpServers: { calc: { command: "bun", args: ["run", MCP_FIXTURE] } },
      }),
    );

    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "mcp__calc__add",
            input: { a: 19, b: 23 },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "The sum is 42." },
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
      prompt: [{ type: "text", text: "add 19 and 23" }],
    });

    expect(result.stopReason).toBe("end_turn");
    // MCP tools are never auto-allowed: server hints don't bypass the engine.
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.toolCall.title).toBe("calc:add");

    const completed = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("42");

    // Audit trail records the namespaced tool.
    const session = kernel.getSession(sessionId);
    if (!session) throw new Error("session missing");
    await session.flush();
    const events = readFileSync(session.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    const toolCall = events.find((event) => event.type === "tool.call");
    expect(toolCall).toMatchObject({ toolName: "mcp__calc__add", input: { a: 19, b: 23 } });

    await kernel.close();
  }, 30_000);

  test("an MCP server launches in the session cwd, not the host cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcpcwd-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mcpcwd-data-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({ mcpServers: { calc: { command: "bun", args: ["run", MCP_FIXTURE] } } }),
    );
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    const kernel = createKernel(kernelTransport, {
      dataDir,
      provider: createScriptedProvider([
        [
          { type: "tool-call", toolCallId: "c1", toolName: "mcp__calc__pwd", input: {} },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
      ]),
    });
    const client = new Connection(clientTransport);
    const updates: SessionUpdateParams[] = [];
    client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
      updates.push(params as SessionUpdateParams);
    });
    client.handleRequest(CLIENT_METHODS.sessionRequestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }));
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "where are you" }],
    });

    const completed = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    // The server reported process.cwd(); it must be the session dir (realpath,
    // since macOS /tmp resolves to /private/var).
    expect(JSON.stringify(completed)).toContain(realpathSync(cwd));
    await kernel.close();
  }, 30_000);

  test("a broken MCP server degrades to a warning, not a failed session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcpbad-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mcpbad-data-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({
        mcpServers: { broken: { command: "/nonexistent/binary" } },
      }),
    );

    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const session = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, { cwd });
    expect(session.sessionId).toStartWith("ses_");
  }, 15_000);
});
