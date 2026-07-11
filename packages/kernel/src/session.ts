import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PlanEntry } from "@minerva/protocol";
import type { ProviderMessage, TurnUsage } from "@minerva/providers";
import { now, type SessionEvent } from "./events";
import { withFileLock } from "./file-lock";
import { DEFAULT_MODE, isSessionModeId, PermissionEngine, type SessionModeId } from "./permissions";
import { type ReplayResult, replayEvents } from "./replay";
import type { Runtime } from "./runtime";
import { loadSettings } from "./settings";
import type { KernelTool } from "./tools";
import { addUsage } from "./usage";

/**
 * Above this many lines, the append-per-use session index is compacted (one
 * line per session id) on the next write. Kept high so compaction is rare —
 * blind append stays the fast, concurrency-safe common path.
 */
const INDEX_COMPACT_THRESHOLD = 500;

export interface SessionOptions {
  cwd: string;
  dataDir: string;
  providerId: string;
  runtime: Runtime;
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
  /** Token spend across every completed turn, incl. pre-resume history. */
  usage: TurnUsage = {};
  promptActive = false;

  #logPath: string;
  #runtime: Runtime;
  #logChain: Promise<void> = Promise.resolve();
  #logError: unknown = null;
  #abort: AbortController | null = null;

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
    this.#logPath = join(projectDir(options.dataDir, options.cwd), `${id}.jsonl`);
    this.#runtime = options.runtime;
  }

  static async create(options: SessionOptions): Promise<Session> {
    const id = `ses_${randomUUID()}`;
    const dir = projectDir(options.dataDir, options.cwd);
    await options.runtime.mkdirp(dir);
    const settings = await loadSettings(options.runtime, options.dataDir, options.cwd);
    const mode = isSessionModeId(settings.defaultMode) ? settings.defaultMode : DEFAULT_MODE;
    const session = new Session(id, options, new PermissionEngine(settings.rules), mode);

    const createdAt = now();
    await appendSessionIndex(options.runtime, dir, { sessionId: id, cwd: options.cwd, createdAt });
    session.append({
      type: "session.created",
      sessionId: id,
      cwd: options.cwd,
      provider: options.providerId,
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
    const dir = projectDir(options.dataDir, options.cwd);
    const logPath = join(dir, `${sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await options.runtime.readTextFile(logPath);
    } catch {
      throw new Error(`no persisted session ${sessionId} for ${options.cwd}`);
    }
    const events = parseEventLog(raw);
    // Project slugs collapse punctuation (/a/b.c and /a/b-c share a dir), so
    // the log's recorded cwd — not the file location — is authoritative.
    const created = events.find((event) => event.type === "session.created");
    if (created && created.cwd !== options.cwd) {
      throw new Error(`session ${sessionId} belongs to ${created.cwd}, not ${options.cwd}`);
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
    // Re-append to the index so "latest session" means most recently used,
    // not most recently created; the list handler dedupes by id.
    await appendSessionIndex(options.runtime, dir, {
      sessionId,
      cwd: options.cwd,
      createdAt: now(),
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
      .then(() => this.#runtime.appendTextFile(this.#logPath, `${JSON.stringify(event)}\n`))
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

/** Filesystem-safe project identifier derived from the working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}

interface IndexEntry {
  sessionId: string;
  cwd: string;
  createdAt: string;
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
    await runtime.appendTextFile(path, `${JSON.stringify(entry)}\n`);
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
      await runtime.writeNewFile(tmp, `${[...bySession.values()].join("\n")}\n`);
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
