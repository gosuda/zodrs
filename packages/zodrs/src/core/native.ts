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

const NATIVE_PLAN: unique symbol = Symbol("zodrs.native-plan");

interface NativePlanState {
  readonly validateJson: (bytes: Uint8Array) => NativeVerdict;
  readonly dispose: () => void;
  disposed: boolean;
}

/** Opaque plan identity. Only the backend factory can create one. */
export interface NativePlanRef {
  readonly [NATIVE_PLAN]: NativePlanState;
}

/** Create one backend-owned plan reference without exposing its raw handle. */
export function createNativePlanRef(
  validateJson: (bytes: Uint8Array) => NativeVerdict,
  dispose: () => void,
): NativePlanRef {
  const state: NativePlanState = { validateJson, dispose, disposed: false };
  return Object.freeze({ [NATIVE_PLAN]: state });
}

export interface NativeBackend {
  compile(planJson: string): NativePlanRef;
}

interface BackendRegistration {
  readonly backend: NativeBackend;
}

const registrations = new WeakMap<NativePlanRef, BackendRegistration>();
let registration: BackendRegistration | null = null;

function releasePlan(plan: NativePlanRef): void {
  const state = plan[NATIVE_PLAN];
  if (state.disposed) return;
  state.disposed = true;
  try {
    state.dispose();
  } catch {
    // Cleanup failure must not change parse behavior or escape a finalizer path.
  }
}

/** Register a native/WASM backend, or clear it by passing `null`. */
export function registerNativeBackend(candidate: NativeBackend | null): void {
  registration = candidate === null ? null : { backend: candidate };
}

export function getNativeBackend(): NativeBackend | null {
  return registration?.backend ?? null;
}

export function isNativeAvailable(): boolean {
  return registration !== null;
}

export interface NativeCallResult {
  readonly available: boolean;
  readonly plan: NativePlanRef | null;
  readonly verdict: NativeVerdict | null;
}

/** Compile on first use, then validate bytes against the current backend generation. */
export function validateJson(
  planJson: string,
  plan: NativePlanRef | null,
  bytes: Uint8Array,
): NativeCallResult {
  const current = registration;
  if (current === null) {
    if (plan !== null) releasePlan(plan);
    return { available: false, plan: null, verdict: null };
  }

  let active = plan;
  if (active !== null && (registrations.get(active) !== current || active[NATIVE_PLAN].disposed)) {
    releasePlan(active);
    active = null;
  }

  if (active === null) {
    try {
      active = current.backend.compile(planJson);
      registrations.set(active, current);
    } catch {
      return { available: false, plan: null, verdict: null };
    }
  }

  try {
    return { available: true, plan: active, verdict: active[NATIVE_PLAN].validateJson(bytes) };
  } catch {
    releasePlan(active);
    return { available: false, plan: null, verdict: null };
  }
}
