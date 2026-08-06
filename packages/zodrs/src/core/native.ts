/**
 * Loader seam for the Rust byte-path backend. The napi/WASM addon is built in a
 * later wave; until it registers, this reports unavailable and the TypeScript
 * fallback in `parse.ts` handles `parseJson` for identical observable results.
 */

export interface NativeVerdict {
  /** 0 = valid canonical input, 1 = valid rewritten payload, 2 = invalid issues, 3 = plan not JSON-eligible. */
  readonly status: number;
  readonly payload: string | null;
}

export interface NativeBackend {
  compile(planJson: string): number;
  dispose(handle: number): void;
  validateJson(handle: number, bytes: Uint8Array): NativeVerdict;
}

let backend: NativeBackend | null = null;

/** Register a native/WASM backend. Called by the addon's loader when present. */
export function registerNativeBackend(candidate: NativeBackend): void {
  backend = candidate;
}

export function getNativeBackend(): NativeBackend | null {
  return backend;
}

export function isNativeAvailable(): boolean {
  return backend !== null;
}

export interface NativeCallResult {
  readonly available: boolean;
  readonly handle: number | null;
  readonly verdict: NativeVerdict | null;
}

/** Compile on first use, then validate bytes across one addon boundary. */
export function validateJson(planJson: string, handle: number | null, bytes: Uint8Array): NativeCallResult {
  if (!backend) return { available: false, handle: null, verdict: null };
  const compiled = handle ?? backend.compile(planJson);
  return { available: true, handle: compiled, verdict: backend.validateJson(compiled, bytes) };
}
