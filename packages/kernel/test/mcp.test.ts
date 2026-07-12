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
import { createKernel, defaultRuntime, type SessionEvent } from "../src";
import { startHttpCalcServer } from "./fixtures/mcp-http-server";

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

  test("a Streamable HTTP server's tool executes end-to-end with headers from settings", async () => {
    const httpServer = await startHttpCalcServer();
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcphttp-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mcphttp-data-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({
        mcpServers: {
          calc: {
            type: "http",
            url: httpServer.url,
            headers: { Authorization: "Bearer test-token" },
          },
        },
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
    // Remote tools go through the same engine as stdio ones.
    expect(permissionRequests).toHaveLength(1);
    const completed = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("42");
    // Settings headers must reach the wire (bearer-token auth path).
    expect(httpServer.lastAuthorization()).toBe("Bearer test-token");

    await kernel.close();
    await httpServer.close();
  }, 30_000);

  test("an unreachable HTTP server degrades to a warning, not a failed session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcphttpbad-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mcphttpbad-data-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({
        mcpServers: {
          dead: { type: "http", url: "http://127.0.0.1:1/mcp" },
          nonsense: { type: "http", url: "not a url" },
          empty: {},
        },
      }),
    );

    const [clientTransport, kernelTransport] = createInProcTransportPair();
    createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) });
    const client = new Connection(clientTransport);
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const session = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, { cwd });
    expect(session.sessionId).toStartWith("ses_");
  }, 15_000);

  test("an explicit type:stdio entry still connects over stdio", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcpstdio-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-mcpstdio-data-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(
      join(cwd, ".minerva", "settings.json"),
      JSON.stringify({
        mcpServers: { calc: { type: "stdio", command: "bun", args: ["run", MCP_FIXTURE] } },
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
            input: { a: 1, b: 2 },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [
          { type: "text-delta", text: "3" },
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
      prompt: [{ type: "text", text: "add 1 and 2" }],
    });
    const completed = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("3");
    await kernel.close();
  }, 30_000);

  test("SSE fallback fires only for 4xx protocol rejections, not server failures", async () => {
    const { connectMcpServers } = await import("../src/mcp");
    const startPostRejecting = (postStatus: number) => {
      let gets = 0;
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          if (req.method === "GET") {
            gets++;
            return new Response("no sse here", { status: 404 });
          }
          return new Response("nope", { status: postStatus });
        },
      });
      return {
        url: `http://127.0.0.1:${server.port}/mcp`,
        gets: () => gets,
        close: () => server.stop(true),
      };
    };
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcpsse-proj-"));

    // 405 = "server doesn't speak Streamable HTTP" → one SSE attempt, and the
    // warning still names the original streamable failure.
    const legacy = startPostRejecting(405);
    const legacyResult = await connectMcpServers(
      { legacy: { type: "http", url: legacy.url } },
      cwd,
    );
    expect(legacy.gets()).toBe(1);
    // The warning surfaces the ORIGINAL streamable failure, not the SSE one.
    expect(legacyResult.warnings[0]).toContain("Error POSTing to endpoint");
    await legacyResult.close();
    legacy.close();

    // 500 = the endpoint itself is broken → fail fast, no SSE probe.
    const broken = startPostRejecting(500);
    const brokenResult = await connectMcpServers(
      { broken: { type: "http", url: broken.url } },
      cwd,
    );
    expect(broken.gets()).toBe(0);
    expect(brokenResult.warnings[0]).toContain("failed to start");
    await brokenResult.close();
    broken.close();
  }, 15_000);

  test("a hanging server is bounded by the startup deadline", async () => {
    const { connectMcpServers } = await import("../src/mcp");
    // POST never resolves — a black-holed server, the worst case for the
    // SDK's 60s default timeout.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcphang-proj-"));
    const started = Date.now();
    const connection = await connectMcpServers(
      { hang: { type: "http", url: `http://127.0.0.1:${server.port}/mcp` } },
      cwd,
      { startupTimeoutMs: 500 },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connection.tools).toHaveLength(0);
    expect(connection.warnings[0]).toContain("hang");
    await connection.close();
    server.stop(true);
  }, 10_000);

  test("remote tool output is capped before it reaches the log and UI", async () => {
    const { connectMcpServers } = await import("../src/mcp");
    const httpServer = await startHttpCalcServer();
    const cwd = mkdtempSync(join(tmpdir(), "minerva-mcpcap-proj-"));
    const connection = await connectMcpServers(
      { calc: { type: "http", url: httpServer.url } },
      cwd,
    );
    const spam = connection.tools.find((tool) => tool.name === "mcp__calc__spam");
    if (!spam) throw new Error("spam tool missing");
    const result = await spam.execute({ n: 60_000 }, { cwd, runtime: defaultRuntime });
    expect(result.output.length).toBeLessThan(50_100);
    expect(result.output).toContain("[truncated: 60000 characters]");
    await connection.close();
    await httpServer.close();
  }, 15_000);

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
