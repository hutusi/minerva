import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  type InitializeResult,
  JSON_RPC_ERROR_CODES,
  MINERVA_METHODS,
  PROTOCOL_VERSION,
  RpcError,
  type SessionCompactResult,
  type SessionLoadResult,
  type SessionModeState,
  type SessionNewResult,
  type SessionPromptResult,
  type SessionSetModeResult,
  type SessionSummary,
  type SessionsListResult,
  type Transport,
} from "@minerva/protocol";
import type { ModelProvider } from "@minerva/providers";
import { runPrompt } from "./agent-loop";
import { runCompact } from "./compact";
import { now } from "./events";
import { connectMcpServers, type McpConnection } from "./mcp";
import { isSessionModeId, SESSION_MODES } from "./permissions";
import { defaultRuntime, type Runtime } from "./runtime";
import { parseEventLog, projectDir, Session } from "./session";
import { defaultDataDir, loadSettings } from "./settings";
import { builtinTools, type KernelTool } from "./tools";

export interface KernelOptions {
  provider: ModelProvider;
  runtime?: Runtime;
  /** Root for session logs and config; defaults to ~/.minerva. */
  dataDir?: string | undefined;
  tools?: KernelTool[];
  systemPrompt?: (cwd: string) => string;
}

/**
 * The kernel host: binds the agent side of the protocol onto a transport.
 * Frontends only ever talk to this class through the wire protocol —
 * there is no privileged in-process API (design decision #2).
 */
export class MinervaKernel {
  #connection: Connection;
  #sessions = new Map<string, Session>();
  #mcp = new Map<string, McpConnection>();
  #provider: ModelProvider;
  #runtime: Runtime;
  #dataDir: string;
  #tools: KernelTool[];
  #systemPrompt: (cwd: string) => string;

