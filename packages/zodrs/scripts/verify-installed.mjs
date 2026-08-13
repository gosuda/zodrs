import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL = "zodrs-verify-installed";
const DEFAULT_EXPECTED_PACKAGE_DIR = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const PLAN =
  '[{"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},{"k":"string","checks":[{"c":"min_length","v":3}]}]';
const INPUT = new TextEncoder().encode('{"a":"abcd"}');
const DEBUG_WASM = "wasm/zodrs_node.wasm32-wasi.debug.wasm";

function isFileMusl(file) {
  return file.includes("libc.musl-") || file.includes("ld-musl-");
}

function isMuslFromFilesystem() {
  try {
    return readFileSync("/usr/bin/ldd", "utf-8").includes("musl");
  } catch {
    return null;
  }
}

function isMuslFromReport() {
  let report = null;
  if (process.report && typeof process.report.getReport === "function") {
    process.report.excludeNetwork = true;
    report = process.report.getReport();
  }
  if (!report) return null;
  if (report.header && report.header.glibcVersionRuntime) return false;
  if (Array.isArray(report.sharedObjects) && report.sharedObjects.some(isFileMusl)) return true;
  return false;
}

function isMuslFromChildProcess() {
  try {
    return execSync("ldd --version", { encoding: "utf8" }).includes("musl");
  } catch {
    return false;
  }
}

function isMusl() {
  let musl = false;
  if (process.platform === "linux") {
    musl = isMuslFromFilesystem();
    if (musl === null) musl = isMuslFromReport();
    if (musl === null) musl = isMuslFromChildProcess();
  }
  return musl;
}

/** Derive the package suffix selected by the generated native loader. */
export function hostDescriptor(
  platform = process.platform,
  arch = process.arch,
  linuxLibc = undefined,
) {
  const archName = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (archName === null) {
    throw new Error(
      `unsupported host: platform=${JSON.stringify(platform)} arch=${JSON.stringify(arch)}; no native artifact is shipped for this pair`,
    );
  }
  if (platform === "darwin") return `darwin-${archName}`;
  if (platform === "win32") return `win32-${archName}-msvc`;
  if (platform === "linux") {
    const libc = linuxLibc ?? (isMusl() ? "musl" : "gnu");
    if (libc === "gnu" || libc === "musl") return `linux-${archName}-${libc}`;
  }
  throw new Error(
    `unsupported host: platform=${JSON.stringify(platform)} arch=${JSON.stringify(arch)}; no native artifact is shipped for this pair`,
  );
}

/**
 * Maps a host descriptor to the platform package name listed in the main
 * package's optionalDependencies.
 */
function platformPackageName(descriptor) {
  return `zod-rs-node-${descriptor}`;
}

const WASM_TIER = {
  entry: "wasm/zodrs_node.wasi.cjs",
  files: [
    "wasm/zodrs_node.wasi.cjs",
    "wasm/zodrs_node.wasm32-wasi.wasm",
    "wasm/wasi-worker.mjs",
  ],
};

export function resolveWasmTierFiles() {
  return WASM_TIER;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readManifest(packageDir) {
  return JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
}

function regularFile(packageDir, relativePath) {
  const unresolved = resolve(packageDir, relativePath);
  const metadata = lstatSync(unresolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${relativePath} must be a regular file, not a symlink`);
  }

  const path = realpathSync(unresolved);
  const fromRoot = relative(packageDir, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${relativePath} resolves outside ${packageDir}`);
  }

  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, relativePath, sha256 };
}

function requireAbsent(packageDir, relativePath) {
  try {
    lstatSync(resolve(packageDir, relativePath));
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${relativePath} must not exist in a release package`);
}

/**
 * Reject any `.node` file inside `<installedMain>/native`.  The main package
 * tarball excludes `native/*.node` via the `files` array, so a `.node` file
 * present in an installed main package means either a stale tarball or a
 * workspace symlink is masking optional-dependency selection.
 */
function rejectEmbeddedNodeFiles(installedMain) {
  const nativeDir = resolve(installedMain, "native");
  let entries;
  try {
    entries = readdirSync(nativeDir, { withFileTypes: true });
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return; // no native/ dir — fine
    }
    throw error;
  }
  const nodeFiles = entries.filter((e) => e.name.endsWith(".node")).map((e) => e.name);
  if (nodeFiles.length > 0) {
    throw new Error(
      `installed main package contains embedded .node files in native/: ${nodeFiles.join(", ")}; the main tarball must not ship native addons`,
    );
  }
}

function isAddon(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.compile === "function" &&
    typeof value.validateJson === "function" &&
    typeof value.dispose === "function"
  );
}

