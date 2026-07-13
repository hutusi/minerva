import type { JsonRpcMessage, Transport } from "@minerva/protocol";
import type { SidecarBridge } from "./sidecar-bridge";

/**
 * Protocol transport over the sidecar bridge. Framing (line splitting, UTF-8
 * chunk boundaries) already happened on the Rust side, so this is a thin
 * JSON codec with the same tolerance as the stdio transport: malformed lines
 * are skipped (they carry no id to answer), close fires exactly once.
 */
export function createSidecarTransport(bridge: SidecarBridge): Transport {
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;

  const emitClose = () => {
    if (closed) return;
    closed = true;
    unsubscribeLine();
    unsubscribeExit();
    for (const handler of closeHandlers) handler();
  };

  const unsubscribeLine = bridge.onLine((line) => {
    if (closed) return;
    let message: JsonRpcMessage | null = null;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Malformed frame — skip it rather than kill the connection.
    }
    if (message) {
      for (const handler of messageHandlers) handler(message);
    }
  });
  const unsubscribeExit = bridge.onExit(() => emitClose());

  return {
    send(message: JsonRpcMessage) {
      if (closed) return;
      // Transport.send is fire-and-forget; a dead peer surfaces as the exit
      // event → close, matching the stream transport's failure path.
      bridge.send(JSON.stringify(message)).catch(() => emitClose());
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      emitClose();
    },
  };
}
