import { access, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageDir, "../..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(`Artifact verification failed: ${message}`);
}

async function requireFile(path, producer) {
  try {
    await access(path);
    const metadata = await stat(path);
    assert(metadata.isFile() && metadata.size > 0, `${path} is empty; run ${producer}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Artifact verification failed:")) throw error;
    throw new Error(`Artifact verification failed: missing ${path}; run ${producer}`, { cause: error });
  }
}

const sourceManifestPath = resolve(repoRoot, "crates/zodrs-node/package.json");
const mainManifestPath = resolve(packageDir, "package.json");
const nativeManifestPath = resolve(packageDir, "native/package.json");
const wasmManifestPath = resolve(packageDir, "wasm/package.json");
const cargoManifestPath = resolve(repoRoot, "Cargo.toml");

const [sourceManifest, mainManifest, nativeManifest, wasmManifest, cargoManifest] = await Promise.all([
  readJson(sourceManifestPath),
  readJson(mainManifestPath),
  readJson(nativeManifestPath),
  readJson(wasmManifestPath),
  readFile(cargoManifestPath, "utf8"),
]);

const workspacePackage = cargoManifest.match(/\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
const cargoVersion = workspacePackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert(cargoVersion !== undefined, `${cargoManifestPath} has no workspace package version`);
assert(sourceManifest.name === "zod-rs-node", `${sourceManifestPath} name must be zod-rs-node`);
assert(sourceManifest.version === cargoVersion, `${sourceManifestPath} version must equal Cargo workspace version ${cargoVersion}`);
assert(sourceManifest.napi?.binaryName === "zodrs_node", `${sourceManifestPath} binaryName must be zodrs_node`);
assert(
  JSON.stringify(sourceManifest.napi?.targets) === JSON.stringify(["x86_64-unknown-linux-gnu", "wasm32-wasip1-threads"]),
  `${sourceManifestPath} must advertise only the Linux x64 GNU and WASM release targets`,
);

assert(mainManifest.version === cargoVersion, `${mainManifestPath} version must equal ${cargoVersion}`);
assert(mainManifest.publishConfig?.name === "zod-rs", `${mainManifestPath} must publish as zod-rs`);
assert(mainManifest.napi === undefined, `${mainManifestPath} must not duplicate N-API metadata`);
assert(nativeManifest.name === sourceManifest.name, `${nativeManifestPath} name must match ${sourceManifest.name}`);
assert(nativeManifest.version === cargoVersion, `${nativeManifestPath} version must equal ${cargoVersion}`);
assert(nativeManifest.type === undefined, `${nativeManifestPath} must remain CommonJS by omitting type`);
assert(nativeManifest.napi === undefined, `${nativeManifestPath} must not duplicate N-API metadata`);
assert(wasmManifest.name === `${sourceManifest.name}-wasm32-wasi`, `${wasmManifestPath} has the wrong generated package name`);
assert(wasmManifest.version === cargoVersion, `${wasmManifestPath} version must equal ${cargoVersion}`);
assert(wasmManifest.napi === undefined, `${wasmManifestPath} must not duplicate N-API metadata`);

const requiredFiles = [
  ["native/index.js", "pnpm run build:native"],
  ["native/index.d.ts", "pnpm run build:native"],
  ["native/zodrs_node.linux-x64-gnu.node", "pnpm run build:native"],
  ["wasm/index.js", "pnpm run build:wasm"],
  ["wasm/index.d.ts", "pnpm run build:wasm"],
  ["wasm/zodrs_node.wasi.cjs", "pnpm run build:wasm"],
  ["wasm/zodrs_node.wasi.d.cts", "pnpm run build:wasm"],
  ["wasm/zodrs_node.wasm32-wasi.wasm", "pnpm run build:wasm"],
];
await Promise.all(requiredFiles.map(([path, producer]) => requireFile(resolve(packageDir, path), producer)));

const debugWasm = resolve(packageDir, "wasm/zodrs_node.wasm32-wasi.debug.wasm");
try {
  await access(debugWasm);
  throw new Error(`Artifact verification failed: remove debug artifact ${debugWasm}; run pnpm run build:wasm`);
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Artifact verification failed:")) throw error;
}

const [nativeLoader, wasmLoader] = await Promise.all([
  readFile(resolve(packageDir, "native/index.js"), "utf8"),
  readFile(resolve(packageDir, "wasm/zodrs_node.wasi.cjs"), "utf8"),
]);
assert(nativeLoader.includes(`${sourceManifest.name}-linux-x64-gnu`), "native loader fallback package name does not match N-API metadata");
assert(nativeLoader.includes(`expected ${cargoVersion}`), "native loader version check does not match release metadata");
assert(wasmLoader.includes("zodrs_node.wasm32-wasi.wasm"), "WASM loader does not reference the release WASM artifact");

const files = new Set(mainManifest.files);
for (const exclusion of [
  "!dist/**/*.test.*",
  "!dist/**/*.selftest.*",
  "!dist-cjs/**/*.test.*",
  "!dist-cjs/**/*.selftest.*",
  "!wasm/*.debug.wasm",
]) {
  assert(files.has(exclusion), `${mainManifestPath} must exclude ${exclusion}`);
}

process.stdout.write(`Verified zod-rs ${cargoVersion}: Linux x64 GNU native and WASM release artifacts are coherent.\n`);
