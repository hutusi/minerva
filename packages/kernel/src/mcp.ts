import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
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
): Promise<McpConnection> {
  const tools: KernelTool[] = [];
  const warnings: string[] = [];
  const clients: Client[] = [];

  for (const [serverName, config] of Object.entries(servers)) {
    try {
      const client = new Client({ name: "minerva", version: "0.1.0" });
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          ...(config.args ? { args: config.args } : {}),
          // Merge with the SDK's safe defaults: passing env alone REPLACES
          // the environment, and a config that sets one variable would
          // otherwise strip PATH/HOME and break the server's spawn.
          ...(config.env ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
        }),
      );
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
  }

  return {
    tools,
    warnings,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
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
    async execute(input) {
      const result = await client.callTool({
        name: info.name,
        arguments: asRecord(input),
      });
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
