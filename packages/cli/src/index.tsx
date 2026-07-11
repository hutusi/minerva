#!/usr/bin/env bun
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
  resolveApiKey,
} from "@minerva/providers";
import { render } from "ink";
import { runAcpHost } from "./acp";
import { App } from "./app";
import { parseCliArgs, usage } from "./args";
import type { ProviderChoice } from "./config-panel";
import { createPermissionBridge } from "./permission-bridge";

const usageDefault = process.env.MINERVA_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.kind === "help") {
  console.log(usage(usageDefault));
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`${parsed.message}\n\n${usage(usageDefault)}`);
  process.exit(1);
}
const { command, resume } = parsed.args;

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

// Precedence: --model flag > MINERVA_MODEL > settings > built-in default.
const model =
  parsed.args.model ?? process.env.MINERVA_MODEL ?? settings.model ?? DEFAULT_ANTHROPIC_MODEL;

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

if (command === "acp") {
  // stdout carries the protocol — no UI, so a missing key stays a hard exit.
  if (missingRequiredKey) {
    const keyVar = apiKeyEnvVar(providerName, registry);
    console.error(`${keyVar} is not set (required for ${model}). Export it and try again:`);
    console.error(`  export ${keyVar}="..."`);
    console.error("or run `minerva` and use /config to store a key in settings.");
    process.exit(1);
  }
  await runAcpHost(kernelOptions);
  process.exit(0);
}

// Rows for the /config panel: every registry provider plus where (if
// anywhere) a usable key was found for it.
const providerChoices: ProviderChoice[] = Object.entries(registry).map(([name, def]) => ({
  name,
  defaultModel: def.defaultModel,
  keyVar: def.apiKeyEnv,
  // Blank-aware, matching resolveApiKey — an exported-but-empty env var
  // must not display as a usable key.
  keySource: process.env[def.apiKeyEnv]?.trim()
    ? ("env" as const)
    : settings.providers[name]?.apiKey?.trim()
      ? ("settings" as const)
      : ("none" as const),
  baseUrl: def.baseURL,
  models: def.models,
  requiresApiKey: def.requiresApiKey,
}));

// The CLI embeds the kernel, but only across the protocol's in-proc
// transport — the same messages a Tauri sidecar or remote kernel would see.
const [clientTransport, kernelTransport] = createInProcTransportPair();
createKernel(kernelTransport, kernelOptions);

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
    providers={providerChoices}
    needsConfig={missingRequiredKey}
  />,
);
await app.waitUntilExit();
// Ink unmounts but stdin's raw-mode listener keeps the runtime alive.
process.exit(0);
