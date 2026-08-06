/**
 * Loader resolution for the Rust byte-path backend (plan step 7).
 *
 * Side-effect module: importing it probes the available tiers and registers
 * the first working backend through `registerNativeBackend`. Resolution is
 * governed by the ZODRS_LOADER environment variable:
 *
 *   - `"none"`:           no backend is registered (TypeScript-only mode).
 *   - `"wasm"`:           only the WASM (wasm32-wasip1-threads) addon is tried.
 *   - unset / `"native"`: the native addon for the current platform triple
 *                         (packages/zodrs/native/, selected by its generated
 *                         platform loader), then the WASM addon
 *                         (packages/zodrs/wasm/), then unavailable.
 *
 * With no backend registered, `parseJson` falls back to `JSON.parse` plus the
 * TypeScript validator, so every tier yields identical observable results.
 *
 * Both addons are loaded with `await import()` because they are
 * platform-specific build artifacts that do not exist on every machine or in
 * every tier: a static import would fail at build/bundle time instead of
 * degrading to the next loader tier at runtime.
 */

import { registerNativeBackend, type NativeBackend, type NativeVerdict } from "./native.js";

declare const process: { readonly env: Record<string, string | undefined> } | undefined;
declare const URL: { new (url: string, base?: string): { readonly href: string } };
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

/** One diagnostic line per tier attempt, for support and the loader self-test. */
export const loaderDiagnostics: string[] = [];

/** The raw napi surface both addons expose. */
interface RawAddon {
  compile(planJson: string): number;
  dispose(handle: number): void;
  validateJson(handle: number, bytes: Uint8Array): NativeVerdict;
}

function isRawAddon(candidate: unknown): candidate is RawAddon {
  if (candidate === null || typeof candidate !== "object") return false;
  if (!("compile" in candidate) || typeof candidate.compile !== "function") return false;
  if (!("dispose" in candidate) || typeof candidate.dispose !== "function") return false;
  return "validateJson" in candidate && typeof candidate.validateJson === "function";
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Wrap a loaded addon in the NativeBackend seam. Each unique plan JSON
 * compiles exactly once: handles are cached in a Map keyed by the plan string
 * so identical schemas share one Rust plan. A FinalizationRegistry disposes
 * the handle of any cache token that gets collected; the cache retains its
 * tokens, so plans in practice live for the process lifetime (the seam
 * carries no schema-lifetime signal), and the registry guarantees disposal if
 * an entry is ever evicted from the cache.
 */
function wrapAddon(addon: RawAddon): NativeBackend {
  const cache = new Map<string, { readonly handle: number; readonly token: object }>();
  const finalizer = new FinalizationRegistry<number>((handle) => {
    addon.dispose(handle);
  });
  return {
    compile(planJson: string): number {
      const cached = cache.get(planJson);
      if (cached) return cached.handle;
      const handle = addon.compile(planJson);
      const token = { handle };
      finalizer.register(token, handle);
      cache.set(planJson, { handle, token });
      return handle;
    },
    dispose(handle: number): void {
      addon.dispose(handle);
    },
    validateJson(handle: number, bytes: Uint8Array): NativeVerdict {
      return addon.validateJson(handle, bytes);
    },
  };
}

function pickAddon(mod: unknown, tier: string): RawAddon | null {
  // CJS interop: the WASI binding is module.exports, surfaced as `default`.
  if (mod !== null && typeof mod === "object" && "default" in mod && isRawAddon(mod.default)) {
    return mod.default;
  }
  if (isRawAddon(mod)) return mod;
  loaderDiagnostics.push(`${tier}: loader did not expose the napi surface`);
  return null;
}

/** The native addon, via its generated platform-selecting ESM loader. */
async function loadNative(): Promise<RawAddon | null> {
  try {
    return pickAddon(await import(new URL("../../native/index.js", import.meta.url).href), "native");
  } catch (error: unknown) {
    loaderDiagnostics.push(`native: ${describe(error)}`);
    return null;
  }
}

/** The WASM addon, via its generated Node WASI loader (CommonJS). */
async function loadWasm(): Promise<RawAddon | null> {
  try {
    return pickAddon(await import(new URL("../../wasm/zodrs_node.wasi.cjs", import.meta.url).href), "wasm");
  } catch (error: unknown) {
    loaderDiagnostics.push(`wasm: ${describe(error)}`);
    return null;
  }
}

const requestedTier: string | undefined =
  typeof process !== "undefined" ? process.env["ZODRS_LOADER"] : undefined;

if (requestedTier === "none") {
  loaderDiagnostics.push("none: ZODRS_LOADER=none, backend disabled");
} else {
  let addon: RawAddon | null = null;
  if (requestedTier !== "wasm") {
    addon = await loadNative();
    if (addon) loaderDiagnostics.push("native: registered");
  }
  if (!addon) {
    addon = await loadWasm();
    if (addon) loaderDiagnostics.push("wasm: registered");
  }
  if (addon) {
    registerNativeBackend(wrapAddon(addon));
  } else {
    loaderDiagnostics.push("unavailable: no native or WASM backend loaded; TypeScript fallback active");
  }
}
