#!/usr/bin/env bun
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "@minerva/providers";
import { render } from "ink";
import { App } from "./app";
import { PermissionBridge } from "./permission-bridge";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Export it and try again:");
  console.error('  export ANTHROPIC_API_KEY="sk-ant-..."');
  process.exit(1);
}

const model = process.env.MINERVA_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
const cwd = process.cwd();

// The CLI embeds the kernel, but only across the protocol's in-proc
// transport — the same messages a Tauri sidecar or remote kernel would see.
const [clientTransport, kernelTransport] = createInProcTransportPair();
createKernel(kernelTransport, { provider: createAnthropicProvider({ model }) });

const bridge = new PermissionBridge();
const client = new MinervaClient(clientTransport, {
  onPermissionRequest: bridge.onPermissionRequest,
});

const app = render(<App client={client} bridge={bridge} model={model} cwd={cwd} />);
await app.waitUntilExit();
// Ink unmounts but stdin's raw-mode listener keeps the runtime alive.
process.exit(0);
