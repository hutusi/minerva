# Architecture

> Update me when: a package's dependency rules change, a new process/transport
> appears, on-disk state moves, or an invariant below changes (update the code
> comment first — this file is the index, the comment is the source of truth).

The one-paragraph version: Minerva is a protocol-fronted kernel (agent loop,
sessions, tools, permissions) with swappable frontends. Every frontend — Ink
TUI, Tauri GUI, editors — speaks the same JSON-RPC 2.0 wire surface
([PROTOCOL.md](PROTOCOL.md)); nothing gets a privileged in-process API. The
founding decisions live in [DESIGN.md](DESIGN.md); newer ones in
[adr/](adr/); vocabulary in [CONTEXT.md](../CONTEXT.md).

## Packages and their dependency rules

```
 packages/protocol    zero deps. JSON-RPC framing, ACP + minerva/* types,
        ▲             Transport interface, in-proc + stdio transports.
        │             Must stay loadable in a browser (no node:* imports —
        │             the webview loads it via the client package).
        │
 packages/providers   ModelProvider + AI SDK adapters; the ONLY package that
        ▲             imports `ai`. Must NEVER enter a webview bundle.
        │
 packages/kernel      agent loop, Session (JSONL event log), tools, MCP,
        ▲             permissions, settings. Depends on protocol + providers.
        │             OS access only through the runtime-adapter seam
        │             (src/runtime.ts) so a Node build stays cheap.
        │
 packages/client      MinervaClient + SessionStore view-model + shared
        ▲    ▲        frontend helpers (diff, format, model-ref). Runtime
        │    │        dep on protocol ONLY (kernel/providers are dev-only,
        │    │        for tests) — that is what lets it enter the webview.
        │    │
 packages/cli    apps/gui
 (Ink TUI +      (React webview + Rust shell; webview may import client +
  acp host)       protocol, never kernel/providers)
```

Rules of thumb: shared frontend logic goes in `client` (it is the "shared
frontend core" of DESIGN.md D8); anything touching the AI SDK goes in
`providers`; policy shared by kernel and TUI hosts goes in `providers` or
`kernel`, not copied (see `providerKeyStatuses`, `splitModelRef` — each
policy has exactly one home).

## Processes and transports

```
 TUI     : one process. Ink UI ── in-proc transport ── kernel (same JS heap,
           same wire messages — no shortcut API).
 Editors : editor ── stdio ── `minerva acp` (kernel host; stdout is protocol,
           stderr is diagnostics).
 GUI     : webview (React) ── Tauri IPC (invoke + events) ── Rust sidecar
           manager ── stdio ── `minerva acp --allow-unconfigured`.
           Rust is a dumb pipe with line framing; ALL policy (restart,
           reconnect, tokens) lives in TS.
 Remote  : WebSocket transport is designed-for, not built (DESIGN.md D2).
```

The GUI's Rust layer (`apps/gui/src-tauri/src/sidecar.rs`) frames stdout into
one `minerva://line` event per JSON frame and reports unexpected death as
`minerva://exit`. The TS side stacks: `sidecar-bridge` (only module touching
@tauri-apps/api) → `sidecar-generation` (exit-event gate) → `tauri-transport`
(JSON codec) → `kernel-manager` (lifecycle policy) → `MinervaClient`.

## Where state lives

- `~/.minerva/settings.json` (0600; the only place API keys are stored) and
  `<project>/.minerva/settings.json` (keys stripped) — merge rules in
  `packages/kernel/src/settings.ts`.
- Sessions: `~/.minerva/projects/<slug>/<sessionId>.jsonl` append-only event
  logs + `index.jsonl`; the event stream is the source of truth (resume =
  replay). Shared by ALL frontends — the GUI resumes TUI sessions and vice
  versa.
- Frontend-local state stays out of the protocol: TUI input history
  (`~/.minerva/history.jsonl`), GUI tabs/drafts/preferences (localStorage).

## Invariants index

The authoritative statement of each invariant is the code comment at the
location cited. Do not change behavior without updating both.

**Sidecar lifecycle (GUI ⇄ kernel process)**
- Rust owns the kernel child; a webview reload must never orphan or respawn
  one — `sidecar.rs` module header.
- Two-lock discipline: `slot` is never held across a wait; `lifecycle`
  serializes whole start/kill (including reader join); the reader thread
  never takes `lifecycle` — `sidecar.rs` `SidecarState` doc comment.
- Every spawn has a monotonic generation; only an unexpected death of the
  still-current generation emits `minerva://exit` (intentional kills are
  silent, and kills are generation-targeted so a stale kill can't reap a
  replacement) — `sidecar.rs` `NEXT_GENERATION` + EOF-path comments.
- `sidecar_send` never holds `slot` across the pipe write; a fair `writes`
  mutex preserves frame order — `sidecar_send` comment.
- Shutdown is drain-first: close stdin (kernel flushes ≤5s), wait ≤7s, kill
  as fallback, then JOIN the stdout forwarder — `shutdown_gracefully`.
- Exit events are generation-gated in the webview too: a previous kernel's
  delayed exit must not tear down its replacement —
  `apps/gui/src/lib/sidecar-generation.ts` header.
- One automatic respawn per death; the allowance is replenished only by a
  manual restart (crash-loop guard); the handshake is bounded (15s) and a
  failed start awaits the kill before showing "down" —
  `apps/gui/src/lib/kernel-manager.ts` comments.

**GUI session state**
- Async session installs commit only while their per-tab token is current;
  superseded results are CLOSED, not installed —
  `apps/gui/src/lib/session-slots.ts` header.
- "Is work running for this target" is tracked separately from install
  tokens; that separation makes A→B→A switches reuse the in-flight load —
  `apps/gui/src/lib/session-switches.ts` header.
- `sessionsRef` is the authoritative sessions map, updated synchronously at
  commit; completion handlers never read the render closure — `app.tsx`
  comment beside `sessionsRef`.
- A fresh kernel client invalidates every store and token; sessions rebuild
  lazily per tab from JSONL replay — `kernel-manager.ts` snapshot comment +
  `app.tsx` client-change effect.

**Kernel**
- Every request handler refuses work after close() and enrolls in the
  #inFlight drain — EXCEPT `session/cancel`, which close() itself relies on —
  `kernel.ts` `#register` + cancel-registration comments.
- Batched replay is capability-gated and capped (4 MB / 1000 updates per
  batch, under the 16 MB frame limit) — `kernel.ts` `chunkReplayUpdates`.
- Profile mutations queue per session in arrival order — `kernel.ts`
  `#profileMutations`.

**Protocol**
- Stdio frames: 16 MB inbound cap (byte-measured), 64 MB outbound queue cap,
  malformed lines skipped, UTF-8 decoded across chunk boundaries with
  TextDecoder (must stay webview-loadable) — `packages/protocol/src/stdio.ts`.
