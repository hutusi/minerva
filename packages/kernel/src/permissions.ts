import type { SessionMode } from "@minerva/protocol";
import type { PermissionRules } from "./settings";
import type { KernelTool } from "./tools";

/**
 * Kernel-enforced permission engine (design decision #5): allow/deny/ask
 * rules like `bash(git *)` plus session modes. Policy lives here — behind
 * the protocol — so no frontend can bypass it.
 */

export type SessionModeId = "plan" | "default" | "acceptEdits" | "auto";

export const DEFAULT_MODE: SessionModeId = "default";

export const SESSION_MODES: SessionMode[] = [
  { id: "plan", name: "Plan", description: "Read and analyze only; mutating tools are blocked" },
  { id: "default", name: "Default", description: "Ask before side-effecting tool calls" },
  {
    id: "acceptEdits",
    name: "Accept Edits",
    description: "File edits run without asking; commands still ask",
  },
  { id: "auto", name: "Auto", description: "Everything runs without asking, except deny rules" },
];

export function isSessionModeId(value: unknown): value is SessionModeId {
  return SESSION_MODES.some((mode) => mode.id === value);
}

export type PermissionVerdict =
  | { action: "allow"; rule?: string }
  | { action: "deny"; rule?: string; reason: string }
  | { action: "ask" };

export class PermissionEngine {
  #rules: PermissionRules;

  constructor(rules: PermissionRules) {
    this.#rules = rules;
  }

  /** Session-local addition; the caller persists it to settings separately. */
  addAllowRule(rule: string): void {
    this.#rules.allow.push(rule);
  }

  evaluate(tool: KernelTool, input: unknown, mode: SessionModeId): PermissionVerdict {
    const value = permissionValue(input);

    // Deny is absolute: it outranks read-only policy, allow rules, and modes,
    // so an org/project deny list can't be talked around.
    const denied = matchRules(this.#rules.deny, tool.name, value);
    if (denied) return { action: "deny", rule: denied, reason: `denied by rule ${denied}` };

    if (tool.readOnly) return { action: "allow" };

    const asked = matchRules(this.#rules.ask, tool.name, value);
    if (asked) return { action: "ask" };

    const allowed = matchRules(this.#rules.allow, tool.name, value);
    if (allowed) return { action: "allow", rule: allowed };

    switch (mode) {
      case "plan":
        return {
          action: "deny",
          reason:
            "Minerva is in plan mode: mutating tools are blocked. Present a plan instead of making changes.",
        };
      case "auto":
        return { action: "allow" };
      case "acceptEdits":
        return tool.kind === "edit" ? { action: "allow" } : { action: "ask" };
      default:
        return { action: "ask" };
    }
  }
}

/**
 * The string a rule pattern matches against — and the rule persisted by an
 * "always allow" answer. Command text for bash, the path for file tools.
 */
export function permissionValue(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.path === "string") return record.path;
  }
  return JSON.stringify(input ?? null);
}

export function formatRule(toolName: string, value: string): string {
  return `${toolName}(${value})`;
}

function matchRules(rules: string[], toolName: string, value: string): string | undefined {
  return rules.find((rule) => ruleMatches(rule, toolName, value));
}

/**
 * Rule forms: `bash` (bare tool name, matches every call) or
 * `bash(git *)` — a wildcard pattern over the tool's permission value,
 * where `*` matches any run of characters and `?` a single one.
 */
export function ruleMatches(rule: string, toolName: string, value: string): boolean {
  const open = rule.indexOf("(");
  if (open === -1) return rule.trim() === toolName;
  if (!rule.endsWith(")")) return false;
  if (rule.slice(0, open).trim() !== toolName) return false;
  const pattern = rule.slice(open + 1, -1);
  return wildcardToRegex(pattern).test(value);
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]")}$`);
}
