import { StringDecoder } from "node:string_decoder";
import type { JsonRpcMessage, Transport } from "./jsonrpc";

/** Drop the connection if a single unframed line grows past this — a peer that
 * never sends a newline must not buffer without bound. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Stream-based transport with ACP stdio framing: one JSON-RPC message per
 * line, delimited by `\n`, no embedded newlines (JSON.stringify guarantees
 * that — newlines inside strings are escaped). Used for `minerva acp`
 * (kernel on stdin/stdout) and, later, the Tauri sidecar.
 */
export function createStreamTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Transport {
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<() => void> = [];
  // Decode across chunk boundaries: a multibyte UTF-8 char split between two
  // reads would otherwise be corrupted by a per-chunk toString.
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let closed = false;

  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    // Everything before the last newline is complete messages; the remainder
    // stays buffered until the peer sends the rest of the line.
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let message: JsonRpcMessage | null = null;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          // A malformed line has no id to answer; skip it rather than kill
          // the connection.
        }
        if (message) {
          for (const handler of messageHandlers) handler(message);
        }
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_FRAME_BYTES) emitClose(); // runaway unframed input
  };

  // Backpressure-aware writer: queue frames and pause when the sink is full,
  // resuming on drain, so a slow reader can't grow the write buffer unbounded.
  const outQueue: string[] = [];
  let draining = false;
  const flush = () => {
    if (draining) return;
    while (outQueue.length > 0) {
      const frame = outQueue.shift() as string;
      if (!output.write(frame)) {
        draining = true;
        output.once("drain", () => {
          draining = false;
          flush();
        });
        return;
      }
    }
  };

  input.on("data", onData);
  input.on("end", emitClose);
  input.on("close", emitClose);
  input.on("error", emitClose);
  output.on("error", emitClose);

  return {
    send(message) {
      if (closed) return;
      outQueue.push(`${JSON.stringify(message)}\n`);
      flush();
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      input.off("data", onData);
      emitClose();
    },
  };
}
