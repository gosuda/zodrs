import { describe, expect, it } from "vitest";
import { array, bigint, coerce, int, number, object, string } from "../classic/schemas.js";
import { compilePlan } from "./plan.js";

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
});
