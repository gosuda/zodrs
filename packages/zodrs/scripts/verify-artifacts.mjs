import { access, readFile, readdir, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageDir, "../..");
const npmDir = resolve(packageDir, "npm");

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

/**
 * The full target matrix advertised in `crates/zodrs-node/package.json` under
 * `napi.targets`: eight native triples plus the WASM tier.  The order matches
 * the committed manifest so a deep-equal check catches accidental reordering.
 */
const EXPECTED_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "wasm32-wasip1-threads",
];

/**
 * The eight native platform packages.  Each maps a Rust target triple to the
 * napi-generated npm sub-package directory, its published name, the `os`/`cpu`
 * (and `libc` for Linux) fields napi writes, and the `.node` filename the
 * loader expects.  The WASM tier is intentionally absent: it is embedded in the
 * main package, not published as a platform package.
 */
const PLATFORM_PACKAGES = [
  { triple: "x86_64-unknown-linux-gnu", dir: "linux-x64-gnu", name: "zod-rs-node-linux-x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"], nodeFile: "zodrs_node.linux-x64-gnu.node" },
  { triple: "aarch64-unknown-linux-gnu", dir: "linux-arm64-gnu", name: "zod-rs-node-linux-arm64-gnu", os: ["linux"], cpu: ["arm64"], libc: ["glibc"], nodeFile: "zodrs_node.linux-arm64-gnu.node" },
  { triple: "x86_64-unknown-linux-musl", dir: "linux-x64-musl", name: "zod-rs-node-linux-x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"], nodeFile: "zodrs_node.linux-x64-musl.node" },
  { triple: "aarch64-unknown-linux-musl", dir: "linux-arm64-musl", name: "zod-rs-node-linux-arm64-musl", os: ["linux"], cpu: ["arm64"], libc: ["musl"], nodeFile: "zodrs_node.linux-arm64-musl.node" },
  { triple: "x86_64-apple-darwin", dir: "darwin-x64", name: "zod-rs-node-darwin-x64", os: ["darwin"], cpu: ["x64"], nodeFile: "zodrs_node.darwin-x64.node" },
  { triple: "aarch64-apple-darwin", dir: "darwin-arm64", name: "zod-rs-node-darwin-arm64", os: ["darwin"], cpu: ["arm64"], nodeFile: "zodrs_node.darwin-arm64.node" },
  { triple: "x86_64-pc-windows-msvc", dir: "win32-x64-msvc", name: "zod-rs-node-win32-x64-msvc", os: ["win32"], cpu: ["x64"], nodeFile: "zodrs_node.win32-x64-msvc.node" },
  { triple: "aarch64-pc-windows-msvc", dir: "win32-arm64-msvc", name: "zod-rs-node-win32-arm64-msvc", os: ["win32"], cpu: ["arm64"], nodeFile: "zodrs_node.win32-arm64-msvc.node" },
];

/**
 * Determine the napi platform suffix for the current host so we can require the
 * one `.node` file a developer machine actually builds.  Mirrors the musl
 * detection the generated `native/index.js` uses.
 */
