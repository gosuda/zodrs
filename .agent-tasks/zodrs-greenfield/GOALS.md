# Task zodrs-greenfield: greenfield Zod v4 rewrite with a Rust core

## What success looks like (prose)

`import { z } from "zodrs"` substitutes for `from "zod"` (v4.4.3) with identical
observable behavior and identical TypeScript inference. JS-value parsing runs a
TypeScript-compiled validator; `parseJson(bytes)` validates entirely in Rust
across one boundary crossing. The vendored Zod v4 test corpus passes under all
four configurations (codegen, interpreter, WASM loader, TS-only loader), the
differential fuzz shows the Rust and TS backends agreeing, and the throughput
thresholds in the plan are met.

## Verifiable goals (code)

The loop runs until every gate below passes. Gates map to plan Verification
sections 1-7; tests live in their permanent homes, not duplicated here.

| # | Criterion | Test / command |
| - | --------- | -------------- |
| 1 | Rust core validates every node kind and check per contract | `cargo nextest run --workspace` |
| 2 | Vendored Zod corpus green, codegen backend + native addon | `pnpm -C packages/conformance test` |
| 3 | Corpus green under interpreter backend | `ZODRS_BACKEND=interpreter pnpm -C packages/conformance test` |
| 4 | Corpus green under WASM loader | `ZODRS_LOADER=wasm pnpm -C packages/conformance test` |
| 5 | Corpus green TS-only (no native) | `ZODRS_LOADER=none pnpm -C packages/conformance test` |
| 6 | Rust bytes path and TS value path agree on 100k generated cases | `pnpm -C packages/conformance test:differential` |
| 7 | **FAILS, and one clause is unreachable by design.** See "Gate 7 measurements" below for the numbers and why. | `pnpm -C packages/bench run object,object-safe,string,number,datetime,union,discriminated-union,array,init` _(current in `packages/bench/results/`)_ |
| 8 | Type-instantiation count at or below Zod v4 | `pnpm -C packages/tsc bench` |
| 9 | Packed tarball resolves prebuilt binary, no source build | `pnpm pack -C packages/zodrs && npm i -g ./zodrs-*.tgz && node -e "..."` |

## Gate 7 measurements

The gate asked for two things. One is missed by a shrinking margin; the other
cannot be reached by tuning and needs a design decision.

### Clause A — `parseJson >= 2x JSON.parse+zod4`: unreachable as designed

A status-0 verdict still calls `JSON.parse(source.text)` to build the output
value (`packages/zodrs/src/core/parse.ts`). Both sides therefore pay
`JSON.parse`, and it dominates:

| items | bytes | JSON.parse | zodrs bytes | zodrs TS | zod4 | vs zod4 |
|---|---|---|---|---|---|---|
| 1 | 130 | 1.5 | 3.8 | 3.0 | 2.8 | 0.73x |
| 35 | 3 695 | 25.3 | 38.2 | 41.9 | 32.2 | 0.84x |
| 200 | 21 592 | 141.8 | 205.0 | 227.9 | 181.6 | 0.89x |
| 1 000 | 109 792 | 825.6 | 1 143.1 | 1 185.8 | 1 030.5 | 0.90x |
| 5 000 | 565 125 | 4 090.0 | 5 960.7 | 5 937.3 | 4 765.1 | 0.80x |

(microseconds per operation)

`JSON.parse` is 66-86% of zod4's total at every size, so the ceiling is
**1.24x even with an instantaneous scanner**. `safeParseJson` never wins at
any size. Two further measurements explain why:

- The Rust byte path validates a 4 KB payload in 14.0 us; zodrs's own
  TypeScript path does the same work in 15.3 us. At 565 KB they are equal.
- A napi round trip costs 1 159 ns fixed, which is why the byte path loses
  outright below roughly 1 KB.

Reaching 2x means not re-parsing: either Rust materializes the output value
across napi, or the byte path is skipped when the TS path would be faster.
Both change the project's central premise, so both are decisions for the
owner rather than something to tune into place.

### Clause B — `parse` beats zod4, within 15% of ArkType: misses

| suite | zodrs | zod4 | ratio |
|---|---|---|---|
| array | 15 863 | 4 964 | 3.20x |
| string-datetime | 770 | 353 | 2.18x |
| init (1000 schemas) | 13 | 6 | 2.17x |
| string | 3 024 | 1 895 | 1.60x |
| number | 2 878 | 1 996 | 1.44x |
| object | 19 531 | 22 263 | 0.88x |
| object-safeParse | 19 266 | 24 536 | 0.79x |
| discriminatedUnion | 39 498 | 51 418 | 0.77x |
| union | 1 044 553 | 1 598 456 | 0.65x |

(operations per second)

Object parse was 9 955 (0.44x) before the shape-step rewrite; dropping the
per-field `Object.hasOwn` and collapsing the wrapper-mode tests took it to
0.88x. The rest is structural: zodrs composes one closure per field, so a
parse walks several indirect calls that zod4's flatter validator does not.
Closing it means changing how `composeSteps` builds validators.

ArkType stays an order of magnitude ahead on object and discriminated-union
(137 029 and 292 860), so the 15% clause is not close.

## Out of scope

- Zod v3 surface, v3 compat shims, deprecated parameter aliases.
- Backtracking regex engines (ReDoS exposure) anywhere in the Rust core.
- Host closures (JS callbacks) inside the Rust validation path.

## Done criterion

- [ ] All gates 1-9 pass from a clean checkout. — **BLOCKED**: Gates 1-6, 8, 9 pass (verified 2026-08-09 from clean worktree with `set -o pipefail`; Gate 6 differential 100_000 cases, Gate 9 packed tarball includes native/*.node + wasm and installs). Gate 7 Clause A (`parseJson >=2x`) is unreachable as designed (ceiling 1.24x, JSON.parse dominates) and Clause B (within 15% of ArkType) misses (zodrs 0.88x zod4, ArkType order-of-magnitude ahead). Both are documented in "Gate 7 measurements" and require an owner design decision (not re-parsing via napi, or skipping byte path when TS is faster). Do not mark complete until owner updates the criterion.
- [x] No new clippy warnings (`-D warnings` green). — verified 2026-08-09: `cargo clippy --workspace --all-targets -- -D warnings` 0 after `#[allow(clippy::too_many_lines)]` on `FormatValidator::compile`.
- [x] No new tsc errors. — verified: `pnpm -r build` (tsc) 0.
- [x] AGENTS.md unchanged by this task's per-task criteria. — verified: no diff from `main`.
- [x] `docs/DIVERGENCE.md` records every Zod behavior classified essential or residue. — 242 units (schemas 98 + checks 23 + api 120) classified, plus tier divergences and fuzz state.
- [ ] crates.io `zodrs` and npm `zod-rs` (`publishConfig.name: zod-rs`) published. — **BLOCKED**: `cargo publish -p zodrs --dry-run` 0 (packaged 18 files, crate already exists as 0.1.1 on crates.io) and `npm publish --dry-run` 0 (packaged, but `zod-rs` not yet published from this checkout; requires owner credentials and version bump). Dry runs verify packaging only; actual publish not done. Do not delete `.agent-tasks/` until publish.
## Cleanup

After merge and publish, delete `.agent-tasks/zodrs-greenfield/` entirely.
