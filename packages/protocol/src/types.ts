/**
 * ACP-shaped protocol types (agentclientprotocol.com), plus minerva/*
 * extensions. Names and payload shapes follow the ACP spec so that slice 3's
 * conformance work (connecting Zed over stdio) is a mapping exercise, not a
 * redesign. Only the subset the current slices need is defined; the spec
 * version is pinned via PROTOCOL_VERSION.
 */

export const PROTOCOL_VERSION = 1;

// --- Methods -----------------------------------------------------------

/** Frontend → kernel. */
export const AGENT_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionSetMode: "session/set_mode",
  /** Notification. */
  sessionCancel: "session/cancel",
} as const;

/**
 * minerva/* extension methods — the namespaced surface beyond ACP core
 * (design decision #3). Kept separate so the ACP mapping stays clean.
 */
export const MINERVA_METHODS = {
  /** Frontend → kernel: list persisted sessions for a project. */
  sessionsList: "minerva/sessions/list",
  /** Frontend → kernel: summarize the conversation and reset model context. */
  sessionCompact: "minerva/session/compact",
  /** Frontend → kernel: persist model/provider config and swap the live provider. */
  configSetModel: "minerva/config/set_model",
  /** Frontend → kernel: current model + selectable providers with key status.
   * Exists for hosts on the far side of a pipe (GUI sidecar): the TUI computes
   * this host-side, a remote frontend can't. */
  configState: "minerva/config/state",
  /** Frontend → kernel: list the skills available for a project. */
  skillsList: "minerva/skills/list",
  /** Frontend → kernel: list the named profiles defined in settings. */
  profilesList: "minerva/profiles/list",
  /** Frontend → kernel: switch (or clear) a session's active profile. */
  sessionSetProfile: "minerva/session/set_profile",
} as const;

/** Kernel → frontend. */
export const CLIENT_METHODS = {
  /** Notification. */
  sessionUpdate: "session/update",
  /** Notification (minerva/* extension): a whole session's replay updates in
   * one message, so the frontend rebuilds the transcript in a single pass. */
  sessionUpdateBatch: "minerva/session/update_batch",
  sessionRequestPermission: "session/request_permission",
  /** Notification (minerva/* extension): token usage after each completed turn. */
  sessionUsage: "minerva/session/usage",
  /** Notification (minerva/* extension): the kernel compacted a session on
   * its own (context-window pressure). */
  sessionCompacted: "minerva/session/compacted",
  /** Notification (minerva/* extension): a subagent's live progress, scoped
   * to the parent's task tool call. Generic ACP clients that ignore it still
   * see the task as an ordinary tool_call → tool_call_update pair. */
  sessionTaskUpdate: "minerva/session/task_update",
} as const;

// --- Content -----------------------------------------------------------

export interface TextContentBlock {
  type: "text";
  text: string;
}

/** Slice 1 is text-only; image/audio/resource variants arrive with ACP conformance. */
export type ContentBlock = TextContentBlock;

// --- initialize --------------------------------------------------------

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
  };
}

// --- session modes -----------------------------------------------------

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface SessionSetModeParams {
  sessionId: string;
  modeId: string;
}

export type SessionSetModeResult = null;

// --- session/new -------------------------------------------------------

export interface SessionNewParams {
  cwd: string;
  /**
   * minerva/* extension: named profile (from settings `profiles`) applied to
   * the session — replaces the base system prompt and may set the default
   * mode. Unknown names are rejected.
   */
  profile?: string;
}

/**
 * minerva/* extension: which AGENTS.md instruction files the kernel folded
 * into the system prompt at session establish. Additive — generic ACP
 * clients ignore it.
 */
export interface InstructionsInfo {
  files: Array<{ path: string; scope: "global" | "project"; truncated: boolean }>;
}

export interface SessionNewResult {
  sessionId: string;
  modes?: SessionModeState;
  instructions?: InstructionsInfo;
  /** minerva/* extension: the profile the session was created with. */
  profile?: string;
}

// --- session/load ------------------------------------------------------

/**
 * Resume a persisted session. The agent replays the conversation to the
 * client as session/update notifications before responding.
 */
export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
}

export interface SessionLoadResult {
  modes?: SessionModeState;
  instructions?: InstructionsInfo;
  /** minerva/* extension: the profile restored from the session log. */
  profile?: string;
}

// --- minerva/session/compact -------------------------------------------

export interface SessionCompactParams {
  sessionId: string;
}

export interface SessionCompactResult {
  summary: string;
}

// --- minerva/skills/list -----------------------------------------------

export interface SkillsListParams {
  cwd: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "global" | "project";
}

export interface SkillsListResult {
  skills: SkillInfo[];
}

// --- minerva/profiles/list ---------------------------------------------

export interface ProfilesListParams {
  cwd: string;
}

export interface ProfileInfo {
  name: string;
  model?: string;
  defaultMode?: string;
  /** Whether the profile replaces the base system prompt (body not shipped). */
  hasSystemPrompt: boolean;
}

