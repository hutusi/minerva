import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  type InitializeResult,
  MINERVA_METHODS,
  PROTOCOL_VERSION,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionCompactResult,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionPromptResult,
  type SessionSummary,
  type SessionsListResult,
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
  #activePrompts = new Set<string>();
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
    const { sessionId, modes } = await this.#connection.request<SessionNewResult>(
      AGENT_METHODS.sessionNew,
      { cwd },
    );
    const store = new SessionStore();
    if (modes) store.setMode(modes.currentModeId);
    this.#stores.set(sessionId, store);
    return { sessionId, store };
  }

  /**
   * Resume a persisted session. The store must be registered before the
   * request goes out: the kernel replays the transcript as session/update
   * notifications ahead of its response.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{ sessionId: string; store: SessionStore }> {
    // Overwriting a live registration would detach that session's store from
    // the update stream (and the failure path would delete it outright).
    if (this.#stores.has(sessionId)) {
      throw new Error(`session ${sessionId} is already open in this client`);
    }
    const store = new SessionStore();
    this.#stores.set(sessionId, store);
    try {
      const { modes } = await this.#connection.request<SessionLoadResult>(
        AGENT_METHODS.sessionLoad,
        { sessionId, cwd },
      );
      if (modes) store.setMode(modes.currentModeId);
      // The replayed transcript is settled history — close any item the
      // replay left in the streaming state.
      store.setBusy(false);
      return { sessionId, store };
    } catch (error) {
      this.#stores.delete(sessionId);
      throw error;
    }
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const result = await this.#connection.request<SessionsListResult>(
      MINERVA_METHODS.sessionsList,
      { cwd },
    );
    return result.sessions;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.#connection.request(AGENT_METHODS.sessionSetMode, { sessionId, modeId });
  }

  /** Summarize and reset the model context; returns the summary. */
  async compact(sessionId: string): Promise<string> {
    // Same guard as prompt(): a rejected overlapping call must not clear the
    // in-flight prompt's busy state on its way out.
    if (this.#activePrompts.has(sessionId)) {
      throw new Error("a prompt is already running in this session");
    }
    this.#activePrompts.add(sessionId);
    const store = this.#stores.get(sessionId);
    store?.setBusy(true);
    try {
      const result = await this.#connection.request<SessionCompactResult>(
        MINERVA_METHODS.sessionCompact,
        { sessionId },
      );
      return result.summary;
    } finally {
      this.#activePrompts.delete(sessionId);
      store?.setBusy(false);
    }
  }

  async prompt(sessionId: string, text: string): Promise<StopReason> {
    // Reject overlapping prompts before touching the store: the kernel would
    // reject them anyway, but by then the rejected call's echo and its
    // finally-setBusy(false) would have clobbered the in-flight prompt's
    // view state.
    if (this.#activePrompts.has(sessionId)) {
      throw new Error("a prompt is already running in this session");
    }
    this.#activePrompts.add(sessionId);
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
      this.#activePrompts.delete(sessionId);
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
