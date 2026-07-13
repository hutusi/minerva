//! Kernel sidecar process manager.
//!
//! Rust owns the child (not the webview) so a webview reload — constant under
//! Vite HMR — can never orphan a kernel. The protocol is newline-delimited
//! JSON-RPC (see packages/protocol/src/stdio.ts): framing happens here on the
//! raw byte stream, so a frame split across pipe reads or a multibyte UTF-8
//! character on a chunk boundary can't corrupt a message. Each complete line
//! is forwarded verbatim to the webview as a `minerva://line` event; process
//! death surfaces as `minerva://exit`. Policy (restart, reconnect) lives in TS.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Monotonic child generation: every spawn gets a fresh id so a lingering
/// stdout thread from an earlier child can never mistake a newer child for
/// its own (take it out of state, reap it, or report its death).
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub struct Running {
    generation: u64,
    child: Child,
    stdin: ChildStdin,
    /// The stdout forwarder thread — joined during shutdown so no stray
    /// line events can outlive an intentional kill.
    reader: Option<std::thread::JoinHandle<()>>,
}

/// Two locks with strictly separated roles (deadlock audit):
/// - `slot` is fine-grained: taken briefly by send, the reader thread's EOF
///   path, and start/kill state swaps. Never held across a wait.
/// - `lifecycle` serializes whole start/kill operations: a start during a
///   shutdown waits until the old process is reaped AND its forwarder is
///   joined, so a replacement can never race a draining kernel (webview
///   reloads invoke start at any time). The reader thread NEVER takes
///   `lifecycle`, and shutdown never holds `slot` while joining the reader —
///   so the join cannot deadlock, even for a crash racing a kill.
#[derive(Default)]
pub struct SidecarState {
    slot: Mutex<Option<Running>>,
    lifecycle: tauri::async_runtime::Mutex<()>,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

/// Lock helper: a poisoned mutex only means a forwarding thread panicked
/// mid-update; the Option inside is still coherent enough to take/replace.
fn lock(state: &SidecarState) -> std::sync::MutexGuard<'_, Option<Running>> {
    state
        .slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Dev runs the kernel from source via Bun; release runs the compiled
/// `minerva` binary bundled next to the app executable (externalBin).
fn kernel_command() -> Result<Command, String> {
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = <repo>/apps/gui/src-tauri at compile time.
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .map_err(|e| format!("cannot resolve repo root: {e}"))?;
        let entry = repo_root.join("packages/cli/src/index.tsx");
        let mut cmd = Command::new("bun");
        cmd.arg("run")
            .arg(entry)
            .arg("acp")
            .arg("--allow-unconfigured");
        cmd.current_dir(repo_root);
        Ok(cmd)
    } else {
        let exe = std::env::current_exe().map_err(|e| format!("cannot resolve app path: {e}"))?;
        let dir = exe
            .parent()
            .ok_or("app executable has no parent directory")?;
        let mut cmd = Command::new(dir.join("minerva"));
        cmd.arg("acp").arg("--allow-unconfigured");
        Ok(cmd)
    }
}

#[tauri::command]
pub async fn sidecar_start(app: AppHandle, state: State<'_, SidecarState>) -> Result<(), String> {
    // Wait out any in-flight shutdown before touching the slot: without this,
    // a webview-reload start could spawn a replacement while the old kernel
    // is still draining and its forwarder still emitting into our events.
    let _lifecycle = state.lifecycle.lock().await;
    let mut guard = lock(&state);
    if let Some(running) = guard.as_mut() {
        // Still alive → idempotent no-op (webview reloads call start again).
        // Exited but never taken (e.g. no listener saw the exit) → reap and respawn.
        match running.child.try_wait() {
            Ok(None) => return Ok(()),
            _ => {
                let mut dead = guard.take().expect("guard checked Some above");
                // Same discipline as the kill path: the dead child's reader
                // must finish before a successor exists, or its last buffered
                // frames could reach the successor's connection. Release the
                // slot lock first — the reader's EOF path takes it (finds the
                // slot empty and returns without emitting), so joining while
                // holding it would deadlock. The lifecycle lock (held for all
                // of start) keeps anything else out of the empty slot.
                drop(guard);
                let _ = dead.child.wait();
                if let Some(reader) = dead.reader.take() {
                    let _ = reader.join();
                }
                guard = lock(&state);
            }
        }
    }

    let mut child = kernel_command()?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn kernel: {e}"))?;

    let stdin = child.stdin.take().ok_or("kernel stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("kernel stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("kernel stderr unavailable")?;

    // stderr is diagnostics only (the protocol owns stdout) — mirror it to the
    // dev terminal so kernel logs stay visible.
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[minerva kernel] {line}");
        }
    });

    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let handle = app.clone();
    let reader = std::thread::spawn(move || {
        let mut reader = stdout;
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    // Frames are complete lines; bytes after the last newline
                    // stay buffered until the kernel sends the rest.
                    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=pos).collect();
                        let text = String::from_utf8_lossy(&line[..line.len() - 1]);
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            let _ = handle.emit("minerva://line", trimmed);
                        }
                    }
                }
            }
        }
        // EOF. Only an UNEXPECTED death — our own generation still sitting in
        // state — is reaped and reported here. If state holds nothing or a
        // newer generation, this child was intentionally shut down (or
        // replaced): shutdown_gracefully owns the reaping, and emitting an
        // exit event would make the frontend run crash recovery against a
        // kill it asked for (or worse, against the replacement child).
        let code = {
            let state = handle.state::<SidecarState>();
            let mut guard = lock(&state);
            match guard.as_ref() {
                Some(running) if running.generation == generation => {
                    let mut running = guard.take().expect("checked Some above");
                    running.child.wait().ok().and_then(|s| s.code())
                }
                _ => return,
            }
        };
        let _ = handle.emit("minerva://exit", ExitPayload { code });
    });

    *guard = Some(Running {
        generation,
        child,
        stdin,
        reader: Some(reader),
    });
    Ok(())
}

