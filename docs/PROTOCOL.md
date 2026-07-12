# Minerva Wire Protocol

The kernel is protocol-fronted: every frontend — the Ink CLI (in-process), an
editor speaking ACP over stdio, the planned Tauri sidecar and WebSocket
remote — exchanges the same JSON-RPC 2.0 messages. This document is the
reference for that wire surface (`@minerva/protocol` is the source of truth in
code; `PROTOCOL_VERSION = 1`).

Method names and payload shapes follow the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) wherever ACP
covers the need; Minerva-specific surface lives under the `minerva/*`
namespace. The protocol is **bidirectional**: the frontend calls the kernel
(prompting), and the kernel calls the frontend mid-turn (permission requests).

## Framing and transports

Messages are individual JSON-RPC requests, notifications, or responses,
delimited by `\n`, never containing embedded newlines (per the ACP stdio
transport spec — `JSON.stringify` guarantees this).

| Transport | Factory | Used by |
|---|---|---|
| In-process | `createInProcTransportPair()` | CLI embedding the kernel |
| Stream (stdio) | `createStreamTransport(input, output)` | `minerva acp`, future Tauri sidecar |
| WebSocket | — | planned (remote kernels) |

Error codes follow JSON-RPC 2.0 (`-32600` invalid request, `-32601` method not
found, `-32602` invalid params, `-32603` internal). A malformed line on the
stream transport is skipped (it carries no id to answer).

## Frontend → kernel (ACP core)

### `initialize`
Params `{ protocolVersion }` → `{ protocolVersion, agentCapabilities: { loadSession: true } }`.

