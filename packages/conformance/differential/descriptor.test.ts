import { describe, expect, test } from "vitest";
import { isNativeAvailable } from "zodrs/core";
import { buildSchema, type Descriptor } from "./descriptor.js";
import { compareResults, runBoth } from "./compare.js";

const encoder = new TextEncoder();

const eligibleCases: readonly (readonly [string, Descriptor])[] = [
  ["coerced string", { k: "string", checks: [], coerce: true }],
  ["coerced number", { k: "number", checks: [], coerce: true }],
  ["coerced boolean", { k: "boolean", coerce: true }],
  ["any", { k: "any" }],
  ["unknown", { k: "unknown" }],
  ["object catchall", {
    k: "object",
    mode: "strip",
    shape: [["known", { k: "string", checks: [] }]],
    catchall: { k: "number", checks: [] },
  }],
  ["tuple rest", {
    k: "tuple",
    items: [{ k: "string", checks: [] }],
    rest: { k: "number", checks: [] },
  }],
  ["partial record", {
    k: "partialRecord",
    keys: ["left", "right"],
    value: { k: "boolean" },
  }],
  ["exact optional", { k: "exactOptional", inner: { k: "string", checks: [] } }],
  ["nonoptional", { k: "nonoptional", inner: { k: "string", checks: [] } }],
  ["scalar default", { k: "default", inner: { k: "string", checks: [] }, value: "default" }],
  ["scalar prefault", { k: "prefault", inner: { k: "string", checks: [] }, value: "prefault" }],
  ["scalar catch", { k: "catch", inner: { k: "string", checks: [] }, value: "catch" }],
  ["template literal", { k: "templateLiteral", prefix: "id-", suffix: "-end" }],
  ["acyclic lazy", { k: "lazy", inner: { k: "string", checks: [] } }],
];

const parityCases: readonly (readonly [string, Descriptor, string])[] = [
  ["missing coerced property", {
    k: "object",
    mode: "strip",
    shape: [["value", { k: "string", checks: [], coerce: true }]],
    catchall: null,
  }, "{}"],
  ["template literal receives an object", { k: "templateLiteral", prefix: "id-", suffix: "-end" }, "{}"],
  ["partial record rejects an unknown key once", {
    k: "partialRecord",
    keys: ["known"],
    value: { k: "object", mode: "strip", shape: [], catchall: null },
  }, '{"extra":null}'],
  ["number coercion reports NaN", { k: "number", checks: [], coerce: true }, '"not-a-number"'],
  ["string coercion rewrites null", { k: "string", checks: [], coerce: true }, "null"],
  ["boolean coercion rewrites null", { k: "boolean", coerce: true }, "null"],
  ["nonoptional preserves an inner union failure", {
    k: "object",
    mode: "strip",
    shape: [["value", {
      k: "nonoptional",
      inner: {
        k: "union",
        options: [
          { k: "record", value: { k: "string", checks: [] } },
          { k: "number", checks: [], coerce: true },
        ],
      },
    }]],
    catchall: null,
  }, "{}"],
  ["nullable number coercion reports NaN for a missing property", {
    k: "object",
    mode: "strip",
    shape: [["value", {
      k: "nullable",
      inner: { k: "number", checks: [], coerce: true },
    }]],
    catchall: null,
  }, "{}"],
  ["invalid prefault loses to a later union branch", {
    k: "object",
    mode: "strip",
    shape: [["value", {
      k: "union",
      options: [
        {
          k: "object",
          mode: "strip",
          shape: [["code", {
            k: "prefault",
            inner: { k: "string", checks: [{ c: "regex", src: "^\\d{2,4}$" }] },
            value: "fallback",
          }]],
          catchall: null,
        },
        { k: "boolean", coerce: true },
      ],
    }]],
    catchall: null,
  }, '{"value":{}}'],
  ["exact optional materializes a missing coerced value", {
    k: "object",
    mode: "strip",
    shape: [["value", {
      k: "exactOptional",
      inner: { k: "string", checks: [], coerce: true },
    }]],
    catchall: null,
  }, "{}"],
  ["exact optional swallows a missing inner failure", {
    k: "object",
    mode: "strip",
    shape: [["value", {
      k: "exactOptional",
      inner: { k: "string", checks: [] },
    }]],
    catchall: null,
  }, "{}"],
];

describe("expanded differential descriptors", () => {
  test.each(eligibleCases)("%s compiles to the native byte path", (_name, descriptor) => {
    const schema = buildSchema(descriptor);
    expect(schema._zod.plan.jsonEligible).toBe(true);
    expect(schema._zod.plan.hostFns).toHaveLength(0);
  });

  const maybeParityTest = isNativeAvailable() ? test : test.skip;
  maybeParityTest.each(parityCases)("%s matches the TypeScript path", (_name, descriptor, json) => {
    const comparison = compareResults(runBoth(buildSchema(descriptor), encoder.encode(json)));
    expect(comparison).toEqual({ match: true, diffTag: null, detail: null });
  });

  test("supported fallback wrappers replace the inert upstream coalesce sample", () => {
    expect(buildSchema({ k: "default", inner: { k: "string", checks: [] }, value: "default" }).parse(undefined)).toBe("default");
    expect(buildSchema({ k: "prefault", inner: { k: "string", checks: [] }, value: "prefault" }).parse(undefined)).toBe("prefault");
    expect(buildSchema({ k: "catch", inner: { k: "string", checks: [] }, value: "catch" }).parse(42)).toBe("catch");
  });
});