function hostPlatformSuffix() {
  const { platform, arch } = process;
  const archName = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (archName === null) return null;
  if (platform === "darwin") return `darwin-${archName}`;
  if (platform === "win32") return `win32-${archName}-msvc`;
  if (platform === "linux") {
    let musl = false;
    try {
      musl = readFileSync("/usr/bin/ldd", "utf-8").includes("musl");
    } catch {
      try {
        musl = execSync("ldd --version", { encoding: "utf8" }).includes("musl");
      } catch {
        musl = false;
      }
    }
    return `linux-${archName}-${musl ? "musl" : "gnu"}`;
  }
  return null;
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

// --- Source manifest (crates/zodrs-node) ---
assert(sourceManifest.name === "zod-rs-node", `${sourceManifestPath} name must be zod-rs-node`);
assert(sourceManifest.version === cargoVersion, `${sourceManifestPath} version must equal Cargo workspace version ${cargoVersion}`);
assert(sourceManifest.napi?.binaryName === "zodrs_node", `${sourceManifestPath} binaryName must be zodrs_node`);
assert(
  JSON.stringify(sourceManifest.napi?.targets) === JSON.stringify(EXPECTED_TARGETS),
  `${sourceManifestPath} napi.targets must equal the full cross-platform matrix (8 native triples + wasm32-wasip1-threads)`,
);

// --- Main manifest (packages/zodrs) ---
assert(mainManifest.version === cargoVersion, `${mainManifestPath} version must equal ${cargoVersion}`);
assert(mainManifest.publishConfig?.name === "zod-rs", `${mainManifestPath} must publish as zod-rs`);
assert(mainManifest.napi === undefined, `${mainManifestPath} must not duplicate N-API metadata`);

// optionalDependencies must list exactly the eight native platform packages at the release version.
const optionalDeps = mainManifest.optionalDependencies ?? {};
const expectedOptionalDeps = Object.fromEntries(PLATFORM_PACKAGES.map((p) => [p.name, cargoVersion]));
assert(
  JSON.stringify(optionalDeps) === JSON.stringify(expectedOptionalDeps),
  `${mainManifestPath} optionalDependencies must list exactly the eight native platform packages at version ${cargoVersion}`,
);

// --- Native tier manifest (packages/zodrs/native/package.json) ---
assert(nativeManifest.name === sourceManifest.name, `${nativeManifestPath} name must match ${sourceManifest.name}`);
assert(nativeManifest.version === cargoVersion, `${nativeManifestPath} version must equal ${cargoVersion}`);
assert(nativeManifest.type === undefined, `${nativeManifestPath} must remain CommonJS by omitting type`);
assert(nativeManifest.napi === undefined, `${nativeManifestPath} must not duplicate N-API metadata`);

// --- WASM tier manifest (packages/zodrs/wasm/package.json) ---
assert(wasmManifest.name === `${sourceManifest.name}-wasm32-wasi`, `${wasmManifestPath} has the wrong generated package name`);
assert(wasmManifest.version === cargoVersion, `${wasmManifestPath} version must equal ${cargoVersion}`);
assert(wasmManifest.napi === undefined, `${wasmManifestPath} must not duplicate N-API metadata`);

// --- Platform package directories (packages/zodrs/npm/<dir>) ---
const npmEntries = new Set(await readdir(npmDir, { withFileTypes: true })
  .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
  .catch(() => []));
const expectedDirs = new Set(PLATFORM_PACKAGES.map((p) => p.dir));
for (const dir of expectedDirs) {
  assert(
    npmEntries.has(dir),
    `${npmDir}/${dir} must exist; regenerate with: pnpm exec napi create-npm-dirs --cwd . --package-json-path crates/zodrs-node/package.json --npm-dir packages/zodrs/npm` +
    ` and then re-apply license: MIT and repository metadata to ${npmDir}/${dir}/package.json because create-npm-dirs overwrites package.json`,
  );
}
// Reject stray directories (e.g. a stale wasm32-wasi template).
for (const entry of npmEntries) {
  assert(expectedDirs.has(entry), `${npmDir}/${entry} is not part of the native platform matrix; remove it`);
}

const platformManifests = await Promise.all(
  PLATFORM_PACKAGES.map((pkg) => readJson(resolve(npmDir, pkg.dir, "package.json"))),
);

for (const [index, pkg] of PLATFORM_PACKAGES.entries()) {
  const manifestPath = resolve(npmDir, pkg.dir, "package.json");
  const manifest = platformManifests[index];
  assert(manifest.name === pkg.name, `${manifestPath} name must be ${pkg.name}`);
  assert(manifest.version === cargoVersion, `${manifestPath} version must equal ${cargoVersion}`);
  assert(manifest.license === "MIT", `${manifestPath} license must be MIT`);
  assert(
    manifest.repository?.type === "git",
    `${manifestPath} repository.type must be git`,
  );
  assert(
    manifest.repository?.url === "git+https://github.com/metaphorics/zodrs.git",
    `${manifestPath} repository.url must be git+https://github.com/metaphorics/zodrs.git`,
  );
  assert(
    manifest.repository?.directory === `packages/zodrs/npm/${pkg.dir}`,
    `${manifestPath} repository.directory must be packages/zodrs/npm/${pkg.dir}`,
  );
  assert(JSON.stringify(manifest.os) === JSON.stringify(pkg.os), `${manifestPath} os must be ${JSON.stringify(pkg.os)}`);
  assert(JSON.stringify(manifest.cpu) === JSON.stringify(pkg.cpu), `${manifestPath} cpu must be ${JSON.stringify(pkg.cpu)}`);
  if (pkg.libc) {
    assert(JSON.stringify(manifest.libc) === JSON.stringify(pkg.libc), `${manifestPath} libc must be ${JSON.stringify(pkg.libc)}`);
  } else {
    assert(manifest.libc === undefined, `${manifestPath} must not set libc for ${pkg.dir}`);
  }
  assert(manifest.main === pkg.nodeFile, `${manifestPath} main must be ${pkg.nodeFile}`);
  assert(
    Array.isArray(manifest.files) && manifest.files.includes(pkg.nodeFile),
    `${manifestPath} files must include ${pkg.nodeFile}`,
  );
  assert(
    optionalDeps[pkg.name] === cargoVersion,
    `${mainManifestPath} optionalDependencies must include ${pkg.name}@${cargoVersion}`,
  );
}

// --- Required local artifacts ---
// The loader JS/dts are always generated; the .node is only the host's.
const requiredFiles = [
  ["native/index.js", "pnpm run build:native"],
  ["native/index.d.ts", "pnpm run build:native"],
  ["wasm/index.js", "pnpm run build:wasm"],
  ["wasm/index.d.ts", "pnpm run build:wasm"],
  ["wasm/zodrs_node.wasi.cjs", "pnpm run build:wasm"],
  ["wasm/zodrs_node.wasi.d.cts", "pnpm run build:wasm"],
  ["wasm/zodrs_node.wasm32-wasi.wasm", "pnpm run build:wasm"],
];
await Promise.all(requiredFiles.map(([path, producer]) => requireFile(resolve(packageDir, path), producer)));

const hostSuffix = hostPlatformSuffix();
assert(hostSuffix !== null, `unsupported host platform=${process.platform} arch=${process.arch}; cannot determine which .node to expect`);
const hostNodeFile = PLATFORM_PACKAGES.find((p) => p.dir === hostSuffix)?.nodeFile;
assert(hostNodeFile !== undefined, `no platform package matches host suffix ${hostSuffix}`);
const nativeDir = resolve(packageDir, "native");
const nativeEntries = await readdir(nativeDir, { withFileTypes: true });
const oddNodeEntries = nativeEntries
  .filter((e) => e.name.endsWith(".node") && !e.isFile())
  .map((e) => e.name);
assert(
  oddNodeEntries.length === 0,
  `${nativeDir} contains non-regular .node entries: ${oddNodeEntries.join(", ")}`,
);
const actualNodeFiles = nativeEntries
  .filter((e) => e.isFile() && e.name.endsWith(".node"))
  .map((e) => e.name)
  .toSorted();
assert(
  JSON.stringify(actualNodeFiles) === JSON.stringify([hostNodeFile]),
  `${nativeDir} must contain exactly the host .node file: expected ${hostNodeFile}, found [${actualNodeFiles.join(", ")}]`,
);
await requireFile(resolve(packageDir, "native", hostNodeFile), `pnpm run build:native (host target ${hostSuffix})`);

// --- Debug WASM must be absent ---
const debugWasm = resolve(packageDir, "wasm/zodrs_node.wasm32-wasi.debug.wasm");
try {
  await access(debugWasm);
  throw new Error(`Artifact verification failed: remove debug artifact ${debugWasm}; run pnpm run build:wasm`);
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Artifact verification failed:")) throw error;
}

// --- Loader references ---
const [nativeLoader, wasmLoader] = await Promise.all([
  readFile(resolve(packageDir, "native/index.js"), "utf8"),
  readFile(resolve(packageDir, "wasm/zodrs_node.wasi.cjs"), "utf8"),
]);
// The generated native loader must reference every platform package name so it
// can resolve each one when installed as an optional dependency.
for (const pkg of PLATFORM_PACKAGES) {
  assert(nativeLoader.includes(pkg.name), `native loader (native/index.js) must reference platform package ${pkg.name}`);
}
assert(nativeLoader.includes(`expected ${cargoVersion}`), "native loader version check does not match release metadata");
assert(wasmLoader.includes("zodrs_node.wasm32-wasi.wasm"), "WASM loader does not reference the release WASM artifact");

// --- files exclusions ---
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

process.stdout.write(
  `Verified zod-rs ${cargoVersion}: ${PLATFORM_PACKAGES.length} native platform packages (${hostSuffix} host addon built), WASM release artifacts, and version coherence across the matrix.\n`,
);
