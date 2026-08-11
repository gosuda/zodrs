import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = "zodrs-verify-installed";
const DEFAULT_EXPECTED_PACKAGE_DIR = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const PLAN =
  '[{"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},{"k":"string","checks":[{"c":"min_length","v":3}]}]';
const INPUT = new TextEncoder().encode('{"a":"abcd"}');
const DEBUG_WASM = "wasm/zodrs_node.wasm32-wasi.debug.wasm";
const TIER_FILES = {
  native: {
    entry: "native/zodrs_node.linux-x64-gnu.node",
    files: ["native/zodrs_node.linux-x64-gnu.node"],
  },
  wasm: {
    entry: "wasm/zodrs_node.wasi.cjs",
    files: ["wasm/zodrs_node.wasi.cjs", "wasm/zodrs_node.wasm32-wasi.wasm"],
  },
};

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

function verify(packageArg, tier, expectedPackageArg = DEFAULT_EXPECTED_PACKAGE_DIR) {
  const packageDir = realpathSync(resolve(packageArg));
  const expectedPackageDir = realpathSync(resolve(expectedPackageArg));
  const expectedManifest = readManifest(expectedPackageDir);
  const manifest = readManifest(packageDir);
  const expectedName = expectedManifest.publishConfig?.name ?? expectedManifest.name;
  if (manifest.name !== expectedName) {
    throw new Error(`${packageDir} name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(expectedName)}`);
  }
  if (manifest.version !== expectedManifest.version) {
    throw new Error(
      `${packageDir} version is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(expectedManifest.version)}`,
    );
  }
  if (tier === "wasm") {
    requireAbsent(expectedPackageDir, DEBUG_WASM);
    requireAbsent(packageDir, DEBUG_WASM);
  }

  const tierFiles = TIER_FILES[tier];
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
    version: expectedManifest.version,
    tier,
    artifacts,
    status,
    ok: true,
  };
}

const packageArg = process.argv[2];
const tier = process.argv[3];
const expectedPackageArg = process.argv[4];
if (packageArg === undefined || (tier !== "native" && tier !== "wasm")) {
  process.stderr.write(
    `${JSON.stringify({ tool: TOOL, ok: false, error: "usage: verify-installed <package-directory> <native|wasm> [expected-package-directory]" })}\n`,
  );
  process.exitCode = 2;
} else {
  delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  if (tier === "wasm") {
    process.env.NAPI_RS_FORCE_WASI = "error";
    process.env.NAPI_RS_WASI_FLAVOR = "wasm32-wasi";
  } else {
    delete process.env.NAPI_RS_FORCE_WASI;
    delete process.env.NAPI_RS_WASI_FLAVOR;
  }

  try {
    process.stdout.write(`${JSON.stringify(verify(packageArg, tier, expectedPackageArg))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ tool: TOOL, tier, ok: false, error: errorMessage(error) })}\n`);
    process.exitCode = 1;
  }
}