export interface ProfilesListResult {
  profiles: ProfileInfo[];
  /** The settings-configured default profile, when one is set. */
  default?: string;
}

// --- minerva/session/set_profile ---------------------------------------

export interface SessionSetProfileParams {
  sessionId: string;
  /** Profile name to activate, or null to clear back to the base prompt. */
  profile: string | null;
}

export type SessionSetProfileResult = null;

// --- minerva/config/set_model ------------------------------------------

export interface ConfigSetModelParams {
  /** Model reference, e.g. "bailian/qwen-plus". */
  modelRef: string;
  /** Upsert this provider definition into global settings before switching. */
  provider?: {
    name: string;
    baseUrl?: string | undefined;
    apiKeyEnv?: string | undefined;
    defaultModel?: string | undefined;
    /** false = keyless endpoint; hosts won't demand a key at startup. */
    requiresApiKey?: boolean | undefined;
  };
  /** Stored in global settings only (file mode 0600). Omit to keep the env/stored key. */
  apiKey?: string;
}

export interface ConfigSetModelResult {
  providerId: string;
}

// --- minerva/config/state ----------------------------------------------

/** One selectable provider: registry definition plus where (if anywhere) a
 * usable API key was found. Blank env/settings values count as absent. */
export interface ConfigProviderState {
  name: string;
  defaultModel?: string | undefined;
  /** Env var the provider reads (e.g. DASHSCOPE_API_KEY). */
  keyVar: string;
  keySource: "env" | "settings" | "none";
  baseUrl?: string | undefined;
  /** Known model ids — selector suggestions; any id remains valid free text. */
  models?: string[] | undefined;
  /** false = keyless endpoint; an empty key entry is fine, not a gap. */
  requiresApiKey?: boolean | undefined;
}

export interface ConfigStateResult {
  /** The live provider's id, i.e. the model ref the kernel actually runs. */
  model: string;
  /** True when the live provider requires a key and none was found — the
   * signal for a frontend to open its first-run config flow. */
  needsApiKey: boolean;
  providers: ConfigProviderState[];
}

// --- minerva/sessions/list ---------------------------------------------

export interface SessionsListParams {
  cwd: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  createdAt: string;
  /** First user message, truncated — enough for a picker UI. */
  preview?: string | undefined;
}

export interface SessionsListResult {
  sessions: SessionSummary[];
}

// --- session/prompt ----------------------------------------------------

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface SessionPromptResult {
  stopReason: StopReason;
}

export interface SessionCancelParams {
  sessionId: string;
}

// --- session/update ----------------------------------------------------

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

export interface ToolCallStart {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  rawOutput?: unknown;
}

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: PlanEntryStatus;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ToolCallStart
  | ToolCallUpdate
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  /** ACP session-usage RFD: context-window utilization after a turn. `used`
   * is the last model call's context (input tokens incl. cache), `size` the
   * provider's declared window. Only emitted when the provider declares one;
   * richer token detail stays on minerva/session/usage. */
  | { sessionUpdate: "usage_update"; used: number; size: number };

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export interface SessionUpdateBatchParams {
  sessionId: string;
  updates: SessionUpdate[];
}

// --- minerva/session/usage ---------------------------------------------

/**
 * Token counts for one prompt turn or a whole session. Provider-truth
 * numbers only — cost needs per-model pricing the open provider registry
 * cannot bundle, so a cost field stays a future additive extension.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

export interface SessionUsageParams {
  sessionId: string;
  /** The turn that just finished; absent when re-announcing totals on session/load. */
  lastTurn?: TokenUsage | undefined;
  /** Totals across every persisted turn of the session, including lastTurn. */
  cumulative: TokenUsage;
}

// --- minerva/session/task_update -----------------------------------------

/**
 * A child (subagent) session's raw update, re-scoped to the PARENT session
 * and the task tool call that spawned it. Full fidelity on purpose: the wire
 * shape stays stable while each frontend decides how much of the nested
 * stream to render (the CLI shows a collapsed status line).
 */
export interface SessionTaskUpdateParams {
  /** The PARENT session. */
  sessionId: string;
  /** The parent's task tool call this progress belongs to. */
  toolCallId: string;
  childSessionId: string;
  update: SessionUpdate;
}

// --- minerva/session/compacted -----------------------------------------

/** Kernel-initiated compaction announcement (manual /compact responds to the
 * requester instead). `reason` is extensible; only "auto" exists today. */
export interface SessionCompactedParams {
  sessionId: string;
  summary: string;
  reason: "auto";
}

// --- session/request_permission ----------------------------------------

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind: ToolKind;
    rawInput?: unknown;
  };
  options: PermissionOption[];
  /**
   * minerva/* extension: set when the request comes from a subagent — the
   * PARENT's task tool call it runs under, so frontends can attribute the
   * prompt. `sessionId` is already the parent's (that's who the user is
   * talking to); generic ACP clients just see an ordinary request.
   */
  taskToolCallId?: string;
}

export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
}
