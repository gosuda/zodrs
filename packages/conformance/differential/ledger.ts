/**
 * Known-mismatch ledger.
 *
 * Confirmed backend divergences live in KNOWN-MISMATCHES.json with a skip
 * rule each. When the fuzz loop hits a mismatch it first asks the ledger to
 * classify it: a known entry is counted and skipped (the bug is already
 * routed to the orchestrator for a fix); anything else is a NEW mismatch and
 * fails the run with a full reproduction.
 *
 * Skip rules self-retire: once the backend is fixed, the predicate stops
 * firing and the formerly-skipped cases run and pass.
 */

import { readFileSync } from "node:fs";
import { deepEqual, type BothResults } from "./compare.js";
import type { FuzzCase } from "./genInput.js";

export interface LedgerEntry {
  id: string;
  title: string;
  rootCause: string;
  skip:
    | { rule: "native-threw-internal-invariant" }
    | { rule: "case-kind"; kinds: string[] }
    | { rule: "issues-equal-modulo-extra-native-fields" };
  repro: {
    schemaDescriptor: unknown;
    inputText: string;
    refOutcome: string;
    nativeOutcome: string;
  };
}

interface LedgerFile { version: number; entries: LedgerEntry[] }

const INTERNAL_INVARIANT_PREFIX = "Internal invariant: native backend received a non-JSON-eligible plan";

export function loadLedger(): LedgerEntry[] {
  const url = new URL("./KNOWN-MISMATCHES.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as LedgerFile).entries;
}

/**
 * Deep-clones a value dropping the fields the native byte path over-reports:
 * `input` everywhere (canonical zod v4 strips it unless reportInput is set)
 * and `origin` on invalid_format (the canonical issue shape has no origin).
 */
function stripOverReportedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOverReportedFields);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const noOriginCanonically = source.code === "invalid_format" || source.code === "not_multiple_of";
  for (const key of Object.keys(source)) {
    if (key === "input") continue;
    if (noOriginCanonically && key === "origin") continue;
    out[key] = stripOverReportedFields(source[key]);
  }
  return out;
}

/** Returns the ledger entry id explaining this mismatch, or null if it is new. */
export function classifyMismatch(entries: LedgerEntry[], fuzzCase: FuzzCase, both: BothResults): string | null {
  for (const entry of entries) {
    if (entry.skip.rule === "native-threw-internal-invariant") {
      if (both.nativeThrew !== null && both.nativeThrew.includes(INTERNAL_INVARIANT_PREFIX)) return entry.id;
    } else if (entry.skip.rule === "case-kind") {
      if (entry.skip.kinds.includes(fuzzCase.kind)) return entry.id;
    } else if (both.ref !== null && !both.ref.success && both.native !== null && !both.native.success) {
      const refStripped = stripOverReportedFields(both.ref.error.issues);
      const nativeStripped = stripOverReportedFields(both.native.error.issues);
      if (deepEqual(refStripped, nativeStripped, "$").eq) return entry.id;
    }
  }
  return null;
}
