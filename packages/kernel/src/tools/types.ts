import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PlanEntry, ToolKind } from "@minerva/protocol";
import { isNotFoundError, type Runtime } from "../runtime";

export interface ToolContext {
  cwd: string;
  runtime: Runtime;
  /** Aborts when the prompt is cancelled; long-running tools should honor it. */
  signal?: AbortSignal | undefined;
  /** Provided by the agent loop: persist + broadcast the session todo list. */
  updateTodos?: ((entries: PlanEntry[]) => void) | undefined;
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
 *
 * A lexical check alone is bypassable by a symlink inside the workspace that
 * points outside it, so we also resolve symlinks: canonicalize the workspace
 * root and the location the operation would actually touch, then re-check
 * containment. A TOCTOU remains: a symlink swapped between this check and the
 * open is out of scope. Returns the lexical path so tool output is unchanged.
 */
export async function resolveWithinWorkspace(
  runtime: Runtime,
  cwd: string,
  inputPath: string,
): Promise<string> {
  const resolved = resolve(cwd, inputPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside the workspace: ${resolved}`);
  }
  // Canonicalize both sides: the workspace root itself may be a symlink (on
  // macOS /tmp → /private/tmp), so realpath-ing only one side would falsely
  // reject legitimate in-workspace paths.
  const realCwd = await runtime.realpath(cwd);
  const realTarget = await canonicalTarget(runtime, resolved);
  const realRel = relative(realCwd, realTarget);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`path is outside the workspace: ${resolved}`);
  }
  return resolved;
}

// Mirrors the OS SYMLOOP_MAX: a self-evident termination bound so the
// resolution can't loop on an adversarial symlink graph even if the kernel's
// own ELOOP detection somehow doesn't fire first.
const MAX_SYMLINK_DEPTH = 40;

/**
 * The canonical filesystem location an operation on `target` would actually
 * touch, resolving symlinks even when the final component doesn't exist yet
 * (a write target) or is a *dangling* symlink (realpath would just throw). A
 * live path is realpath'd directly; otherwise the parent is canonicalized and
 * the final component is inspected: a symlink is followed (so an escape is
 * caught), anything else is a genuinely new file under a real directory.
 */
async function canonicalTarget(runtime: Runtime, target: string, depth = 0): Promise<string> {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new Error(`path is outside the workspace: ${target}`);
  }
  try {
    return await runtime.realpath(target);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const parent = dirname(target);
  if (parent === target) throw new Error(`path is outside the workspace: ${target}`);
  const realParent = await canonicalTarget(runtime, parent, depth + 1);
  const candidate = join(realParent, basename(target));
  let link: string;
  try {
    link = await runtime.readlink(candidate);
  } catch (error) {
    // ENOENT/EINVAL ⇒ not a symlink: a genuinely new file under a real dir.
    if (isNotFoundError(error) || isInvalidArg(error)) return candidate;
    throw error;
  }
  return canonicalTarget(runtime, resolve(realParent, link), depth + 1);
}

function isInvalidArg(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "EINVAL";
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
