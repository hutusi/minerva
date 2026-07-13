# Domain context

> Update me when: a new domain term enters the code, an existing term's
> meaning shifts, or two terms start being used interchangeably (they must
> not — disambiguation is this file's job).

The ubiquitous language of this codebase. Each term links to its defining
file; use these words (and no synonyms) in code, commits, and docs.

## Core

- **kernel** — the protocol-fronted agent engine (`packages/kernel/src/kernel.ts`,
  `MinervaKernel`). Hosts bind it to a transport; it has no UI and no
  privileged API.
- **host** — the process wrapper that owns a kernel: the TUI entrypoint
  (in-proc), `minerva acp` (stdio), the GUI's spawned `minerva acp`.
- **frontend** — anything speaking the protocol to a kernel: Ink TUI, GUI
  webview, an editor.
- **transport** — the wire between them (`packages/protocol/src/transport.ts`
  in-proc, `stdio.ts` stream); carries JSON-RPC 2.0 both directions.
- **session** — one conversation, persisted as an append-only JSONL event log
  (`packages/kernel/src/session.ts`); the event stream is the source of
  truth. Identified by `ses_<uuid>`, scoped to a project cwd.
- **event / audit log** — the typed JSONL records inside a session log
  (`packages/kernel/src/events.ts`): messages, tool calls + decisions,
  mode/profile/model changes, turn accounting.
- **replay** — rebuilding state from the event log (`packages/kernel/src/replay.ts`):
  either model context (resume) or frontend view (session/load).
  **batch replay** is the capability-gated wire form of the latter —
  `minerva/session/update_batch` (see PROTOCOL.md), N additive batches, not a
  different reconstruction.
- **turn** — one `session/prompt` round trip, ending in a StopReason.
- **prompt lease** — a session's exclusivity guard: one active prompt per
  session (`promptActive` in `kernel.ts`; `prompt-lease.test.ts`).

## Policy and persona

- **mode** — the session's permission posture: `plan | default | acceptEdits |
  auto` (`packages/kernel/src/permissions.ts`, `SESSION_MODES`).
- **permission engine / rules** — kernel-enforced allow/deny/ask patterns like
  `Bash(git *)`; unmatched → `session/request_permission` to the frontend
  (`permissions.ts`).
- **profile** — a named persona in settings (`systemPrompt?`, `model?`,
  `defaultMode?`); sessions record the NAME and re-resolve on load
  (`packages/kernel/src/settings.ts`, `resolveProfile`).
- **skill** — a `skills/<name>/SKILL.md` prompt expansion, model-invoked via
  the `skill` tool or user-invoked as `/name`, expanded kernel-side
  (`packages/kernel/src/skills.ts`).
- **instructions** — AGENTS.md content (global + project root) appended to the
  system prompt at session establish (`packages/kernel/src/instructions.ts`).
  Distinct from *profile* (which replaces the base prompt).
- **compaction** — summarize-and-reset of model context; *auto-compaction*
  triggers at 80% of the provider's declared window
  (`packages/kernel/src/compact.ts`; threshold in `kernel.ts`). Does not
  reset usage telemetry.
- **subagent / task** — a task tool call spawning a child agent loop over its
  own persisted session, policed by the PARENT's permission engine
  (`packages/kernel/src/subagent.ts`; DESIGN.md D15).

## Model layer

- **provider / ModelProvider** — the kernel's model interface
  (`packages/providers/src/types.ts`); adapters and the builtin registry live
  in `registry.ts`. Only this package imports the AI SDK.
- **model ref** — `provider/model` (`bailian/qwen-plus`); provider is
  everything before the FIRST slash — model ids may contain slashes.
  Validating parse: `parseModelRef` (providers). Frontend split:
  `splitModelRef` (client). Bare refs default to anthropic.
- **key status / keySource** — where a usable API key was found
  (`env | settings | none`), blank-aware; single home is
  `providerKeyStatuses` (providers).

## GUI lifecycle (the terms that must never blur)

- **sidecar** — the kernel process the GUI's Rust layer spawns
  (`apps/gui/src-tauri/src/sidecar.rs`). (The release artifacts also call
  bundled `minerva`/`rg` binaries "sidecars" — Tauri's word; context
  disambiguates.)
- **generation** — a monotonically increasing id per *spawned kernel process*
  (Rust `NEXT_GENERATION`; webview gate in
  `apps/gui/src/lib/sidecar-generation.ts`). Answers: "is this exit/line
  event from the process I own?"
- **install token** — a per-*tab* monotonic token for async session installs
  (`apps/gui/src/lib/session-slots.ts`). Answers: "is this completed
  load/create still what the tab wants?" Unrelated to generations.
- **switch target** — the session a tab is currently trying to show
  (`apps/gui/src/lib/session-switches.ts`); tracks in-flight work separately
  from tokens so A→B→A reuses the running load.
- **drain** — the kernel's own shutdown work after stdin closes (cancel,
  settle in-flight, flush logs; ≤ `shutdownDrainMs`). **grace** — how long
  the Rust side waits for the drain before SIGKILL (7s). Drain is the
  kernel's act; grace is the supervisor's patience.
- **tab** — a project (cwd) open in the GUI (`apps/gui/src/lib/tabs.ts`);
  holds a cwd + persisted sessionId, multiplexed over ONE kernel.
- **permission queue** — the GUI's FIFO of pending permission requests
  (`apps/gui/src/lib/permission-queue.ts`); survives kernel restarts, its
  entries don't.
