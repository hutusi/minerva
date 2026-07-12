import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  type SessionNewResult,
} from "@minerva/protocol";
import { createScriptedProvider } from "@minerva/providers";
import { createKernel, defaultRuntime, type MinervaKernel } from "../src";
import { permissionValue } from "../src/permissions";
import { htmlToText, webFetchTool } from "../src/tools";
import { type BodyReader, readBoundedFrom } from "../src/tools/web-fetch";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const kernels: MinervaKernel[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
});

function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const ctx = (cwd: string) => ({ cwd, runtime: defaultRuntime });
const tmp = () => mkdtempSync(join(tmpdir(), "minerva-fetch-"));

describe("web_fetch", () => {
  test("plain text passes through; title is the URL", async () => {
    const base = serve(() => new Response("hello over http\n"));
    expect(webFetchTool.title({ url: `${base}/greeting` })).toBe(`${base}/greeting`);
    const result = await webFetchTool.execute({ url: `${base}/greeting` }, ctx(tmp()));
    expect(result.isError).toBe(false);
    expect(result.output).toBe("hello over http\n");
  });

  test("HTML is reduced to readable text", async () => {
    const base = serve(
      () =>
        new Response(
          "<html><head><style>p{color:red}</style><script>alert(1)</script></head>" +
            "<body><!-- note --><h1>Title</h1><p>First &amp; second.</p><p>Next&nbsp;line</p></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
    const result = await webFetchTool.execute({ url: base }, ctx(tmp()));
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Title");
    expect(result.output).toContain("First & second.");
    expect(result.output).toContain("Next line");
    expect(result.output).not.toContain("alert(1)");
    expect(result.output).not.toContain("color:red");
    expect(result.output).not.toContain("<p>");
  });

  test("JSON passes through; binary content types are refused", async () => {
    const base = serve((request) =>
      new URL(request.url).pathname === "/data.json"
        ? Response.json({ ok: true })
        : new Response("...", { headers: { "content-type": "application/octet-stream" } }),
    );
    const json = await webFetchTool.execute({ url: `${base}/data.json` }, ctx(tmp()));
    expect(json.isError).toBe(false);
    expect(json.output).toBe('{"ok":true}');

    const binary = await webFetchTool.execute({ url: `${base}/blob` }, ctx(tmp()));
    expect(binary.isError).toBe(true);
    expect(binary.output).toContain("unsupported content-type");
  });

  test("bodies are capped at 1 MiB and output at 30k characters", async () => {
    const base = serve(() => new Response("x".repeat(1_200_000)));
    const result = await webFetchTool.execute({ url: base }, ctx(tmp()));
    expect(result.isError).toBe(false);
    expect(result.output).toContain("[truncated at 30000 characters]");
    expect(result.output.length).toBeLessThan(30_100);
  });

  test("follows a redirect chain but rejects endless loops", async () => {
    const base = serve((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/a") return Response.redirect(`${base}/b`, 302);
      if (path === "/b") return Response.redirect(`${base}/final`, 301);
      if (path === "/final") return new Response("arrived");
      // /loop redirects to itself forever
      return Response.redirect(`${base}/loop`, 302);
    });
    const chain = await webFetchTool.execute({ url: `${base}/a` }, ctx(tmp()));
    expect(chain.isError).toBe(false);
    expect(chain.output).toBe("arrived");

    const loop = await webFetchTool.execute({ url: `${base}/loop` }, ctx(tmp()));
    expect(loop.isError).toBe(true);
    expect(loop.output).toContain("too many redirects");
  });

  test("rejects non-http schemes, initial and via redirect", async () => {
    const direct = await webFetchTool.execute({ url: "file:///etc/passwd" }, ctx(tmp()));
    expect(direct.isError).toBe(true);
    expect(direct.output).toContain("only http(s)");

    const base = serve(
      () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }),
    );
    const redirected = await webFetchTool.execute({ url: base }, ctx(tmp()));
    expect(redirected.isError).toBe(true);
    expect(redirected.output).toContain("redirect to unsupported scheme");
  });

  test("times out a stalled server", async () => {
    const base = serve(() => new Promise<Response>(() => {})); // never resolves
    const result = await webFetchTool.execute({ url: base, timeout_ms: 150 }, ctx(tmp()));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out after 150ms");
  }, 5_000);

  test("non-2xx statuses surface as errors with the body preserved", async () => {
    const base = serve(() => new Response("gone fishing", { status: 404 }));
    const result = await webFetchTool.execute({ url: base }, ctx(tmp()));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("[HTTP 404]");
    expect(result.output).toContain("gone fishing");
  });

  test("readBoundedFrom: a chunk landing exactly on the cap is handled precisely", async () => {
    const chunk = (size: number) => new Uint8Array(size).fill(120); // "x"
    const fakeReader = (chunks: Uint8Array[], moreAfter: boolean) => {
      let cancelled = false;
      let index = 0;
      const reader: BodyReader = {
        read: async () => {
          if (index < chunks.length) return { done: false, value: chunks[index++] };
          // After the scripted chunks: either EOF or one more pending chunk.
          if (moreAfter && index === chunks.length) {
            index++;
            return { done: false, value: chunk(1) };
          }
          return { done: true };
        },
        cancel: async () => {
          cancelled = true;
        },
      };
      return { reader, wasCancelled: () => cancelled };
    };

    // Exactly at the cap, then clean EOF: complete read, nothing to cancel.
    const eof = fakeReader([chunk(6), chunk(4)], false);
    const atCap = await readBoundedFrom(eof.reader, 10);
    expect(atCap).toEqual({ text: "x".repeat(10), truncated: false });
    expect(eof.wasCancelled()).toBe(false);

    // Exactly at the cap with more data pending: truncated AND cancelled.
    const pending = fakeReader([chunk(6), chunk(4)], true);
    const cut = await readBoundedFrom(pending.reader, 10);
    expect(cut).toEqual({ text: "x".repeat(10), truncated: true });
    expect(pending.wasCancelled()).toBe(true);

    // A chunk crossing the cap: trimmed, truncated, cancelled.
    const over = fakeReader([chunk(6), chunk(7)], false);
    const trimmed = await readBoundedFrom(over.reader, 10);
    expect(trimmed).toEqual({ text: "x".repeat(10), truncated: true });
    expect(over.wasCancelled()).toBe(true);

    // EOF under the cap: everything read, not truncated.
    const short = fakeReader([chunk(3)], false);
    expect(await readBoundedFrom(short.reader, 10)).toEqual({ text: "xxx", truncated: false });
    expect(short.wasCancelled()).toBe(false);
  });

  test("permissionValue matches rules against the URL", () => {
    expect(permissionValue({ url: "https://example.com/docs" })).toBe("https://example.com/docs");
    // command still wins for execute-shaped inputs
    expect(permissionValue({ command: "curl https://x", url: "https://x" })).toBe("curl https://x");
  });

  test("htmlToText collapses blank runs and decodes numeric entities", () => {
    // Runs of blank lines collapse to a single paragraph break.
    expect(htmlToText("<div>a</div>\n\n\n\n\n<div>&#65;&#x42;</div>")).toBe("a\n\nAB");
  });

  test("default mode prompts with the URL as the permission title", async () => {
    const cwd = tmp();
    const dataDir = tmp();
    const base = serve(() => new Response("fetched"));
    const url = `${base}/page`;
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    kernels.push(
      createKernel(kernelTransport, {
        dataDir,
        provider: createScriptedProvider([
          [
            { type: "tool-call", toolCallId: "c1", toolName: "web_fetch", input: { url } },
            { type: "finish", finishReason: "tool-calls", usage: {} },
          ],
          [
            { type: "text-delta", text: "done" },
            { type: "finish", finishReason: "stop", usage: {} },
          ],
        ]),
      }),
    );
    const client = new Connection(clientTransport);
    const titles: string[] = [];
    client.handleRequest(CLIENT_METHODS.sessionRequestPermission, (params) => {
      const { toolCall } = params as { toolCall: { title: string } };
      titles.push(toolCall.title);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    await client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await client.request<SessionNewResult>(AGENT_METHODS.sessionNew, {
      cwd,
    });
    await client.request(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "fetch it" }],
    });
    expect(titles).toEqual([url]);
  }, 15_000);
});
