import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  type ConfigSetModelParams,
  type ConfigSetModelResult,
  Connection,
  type InitializeParams,
  type InitializeResult,
  type InstructionsInfo,
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
  type SessionUsageParams,
  type SkillsListResult,
  type Transport,
} from "@minerva/protocol";
import { buildProviderRegistry, type ModelProvider } from "@minerva/providers";
import { type LoopContext, runPrompt } from "./agent-loop";
import { runCompact } from "./compact";
import { now } from "./events";
import { loadProjectInstructions, type ProjectInstructions } from "./instructions";
import { connectMcpServers, type McpConnection } from "./mcp";
import { isSessionModeId, SESSION_MODES } from "./permissions";
import { defaultRuntime, isNotFoundError, type Runtime } from "./runtime";
import {
  migrateDataDirPermissions,
  parseEventLog,
  previewText,
  projectDir,
  Session,
} from "./session";
import {
  defaultDataDir,
  loadSettings,
  type ProviderSettings,
  updateGlobalSettings,
} from "./settings";
import { loadSkills, readSkillBody, type SkillRegistry } from "./skills";
import { builtinTools, createSkillTool, type KernelTool } from "./tools";
import { hasUsage, toTokenUsage } from "./usage";

/**
 * A whole transcript can be large; over stdio a client that negotiated batch
 * replay would disconnect once one batch serialized past the transport frame
 * cap (16 MB). Split replay into batches whose serialized size stays well under
 * that, plus a count guard so a batch of tiny updates isn't unbounded work. The
 * kernel stays transport-agnostic (in-proc has no frame limit) — this is a safe
 * worst-case for stdio and harmless elsewhere. Batches are additive on the
 * client, so N of them rebuild the same transcript as one.
 */
const REPLAY_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const REPLAY_BATCH_MAX_UPDATES = 1000;

