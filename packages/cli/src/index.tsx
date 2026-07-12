#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

if (command === "acp") {
  // stdout carries the protocol — no UI, so a missing key stays a hard exit.
  if (missingRequiredKey) {
    const keyVar = apiKeyEnvVar(providerName, registry);
    console.error(`${keyVar} is not set (required for ${model}). Export it and try again:`);
    console.error(`  export ${keyVar}="..."`);
    console.error("or run `minerva` and use /config to store a key in settings.");
    process.exit(1);
  }
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

// Input history is frontend-local state (like Ink itself), so it lives here
// rather than behind the protocol: one JSONL file per data dir, best-effort.
const historyPath = join(dataDir, "history.jsonl");
function loadHistory(): string[] {
  try {
    return readFileSync(historyPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as { text?: unknown };
          return typeof parsed.text === "string" ? [parsed.text] : [];
        } catch {
          return []; // torn/foreign line — skip it, keep the rest
        }
      })
      .slice(-500);
  } catch {
    return [];
  }
}
const appendHistory = (text: string) => {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify({ text, at: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
  } catch {
    // History is a convenience; persistence failures must not break input.
  }
};

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
    initialHistory={loadHistory()}
    onHistoryAppend={appendHistory}
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