function errorMessage(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

// ---------------------------------------------------------------------------
// Native verification — resolves the platform package from the installed
// main package's dependency graph, never from the source tree or workspace.
// ---------------------------------------------------------------------------

function verifyNative(packageDir, expectedPackageDir, expectedPlatformDir) {
  const expectedManifest = readManifest(expectedPackageDir);
  const expectedName = expectedManifest.publishConfig?.name ?? expectedManifest.name;
  const expectedVersion = expectedManifest.version;

  const manifest = readManifest(packageDir);
  if (manifest.name !== expectedName) {
    throw new Error(`${packageDir} name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(expectedName)}`);
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${packageDir} version is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(expectedVersion)}`,
    );
  }

  // Reject embedded .node files so a host addon inside the main package
  // cannot mask optional-dependency selection.
  rejectEmbeddedNodeFiles(packageDir);

  // Derive the host descriptor and the expected platform package name.
  const descriptor = hostDescriptor();
  const pkgName = platformPackageName(descriptor);

  // The main package must list this platform package as an optional
  // dependency at the expected version.
  const optionalDeps = manifest.optionalDependencies ?? {};
  const pinnedVersion = optionalDeps[pkgName];
  if (pinnedVersion === undefined) {
    throw new Error(
      `${packageDir} optionalDependencies does not include ${pkgName}`,
    );
  }
  if (pinnedVersion !== expectedVersion) {
    throw new Error(
      `${packageDir} optionalDependencies pins ${pkgName}@${JSON.stringify(pinnedVersion)}, expected ${JSON.stringify(expectedVersion)}`,
    );
  }

  // Resolve the platform package from the installed main package's
  // dependency graph — never from import.meta.url or the source tree.
  const installedRequire = createRequire(resolve(packageDir, "package.json"));
  let platformEntry;
  let platformManifestPath;
  try {
    platformEntry = installedRequire.resolve(pkgName);
    platformManifestPath = installedRequire.resolve(`${pkgName}/package.json`);
  } catch (error) {
    throw new Error(
      `could not resolve ${pkgName} from ${packageDir} dependency graph: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const siblingDir = resolve(packageDir, "..", pkgName);
  const siblingStat = lstatSync(siblingDir);
  if (siblingStat.isSymbolicLink() || !siblingStat.isDirectory()) {
    throw new Error(`${pkgName} must be a sibling directory of ${packageDir}`);
  }
  const platformDir = realpathSync(siblingDir);
  const resolvedManifest = realpathSync(platformManifestPath);
  if (resolvedManifest !== resolve(platformDir, "package.json")) {
    throw new Error(`${pkgName} resolved outside its sibling package directory`);
  }

  const entryStat = lstatSync(platformEntry);
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new Error(`${pkgName} entry must be a regular file, not a symlink`);
  }
  const platformEntryReal = realpathSync(platformEntry);
  const platformManifest = readManifest(platformDir);

  // Validate the platform package manifest.
  if (platformManifest.name !== pkgName) {
    throw new Error(
      `platform package name is ${JSON.stringify(platformManifest.name)}, expected ${JSON.stringify(pkgName)}`,
    );
  }
  if (platformManifest.version !== expectedVersion) {
    throw new Error(
      `platform package version is ${JSON.stringify(platformManifest.version)}, expected ${JSON.stringify(expectedVersion)}`,
    );
  }

  const nodeFile = platformManifest.main;
  if (typeof nodeFile !== "string" || !nodeFile.endsWith(".node")) {
    throw new Error(`platform package main must be a .node file, got ${JSON.stringify(nodeFile)}`);
  }

  // Validate platform manifest os/cpu/libc against the host descriptor.
  const expectedOs = descriptor.startsWith("linux")
    ? ["linux"]
    : descriptor.startsWith("darwin")
      ? ["darwin"]
      : ["win32"];
  const expectedCpu = descriptor.includes("-x64-") || descriptor.endsWith("-x64")
    ? ["x64"]
    : ["arm64"];
  if (JSON.stringify(platformManifest.os) !== JSON.stringify(expectedOs)) {
    throw new Error(
      `platform package os is ${JSON.stringify(platformManifest.os)}, expected ${JSON.stringify(expectedOs)}`,
    );
  }
  if (JSON.stringify(platformManifest.cpu) !== JSON.stringify(expectedCpu)) {
    throw new Error(
      `platform package cpu is ${JSON.stringify(platformManifest.cpu)}, expected ${JSON.stringify(expectedCpu)}`,
    );
  }
  if (descriptor.startsWith("linux")) {
    const expectedLibc = descriptor.endsWith("-musl") ? ["musl"] : ["glibc"];
    if (JSON.stringify(platformManifest.libc) !== JSON.stringify(expectedLibc)) {
      throw new Error(
        `platform package libc is ${JSON.stringify(platformManifest.libc)}, expected ${JSON.stringify(expectedLibc)}`,
      );
    }
  }

  // Validate files array includes the .node file.
  if (!Array.isArray(platformManifest.files) || !platformManifest.files.includes(nodeFile)) {
    throw new Error(`platform package files must include ${nodeFile}`);
  }

  // The resolved entry must be the declared main .node file.
  const entryBasename = relative(platformDir, platformEntryReal);
  if (entryBasename !== nodeFile) {
    throw new Error(
      `resolved platform entry ${entryBasename} does not match manifest main ${nodeFile}`,
    );
  }

  // Containment: the entry realpath must be inside the platform dir.
  const fromRoot = relative(platformDir, platformEntryReal);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`platform entry ${platformEntry} resolves outside ${platformDir}`);
  }


  // If an expected platform dir is supplied, compare the raw addon SHA.
  let sha256 = null;
  if (expectedPlatformDir !== undefined) {
    const expectedPlatformReal = realpathSync(resolve(expectedPlatformDir));
    const expectedPlatformManifest = readManifest(expectedPlatformReal);
    if (expectedPlatformManifest.name !== pkgName) {
      throw new Error(
        `expected platform package name is ${JSON.stringify(expectedPlatformManifest.name)}, expected ${JSON.stringify(pkgName)}`,
      );
    }
    const expectedNodePath = resolve(expectedPlatformReal, nodeFile);
    const expectedNodeStat = lstatSync(expectedNodePath);
    if (expectedNodeStat.isSymbolicLink() || !expectedNodeStat.isFile()) {
      throw new Error(`expected ${nodeFile} must be a regular file, not a symlink`);
    }
    const expectedSha = createHash("sha256").update(readFileSync(expectedNodePath)).digest("hex");
    const installedSha = createHash("sha256").update(readFileSync(platformEntryReal)).digest("hex");
    if (installedSha !== expectedSha) {
      throw new Error(
        `${nodeFile} SHA-256 ${installedSha} does not match expected platform addon ${expectedSha}`,
      );
    }
    sha256 = installedSha;
  }

  // Directly load the raw addon from the resolved platform package entry.
  const loaded = installedRequire(platformEntry);
  const addon = isAddon(loaded) ? loaded : isAddon(loaded?.default) ? loaded.default : null;
  if (addon === null) {
    throw new Error(`${nodeFile} does not expose compile, validateJson, and dispose`);
  }

  let handle;
  let status;
  try {
    handle = addon.compile(PLAN);
    if (!Number.isInteger(handle)) throw new Error(`${nodeFile} returned a non-integer plan handle`);

    const verdict = addon.validateJson(handle, INPUT);
    if (verdict === null || typeof verdict !== "object" || verdict.status !== 0) {
      throw new Error(`${nodeFile} returned verdict ${JSON.stringify(verdict)}; expected status 0`);
    }
    status = verdict.status;
  } finally {
    if (Number.isInteger(handle)) addon.dispose(handle);
  }

  return {
    tool: TOOL,
    package: expectedName,
    version: expectedVersion,
    tier: "native",
    platformPackage: pkgName,
    hostDescriptor: descriptor,
    addon: nodeFile,
    sha256,
    status,
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// WASM verification — host-independent, preserves installed-vs-expected SHA.
// ---------------------------------------------------------------------------

function verifyWasm(packageDir, expectedPackageDir) {
  const expectedManifest = readManifest(expectedPackageDir);
  const expectedName = expectedManifest.publishConfig?.name ?? expectedManifest.name;
  const expectedVersion = expectedManifest.version;

  const manifest = readManifest(packageDir);
  if (manifest.name !== expectedName) {
    throw new Error(`${packageDir} name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(expectedName)}`);
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${packageDir} version is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(expectedVersion)}`,
    );
  }

  requireAbsent(expectedPackageDir, DEBUG_WASM);
  requireAbsent(packageDir, DEBUG_WASM);

  const tierFiles = resolveWasmTierFiles();
  const artifacts = tierFiles.files.map((relativePath) => {
    const expected = regularFile(expectedPackageDir, relativePath);
    const installed = regularFile(packageDir, relativePath);
    if (installed.sha256 !== expected.sha256) {
      throw new Error(`${relativePath} SHA-256 ${installed.sha256} does not match release artifact ${expected.sha256}`);
    }
    return { path: relativePath, sha256: installed.sha256 };
  });

  const entry = regularFile(packageDir, tierFiles.entry);
  const loaded = createRequire(import.meta.url)(entry.path);
  const addon = isAddon(loaded) ? loaded : isAddon(loaded?.default) ? loaded.default : null;
  if (addon === null) throw new Error(`${tierFiles.entry} does not expose compile, validateJson, and dispose`);

  let handle;
  let status;
  try {
    handle = addon.compile(PLAN);
    if (!Number.isInteger(handle)) throw new Error(`${tierFiles.entry} returned a non-integer plan handle`);

    const verdict = addon.validateJson(handle, INPUT);
    if (verdict === null || typeof verdict !== "object" || verdict.status !== 0) {
      throw new Error(`${tierFiles.entry} returned verdict ${JSON.stringify(verdict)}; expected status 0`);
    }
    status = verdict.status;
  } finally {
    if (Number.isInteger(handle)) addon.dispose(handle);
  }

  return {
    tool: TOOL,
    package: expectedName,
    version: expectedVersion,
    tier: "wasm",
    artifacts,
    status,
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// Public verify entry point
// ---------------------------------------------------------------------------

function verify(packageArg, tier, expectedPackageArg = DEFAULT_EXPECTED_PACKAGE_DIR, expectedPlatformArg = undefined) {
  const packageDir = realpathSync(resolve(packageArg));
  const expectedPackageDir = realpathSync(resolve(expectedPackageArg));
  const expectedPlatformDir =
    expectedPlatformArg !== undefined ? realpathSync(resolve(expectedPlatformArg)) : undefined;

  if (tier === "wasm") {
    return verifyWasm(packageDir, expectedPackageDir);
  }
  return verifyNative(packageDir, expectedPackageDir, expectedPlatformDir);
}

export function main() {
  const packageArg = process.argv[2];
  const tier = process.argv[3];
  const expectedPackageArg = process.argv[4];
  const expectedPlatformArg = process.argv[5];
  if (packageArg === undefined || (tier !== "native" && tier !== "wasm")) {
    process.stderr.write(
      `${JSON.stringify({ tool: TOOL, ok: false, error: "usage: verify-installed <package-directory> <native|wasm> [expected-package-directory] [expected-platform-package-directory]" })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  if (tier === "wasm") {
    process.env.NAPI_RS_FORCE_WASI = "error";
    process.env.NAPI_RS_WASI_FLAVOR = "wasm32-wasi";
  } else {
    delete process.env.NAPI_RS_FORCE_WASI;
    delete process.env.NAPI_RS_WASI_FLAVOR;
  }

  try {
    process.stdout.write(`${JSON.stringify(verify(packageArg, tier, expectedPackageArg, expectedPlatformArg))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ tool: TOOL, tier, ok: false, error: errorMessage(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
