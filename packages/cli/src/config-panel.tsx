import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";

/**
 * Interactive provider/model/key setup — opened by /config and on first run
 * when the selected model has no API key. Same inline-replacement pattern as
 * PermissionPrompt: it occupies the input slot, so it can never hide a
 * running turn's permission request.
 */

/** One selectable provider row, precomputed by the entrypoint. */
export interface ProviderChoice {
  name: string;
  defaultModel?: string | undefined;
  /** Env var the provider reads (e.g. DASHSCOPE_API_KEY). */
  keyVar: string;
  /** Where a usable key was found, if anywhere. */
  keySource: "env" | "settings" | "none";
  baseUrl?: string | undefined;
  /** Known model ids — cycled with ↑/↓ at the model step; free text still wins. */
  models?: string[] | undefined;
}

export interface ConfigResult {
  modelRef: string;
  /** Present for newly defined custom providers. */
  provider?: { name: string; baseUrl?: string | undefined };
  /** Omitted when the user kept the existing env/stored key. */
  apiKey?: string;
}

type Step = "provider" | "name" | "baseUrl" | "apiKey" | "model";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function ConfigPanel({
  providers,
  currentModel,
  firstRun,
  onSubmit,
  onCancel,
}: {
  providers: ProviderChoice[];
  currentModel: string;
  firstRun: boolean;
  onSubmit: (result: ConfigResult) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("provider");
  const [index, setIndex] = useState(0);
  // Mirror of `index` that is current within a single input batch: rapid
  // ↓+enter can reach React as one batch, and selecting via the state
  // closure would then pick the previously highlighted row.
  const indexRef = useRef(0);
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = providers.length + 1; // trailing "custom…" row
  const selected = custom ? undefined : providers[index];
  const suggestions = selected?.models ?? [];
  // Position within `suggestions` while cycling; -1 = free text. A ref for
  // the same batching reason as indexRef.
  const suggestionRef = useRef(-1);

  const chooseProvider = (i: number) => {
    setError(null);
    if (i === providers.length) {
      setCustom(true);
      setStep("name");
      return;
    }
    setCustom(false);
    const choice = providers[i];
    if (!choice) return;
    // Re-configuring the current provider keeps its model; otherwise prefill
    // the provider's default.
    const slash = currentModel.indexOf("/");
    const currentProvider = slash === -1 ? "anthropic" : currentModel.slice(0, slash);
    const currentModelId = slash === -1 ? currentModel : currentModel.slice(slash + 1);
    const prefill = currentProvider === choice.name ? currentModelId : (choice.defaultModel ?? "");
    setModel(prefill);
    suggestionRef.current = (choice.models ?? []).indexOf(prefill);
    setStep("apiKey");
  };

  const cycleSuggestion = (delta: number) => {
    if (suggestions.length === 0) return;
    suggestionRef.current =
      suggestionRef.current === -1
        ? delta > 0
          ? 0
          : suggestions.length - 1
        : (suggestionRef.current + suggestions.length + delta) % suggestions.length;
    const next = suggestions[suggestionRef.current];
    if (next !== undefined) setModel(next);
  };

  const stepBack = () => {
    setError(null);
    if (step === "model") setStep("apiKey");
    else if (step === "apiKey") setStep(custom ? "baseUrl" : "provider");
    else if (step === "baseUrl") setStep("name");
    else if (step === "name") setStep("provider");
  };

  const moveIndex = (delta: number) => {
    indexRef.current = (indexRef.current + rows + delta) % rows;
    setIndex(indexRef.current);
  };

  useInput((input, key) => {
    if (saving) return;
    if (step === "provider") {
      if (key.upArrow || input === "k") moveIndex(-1);
      else if (key.downArrow || input === "j") moveIndex(1);
      else if (key.return) chooseProvider(indexRef.current);
      else if (key.escape) onCancel();
      return;
    }
    if (step === "model") {
      if (key.upArrow) cycleSuggestion(-1);
      else if (key.downArrow) cycleSuggestion(1);
    }
    if (key.escape) stepBack();
  });

  const submitName = (value: string) => {
    const trimmed = value.trim();
    if (!NAME_PATTERN.test(trimmed)) {
      setError("provider name must be lowercase letters, digits, and dashes (e.g. deepseek)");
      return;
    }
    if (providers.some((choice) => choice.name === trimmed)) {
      setError(`"${trimmed}" already exists — select it from the list instead`);
      return;
    }
    setError(null);
    setName(trimmed);
    setStep("baseUrl");
  };

  const submitBaseUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed.startsWith("http")) {
      setError("baseUrl must be an http(s) endpoint, e.g. https://api.example.com/v1");
      return;
    }
    setError(null);
    setBaseUrl(trimmed);
    setStep("apiKey");
  };

  const submitApiKey = (value: string) => {
    const trimmed = value.trim();
    // Custom endpoints may be keyless (local servers); known providers need
    // a key from somewhere.
    if (!trimmed && !custom && selected?.keySource === "none") {
      setError(`no existing key for ${selected.name} — enter one`);
      return;
    }
    setError(null);
    setApiKey(trimmed);
    setStep("model");
  };

  const submitModel = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("model id is required (e.g. qwen-plus)");
      return;
    }
    const providerName = custom ? name : (selected?.name ?? "anthropic");
    const result: ConfigResult = {
      modelRef: `${providerName}/${trimmed}`,
      ...(custom ? { provider: { name: providerName, baseUrl } } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      await onSubmit(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        Configure model{custom && name ? ` — ${name}` : selected ? ` — ${selected.name}` : ""}
      </Text>
      {firstRun && step === "provider" ? (
        <Text color="yellow">
          No API key found for {currentModel} — pick a provider to get started.
        </Text>
      ) : null}

      {step === "provider" ? (
        <Box flexDirection="column">
          {providers.map((choice, i) => (
            <Text key={choice.name} {...(i === index ? { color: "cyan" } : {})}>
              {i === index ? "❯ " : "  "}
              {choice.name.padEnd(12)}
              {(choice.defaultModel ?? "").padEnd(22)}
              <Text dimColor>{keyStatus(choice)}</Text>
            </Text>
          ))}
          <Text {...(index === providers.length ? { color: "cyan" } : {})}>
            {index === providers.length ? "❯ " : "  "}custom…{"     "}
            <Text dimColor>add an OpenAI-compatible provider</Text>
          </Text>
          <Text dimColor>↑/↓ select · enter confirm · esc cancel</Text>
        </Box>
      ) : null}

      {step === "name" ? (
        <Box>
          <Text>Provider name: </Text>
          <TextInput value={name} onChange={setName} onSubmit={submitName} placeholder="deepseek" />
        </Box>
      ) : null}

      {step === "baseUrl" ? (
        <Box>
          <Text>Base URL: </Text>
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            onSubmit={submitBaseUrl}
            placeholder="https://api.example.com/v1"
          />
        </Box>
      ) : null}

      {step === "apiKey" ? (
        <Box>
          <Text>API key{selected ? ` ($${selected.keyVar})` : ""}: </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            onSubmit={submitApiKey}
            mask="*"
            placeholder={apiKeyPlaceholder(custom, selected)}
          />
        </Box>
      ) : null}

      {step === "model" ? (
        <Box flexDirection="column">
          <Box>
            <Text>Model id: </Text>
            <TextInput
              value={model}
              onChange={setModel}
              onSubmit={submitModel}
              placeholder={selected?.defaultModel ?? "model-id"}
            />
          </Box>
          {suggestions.length > 0 ? (
            <Text dimColor>known: {suggestions.join(" · ")} (↑/↓ cycle, or type any id)</Text>
          ) : null}
        </Box>
      ) : null}

      {saving ? <Text color="yellow">saving…</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {step !== "provider" && !saving ? <Text dimColor>enter confirm · esc back</Text> : null}
    </Box>
  );
}

function keyStatus(choice: ProviderChoice): string {
  switch (choice.keySource) {
    case "env":
      return `key: env $${choice.keyVar}`;
    case "settings":
      return "key: saved in settings";
    case "none":
      return "no key";
  }
}

function apiKeyPlaceholder(custom: boolean, selected: ProviderChoice | undefined): string {
  if (custom) return "leave empty if the endpoint needs no key";
  if (selected && selected.keySource !== "none") {
    return selected.keySource === "env"
      ? `leave empty to keep using $${selected.keyVar}`
      : "leave empty to keep the saved key";
  }
  return "sk-…";
}
