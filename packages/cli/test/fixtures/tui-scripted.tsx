/**
 * Test fixture: the real TUI wired to a scripted provider, for PTY-driven
 * e2e (scripts/e2e-tui.exp). Turns arrive as JSON via MINERVA_TEST_TURNS;
 * MINERVA_DATA_DIR isolates session state.
 */
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { render } from "ink";
import { App } from "../../src/app";
import { createPermissionBridge } from "../../src/permission-bridge";

const turns = JSON.parse(process.env.MINERVA_TEST_TURNS ?? "[]") as TurnEvent[][];
const [clientTransport, kernelTransport] = createInProcTransportPair();
createKernel(kernelTransport, {
  provider: createScriptedProvider(turns),
  ...(process.env.MINERVA_DATA_DIR ? { dataDir: process.env.MINERVA_DATA_DIR } : {}),
});

const bridge = createPermissionBridge();
const client = new MinervaClient(clientTransport, {
  onPermissionRequest: bridge.onPermissionRequest,
});

const app = render(
  <App
    client={client}
    bridge={bridge}
    model="scripted"
    cwd={process.cwd()}
    resume={null}
    providers={[]}
    needsConfig={false}
  />,
);
await app.waitUntilExit();
process.exit(0);
