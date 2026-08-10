import { describe, expect, it } from "vitest";
import {
  array,
  bigint,
  coerce,
  int,
  number,
  object,
  string,
  type SomeType,
} from "../classic/schemas.js";
import { compilePlan } from "./plan.js";
import * as z from "../classic/index.js";

describe("compilePlan", () => {
  it("emits the exact flat four-node object plan", () => {
    const schema = object({
      a: string().min(3),
      b: array(int()),
    });

    expect(compilePlan(schema._zod.node)).toEqual({
      json: JSON.stringify([
        {
          k: "object",
          keys: ["a", "b"],
          values: [1, 2],
          optional: [false, false],
          mode: "strip",
          catchall: null,
        },
        { k: "string", checks: [{ c: "min_length", v: 3 }] },
        { k: "array", element: 3, checks: [] },
        { k: "number", checks: [{ c: "number_format", v: "safeint" }] },
      ]),
      hostFns: [],
      jsonEligible: true,
      objectShapeKeys: ["a", "b"],
    });
  });

  // A bigint parses to a JS `BigInt`, which JSON cannot encode: the Rust walk
  // would hand back a `number` and would compare against bounds the plan
  // carries as decimal strings, silently accepting out-of-range input. The
  // node must therefore never reach the byte path.
  it("marks any plan containing a bigint node ineligible for the byte path", () => {
    expect(compilePlan(bigint()._zod.node).jsonEligible).toBe(false);
    expect(compilePlan(coerce.bigint()._zod.node).jsonEligible).toBe(false);
    // Nested, not just at the root.
    expect(compilePlan(object({ id: coerce.bigint() })._zod.node).jsonEligible).toBe(false);
    expect(compilePlan(array(bigint())._zod.node).jsonEligible).toBe(false);
    // The sibling primitives stay eligible, so the rule is not over-broad.
    expect(compilePlan(object({ n: number(), s: string() })._zod.node).jsonEligible).toBe(true);
  });

  const ineligibleCases: [string, () => SomeType][] = [
    // refinements/checks on object, boolean, tuple, union
    ["object with .refine", () => z.object({ a: z.string() }).refine(() => true)],
    ["object with .check", () => z.object({ a: z.string() }).check(z.check(() => {}))],
    ["boolean with .refine", () => z.boolean().refine(() => true)],
    ["boolean with .check", () => z.boolean().check(z.check(() => {}))],
    ["tuple with .refine", () => z.tuple([z.string()]).refine(() => true)],
    ["tuple with .check", () => z.tuple([z.string()]).check(z.check(() => {}))],
    ["union with .refine", () => z.union([z.string(), z.number()]).refine(() => true)],
    ["union with .check", () => z.union([z.string(), z.number()]).check(z.check(() => {}))],

    // node/check custom errors and abort/when/path metadata
    ["node-level custom error", () => z.string({ message: "bad" })],
    ["check-level custom error", () => z.string().refine(() => true, { message: "bad" })],
    ["check with abort", () => z.string().refine(() => true, { abort: true })],
    ["check with when", () => z.string().refine(() => true, { when: () => true })],
    ["check with path", () => z.string().refine(() => true, { path: ["foo"] })],
    ["check with params", () => z.string().refine(() => true, { params: { a: 1 } })],

    // property check
    ["property check on string", () => z.string().check(z.property("length", z.number().min(5)))],
    ["property check on any", () => z.any().check(z.property("a", z.string()))],

    // non-JSON literals
    ["literal bigint", () => z.literal(BigInt(1))],
    ["literal undefined", () => z.literal(undefined)],
    ["literal symbol", () => z.literal(Symbol())],
    ["literal NaN", () => z.literal(NaN)],
    ["literal Infinity", () => z.literal(Infinity)],
    ["literal -0", () => z.literal(-0)],

    // unwireable node kinds
    ["date schema", () => z.date()],
    ["file schema", () => z.file()],
    ["map schema", () => z.map(z.string(), z.string())],
    ["set schema", () => z.set(z.string())],
    ["symbol schema", () => z.symbol()],
    ["nan schema", () => z.nan()],
    ["promise schema", () => z.promise(z.string())],
    ["intersection schema", () => z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))],
    ["readonly wrapper", () => z.string().readonly()],
    ["pipe schema", () => z.string().pipe(z.number())],

    // record shapes that cannot be wired
    ["exhaustive record", () => z.record(z.literal("a"), z.string())],
    ["loose record", () => z.looseRecord(z.string(), z.string())],

    // union variants
    ["xor union", () => z.xor([z.string(), z.number()])],
    ["discriminated union with fallback", () =>
      z.discriminatedUnion(
        "kind",
        [z.object({ kind: z.literal("a") }), z.object({ kind: z.literal("b") })],
        { unionFallback: true },
      )],
    ["discriminated union with invalid option", () =>
      z.discriminatedUnion(
        "kind",
        [z.object({ kind: z.literal("a") }), z.object({ other: z.string() })],
      )],

    // dynamic and non-JSON static defaults/prefaults/catch
    ["dynamic default", () => z.string().default(() => "x")],
    ["dynamic prefault", () => z.string().prefault(() => "x")],
    ["dynamic catch", () => z.string().catch(() => "x")],
    ["mutable object static default", () => z.object({ x: z.number() }).default({ x: 1 })],
    ["mutable array static prefault", () => z.array(z.number()).prefault([1])],
    ["mutable object static catch", () => z.object({ x: z.number() }).catch({ x: 1 })],
    ["non-JSON static default", () => z.any().default(new Date())],
    ["non-JSON static prefault", () => z.any().prefault(NaN)],
    ["non-JSON static catch", () => z.any().catch(Symbol())],

    // format params carrying non-JSON values or cycles
    [
      "format check with non-JSON params",
      () => z.string().check(z.format("url", undefined, { hostname: /x/ })),
    ],
    [
      "format check with cyclic params",
      () => {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        return z.string().check(z.format("url", undefined, cyclic));
      },
    ],
  ];

  it.each(ineligibleCases)("%s is ineligible for the byte path", (name, factory) => {
    expect(() => compilePlan(factory()._zod.node)).not.toThrow();
    const plan = compilePlan(factory()._zod.node);
    expect(plan.jsonEligible).toBe(false);
  });

  const eligibleCases: [string, () => SomeType][] = [
    ["plain object", () => z.object({ a: z.string(), b: z.number() })],
    ["plain string", () => z.string()],
    ["plain number", () => z.number()],
    ["plain array", () => z.array(z.string())],
    ["plain tuple", () => z.tuple([z.string(), z.number()])],
    ["plain union", () => z.union([z.string(), z.number()])],
    [
      "plain discriminated union",
      () =>
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), a: z.string() }),
          z.object({ kind: z.literal("b"), b: z.number() }),
        ]),
    ],
    ["non-exhaustive record", () => z.record(z.string(), z.string())],
    ["optional wrapper", () => z.string().optional()],
    ["exactOptional wrapper", () => z.string().exactOptional()],
    ["nullable wrapper", () => z.string().nullable()],
    ["nonoptional wrapper", () => z.string().optional().nonoptional()],
    ["lazy schema", () => z.lazy(() => z.string())],
    ["static JSON default", () => z.string().default("fallback")],
    ["template literal", () => z.templateLiteral(["foo", "bar"])],
  ];

  it.each(eligibleCases)("%s remains eligible for the byte path", (name, factory) => {
    expect(() => compilePlan(factory()._zod.node)).not.toThrow();
    const plan = compilePlan(factory()._zod.node);
    expect(plan.jsonEligible).toBe(true);
  });

  it("does not throw for a cyclic static default value", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => compilePlan(z.any().default(cycle)._zod.node)).not.toThrow();
    const plan = compilePlan(z.any().default(cycle)._zod.node);
    expect(plan.jsonEligible).toBe(false);
  });
});
