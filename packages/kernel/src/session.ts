import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProviderMessage } from "@minerva/providers";
import { now, type SessionEvent } from "./events";
import type { Runtime } from "./runtime";

/**
 * One conversation. The JSONL event log is the durable record; the
 * in-memory provider messages are a projection of it, maintained
 * incrementally (full replay/resume lands in slice 2).
 */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly messages: ProviderMessage[] = [];
  promptActive = false;

  #logPath: string;
  #runtime: Runtime;
  #logChain: Promise<void> = Promise.resolve();
  #abort: AbortController | null = null;

  private constructor(id: string, cwd: string, logPath: string, runtime: Runtime) {
    this.id = id;
    this.cwd = cwd;
    this.#logPath = logPath;
    this.#runtime = runtime;
  }

  static async create(options: {
    cwd: string;
    dataDir: string;
    providerId: string;
    runtime: Runtime;
  }): Promise<Session> {
    const id = `ses_${randomUUID()}`;
    const projectDir = join(options.dataDir, "projects", projectSlug(options.cwd));
    await options.runtime.mkdirp(projectDir);
    const session = new Session(id, options.cwd, join(projectDir, `${id}.jsonl`), options.runtime);
    session.append({
      type: "session.created",
      sessionId: id,
      cwd: options.cwd,
      provider: options.providerId,
      at: now(),
    });
    return session;
  }

  /**
   * Append to the JSONL log. Writes are chained so events land in order
   * even though callers don't await them; `flush()` awaits the chain.
   */
  append(event: SessionEvent): void {
    this.#logChain = this.#logChain.then(() =>
      this.#runtime.appendTextFile(this.#logPath, `${JSON.stringify(event)}\n`),
    );
  }

  flush(): Promise<void> {
    return this.#logChain;
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

/** Filesystem-safe project identifier derived from the working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}
