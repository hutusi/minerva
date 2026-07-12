import { lookup } from "node:dns/promises";

/**
 * Private/loopback address guard for web_fetch. Pure address logic plus one
 * injectable DNS seam — no tool or settings imports, so it stays unit-testable
 * without touching the network.
 *
 * Honesty note: fetch() re-resolves the hostname after this check, so a DNS
 * rebinding race between check and connect remains possible. This is friction
 * against accidental SSRF-shaped fetches (cloud metadata endpoints, router
 * admin pages), consistent with the permissions posture — not a sandbox.
 */

/** One resolved address — the subset of dns.LookupAddress the guard needs. */
interface ResolvedAddress {
  address: string;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/** `all: true`: every A/AAAA record is checked — one private record rejects. */
const defaultLookup: LookupFn = (hostname) => lookup(hostname, { all: true });

/** Thrown (only) for a private/loopback verdict, so callers can distinguish
 * a refusal (worth explaining the escape hatch) from a resolution failure. */
export class PrivateHostError extends Error {}

/**
 * Reject a URL whose host is, or resolves to, a private/loopback address.
 * Literal IPs are checked directly (no DNS); hostnames are resolved via
 * `lookupFn` and rejected if ANY returned address is private. A resolution
 * failure also throws (plain Error): fetch would fail on the same name, and
 * failing closed keeps a flaky resolver from skipping the check.
 */
export async function assertPublicHost(
  url: URL,
  lookupFn: LookupFn = defaultLookup,
): Promise<void> {
  const host = url.hostname;
  // WHATWG URL normalizes literals for http(s): 0x7f000001 → 127.0.0.1,
  // [::ffff:10.0.0.1] → [::ffff:a00:1] — so plain dotted-quad and bracketed
  // IPv6 are the only literal shapes that reach us.
  if (parseIpv4(host) !== undefined || host.startsWith("[")) {
    if (isPrivateAddress(host)) {
      throw new PrivateHostError(`${host} is a private/loopback address`);
    }
    return;
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookupFn(host);
  } catch (error) {
    throw new Error(
      `cannot resolve host ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const hit = addresses.find(({ address }) => isPrivateAddress(address));
  if (hit) {
    throw new PrivateHostError(`${host} resolves to a private/loopback address (${hit.address})`);
  }
}

/** True for loopback, RFC1918/ULA, link-local, CGNAT, unspecified, multicast,
 * and reserved ranges — both families; IPv4-mapped IPv6 recurses into the
 * IPv4 check. Unparseable input counts as private (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== undefined) return isPrivateV4(v4);
  const groups = parseIpv6(ip);
  if (groups === undefined) return true;
  return isPrivateV6(groups);
}

function isPrivateV4([a, b]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // "this", RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4
  return false;
}

function isPrivateV6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: (unspecified) and ::1 (loopback).
  if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d — the URL parser stores it hex-grouped.
  if (leadingZero && g5 === 0xffff) {
    return isPrivateV4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  return false;
}

/** Strict dotted-quad only — every other shape was either normalized away by
 * the URL parser or came from the resolver in canonical form. */
function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/** Expand an IPv6 literal (optionally bracketed, optional zone, optional
 * embedded IPv4 tail) into its 8 groups; undefined if malformed. */
function parseIpv6(ip: string): number[] | undefined {
  let host = ip;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (!host.includes(":")) return undefined;

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes the last two groups.
  const lastColon = host.lastIndexOf(":");
  const tail = host.slice(lastColon + 1);
  const tailV4 = tail.includes(".") ? parseIpv4(tail) : undefined;
  if (tail.includes(".") && tailV4 === undefined) return undefined;
  if (tailV4) {
    const [a, b, c, d] = tailV4;
    host = `${host.slice(0, lastColon)}:${hex((a << 8) | b)}:${hex((c << 8) | d)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half === "") return [];
    const groups: number[] = [];
    for (const part of half.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const head = parseHalf(halves[0] ?? "");
  const rest = halves.length === 2 ? parseHalf(halves[1] ?? "") : [];
  if (head === undefined || rest === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return undefined;
  return [...head, ...Array.from({ length: missing }, () => 0), ...rest];
}

function hex(value: number): string {
  return value.toString(16);
}
