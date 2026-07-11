import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  cwd: string,
): Promise<McpConnection> {
  const tools: KernelTool[] = [];
  const warnings: string[] = [];
  const clients: Client[] = [];

  // Connect independent servers concurrently; one slow/broken server must not
  // serialize the rest.
  await Promise.all(
    Object.entries(servers).map(async ([serverName, config]) => {
      try {
        const client = new Client({ name: "minerva", version: "0.1.0" });
        await connectClient(client, config, cwd);
        clients.push(client);
        const listed = await client.listTools();
        for (const tool of listed.tools) {
          tools.push(wrapMcpTool(client, serverName, tool));
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
async function connectClient(client: Client, config: McpServerConfig, cwd: string): Promise<void> {
  if (config.type === "http") {
    const url = new URL(config.url); // malformed URL → descriptive TypeError
    const options = config.headers ? { requestInit: { headers: config.headers } } : {};
    try {
      // Cast: the transport's `sessionId: string | undefined` doesn't unify
      // with the interface's `sessionId?: string` under
      // exactOptionalPropertyTypes — an SDK-internal mismatch, not ours.
      await client.connect(new StreamableHTTPClientTransport(url, options) as Transport);
    } catch (streamableError) {
      try {
        await client.connect(new SSEClientTransport(url, options));
      } catch {
        // The SSE attempt was only a courtesy; the streamable error names
        // the real problem (auth, DNS, protocol), so surface that one.
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
  );
}

interface McpToolInfo {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

function wrapMcpTool(client: Client, serverName: string, info: McpToolInfo): KernelTool {
  const qualifiedName = `mcp__${serverName}__${info.name}`;
  return {
    name: qualifiedName,
    description: info.description ?? `${info.name} (MCP server: ${serverName})`,
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
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : `[${String((part as { type?: unknown })?.type ?? "unknown")} content]`,
        )
        .join("\n");
      return { output: text || "(no output)", isError: result.isError === true };
    },
  };
}
