import type { ToolKind } from "@minerva/protocol";
import type { Runtime } from "../runtime";

export interface ToolContext {
  cwd: string;
  runtime: Runtime;
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
