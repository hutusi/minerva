import { MinervaClient } from "@minerva/client";
import { createKernel, type KernelOptions } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";

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
    const establish = async () => {
      if (options.resume === "latest") {
        const sessions = await client.listSessions(cwd);
        const latest = sessions[0];
        if (!latest) throw new Error(`no previous sessions for ${cwd}`);
        return client.loadSession(latest.sessionId, cwd);
      }
      if (options.resume) return client.loadSession(options.resume, cwd);
      return client.newSession(cwd, options.profile ? { profile: options.profile } : {});
    };
    const { sessionId } = await establish();
    live = true;
    if (options.mode) await client.setMode(sessionId, options.mode);
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
