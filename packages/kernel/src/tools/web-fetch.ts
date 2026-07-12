import { loadSettings } from "../settings";
import { truncateCodePointSafe } from "../text";
import { assertPublicHost, type LookupFn, PrivateHostError } from "./net-guard";
import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

/**
 * Bounded, permission-gated HTTP GET. Deliberately NOT readOnly: network
 * egress can exfiltrate context through the URL and pulls untrusted text
 * into the prompt, so it must never ride the read-only auto-allow — default
 * mode always prompts with the URL, and deny/allow rules match it
 * (`web_fetch(https://example.com/*)`).
 *
 * SSRF stance: hosts that are (or resolve to) private/loopback addresses are
 * refused by default — the check runs on the initial URL and on every
 * redirect hop, so a public page can't bounce the fetch to a metadata
 * endpoint. `{ "webFetch": { "allowPrivate": true } }` in settings lifts it
 * (localhost development). This is friction against ACCIDENTAL SSRF-shaped
 * fetches, same posture as the bash rules (see permissions.ts), not a
 * sandbox: fetch re-resolves DNS after the check, so a rebinding race
 * between check and connect remains possible.
 */

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** The DNS seam exists for tests; production uses the default resolver. */
export function createWebFetchTool(options: { lookup?: LookupFn } = {}): KernelTool {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL over HTTP(S) GET and return its textual content. HTML is " +
      "reduced to plain text; JSON, XML, and text/* pass through. Bodies are " +
      "capped at 1 MiB and output at 30000 characters. Hosts on private or " +
      "loopback addresses are refused unless settings permit them.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch" },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default 30000, max 120000)",
        },
      },
      required: ["url"],
    },
    kind: "fetch",
    readOnly: false,
    title(input) {
      return requireString(asRecord(input), "url");
    },
    async execute(input, context) {
      const record = asRecord(input);
      const rawUrl = requireString(record, "url");
      const timeoutMs =
        typeof record.timeout_ms === "number" &&
        Number.isFinite(record.timeout_ms) &&
        record.timeout_ms > 0
          ? Math.min(record.timeout_ms, MAX_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS;

      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { output: `invalid URL: ${rawUrl}`, isError: true };
      }
      if (!isHttpScheme(url)) {
        return { output: `only http(s) URLs are supported: ${rawUrl}`, isError: true };
      }
      // No dataDir (direct-call tests) means no settings — the guard stays on.
      const allowPrivate =
        context.dataDir !== undefined &&
        (await loadSettings(context.runtime, context.dataDir, context.cwd)).webFetch
          .allowPrivate === true;

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;

      try {
        if (!allowPrivate) await assertPublicHost(url, options.lookup);
        // Manual redirects: each hop's scheme and host are re-checked, so a
        // redirect to file:// or into a private range can't slip past the
        // initial validation, and an unbounded loop is cut off.
        let response = await fetch(url, { redirect: "manual", signal });
        for (let hops = 0; isRedirect(response.status); hops++) {
          if (hops >= MAX_REDIRECTS) {
            await response.body?.cancel();
            return { output: `too many redirects (limit ${MAX_REDIRECTS})`, isError: true };
          }
          const location = response.headers.get("location");
          if (!location) break; // 3xx without a target — treat as the final response
          await response.body?.cancel();
          url = new URL(location, url);
          if (!isHttpScheme(url)) {
            return { output: `redirect to unsupported scheme: ${url.href}`, isError: true };
          }
          if (!allowPrivate) await assertPublicHost(url, options.lookup);
          response = await fetch(url, { redirect: "manual", signal });
        }

        const contentType = response.headers.get("content-type") ?? "";
        const kind = classifyContentType(contentType);
        if (kind === "binary") {
          await response.body?.cancel();
          return {
            output: `unsupported content-type: ${contentType} — web_fetch handles text, JSON, XML, and HTML`,
            isError: true,
          };
        }
        const { text, truncated } = await readBounded(response, MAX_BODY_BYTES);
        const content = kind === "html" ? htmlToText(text) : text;
        const header = response.ok ? "" : `[HTTP ${response.status}]\n`;
        let output = `${header}${content}`;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${truncateCodePointSafe(output, MAX_OUTPUT_CHARS)}\n[truncated at ${MAX_OUTPUT_CHARS} characters]`;
        } else if (truncated) {
          output += `\n[body truncated at ${MAX_BODY_BYTES} bytes]`;
        }
        return { output, isError: !response.ok };
      } catch (error) {
        if (error instanceof PrivateHostError) {
          return {
            output:
              `refused: ${error.message} — set { "webFetch": { "allowPrivate": true } } ` +
              "in settings to permit fetching private hosts",
            isError: true,
          };
        }
        if (timeout.aborted) {
          return { output: `fetch timed out after ${timeoutMs}ms: ${url.href}`, isError: true };
        }
        return {
          output: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

export const webFetchTool: KernelTool = createWebFetchTool();

function isHttpScheme(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function classifyContentType(contentType: string): "html" | "text" | "binary" {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime.includes("html")) return "html";
  // No declared type: assume text — the 1 MiB / 30k caps bound the damage.
  if (mime === "") return "text";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) return "text";
  return "binary";
}

/** The subset of ReadableStreamDefaultReader readBounded needs; lets tests
 * drive the exact-boundary paths with a fake reader. */
export interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<unknown>;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };
  return readBoundedFrom(body.getReader(), maxBytes);
}

/** Read at most maxBytes, then cancel whatever remains of the stream. */
export async function readBoundedFrom(
  reader: BodyReader,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      finished = true;
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  // At the cap without EOF: cancel immediately — NEVER read again. A stream
  // sitting exactly at the cap and held open would park a probe read until
  // the overall fetch timeout, turning a fully capped body into a timeout
  // error. The price is a conservative "truncated" label on a body that
  // would have EOF'd exactly at the boundary. (Content-Length can't settle
  // it either: with Content-Encoding it counts compressed bytes while the
  // reader yields decompressed ones.)
  const truncated = !finished;
  if (!finished) await reader.cancel().catch(() => {});
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = merged.length - offset;
    if (room <= 0) break;
    merged.set(room >= chunk.byteLength ? chunk : chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  // TextDecoder replaces a byte sequence torn at the cap — acceptable there.
  return { text: new TextDecoder().decode(merged), truncated };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Hand-rolled HTML → text: scripts/styles/comments dropped, block-level
 * closes become newlines, tags stripped, common entities decoded, blank runs
 * collapsed. Deliberately not a real HTML parser — good enough to read docs
 * and articles without a dependency.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|article|blockquote|pre)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? "")
    .replace(/[ \t\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
