# Differential Fuzz — packages/conformance/differential

Asserts the two-backend invariant from plan Verification §4: for random
schemas and random inputs, `schema.safeParseJson(bytes)` (Rust byte path)
and `schema.safeParse(JSON.parse(decode(bytes)))` (TypeScript path) produce
deep-equal results — same success flag, deep-equal data, deep-equal issue
arrays including code, path, payload fields, message, and back-filled input.

Run it:

```
pnpm -C packages/conformance test:differential                    # 100k cases (plan §4 CI count)
FUZZ_CASES=20000 pnpm -C packages/conformance test:differential   # fast dev run
FUZZ_SEED=12345 FUZZ_CASES=20000 pnpm -C packages/conformance test:differential
```

The vitest `differential` project pins `ZODRS_LOADER=native`.

## Current status (2026-08-07)

The gate FAILS: the fuzz found 12 distinct root-cause divergence classes
between the backends, past the assignment's 3-class tripwire — the backend
needs fixing before this suite can pass. Three classes are recorded in
`KNOWN-MISMATCHES.json` and skipped (self-retiring rules); the remaining
classes abort the run early with full reproductions (default
`FUZZ_MAX_NEW=3`).

Survey the full case count while the backend is known-broken (the test
still fails at the end, but prints every distinct signature with counts):

```
FUZZ_CASES=20000 FUZZ_MAX_NEW=1000 FUZZ_REPORT_BODIES=60 \
  pnpm -C packages/conformance test:differential
```

Last survey (seed 24301, 20000 cases): 19535 compared, 13009 matched,
4810 known-skips, 1716 new mismatches across 52 signatures (12 root
causes), wall ~2s.

## Layout

- `fuzz.test.ts` — the loop: schema-per-50-cases, per-case sub-seeds
  (`deriveSeed(seed, index)` so a failing case index reproduces in
  isolation), mismatch classification, summary, failure report.
- `genSchema.ts` — random schema descriptors from the JSON-eligible Plan IR
  grammar: primitives with checks, string formats, objects
  (strip/strict/passthrough), arrays, tuples, unions, discriminated unions,
  records, enums, literals, optional/nullable/default/catch, depth ≤ 5.
  No host closures (refine/transform) — those are not JSON-eligible by design.
- `genInput.ts` — per-schema inputs: valid (self-verified against the TS
  path), near-miss mutations (type flip, out-of-range, missing/extra key,
  string tweak, null leaf), and adversarial bytes (`__proto__` injection,
  lone-surrogate escapes, `1e400`, 100-deep arrays, duplicate keys, BOM,
  NaN/Infinity literals, truncation).
- `compare.ts` — runs both paths and deep-compares; invalid-JSON bytes
  require `safeParseJson` to throw a `SyntaxError` (the plan's fallback
  contract), anything else is a mismatch.
- `ledger.ts` + `KNOWN-MISMATCHES.json` — confirmed backend divergences
  with skip rules. Known mismatches are counted and skipped (fixes are
  routed to the backend owners); skip rules self-retire once fixed. Any
  NEW mismatch fails the test with seed + schema descriptor + input bytes +
  both outcomes; past `FUZZ_MAX_NEW` distinct new signatures the run
  aborts early.
