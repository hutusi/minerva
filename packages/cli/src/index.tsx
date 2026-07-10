#!/usr/bin/env bun
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "@minerva/providers";
import { render } from "ink";
import { runAcpHost } from "./acp";
import { App } from "./app";
import { PermissionBridge } from "./permission-bridge";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Export it and try again:");
  console.error('  export ANTHROPIC_API_KEY="sk-ant-..."');
  process.exit(1);
}

const USAGE = `minerva — model-agnostic code agent

Usage: minerva [command] [options]

Commands:
  (default)            Interactive terminal UI
  acp                  Host the kernel on stdio (ACP framing) for editors

Options:
  -c, --continue       Resume the most recent session for this directory
  -r, --resume <id>    Resume a specific session
  -m, --model <id>     Model to use (default: ${DEFAULT_ANTHROPIC_MODEL}, env: MINERVA_MODEL)
  -h, --help           Show this help

Environment:
  MINERVA_DATA_DIR     Session/config root (default: ~/.minerva)`;

let model = process.env.MINERVA_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
let resume: string | null = null;
let command: "tui" | "acp" = "tui";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "acp" && command === "tui") {
    command = "acp";
  } else if (arg === "--continue" || arg === "-c") {
    resume = "latest";
  } else if (arg === "--resume" || arg === "-r") {
    const value = argv[++i];
    if (!value || value.startsWith("-")) {
      console.error("--resume requires a session id");
      process.exit(1);
    }
    resume = value;
  } else if (arg === "--model" || arg === "-m") {
    const value = argv[++i];
    if (!value || value.startsWith("-")) {
      console.error("--model requires a model id");
      process.exit(1);
    }
    model = value;
  } else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option: ${arg}\n\n${USAGE}`);
    process.exit(1);
  }
}

const kernelOptions = {
  provider: createAnthropicProvider({ model }),
  dataDir: process.env.MINERVA_DATA_DIR,
};

if (command === "acp") {
  // stdout carries the protocol; the kernel must never render UI here.
  await runAcpHost(kernelOptions);
  process.exit(0);
}

const cwd = process.cwd();

// The CLI embeds the kernel, but only across the protocol's in-proc
// transport — the same messages a Tauri sidecar or remote kernel would see.
const [clientTransport, kernelTransport] = createInProcTransportPair();
createKernel(kernelTransport, kernelOptions);

const bridge = new PermissionBridge();
const client = new MinervaClient(clientTransport, {
  onPermissionRequest: bridge.onPermissionRequest,
});

const app = render(<App client={client} bridge={bridge} model={model} cwd={cwd} resume={resume} />);
await app.waitUntilExit();
// Ink unmounts but stdin's raw-mode listener keeps the runtime alive.
process.exit(0);
