import { describe, expect, it } from "vitest";
import * as z from "../classic/index.js";

describe("direct scalar parse", () => {
  it("runs checks on otherwise valid strings and numbers", () => {
    let stringChecks = 0;
    let numberChecks = 0;
    const stringSchema = z.string().superRefine(() => {
      stringChecks += 1;
    });
    const numberSchema = z.number().superRefine(() => {
      numberChecks += 1;
    });

    expect(stringSchema.parse("value")).toBe("value");
    expect(numberSchema.parse(42)).toBe(42);
    expect(stringChecks).toBe(1);
    expect(numberChecks).toBe(1);
  });

  it("rejects non-finite direct numbers", () => {
    expect(() => z.number().parse(Number.NaN)).toThrow();
    expect(() => z.number().parse(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => z.number().parse(Number.NEGATIVE_INFINITY)).toThrow();
  });

  it("keeps reflective prototype access lazy", () => {
    const descriptor = Object.getOwnPropertyDescriptor(z.ZodType.prototype, "parse");
    expect(typeof z.ZodType.prototype.parse).toBe("function");
    expect(Object.getOwnPropertyDescriptor(z.ZodType.prototype, "parse")).toEqual(descriptor);
  });
});
