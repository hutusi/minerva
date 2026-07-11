/**
 * Build the release: a compiled `minerva` plus its ripgrep sidecar — the
 * artifact is the pair `dist/{minerva, rg}` (see resolveRgPath in the kernel).
 *
 * `@vscode/ripgrep` fetches only the *host* platform's rg at install time, so
 * the sidecar can only ever be the host binary. Cross-compiling the executable
 * with a `--target` for another OS/arch would pair it with the wrong rg — a
 * silently broken artifact — so we reject that up front. To produce a native
 * pair for another platform, build on that platform (or in its container).
 *
 * A single script (rather than two `&&`-joined commands) so a forwarded
 * `--target` reaches this parser instead of landing on the copy step.
 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";

function parseTarget(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") return argv[i + 1];
    if (arg?.startsWith("--target=")) return arg.slice("--target=".length);
  }
  return undefined;
}

/** Bun targets look like `bun-<os>-<arch>[-modifier]`, e.g. `bun-darwin-arm64`. */
function platformArchOf(target: string | undefined): { os: string; arch: string } {
  if (!target) return { os: process.platform, arch: process.arch };
  const [osToken, archToken] = target.replace(/^bun-/, "").split("-");
  return { os: osToken === "windows" ? "win32" : (osToken ?? ""), arch: archToken ?? "" };
}

const target = parseTarget(process.argv.slice(2));
const host = platformArchOf(undefined);
const requested = platformArchOf(target);

if (requested.os !== host.os || requested.arch !== host.arch) {
  console.error(
    `Cross-compiling the ripgrep sidecar isn't supported: @vscode/ripgrep ships only the ` +
      `host binary (${host.os}/${host.arch}), but --target=${target} requests ` +
      `${requested.os}/${requested.arch}. Build on the target platform to get a matching ` +
      `minerva + rg pair.`,
  );
  process.exit(1);
}

const buildArgs = [
  "build",
  "--compile",
  "--minify",
  "packages/cli/src/index.tsx",
  "--outfile",
  "dist/minerva",
];
if (target) buildArgs.push("--target", target);

const build = Bun.spawnSync(["bun", ...buildArgs], { stdout: "inherit", stderr: "inherit" });
if (!build.success) process.exit(build.exitCode || 1);

const dist = join(import.meta.dir, "..", "dist");
mkdirSync(dist, { recursive: true });
const dest = join(dist, process.platform === "win32" ? "rg.exe" : "rg");
copyFileSync(rgPath, dest);
chmodSync(dest, 0o755);
console.log(`copied ripgrep → ${dest} (from ${dirname(rgPath)})`);
