# 0002 — GUI kernel lifecycle: Rust-owned child, generations, drain-first shutdown

Status: accepted · Date: 2026-07-13

## Context

The Tauri GUI (M2, PR #16) runs the kernel as a stdio child process. Three
forces shaped the lifecycle design, mostly discovered the hard way across six
review rounds (codex ×4, CodeRabbit, one consolidated final-state review):

- Webview JS is an unreliable owner: Vite HMR reloads it constantly, and a
  webview-held child is orphaned on every reload.
- Tauri events are app-global: a dying kernel's stdout lines and exit event
  can reach a *replacement's* freshly subscribed listeners, corrupting the
  new connection or triggering crash recovery against an intentional kill.
- The kernel has a durability contract (D7: the event log is the source of
  truth): on stdin EOF it cancels, drains in-flight work (≤5s) and flushes
  session logs. SIGKILL-first shutdown silently loses tail events.

## Decision

- **Rust owns the child** (`apps/gui/src-tauri/src/sidecar.rs`); the webview
  gets a dumb pipe (`minerva://line` / `minerva://exit` events) and all
  policy — restart, reconnect, tokens — lives in TS
  (`apps/gui/src/lib/kernel-manager.ts`). No `shell:*` capability is granted
  to the webview.
- **Generations everywhere**: each spawn gets a monotonic id. The Rust
  stdout thread only reaps/reports a death of its own still-current
  generation; kills are generation-targeted; the webview gates exit events
  through the same id (`sidecar-generation.ts`). Intentional shutdowns are
  therefore silent and can never masquerade as crashes.
- **Drain-first shutdown**: close stdin → wait up to 7s (kernel drain 5s +
  margin) → SIGKILL as fallback → join the stdout forwarder before the slot
  is reusable. App quit blocks on this by design.
- **Serialized lifecycle**: an async `lifecycle` mutex spans whole start/kill
  operations; the fine-grained `slot` lock is never held across a wait or a
  pipe write (full two-lock audit in the `SidecarState` doc comment).
- **Bounded recovery**: one automatic respawn per death, replenished only by
  manual restart; the connect handshake times out at 15s and a failed start
  awaits the kill before offering restart.

Rejected: `tauri-plugin-shell`'s JS-held child (HMR orphaning, unverifiable
line framing); killing first and draining never (loses the durability
contract); unlimited auto-restart (crash loops).

## Consequences

- Quit can take up to 7s against a wedged kernel — accepted, that's the
  durability trade.
- The invariants are spread across Rust and TS and MUST move together; the
  index is [ARCHITECTURE.md](../ARCHITECTURE.md) § Invariants, the
  authoritative statements are the cited code comments, and the regression
  tests live in `apps/gui/test/` (kernel-manager, sidecar-generation,
  session-slots, session-switches) plus `src-tauri`'s Rust tests.
