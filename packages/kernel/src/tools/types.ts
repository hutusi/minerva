import { isAbsolute, relative, resolve } from "node:path";
import type { PlanEntry, ToolKind } from "@minerva/protocol";
import type { Runtime } from "../runtime";

export interface ToolContext {
  cwd: string;
  runtime: Runtime;
  /** Aborts when the prompt is cancelled; long-running tools should honor it. */
  signal?: AbortSignal;
  /** Provided by the agent loop: persist + broadcast the session todo list. */
  updateTodos?(entries: PlanEntry[]): void;
}

export interface ToolOutput {
  output: string;
  isError?: boolean;
}

export interface KernelTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input, forwarded to the model provider. */
  inputSchema: Record<string, unknown>;
  /** ACP tool kind, used by frontends to pick rendering. */
  kind: ToolKind;
  /** Read-only tools are auto-allowed by policy; others need permission. */
  readOnly: boolean;
  /** Short human-readable label for a specific call, shown in UIs. */
  title(input: unknown): string;
  execute(input: unknown, context: ToolContext): Promise<ToolOutput>;
}

/** Tool inputs arrive as unknown; narrow to a record or fail the call. */
export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tool input must be an object");
  }
  return input as Record<string, unknown>;
}

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required string parameter: ${key}`);
  }
  return value;
}

/**
 * Resolve a model-supplied path and confine it to the workspace. Tool inputs
 * are untrusted model output: without this check a policy-allowed read-only
 * tool could read arbitrary files (~/.ssh/id_rsa) with no permission prompt.
 * Symlink escapes remain possible in slice 1; the rule engine tightens this.
 */
export function resolveWithinWorkspace(cwd: string, inputPath: string): string {
  const resolved = resolve(cwd, inputPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside the workspace: ${resolved}`);
  }
  return resolved;
}

/**
 * Glob patterns are matched by the glob engine, not resolved as paths, so
 * resolveWithinWorkspace can't see an escape like `../**` or `/etc/*` —
 * reject those shapes outright.
 */
export function ensureConfinedPattern(pattern: string): string {
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new Error(`glob pattern must stay inside the workspace: ${pattern}`);
  }
  return pattern;
}
