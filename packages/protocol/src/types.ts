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
} as const;

/** Kernel → frontend. */
export const CLIENT_METHODS = {
  /** Notification. */
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
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
}

export interface SessionNewResult {
  sessionId: string;
  modes?: SessionModeState;
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
}

// --- minerva/session/compact -------------------------------------------

export interface SessionCompactParams {
  sessionId: string;
}

export interface SessionCompactResult {
  summary: string;
}

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
  };
  /** Stored in global settings only (file mode 0600). Omit to keep the env/stored key. */
  apiKey?: string;
}

export interface ConfigSetModelResult {
  providerId: string;
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
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
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
}

export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
}
