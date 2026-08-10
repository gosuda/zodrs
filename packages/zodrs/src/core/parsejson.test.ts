import { TextEncoder } from "node:util";
import { expect, test } from "vitest";
import * as z from "../classic/index.js";
import {
  createNativePlanRef,
  getNativeBackend,
  registerNativeBackend,
  validateJson,
  type NativeBackend,
} from "./native.js";

/**
 * parseJson byte-path divergences surfaced by the differential fuzz. These
 * exercise the native status-3 fallback (K1), reportInput gating (K2), and
 * nested union sub-issue back-fill (K3). parseJson is zodrs-only, so this has
 * no corpus coverage — behaviors asserted here mirror JSON.parse semantics.
 */

test("BOM input succeeds via status-3 fallback", () => {
  const S = z.object({ a: z.string() });
  const json = Array.from('{"a":"x"}', (ch) => ch.charCodeAt(0));
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
  expect(S.parseJson(bom)).toEqual({ a: "x" });
});

test("lone-surrogate escape succeeds via status-3 fallback", () => {
  const S = z.object({ a: z.string() });
  expect(S.parseJson('{"a":"\\ud800"}')).toEqual({ a: "\ud800" });
});

test("1e400 reaches the validator as Infinity via status-3 fallback", () => {
  const N = z.object({ a: z.number() });
  // sonic-rs rejects the overflowing literal, so the byte path returns
  // status 3 and the TS path re-parses: `JSON.parse` yields Infinity.
  // `z.number()` then rejects it exactly as zod v4 does. `received:
  // "Infinity"` is the proof the fallback ran — the Rust path never sees
  // the value, so it could not have produced this issue.
  const result = N.safeParseJson('{"a":1e400}');
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues).toEqual([
    expect.objectContaining({
      code: "invalid_type",
      expected: "number",
      received: "Infinity",
      path: ["a"],
    }),
  ]);
});

test("NaN literal throws SyntaxError", () => {
  const N = z.object({ a: z.number() });
  expect(() => N.parseJson('{"a":NaN}')).toThrow(SyntaxError);
});

test("truncated JSON throws SyntaxError", () => {
  const N = z.object({ a: z.number() });
  expect(() => N.parseJson('{"a":1')).toThrow(SyntaxError);
});

test("reportInput off strips input from issues", () => {
  const U = z.union([z.string(), z.number()]);
  const result = U.safeParseJson("true");
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0]?.code).toBe("invalid_union");
  expect(result.error.issues[0]?.input).toBeUndefined();
});

test("reportInput on back-fills input including nested union sub-issues", () => {
  const U = z.union([z.string(), z.number()]);
  const result = U.safeParseJson("true", { reportInput: true });
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues[0];
  expect(issue?.code).toBe("invalid_union");
  expect(issue?.input).toBe(true);
  const nested = issue?.code === "invalid_union" ? issue.errors[0]?.[0] : undefined;
  expect(nested?.input).toBe(true);
  expect(nested?.message).toBe("Invalid input: expected string, received boolean");
});

test("status-2 result issues identical to the JS path", () => {
  const User = z.object({ name: z.string().min(3), age: z.number().int().positive() });
  const bad = '{"name":"Ad","age":-1}';
  const viaBytes = User.safeParseJson(bad);
  const viaValue = User.safeParse(JSON.parse(bad));
  expect(viaBytes.success).toBe(false);
  expect(viaValue.success).toBe(false);
  if (viaBytes.success || viaValue.success) return;
  expect(viaBytes.error.issues).toEqual(viaValue.error.issues);
});

test("prototype pollution after plan cache falls back to TS path", () => {
  const S = z.object({ pollutedKey: z.string() });
  // Cache the plan before polluting
  void S._zod.plan;
  (Object.prototype as Record<string, unknown>).pollutedKey = "evil";
  try {
    // With polluted prototype, {} reads through as { pollutedKey: "evil" } on the TS path.
    // The byte path would see a missing required key; the live check must force a fallback.
    const result = S.safeParseJson("{}");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ pollutedKey: "evil" });
  } finally {
    delete (Object.prototype as Record<string, unknown>).pollutedKey;
  }
});

test("mutable static fallback stays live after plan cache", () => {
  const fallback = { value: 1 };
  const S = z.object({ config: z.object({ value: z.number() }).default(fallback) });
  void S._zod.plan;

  fallback.value = 2;
  expect(S.parseJson("{}")).toEqual(S.parse({}));
  expect(S.parseJson("{}")).toEqual({ config: { value: 2 } });
});

test("20k nested array does not abort the process", () => {
  const A = z.any();
  const depth = 20_000;
  const input = "[".repeat(depth) + "1" + "]".repeat(depth);
  // The native byte path must fall back (status 3) before any recursive path
  // can exhaust the process stack. The JS path then JSON.parses and validates.
  const result = A.safeParseJson(input);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(Array.isArray(result.data)).toBe(true);
  }
});

