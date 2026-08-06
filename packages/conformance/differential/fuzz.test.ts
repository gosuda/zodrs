/**
 * Differential fuzz harness (plan Verification §4).
 *
 * For every (schema, inputBytes) pair: schema.safeParseJson(bytes) — the
 * Rust byte path — must agree with schema.safeParse(JSON.parse(decode(bytes)))
 * — the TypeScript path — on the success flag, the data, and the full issue
 * array (code, path, payload fields, message, back-filled input).
 *
 * Knobs:
 *   FUZZ_CASES   — iteration count (default 100_000 per plan §4; CI pins
 *                  100k, dev runs set e.g. FUZZ_CASES=20000)
 *   FUZZ_SEED    — PRNG seed (default 0x5eed; every case derives its own
 *                  sub-seed, so a failing case index reproduces in isolation)
 *   FUZZ_MAX_NEW — distinct NEW mismatch signatures tolerated before the run
 *                  aborts early (default 3, per the assignment's stop rule;
 *                  raise only to survey the full case count while the
 *                  backend is known-broken — the test still fails at the end)
 *
 * Mismatch policy: a mismatch matching a KNOWN-MISMATCHES.json entry is
 * counted and skipped (the bug is confirmed and routed for a fix); any other
 * mismatch is NEW — up to FUZZ_MAX_NEW distinct signatures are collected
 * with full reproductions, the next distinct signature aborts the run early.
 * Any new mismatch fails the test.
 */

import { expect, test } from "vitest";
import { isNativeAvailable } from "zodrs/core";
import { compareResults, runBoth, show, type BothResults, type Comparison } from "./compare.js";
import { buildSchema, type AnySchema, type Descriptor } from "./descriptor.js";
import { genCase, type FuzzCase } from "./genInput.js";
import { genSchemaDescriptor } from "./genSchema.js";
import { classifyMismatch, loadLedger } from "./ledger.js";
import { deriveSeed, Rng } from "./prng.js";

const CASES = process.env.FUZZ_CASES === undefined ? 100_000 : Number.parseInt(process.env.FUZZ_CASES, 10);
const SEED = process.env.FUZZ_SEED === undefined ? 0x5eed : Number.parseInt(process.env.FUZZ_SEED, 10);
const MAX_NEW = process.env.FUZZ_MAX_NEW === undefined ? 3 : Number.parseInt(process.env.FUZZ_MAX_NEW, 10);
const CASES_PER_SCHEMA = 50;
const MAX_REPORT_BODIES = process.env.FUZZ_REPORT_BODIES === undefined ? 6 : Number.parseInt(process.env.FUZZ_REPORT_BODIES, 10);
const SCHEMA_SALT = 0x5c1e;
const CASE_SALT = 0xca5e;

interface NewMismatch {
  signature: string;
  caseIndex: number;
  schemaIndex: number;
  fuzzCase: FuzzCase;
  descriptor: Descriptor;
  both: BothResults;
  cmp: Comparison;
}

function formatMismatch(m: NewMismatch): string {
  const ref = m.both.refThrew === null ? show(m.both.ref) : `threw ${m.both.refThrew}`;
  const native = m.both.nativeThrew === null ? show(m.both.native) : `threw ${m.both.nativeThrew}`;
  return [
    `--- NEW MISMATCH [${m.signature}] ---`,
    `seed: ${SEED}  caseIndex: ${m.caseIndex}  schemaIndex: ${m.schemaIndex}  kind: ${m.fuzzCase.kind}`,
    `diff: ${m.cmp.detail ?? m.cmp.diffTag}`,
    `schema descriptor: ${JSON.stringify(m.descriptor)}`,
    `input text: ${JSON.stringify(m.fuzzCase.text)}`,
    `input bytes (base64): ${Buffer.from(m.fuzzCase.bytes).toString("base64")}`,
    `ref (safeParse(JSON.parse)):    ${ref}`,
    `native (safeParseJson):         ${native}`,
  ].join("\n");
}

