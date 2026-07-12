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
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct SidecarState(Mutex<Option<Running>>);

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

/// Lock helper: a poisoned mutex only means a forwarding thread panicked
/// mid-update; the Option inside is still coherent enough to take/replace.
fn lock(state: &SidecarState) -> std::sync::MutexGuard<'_, Option<Running>> {
    state
        .0
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
pub fn sidecar_start(app: AppHandle, state: State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = lock(&state);
    if let Some(running) = guard.as_mut() {
        // Still alive → idempotent no-op (webview reloads call start again).
        // Exited but never taken (e.g. no listener saw the exit) → reap and respawn.
        match running.child.try_wait() {
            Ok(None) => return Ok(()),
            _ => {
                let mut dead = guard.take().expect("guard checked Some above");
                let _ = dead.child.wait();
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

    let handle = app.clone();
    std::thread::spawn(move || {
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
        // EOF: the kernel exited (or was killed). Whoever still holds the
        // child reaps it; emit exactly one exit event from this thread.
        let code = {
            let state = handle.state::<SidecarState>();
            let mut guard = lock(&state);
            match guard.take() {
                Some(mut running) => running.child.wait().ok().and_then(|s| s.code()),
                None => None,
            }
        };
        let _ = handle.emit("minerva://exit", ExitPayload { code });
    });

    *guard = Some(Running { child, stdin });
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

#[tauri::command]
pub fn sidecar_kill(state: State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = lock(&state);
    if let Some(mut running) = guard.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

/// Exit-time cleanup, called from the RunEvent::Exit hook.
pub fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut guard = lock(&state);
    if let Some(mut running) = guard.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
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
