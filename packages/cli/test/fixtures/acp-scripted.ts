/**
 * Test fixture: the `minerva acp` host wired to a scripted provider, so the
 * conformance harness can drive full prompt flows across a real process
 * boundary without a model API. Turns arrive as JSON via MINERVA_TEST_TURNS.
 */
import { createKernel } from "@minerva/kernel";
import { createStreamTransport } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";

const turns = JSON.parse(process.env.MINERVA_TEST_TURNS ?? "[]") as TurnEvent[][];
const transport = createStreamTransport(process.stdin, process.stdout);
createKernel(transport, {
  provider: createScriptedProvider(turns),
  dataDir: process.env.MINERVA_DATA_DIR,
});
await new Promise<void>((resolve) => {
  transport.onClose(resolve);
});
process.exit(0);