#[tauri::command]
pub fn sidecar_send(line: String, state: State<'_, SidecarState>) -> Result<(), String> {
    // Holding the lock across the write serializes whole frames — two invokes
    // can never interleave bytes on the kernel's stdin.
    let mut guard = lock(&state);
    let running = guard.as_mut().ok_or("kernel is not running")?;
    running
        .stdin
        .write_all(line.as_bytes())
        .and_then(|()| running.stdin.write_all(b"\n"))
        .and_then(|()| running.stdin.flush())
        .map_err(|e| format!("write to kernel failed: {e}"))
}

/// The kernel drains in-flight work for up to 5s (kernel shutdownDrainMs)
/// and then flushes session logs; give it that plus margin before killing.
const SHUTDOWN_GRACE_MS: u64 = 7_000;

/// Durability-preserving shutdown: closing stdin is the kernel's shutdown
/// signal — the acp host runs kernel.close() (cancel, drain, flush session
/// logs) on EOF and exits on its own. SIGKILL is the fallback, not the plan;
/// killing first would lose pending session events and in-progress turns.
/// Callers must NOT hold the state lock — this can block for the full grace.
fn shutdown_gracefully(mut running: Running) {
    drop(running.stdin);
    let deadline = Instant::now() + Duration::from_millis(SHUTDOWN_GRACE_MS);
    let mut reaped = false;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = running.child.try_wait() {
            eprintln!("[minerva gui] kernel exited gracefully on stdin close");
            reaped = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if !reaped {
        eprintln!("[minerva gui] kernel shutdown grace expired; killing");
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    // Drain the forwarder before declaring the shutdown complete: it exits on
    // pipe EOF (bounded — the process is dead), and joining it guarantees no
    // stray line event from this kernel can reach a successor's listeners.
    // The EOF path finds the slot empty (we hold the Running) and returns
    // without taking any long-held lock, so this join cannot deadlock.
    if let Some(reader) = running.reader.take() {
        let _ = reader.join();
    }
}

#[tauri::command]
pub async fn sidecar_kill(state: State<'_, SidecarState>) -> Result<(), String> {
    // Hold the lifecycle lock for the whole shutdown: a concurrent start
    // queues behind it instead of spawning a replacement mid-drain.
    let _lifecycle = state.lifecycle.lock().await;
    let taken = lock(&state).take();
    if let Some(running) = taken {
        // Off the command thread: the grace wait can block for seconds, and
        // the caller awaits so it knows when the old kernel is really gone.
        tauri::async_runtime::spawn_blocking(move || shutdown_gracefully(running))
            .await
            .map_err(|e| format!("shutdown task failed: {e}"))?;
    }
    Ok(())
}

/// Exit-time cleanup, called from the RunEvent::Exit hook. Blocking the main
/// thread is the point here — quit must not complete before the drain does.
pub fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let _lifecycle = tauri::async_runtime::block_on(state.lifecycle.lock());
    let taken = lock(&state).take();
    if let Some(running) = taken {
        shutdown_gracefully(running);
    }
}

/// Starting project directory for the first session until the folder picker
/// lands: the user's home directory, matching what a fresh terminal would use.
#[tauri::command]
pub fn default_cwd() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}
