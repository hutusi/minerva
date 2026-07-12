import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PlanEntry, ToolCallContent, ToolKind } from "@minerva/protocol";
import { type BoundedRead, isNotFoundError, type Runtime } from "../runtime";

export interface ToolContext {
  cwd: string;
  runtime: Runtime;
  /** Config/session root, for tools that consult settings (web_fetch). The
   * agent loop always provides it; only direct-call tests may omit it, and
   * settings-dependent behavior must fail CLOSED without it. */
  dataDir?: string | undefined;
  /** Aborts when the prompt is cancelled; long-running tools should honor it. */
  signal?: AbortSignal | undefined;
  /** Provided by the agent loop: persist + broadcast the session todo list. */
  updateTodos?: ((entries: PlanEntry[]) => void) | undefined;
  /** Provided by the agent loop for the task tool — absent in child loops
   * (no recursive spawning) and outside a kernel prompt. */
  runSubagent?:
    | ((input: { description: string; prompt: string }) => Promise<ToolOutput>)
    | undefined;
}

export interface ToolOutput {
  output: string;
  isError?: boolean;
  /**
   * Structured blocks beyond the text output — e.g. a diff for file edits.
   * Rides tool_call_update to the frontend and is persisted for replay.
   */
  content?: ToolCallContent[];
}

/**
 * Full-file diff content for a file-mutating tool, ACP semantics
 * (`oldText: null` = new file). Either side above the cap ⇒ no diff block
 * (text-only fallback) — full file contents ride the wire and the session
 * log, so unbounded sides would balloon frames and JSONL growth.
 */
const DIFF_SIDE_LIMIT = 48_000;

export function diffContent(
  path: string,
  oldText: string | null,
  newText: string,
): ToolCallContent[] | undefined {
  if ((oldText?.length ?? 0) > DIFF_SIDE_LIMIT || newText.length > DIFF_SIDE_LIMIT) {
    return undefined;
  }
  return [{ type: "diff", path, oldText, newText }];
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

/**
 * Bounded read confined to `root`, closing the check-then-open TOCTOU that a
 * bare resolveWithinWorkspace + read pair has: the pre-check rejects paths
 * that already resolve outside, the read pins an inode via its open fd, and
 * the path is then re-validated as (still) resolving inside the root AND
 * still pointing at that same inode. A symlink swapped in at any point either
 * fails a validation or changes the inode — bytes from a losing race are
 * discarded, never returned. Repos cannot carry hardlinks, so symlinks are
 * the entire escape vector an inode match rules out.
 */
export async function readConfinedTextFilePrefix(
  runtime: Runtime,
  root: string,
  path: string,
  maxBytes: number,
): Promise<BoundedRead> {
  await resolveWithinWorkspace(runtime, root, path);
  const bounded = await runtime.readTextFilePrefix(path, maxBytes);
  await resolveWithinWorkspace(runtime, root, path);
  const current = await runtime.statFile(path);
  if (current.dev !== bounded.dev || current.ino !== bounded.ino) {
    throw new Error(`path is outside the workspace: ${path}`);
  }
  return bounded;
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
