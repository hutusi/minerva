import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Locate the ripgrep executable. The compiled release ships `rg` alongside the
 * binary (a sidecar), so prefer that; in dev / when node_modules is present,
 * fall back to the `@vscode/ripgrep` resolver. Cached after the first hit.
 */
let cached: string | undefined;

export async function resolveRgPath(): Promise<string> {
  if (cached) return cached;

  // 1. Sidecar next to the running executable (the release copies dist/rg).
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const sidecar = join(dirname(process.execPath), binaryName);
  if (existsSync(sidecar)) {
    cached = sidecar;
    return sidecar;
  }

  // 2. Development / node_modules present: the platform binary @vscode/ripgrep
  //    resolves. (In a distributed single binary this path doesn't exist, so
  //    the sidecar above is what a release relies on.)
  try {
    const { rgPath } = await import("@vscode/ripgrep");
    if (rgPath && existsSync(rgPath)) {
      cached = rgPath;
      return rgPath;
    }
  } catch {
    // @vscode/ripgrep isn't resolvable (e.g. a stripped release) — fall through.
  }

  throw new Error(
    "ripgrep (rg) was not found: expected it beside the minerva executable or via @vscode/ripgrep",
  );
}
