import { describe, expect, it } from "vitest";
import * as z from "../classic/index.js";

/**
 * `origin` on `not_multiple_of` and `invalid_format` issues.
 *
 * Both codes carry it in zod v4 (`checks.ts` pushes `origin: typeof value`
 * for multipleOf; `$ZodIssueInvalidStringFormat` declares `origin: "string"`),
 * and the differential fuzz previously excused 108 cases where one of our two
 * paths dropped it — the TS path on `not_multiple_of`, the Rust path on a
 * regex `invalid_format`. The excuse is gone, so these pin the field on both
 * paths at once: an issue from bytes and an issue from a value must agree.
 */

const enc = new TextEncoder();

const bothPaths = (schema: { safeParse: (v: unknown) => unknown; safeParseJson: (b: Uint8Array) => unknown }, text: string) => {
  type R = { success: boolean; error?: { issues: Record<string, unknown>[] } };
  const fromValue = schema.safeParse(JSON.parse(text)) as R;
  const fromBytes = schema.safeParseJson(enc.encode(text)) as R;
  return { value: fromValue.error?.issues ?? [], bytes: fromBytes.error?.issues ?? [] };
};

describe("issue origin parity", () => {
  it("reports origin on not_multiple_of from both paths", () => {
    const { value, bytes } = bothPaths(z.number().multipleOf(10), "-0.5");
    expect(value[0]).toMatchObject({ code: "not_multiple_of", origin: "number", divisor: 10 });
    expect(bytes[0]).toMatchObject({ code: "not_multiple_of", origin: "number", divisor: 10 });
  });

  it("reports origin on a nested not_multiple_of from both paths", () => {
    const { value, bytes } = bothPaths(z.array(z.number().multipleOf(10)), "[-0.5]");
    expect(value[0]).toMatchObject({ code: "not_multiple_of", origin: "number", path: [0] });
    expect(bytes[0]).toMatchObject({ code: "not_multiple_of", origin: "number", path: [0] });
  });

  it("reports origin on a regex invalid_format from both paths", () => {
    const { value, bytes } = bothPaths(z.string().regex(/^[A-Z][a-z]*$/), '"flip"');
    expect(value[0]).toMatchObject({ code: "invalid_format", origin: "string", format: "regex" });
    expect(bytes[0]).toMatchObject({ code: "invalid_format", origin: "string", format: "regex" });
  });

  it("reports origin on a nested regex invalid_format from both paths", () => {
    const { value, bytes } = bothPaths(z.object({ e: z.array(z.string().regex(/^[A-Z][a-z]*$/)) }), '{"e":["flip"]}');
    expect(value[0]).toMatchObject({ code: "invalid_format", origin: "string", path: ["e", 0] });
    expect(bytes[0]).toMatchObject({ code: "invalid_format", origin: "string", path: ["e", 0] });
  });

  it("keeps the two paths field-identical on these codes", () => {
    for (const [schema, text] of [
      [z.number().multipleOf(10), "-0.5"],
      [z.string().regex(/^[A-Z][a-z]*$/), '"flip"'],
      [z.string().email(), '"nope"'],
      [z.string().startsWith("x"), '"nope"'],
    ] as const) {
      const { value, bytes } = bothPaths(schema, text);
      const keys = (issues: Record<string, unknown>[]) => issues.map((i) => Object.keys(i).sort().join(","));
      expect(keys(bytes)).toEqual(keys(value));
    }
  });
});
