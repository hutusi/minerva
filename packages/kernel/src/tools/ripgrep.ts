import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Locate the ripgrep executable. The compiled release ships `rg` alongside the
 * binary (a sidecar), so prefer that; in dev / when node_modules is present,
 * fall back to the `@vscode/ripgrep` resolver. Cached after the first hit.
 */

/**
 * The fs/module seam `locateRg` resolves against. Injected in tests because the
 * compiled binary can't be run locally (it exits 137 on macOS), so the sidecar
 * and not-found branches are otherwise unreachable.
 */
export interface RgEnv {
  /** The running executable — the sidecar is looked up beside it. */
  execPath: string;
  /** Existence probe (the real one is `node:fs` existsSync). */
  exists: (path: string) => boolean;
  /** Resolve `@vscode/ripgrep`'s rgPath, or undefined if it isn't installed. */
  importRgPath: () => Promise<string | undefined>;
}

const realEnv: RgEnv = {
  execPath: process.execPath,
  exists: existsSync,
  importRgPath: async () => {
    try {
      return (await import("@vscode/ripgrep")).rgPath;
    } catch {
      // @vscode/ripgrep isn't resolvable (e.g. a stripped release) — no path.
      return undefined;
    }
  },
};

/** Resolve rg against an injectable seam. Pure branch logic, no caching. */
export async function locateRg(env: RgEnv): Promise<string> {
  // 1. Sidecar next to the running executable (the release copies dist/rg).
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const sidecar = join(dirname(env.execPath), binaryName);
  if (env.exists(sidecar)) return sidecar;

  // 2. Development / node_modules present: the platform binary @vscode/ripgrep
  //    resolves. (In a distributed single binary this path doesn't exist, so
  //    the sidecar above is what a release relies on.)
  const rgPath = await env.importRgPath();
  if (rgPath && env.exists(rgPath)) return rgPath;

  throw new Error(
    "ripgrep (rg) was not found: expected it beside the minerva executable or via @vscode/ripgrep",
  );
}

let cached: string | undefined;

export async function resolveRgPath(): Promise<string> {
  if (cached) return cached;
  cached = await locateRg(realEnv);
  return cached;
}
