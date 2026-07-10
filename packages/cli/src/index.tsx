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

const USAGE = `minerva — model-agnostic code agent

Usage: minerva [options]
  -c, --continue       Resume the most recent session for this directory
  -r, --resume <id>    Resume a specific session
  -m, --model <id>     Model to use (default: ${DEFAULT_ANTHROPIC_MODEL}, env: MINERVA_MODEL)
  -h, --help           Show this help`;

let model = process.env.MINERVA_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
let resume: string | null = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--continue" || arg === "-c") {
    resume = "latest";
  } else if (arg === "--resume" || arg === "-r") {
    resume = argv[++i] ?? null;
    if (!resume) {
      console.error("--resume requires a session id");
      process.exit(1);
    }
  } else if (arg === "--model" || arg === "-m") {
    model = argv[++i] ?? model;
  } else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option: ${arg}\n\n${USAGE}`);
    process.exit(1);
  }
}

const cwd = process.cwd();

// The CLI embeds the kernel, but only across the protocol's in-proc
// transport — the same messages a Tauri sidecar or remote kernel would see.
const [clientTransport, kernelTransport] = createInProcTransportPair();
createKernel(kernelTransport, { provider: createAnthropicProvider({ model }) });

const bridge = new PermissionBridge();
const client = new MinervaClient(clientTransport, {
  onPermissionRequest: bridge.onPermissionRequest,
});

const app = render(<App client={client} bridge={bridge} model={model} cwd={cwd} resume={resume} />);
await app.waitUntilExit();
// Ink unmounts but stdin's raw-mode listener keeps the runtime alive.
process.exit(0);
