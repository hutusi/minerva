#!/usr/bin/env bun
import { MinervaClient } from "@minerva/client";
import { createKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import {
  apiKeyEnvVar,
  createProviderFromRef,
  DEFAULT_ANTHROPIC_MODEL,
  parseModelRef,
} from "@minerva/providers";
import { render } from "ink";
import { runAcpHost } from "./acp";
import { App } from "./app";
import { parseCliArgs, usage } from "./args";
import { createPermissionBridge } from "./permission-bridge";

const defaultModel = process.env.MINERVA_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
const parsed = parseCliArgs(process.argv.slice(2), defaultModel);
if (parsed.kind === "help") {
  console.log(usage(defaultModel));
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`${parsed.message}\n\n${usage(defaultModel)}`);
  process.exit(1);
}
const { command, model, resume } = parsed.args;

let providerName: ReturnType<typeof parseModelRef>["provider"];
try {
  providerName = parseModelRef(model).provider;
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
const keyVar = apiKeyEnvVar(providerName);
if (!process.env[keyVar]) {
  console.error(`${keyVar} is not set (required for ${model}). Export it and try again:`);
  console.error(`  export ${keyVar}="..."`);
  process.exit(1);
}

const kernelOptions = {
  provider: createProviderFromRef(model),
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

const bridge = createPermissionBridge();
const client = new MinervaClient(clientTransport, {
  onPermissionRequest: bridge.onPermissionRequest,
});

const app = render(<App client={client} bridge={bridge} model={model} cwd={cwd} resume={resume} />);
await app.waitUntilExit();
// Ink unmounts but stdin's raw-mode listener keeps the runtime alive.
process.exit(0);
