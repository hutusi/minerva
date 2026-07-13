#!/usr/bin/env bun
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import {
  createKernel,
  defaultDataDir,
  defaultRuntime,
  loadSettings,
  type ResolvedSettings,
} from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import {
  apiKeyEnvVar,
  buildProviderRegistry,
  createProviderFromRef,
  DEFAULT_ANTHROPIC_MODEL,
  type ModelProvider,
  parseModelRef,
  providerKeyStatuses,
  resolveApiKey,
} from "@minerva/providers";
import { render } from "ink";
import pkg from "../package.json";
import { runAcpHost } from "./acp";
import { App } from "./app";
import { parseCliArgs, usage } from "./args";
import type { ProviderChoice } from "./config-panel";
import { appendHistoryFile, loadHistoryFile } from "./history-file";
import { createPermissionBridge } from "./permission-bridge";
import { runPrintMode } from "./print";

const usageDefault = process.env.MINERVA_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.kind === "version") {
  console.log(`minerva ${pkg.version}`);
  process.exit(0);
}
if (parsed.kind === "help") {
  console.log(usage(usageDefault));
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`${parsed.message}\n\n${usage(usageDefault)}`);
  process.exit(1);
}
const { command, resume, profile: profileFlag } = parsed.args;

const runtime = defaultRuntime;
const dataDir = process.env.MINERVA_DATA_DIR ?? defaultDataDir(runtime);
const cwd = process.cwd();

function fail(cause: unknown): never {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}

function storedKeys(settings: ResolvedSettings): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(settings.providers).map(([name, entry]) => [name, entry.apiKey]),
  );
}

let settings: ResolvedSettings;
let registry: ReturnType<typeof buildProviderRegistry>;
try {
  settings = await loadSettings(runtime, dataDir, cwd);
  registry = buildProviderRegistry(settings.providers);
} catch (cause) {
  fail(cause);
}

// Validate the requested profile up front — a typo should fail before any
// session exists, not on the first prompt.
const activeProfile = profileFlag ?? settings.profile ?? null;
if (activeProfile !== null && !settings.profiles[activeProfile]) {
  const defined = Object.keys(settings.profiles).join(", ") || "(none)";
  fail(new Error(`unknown profile "${activeProfile}" — defined: ${defined}`));
}

// Precedence: --model flag > MINERVA_MODEL > profile's model > settings > default.
const model =
  parsed.args.model ??
  process.env.MINERVA_MODEL ??
  (activeProfile ? settings.profiles[activeProfile]?.model : undefined) ??
  settings.model ??
  DEFAULT_ANTHROPIC_MODEL;

let providerName: string;
try {
  providerName = parseModelRef(model, registry).provider;
} catch (cause) {
  fail(cause);
}
const apiKey = resolveApiKey(providerName, registry, {
  env: process.env,
  storedKeys: storedKeys(settings),
});
// Keyless endpoints (requiresApiKey: false, e.g. local servers) must not be
// forced into setup — only gate on a missing key when one is actually needed.
const missingRequiredKey = !apiKey && registry[providerName]?.requiresApiKey !== false;

/**
 * Host-injected factory for minerva/config/set_model. Re-reads settings so
 * a key or provider the config panel just persisted is picked up.
 */
const resolveProvider = async (modelRef: string): Promise<ModelProvider> => {
  const latest = await loadSettings(runtime, dataDir, cwd);
  const providers = buildProviderRegistry(latest.providers);
  const ref = parseModelRef(modelRef, providers);
  const key = resolveApiKey(ref.provider, providers, {
    env: process.env,
    storedKeys: storedKeys(latest),
  });
  return createProviderFromRef(modelRef, { providers, ...(key ? { apiKey: key } : {}) });
};

const kernelOptions = {
  provider: createProviderFromRef(model, {
    providers: registry,
    ...(apiKey ? { apiKey } : {}),
  }),
  resolveProvider,
  dataDir,
};

function requireKeyOrExit(): void {
  if (!missingRequiredKey) return;
  const keyVar = apiKeyEnvVar(providerName, registry);
  console.error(`${keyVar} is not set (required for ${model}). Export it and try again:`);
  console.error(`  export ${keyVar}="..."`);
  console.error("or run `minerva` and use /config to store a key in settings.");
  process.exit(1);
}

if (command === "acp") {
  // stdout carries the protocol — no UI, so a missing key stays a hard exit
  // unless a GUI host asked to drive configuration over the protocol.
  if (!parsed.args.allowUnconfigured) requireKeyOrExit();
  // runAcpHost awaits kernel.close() on disconnect; a durability failure
  // surfaces here as a nonzero exit rather than a silent success.
  try {
    await runAcpHost(kernelOptions);
    process.exit(0);
  } catch (error) {
    console.error(`minerva: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (parsed.args.print) {
  // One-shot output — no UI, so a missing key is a hard exit like acp.
  requireKeyOrExit();
  let promptText = parsed.args.print.prompt;
  if (promptText === null) {
    // -p with no inline prompt reads stdin, but only when something is
    // actually piped in — headlessly waiting on a TTY would just hang.
    if (process.stdin.isTTY) {
      fail(new Error("-p/--print needs a prompt argument or piped stdin"));
    }
    promptText = await Bun.stdin.text();
  }
  if (!promptText.trim()) fail(new Error("empty prompt"));
  const code = await runPrintMode({
    kernelOptions,
    cwd,
    prompt: promptText.trim(),
    mode: parsed.args.mode,
    profile: profileFlag,
    resume,
    io: { stdout: process.stdout, stderr: process.stderr },
  });
  process.exit(code);
}

// Rows for the /config panel — providerKeyStatuses is the shared policy
// home, also consumed by the kernel's minerva/config/state for the GUI.
const providerChoices: ProviderChoice[] = providerKeyStatuses(
  registry,
  process.env,
  storedKeys(settings),
);

// Input history is frontend-local state (like Ink itself), so it lives here
// rather than behind the protocol: one JSONL file per data dir, best-effort,
// compacted at load when it grows past its threshold.
const historyPath = join(dataDir, "history.jsonl");

// The CLI embeds the kernel, but only across the protocol's in-proc
// transport — the same messages a Tauri sidecar or remote kernel would see.
const [clientTransport, kernelTransport] = createInProcTransportPair();
const kernel = createKernel(kernelTransport, kernelOptions);

const bridge = createPermissionBridge();
const client = new MinervaClient(clientTransport, {
  onPermissionRequest: bridge.onPermissionRequest,
});

const app = render(
  <App
    client={client}
    bridge={bridge}
    model={model}
    cwd={cwd}
    resume={resume}
    profile={profileFlag}
    providers={providerChoices}
    needsConfig={missingRequiredKey}
    initialHistory={loadHistoryFile(historyPath)}
    onHistoryAppend={(text) => appendHistoryFile(historyPath, text)}
  />,
);
await app.waitUntilExit();
// Flush session logs and close MCP before exiting, or the fire-and-forget
// appends queued after the last turn (e.g. a model switch) can be lost. A
// durability failure exits nonzero so the loss isn't silent.
// Ink unmounts but stdin's raw-mode listener keeps the runtime alive.
try {
  await kernel.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(`minerva: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
