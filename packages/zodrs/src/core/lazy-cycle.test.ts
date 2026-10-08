import { afterEach, describe, expect, test } from "vitest";
import * as z from "../classic/index.js";
import * as zm from "../mini/index.js";
import { config } from "./config.js";

const originalJitless = config().jitless;

afterEach(() => {
  config({ jitless: originalJitless });
});

describe.each([
  ["codegen", false],
  ["interpreter", true],
] as const)("cyclic lazy input with %s", (_mode, jitless) => {
  test("matches Zod's RangeError termination", () => {
    config({ jitless });

    let A: z.ZodType;
    let B: z.ZodType;
    A = z.object({ b: z.lazy(() => B) });
    B = z.object({ a: z.lazy(() => A) });

    const a: { b?: object } = {};
    const b: { a?: object } = {};
    a.b = b;
    b.a = a;

    expect(() => A.parse(a)).toThrow(RangeError);
  });

  test("still crashes parsing a missing cyclic-union field", () => {
    config({ jitless });

    let U: z.ZodType;
    const L = z.lazy(() => U);
    U = z.union([L, z.string().optional()]);

    // Introspection answers U.optin/optout as "optional", but object fields
    // always run their schema before the flags can squash issues (matching
    // Zod's always-parse semantics) — the cyclic union itself never returns.
    expect(() => z.object({ x: U }).parse({})).toThrow(RangeError);
  });

  test("still crashes parsing a purely cyclic union field", () => {
    config({ jitless });

    let U: z.ZodType;
    const L = z.lazy(() => U);
    U = z.union([L, z.string()]);

    expect(() => z.object({ x: U }).parse({})).toThrow(RangeError);
  });
});

describe("cyclic lazy introspection", () => {
  test("optin/optout answer through a cyclic union with an optional branch", () => {
    let U: z.ZodType;
    const L = z.lazy(() => U);
    U = z.union([L, z.string().optional()]);

    // Zod answers "optional" here via defineLazy's re-entrant-read guard;
    // unguarded recursion overflows instead.
    expect(U._zod.optin).toBe("optional");
    expect(U._zod.optout).toBe("optional");
    expect(L._zod.optin).toBe("optional");
    expect(L._zod.optout).toBe("optional");
  });

  test("optin/optout stay required on a purely cyclic union", () => {
    let U: z.ZodType;
    const L = z.lazy(() => U);
    U = z.union([L, z.string()]);

    expect(U._zod.optin).toBeUndefined();
    expect(U._zod.optout).toBeUndefined();
    expect(L._zod.optin).toBeUndefined();
    expect(L._zod.optout).toBeUndefined();
  });

  test("optin/optout terminate on lazy-to-lazy cycles", () => {
    let L2: z.ZodType;
    const L1 = z.lazy(() => L2);
    L2 = z.lazy(() => L1);

    expect(L1._zod.optin).toBeUndefined();
    expect(L1._zod.optout).toBeUndefined();
    expect(L1._zod.values).toBeUndefined();
    expect(L1._zod.propValues).toBeUndefined();
  });

  test("lazy still delegates optionality through the guard", () => {
    expect(z.lazy(() => z.string().optional())._zod.optin).toBe("optional");
    expect(z.lazy(() => z.string().optional())._zod.optout).toBe("optional");
  });

  test("default/prefault are input-optional but never output-absent", () => {
    // Zod leaves optout undefined on default/prefault rather than delegating:
    // the materialized output is never absent.
    expect(z.string().optional().default("x")._zod.optin).toBe("optional");
    expect(z.string().optional().default("x")._zod.optout).toBeUndefined();
    expect(z.string().optional().prefault("x")._zod.optin).toBe("optional");
    expect(z.string().optional().prefault("x")._zod.optout).toBeUndefined();
    // catch keeps delegating its output optionality to the inner schema.
    expect(z.string().optional().catch("x")._zod.optout).toBe("optional");
    // nullable/readonly delegate both directions.
    expect(z.string().optional().nullable()._zod.optin).toBe("optional");
    expect(z.string().optional().nullable()._zod.optout).toBe("optional");
  });

  test("mini surface shares the same table", () => {
    // promise is required in both directions (Zod defines no flag on it).
    expect(zm.promise(zm.optional(zm.string()))._zod.optin).toBeUndefined();
    expect(zm.promise(zm.optional(zm.string()))._zod.optout).toBeUndefined();
    // a preprocess pipe reads its transform head's optin.
    expect(zm.preprocess((x) => x, zm.string())._zod.optin).toBe("optional");
    // default/prefault are input-optional, never output-absent.
    expect(zm.prefault(zm.optional(zm.string()), "x")._zod.optout).toBeUndefined();

    let U: zm.ZodMiniType;
    const L = zm.lazy(() => U);
    U = zm.union([L, zm.optional(zm.string())]);
    expect(U._zod.optin).toBe("optional");
    expect(U._zod.optout).toBe("optional");
    expect(L._zod.optin).toBe("optional");
  });
});
