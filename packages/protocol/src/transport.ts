import type { JsonRpcMessage, Transport } from "./jsonrpc";

/**
 * In-process transport: a linked pair of endpoints for frontends that embed
 * the kernel (the CLI). Delivery is deferred to a microtask so in-proc
 * behaves like every other transport — a handler never runs synchronously
 * inside the sender's stack frame, which would otherwise hide reentrancy
 * bugs that only surface on stdio/WebSocket.
 */
class InProcEndpoint implements Transport {
  peer!: InProcEndpoint;
  #messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  #closeHandlers: Array<() => void> = [];
  #closed = false;

  send(message: JsonRpcMessage): void {
    if (this.#closed || this.peer.#closed) return;
    queueMicrotask(() => {
      if (this.peer.#closed) return;
      for (const handler of this.peer.#messageHandlers) handler(message);
    });
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler();
    this.peer.#notifyPeerClosed();
  }

  #notifyPeerClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler();
  }
}

export function createInProcTransportPair(): [Transport, Transport] {
  const a = new InProcEndpoint();
  const b = new InProcEndpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
