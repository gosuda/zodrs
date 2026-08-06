import { describe, expect, it } from "vitest";
import { array, int, number, object, string } from "../classic/schemas.js";
import { compilePlan } from "./plan.js";

describe("compilePlan", () => {
  it("emits the exact flat four-node object plan", () => {
    const schema = object({
      a: string().min(3),
      b: array(number().check(int())),
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
    });
  });
});
