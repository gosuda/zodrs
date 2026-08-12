<div align="center">

# zodrs

**Drop-in replacement for Zod v4.4.3 with a Rust validation core.**

[![npm](https://img.shields.io/npm/v/zod-rs.svg)](https://www.npmjs.com/package/zod-rs)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17-informational.svg)](https://nodejs.org)

[Behavior contract](docs/CONTRACT.md) &bull;
[Divergences](docs/DIVERGENCE.md) &bull;
[Dependency rationale](docs/DEPENDENCIES.md)

</div>

---

## What this is

`zodrs` keeps the Zod v4 TypeScript surface and replaces the validation engine.
Schemas compile to a flat plan arena that a Rust core walks over raw JSON bytes
in one pass. The backends are designed to agree, and the conformance suite runs
four of them against the same corpus to prove it, so the engine underneath is
an implementation detail you can switch off.

Correctness is measured against Zod's own v4.4.3 test corpus, vendored into
`packages/conformance`. Every departure is recorded in
[`packages/conformance/EXCISIONS.md`](packages/conformance/EXCISIONS.md);
anything failing that was not excised is a bug.

## Install

```bash
npm install zod-rs
```

Requires Node 20.17 or later. The package embeds a prebuilt Linux x64 GNU
N-API addon and a `wasm32-wasip1-threads` addon. On any other platform the
loader skips the native tier and uses the embedded WASM addon.

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
conformance suite can prove the tiers agree; neither is needed in normal use.

| Variable | Values | Effect |
|---|---|---|
| `ZODRS_LOADER` | unset / `native` | Native N-API addon, then WASM, then none |
| | `wasm` | WASM addon only |
| | `none` | No Rust backend; TypeScript validator only |
| `ZODRS_BACKEND` | `interpreter` | Forces the tree-walking interpreter over compiled codegen |

The suite runs all four lanes. Each passes 5,679 tests across 435 files.

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

`sonic-rs` is the only JSON dependency: parser, writer, and value model.
`cargo-deny` bans `serde_json` from the graph. See
[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) for why.

## License

MIT, as declared by `packages/zodrs/package.json` and the workspace
`Cargo.toml`. The repository carries no `LICENSE` file yet.
