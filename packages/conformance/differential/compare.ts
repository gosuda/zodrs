/**
 * Runs both parse paths for one (schema, bytes) pair and compares the
 * observable results.
 *
 * The reference (TS) path is `schema.safeParse(JSON.parse(decode(bytes)))`.
 * The Rust byte path is `schema.safeParseJson(bytes)`.
 *
 * Contract:
 *   - If JSON.parse throws (invalid JSON bytes), safeParseJson MUST throw a
 *     SyntaxError too — the plan requires the JS fallback to reproduce any
 *     JSON.parse SyntaxError. Throwing anything else, or returning a result,
 *     is a mismatch.
 *   - Otherwise both sides return SafeParseResults that must be deep-equal:
 *     same success flag, deep-equal data, deep-equal issue arrays including
 *     code, path, message, payload fields, and back-filled input.
 */

import type { AnySchema } from "./descriptor.js";

interface SafeParseSuccess { readonly success: true; readonly data: unknown }
interface SafeParseFailure { readonly success: false; readonly error: { issues: unknown[] } }
type SafeParseResult = SafeParseSuccess | SafeParseFailure;

export interface BothResults {
  /** Set when the TS reference's JSON.parse threw (error constructor name). */
  refThrew: string | null;
  ref: SafeParseResult | null;
  /** Set when safeParseJson threw instead of returning (error constructor name + message head). */
  nativeThrew: string | null;
  native: SafeParseResult | null;
}

export interface Comparison {
  match: boolean;
  /** Coarse tag identifying the first difference, used for signature dedup. */
  diffTag: string | null;
  /** Human-readable detail of the first difference. */
  detail: string | null;
}

const decoder = new TextDecoder();

export function runBoth(schema: AnySchema, bytes: Uint8Array): BothResults {
  let refThrew: string | null = null;
  let ref: SafeParseResult | null = null;
  try {
    ref = schema.safeParse(JSON.parse(decoder.decode(bytes))) as SafeParseResult;
  } catch (error: unknown) {
    refThrew = error instanceof Error ? error.name : "UnknownError";
  }
  let nativeThrew: string | null = null;
  let nativeResult: SafeParseResult | null = null;
  try {
    nativeResult = schema.safeParseJson(bytes) as SafeParseResult;
  } catch (error: unknown) {
    nativeThrew = error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : "UnknownError";
  }
  return { refThrew, ref, nativeThrew, native: nativeResult };
}

/** Lossy-but-faithful serializer for mismatch reports: keeps -0, NaN, Infinity, undefined. */
export function show(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "__NaN__";
      if (v === Infinity) return "__Infinity__";
      if (v === -Infinity) return "__-Infinity__";
      if (Object.is(v, -0)) return "__-0__";
    }
    if (v === undefined) return "__undefined__";
    return v;
  });
}

export interface Diff { eq: boolean; at?: string }

type CompareMode = "exact" | "issue";

/** Shared recursive core: one traversal, two key-set policies. */
function compareValues(a: unknown, b: unknown, at: string, mode: CompareMode): Diff {
  if (typeof a === "number" && typeof b === "number") {
    const eq = (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b);
    return eq ? { eq: true } : { eq: false, at: `${at} (${show(a)} vs ${show(b)})` };
  }
  if (a === b) return { eq: true };
  if (a === undefined || b === undefined) return { eq: false, at };
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return { eq: false, at: `${at} (${show(a)} vs ${show(b)})` };
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { eq: false, at };
    if (a.length !== b.length) return { eq: false, at: `${at} (length ${a.length} vs ${b.length})` };
    for (let i = 0; i < a.length; i++) {
      const sub = compareValues(a[i], b[i], `${at}[${i}]`, mode);
      if (!sub.eq) return sub;
    }
    return { eq: true };
  }

  const keysOf = (o: object) => {
    const keys = Object.keys(o);
    // Issue-payload parity: a present key whose value is undefined is treated
    // as if the key were absent, matching the TS/Rust issue-construction sites.
    if (mode === "issue") {
      return keys.filter((k) => (o as Record<string, unknown>)[k] !== undefined);
    }
    // Exact parsed-data parity: every own enumerable key counts, including
    // undefined-valued keys. This catches `{}` vs `{ a: undefined }` in output.
    return keys;
  };

  const aKeys = keysOf(a);
  const bKeys = keysOf(b);
  if (aKeys.length !== bKeys.length || !aKeys.every((k) => bKeys.includes(k))) {
    return { eq: false, at: `${at} (keys [${aKeys}] vs [${bKeys}])` };
  }
  for (const k of aKeys) {
    const sub = compareValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`, mode);
    if (!sub.eq) return sub;
  }
  return { eq: true };
}

/** Exact parsed-data comparison: all own enumerable keys, including undefined-valued keys. */
export function exactDataEqual(a: unknown, b: unknown, at: string): Diff {
  const result = compareValues(a, b, at, "exact");
  return result;
}

/** Issue-payload comparison: undefined-valued keys are treated as absent. */
export function issuePayloadEqual(a: unknown, b: unknown, at: string): Diff {
  const result = compareValues(a, b, at, "issue");
  return result;
}

export function compareResults(both: BothResults): Comparison {
  if (both.refThrew !== null) {
    // Invalid JSON bytes: the byte path must throw a SyntaxError as well.
    if (both.nativeThrew !== null && both.nativeThrew.startsWith("SyntaxError")) return { match: true, diffTag: null, detail: null };
    return {
      match: false,
      diffTag: both.nativeThrew === null ? "ref-threw-vs-native-result" : "ref-threw-vs-native-threw-other",
      detail: `JSON.parse threw ${both.refThrew}; safeParseJson ${both.nativeThrew === null ? "returned a result" : `threw ${both.nativeThrew}`}`,
    };
  }
  if (both.nativeThrew !== null) {
    return { match: false, diffTag: `native-threw:${both.nativeThrew.split(":")[0]}`, detail: `safeParseJson threw ${both.nativeThrew}; safeParse returned ${show(both.ref)}` };
  }
  const ref = both.ref as SafeParseResult;
  const native = both.native as SafeParseResult;
  if (ref.success !== native.success) {
    return { match: false, diffTag: "success-flag", detail: `ref.success=${ref.success} native.success=${native.success}` };
  }
  if (ref.success && native.success) {
    const sub = exactDataEqual(ref.data, native.data, "$");
    return sub.eq ? { match: true, diffTag: null, detail: null } : { match: false, diffTag: "data", detail: `data differ at ${sub.at}` };
  }
  const refIssues = (ref as SafeParseFailure).error.issues;
  const nativeIssues = (native as SafeParseFailure).error.issues;
  if (refIssues.length !== nativeIssues.length) {
    return {
      match: false,
      diffTag: "issues.length",
      detail: `issue count ${refIssues.length} vs ${nativeIssues.length}\nref:    ${show(refIssues)}\nnative: ${show(nativeIssues)}`,
    };
  }
  for (let i = 0; i < refIssues.length; i++) {
    const sub = issuePayloadEqual(refIssues[i], nativeIssues[i], `issues[${i}]`);
    if (!sub.eq) {
      return {
        match: false,
        diffTag: `issue:${sub.at?.replace(/[^a-zA-Z0-9[\].]/g, "").slice(0, 60)}`,
        detail: `issues differ at ${sub.at}\nref:    ${show(refIssues[i])}\nnative: ${show(nativeIssues[i])}`,
      };
    }
  }
  return { match: true, diffTag: null, detail: null };
}
