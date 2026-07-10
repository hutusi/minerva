import type { JsonRpcMessage, Transport } from "./jsonrpc";

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
  let buffer = "";
  let closed = false;

  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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
  };

  input.on("data", onData);
  input.on("end", emitClose);
  input.on("close", emitClose);
  input.on("error", emitClose);
  output.on("error", emitClose);

  return {
    send(message) {
      if (closed) return;
      output.write(`${JSON.stringify(message)}\n`);
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
