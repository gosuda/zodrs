import { expect, test } from "vitest";
import {
  compareResults,
  exactDataEqual,
  issuePayloadEqual,
  type BothResults,
} from "./compare.js";

// ---------------------------------------------------------------------------
// Exact parsed-data comparison: every own enumerable key matters, including
// keys whose value is undefined. These tests directly pin the H7 pre-fix bug:
// the old `deepEqual` filtered undefined-valued keys for *all* objects, so
// `{}` and `{ a: undefined }` compared equal in parsed output.
// ---------------------------------------------------------------------------

test("exactDataEqual distinguishes {} from { a: undefined } in both directions", () => {
  const empty = {};
  const withUndefined = { a: undefined };

  const forward = exactDataEqual(empty, withUndefined, "$");
  expect(forward.eq).toBe(false);
  expect(forward.at ?? "").toContain("a");

  const reverse = exactDataEqual(withUndefined, empty, "$");
  expect(reverse.eq).toBe(false);
  expect(reverse.at ?? "").toContain("a");
});

test("exactDataEqual detects a nested undefined-valued key", () => {
  const a = { x: { a: undefined } };
  const b = { x: {} };

  const sub = exactDataEqual(a, b, "$");
  expect(sub.eq).toBe(false);
  expect(sub.at ?? "").toContain("x");
  expect(sub.at ?? "").toContain("a");
});

// ---------------------------------------------------------------------------
// Issue-payload comparison: undefined-valued keys are still treated as absent,
// matching the TS/Rust issue-construction sites. This preserves the old parity
// behavior where `optional: undefined` and an absent `optional` are equivalent.
// ---------------------------------------------------------------------------

test("issuePayloadEqual treats undefined payload fields as absent", () => {
  const withOptional = { code: "x", path: ["a"], optional: undefined };
  const withoutOptional = { code: "x", path: ["a"] };
  const bothWithOptional = { code: "x", path: ["a"], optional: undefined };

  expect(issuePayloadEqual(withOptional, withoutOptional, "$")).toEqual({ eq: true });
  expect(issuePayloadEqual(withoutOptional, withOptional, "$")).toEqual({ eq: true });
  expect(issuePayloadEqual(withOptional, bothWithOptional, "$")).toEqual({ eq: true });
});

// ---------------------------------------------------------------------------
// compareResults: success data uses exact mode, failure issues use issue mode.
// ---------------------------------------------------------------------------

test("compareResults uses exact mode for success data", () => {
  const both: BothResults = {
    refThrew: null,
    ref: { success: true, data: { a: undefined } },
    nativeThrew: null,
    native: { success: true, data: {} },
  };

  const cmp = compareResults(both);
  expect(cmp.match).toBe(false);
  expect(cmp.diffTag).toBe("data");
  expect(cmp.detail ?? "").toContain("data differ");
  expect(cmp.detail ?? "").toContain("a");
});

test("compareResults uses issue mode for failure issue payloads", () => {
  const both: BothResults = {
    refThrew: null,
    ref: {
      success: false,
      error: {
        issues: [{ code: "too_small", origin: "string", minimum: 3, inclusive: undefined, path: ["a"] }],
      },
    },
    nativeThrew: null,
    native: {
      success: false,
      error: {
        issues: [{ code: "too_small", origin: "string", minimum: 3, path: ["a"] }],
      },
    },
  };

  const cmp = compareResults(both);
  expect(cmp.match).toBe(true);
  expect(cmp.diffTag).toBeNull();
  expect(cmp.detail).toBeNull();
});

// ---------------------------------------------------------------------------
// Unchanged comparator semantics: NaN, -0, arrays, and throw parity.
// ---------------------------------------------------------------------------

test("NaN, -0, and array comparisons remain unchanged", () => {
  // NaN == NaN in both modes.
  expect(exactDataEqual(NaN, NaN, "$")).toEqual({ eq: true });
  expect(issuePayloadEqual(NaN, NaN, "$")).toEqual({ eq: true });

  // 0 and -0 are distinct and the report preserves -0.
  const zeroVsNegZero = exactDataEqual(0, -0, "$");
  expect(zeroVsNegZero.eq).toBe(false);
  expect(zeroVsNegZero.at ?? "").toContain("__-0__");

  // Arrays are compared element-wise, length-first.
  expect(exactDataEqual([1, 2, 3], [1, 2, 3], "$")).toEqual({ eq: true });

  // Arrays of objects with undefined keys use the same exact semantics.
  expect(
    exactDataEqual([1, { a: undefined }], [1, { a: undefined }], "$"),
  ).toEqual({ eq: true });
  expect(
    exactDataEqual([1, {}], [1, { a: undefined }], "$").eq,
  ).toBe(false);
});

test("compareResults throw parity is unchanged", () => {
  const bothThrow: BothResults = {
    refThrew: "SyntaxError",
    ref: null,
    nativeThrew: "SyntaxError: Unexpected token",
    native: null,
  };
  expect(compareResults(bothThrow)).toEqual({ match: true, diffTag: null, detail: null });

  const refThrewNativeResult: BothResults = {
    refThrew: "SyntaxError",
    ref: null,
    nativeThrew: null,
    native: { success: true, data: 1 },
  };
  const mismatch = compareResults(refThrewNativeResult);
  expect(mismatch.match).toBe(false);
  expect(mismatch.diffTag).toBe("ref-threw-vs-native-result");

  const nativeThrewOther: BothResults = {
    refThrew: null,
    ref: { success: true, data: 1 },
    nativeThrew: "TypeError: something failed",
    native: null,
  };
  const thrown = compareResults(nativeThrewOther);
  expect(thrown.match).toBe(false);
  expect(thrown.diffTag).toBe("native-threw:TypeError");
});
