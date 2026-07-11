/**
 * Copy the platform ripgrep binary next to the compiled release, so the
 * `minerva` executable finds it as a sidecar (see resolveRgPath). The release
 * artifact is the pair `dist/{minerva, rg}`.
 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";

const dist = join(import.meta.dir, "..", "dist");
mkdirSync(dist, { recursive: true });
const dest = join(dist, process.platform === "win32" ? "rg.exe" : "rg");
copyFileSync(rgPath, dest);
chmodSync(dest, 0o755);
console.log(`copied ripgrep → ${dest} (from ${dirname(rgPath)})`);
