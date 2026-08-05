import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Catalyst ships the same UGUI engine projects/ proved out; this projects it
// into the Electron renderer so the desktop shell paints no vocabulary itself.
const REQUIRED_VERSION = "wasm-pack 0.13.1";
const catalystRoot = fileURLToPath(new URL("../../..", import.meta.url));

const version = spawnSync("wasm-pack", ["--version"], {
  cwd: catalystRoot,
  encoding: "utf8",
});
if (version.error || version.status !== 0) {
  console.error("wasm-pack 0.13.1 is required to build the Catalyst UGUI client.");
  process.exit(1);
}
if (version.stdout.trim() !== REQUIRED_VERSION) {
  console.error(
    `Expected ${REQUIRED_VERSION}; found ${version.stdout.trim() || "an unknown version"}.`,
  );
  process.exit(1);
}

const build = spawnSync(
  "wasm-pack",
  [
    "--quiet",
    "build",
    "wasm",
    "--target",
    "web",
    "--release",
    "--out-dir",
    "../apps/desktop/public/wasm",
    "--out-name",
    "catalyst_wasm",
  ],
  { cwd: catalystRoot, stdio: "inherit" },
);
if (build.error || build.status !== 0) {
  process.exit(build.status || 1);
}
console.log("Catalyst UGUI client release projection: ok");