### `session/new`
Params `{ cwd, profile? }` → `{ sessionId, modes, instructions?, profile? }`
where `modes` is
`{ currentModeId, availableModes: [{ id, name, description }] }`. Mode ids:
`plan | default | acceptEdits | auto`. `instructions` (minerva/* extension
field, absent when no AGENTS.md was found) is
`{ files: [{ path, scope: "global" | "project", truncated }] }` — the
AGENTS.md instruction files the kernel folded into the system prompt at
session establish. Generic ACP clients can ignore it. `profile` (minerva/*
extension, both directions) names a settings-defined profile: the request
field selects one explicitly (unknown names are rejected; omitted = the
settings `profile` default, if any), and the result field reports what was
applied. A profile's `systemPrompt` replaces the base system prompt (AGENTS.md
still appends), its `defaultMode` wins the initial mode.

### `session/load`
Params `{ sessionId, cwd }` → `{ modes, instructions?, profile? }` (same
`instructions` shape as `session/new`; instruction files are re-read on load).
Before responding, the kernel replays the persisted conversation to the
frontend as `session/update` notifications (transcript rebuild). Fails if the
session belongs to a different cwd or a prompt is running in it. The logged
profile NAME is re-resolved against current settings (so prompt edits take
effect); a vanished profile degrades to the base persona with a stderr
warning rather than failing the load.

### `session/prompt`
Params `{ sessionId, prompt: [{ type: "text", text }] }` → `{ stopReason }`.
Blocks until the turn completes. One prompt per session at a time.
`stopReason ∈ end_turn | max_tokens | max_turn_requests | refusal | cancelled`.

Skill expansion (minerva/* behavior): a prompt of the form `/name args`
whose `name` matches a skill loaded for the session is expanded kernel-side —
the transcript and replay keep the literal text the user typed, while the
model receives the skill's SKILL.md body plus the arguments. Slash text
matching no skill passes through unchanged. ACP hosts get this for free by
sending the user's raw input. The skill registry is re-read from disk on
every invocation, so the expansion always matches what `minerva/skills/list`
reports. A `deny` permission rule matching the `skill` tool rejects the
prompt (`INVALID_REQUEST`); `ask` rules are skipped — typing the command is
consent, and the expansion is recorded on the `user.message` event's
`providerText` field.

### `session/set_mode`
Params `{ sessionId, modeId }` → `null`. Persisted to the event log before the
response; echoed to every frontend as a `current_mode_update`.

### `session/cancel` *(notification)*
Params `{ sessionId }`. Aborts the running turn: the model stream is aborted,
pending tool calls resolve as cancelled errors, the prompt returns
`stopReason: "cancelled"`. Text already streamed is preserved in the log.

## Kernel → frontend

### `session/update` *(notification)*
Params `{ sessionId, update }`. `update.sessionUpdate` variants:

| Variant | Payload | Meaning |
|---|---|---|
| `user_message_chunk` | `content` | User text (emitted during replay) |
| `agent_message_chunk` | `content` | Streamed assistant text |
| `agent_thought_chunk` | `content` | Streamed model reasoning; re-emitted on `session/load` replay in stream order relative to the turn's message text |
| `tool_call` | `toolCallId, title, kind, status, rawInput` | Tool call started (`status: "pending"`) |
| `tool_call_update` | `toolCallId, status?, title?, content?, rawOutput?` | Progress → `in_progress`, then `completed`/`failed` with output |
| `plan` | `entries: [{ content, priority, status }]` | Todo list replaced |
| `current_mode_update` | `currentModeId` | Session mode changed |

`kind ∈ read | edit | delete | move | search | execute | think | fetch | other`;
`content` entries are `{ type: "content", content: { type: "text", text } }` or
`{ type: "diff", path, oldText, newText }` (ACP diff semantics: full before/after
file contents, `oldText: null` = new file). File-mutating tools (`edit_file`,
`write_file`) emit a diff entry ahead of their text output on the final
`tool_call_update`, live and on `session/load` replay; when either side exceeds
48 000 characters the diff entry is omitted (text-only fallback). Frontends
compute their own line diffs from the two sides.

### `minerva/session/usage` *(notification)*
Params `{ sessionId, lastTurn?, cumulative }`, where both usage shapes are
`{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }`.

Emitted after each completed prompt turn whose provider reported any usage
(including cancelled turns), and once after a `session/load` replay when the
rebuilt cumulative total is non-zero — that re-announcement omits `lastTurn`.
`cumulative` sums every persisted `turn.completed` of the session and is not
reset by compaction (it is spend telemetry, not context size). Token counts
are provider-truth; there is no cost field — pricing for the open provider
registry can't be bundled truthfully, so cost stays a future additive
extension (`cost?: { amount, currency }`, mirroring ACP's session-usage RFD).

### `session/request_permission` *(kernel → frontend request)*
Params `{ sessionId, toolCall: { toolCallId, title, kind, rawInput }, options }`
where `options` are `{ optionId, name, kind }`, kinds
`allow_once | allow_always | reject_once | reject_always`. Result:

```json
{ "outcome": { "outcome": "selected", "optionId": "allow" } }
{ "outcome": { "outcome": "cancelled" } }
```

`allow_always` persists a project permission rule (wildcards in the approved
value are escaped). `cancelled` means the frontend is abandoning the whole
turn, not answering the question — the kernel cancels the prompt. A transport
failure on this request denies by default and is audited as source `error`,
never attributed to the user.

## `minerva/*` extensions

### `minerva/sessions/list`
Params `{ cwd }` → `{ sessions: [{ sessionId, cwd, createdAt, preview? }] }`.
Most recently *used* first (resume re-appends to the index); capped at 20.

### `minerva/session/compact`
Params `{ sessionId }` → `{ summary }`. Runs one summarization turn, appends a
`session.compacted` event, and resets the model context to the summary. The
event log — and therefore the replayed transcript — keeps the full history.

### `minerva/skills/list`
Params `{ cwd }` → `{ skills: [{ name, description, source: "global" |
"project" }] }`. Reads `skills/<name>/SKILL.md` directories fresh from disk
(global data dir + project `.minerva/`), so no session is required and a
frontend can refresh after the user adds a skill. Project skills win name
collisions. Frontends use this to offer skills as slash commands; the model
reaches the same skills through the per-session `skill` tool.

### `minerva/profiles/list`
Params `{ cwd }` → `{ profiles: [{ name, model?, defaultMode?,
hasSystemPrompt }], default? }`. Lists the named profiles from merged
settings (`profiles` maps merge per name, project over global; the `default`
field is the settings `profile` scalar, project winning). Reads settings
fresh per call, like `minerva/skills/list` — no session required. Prompt
bodies are not shipped; `hasSystemPrompt` says whether one is defined.

### `minerva/session/set_profile`
Params `{ sessionId, profile: string | null }` → `null`. Switches the
session's active profile (or clears it back to the base persona with `null`);
applies from the next prompt, since the system prompt is rebuilt per prompt.
Unknown names are rejected; rejected while a prompt is running. Appends a
`session.profile_changed` event (flushed before acknowledging), so resume
restores the switch.

### `minerva/config/set_model`
Params `{ modelRef, provider?, apiKey? }` → `{ providerId }`. Persists the
model ref — and optionally a provider definition (`{ name, baseUrl?,
apiKeyEnv?, defaultModel?, requiresApiKey? }`) plus API key — to global
settings (written `0600`), then swaps the kernel's live provider; the next
prompt in any session uses it. `requiresApiKey: false` marks a keyless
endpoint so hosts don't demand a key at startup. Provider construction is host-injected (`KernelOptions.
resolveProvider`), keeping the kernel free of AI SDK knowledge; hosts without
a resolver reject the method. Open sessions log a `session.model_changed`
audit event, which replay ignores.

## Versioning

`PROTOCOL_VERSION` is exchanged in `initialize`. Additive changes (new
`minerva/*` methods, new update variants frontends may ignore) don't bump it;
breaking changes to existing shapes do, with a migration note in CHANGELOG.
The ACP-shaped subset tracks ACP v1; divergences must be recorded here.

Recorded divergences:
- **Usage telemetry.** ACP's session-usage RFD added a `usage_update` variant
  to `session/update` carrying context-window utilization (`used`/`size`,
  optional `cost`). Minerva instead emits the richer per-turn/cumulative
  token counts as the separate `minerva/session/usage` notification: emitting
  a truthful `used`/`size` needs per-model context-window metadata the open
  provider registry doesn't carry. ACP `usage_update` alignment is deferred
  until providers declare a context window.
