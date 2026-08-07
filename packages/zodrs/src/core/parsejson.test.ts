import { expect, test } from "vitest";
import * as z from "../classic/index.js";

/**
 * parseJson byte-path divergences surfaced by the differential fuzz. These
 * exercise the native status-3 fallback (K1), reportInput gating (K2), and
 * nested union sub-issue back-fill (K3). parseJson is zodrs-only, so this has
 * no corpus coverage — behaviors asserted here mirror JSON.parse semantics.
 */

test("BOM input succeeds via status-3 fallback", () => {
  const S = z.object({ a: z.string() });
  const json = Array.from('{"a":"x"}', (ch) => ch.charCodeAt(0));
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
  expect(S.parseJson(bom)).toEqual({ a: "x" });
});

test("lone-surrogate escape succeeds via status-3 fallback", () => {
  const S = z.object({ a: z.string() });
  expect(S.parseJson('{"a":"\\ud800"}')).toEqual({ a: "\ud800" });
});

test("1e400 reaches the validator as Infinity via status-3 fallback", () => {
  const N = z.object({ a: z.number() });
  // sonic-rs rejects the overflowing literal, so the byte path returns
  // status 3 and the TS path re-parses: `JSON.parse` yields Infinity.
  // `z.number()` then rejects it exactly as zod v4 does. `received:
  // "Infinity"` is the proof the fallback ran — the Rust path never sees
  // the value, so it could not have produced this issue.
  const result = N.safeParseJson('{"a":1e400}');
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues).toEqual([
    expect.objectContaining({
      code: "invalid_type",
      expected: "number",
      received: "Infinity",
      path: ["a"],
    }),
  ]);
});

test("NaN literal throws SyntaxError", () => {
  const N = z.object({ a: z.number() });
  expect(() => N.parseJson('{"a":NaN}')).toThrow(SyntaxError);
});

test("truncated JSON throws SyntaxError", () => {
  const N = z.object({ a: z.number() });
  expect(() => N.parseJson('{"a":1')).toThrow(SyntaxError);
});

test("reportInput off strips input from issues", () => {
  const U = z.union([z.string(), z.number()]);
  const result = U.safeParseJson("true");
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0]?.code).toBe("invalid_union");
  expect(result.error.issues[0]?.input).toBeUndefined();
});

test("reportInput on back-fills input including nested union sub-issues", () => {
  const U = z.union([z.string(), z.number()]);
  const result = U.safeParseJson("true", { reportInput: true });
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues[0];
  expect(issue?.code).toBe("invalid_union");
  expect(issue?.input).toBe(true);
  const nested = issue?.code === "invalid_union" ? issue.errors[0]?.[0] : undefined;
  expect(nested?.input).toBe(true);
  expect(nested?.message).toBe("Invalid input: expected string, received boolean");
});

test("status-2 result issues identical to the JS path", () => {
  const User = z.object({ name: z.string().min(3), age: z.number().int().positive() });
  const bad = '{"name":"Ad","age":-1}';
  const viaBytes = User.safeParseJson(bad);
  const viaValue = User.safeParse(JSON.parse(bad));
  expect(viaBytes.success).toBe(false);
  expect(viaValue.success).toBe(false);
  if (viaBytes.success || viaValue.success) return;
  expect(viaBytes.error.issues).toEqual(viaValue.error.issues);
});
