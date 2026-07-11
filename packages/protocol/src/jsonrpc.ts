/**
 * JSON-RPC 2.0 message types and a bidirectional connection.
 *
 * Both sides of a Minerva connection can issue requests: the frontend calls
 * `session/prompt` on the kernel, and mid-turn the kernel calls
 * `session/request_permission` back on the frontend. One Connection class
 * serves both roles.
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Error thrown to callers when the remote side returns a JSON-RPC error. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message) && "id" in message;
}

function isValidId(id: unknown): id is JsonRpcId {
  return typeof id === "number" || typeof id === "string";
}

/**
 * Structural check before a message is classified and dispatched. The wire is
 * only as trustworthy as the peer, and #dispatch routes responses to pending
 * requests by id — a shaped-but-invalid response (non-string method, both
 * result and error, a bad id type) could otherwise settle the wrong caller.
 */
export function isValidMessage(message: unknown): message is JsonRpcMessage {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return false;
  const hasMethod = "method" in m;
  const hasId = "id" in m;
  if (hasMethod && typeof m.method !== "string") return false;
  if (hasId && !isValidId(m.id)) return false;
  // A request (method + id) or notification (method, no id) is valid here.
  if (hasMethod) return true;
  // No method ⇒ it must be a response: a valid id and exactly one of
  // result/error. When it carries an error, the error object must be
  // well-formed — otherwise `error: null` slips through the dispatcher's
  // truthiness check and resolves the caller with `undefined`.
  if (!hasId) return false;
  const hasResult = "result" in m;
  const hasError = "error" in m;
  if (hasResult === hasError) return false; // need exactly one
  return hasError ? isValidError(m.error) : true; // result may be any value, incl. null
}

function isValidError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  return typeof e.code === "number" && typeof e.message === "string";
}

export interface Transport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: RpcError) => void;
}

export class Connection {
  #transport: Transport;
  #requestHandlers = new Map<string, RequestHandler>();
  #notificationHandlers = new Map<string, NotificationHandler>();
  #pending = new Map<JsonRpcId, PendingRequest>();
  #nextId = 1;
  #closed = false;

  constructor(transport: Transport) {
    this.#transport = transport;
    transport.onMessage((message) => this.#dispatch(message));
    transport.onClose(() => this.#handleClose());
  }

  handleRequest(method: string, handler: RequestHandler): void {
    this.#requestHandlers.set(method, handler);
  }

  handleNotification(method: string, handler: NotificationHandler): void {
    this.#notificationHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new RpcError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, "connection closed"));
    }
    if (signal?.aborted) {
      return Promise.reject(new RpcError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, "request aborted"));
    }
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    if (signal) {
      // JSON-RPC has no wire-level cancel; abort settles the caller locally
      // and a late response for this id is dropped by #dispatchResponse.
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.reject(new RpcError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, "request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
    }
    this.#transport.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#transport.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.#transport.close();
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new RpcError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, "connection closed"));
    }
    this.#pending.clear();
  }

  #dispatch(message: JsonRpcMessage): void {
    if (!isValidMessage(message)) {
      // Drop rather than misroute; stderr only where a console exists (never
      // stdout, which carries the protocol on stdio transports).
      if (typeof process !== "undefined") {
        process.stderr.write("minerva: dropping malformed JSON-RPC message\n");
      }
      return;
    }
    if (isResponse(message)) {
      this.#dispatchResponse(message);
    } else if (isRequest(message)) {
      void this.#dispatchRequest(message);
    } else if (isNotification(message)) {
      void this.#dispatchNotification(message);
    }
  }

  #dispatchResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new RpcError(response.error.code, response.error.message, response.error.data),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  async #dispatchRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.#requestHandlers.get(request.method);
    if (!handler) {
      this.#transport.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `method not found: ${request.method}`,
        },
      });
      return;
    }
    try {
      const result = await handler(request.params);
      if (this.#closed) return;
      this.#transport.send({ jsonrpc: "2.0", id: request.id, result: result ?? null });
    } catch (error) {
      if (this.#closed) return;
      const rpcError: JsonRpcError =
        error instanceof RpcError
          ? { code: error.code, message: error.message, data: error.data }
          : {
              code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
              message: error instanceof Error ? error.message : String(error),
            };
      this.#transport.send({ jsonrpc: "2.0", id: request.id, error: rpcError });
    }
  }

  async #dispatchNotification(notification: JsonRpcNotification): Promise<void> {
    const handler = this.#notificationHandlers.get(notification.method);
    if (!handler) return;
    try {
      await handler(notification.params);
    } catch {
      // Notifications have no reply channel; errors are the handler's problem.
    }
  }
}
