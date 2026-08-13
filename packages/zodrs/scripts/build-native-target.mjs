import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(scriptDir, "../../../crates/zodrs-node");
const outputDir = resolve(scriptDir, "../native");

let positionalTarget;
let crossCompileFlag = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--cross-compile") {
    crossCompileFlag = true;
  } else if (arg.startsWith("-")) {
    process.stderr.write(`build:native:target: unknown flag: ${arg}\n`);
    process.exit(2);
  } else if (positionalTarget !== undefined) {
    process.stderr.write(
      `build:native:target: unexpected extra argument: ${arg}\n`,
    );
    process.exit(2);
  } else {
    positionalTarget = arg;
  }
}

const envTarget = process.env.NAPI_TARGET;
if (envTarget !== undefined && positionalTarget !== undefined && envTarget !== positionalTarget) {
  process.stderr.write(
    `build:native:target: NAPI_TARGET=${JSON.stringify(envTarget)} conflicts with positional ${JSON.stringify(positionalTarget)}\n`,
  );
  process.exit(2);
}
const target = envTarget || positionalTarget;
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
  crossCompileFlag;

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
