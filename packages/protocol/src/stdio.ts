import { StringDecoder } from "node:string_decoder";
import type { JsonRpcMessage, Transport } from "./jsonrpc";

/** Drop the connection if a single frame grows past this — a peer that sends a
 * huge (or never-terminated) line must not buffer without bound. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Cap the queued outbound bytes so a stalled reader can't exhaust memory. */
const MAX_OUTBOUND_BYTES = 64 * 1024 * 1024;

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
    if (closed) return; // stop processing once the transport is torn down
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    // A single frame (framed OR not-yet-framed) larger than the cap is a
    // runaway/hostile peer — enforce the byte limit before parsing so a valid
    // 20 MB JSON line can't slip through.
    const firstNewline = buffer.indexOf("\n");
    const pendingFrameLength = firstNewline === -1 ? buffer.length : firstNewline;
    if (pendingFrameLength > MAX_FRAME_BYTES) {
      emitClose();
      return;
    }
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
      // The next unframed remainder must also respect the cap.
      const nextNewline = buffer.indexOf("\n");
      if ((nextNewline === -1 ? buffer.length : nextNewline) > MAX_FRAME_BYTES) {
        emitClose();
        return;
      }
      newline = buffer.indexOf("\n");
    }
  };

  // Backpressure-aware writer: queue frames and pause when the sink is full,
  // resuming on drain. Bound the queued bytes so a stalled reader can't grow
  // the outbound buffer without limit.
  const outQueue: string[] = [];
  let queuedBytes = 0;
  let draining = false;
  const flush = () => {
    if (draining) return;
    while (outQueue.length > 0) {
      const frame = outQueue.shift() as string;
      queuedBytes -= frame.length;
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
      const frame = `${JSON.stringify(message)}\n`;
      // A reader that never drains would otherwise let the queue grow without
      // bound; past the cap, tear the connection down rather than exhaust memory.
      if (queuedBytes + frame.length > MAX_OUTBOUND_BYTES) {
        emitClose();
        return;
      }
      outQueue.push(frame);
      queuedBytes += frame.length;
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
