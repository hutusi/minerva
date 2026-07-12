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

const binary = join(dist, process.platform === "win32" ? "minerva.exe" : "minerva");

// Bun's own compile-time signature runs (the 1.3.12 truncation that SIGKILLed
// arm64 binaries was fixed in 1.3.13, oven-sh/bun#29270) but still fails
// `codesign --verify --strict` on 1.3.14. A fresh ad-hoc signature is cheap,
// makes strict verification pass, and is what distribution needs anyway.
if (process.platform === "darwin") {
  const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", binary], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!sign.success) {
    console.error(`ad-hoc signing failed for ${binary}`);
    process.exit(1);
  }
}

// Post-build self-check: actually RUN the binary — and, on macOS, validate
// its signature — so any signing recurrence fails the build loudly instead
// of shipping an artifact that dies on the user's machine.
const versionCheck = Bun.spawnSync([binary, "--version"], { stderr: "inherit" });
const versionOut = versionCheck.stdout.toString().trim();
if (!versionCheck.success || !/\d+\.\d+\.\d+/.test(versionOut)) {
  console.error(
    `self-check failed: ${binary} --version exited ` +
      `${versionCheck.exitCode ?? `signal ${versionCheck.signalCode}`} with output "${versionOut}"`,
  );
  process.exit(1);
}
if (process.platform === "darwin") {
  const codesign = Bun.spawnSync(["codesign", "--verify", "--strict", binary], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!codesign.success) {
    console.error(`self-check failed: codesign rejects ${binary}`);
    process.exit(1);
  }
}
console.log(`self-check passed: ${binary} runs (${versionOut})`);
