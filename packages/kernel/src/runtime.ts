/**
 * Runtime-adapter seam (design decision #9: Bun-first, Node-tolerant).
 * The kernel touches the OS only through this interface; the default
 * implementation uses node:* APIs, which run identically under Bun and
 * Node, so a Node build of the kernel stays cheap.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
}

export interface Runtime {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  appendTextFile(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  homedir(): string;
}

export const defaultRuntime: Runtime = {
  readTextFile: (path) => readFile(path, "utf8"),
  writeTextFile: (path, content) => writeFile(path, content, "utf8"),
  appendTextFile: (path, content) => appendFile(path, content, "utf8"),
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  homedir: () => homedir(),

  exec(command, options) {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
      });
    });
  },
};
