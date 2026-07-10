import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PlanEntry } from "@minerva/protocol";
import type { ProviderMessage } from "@minerva/providers";
import { now, type SessionEvent } from "./events";
import { DEFAULT_MODE, isSessionModeId, PermissionEngine, type SessionModeId } from "./permissions";
import { replayEvents } from "./replay";
import type { Runtime } from "./runtime";
import { loadSettings } from "./settings";
import type { KernelTool } from "./tools";

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
    await options.runtime.appendTextFile(
      join(dir, "index.jsonl"),
      `${JSON.stringify({ sessionId: id, cwd: options.cwd, createdAt })}\n`,
    );
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
   * context, and hand the caller the events so it can re-render the UI.
   */
  static async load(
    sessionId: string,
    options: SessionOptions,
    tools: KernelTool[],
  ): Promise<{ session: Session; events: SessionEvent[] }> {
    const logPath = join(projectDir(options.dataDir, options.cwd), `${sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await options.runtime.readTextFile(logPath);
    } catch {
      throw new Error(`no persisted session ${sessionId} for ${options.cwd}`);
    }
    const events = parseEventLog(raw);
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
    session.append({ type: "session.resumed", provider: options.providerId, at: now() });
    return { session, events };
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

export function parseEventLog(raw: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // A torn final line (kill -9 mid-write) must not block resume.
    }
  }
  return events;
}
