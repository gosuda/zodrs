import { describe, expect, it } from "vitest";
import * as z from "../classic/index.js";

/**
 * Object shape steps read `input[key]` directly rather than gating the read
 * behind `Object.hasOwn`. That matches zod v4 — an inherited property is the
 * field's value — and keeps `hasOwn` off the hot path, where it cost a call
 * per field per parse.
 *
 * The cases below pin the boundary that change moved: what counts as
 * "present" when the value is `undefined`, absent, or inherited, across the
 * optional / default / nullable / catch wrappers that care about the
 * distinction. Expectations were taken from zod v4.4.3 running the same
 * inputs, so a regression here is a divergence from the oracle.
 */

const inherited = <T>(shape: T): T => Object.create(shape as object) as T;

describe("object shape property access", () => {
  it("reads inherited properties as the field value", () => {
    const S = z.object({ a: z.string(), n: z.number(), b: z.boolean() });
    expect(S.safeParse(inherited({ a: "x", n: 5, b: true }))).toEqual({
      success: true,
      data: { a: "x", n: 5, b: true },
    });
  });

  it("reports the inherited value's type when it is wrong", () => {
    const S = z.object({ a: z.string() });
    const r = S.safeParse(inherited({ a: 123 }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.message).toBe("Invalid input: expected string, received number");
  });

  it("keeps an absent optional key out of the output", () => {
    const S = z.object({ a: z.string().optional() });
    expect(Object.keys(S.parse({}))).toEqual([]);
  });

  it("keeps an explicitly undefined optional key in the output", () => {
    const S = z.object({ a: z.string().optional() });
    expect(Object.keys(S.parse({ a: undefined }))).toEqual(["a"]);
  });

  it("applies a default for an absent key but not for an inherited one", () => {
    const S = z.object({ a: z.string().default("d") });
    expect(S.parse({})).toEqual({ a: "d" });
    expect(S.parse(inherited({ a: "p" }))).toEqual({ a: "p" });
  });

  it("suppresses check failures only when the optional key is truly absent", () => {
    const S = z.object({ a: z.string().min(3).optional() });
    expect(S.safeParse({}).success).toBe(true);
    // Present or inherited, a failing check reports: the key has a value.
    expect(S.safeParse({ a: "x" }).success).toBe(false);
    expect(S.safeParse(inherited({ a: "x" })).success).toBe(false);
  });

  it("rejects undefined for a nullable field but accepts null", () => {
    const S = z.object({ a: z.string().nullable() });
    expect(S.parse({ a: null })).toEqual({ a: null });
    expect(S.safeParse({}).success).toBe(false);
  });

  // A shape key naming an Object.prototype member resolves through the
  // prototype on any plain object, so `{}` already supplies a function for
  // `constructor`. The byte path cannot see that, which is why `compilePlan`
  // marks such a plan ineligible.
  it("resolves an Object.prototype shape key through the prototype", () => {
    const S = z.object({ constructor: z.string() });
    const r = S.safeParse({});
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.message).toBe("Invalid input: expected string, received function");
  });
});
