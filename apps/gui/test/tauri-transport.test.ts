import { describe, expect, test } from "bun:test";
import type { JsonRpcMessage } from "@minerva/protocol";
import type { SidecarBridge } from "../src/lib/sidecar-bridge";
import { createSidecarTransport } from "../src/lib/tauri-transport";

interface FakeBridge extends SidecarBridge {
  sent: string[];
  emitLine(line: string): void;
  emitExit(code: number | null): void;
  failSends: boolean;
}

function createFakeBridge(): FakeBridge {
  const lineHandlers = new Set<(line: string) => void>();
  const exitHandlers = new Set<(code: number | null) => void>();
  const bridge: FakeBridge = {
    sent: [],
    failSends: false,
    emitLine(line) {
      for (const handler of lineHandlers) handler(line);
    },
    emitExit(code) {
      for (const handler of exitHandlers) handler(code);
    },
    async start() {},
    async send(line) {
      if (bridge.failSends) throw new Error("kernel is not running");
      bridge.sent.push(line);
    },
    async kill() {},
    onLine(handler) {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
  return bridge;
}

const REQUEST: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

describe("createSidecarTransport", () => {
  test("round-trips messages as single-line JSON frames", () => {
    const bridge = createFakeBridge();
    const transport = createSidecarTransport(bridge);
    const received: JsonRpcMessage[] = [];
    transport.onMessage((message) => received.push(message));

    transport.send(REQUEST);
    expect(bridge.sent).toEqual([JSON.stringify(REQUEST)]);
    expect(bridge.sent[0]).not.toContain("\n");

    bridge.emitLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  test("skips malformed frames without dropping the connection", () => {
    const bridge = createFakeBridge();
    const transport = createSidecarTransport(bridge);
    const received: JsonRpcMessage[] = [];
    let closed = 0;
    transport.onMessage((message) => received.push(message));
    transport.onClose(() => closed++);

    bridge.emitLine("not json at all {{{");
    bridge.emitLine(JSON.stringify(REQUEST));
    expect(received).toEqual([REQUEST]);
    expect(closed).toBe(0);
  });

  test("kernel exit closes the transport exactly once and stops delivery", () => {
    const bridge = createFakeBridge();
    const transport = createSidecarTransport(bridge);
    const received: JsonRpcMessage[] = [];
    let closed = 0;
    transport.onMessage((message) => received.push(message));
    transport.onClose(() => closed++);

    bridge.emitExit(1);
    bridge.emitExit(1);
    bridge.emitLine(JSON.stringify(REQUEST));
    transport.send(REQUEST);

    expect(closed).toBe(1);
    expect(received).toEqual([]);
    expect(bridge.sent).toEqual([]);
  });

  test("close() detaches from the bridge", () => {
    const bridge = createFakeBridge();
    const transport = createSidecarTransport(bridge);
    let closed = 0;
    transport.onClose(() => closed++);

    transport.close();
    expect(closed).toBe(1);
    bridge.emitExit(0);
    expect(closed).toBe(1);
  });

  test("a failed send closes the transport", async () => {
    const bridge = createFakeBridge();
    const transport = createSidecarTransport(bridge);
    let closed = 0;
    transport.onClose(() => closed++);

    bridge.failSends = true;
    transport.send(REQUEST);
    // send() failure propagates through a promise rejection handler.
    await Bun.sleep(0);
    expect(closed).toBe(1);
  });
});
