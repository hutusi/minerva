import type {
  ConfigProviderState,
  ConfigSetModelParams,
  ConfigStateResult,
} from "@minerva/protocol";
import { useMemo, useState } from "react";

const CUSTOM = "custom…";

function keyHint(provider: ConfigProviderState | undefined): string {
  if (!provider) return "";
  if (provider.requiresApiKey === false) return "no key needed for this endpoint";
  switch (provider.keySource) {
    case "env":
      return `key found in ${provider.keyVar} — leave blank to keep it`;
    case "settings":
      return "a key is stored in settings — leave blank to keep it";
    default:
      return `no key found (checked ${provider.keyVar} and settings)`;
  }
}

/**
 * Provider/key/model form, mirroring the TUI's /config panel over the same
 * protocol call (minerva/config/set_model). One screen instead of wizard
 * steps — a GUI can show all three decisions at once.
 */
export function ConfigDialog({
  state,
  onSubmit,
  onClose,
}: {
  state: ConfigStateResult;
  /** Persist + hot-swap. Rejections render inline; the dialog stays open. */
  onSubmit: (params: ConfigSetModelParams) => Promise<void>;
  /** Absent on first run: there is nothing to fall back to yet. */
  onClose?: (() => void) | undefined;
}) {
  const currentProvider = state.model.includes("/") ? state.model.split("/")[0] : "anthropic";
  const names = state.providers.map((p) => p.name);
  const [providerName, setProviderName] = useState(
    currentProvider && names.includes(currentProvider) ? currentProvider : (names[0] ?? CUSTOM),
  );
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const selected = useMemo(
    () => state.providers.find((p) => p.name === providerName),
    [state.providers, providerName],
  );
  const [model, setModel] = useState(() =>
    currentProvider === providerName ? (state.model.split("/")[1] ?? "") : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustom = providerName === CUSTOM;
  const effectiveName = isCustom ? customName.trim() : providerName;
  const effectiveModel = model.trim() || selected?.defaultModel || "";
  const canSubmit =
    !busy &&
    effectiveName.length > 0 &&
    effectiveModel.length > 0 &&
    (!isCustom || customBaseUrl.trim());

  const submit = () => {
    if (!canSubmit) return;
    const modelRef = effectiveModel.includes("/")
      ? effectiveModel
      : `${effectiveName}/${effectiveModel}`;
    const key = apiKey.trim();
    const params: ConfigSetModelParams = {
      modelRef,
      ...(isCustom ? { provider: { name: effectiveName, baseUrl: customBaseUrl.trim() } } : {}),
      ...(key ? { apiKey: key } : {}),
    };
    setBusy(true);
    setError(null);
    onSubmit(params)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-md rounded-lg border bg-popover p-5 text-popover-foreground shadow-lg">
        <div className="text-sm font-semibold">Model &amp; provider</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          current: {state.model} · stored in ~/.minerva/settings.json
        </div>

        <label className="mt-4 block text-xs font-medium" htmlFor="cfg-provider">
          Provider
        </label>
        <select
          id="cfg-provider"
          value={providerName}
          onChange={(event) => {
            setProviderName(event.target.value);
            setModel("");
          }}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        >
          {state.providers.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.keySource !== "none" ? " ✓" : ""}
            </option>
          ))}
          <option value={CUSTOM}>{CUSTOM}</option>
        </select>

        {isCustom ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium" htmlFor="cfg-name">
                Name
              </label>
              <input
                id="cfg-name"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="my-endpoint"
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium" htmlFor="cfg-baseurl">
                Base URL
              </label>
              <input
                id="cfg-baseurl"
                value={customBaseUrl}
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                placeholder="https://…/v1"
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        ) : null}

        <label className="mt-3 block text-xs font-medium" htmlFor="cfg-key">
          API key
        </label>
        <input
          id="cfg-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-…"
          className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <div className="mt-1 text-xs text-muted-foreground">{keyHint(selected)}</div>

        <label className="mt-3 block text-xs font-medium" htmlFor="cfg-model">
          Model
        </label>
        <input
          id="cfg-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={selected?.defaultModel ?? "model id"}
          list="cfg-model-options"
          className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        <datalist id="cfg-model-options">
          {(selected?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        {error ? <div className="mt-3 text-xs text-destructive">✖ {error}</div> : null}

        <div className="mt-4 flex justify-end gap-2">
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save & use"}
          </button>
        </div>
      </div>
    </div>
  );
}
