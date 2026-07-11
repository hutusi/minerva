/**
 * Minimal MCP server for integration tests: one "add" tool over stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "minerva-test-calc", version: "0.0.1" });

server.registerTool(
  "add",
  {
    description: "Add two numbers",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

server.registerTool(
  "pwd",
  { description: "Report the server's working directory", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: process.cwd() }] }),
);

await server.connect(new StdioServerTransport());
