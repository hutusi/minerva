/**
 * Minimal Streamable HTTP MCP server for integration tests: the same "add"
 * tool as the stdio fixture, served in-process via Bun.serve so tests get a
 * real HTTP round-trip without spawning a child process.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface HttpCalcServer {
  url: string;
  /** Value of the Authorization header on the most recent request, if any. */
  lastAuthorization: () => string | null;
  close: () => Promise<void>;
}

export async function startHttpCalcServer(): Promise<HttpCalcServer> {
  let lastAuthorization: string | null = null;
  const httpServer = Bun.serve({
    port: 0,
    // Stateless mode requires a fresh server+transport per request (the SDK
    // rejects reuse); each request is self-contained, which is the simplest
    // shape that still exercises the client's full HTTP path.
    async fetch(request) {
      lastAuthorization = request.headers.get("authorization");
      const server = new McpServer({ name: "minerva-test-http-calc", version: "0.0.1" });
      server.registerTool(
        "add",
        { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
        async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
      );
      // No sessionIdGenerator = stateless mode (explicit `undefined` trips
      // exactOptionalPropertyTypes against the SDK's option types).
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });

  return {
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    lastAuthorization: () => lastAuthorization,
    close: async () => {
      await httpServer.stop(true);
    },
  };
}
