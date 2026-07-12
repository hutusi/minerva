import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ThinkingConfig } from "@minerva/providers";
import { withFileLock } from "./file-lock";
import { isNotFoundError, type Runtime } from "./runtime";

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

/** A local MCP server launched as a child process over stdio. */
export interface McpStdioServerConfig {
  /** Optional discriminant; an entry with `command` and no `type` is stdio. */
  type?: "stdio" | undefined;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A remote MCP server reached over Streamable HTTP (SSE fallback). */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  /**
   * Extra request headers, e.g. `{ "Authorization": "Bearer …" }`. Unlike
   * provider apiKeys these merge from BOTH layers — keep tokened servers in
   * the global settings file, not a shared project one.
   */
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** A model provider entry — built-in override or custom OpenAI-compatible endpoint. */
export interface ProviderSettings {
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  defaultModel?: string | undefined;
  /** false = keyless endpoint (e.g. a local server); startup won't demand a key. */
  requiresApiKey?: boolean | undefined;
  /** Only honored in the GLOBAL layer; project-layer keys are ignored. */
  apiKey?: string | undefined;
  /**
   * Request (true) or suppress (false) model thinking; unset sends nothing.
   * A boolean covers every model; a `{ "qwen-*": true }` map toggles per
   * model. OpenAI-compatible providers only.
   */
  thinking?: ThinkingConfig | undefined;
  /** Context window (tokens) override; feeds auto-compaction. */
  contextWindow?: number | undefined;
}

/**
 * A named persona: replaces the base system prompt (AGENTS.md instructions
 * still append after it) and may prefer a model and a default session mode.
 */
export interface ProfileSettings {
  systemPrompt?: string | undefined;
  /** Model ref the profile prefers, e.g. "bailian/qwen-plus". */
  model?: string | undefined;
  defaultMode?: string | undefined;
}

/** web_fetch tool behavior. */
export interface WebFetchSettings {
  /** Permit fetching hosts that are (or resolve to) private/loopback
   * addresses — for developing against localhost servers. Default false. */
  allowPrivate?: boolean | undefined;
}

export interface MinervaSettings {
  permissions?: Partial<PermissionRules>;
  defaultMode?: string | undefined;
  mcpServers?: Record<string, McpServerConfig>;
  /** Default model ref, e.g. "bailian/qwen-plus". */
  model?: string | undefined;
  providers?: Record<string, ProviderSettings>;
  profiles?: Record<string, ProfileSettings>;
  /** Name of the profile applied to new sessions when none is requested. */
  profile?: string | undefined;
  webFetch?: WebFetchSettings | undefined;
}

export interface ResolvedSettings {
  rules: PermissionRules;
  defaultMode?: string | undefined;
  mcpServers: Record<string, McpServerConfig>;
  model?: string | undefined;
  providers: Record<string, ProviderSettings>;
  profiles: Record<string, ProfileSettings>;
  profile?: string | undefined;
  webFetch: WebFetchSettings;
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
    model: project.model ?? global.model,
    providers: mergeProviders(global.providers, project.providers),
    profiles: mergeByName(global.profiles, project.profiles),
    profile: project.profile ?? global.profile,
    webFetch: {
      allowPrivate: project.webFetch?.allowPrivate ?? global.webFetch?.allowPrivate,
    },
  };
}

/** The active profile for a session: an explicit request wins over the
 * settings default; no name anywhere means no profile. Unknown names throw —
 * a typo must not silently fall back to the base persona. */
export function resolveProfile(
  settings: ResolvedSettings,
  requested?: string | undefined,
): ({ name: string } & ProfileSettings) | undefined {
  const name = requested ?? settings.profile;
  if (name === undefined) return undefined;
  // Own-property check: a bare index would accept inherited names like
  // "toString" as bogus empty profiles instead of failing as unknown.
  const profile = Object.hasOwn(settings.profiles, name) ? settings.profiles[name] : undefined;
  if (!profile) {
    const defined = Object.keys(settings.profiles).join(", ") || "(none)";
    throw new Error(`unknown profile "${name}" — defined: ${defined}`);
  }
  // Canonical name LAST: a stray "name" key in the profile JSON must not
  // overwrite it — the name is persisted to the session log and a wrong one
  // breaks resume.
  return { ...profile, name };
}

/** Per-name shallow merge, project over global. */
function mergeByName<T extends object>(
  global: Record<string, T> | undefined,
  project: Record<string, T> | undefined,
): Record<string, T> {
  const merged: Record<string, T> = { ...global };
  for (const [name, entry] of Object.entries(project ?? {})) {
    const base = merged[name];
    merged[name] = base ? { ...base, ...entry } : entry;
  }
  return merged;
}

/**
 * Per-name shallow merge, project over global — except API keys, which are
 * global-only: a shared project settings file must never carry (or shadow)
 * a secret.
 */
function mergeProviders(
  global: Record<string, ProviderSettings> | undefined,
  project: Record<string, ProviderSettings> | undefined,
): Record<string, ProviderSettings> {
  const merged: Record<string, ProviderSettings> = { ...global };
  for (const [name, { apiKey: _ignored, ...entry }] of Object.entries(project ?? {})) {
    const base = merged[name];
    merged[name] = base ? { ...base, ...entry } : entry;
  }
  return merged;
}