test("safeParseJson(bytes) deep-equals safeParse(JSON.parse(bytes)) across random schemas and inputs", () => {
  expect(isNativeAvailable(), "differential project must run with the native backend registered (ZODRS_LOADER=native)").toBe(true);
  expect(Number.isFinite(CASES) && CASES > 0, `FUZZ_CASES must be a positive integer, got ${process.env.FUZZ_CASES}`).toBe(true);

  const ledger = loadLedger();
  const stats = { compared: 0, matched: 0, generatorMisses: 0, ineligibleSchemas: 0, stoppedEarly: false };
  const knownSkips = new Map<string, number>();
  const newMismatches: NewMismatch[] = [];
  const newSignatures = new Set<string>();
  const newSignatureCounts = new Map<string, number>();

  let schemaIndex = -1;
  let current: { descriptor: Descriptor; schema: AnySchema } | null = null;
  const startedAt = performance.now();

  for (let i = 0; i < CASES; i++) {
    const si = Math.floor(i / CASES_PER_SCHEMA);
    if (si !== schemaIndex || current === null) {
      schemaIndex = si;
      const descriptor = genSchemaDescriptor(deriveSeed(SEED, si, SCHEMA_SALT));
      const schema = buildSchema(descriptor);
      const internals: { readonly plan?: { readonly jsonEligible?: boolean } } = schema._zod;
      if (internals.plan?.jsonEligible === false) stats.ineligibleSchemas++;
      current = { descriptor, schema };
    }
    const { descriptor, schema } = current;
    const fc = genCase(new Rng(deriveSeed(SEED, i, CASE_SALT)), descriptor, schema);
    if (fc === null) {
      stats.generatorMisses++;
      continue;
    }
    const both = runBoth(schema, fc.bytes);
    const cmp = compareResults(both);
    stats.compared++;
    if (cmp.match) {
      stats.matched++;
    } else {
      const known = classifyMismatch(ledger, fc, both);
      if (known !== null) {
        knownSkips.set(known, (knownSkips.get(known) ?? 0) + 1);
      } else {
        const signature = `${fc.kind}|${cmp.diffTag ?? "unknown"}`;
        newSignatureCounts.set(signature, (newSignatureCounts.get(signature) ?? 0) + 1);
        if (!newSignatures.has(signature)) {
          newSignatures.add(signature);
          newMismatches.push({ signature, caseIndex: i, schemaIndex: si, fuzzCase: fc, descriptor, both, cmp });
          if (newSignatures.size > MAX_NEW) {
            stats.stoppedEarly = true;
            break;
          }
        }
      }
    }
    if ((i + 1) % Math.max(1, Math.floor(CASES / 4)) === 0) {
      console.error(`[differential] ${i + 1}/${CASES} cases, ${newSignatures.size} new mismatch signatures so far`);
    }
  }

  const wallMs = Math.round(performance.now() - startedAt);
  const knownSummary = [...knownSkips.entries()].map(([id, n]) => `${id}: ${n}`).join(", ") || "none";
  const newSummary = [...newSignatureCounts.entries()].map(([sig, n]) => `${sig}: ${n}`).join(", ") || "none";
  console.error(
    `[differential] seed=${SEED} cases=${stats.compared} matched=${stats.matched} ` +
      `known-skips=(${knownSummary}) new-signature-counts=(${newSummary}) generator-misses=${stats.generatorMisses} ` +
      `ineligible-schemas=${stats.ineligibleSchemas} distinct-new=${newSignatures.size} ` +
      `stopped-early=${stats.stoppedEarly} wall=${wallMs}ms`,
  );

  if (newMismatches.length > 0) {
    const header = stats.stoppedEarly
      ? `More than ${MAX_NEW} distinct NEW mismatch signatures; stopped at case ${newMismatches.at(-1)?.caseIndex}.`
      : `${newSignatures.size} distinct NEW mismatch signature(s).`;
    const bodies = newMismatches.slice(0, MAX_REPORT_BODIES).map(formatMismatch).join("\n\n");
    const remainder = newMismatches.length - MAX_REPORT_BODIES;
    throw new Error(
      `Differential fuzz found NEW mismatches (not in KNOWN-MISMATCHES.json).\n${header}\n\n${bodies}` +
        (remainder > 0 ? `\n\n(+${remainder} more first-instance reproductions; re-run with the same seed to inspect)` : ""),
    );
  }
});
