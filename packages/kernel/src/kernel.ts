import { join } from "node:path";
import {
  AGENT_METHODS,
  Connection,
  type InitializeResult,
  JSON_RPC_ERROR_CODES,
  PROTOCOL_VERSION,
  RpcError,
  type SessionNewResult,
  type SessionPromptResult,
  type Transport,
} from "@minerva/protocol";
import type { ModelProvider } from "@minerva/providers";
import { runPrompt } from "./agent-loop";
import { defaultRuntime, type Runtime } from "./runtime";
import { Session } from "./session";
import { builtinTools, type KernelTool } from "./tools";

export interface KernelOptions {
  provider: ModelProvider;
  runtime?: Runtime;
  /** Root for session logs and config; defaults to ~/.minerva. */
  dataDir?: string;
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
  #provider: ModelProvider;
  #runtime: Runtime;
  #dataDir: string;
  #tools: KernelTool[];
  #systemPrompt: (cwd: string) => string;

  constructor(transport: Transport, options: KernelOptions) {
    this.#provider = options.provider;
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#dataDir = options.dataDir ?? join(this.#runtime.homedir(), ".minerva");
    this.#tools = options.tools ?? builtinTools();
    this.#systemPrompt = options.systemPrompt ?? defaultSystemPrompt;

    this.#connection = new Connection(transport);
    this.#connection.handleRequest(AGENT_METHODS.initialize, () => this.#initialize());
    this.#connection.handleRequest(AGENT_METHODS.sessionNew, (params) => this.#sessionNew(params));
    this.#connection.handleRequest(AGENT_METHODS.sessionPrompt, (params) =>
      this.#sessionPrompt(params),
    );
    this.#connection.handleNotification(AGENT_METHODS.sessionCancel, (params) => {
      const { sessionId } = params as { sessionId?: string };
      if (sessionId) this.#sessions.get(sessionId)?.cancel();
    });
  }

  #initialize(): InitializeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
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
    return { sessionId: session.id };
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
        tools: this.#tools,
        system: this.#systemPrompt(session.cwd),
        runtime: this.#runtime,
      },
      text,
    );
  }

  /** For tests and diagnostics. */
  getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  close(): void {
    this.#connection.close();
  }
}

export function createKernel(transport: Transport, options: KernelOptions): MinervaKernel {
  return new MinervaKernel(transport, options);
}

function defaultSystemPrompt(cwd: string): string {
  return [
    `You are Minerva, a coding agent. Working directory: ${cwd}.`,
    "Use the available tools to inspect, edit, and run code. Read a file before",
    "editing it; edit_file requires the exact current text. Keep responses concise",
    "and factual, and report command failures honestly instead of glossing over them.",
  ].join(" ");
}
