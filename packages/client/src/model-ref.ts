/**
 * The model-ref grammar shared by frontend config UIs: the provider is
 * everything before the FIRST slash, the model everything after — model ids
 * may themselves contain slashes (openrouter-style `meta-llama/llama-3`).
 * Mirrors the provider registry's parseModelRef contract; that function
 * additionally validates against a live registry and stays server-side
 * (the providers package must not enter a webview bundle).
 */
export function splitModelRef(ref: string): { provider: string | null; model: string } {
  const slash = ref.indexOf("/");
  if (slash === -1) return { provider: null, model: ref };
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
