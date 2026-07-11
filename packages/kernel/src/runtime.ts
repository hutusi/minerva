/**
 * Runtime-adapter seam (design decision #9: Bun-first, Node-tolerant).
 * The kernel touches the OS only through this interface; the default
 * implementation uses node:* APIs, which run identically under Bun and
 * Node, so a Node build of the kernel stays cheap.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface WriteTextFileOptions {
  /** Unix permission bits to enforce on the file (e.g. 0o600 for secrets). */
  mode?: number | undefined;
}

export interface Runtime {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string, options?: WriteTextFileOptions): Promise<void>;
  /**
   * Create and write a brand-new file, failing if it already exists and
   * never following a symlink at the final component (for atomic temp
   * writes). Guards against a planted temp-name symlink redirecting the write.
   */
  writeNewFile(path: string, content: string, options?: WriteTextFileOptions): Promise<void>;
  appendTextFile(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  /** Resolve symlinks to the canonical path. Rejects (ENOENT) if absent. */
  realpath(path: string): Promise<string>;
  /** Read a symlink's target. Rejects EINVAL if the path is not a symlink. */
  readlink(path: string): Promise<string>;
  /** Atomically replace `to` with `from` (same filesystem). */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file. Used to clean up a temp file after a failed atomic write. */
  unlink(path: string): Promise<void>;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  homedir(): string;
}

/**
 * A missing file (ENOENT) is a normal "not configured yet" state; any other
 * read failure (EACCES, EIO, EISDIR) is a real error that must not be
 * mistaken for absence — a swallowed EACCES silently drops policy.
 */
export function isNotFoundError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

/**
 * Cap per-stream accumulation well above the tool-level truncation limit;
 * without it a runaway command buffers unbounded output in kernel memory
 * for the whole timeout window.
 */
const MAX_STREAM_CHARS = 200_000;

/** After the child exits, wait this long for pipes held open by orphaned
 * grandchildren (e.g. `daemon &`) before settling with what we have. */
const PIPE_GRACE_MS = 1_000;

export const defaultRuntime: Runtime = {
  readTextFile: (path) => readFile(path, "utf8"),
  writeTextFile: async (path, content, options) => {
    const mode = options?.mode;
    await writeFile(path, content, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) });
    // writeFile's mode only applies when it creates the file; chmod covers
    // pre-existing files that must be tightened (e.g. stored API keys).
    if (mode !== undefined) await chmod(path, mode);
  },
  writeNewFile: async (path, content, options) => {
    const mode = options?.mode;
    // O_EXCL fails if the name exists (incl. a symlink); O_NOFOLLOW refuses a
    // symlink final component. Together they stop a planted temp symlink from
    // redirecting the write outside the intended directory.
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags, mode ?? 0o666);
    try {
      await handle.writeFile(content, "utf8");
      // open()'s mode is masked by umask; chmod pins the exact bits (0600).
      if (mode !== undefined) await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  },
  appendTextFile: (path, content) => appendFile(path, content, "utf8"),
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  realpath: (path) => realpath(path),
  readlink: (path) => readlink(path),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  homedir: () => homedir(),

  exec(command, options) {
    return new Promise((resolve, reject) => {
      // detached puts the child in its own process group so kills reach
      // grandchildren, not just the bash wrapper.
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let exitCode: number | null = null;
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const killTree = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, options.timeoutMs);

      const onAbort = () => {
        aborted = true;
        killTree();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: exitCode ?? -1, timedOut, aborted });
      };

      // setEncoding decodes via StringDecoder, so multi-byte UTF-8 characters
      // split across chunk boundaries survive intact.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < MAX_STREAM_CHARS) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STREAM_CHARS) stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      // 'close' waits for the pipes to drain — which never happens when the
      // command backgrounds a process that inherits them. Settle on 'close'
      // normally, but treat 'exit' + grace period as good enough.
      child.on("exit", (code) => {
        exitCode = code ?? -1;
        graceTimer = setTimeout(settle, PIPE_GRACE_MS);
      });
      child.on("close", (code) => {
        exitCode = exitCode ?? code ?? -1;
        settle();
      });
    });
  },
};
