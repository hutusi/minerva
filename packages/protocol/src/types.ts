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
  sessionPrompt: "session/prompt",
  /** Notification. */
  sessionCancel: "session/cancel",
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

// --- session/new -------------------------------------------------------

export interface SessionNewParams {
  cwd: string;
}

export interface SessionNewResult {
  sessionId: string;
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

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ToolCallStart
  | ToolCallUpdate;

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
