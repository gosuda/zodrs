import { afterEach, describe, expect, test } from "vitest";
import * as z from "../classic/index.js";
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
});
