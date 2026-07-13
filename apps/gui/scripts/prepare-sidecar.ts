/**
 * Prepare the kernel sidecar pair for a packaged GUI build.
 *
 * Runs the repo's release build (the `dist/{minerva, rg}` pair — see
 * scripts/build-release.ts for why the pair is host-only) and copies both
 * into src-tauri/binaries/ with the host target-triple suffix Tauri requires
 * for externalBin sources. At bundle time Tauri strips the suffix and places
 * both next to the app executable (Contents/MacOS/ on macOS), so the kernel's
 * process.execPath sits beside rg and resolveRgPath works unchanged.
 *
 * Only needed before `tauri build`; dev spawns the kernel from source.
 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

const build = Bun.spawnSync(["bun", "run", "build:release"], {
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (!build.success) process.exit(build.exitCode || 1);

// The triple must match what the tauri CLI expects for this host, and rustc
// is authoritative (and always present — tauri build needs it too). Guard
// the whole probe: a missing rustc can throw from spawnSync or leave stdout
// unset, and either must fail with the hint rather than a stack trace.
const triple = (() => {
  try {
    const rustc = Bun.spawnSync(["rustc", "-vV"]);
    if (!rustc.success || !rustc.stdout) return null;
    return (
      rustc.stdout
        .toString()
        .split("\n")
        .find((line) => line.startsWith("host: "))
        ?.slice("host: ".length)
        .trim() ?? null
    );
  } catch {
    return null;
  }
})();
if (!triple) {
  console.error("cannot determine host target triple: is rustc installed?");
  process.exit(1);
}

const binariesDir = join(import.meta.dir, "..", "src-tauri", "binaries");
mkdirSync(binariesDir, { recursive: true });
for (const name of ["minerva", "rg"]) {
  const source = join(repoRoot, "dist", name);
  const dest = join(binariesDir, `${name}-${triple}`);
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
  console.log(`prepared sidecar: ${dest}`);
}
