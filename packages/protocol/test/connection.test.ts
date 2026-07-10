import { describe, expect, test } from "bun:test";
import { Connection, createInProcTransportPair, RpcError } from "../src";

function connectedPair(): [Connection, Connection] {
  const [a, b] = createInProcTransportPair();
  return [new Connection(a), new Connection(b)];
}

describe("Connection over in-proc transport", () => {
  test("request/response roundtrip", async () => {
    const [client, server] = connectedPair();
    server.handleRequest("echo", (params) => ({ echoed: params }));

    const result = await client.request("echo", { value: 42 });
    expect(result).toEqual({ echoed: { value: 42 } });
  });

  test("both sides can issue requests (bidirectional)", async () => {
    const [frontend, kernel] = connectedPair();
    kernel.handleRequest("session/prompt", async () => {
      // Mid-request, the kernel asks the frontend for permission.
      const permission = await kernel.request("session/request_permission", { tool: "bash" });
      return { permission };
    });
    frontend.handleRequest("session/request_permission", () => ({ outcome: "selected" }));

    const result = await frontend.request("session/prompt", {});
    expect(result).toEqual({ permission: { outcome: "selected" } });
  });

  test("notifications are delivered without a reply", async () => {
    const [client, server] = connectedPair();
    const received: unknown[] = [];
    server.handleNotification("session/update", (params) => {
      received.push(params);
    });

    client.notify("session/update", { seq: 1 });
    client.notify("session/update", { seq: 2 });
    await Bun.sleep(0);
    expect(received).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  test("handler throw becomes an RpcError for the caller", async () => {
    const [client, server] = connectedPair();
    server.handleRequest("boom", () => {
      throw new Error("kaputt");
    });

    await expect(client.request("boom")).rejects.toThrow("kaputt");
  });

  test("custom RpcError code survives the wire", async () => {
    const [client, server] = connectedPair();
    server.handleRequest("denied", () => {
      throw new RpcError(-32001, "not allowed", { reason: "policy" });
    });

    try {
      await client.request("denied");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32001);
      expect(rpcError.data).toEqual({ reason: "policy" });
    }
  });

  test("unknown method rejects with METHOD_NOT_FOUND", async () => {
    const [client] = connectedPair();
    try {
      await client.request("nope");
      expect.unreachable();
    } catch (error) {
      expect((error as RpcError).code).toBe(-32601);
    }
  });

  test("closing rejects pending requests", async () => {
    const [client, server] = connectedPair();
    server.handleRequest("hang", () => new Promise(() => {}));

    const pending = client.request("hang");
    client.close();
    await expect(pending).rejects.toThrow("connection closed");
  });

  test("concurrent requests correlate by id", async () => {
    const [client, server] = connectedPair();
    server.handleRequest("delayed", async (params) => {
      const { ms, tag } = params as { ms: number; tag: string };
      await Bun.sleep(ms);
      return tag;
    });

    const [slow, fast] = await Promise.all([
      client.request("delayed", { ms: 20, tag: "slow" }),
      client.request("delayed", { ms: 1, tag: "fast" }),
    ]);
    expect(slow).toBe("slow");
    expect(fast).toBe("fast");
  });
});
