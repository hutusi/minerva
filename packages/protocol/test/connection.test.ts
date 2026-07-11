import { describe, expect, test } from "bun:test";
import { Connection, createInProcTransportPair, isValidMessage, RpcError } from "../src";

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

  test("a shaped-but-invalid response is dropped, not misrouted to a pending request", async () => {
    const [a, b] = createInProcTransportPair();
    const client = new Connection(a);
    // No server on `b`; drive raw messages back over it. The first request
    // takes id 1.
    const pending = client.request<string>("echo");
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Both result and error → an invalid response that must not settle id 1.
    b.send({ jsonrpc: "2.0", id: 1, result: "wrong", error: { code: 1, message: "x" } });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    // A well-formed response for the same id still settles it.
    b.send({ jsonrpc: "2.0", id: 1, result: "ok" });
    expect(await pending).toBe("ok");
  });

  test("isValidMessage accepts valid shapes and rejects malformed ones", () => {
    expect(isValidMessage({ jsonrpc: "2.0", method: "m", id: 1 })).toBe(true); // request
    expect(isValidMessage({ jsonrpc: "2.0", method: "m" })).toBe(true); // notification
    expect(isValidMessage({ jsonrpc: "2.0", id: 1, result: "ok" })).toBe(true); // response
    expect(isValidMessage({ jsonrpc: "2.0", id: 1, result: null })).toBe(true); // null result
    expect(isValidMessage({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "e" } })).toBe(true);

    expect(isValidMessage({ jsonrpc: "1.0", method: "m" })).toBe(false); // wrong version
    expect(isValidMessage({ jsonrpc: "2.0", method: 123, id: 1 })).toBe(false); // non-string method
    expect(isValidMessage({ jsonrpc: "2.0", id: {}, method: "m" })).toBe(false); // bad id type
    expect(isValidMessage({ jsonrpc: "2.0", id: 1 })).toBe(false); // response with neither
    expect(
      isValidMessage({ jsonrpc: "2.0", id: 1, result: "a", error: { code: 1, message: "e" } }),
    ).toBe(false); // response with both
    // Malformed error objects must be rejected, or `error: null` resolves the
    // caller with undefined instead of rejecting.
    expect(isValidMessage({ jsonrpc: "2.0", id: 1, error: null })).toBe(false);
    expect(isValidMessage({ jsonrpc: "2.0", id: 1, error: {} })).toBe(false);
    expect(isValidMessage({ jsonrpc: "2.0", id: 1, error: { code: "x", message: "y" } })).toBe(
      false,
    );
    expect(isValidMessage(null)).toBe(false);
  });

  test("a null-error response is dropped, not resolved with undefined", async () => {
    const [a, b] = createInProcTransportPair();
    const client = new Connection(a);
    const pending = client.request("echo"); // id 1
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    b.send({ jsonrpc: "2.0", id: 1, error: null } as unknown as Parameters<typeof b.send>[0]);
    await Bun.sleep(0);
    expect(settled).toBe(false);

    b.send({ jsonrpc: "2.0", id: 1, result: "ok" });
    expect(await pending).toBe("ok");
  });

  test("a well-formed error response rejects the pending request", async () => {
    const [a, b] = createInProcTransportPair();
    const client = new Connection(a);
    const pending = client.request("echo"); // id 1
    b.send({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "denied" } });
    await expect(pending).rejects.toMatchObject({ code: -32001 });
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