  constructor(transport: Transport, options: KernelOptions) {
    this.#provider = options.provider;
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#dataDir = options.dataDir ?? defaultDataDir(this.#runtime);
    this.#tools = options.tools ?? builtinTools();
    this.#systemPrompt = options.systemPrompt ?? defaultSystemPrompt;

    this.#connection = new Connection(transport);
    this.#connection.handleRequest(AGENT_METHODS.initialize, () => this.#initialize());
    this.#connection.handleRequest(AGENT_METHODS.sessionNew, (params) => this.#sessionNew(params));
    this.#connection.handleRequest(AGENT_METHODS.sessionLoad, (params) =>
      this.#sessionLoad(params),
    );
    this.#connection.handleRequest(AGENT_METHODS.sessionPrompt, (params) =>
      this.#sessionPrompt(params),
    );
    this.#connection.handleRequest(AGENT_METHODS.sessionSetMode, (params) =>
      this.#sessionSetMode(params),
    );
    this.#connection.handleRequest(MINERVA_METHODS.sessionsList, (params) =>
      this.#sessionsList(params),
    );
    this.#connection.handleRequest(MINERVA_METHODS.sessionCompact, (params) =>
      this.#sessionCompact(params),
    );
    this.#connection.handleNotification(AGENT_METHODS.sessionCancel, (params) => {
      const { sessionId } = params as { sessionId?: string };
      if (sessionId) this.#sessions.get(sessionId)?.cancel();
    });
  }

  #initialize(): InitializeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    };
  }

  async #sessionNew(params: unknown): Promise<SessionNewResult> {
    const { cwd } = (params ?? {}) as { cwd?: string };
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "session/new requires cwd");
    }
    const session = await Session.create({
      cwd,
      dataDir: this.#dataDir,
      providerId: this.#provider.id,
      runtime: this.#runtime,
    });
    this.#sessions.set(session.id, session);
    await this.#connectMcp(session.id, cwd);
    return { sessionId: session.id, modes: modeState(session) };
  }

  /**
   * Connect the session's configured MCP servers. Failures degrade to
   * warnings on stderr — a broken server config must not brick sessions.
   */
  async #connectMcp(sessionId: string, cwd: string): Promise<void> {
    // Re-loading a session replaces its connection; close the old one or its
    // server processes leak for the kernel's lifetime.
    await this.#mcp.get(sessionId)?.close();
    this.#mcp.delete(sessionId);

    const settings = await loadSettings(this.#runtime, this.#dataDir, cwd);
    if (Object.keys(settings.mcpServers).length === 0) return;
    const connection = await connectMcpServers(settings.mcpServers);
    for (const warning of connection.warnings) {
      process.stderr.write(`minerva: ${warning}\n`);
    }
    this.#mcp.set(sessionId, connection);
  }

  #toolsFor(sessionId: string): KernelTool[] {
    const mcpTools = this.#mcp.get(sessionId)?.tools ?? [];
    return mcpTools.length > 0 ? [...this.#tools, ...mcpTools] : this.#tools;
  }

  async #sessionLoad(params: unknown): Promise<SessionLoadResult> {
    const { sessionId, cwd } = (params ?? {}) as { sessionId?: string; cwd?: string };
    if (typeof sessionId !== "string" || typeof cwd !== "string" || cwd.length === 0) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        "session/load requires sessionId and cwd",
      );
    }
    const existing = this.#sessions.get(sessionId);
    if (existing?.promptActive) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "cannot load a session while a prompt is running in it",
      );
    }
    // The live session's log writes are fire-and-forget; settle them before
    // rebuilding from the file or the reload silently drops recent events.
    await existing?.flush().catch(() => {});

    let loaded: Awaited<ReturnType<typeof Session.load>>;
    try {
      loaded = await Session.load(
        sessionId,
        { cwd, dataDir: this.#dataDir, providerId: this.#provider.id, runtime: this.#runtime },
        this.#tools,
      );
    } catch (error) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#sessions.set(sessionId, loaded.session);
    await this.#connectMcp(sessionId, cwd);
    // ACP: replay the conversation as session/update notifications before
    // answering, so the frontend can rebuild its transcript.
    for (const update of loaded.replay.updates) {
      this.#connection.notify(CLIENT_METHODS.sessionUpdate, { sessionId, update });
    }
    return { modes: modeState(loaded.session) };
  }

  async #sessionSetMode(params: unknown): Promise<SessionSetModeResult> {
    const { sessionId, modeId } = (params ?? {}) as { sessionId?: string; modeId?: string };
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!session) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, `unknown session: ${sessionId}`);
    }
    if (!isSessionModeId(modeId)) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, `unknown mode: ${modeId}`);
    }
    session.mode = modeId;
    session.append({ type: "session.mode_changed", modeId, at: now() });
    // Settle the write before acknowledging: a mode change that vanishes on
    // restart (kill right after switching to plan) is a policy surprise.
    await session.flush();
    this.#connection.notify(CLIENT_METHODS.sessionUpdate, {
      sessionId: session.id,
      update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
    });
    return null;
  }

  async #sessionsList(params: unknown): Promise<SessionsListResult> {
    const { cwd } = (params ?? {}) as { cwd?: string };
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "sessions/list requires cwd");
    }
    const dir = projectDir(this.#dataDir, cwd);
    let raw: string;
    try {
      raw = await this.#runtime.readTextFile(join(dir, "index.jsonl"));
    } catch {
      return { sessions: [] };
    }
    const entries = raw
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionSummary];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.cwd === cwd);

    // The index is append-per-use (create and resume both write), so the
    // last entry per session id reflects most-recent use. Return the 20
    // most recently used — a hard cap, matching the picker UIs it feeds.
    const bySessionId = new Map<string, SessionSummary>();
    for (const entry of entries) bySessionId.set(entry.sessionId, entry);
    const recent = [...bySessionId.values()].reverse().slice(0, 20);
    const sessions = await Promise.all(
      recent.map(async (entry) => ({
        ...entry,
        preview: await this.#sessionPreview(dir, entry.sessionId),
      })),
    );
    return { sessions };
  }

  async #sessionPreview(dir: string, sessionId: string): Promise<string | undefined> {
    try {
      const raw = await this.#runtime.readTextFile(join(dir, `${sessionId}.jsonl`));
      for (const event of parseEventLog(raw)) {
        if (event.type === "user.message") {
          // Slice by code point so an emoji at the boundary isn't torn.
          const chars = [...event.text];
          return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : event.text;
        }
      }
    } catch {
      // Index entry without a readable log — list it without a preview.
    }
    return undefined;
  }

  async #sessionPrompt(params: unknown): Promise<SessionPromptResult> {
    const { sessionId, prompt } = (params ?? {}) as {
      sessionId?: string;
      prompt?: Array<{ type?: string; text?: string }>;
    };
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!session) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, `unknown session: ${sessionId}`);
    }
    if (session.promptActive) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "a prompt is already running in this session",
      );
    }
    const text = (prompt ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (!text) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "prompt has no text content");
    }

    return runPrompt(
      {
        session,
        connection: this.#connection,
        provider: this.#provider,
        tools: this.#toolsFor(session.id),
        system: this.#systemPrompt(session.cwd),
        runtime: this.#runtime,
      },
      text,
    );
  }

  async #sessionCompact(params: unknown): Promise<SessionCompactResult> {
    const { sessionId } = (params ?? {}) as { sessionId?: string };
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!session) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, `unknown session: ${sessionId}`);
    }
    if (session.promptActive) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "cannot compact while a prompt is running",
      );
    }
    if (session.messages.length === 0) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, "nothing to compact yet");
    }
    const summary = await runCompact(session, this.#provider);
    return { summary };
  }

  /** For tests and diagnostics. */
  getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  close(): void {
    for (const connection of this.#mcp.values()) {
      void connection.close();
    }
    this.#mcp.clear();
    this.#connection.close();
  }
}

export function createKernel(transport: Transport, options: KernelOptions): MinervaKernel {
  return new MinervaKernel(transport, options);
}

function modeState(session: Session): SessionModeState {
  return { currentModeId: session.mode, availableModes: SESSION_MODES };
}

function defaultSystemPrompt(cwd: string): string {
  return [
    `You are Minerva, a coding agent. Working directory: ${cwd}.`,
    "Use the available tools to inspect, edit, and run code. Read a file before",
    "editing it; edit_file requires the exact current text. Keep responses concise",
    "and factual, and report command failures honestly instead of glossing over them.",
  ].join(" ");
}
