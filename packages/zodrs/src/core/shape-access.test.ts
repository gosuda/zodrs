import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "../classic/index.js";
import { config } from "./config.js";
import { compilePlan } from "./plan.js";

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

  // A `__proto__` shape key used to vanish: the shape was built by plain
  // assignment, so the key hit the inherited setter and the field was never
  // validated at all. It is an ordinary key now.
  it("validates a declared __proto__ field", () => {
    const S = z.object({ ["__proto__"]: z.string() });
    expect(S.safeParse(JSON.parse('{"__proto__":123}')).success).toBe(false);
    expect(S.safeParse(JSON.parse('{"__proto__":"s"}')).success).toBe(true);
  });

  // zod assigns results with `result[key] = value`, so a valid `__proto__`
  // field hits the setter and disappears from its output. zodrs defines the
  // property instead and keeps the field. Recorded in docs/DIVERGENCE.md.
  it("keeps a valid __proto__ field in the output", () => {
    const S = z.object({ ["__proto__"]: z.string() });
    const parsed = S.parse(JSON.parse('{"__proto__":"s"}')) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(parsed)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toBe("s");
  });

  it("keeps a plan with a __proto__ shape key off the byte path", () => {
    expect(compilePlan(z.object({ ["__proto__"]: z.string() })._zod.node).jsonEligible).toBe(false);
  });

  // zod matches literals with `Set.has`, i.e. SameValueZero, so `-0` satisfies
  // a `0` literal. `Object.is` would reject it.
  it("accepts -0 for a 0 literal", () => {
    expect(z.literal(0).safeParse(-0).success).toBe(true);
    expect(z.object({ a: z.literal(0) }).safeParse({ a: -0 }).success).toBe(true);
    expect(z.object({ a: z.literal(0) }).safeParse({ a: 1 }).success).toBe(false);
  });
});

describe("__proto__ result writes keep own keys and the original prototype", () => {
  let wasJitless: boolean | undefined;
  beforeAll(() => {
    wasJitless = config().jitless;
    config({ jitless: true });
  });
  afterAll(() => {
    config({ jitless: wasJitless });
  });

  const assertProto = (result: Record<string, unknown>, value: unknown) => {
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(value);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  };

  it("declared async object", async () => {
    const S = z.object({ ["__proto__"]: z.string() });
    const result = (await S.parseAsync(JSON.parse('{"__proto__":"s"}'))) as Record<string, unknown>;
    assertProto(result, "s");
  });

  it("declared sync object", () => {
    const S = z.object({ ["__proto__"]: z.string() });
    const result = S.parse(JSON.parse('{"__proto__":"s"}')) as Record<string, unknown>;
    assertProto(result, "s");
  });

  it("enumerated record async", async () => {
    const S = z.record(z.enum(["__proto__", "x"]), z.string());
    const result = (await S.parseAsync(JSON.parse('{"__proto__":"s","x":"t"}'))) as Record<string, unknown>;
    assertProto(result, "s");
    expect(Object.hasOwn(result, "x")).toBe(true);
  });

  it("enumerated record sync", () => {
    const S = z.record(z.enum(["__proto__", "x"]), z.string());
    const result = S.parse(JSON.parse('{"__proto__":"s","x":"t"}')) as Record<string, unknown>;
    assertProto(result, "s");
    expect(Object.hasOwn(result, "x")).toBe(true);
  });

  it("transformed key record async", async () => {
    const S = z.record(
      z.string().transform((k) => (k === "p" ? "__proto__" : k)),
      z.string(),
    );
    const result = (await S.parseAsync({ p: "s", q: "t" })) as Record<string, unknown>;
    assertProto(result, "s");
    expect(Object.hasOwn(result, "q")).toBe(true);
  });

  it("undefined-valued declared key", () => {
    const S = z.object({ ["__proto__"]: z.undefined() });
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "__proto__", {
      value: undefined,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = S.parse(input) as Record<string, unknown>;
    assertProto(result, undefined);
  });
});
