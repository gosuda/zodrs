import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(scriptDir, "../../../crates/zodrs-node");
const outputDir = resolve(scriptDir, "../native");

const target = process.env.NAPI_TARGET || process.argv[2];
if (!target) {
  process.stderr.write(
    "build:native:target: set NAPI_TARGET=<rust-triple> or pass one as an argument\n",
  );
  process.exit(1);
}

const crossCompileValue = process.env.NAPI_CROSS_COMPILE;
if (
  crossCompileValue !== undefined &&
  !["0", "1", "false", "true"].includes(crossCompileValue)
) {
  process.stderr.write(
    `build:native:target: NAPI_CROSS_COMPILE must be one of 0, 1, false, or true; received ${JSON.stringify(crossCompileValue)}\n`,
  );
  process.exit(2);
}
const crossCompile =
  crossCompileValue === "1" ||
  crossCompileValue === "true" ||
  process.argv.includes("--cross-compile");

const args = ["build", "--platform", "--release", "--target", target];
if (crossCompile) args.push("--cross-compile");
args.push("--output-dir", outputDir);

const napiEntry = resolve(scriptDir, "../node_modules/@napi-rs/cli/dist/cli.js");
const result = spawnSync(process.execPath, [napiEntry, ...args], {
  cwd: crateDir,
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`build:native:target: failed to launch napi: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