/**
 * Write settings atomically: a plain overwrite can be truncated by a crash
 * mid-write, corrupting the file. Write a sibling temp (same directory, so the
 * rename stays on one filesystem) then rename over the destination.
 *
 * The temp name is randomized and created with writeNewFile (O_EXCL|O_NOFOLLOW):
 * a malicious repo could otherwise pre-plant `.minerva/settings.json.tmp` as a
 * symlink and redirect the write outside the project. rename over the final
 * path replaces a planted symlink there rather than following it. The temp
 * carries the final mode, so the renamed inode is already correct.
 */
async function writeSettingsAtomic(
  runtime: Runtime,
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  await runtime.mkdirp(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await runtime.writeNewFile(tmp, content, mode !== undefined ? { mode } : {});
    await runtime.rename(tmp, path);
  } catch (error) {
    // Don't leave a randomly-named orphan behind on failure.
    await runtime.unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Persist an "always allow" decision into the project settings file. */
export async function persistAllowRule(runtime: Runtime, cwd: string, rule: string): Promise<void> {
  const path = projectSettingsPath(cwd);
  // Serialize with any concurrent approval on the same file: two sessions
  // approving at once must not read the same base and clobber each other.
  await withFileLock(path, async () => {
    const settings = await readSettingsFile(runtime, path);
    const allow = settings.permissions?.allow ?? [];
    if (allow.includes(rule)) return;
    const next: MinervaSettings = {
      ...settings,
      permissions: { ...settings.permissions, allow: [...allow, rule] },
    };
    await writeSettingsAtomic(runtime, path, `${JSON.stringify(next, null, 2)}\n`);
  });
}

/**
 * Read-modify-write the GLOBAL settings file. Always (re)writes it as 0600:
 * this is the file that may hold API keys entered in the config panel.
 */
export async function updateGlobalSettings(
  runtime: Runtime,
  dataDir: string,
  update: (current: MinervaSettings) => MinervaSettings,
): Promise<void> {
  const path = globalSettingsPath(dataDir);
  // Same serialization as persistAllowRule: two config/set_model calls racing
  // this read-modify-write must not lose one update.
  await withFileLock(path, async () => {
    const current = await readSettingsFile(runtime, path);
    const next = update(current);
    await writeSettingsAtomic(runtime, path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  });
}

/** The default config/session root, shared by the kernel and its hosts. */
export function defaultDataDir(runtime: Runtime): string {
  return join(runtime.homedir(), ".minerva");
}

async function readSettingsFile(runtime: Runtime, path: string): Promise<MinervaSettings> {
  let raw: string;
  try {
    raw = await runtime.readTextFile(path);
  } catch (error) {
    // No settings file is the normal case; a read that fails for any other
    // reason (permissions, I/O, a directory in the way) must not be treated
    // as "no rules" — that would silently drop the user's deny list.
    if (isNotFoundError(error)) return {};
    throw new Error(
      `cannot read settings ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // A corrupt settings file must not silently grant or drop permissions.
    throw new Error(
      `invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  validatePermissions(parsed as Record<string, unknown>, path);
  validateProfiles(parsed as Record<string, unknown>, path);
  validateWebFetch(parsed as Record<string, unknown>, path);
  return parsed as MinervaSettings;
}

/** A malformed webFetch entry must fail loudly, not silently lift (or keep)
 * the private-address guard. */
function validateWebFetch(settings: Record<string, unknown>, path: string): void {
  if (!("webFetch" in settings) || settings.webFetch === undefined) return;
  const webFetch = settings.webFetch;
  if (typeof webFetch !== "object" || webFetch === null || Array.isArray(webFetch)) {
    throw new Error(`invalid settings in ${path}: webFetch must be an object`);
  }
  const allowPrivate = (webFetch as Record<string, unknown>).allowPrivate;
  if (allowPrivate !== undefined && typeof allowPrivate !== "boolean") {
    throw new Error(`invalid settings in ${path}: webFetch.allowPrivate must be a boolean`);
  }
}

/**
 * Same rationale as validatePermissions: a malformed `profiles` entry must
 * fail loudly rather than pass a garbage system prompt to the model or crash
 * deep inside session creation.
 */
function validateProfiles(settings: Record<string, unknown>, path: string): void {
  if ("profile" in settings && settings.profile !== undefined) {
    if (typeof settings.profile !== "string") {
      throw new Error(`invalid settings in ${path}: profile must be a string`);
    }
  }
  if (!("profiles" in settings) || settings.profiles === undefined) return;
  const profiles = settings.profiles;
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
    throw new Error(`invalid settings in ${path}: profiles must be an object`);
  }
  for (const [name, entry] of Object.entries(profiles)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid settings in ${path}: profiles.${name} must be an object`);
    }
    for (const key of ["systemPrompt", "model", "defaultMode"] as const) {
      const value = (entry as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`invalid settings in ${path}: profiles.${name}.${key} must be a string`);
      }
    }
  }
}

/**
 * Reject malformed permission fields rather than coerce them. Without this a
 * string `"deny": "bash"` spreads character-by-character into `["b","a",...]`
 * in loadSettings, silently dropping the intended rule — a fail-open.
 */
function validatePermissions(settings: Record<string, unknown>, path: string): void {
  if (!("permissions" in settings)) return;
  const permissions = settings.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    throw new Error(`invalid settings in ${path}: permissions must be an object`);
  }
  for (const key of ["allow", "deny", "ask"] as const) {
    const value = (permissions as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(
        `invalid settings in ${path}: permissions.${key} must be an array of strings`,
      );
    }
  }
}
