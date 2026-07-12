import { MinervaClient } from "@minerva/client";
import { createKernel, type KernelOptions } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { establishSession } from "./establish";

/**
 * One-shot print mode (`minerva -p "…"`): run a single prompt against a
 * fresh (or resumed) session, stream the reply to stdout, and exit. The
 * model's text is the only thing on stdout — tool progress and diagnostics
 * go to stderr — so the output pipes cleanly.
 *
 * Non-interactive permission story: there is nobody to ask, so permission
 * requests are auto-DENIED (with a stderr note pointing at --mode). The
 * model sees the denial and can continue; --mode acceptEdits/auto widens
 * what runs without asking, exactly like the TUI modes.
 */

interface Sink {
  write(text: string): unknown;
}

export interface PrintModeOptions {
  kernelOptions: KernelOptions;
  cwd: string;
  prompt: string;
  mode?: string | null | undefined;
  profile?: string | null | undefined;
  /** null = new session; "latest" = most recent for cwd; else a session id. */
  resume?: string | null | undefined;
  io: { stdout: Sink; stderr: Sink };
}

export async function runPrintMode(options: PrintModeOptions): Promise<number> {
  const { cwd, io } = options;
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, options.kernelOptions);
  // A resume replays the prior transcript as updates BEFORE establish
  // resolves; only the new turn belongs on stdout.
  let live = false;
  let wroteText = false;
  const client = new MinervaClient(clientTransport, {
    onPermissionRequest: async (request) => {
      io.stderr.write(
        `permission denied (non-interactive): ${request.toolCall.title} — rerun with --mode acceptEdits|auto\n`,
      );
      const reject = request.options.find((option) => option.kind === "reject_once");
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    onSessionUpdate: (_sessionId, update) => {
      if (!live) return;
      if (update.sessionUpdate === "agent_message_chunk") {
        io.stdout.write(update.content.text);
        wroteText = true;
      } else if (update.sessionUpdate === "tool_call") {
        // Progress without polluting stdout.
        io.stderr.write(`⏺ ${update.title}\n`);
      }
    },
  });
  try {
    await client.initialize();
    const { sessionId, store } = await establishSession(client, cwd, {
      resume: options.resume,
      profile: options.profile,
    });
    live = true;
    // Print mode always runs in an EXPLICIT mode: default unless --mode. A
    // session or settings default of auto must not silently execute tools in
    // a headless run — the documented contract is deny-unless-flagged. Only
    // set when it differs; set_mode has no no-op guard and would append a
    // redundant mode_changed event per run.
    const desired = options.mode ?? "default";
    if ((store.snapshot.currentModeId ?? "default") !== desired) {
      await client.setMode(sessionId, desired);
    }
    const stopReason = await client.prompt(sessionId, options.prompt);
    if (wroteText) io.stdout.write("\n");
    if (stopReason !== "end_turn") {
      io.stderr.write(`turn ended early: ${stopReason}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    io.stderr.write(`minerva: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    // Flush session logs and close MCP even on failure; a durability error
    // is worth a note but must not mask the primary outcome.
    await kernel.close().catch((error) => {
      io.stderr.write(`minerva: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}
