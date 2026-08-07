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
import type { FuzzCase } from "./genInput.js";

export interface LedgerEntry {
  id: string;
  title: string;
  rootCause: string;
  skip: { rule: "case-kind"; kinds: string[] };
  repro: {
    schemaDescriptor: unknown;
    inputText: string;
    refOutcome: string;
    nativeOutcome: string;
  };
}

interface LedgerFile { version: number; entries: LedgerEntry[] }

export function loadLedger(): LedgerEntry[] {
  const url = new URL("./KNOWN-MISMATCHES.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as LedgerFile).entries;
}

/** Returns the ledger entry id explaining this mismatch, or null if it is new. */
export function classifyMismatch(entries: LedgerEntry[], fuzzCase: FuzzCase): string | null {
  for (const entry of entries) {
    if (entry.skip.kinds.includes(fuzzCase.kind)) return entry.id;
  }
  return null;
}
