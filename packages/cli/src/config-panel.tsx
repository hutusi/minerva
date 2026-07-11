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
  /** Known model ids — offered as a select list at the model step; the
   *  trailing "other…" row still accepts any id as free text. */
  models?: string[] | undefined;
  /** false = keyless endpoint; an empty key entry is fine, not a gap. */
  requiresApiKey?: boolean | undefined;
}

export interface ConfigResult {
  modelRef: string;
  /** Present for newly defined custom providers. */
  provider?: { name: string; baseUrl?: string | undefined; requiresApiKey?: boolean };
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
  // Model-step list highlight (same ref-mirror pattern as indexRef).
  const [modelIndex, setModelIndex] = useState(0);
  const modelIndexRef = useRef(0);
  const modelRows = suggestions.length + 1; // trailing "other…" row
  // Free-text entry: always for providers without a models list; opt-in via
  // the "other…" row when there is one.
  const [modelFreeText, setModelFreeText] = useState(false);
  const modelList = step === "model" && suggestions.length > 0 && !modelFreeText;

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
    const known = (choice.models ?? []).indexOf(prefill);
    modelIndexRef.current = known === -1 ? 0 : known;
    setModelIndex(modelIndexRef.current);
    setModelFreeText(false);
    setStep("apiKey");
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

  const moveModelIndex = (delta: number) => {
    modelIndexRef.current = (modelIndexRef.current + modelRows + delta) % modelRows;
    setModelIndex(modelIndexRef.current);
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
    if (modelList) {
      if (key.upArrow || input === "k") moveModelIndex(-1);
      else if (key.downArrow || input === "j") moveModelIndex(1);
      else if (key.return) {
        const i = modelIndexRef.current;
        if (i === suggestions.length) {
          // "other…" — hand over to free text; keep the draft only when it
          // isn't just the highlighted suggestion.
          if (suggestions.includes(model)) setModel("");
          setModelFreeText(true);
        } else {
          const value = suggestions[i];
          if (value !== undefined) {
            setModel(value);
            void submitModel(value);
          }
        }
      } else if (key.escape) stepBack();
      return;
    }
    if (key.escape) {
      // esc from free text returns to the model list when there is one.
      if (step === "model" && modelFreeText && suggestions.length > 0) {
        setError(null);
        setModelFreeText(false);
      } else {
        stepBack();
      }
    }
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
    // Custom and keyless endpoints may go without; other known providers
    // need a key from somewhere.
    if (
      !trimmed &&
      !custom &&
      selected?.keySource === "none" &&
      selected.requiresApiKey !== false
    ) {
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
      // Persist keylessness with the definition, or the next startup would
      // demand the key this endpoint doesn't have.
      ...(custom
        ? { provider: { name: providerName, baseUrl, requiresApiKey: apiKey !== "" } }
        : {}),
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
        Configure model
        {step === "provider"
          ? ""
          : custom && name
            ? ` — ${name}`
            : selected
              ? ` — ${selected.name}`
              : ""}
      </Text>
      {firstRun && step === "provider" ? (
        <Text color="yellow">
          No API key found for {currentModel} — pick a provider to get started.
        </Text>
      ) : null}

      {step === "provider" ? (
        <Box flexDirection="column">
          {providers.map((choice, i) => (
            <Box key={choice.name} flexDirection="column">
              <Text {...(i === index ? { color: "cyan" } : {})}>
                {i === index ? "❯ " : "  "}
                {choice.name.padEnd(12)}
                <Text dimColor>{keyStatus(choice)}</Text>
              </Text>
              <Text dimColor>
                {"              "}
                {modelsLine(choice)}
              </Text>
            </Box>
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

      {modelList ? (
        <Box flexDirection="column">
          {suggestions.map((id, i) => (
            <Text key={id} {...(i === modelIndex ? { color: "cyan" } : {})}>
              {i === modelIndex ? "❯ " : "  "}
              {id}
              {id === selected?.defaultModel ? <Text dimColor> (default)</Text> : null}
            </Text>
          ))}
          <Text {...(modelIndex === suggestions.length ? { color: "cyan" } : {})}>
            {modelIndex === suggestions.length ? "❯ " : "  "}other…{"  "}
            <Text dimColor>type a model id</Text>
          </Text>
        </Box>
      ) : null}

      {step === "model" && !modelList ? (
        <Box>
          <Text>Model id: </Text>
          <TextInput
            value={model}
            onChange={setModel}
            onSubmit={submitModel}
            placeholder={selected?.defaultModel ?? "model-id"}
          />
        </Box>
      ) : null}

      {saving ? <Text color="yellow">saving…</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {step !== "provider" && !saving ? (
        <Text dimColor>
          {modelList ? "↑/↓ select · enter save · esc back" : "enter confirm · esc back"}
        </Text>
      ) : null}
    </Box>
  );
}

/** All of a provider's known models, so the list doesn't read as one-model-per-provider. */
function modelsLine(choice: ProviderChoice): string {
  if (choice.models && choice.models.length > 0) return choice.models.join(" · ");
  return choice.defaultModel ?? "any model id";
}

function keyStatus(choice: ProviderChoice): string {
  switch (choice.keySource) {
    case "env":
      return `key: env $${choice.keyVar}`;
    case "settings":
      return "key: saved in settings";
    case "none":
      return choice.requiresApiKey === false ? "no key required" : "no key";
  }
}

function apiKeyPlaceholder(custom: boolean, selected: ProviderChoice | undefined): string {
  if (custom) return "leave empty if the endpoint needs no key";
  if (selected?.requiresApiKey === false && selected.keySource === "none") {
    return "leave empty — this endpoint needs no key";
  }
  if (selected && selected.keySource !== "none") {
    return selected.keySource === "env"
      ? `leave empty to keep using $${selected.keyVar}`
      : "leave empty to keep the saved key";
  }
  return "sk-…";
}
