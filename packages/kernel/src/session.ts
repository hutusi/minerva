import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PlanEntry } from "@minerva/protocol";
import type { ProviderMessage, TurnUsage } from "@minerva/providers";
import { now, type SessionEvent } from "./events";
import { withFileLock } from "./file-lock";
import { DEFAULT_MODE, isSessionModeId, PermissionEngine, type SessionModeId } from "./permissions";
import { type ReplayResult, replayEvents } from "./replay";
import type { Runtime } from "./runtime";
import { loadSettings, resolveProfile } from "./settings";
import type { KernelTool } from "./tools";
import { addUsage } from "./usage";

/**
 * Above this many lines, the append-per-use session index is compacted (one
 * line per session id) on the next write. Kept high so compaction is rare —
 * blind append stays the fast, concurrency-safe common path.
 */
const INDEX_COMPACT_THRESHOLD = 500;

/** Data dir is owner-only (0700); logs/index may hold secrets, so 0600. */
const DATA_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** The shape `Session.create` mints: `ses_` + a v4 UUID. */
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Session ids reach `load` from the frontend and are joined into a filesystem
 * path, so an unvalidated id (`../../../x`) is a path-traversal / arbitrary
 * append primitive. Only the generated shape is allowed.
 */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export interface SessionOptions {
  cwd: string;
  dataDir: string;
  providerId: string;
  runtime: Runtime;
  /** Named profile to create the session with (create only; load re-resolves
   * the name recorded in the log). Unknown names throw. */
  profile?: string | undefined;
}

