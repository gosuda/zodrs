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

describe("JSON Schema required follows the shared optionality table", () => {
  const required = (schema: z.ZodType, io: "input" | "output") =>
    (z.toJSONSchema(z.object({ x: schema }), { io }) as { required?: string[] }).required ?? [];

  test.each([
    // optin/optout both undefined — required in both directions.
    ["required both", () => z.promise(z.string().optional()), ["x"], ["x"]],
    // a discunion of plain objects carries no optional option.
    [
      "required both",
      () => z.discriminatedUnion("k", [z.object({ k: z.literal("a") }), z.object({ k: z.literal("b") })]),
      ["x"],
      ["x"],
    ],
    // input-optional but output-materialized: optional out, required in.
    ["io-split", () => z.string().default("d"), [], ["x"]],
    ["io-split", () => z.preprocess((v) => v, z.string()), [], ["x"]],
    // catch delegates optout to the inner optional.
    ["optional both", () => z.string().optional().catch("c"), [], []],
    ["optional both", () => z.union([z.string().optional(), z.string()]), [], []],
    // an optional OPTION inside a discunion still flips the flag.
    [
      "optional both",
      () => z.discriminatedUnion("k", [z.object({ k: z.literal("a") }), z.optional(z.object({ k: z.literal("b") }))]),
      [],
      [],
    ],
  ])("%s: %s", (_label, build, inReq, outReq) => {
    expect(required(build(), "input")).toEqual(inReq);
    expect(required(build(), "output")).toEqual(outReq);
  });

  test("cyclic lazy shapes still answer required without overflowing", () => {
    let U: z.ZodType = z.string();
    const L = z.lazy(() => U);
    U = z.union([L, z.string().optional()]);
    expect(required(U, "input")).toEqual([]);
    expect(required(L, "input")).toEqual([]);
  });
});

describe("introspection tables match zod exactly", () => {
  test("readonly delegates propValues; default/prefault/catch do not", () => {
    const O = z.object({ k: z.literal("a") });
    // Zod defines propValues on object/readonly/pipe/lazy/discunion only.
    expect(O.readonly()._zod.propValues).toBeDefined();
    expect(O.pipe(z.object({ k: z.literal("b") }))._zod.propValues).toBeDefined();
    expect(z.lazy(() => O)._zod.propValues).toBeDefined();
    // default/prefault/catch carry no propValues in Zod — delegating inner
    // would wrongly expose the inner object's map.
    expect(O.default({ k: "a" })._zod.propValues).toBeUndefined();
    expect(O.prefault({ k: "a" })._zod.propValues).toBeUndefined();
    expect(O.catch({ k: "a" })._zod.propValues).toBeUndefined();
  });

  test("readonly has no pattern; optional(nullable) chains still compose", () => {
    const S = z.string();
    // $ZodReadonly defines no _zod.pattern — it must not borrow inner's.
    expect(S.readonly()._zod.pattern).toBeUndefined();
    expect(S.optional()._zod.pattern).toBeInstanceOf(RegExp);
    expect(S.nullable()._zod.pattern).toBeInstanceOf(RegExp);
  });

  test("templateLiteral rejects a readonly part like zod", () => {
    expect(() => z.templateLiteral([z.string().readonly()])).toThrow(/regex pattern/);
  });

  test("void has no values; undefined keeps {undefined}", () => {
    expect(z.void()._zod.values).toBeUndefined();
    expect(z.undefined()._zod.values?.has(undefined)).toBe(true);
    expect(z.nan()._zod.values).toBeUndefined();
  });

  test("discriminatedUnion rejects default/prefault/catch-wrapped options on parse", () => {
    const A = z.object({ k: z.literal("a") });
    const B = z.object({ k: z.literal("b") });
    // Zod defers the rejection to first dispatch access (util.cached); zodrs
    // records invalidOptionIndex at construction and throws at parse — same
    // deferred verdict, identical message.
    for (const wrap of [() => A.default({ k: "a" }), () => A.prefault({ k: "a" }), () => A.catch({ k: "a" })]) {
      const d = z.discriminatedUnion("k", [wrap() as z.ZodType, B]);
      expect(() => d.parse({ k: "a" })).toThrow(/Invalid discriminated union option at index "0"/);
    }
    // readonly/pipe/lazy options still dispatch.
    expect(z.discriminatedUnion("k", [A.readonly(), B]).parse({ k: "a" })).toEqual({ k: "a" });
  });

  test("catch/exactOptional wrappers delegate the transforming scrub on io=input", () => {
    const ex = { examples: ["x"] };
    const jsonOf = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
    // A transform through a value-preserving wrapper still transforms — input
    // schemas drop output-shaped examples/default exactly like the bare pipe.
    expect(jsonOf(z.string().transform((v) => v).catch("c").meta(ex))).not.toHaveProperty("examples");
    expect(jsonOf(z.string().transform((v) => v).exactOptional().meta(ex))).not.toHaveProperty("examples");
    // A non-transforming wrapper keeps them.
    expect(jsonOf(z.string().catch("c").meta(ex))).toHaveProperty("examples");
  });
});
