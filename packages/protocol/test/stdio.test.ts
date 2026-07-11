import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Connection, createStreamTransport, type JsonRpcMessage } from "../src";

function streamPair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = createStreamTransport(bToA, aToB);
  const b = createStreamTransport(aToB, bToA);
  return { a, b, aToB, bToA };
}

describe("stream transport (ACP stdio framing)", () => {
  test("request/response roundtrip over streams", async () => {
    const { a, b } = streamPair();
    const server = new Connection(b);
    server.handleRequest("echo", (params) => ({ echoed: params }));
    const client = new Connection(a);

    const result = await client.request("echo", { hello: "stdio" });
    expect(result).toEqual({ echoed: { hello: "stdio" } });
  });

  test("messages split across chunks and batched in one chunk both parse", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStreamTransport(input, output);
    const received: JsonRpcMessage[] = [];
    transport.onMessage((message) => received.push(message));

    // Half a message, then the rest plus two complete messages in one chunk.
    const m = (n: number) => JSON.stringify({ jsonrpc: "2.0", method: "m", params: { n } });
    const full = `${m(1)}\n${m(2)}\n${m(3)}\n`;
    input.write(full.slice(0, 10));
    await Bun.sleep(1);
    input.write(full.slice(10));
    await Bun.sleep(1);

    expect(received).toHaveLength(3);
    expect(received.map((msg) => (msg as { params: { n: number } }).params.n)).toEqual([1, 2, 3]);
  });

  test("newlines inside string values survive framing", async () => {
    const { a, b } = streamPair();
    const server = new Connection(b);
    server.handleRequest("echo", (params) => params);
    const client = new Connection(a);

    const result = await client.request("echo", { text: "line one\nline two\n" });
    expect(result).toEqual({ text: "line one\nline two\n" });
  });

  test("malformed lines are skipped without killing the connection", async () => {
    const input = new PassThrough();
    const transport = createStreamTransport(input, new PassThrough());
    const received: JsonRpcMessage[] = [];
    transport.onMessage((message) => received.push(message));

    input.write('this is not json\n{"jsonrpc":"2.0","method":"ok"}\n');
    await Bun.sleep(1);
    expect(received).toEqual([{ jsonrpc: "2.0", method: "ok" }]);
  });

  test("a multibyte char split across chunks decodes intact", async () => {
    const input = new PassThrough();
    const transport = createStreamTransport(input, new PassThrough());
    const received: JsonRpcMessage[] = [];
    transport.onMessage((message) => received.push(message));

    // "中文" is 6 UTF-8 bytes; split the first char across two writes.
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "中文" })}\n`, "utf8");
    const cut = frame.indexOf(Buffer.from("中", "utf8")[0] as number) + 1;
    input.write(frame.subarray(0, cut));
    await Bun.sleep(1);
    input.write(frame.subarray(cut));
    await Bun.sleep(1);

    expect(received).toEqual([{ jsonrpc: "2.0", method: "中文" }]);
  });

  test("a runaway unframed line closes the transport instead of buffering forever", async () => {
    const input = new PassThrough();
    const transport = createStreamTransport(input, new PassThrough());
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    // 20MB with no newline exceeds the 16MB frame cap.
    input.write("x".repeat(20 * 1024 * 1024));
    await Bun.sleep(1);
    expect(closed).toBe(true);
  });

  test("input end closes the transport and rejects pending requests", async () => {
    const input = new PassThrough();
    const transport = createStreamTransport(input, new PassThrough());
    const client = new Connection(transport);
    const pending = client.request("never");
    input.end();
    await expect(pending).rejects.toThrow("connection closed");
  });
});