/**
 * One conversation. The JSONL event log is the durable record; the
 * in-memory provider messages are a projection of it — maintained
 * incrementally while live, rebuilt by replay on resume.
 */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly messages: ProviderMessage[] = [];
  readonly permissions: PermissionEngine;
  mode: SessionModeId;
  todos: PlanEntry[] = [];
  /** Active persona: its systemPrompt REPLACES the base prompt (AGENTS.md
   * instructions still append). Undefined = base persona. */
  profile?: { name: string; systemPrompt?: string | undefined } | undefined;
  /** Token spend across every completed turn, incl. pre-resume history. */
  usage: TurnUsage = {};
  /**
   * Context size of the LAST completed prompt (input + cache read/write
   * tokens), the auto-compaction trigger. Deliberately NOT the running
   * total: the compaction turn's own input is ≈ the over-threshold context,
   * so a naive signal would re-trigger on every prompt after. Set by the
   * agent loop's finish, cleared by runCompact, rebuilt on replay.
   */
  lastTurnContext?: number | undefined;
  promptActive = false;

  #dir: string;
  #logPath: string;
  #runtime: Runtime;
  #logChain: Promise<void> = Promise.resolve();
  #logError: unknown = null;
  #abort: AbortController | null = null;
  #previewRecorded = false;

  private constructor(
    id: string,
    options: SessionOptions,
    permissions: PermissionEngine,
    mode: SessionModeId,
  ) {
    this.id = id;
    this.cwd = options.cwd;
    this.permissions = permissions;
    this.mode = mode;
    this.#dir = projectDir(options.dataDir, options.cwd);
    this.#logPath = join(this.#dir, `${id}.jsonl`);
    this.#runtime = options.runtime;
  }

  /**
   * Persist the first user message into the session index (once) so the picker
   * can show a preview without reading the whole log. The index dedupes by id,
   * so this later entry supersedes the create-time one.
   */
  async recordPreview(text: string): Promise<void> {
    if (this.#previewRecorded) return;
    this.#previewRecorded = true;
    await appendSessionIndex(this.#runtime, this.#dir, {
      sessionId: this.id,
      cwd: this.cwd,
      createdAt: now(),
      preview: previewText(text),
    });
  }

  static async create(options: SessionOptions): Promise<Session> {
    const id = `ses_${randomUUID()}`;
    const dir = projectDir(options.dataDir, options.cwd);
    await options.runtime.mkdirp(dir, { mode: DATA_DIR_MODE });
    const settings = await loadSettings(options.runtime, options.dataDir, options.cwd);
    // Throws on an unknown name — an explicit request AND a settings default
    // both fail loudly rather than silently running the base persona.
    const profile = resolveProfile(settings, options.profile);
    const mode = isSessionModeId(profile?.defaultMode)
      ? profile.defaultMode
      : isSessionModeId(settings.defaultMode)
        ? settings.defaultMode
        : DEFAULT_MODE;
    const session = new Session(id, options, new PermissionEngine(settings.rules), mode);
    if (profile) {
      session.profile = {
        name: profile.name,
        ...(profile.systemPrompt !== undefined ? { systemPrompt: profile.systemPrompt } : {}),
      };
    }

    const createdAt = now();
    await appendSessionIndex(options.runtime, dir, { sessionId: id, cwd: options.cwd, createdAt });
    session.append({
      type: "session.created",
      sessionId: id,
      cwd: options.cwd,
      provider: options.providerId,
      ...(profile ? { profile: profile.name } : {}),
      at: createdAt,
    });
    return session;
  }

  /**
   * Resume a persisted session: replay the event log to rebuild the model
   * context, handing back the replay so the caller can re-render the UI
   * without a second pass over the log.
   */
  static async load(
    sessionId: string,
    options: SessionOptions,
    tools: KernelTool[],
  ): Promise<{ session: Session; replay: ReplayResult }> {
    // Reject a traversal id before it ever reaches join(); the frontend is not
    // trusted to keep the path inside the data dir.
    if (!isValidSessionId(sessionId)) {
      throw new Error(`invalid session id: ${sessionId}`);
    }
    const dir = projectDir(options.dataDir, options.cwd);
    const logPath = join(dir, `${sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await options.runtime.readTextFile(logPath);
    } catch {
      throw new Error(`no persisted session ${sessionId} for ${options.cwd}`);
    }
    const events = parseEventLog(raw);
    // Require a session.created that names this exact session and cwd. Project
    // slugs collapse punctuation (/a/b.c and /a/b-c share a dir), so the log's
    // recorded identity — not the file location — is authoritative, and a log
    // that doesn't claim this session must not be resumed into it.
    const created = events.find((event) => event.type === "session.created");
    if (!created || created.sessionId !== sessionId || created.cwd !== options.cwd) {
      throw new Error(`session ${sessionId} does not belong to ${options.cwd}`);
    }
    const replay = replayEvents(events, tools);

    const settings = await loadSettings(options.runtime, options.dataDir, options.cwd);
    const mode = isSessionModeId(replay.modeId)
      ? replay.modeId
      : isSessionModeId(settings.defaultMode)
        ? settings.defaultMode
        : DEFAULT_MODE;

    const session = new Session(sessionId, options, new PermissionEngine(settings.rules), mode);
    session.messages.push(...replay.messages);
    session.todos = replay.todos;
    session.usage = replay.usage;
    session.lastTurnContext = replay.lastTurnContext;
    // Re-resolve the logged profile NAME against current settings, so prompt
    // edits take effect on resume. A vanished profile degrades to the base
    // persona with a warning — it must never brick resume.
    if (replay.profile !== undefined) {
      try {
        const profile = resolveProfile(settings, replay.profile);
        if (profile) {
          session.profile = {
            name: profile.name,
            ...(profile.systemPrompt !== undefined ? { systemPrompt: profile.systemPrompt } : {}),
          };
        }
      } catch (error) {
        process.stderr.write(
          `minerva: session ${sessionId}: ${error instanceof Error ? error.message : String(error)} — continuing without a profile\n`,
        );
      }
    }
    // Re-append to the index so "latest session" means most recently used, not
    // most recently created (the list handler dedupes by id), carrying the
    // first user message forward as a preview so the picker needn't read the
    // full log.
    const firstUser = events.find((event) => event.type === "user.message");
    session.#previewRecorded = firstUser !== undefined;
    await appendSessionIndex(options.runtime, dir, {
      sessionId,
      cwd: options.cwd,
      createdAt: now(),
      ...(firstUser ? { preview: previewText(firstUser.text) } : {}),
    });
    session.append({ type: "session.resumed", provider: options.providerId, at: now() });
    return { session, replay };
  }

  /**
   * Append to the JSONL log. Writes are chained so events land in order even
   * though callers don't await them. A failed write must not poison the
   * chain (later events still get their own attempt), but it must not be
   * silent either: flush() throws the first failure once, so the prompt that
   * hit it fails loudly while later prompts recover.
   */
  append(event: SessionEvent): void {
    this.#logChain = this.#logChain
      .then(() =>
        this.#runtime.appendTextFile(this.#logPath, `${JSON.stringify(event)}\n`, {
          mode: LOG_FILE_MODE,
        }),
      )
      .catch((error) => {
        this.#logError ??= error;
      });
  }

  addTurnUsage(turn: TurnUsage): void {
    this.usage = addUsage(this.usage, turn);
  }

  async flush(): Promise<void> {
    await this.#logChain;
    if (this.#logError !== null) {
      const error = this.#logError;
      this.#logError = null;
      throw error instanceof Error
        ? new Error(`session event log write failed: ${error.message}`)
        : new Error(`session event log write failed: ${String(error)}`);
    }
  }

  get logPath(): string {
    return this.#logPath;
  }

  beginPrompt(): AbortSignal {
    // Hard backstop: callers guard promptActive with a friendly RpcError
    // first, and must claim the lease with NO await between guard and claim.
    // Reaching this while active means that invariant broke — overwriting the
    // live AbortController would detach cancel() from the running prompt.
    if (this.promptActive) {
      throw new Error("a prompt is already running in this session");
    }
    this.promptActive = true;
    this.#abort = new AbortController();
    return this.#abort.signal;
  }

  endPrompt(): void {
    this.promptActive = false;
    this.#abort = null;
  }

  cancel(): void {
    this.#abort?.abort();
  }

  get cancelled(): boolean {
    return this.#abort?.signal.aborted ?? false;
  }
}

export function projectDir(dataDir: string, cwd: string): string {
  return join(dataDir, "projects", projectSlug(cwd));
}

/**
 * Tighten an existing data dir to owner-only: new files/dirs are already
 * created 0700/0600, but installs that predate that leave session logs
 * world-readable. Best-effort and idempotent — a missing dir or a chmod
 * failure is skipped, never fatal to startup.
 */
export async function migrateDataDirPermissions(runtime: Runtime, dataDir: string): Promise<void> {
  const chmodQuiet = (path: string, mode: number) => runtime.chmod(path, mode).catch(() => {});
  const listQuiet = (path: string) =>
    runtime.readdir(path).then(
      (e) => e,
      () => [] as string[],
    );

  await chmodQuiet(dataDir, DATA_DIR_MODE);
  await chmodQuiet(join(dataDir, "settings.json"), LOG_FILE_MODE);
  const projectsRoot = join(dataDir, "projects");
  await chmodQuiet(projectsRoot, DATA_DIR_MODE);
  for (const project of await listQuiet(projectsRoot)) {
    const dir = join(projectsRoot, project);
    await chmodQuiet(dir, DATA_DIR_MODE);
    for (const file of await listQuiet(dir)) {
      if (file.endsWith(".jsonl")) await chmodQuiet(join(dir, file), LOG_FILE_MODE);
    }
  }
}

/** Filesystem-safe project identifier derived from the working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}

interface IndexEntry {
  sessionId: string;
  cwd: string;
  createdAt: string;
  /** First user message, truncated — lets the picker skip reading the log. */
  preview?: string;
}

/** Truncate a first-user-message to a picker-sized preview (code-point safe). */
export function previewText(text: string): string {
  const chars = [...text];
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : text;
}

/**
 * Append a session-index entry, opportunistically compacting the file when it
 * grows past the threshold. Both the append and the (rare) compaction run
 * under a per-path lock, so blind append stays atomic and a concurrent writer
 * can't land between the compaction's read and its atomic rename.
 */
async function appendSessionIndex(runtime: Runtime, dir: string, entry: IndexEntry): Promise<void> {
  const path = join(dir, "index.jsonl");
  await withFileLock(path, async () => {
    await runtime.appendTextFile(path, `${JSON.stringify(entry)}\n`, { mode: LOG_FILE_MODE });
    let raw: string;
    try {
      raw = await runtime.readTextFile(path);
    } catch {
      return; // the append succeeded; a failed re-read just skips compaction
    }
    const lines = raw.split("\n").filter((line) => line.trim());
    if (lines.length <= INDEX_COMPACT_THRESHOLD) return;
    // Keep the latest line per session id, in last-occurrence order — the same
    // dedupe the list handler applies at read time.
    const bySession = new Map<string, string>();
    for (const line of lines) {
      let id: string;
      try {
        id = (JSON.parse(line) as IndexEntry).sessionId;
      } catch {
        continue; // drop a torn line during compaction
      }
      bySession.delete(id);
      bySession.set(id, line);
    }
    // Random temp + exclusive/no-follow create + atomic rename, matching the
    // settings writer. The index lives in the data dir, not the repo, so it
    // isn't attacker-reachable — this is defense-in-depth and consistency.
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await runtime.writeNewFile(tmp, `${[...bySession.values()].join("\n")}\n`, {
        mode: LOG_FILE_MODE,
      });
      await runtime.rename(tmp, path);
    } catch (error) {
      await runtime.unlink(tmp).catch(() => {});
      throw error;
    }
  });
}

export function parseEventLog(raw: string): SessionEvent[] {
  const lines = raw.split("\n");
  // A torn final record (kill -9 mid-write) is expected and must not block
  // resume; corruption anywhere earlier means real damage, so fail loudly
  // rather than silently dropping events from the middle of the history.
  // Only an *unterminated* tail is a torn write: a trailing newline means the
  // final line was fully flushed, so a malformed complete line is corruption.
  const lastNonEmpty =
    !raw.endsWith("\n") && raw.trimEnd().length !== 0 ? findLastNonEmptyIndex(lines) : -1;
  const events: SessionEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch (error) {
      if (i === lastNonEmpty) break; // tolerate only the torn final line
      throw new Error(
        `corrupt session event log at line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}

function findLastNonEmptyIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] as string).trim()) return i;
  }
  return -1;
}
