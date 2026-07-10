import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  type InitializeResult,
  PROTOCOL_VERSION,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionNewResult,
  type SessionPromptResult,
  type SessionUpdateParams,
  type StopReason,
  type Transport,
} from "@minerva/protocol";
import { SessionStore } from "./store";

export type PermissionHandler = (
  request: RequestPermissionParams,
) => Promise<RequestPermissionResult>;

export interface MinervaClientOptions {
  /**
   * Called when the kernel asks permission for a tool call. UIs resolve this
   * from user input; leaving it unset rejects every request (safe default).
   */
  onPermissionRequest?: PermissionHandler;
}

/**
 * Frontend-agnostic protocol client. Owns the connection and one
 * SessionStore per session; UIs subscribe to stores and render snapshots.
 */
export class MinervaClient {
  #connection: Connection;
  #stores = new Map<string, SessionStore>();
  #onPermissionRequest: PermissionHandler;

  constructor(transport: Transport, options: MinervaClientOptions = {}) {
    this.#onPermissionRequest =
      options.onPermissionRequest ?? (async () => ({ outcome: { outcome: "cancelled" } }));

    this.#connection = new Connection(transport);
    this.#connection.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
      const { sessionId, update } = params as SessionUpdateParams;
      this.#stores.get(sessionId)?.apply(update);
    });
    this.#connection.handleRequest(CLIENT_METHODS.sessionRequestPermission, (params) =>
      this.#onPermissionRequest(params as RequestPermissionParams),
    );
  }

  initialize(): Promise<InitializeResult> {
    return this.#connection.request<InitializeResult>(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  async newSession(cwd: string): Promise<{ sessionId: string; store: SessionStore }> {
    const { sessionId } = await this.#connection.request<SessionNewResult>(
      AGENT_METHODS.sessionNew,
      { cwd },
    );
    const store = new SessionStore();
    this.#stores.set(sessionId, store);
    return { sessionId, store };
  }

  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const store = this.#stores.get(sessionId);
    store?.addUserMessage(text);
    store?.setBusy(true);
    try {
      const result = await this.#connection.request<SessionPromptResult>(
        AGENT_METHODS.sessionPrompt,
        { sessionId, prompt: [{ type: "text", text }] },
      );
      return result.stopReason;
    } finally {
      store?.setBusy(false);
    }
  }

  cancel(sessionId: string): void {
    this.#connection.notify(AGENT_METHODS.sessionCancel, { sessionId });
  }

  getStore(sessionId: string): SessionStore | undefined {
    return this.#stores.get(sessionId);
  }

  close(): void {
    this.#connection.close();
  }
}