test("compile throw falls back to the TypeScript validator", () => {
  const S = z.object({ a: z.string() });
  const plan = S._zod.plan;
  const encoder = new TextEncoder();

  expect(plan.jsonEligible).toBe(true);

  const original = getNativeBackend();
  let compileCalls = 0;
  const fake: NativeBackend = {
    compile: (planJson) => {
      compileCalls += 1;
      throw new Error(`compile rejected: ${planJson.slice(0, 20)}`);
    },
  };
  registerNativeBackend(fake);

  try {
    const direct = validateJson(plan.json, null, encoder.encode('{"a":"x"}'));
    expect(direct).toEqual({ available: false, plan: null, verdict: null });
    expect(compileCalls).toBe(1);

    expect(S.parseJson('{"a":"hello"}')).toEqual({ a: "hello" });
    expect(compileCalls).toBe(2);

    const safe = S.safeParseJson('{"a":1}');
    expect(safe.success).toBe(false);
    expect(compileCalls).toBe(3);
    expect(S._zod.nativePlan).toBe(null);
  } finally {
    registerNativeBackend(original);
  }
});

test("status-1 byte validation does not decode the original bytes", () => {
  const S = z.object({ a: z.string() });
  const original = getNativeBackend();
  const fake: NativeBackend = {
    compile: () => createNativePlanRef(
      () => ({ status: 1, payload: '{"a":"rewritten"}' }),
      () => {},
    ),
  };
  registerNativeBackend(fake);

  try {
    // TextDecoder rejects a Proxy because it has no Uint8Array internal slot.
    // A status-1 result does not need the original text, so decoding it is waste.
    const bytes = new Proxy(new Uint8Array([0]), {});
    expect(S.parseJson(bytes)).toEqual({ a: "rewritten" });
  } finally {
    registerNativeBackend(null);
    expect(S.parseJson('{"a":"cleanup"}')).toEqual({ a: "cleanup" });
    registerNativeBackend(original);
  }
});

test("one schema reuses its native plan", () => {
  const S = z.string();
  const original = getNativeBackend();
  let compileCalls = 0;
  const fake: NativeBackend = {
    compile: () => {
      compileCalls += 1;
      return createNativePlanRef(
        () => ({ status: 0, payload: null }),
        () => {},
      );
    },
  };
  registerNativeBackend(fake);

  try {
    expect(S.parseJson('"one"')).toBe("one");
    const first = S._zod.nativePlan;
    expect(S.parseJson('"two"')).toBe("two");
    expect(S._zod.nativePlan).toBe(first);
    expect(compileCalls).toBe(1);
  } finally {
    registerNativeBackend(null);
    expect(S.parseJson('"cleanup"')).toBe("cleanup");
    registerNativeBackend(original);
  }
});

test("backend replacement isolates reused raw handle identities", () => {
  const S = z.object({ source: z.string() });
  const original = getNativeBackend();
  let disposedA = 0;
  let disposedB = 0;
  const backendA: NativeBackend = {
    compile: () => createNativePlanRef(
      () => ({ status: 1, payload: '{"source":"A"}' }),
      () => {
        disposedA += 1;
        throw new Error("addon A dispose failure");
      },
    ),
  };
  const backendB: NativeBackend = {
    compile: () => createNativePlanRef(
      () => ({ status: 1, payload: '{"source":"B"}' }),
      () => {
        disposedB += 1;
      },
    ),
  };

  registerNativeBackend(backendA);
  try {
    expect(S.parseJson('{"source":"input"}')).toEqual({ source: "A" });
    const planA = S._zod.nativePlan;

    registerNativeBackend(backendB);
    expect(S.parseJson('{"source":"input"}')).toEqual({ source: "B" });
    expect(S._zod.nativePlan).not.toBe(planA);
    expect(disposedA).toBe(1);
  } finally {
    registerNativeBackend(null);
    expect(S.parseJson('{"source":"cleanup"}')).toEqual({ source: "cleanup" });
    expect(disposedB).toBe(1);
    registerNativeBackend(original);
  }
});

test("validation throw disposes the plan and falls back", () => {
  const S = z.object({ a: z.string() });
  const original = getNativeBackend();
  let disposeCalls = 0;
  const fake: NativeBackend = {
    compile: () => createNativePlanRef(
      () => {
        throw new Error("validation failed");
      },
      () => {
        disposeCalls += 1;
      },
    ),
  };
  registerNativeBackend(fake);

  try {
    expect(S.parseJson('{"a":"value"}')).toEqual({ a: "value" });
    expect(S._zod.nativePlan).toBe(null);
    expect(disposeCalls).toBe(1);
  } finally {
    registerNativeBackend(original);
  }
});
