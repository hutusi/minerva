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
  | { action: "allow"; rule?: string | undefined }
  | { action: "deny"; rule?: string | undefined; reason: string }
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

    // Ask rules outrank the read-only fast path so a project can force
    // confirmation even for reads.
    const asked = matchRules(this.#rules.ask, tool.name, value);
    if (asked) return { action: "ask" };

    if (tool.readOnly) return { action: "allow" };

    // Plan mode outranks allow rules: "mutating tools are blocked" must hold
    // even for calls a previous allow_always would have covered.
    if (mode === "plan") {
      return {
        action: "deny",
        reason:
          "Minerva is in plan mode: mutating tools are blocked. Present a plan instead of making changes.",
      };
    }

    const allowed = matchRules(this.#rules.allow, tool.name, value);
    if (allowed) return { action: "allow", rule: allowed };

    switch (mode) {
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

/**
 * Escape wildcard characters in a literal value before embedding it in a
 * rule. Without this, approving `git add *` once would persist a rule that
 * matches `git add --force anything` — a silent over-grant.
 */
export function escapeRuleValue(value: string): string {
  return value.replace(/[\\*?]/g, (char) => `\\${char}`);
}

function matchRules(rules: string[], toolName: string, value: string): string | undefined {
  return rules.find((rule) => ruleMatches(rule, toolName, value));
}

/**
 * Rule forms: `bash` (bare tool name, matches every call) or
 * `bash(git *)` — a wildcard pattern over the tool's permission value,
 * where `*` matches any run of characters, `?` a single one, and a
 * backslash escapes the next character (`\*` is a literal asterisk).
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
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "\\" && i + 1 < pattern.length) {
      source += escapeRegexChar(pattern[++i] as string);
    } else if (char === "*") {
      source += "[\\s\\S]*";
    } else if (char === "?") {
      source += "[\\s\\S]";
    } else {
      source += escapeRegexChar(char);
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
