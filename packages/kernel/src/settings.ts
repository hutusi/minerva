import { dirname, join } from "node:path";
import type { Runtime } from "./runtime";

/**
 * Settings live in two layers (design record: Config): global
 * `<dataDir>/settings.json` and project `<cwd>/.minerva/settings.json`.
 * Permission lists concatenate (deny always wins at evaluation time);
 * scalar settings prefer the project layer.
 */

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** How to launch an MCP server (stdio transport). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MinervaSettings {
  permissions?: Partial<PermissionRules>;
  defaultMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ResolvedSettings {
  rules: PermissionRules;
  defaultMode?: string;
  mcpServers: Record<string, McpServerConfig>;
}

export function globalSettingsPath(dataDir: string): string {
  return join(dataDir, "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".minerva", "settings.json");
}

export async function loadSettings(
  runtime: Runtime,
  dataDir: string,
  cwd: string,
): Promise<ResolvedSettings> {
  const global = await readSettingsFile(runtime, globalSettingsPath(dataDir));
  const project = await readSettingsFile(runtime, projectSettingsPath(cwd));
  return {
    rules: {
      allow: [...(global.permissions?.allow ?? []), ...(project.permissions?.allow ?? [])],
      deny: [...(global.permissions?.deny ?? []), ...(project.permissions?.deny ?? [])],
      ask: [...(global.permissions?.ask ?? []), ...(project.permissions?.ask ?? [])],
    },
    defaultMode: project.defaultMode ?? global.defaultMode,
    // Per-name override: a project redefining "github" replaces the global one.
    mcpServers: { ...global.mcpServers, ...project.mcpServers },
  };
}

/** Persist an "always allow" decision into the project settings file. */
export async function persistAllowRule(runtime: Runtime, cwd: string, rule: string): Promise<void> {
  const path = projectSettingsPath(cwd);
  const settings = await readSettingsFile(runtime, path);
  const allow = settings.permissions?.allow ?? [];
  if (allow.includes(rule)) return;
  const next: MinervaSettings = {
    ...settings,
    permissions: { ...settings.permissions, allow: [...allow, rule] },
  };
  await runtime.mkdirp(dirname(path));
  await runtime.writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

async function readSettingsFile(runtime: Runtime, path: string): Promise<MinervaSettings> {
  let raw: string;
  try {
    raw = await runtime.readTextFile(path);
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as MinervaSettings;
  } catch (error) {
    // A corrupt settings file must not silently grant or drop permissions.
    throw new Error(
      `invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
