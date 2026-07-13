import type { JsonRpcMessage, Transport } from "./jsonrpc";

/** Drop the connection if a single frame grows past this — a peer that sends a
 * huge (or never-terminated) line must not buffer without bound. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Cap the queued outbound bytes so a stalled reader can't exhaust memory. */
const MAX_OUTBOUND_BYTES = 64 * 1024 * 1024;

/** Overridable limits; tests inject tiny caps instead of allocating megabytes. */
export interface StreamTransportOptions {
  maxFrameBytes?: number;
  maxOutboundBytes?: number;
}

/**
 * Stream-based transport with ACP stdio framing: one JSON-RPC message per
 * line, delimited by `\n`, no embedded newlines (JSON.stringify guarantees
 * that — newlines inside strings are escaped). Used for `minerva acp`
 * (kernel on stdin/stdout) and, later, the Tauri sidecar.
 */
export function createStreamTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: StreamTransportOptions = {},
): Transport {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const maxOutboundBytes = options.maxOutboundBytes ?? MAX_OUTBOUND_BYTES;
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<() => void> = [];
  // Decode across chunk boundaries: a multibyte UTF-8 char split between two
  // reads would otherwise be corrupted by a per-chunk toString. TextDecoder
  // (not node:string_decoder) because this module also loads in the GUI
  // webview, where node: builtins don't exist — Vite externalizes them and
  // the import throws at module eval.
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let closed = false;

  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  // The cap is a byte budget, so it must be measured in UTF-8 bytes, not
  // `.length` (UTF-16 code units) — a multibyte line can be well over the byte
  // cap while its code-unit count is under it. Fast path: units <= bytes, so a
  // unit count already over the cap is decisive without an exact byte scan.
  const headOverCap = (): boolean => {
    const newline = buffer.indexOf("\n");
    const head = newline === -1 ? buffer : buffer.slice(0, newline);
    return head.length > maxFrameBytes || Buffer.byteLength(head, "utf8") > maxFrameBytes;
  };

  const onData = (chunk: Buffer | string) => {
    if (closed) return; // stop processing once the transport is torn down
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    // A single frame (framed OR not-yet-framed) larger than the cap is a
    // runaway/hostile peer — enforce the byte limit before parsing so a valid
    // 20 MB JSON line can't slip through.
    if (headOverCap()) {
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
      if (headOverCap()) {
        emitClose();
        return;
      }
      newline = buffer.indexOf("\n");
    }
  };

  // Backpressure-aware writer: queue frames and pause when the sink is full,
  // resuming on drain. Bound the queued bytes so a stalled reader can't grow
  // the outbound buffer without limit. Each entry carries its UTF-8 byte size
  // so the running total stays in bytes (not code units).
  const outQueue: Array<{ frame: string; bytes: number }> = [];
  let queuedBytes = 0;
  let draining = false;
  const flush = () => {
    if (draining) return;
    while (outQueue.length > 0) {
      const entry = outQueue.shift() as { frame: string; bytes: number };
      queuedBytes -= entry.bytes;
      if (!output.write(entry.frame)) {
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
      const bytes = Buffer.byteLength(frame, "utf8");
      // A reader that never drains would otherwise let the queue grow without
      // bound; past the cap, tear the connection down rather than exhaust memory.
      if (queuedBytes + bytes > maxOutboundBytes) {
        emitClose();
        return;
      }
      outQueue.push({ frame, bytes });
      queuedBytes += bytes;
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
