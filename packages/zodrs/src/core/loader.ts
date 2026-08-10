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
 * **Native tier — synchronous.** The generated napi-rs loader
 * (`native/index.js`) is TLA-free ESM, so `require(esm)` (Node 22.12+)
 * loads it without async. `createRequire(moduleUrl)` provides the `require`
 * function in both ESM and CJS contexts.
 *
 * **WASM tier — async, fire-and-forget.** WASI instantiation is inherently
 * async. The `import()` call returns a Promise that registers the backend
 * when it resolves. Until then, `parseJson` falls back to `JSON.parse` plus
 * the TypeScript validator — identical observable results, lower throughput.
 * `loaderSettled` exposes the Promise so callers (e.g. the self-test) can
 * await registration if needed.
 *
 * With no backend registered, `parseJson` falls back to `JSON.parse` plus the
 * TypeScript validator, so every tier yields identical observable results.
 */

import { createRequire } from "node:module";
import { moduleUrl } from "#module-url";
import {
  createNativePlanRef,
  registerNativeBackend,
  type NativeBackend,
  type NativePlanRef,
  type NativeVerdict,
} from "./native.js";

declare const process: { readonly env: Record<string, string | undefined> } | undefined;
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
 * Wrap a loaded addon in the opaque native-plan contract. */
function wrapAddon(addon: RawAddon): NativeBackend {
  const cache = new Map<string, WeakRef<NativePlanRef>>();
  interface FinalizerHolding {
    readonly planJson: string;
    readonly ref: WeakRef<NativePlanRef>;
    readonly handle: number;
  }
  const finalizer = new FinalizationRegistry<FinalizerHolding>((holding) => {
    if (cache.get(holding.planJson) === holding.ref) cache.delete(holding.planJson);
    try {
      addon.dispose(holding.handle);
    } catch {
      // Native cleanup cannot safely report through a garbage-collection callback.
    }
  });

  return {
    compile(planJson: string): NativePlanRef {
      const cachedRef = cache.get(planJson);
      const cached = cachedRef?.deref();
      if (cached !== undefined) return cached;
      if (cachedRef !== undefined) cache.delete(planJson);

      const handle = addon.compile(planJson);
      const unregisterToken = {};
      let weakRef: WeakRef<NativePlanRef> | undefined;
      const plan = createNativePlanRef(
        (bytes) => addon.validateJson(handle, bytes),
        () => {
          finalizer.unregister(unregisterToken);
          if (weakRef !== undefined && cache.get(planJson) === weakRef) cache.delete(planJson);
          try {
            addon.dispose(handle);
          } catch {
            // Disposal is best-effort after the plan leaves the active generation.
          }
        },
      );
      weakRef = new WeakRef(plan);
      cache.set(planJson, weakRef);
      finalizer.register(plan, { planJson, ref: weakRef, handle }, unregisterToken);
      return plan;
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

/**
 * A `require` function anchored at this module's location. In ESM,
 * `createRequire(import.meta.url)`; in CJS, `createRequire(__filename)`.
 * Both resolve relative specifiers against the compiled loader file, so
 * `req("../../native/index.js")` finds the same artifact from either build.
 */
const req = createRequire(moduleUrl);

/** The native addon, via its generated platform-selecting ESM loader (sync). */
function loadNativeSync(): RawAddon | null {
  try {
    return pickAddon(req("../../native/index.js"), "native");
  } catch (error: unknown) {
    loaderDiagnostics.push(`native: ${describe(error)}`);
    return null;
  }
}

/**
 * The WASM addon, via its generated Node WASI loader (CommonJS).
 * Fire-and-forget: returns a Promise that registers the backend when it
 * resolves. The caller does NOT await this at the top level.
 */
function loadWasmAsync(): Promise<void> {
  // Non-literal specifier so tsc does not try to resolve the .cjs types
  // (which would fail under moduleResolution: node10).
  const specifier: string = "../../wasm/zodrs_node.wasi.cjs";
  return import(specifier)
    .then((mod: unknown) => {
      const addon = pickAddon(mod, "wasm");
      if (addon) {
        registerNativeBackend(wrapAddon(addon));
        loaderDiagnostics.push("wasm: registered (async)");
      }
    })
    .catch((error: unknown) => {
      loaderDiagnostics.push(`wasm: ${describe(error)}`);
    });
}

const requestedTier: string | undefined =
  typeof process !== "undefined" ? process.env["ZODRS_LOADER"] : undefined;

function resolveTiers(): Promise<void> {
  if (requestedTier === "none") {
    loaderDiagnostics.push("none: ZODRS_LOADER=none, backend disabled");
    return Promise.resolve();
  }

  // Native tier: synchronous.
  if (requestedTier !== "wasm") {
    const native = loadNativeSync();
    if (native) {
      registerNativeBackend(wrapAddon(native));
      loaderDiagnostics.push("native: registered");
      return Promise.resolve();
    }
  }

  // WASM tier: async, fire-and-forget.
  // Before registration, parseJson falls back to TS (identical observable results).
  return loadWasmAsync();
}

/** Resolves when tier resolution is complete (immediately for native/none). */
export const loaderSettled: Promise<void> = resolveTiers();
