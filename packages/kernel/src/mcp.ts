import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./settings";
import type { KernelTool } from "./tools";
import { asRecord } from "./tools";

/**
 * MCP client (design decision #6): external tools arrive via the ecosystem
 * and flow through the same permission engine as built-ins. Tool names are
 * namespaced mcp__<server>__<tool> so rules can target them.
 */

export interface McpConnection {
  tools: KernelTool[];
  /** Servers that failed to connect, with the reason — callers surface these. */
  warnings: string[];
  close(): Promise<void>;
}

export interface McpConnectOptions {
  /** Shared per-server budget across connect + tool discovery. */
  startupTimeoutMs?: number;
}

/**
 * The SDK's default request timeout is 60s; with connect + listTools on the
 * session-establish critical path, one black-holed server could stall a new
 * session for two minutes. Servers run concurrently, but the slowest one
 * still gates session/new — bound it.
 */
const MCP_STARTUP_TIMEOUT_MS = 15_000;

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  cwd: string,
  options?: McpConnectOptions,
): Promise<McpConnection> {
  const tools: KernelTool[] = [];
  const warnings: string[] = [];
  const clients: Client[] = [];
  const startupTimeoutMs = options?.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;

  // Connect independent servers concurrently; one slow/broken server must not
  // serialize the rest.
  await Promise.all(
    Object.entries(servers).map(async ([serverName, config]) => {
      // One deadline covers connect AND discovery, so a server that answers
      // the handshake slowly can't buy itself a second full budget.
      const deadline = Date.now() + startupTimeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      const client = new Client({ name: "minerva", version: "0.1.0" });
      try {
        await connectClient(client, config, cwd, remaining);
        try {
          const listed = await client.listTools(undefined, { timeout: remaining() });
          clients.push(client);
          for (const tool of listed.tools) {
            tools.push(wrapMcpTool(client, serverName, tool));
          }
        } catch (error) {
          // Connected but discovery failed: close now, or the half-open
          // client lingers until session teardown.
          await client.close().catch(() => {});
          throw error;
        }
      } catch (error) {
        warnings.push(
          `MCP server "${serverName}" failed to start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),
  );

  return {
    tools,
    warnings,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

/**
 * Pick a transport from the config shape: `url` = remote Streamable HTTP
 * (with a one-shot SSE fallback for pre-2025-03 servers), `command` = local
 * stdio child. Throws into the caller's warning path — a bad entry degrades,
 * it never fails the session.
 */
async function connectClient(
  client: Client,
  config: McpServerConfig,
  cwd: string,
  /** Milliseconds left in the server's shared startup budget. */
  remaining: () => number,
): Promise<void> {
  if (config.type === "http") {
    const url = new URL(config.url); // malformed URL → descriptive TypeError
    const options = config.headers ? { requestInit: { headers: config.headers } } : {};
    try {
      // Cast: the transport's `sessionId: string | undefined` doesn't unify
      // with the interface's `sessionId?: string` under
      // exactOptionalPropertyTypes — an SDK-internal mismatch, not ours.
      await client.connect(new StreamableHTTPClientTransport(url, options) as Transport, {
        timeout: remaining(),
      });
    } catch (streamableError) {
      if (!shouldFallBackToSse(streamableError)) throw streamableError;
      try {
        await client.connect(new SSEClientTransport(url, options), { timeout: remaining() });
      } catch {
        // The SSE attempt was only a courtesy; the streamable error names
        // the real problem (auth, protocol), so surface that one.
        throw streamableError;
      }
    }
    return;
  }
  if (!config.command) {
    throw new Error('config needs a "command" (stdio) or "type": "http" with a "url"');
  }
  await client.connect(
    new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      // Launch the server in the session's working directory so relative
      // paths and project detection match the user's project, not the
      // Minerva host's cwd.
      cwd,
      // Merge with the SDK's safe defaults: passing env alone REPLACES
      // the environment, and a config that sets one variable would
      // otherwise strip PATH/HOME and break the server's spawn.
      ...(config.env ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
    }),
    { timeout: remaining() },
  );
}

/**
 * The MCP back-compat rule: fall back to legacy SSE only when the server
 * answered the Streamable HTTP initialize POST with a 4xx (405/404 per spec;
 * any 4xx counts, one fast extra request). Network failures (plain fetch
 * errors), 5xx, and non-HTTP errors mean the endpoint itself is broken —
 * retrying with SSE would just double the failure, and against a slow host
 * double the startup delay.
 */
function shouldFallBackToSse(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    error.code !== undefined &&
    error.code >= 400 &&
    error.code < 500
  );
}

interface McpToolInfo {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** Server-controlled text rides in every provider request — keep it bounded.
 * Input schemas stay unbounded (accepted risk: no meaningful cap exists that
 * wouldn't break legitimate tools). */
const MAX_MCP_DESCRIPTION_CHARS = 2_000;

/** Tool output enters kernel memory, the event log, replay, and the UI. */
const MAX_MCP_OUTPUT_CHARS = 50_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated: ${text.length} characters]` : text;
}

function wrapMcpTool(client: Client, serverName: string, info: McpToolInfo): KernelTool {
  const qualifiedName = `mcp__${serverName}__${info.name}`;
  return {
    name: qualifiedName,
    description: clip(
      info.description ?? `${info.name} (MCP server: ${serverName})`,
      MAX_MCP_DESCRIPTION_CHARS,
    ),
    inputSchema: info.inputSchema,
    kind: "other",
    // Server-provided readOnlyHint is not trusted for permission bypass:
    // MCP tools always go through the engine (deny/ask/allow rules + modes).
    readOnly: false,
    title() {
      return `${serverName}:${info.name}`;
    },
    async execute(input, context) {
      // Forward cancellation so a user cancel aborts the call instead of
      // waiting out the SDK's default request timeout.
      const result = await client.callTool(
        { name: info.name, arguments: asRecord(input) },
        undefined,
        context.signal ? { signal: context.signal } : {},
      );
      // Accumulate up to the cap instead of joining everything first, so the
      // kernel's own copy of a huge response stays bounded. The SDK has
      // already parsed the full response into result.content — bounding the
      // transport itself is out of scope (accepted).
      const content = Array.isArray(result.content) ? result.content : [];
      let output = "";
      let totalChars = 0;
      for (const part of content) {
        const rendered =
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : `[${String((part as { type?: unknown })?.type ?? "unknown")} content]`;
        totalChars += rendered.length + (totalChars > 0 ? 1 : 0); // "\n" joins
        if (output.length <= MAX_MCP_OUTPUT_CHARS) {
          output = output ? `${output}\n${rendered}` : rendered;
        }
      }
      if (totalChars > MAX_MCP_OUTPUT_CHARS) {
        output = `${output.slice(0, MAX_MCP_OUTPUT_CHARS)}\n[truncated: ${totalChars} characters]`;
      }
      return { output: output || "(no output)", isError: result.isError === true };
    },
  };
}
