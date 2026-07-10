/**
 * Live-model smoke test: one real prompt through the full stack (client →
 * in-proc kernel → AI SDK → Anthropic). Run by CI on main pushes when the
 * ANTHROPIC_API_KEY secret is configured; skips quietly otherwise so forks
 * and secretless checkouts stay green.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createAnthropicProvider } from "@minerva/providers";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("live-smoke: ANTHROPIC_API_KEY not set — skipping");
  process.exit(0);
}

const timeout = setTimeout(() => {
  console.error("live-smoke: timed out after 120s");
  process.exit(1);
}, 120_000);

const cwd = mkdtempSync(join(tmpdir(), "minerva-live-proj-"));
const dataDir = mkdtempSync(join(tmpdir(), "minerva-live-data-"));

const [clientTransport, kernelTransport] = createInProcTransportPair();
createKernel(kernelTransport, { provider: createAnthropicProvider({}), dataDir });
const client = new MinervaClient(clientTransport);

await client.initialize();
const { sessionId, store } = await client.newSession(cwd);
const stopReason = await client.prompt(
  sessionId,
  "Reply with exactly the two characters: OK — no tools, nothing else.",
);

const reply = store.snapshot.items
  .filter((item) => item.kind === "assistant")
  .map((item) => item.text)
  .join("");

clearTimeout(timeout);
if (stopReason !== "end_turn" || !reply.includes("OK")) {
  console.error(`live-smoke: FAILED — stopReason=${stopReason} reply=${JSON.stringify(reply)}`);
  process.exit(1);
}
console.log(`live-smoke: OK (stopReason=${stopReason})`);
process.exit(0);