export function chunkReplayUpdates<T>(updates: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const update of updates) {
    const bytes = Buffer.byteLength(JSON.stringify(update), "utf8");
    // Start a fresh batch when adding this update would breach either bound —
    // but never emit an empty batch, so a single oversized update still ships
    // alone (nothing smaller can be done for it).
    if (
      current.length > 0 &&
      (currentBytes + bytes > REPLAY_BATCH_MAX_BYTES || current.length >= REPLAY_BATCH_MAX_UPDATES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(update);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface KernelOptions {
  provider: ModelProvider;
  /**
   * Host-supplied factory for switching models at runtime
   * (minerva/config/set_model). Injected rather than built in so the kernel
   * never sees provider construction (or the AI SDK); hosts that omit it
   * simply reject the method.
   */
  resolveProvider?: (modelRef: string) => ModelProvider | Promise<ModelProvider>;
  runtime?: Runtime;
  /** Root for session logs and config; defaults to ~/.minerva. */
  dataDir?: string | undefined;
  tools?: KernelTool[];
  systemPrompt?: (cwd: string) => string;
  /** Max time close() waits for in-flight operations to drain (ms, default 5000). */
  shutdownDrainMs?: number | undefined;
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
  #instructions = new Map<string, ProjectInstructions>();
  #skills = new Map<string, SkillRegistry>();
  #provider: ModelProvider;
  #resolveProvider: KernelOptions["resolveProvider"];
  #runtime: Runtime;
  #dataDir: string;
  #tools: KernelTool[];
  #systemPrompt: (cwd: string) => string;
  /** Operations running now; drained on shutdown so their trailing events are
   * flushed before the process exits. */
  #inFlight = new Set<Promise<unknown>>();
  #closed = false;
  #shutdownDrainMs: number;
  /** Set from the initialize handshake; gates the minerva batch-replay
   * extension so generic ACP clients still get standard notifications. */
  #clientSupportsBatch = false;

  constructor(transport: Transport, options: KernelOptions) {
    this.#provider = options.provider;
    this.#resolveProvider = options.resolveProvider;
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#dataDir = options.dataDir ?? defaultDataDir(this.#runtime);
    this.#tools = options.tools ?? builtinTools();
    this.#systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.#shutdownDrainMs = options.shutdownDrainMs ?? 5000;
    // Tighten any pre-existing data dir to owner-only; best-effort, never
    // blocks startup.
    void migrateDataDirPermissions(this.#runtime, this.#dataDir).catch(() => {});

    this.#connection = new Connection(transport);
    this.#register(AGENT_METHODS.initialize, (params) => this.#initialize(params));
    this.#register(AGENT_METHODS.sessionNew, (params) => this.#sessionNew(params));
    this.#register(AGENT_METHODS.sessionLoad, (params) => this.#sessionLoad(params));
    this.#register(AGENT_METHODS.sessionPrompt, (params) => this.#sessionPrompt(params));
    this.#register(AGENT_METHODS.sessionSetMode, (params) => this.#sessionSetMode(params));
    this.#register(MINERVA_METHODS.sessionsList, (params) => this.#sessionsList(params));
    this.#register(MINERVA_METHODS.sessionCompact, (params) => this.#sessionCompact(params));
    this.#register(MINERVA_METHODS.configSetModel, (params) => this.#configSetModel(params));
    this.#register(MINERVA_METHODS.skillsList, (params) => this.#skillsList(params));
    // Cancel is a notification, deliberately unwrapped: it carries no state to
    // persist and must keep working during shutdown — close() relies on it.
    this.#connection.handleNotification(AGENT_METHODS.sessionCancel, (params) => {
      const { sessionId } = params as { sessionId?: string };
      if (sessionId) this.#sessions.get(sessionId)?.cancel();
    });
  }

  /**
   * Register a request handler that (1) refuses new work once shutdown has
   * begun and (2) enrolls its promise in #inFlight so close() can drain it.
   * Promise.resolve wraps the synchronous initialize handler.
   */
  #register<T>(method: string, handler: (params: unknown) => T | Promise<T>): void {
    this.#connection.handleRequest(method, (params) => {
      if (this.#closed) {
        throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, "kernel is shutting down");
      }
      return this.#track(Promise.resolve(handler(params)));
    });
  }

  #initialize(params: unknown): InitializeResult {
    // Only clients that advertise the minerva batch extension get batched
    // replay; a generic ACP client (Zed) gets standard session/update
    // notifications so it can rebuild the transcript.
    const capabilities = (params as InitializeParams | undefined)?.clientCapabilities;
    this.#clientSupportsBatch = capabilities?.batchReplay === true;
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
    const instructions = await this.#prepareSession(session.id, cwd);
    return {
      sessionId: session.id,
      modes: modeState(session),
      ...(instructions ? { instructions } : {}),
    };
  }

  /**
   * Per-session context beyond the transcript: MCP connections and AGENTS.md
   * instructions, established on session/new and re-established on
   * session/load. Every failure degrades to a stderr warning — a broken
   * config file must not brick sessions.
   */
  async #prepareSession(sessionId: string, cwd: string): Promise<InstructionsInfo | undefined> {
    // Independent I/O — run concurrently so one slow MCP server doesn't
    // delay instruction/skill loading (each degrades to warnings internally).
    const [, instructions, skills] = await Promise.all([
      this.#connectMcp(sessionId, cwd),
      loadProjectInstructions(this.#runtime, this.#dataDir, cwd),
      loadSkills(this.#runtime, this.#dataDir, cwd),
    ]);
    for (const warning of [...instructions.warnings, ...skills.warnings]) {
      process.stderr.write(`minerva: ${warning}\n`);
    }
    this.#instructions.set(sessionId, instructions);
    this.#skills.set(sessionId, skills);
    if (instructions.files.length === 0) return undefined;
    return {
      files: instructions.files.map(({ path, scope, truncated }) => ({ path, scope, truncated })),
    };
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
    const connection = await connectMcpServers(settings.mcpServers, cwd);
    for (const warning of connection.warnings) {
      process.stderr.write(`minerva: ${warning}\n`);
    }
    this.#mcp.set(sessionId, connection);
  }

  #toolsFor(sessionId: string): KernelTool[] {
    const mcpTools = this.#mcp.get(sessionId)?.tools ?? [];
    const skills = this.#skills.get(sessionId);
    // The skill tool only exists when the session has skills: an empty
    // listing would just burn prompt tokens and invite bogus calls. A host
    // that injected its own "skill" tool wins — providers reject duplicate
    // definitions, and the execute map would silently shadow the host's.
    const hostHasSkillTool = this.#tools.some((tool) => tool.name === "skill");
    const skillTools =
      !hostHasSkillTool && skills && skills.skills.length > 0 ? [createSkillTool(skills)] : [];
    if (mcpTools.length === 0 && skillTools.length === 0) return this.#tools;
    return [...this.#tools, ...skillTools, ...mcpTools];
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
    // rebuilding from the file. A flush failure means the on-disk log is
    // missing recent events, so rebuilding from it would silently lose data —
    // fail the reload loudly instead of reporting success on a stale state.
    if (existing) {
      try {
        await existing.flush();
      } catch (error) {
        throw new RpcError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          `cannot reload session: pending writes failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

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
    const instructions = await this.#prepareSession(sessionId, cwd);
    // Replay the conversation so the frontend can rebuild its transcript. A
    // client that advertised batch support gets it in one message (one
    // apply+render instead of the O(n²) per-update path); a generic ACP client
    // gets standard session/update notifications.
    if (loaded.replay.updates.length > 0) {
      if (this.#clientSupportsBatch) {
        for (const updates of chunkReplayUpdates(loaded.replay.updates)) {
          this.#connection.notify(CLIENT_METHODS.sessionUpdateBatch, { sessionId, updates });
        }
      } else {
        for (const update of loaded.replay.updates) {
          this.#connection.notify(CLIENT_METHODS.sessionUpdate, { sessionId, update });
        }
      }
    }
    // Session-lifetime spend lives only in the log; without this a resumed
    // frontend would show totals starting from zero.
    if (hasUsage(loaded.session.usage)) {
      const params: SessionUsageParams = {
        sessionId,
        cumulative: toTokenUsage(loaded.session.usage),
      };
      this.#connection.notify(CLIENT_METHODS.sessionUsage, params);
    }
    return { modes: modeState(loaded.session), ...(instructions ? { instructions } : {}) };
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

  async #skillsList(params: unknown): Promise<SkillsListResult> {
    const { cwd } = (params ?? {}) as { cwd?: string };
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "skills/list requires cwd");
    }
    // Fresh from disk rather than a per-session cache: needs no session, is
    // two readdirs, and lets a frontend refresh after the user adds a skill.
    const registry = await loadSkills(this.#runtime, this.#dataDir, cwd);
    return {
      skills: registry.skills.map(({ name, description, source }) => ({
        name,
        description,
        source,
      })),
    };
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
    } catch (error) {
      // No index yet means no sessions; any other read failure is real and
      // must not masquerade as an empty list.
      if (isNotFoundError(error)) return { sessions: [] };
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        `cannot read session index: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    for (const entry of entries) {
      // delete-before-set so a resumed session moves to the most-recent
      // position rather than keeping its original insertion order.
      bySessionId.delete(entry.sessionId);
      bySessionId.set(entry.sessionId, entry);
    }
    const recent = [...bySessionId.values()].reverse().slice(0, 20);
    const sessions = await Promise.all(
      recent.map(async (entry) => ({
        ...entry,
        // Previews are persisted in the index; only fall back to reading the
        // log for old entries written before previews existed.
        preview: entry.preview ?? (await this.#sessionPreview(dir, entry.sessionId)),
      })),
    );
    return { sessions };
  }

  async #sessionPreview(dir: string, sessionId: string): Promise<string | undefined> {
    try {
      const raw = await this.#runtime.readTextFile(join(dir, `${sessionId}.jsonl`));
      for (const event of parseEventLog(raw)) {
        if (event.type === "user.message") return previewText(event.text);
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
    // Claim the prompt lease synchronously: an await between the promptActive
    // guard above and this claim would let two same-tick requests both pass
    // the guard and interleave their events. runPrompt releases the lease.
    const signal = session.beginPrompt();

    // Persist the first prompt as the session's index preview (once), so the
    // picker doesn't have to read the log to show it.
    void session.recordPreview(text).catch(() => {});

    // ALL fallible pre-work must sit inside this block: the host-supplied
    // systemPrompt callback, skill expansion, and tool assembly can each
    // throw, and a leaked lease locks the session forever. Never release
    // AFTER runPrompt is called — it owns the lease from that point (its
    // finally releases), and a late endPrompt here could free a successor
    // prompt's freshly claimed lease.
    let context: LoopContext;
    let providerText: string | undefined;
    try {
      // AGENTS.md instructions append to the host's base prompt rather than
      // replacing it; loaded at session establish, so edits need a
      // new/reloaded session to take effect.
      const instructions = this.#instructions.get(session.id)?.text;
      const base = this.#systemPrompt(session.cwd);
      providerText = await this.#expandSkillInvocation(session, text);
      context = {
        session,
        connection: this.#connection,
        provider: this.#provider,
        tools: this.#toolsFor(session.id),
        system: instructions ? `${base}\n\n${instructions}` : base,
        runtime: this.#runtime,
        signal,
      };
    } catch (error) {
      // Nothing was logged yet; the failed prompt leaves no trace.
      session.endPrompt();
      throw error;
    }
    // runPrompt is async — it cannot throw synchronously, so the handoff is
    // unconditional once we reach this line.
    return runPrompt(context, text, providerText);
  }

  /**
   * A `/name args` prompt naming a session skill expands kernel-side: the
   * transcript keeps the literal line while the provider receives the skill
   * body — so skills work identically from the CLI and ACP hosts. Slash text
   * matching no skill passes through to the model unchanged (today's
   * behavior for stray slashes).
   */
  async #expandSkillInvocation(session: Session, text: string): Promise<string | undefined> {
    const match = text.match(/^\/([a-z0-9][a-z0-9_-]*)\s*([\s\S]*)$/i);
    if (!match) return undefined;
    const [, name = "", args = ""] = match;
    // Always resolve against a fresh read: skills/list reads fresh from disk,
    // so anything less here lets a stale session cache diverge from what the
    // frontend offered (a later-added project override would expand the
    // cached global body; a deleted one would error instead of falling back).
    // Bounded cost — only slash-shaped prompts get here, and discovery reads
    // 8 KiB frontmatter prefixes at most.
    const registry = await loadSkills(this.#runtime, this.#dataDir, session.cwd);
    for (const warning of registry.warnings) {
      process.stderr.write(`minerva: ${warning}\n`);
    }
    this.#skills.set(session.id, registry);
    const skill = registry.skills.find((entry) => entry.name === name);
    if (!skill) return undefined;
    // Deny rules block even explicit user invocations; "ask" is skipped —
    // typing the command is consent, and the expansion is audited via the
    // user.message providerText field.
    const verdict = session.permissions.evaluate(createSkillTool(registry), { name }, session.mode);
    if (verdict.action === "deny") {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        `skill "${name}" is blocked by a deny permission rule`,
      );
    }
    let body: string;
    try {
      body = await readSkillBody(this.#runtime, skill);
    } catch (error) {
      // Unlike discovery, the user explicitly asked for this skill — a
      // vanished/unreadable file should fail the prompt loudly.
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        `skill "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const invocation = args.trim() ? `with: ${args.trim()}` : "with no arguments";
    return `${body}\n\n---\nThe user invoked the "${name}" skill ${invocation}`;
  }

  /**
   * Enroll an in-flight operation so shutdown can drain it. #inFlight.add runs
   * synchronously before the first await, so close()'s synchronous
   * (#closed=true → snapshot) section can't miss an operation that passed the
   * guard.
   */
  async #track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise);
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(promise);
    }
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
    // No await may sit between the guard above and runCompact's synchronous
    // beginPrompt(), or a same-tick prompt could claim the lease in between.
    const { summary, usage } = await runCompact(session, this.#provider);
    // Reflect the summarization spend immediately, like a completed turn does.
    if (usage && hasUsage(usage)) {
      const params: SessionUsageParams = {
        sessionId: session.id,
        lastTurn: toTokenUsage(usage),
        cumulative: toTokenUsage(session.usage),
      };
      this.#connection.notify(CLIENT_METHODS.sessionUsage, params);
    }
    return { summary };
  }

  async #configSetModel(params: unknown): Promise<ConfigSetModelResult> {
    const { modelRef, provider, apiKey } = (params ?? {}) as Partial<ConfigSetModelParams>;
    if (typeof modelRef !== "string" || modelRef.length === 0) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "config/set_model requires modelRef");
    }
    const resolve = this.#resolveProvider;
    if (!resolve) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "model configuration is not supported by this host",
      );
    }

    // Persist before resolving: the host's resolver re-reads settings, so a
    // key entered alongside the switch must already be on disk.
    const slash = modelRef.indexOf("/");
    const providerName = provider?.name ?? (slash === -1 ? "anthropic" : modelRef.slice(0, slash));
    let previousModel: string | undefined;
    try {
      await updateGlobalSettings(this.#runtime, this.#dataDir, (current) => {
        previousModel = current.model;
        const entry: ProviderSettings = {
          ...current.providers?.[providerName],
          ...(provider?.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
          ...(provider?.apiKeyEnv !== undefined ? { apiKeyEnv: provider.apiKeyEnv } : {}),
          ...(provider?.defaultModel !== undefined ? { defaultModel: provider.defaultModel } : {}),
          ...(provider?.requiresApiKey !== undefined
            ? { requiresApiKey: provider.requiresApiKey }
            : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
        };
        const touched = provider !== undefined || apiKey !== undefined;
        const next = {
          ...current,
          model: modelRef,
          ...(touched ? { providers: { ...current.providers, [providerName]: entry } } : {}),
        };
        // Validate the candidate registry in memory before it reaches disk. An
        // invalid provider (bad name, missing baseUrl) would otherwise persist
        // and brick the next startup, which builds the registry unguarded.
        if (touched) buildProviderRegistry(next.providers);
        return next;
      });
    } catch (error) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        error instanceof Error ? error.message : String(error),
      );
    }

    let next: ModelProvider;
    try {
      next = await resolve(modelRef);
    } catch (error) {
      // Roll back the model ref so a rejected switch can't brick the next
      // startup; the provider entry/key stays — it's valid on its own.
      await updateGlobalSettings(this.#runtime, this.#dataDir, (current) => ({
        ...current,
        model: previousModel,
      })).catch((rollbackError) => {
        // Settings now point at the rejected model — surface it, since the
        // next startup will hit it with no other trace of why.
        process.stderr.write(
          `minerva: failed to roll back model after rejected switch: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }\n`,
        );
      });
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        error instanceof Error ? error.message : String(error),
      );
    }

    this.#provider = next;
    const at = now();
    for (const session of this.#sessions.values()) {
      session.append({ type: "session.model_changed", provider: next.id, at });
    }
    return { providerId: next.id };
  }

  /** For tests and diagnostics. */
  getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * Cancel and drain in-flight operations, flush every session's log, and close
   * MCP connections before tearing down the transport. Ordering is
   * load-bearing: set #closed first so no new work slips in; cancel *before*
   * awaiting, or a prompt blocked on a permission round-trip to a gone frontend
   * would deadlock the drain (cancel rejects that pending request). No `await`
   * between #closed=true and the #inFlight snapshot, so a handler that passed
   * the shutdown guard is already enrolled and can't be missed.
   *
   * Draining lets each operation's own flush persist its trailing events
   * (turn.completed, session.model_changed) that a plain exit would drop. Every
   * teardown step runs regardless of the others; afterwards, the steps that
   * actually mean "data may be lost" — a drain timeout or a failed session
   * flush — are raised as an AggregateError so the host can exit nonzero. An
   * ordinary in-flight rejection (a prompt erroring at shutdown already flushed
   * and surfaced its error to its caller) and MCP/connection teardown errors
   * are logged but not fatal.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const session of this.#sessions.values()) session.cancel();
    const drainTimedOut = await this.#drainInFlight();
    const flushes = await Promise.allSettled([...this.#sessions.values()].map((s) => s.flush()));
    const closes = await Promise.allSettled([...this.#mcp.values()].map((c) => c.close()));
    this.#mcp.clear();
    this.#connection.close();

    const durabilityErrors: Error[] = [];
    if (drainTimedOut) {
      durabilityErrors.push(new Error(`shutdown drain timed out after ${this.#shutdownDrainMs}ms`));
    }
    for (const result of flushes) {
      if (result.status === "rejected") durabilityErrors.push(asError(result.reason));
    }
    for (const result of closes) {
      if (result.status === "rejected") {
        process.stderr.write(`minerva: MCP teardown failed: ${String(result.reason)}\n`);
      }
    }
    if (durabilityErrors.length > 0) {
      throw new AggregateError(
        durabilityErrors,
        `kernel shutdown incomplete: ${durabilityErrors.length} step(s) failed`,
      );
    }
  }

  /** Await in-flight operations, bounded by shutdownDrainMs. Returns true if
   * the deadline was hit (some operations may not have flushed). */
  async #drainInFlight(): Promise<boolean> {
    const inFlight = Promise.allSettled([...this.#inFlight]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#shutdownDrainMs);
      timer.unref?.(); // never keep the process alive just for the drain deadline
    });
    try {
      return (await Promise.race([inFlight.then(() => "drained" as const), timeout])) === "timeout";
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createKernel(transport: Transport, options: KernelOptions): MinervaKernel {
  return new MinervaKernel(transport, options);
}

function modeState(session: Session): SessionModeState {
  return { currentModeId: session.mode, availableModes: SESSION_MODES };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function defaultSystemPrompt(cwd: string): string {
  return [
    `You are Minerva, a coding agent. Working directory: ${cwd}.`,
    "Use the available tools to inspect, edit, and run code. Read a file before",
    "editing it; edit_file requires the exact current text. Keep responses concise",
    "and factual, and report command failures honestly instead of glossing over them.",
  ].join(" ");
}
