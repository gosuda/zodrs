<div align="center">

# zodrs

**Drop-in blazingly-fast replacement for Zod with a Rust validation core.**

[![npm](https://img.shields.io/npm/v/zod-rs.svg)](https://www.npmjs.com/package/zod-rs)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17-informational.svg)](https://nodejs.org)

[Benchmarks](#benchmarks) &bull;
[Behavior contract](docs/CONTRACT.md) &bull;
[Divergences](docs/DIVERGENCE.md) &bull;
[Dependency rationale](docs/DEPENDENCIES.md)

</div>

---

## What this is

`zodrs` keeps the Zod v4 TypeScript surface and replaces the validation engine.
Schemas compile to a flat plan arena that a Rust core walks over raw JSON bytes
in one pass. The backends are designed to agree, and the conformance suite
runs four of them against the same corpus, so the engine underneath is an
implementation detail you can switch off.

Correctness is measured against Zod's own v4.4.3 test corpus, vendored into
`packages/conformance`. Every departure is recorded in
[`packages/conformance/EXCISIONS.md`](packages/conformance/EXCISIONS.md);
anything failing that was not excised is a bug.

## Install

```bash
npm install zod-rs
```

Requires Node 20.17 or later. Prebuilt N-API addons cover Linux GNU
(x64/arm64), Linux musl (x64/arm64), macOS (x64/arm64), and Windows MSVC
(x64/arm64) as optional platform packages. The main package embeds the build
host's native addon directly so it works without optional dependencies on that
system, while optional platform packages provide native-by-default support on
other listed systems. On any platform without a matching native addon, the
loader uses the embedded `wasm32-wasip1-threads` WASM addon; if that is
unavailable too, validation falls back to the TypeScript validator.

## Quickstart

```javascript
import { z } from "zod-rs";

const User = z.object({
  name: z.string().min(3),
  age: z.number().int().positive(),
});

User.parse({ name: "Ada", age: 36 });
// -> { name: "Ada", age: 36 }

const result = User.safeParse({ name: "Al", age: -1 });
result.success; // false
result.error.issues.map((i) => [i.code, i.path]);
// -> [["too_small", ["name"]], ["too_small", ["age"]]]
```

To hand raw bytes straight to the Rust core, skip `JSON.parse` and call
`parseJson`:

```javascript
User.parseJson('{"name":"Ada","age":36}');
```

`parseJson` returns exactly what `parse(JSON.parse(...))` returns. When no Rust
backend is registered it does that internally.

## Entry points

| Import | Contents |
|---|---|
| `zod-rs` | Classic `z` surface |
| `zod-rs/mini` | Tree-shakeable functional surface |
| `zod-rs/core` | Shared primitives and issue types |
| `zod-rs/locales` | Error-message locales |
| `zod-rs/v4`, `zod-rs/v4-mini`, `zod-rs/v4/core`, `zod-rs/v4/locales` | Version-qualified aliases |

Zod's v3 surface is not shipped.

## Backends

Two independent switches select how validation runs. Both exist so the
conformance suite can pin each tier against the corpus; neither is needed in
normal use.

| Variable | Values | Effect |
|---|---|---|
| `ZODRS_LOADER` | unset / `native` | Native N-API addon, then WASM, then none |
| | `wasm` | WASM addon only |
| | `none` | No Rust backend; TypeScript validator only |
| `ZODRS_BACKEND` | `interpreter` | Forces the tree-walking interpreter over compiled codegen |

Native platform packages (installed automatically as optional dependencies):

| Platform | Package |
|---|---|
| Linux x64 (GNU) | `zod-rs-node-linux-x64-gnu` |
| Linux arm64 (GNU) | `zod-rs-node-linux-arm64-gnu` |
| Linux x64 (musl) | `zod-rs-node-linux-x64-musl` |
| Linux arm64 (musl) | `zod-rs-node-linux-arm64-musl` |
| macOS x64 | `zod-rs-node-darwin-x64` |
| macOS arm64 | `zod-rs-node-darwin-arm64` |
| Windows x64 (MSVC) | `zod-rs-node-win32-x64-msvc` |
| Windows arm64 (MSVC) | `zod-rs-node-win32-arm64-msvc` |

The suite runs all four lanes. Each passes 5,679 tests across 435 files.

## Benchmarks

Measured against Zod v4.4.3 on the native tier, with valid inputs. Each figure
is the median of three full runs. The harness lives in `packages/bench`; the
comparison set is fixed in `packages/bench/gate.mjs`.

| Suite | Workload per op | zodrs (ops/s) | zod4 (ops/s) | Ratio |
|---|---|---:|---:|---:|
| `z.string().parse` | 10,000 strings | 34,252 | 1,875 | 18.27x |
| `z.number().parse` | 10,000 numbers | 8,116 | 1,570 | 5.17x |
| `z.array().parse` | 1,000 arrays of 3 strings | 12,217 | 4,188 | 2.92x |
| `z.union().parse` | 1 value, 3-member union | 3,438,230 | 1,495,908 | 2.30x |
| `z.discriminatedUnion().parse` | 100 objects | 87,666 | 39,411 | 2.22x |
| `z.object().safeParse` | 1,000 3-field objects | 15,740 | 7,251 | 2.17x |
| `z.string().datetime().parse` | 10,000 ISO strings | 820 | 441 | 1.86x |
| `z.object()` initialization | build 1,000 schemas | 12 | 7 | 1.71x |
| `z.object().parse` | 1,000 3-field objects | 19,812 | 17,871 | 1.11x |
| `safeParseJson` | one 4 KB nested payload | 21,433 | 21,699 | 0.99x |

An op is a whole suite workload, not one value, and the workloads differ. Read
each row across its two engine columns; do not compare rows to each other.

The `safeParseJson` row measures `zodrs.safeParseJson(buffer)` against
`zod4.safeParse(JSON.parse(json))`. At 0.99x it is a tie, and it is the one
cell of the release gate that did not pass on this run: the gate requires
every comparison to reach at least 1.00x.

Reproduce the full gate with three runs into distinct directories, then the
median-of-three comparison:

```bash
SUITES=object,object-safe,string,number,datetime,union,discriminated-union,array,init
for i in 1 2 3; do
  BENCH_RESULTS_DIR=/tmp/bench$i pnpm -C packages/bench run run "$SUITES"
done
node packages/bench/gate.mjs /tmp/bench1 /tmp/bench2 /tmp/bench3
```

Numbers above: Node 24.18.0, Linux x64, Xeon Gold 6138, Tinybench 6.1.3.
Absolute throughput depends on the machine; rerun the gate on yours.

## Repository layout

| Path | Contents |
|---|---|
| `packages/zodrs` | The published TypeScript package |
| `packages/conformance` | Vendored Zod v4.4.3 corpus, the correctness oracle |
| `packages/bench` | Benchmarks and the release performance gate |
| `crates/zodrs` | Pure Rust validation engine, no napi dependency |
| `crates/zodrs-node` | N-API and WASI binding layer |

## Development

```bash
cargo build --workspace
cargo nextest run --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cargo deny check bans licenses sources

pnpm install
pnpm -r build
pnpm -C packages/conformance test
pnpm exec oxlint --config .oxlintrc.json packages/
```

Pre-commit hooks run through lefthook. Install them once:

```bash
pnpm exec lefthook install
```

## License

MIT
