# Grounded dependency set

Grounded on 2026-08-12. The links in this document point to the release channel or package record used for each decision.

## Platform decisions

| Choice | Selected version | Current stable or LTS | Release or support date | Decision | Source |
|---|---:|---:|---:|---|---|
| Rust edition | 2024 | 2024 | Rust 1.85 stabilized it on 2025-02-20 | The repository edition pin wins. | [Rust 2024](https://doc.rust-lang.org/edition-guide/rust-2024/index.html) |
| Rust toolchain | 1.97.1 | 1.97.1 | 2026-07-16 | Rust has no LTS channel. Use the latest stable toolchain. Keep the repository MSRV at 1.88. | [Stable channel](https://static.rust-lang.org/dist/channel-rust-stable.toml) |
| Node CI runtime | 24 LTS | 24 LTS | 24.19.0 released 2026-08-03; support ends 2028-04-30 | Use the current LTS in CI. | [Official Node release schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) and [24.19.0 release record](https://nodejs.org/en/blog/release/v24.19.0) |
| Node consumer floor | >=20.17 | 24 LTS | Node 20 support ended 2026-04-30 | The existing public compatibility contract overrides an engine-floor raise. All shipped runtime dependencies must still load on 20.17. | [Official Node release schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) and [Node 20.17 API](https://nodejs.org/download/release/v20.17.0/docs/api/) |
| pnpm | 11.21.0 | 11.21.0 | 2026-08-09 | Use the latest stable package manager. | [npm package record](https://registry.npmjs.org/pnpm/11.21.0) |
| npm | 12.0.2 | 12.0.2 | 2026-07-29 | The release workflow exact-pins this stable version for publication and lockfile work. | [npm package record](https://registry.npmjs.org/npm/12.0.2) |
| cargo-nextest | 0.9.143 | 0.9.143 | 2026-08-07 | The release workflow exact-pins this stable test runner. | [upstream release](https://github.com/nextest-rs/nextest/releases/tag/cargo-nextest-0.9.143) |
| TypeScript | 7.0.2 | 7.0.2 | 2026-07-08 | Use the latest stable compiler. | [npm package record](https://registry.npmjs.org/typescript/7.0.2) |
| Vitest | 4.1.10 | 4.1.10 | 2026-07-06 | Use the latest stable release. Exclude Vitest 5 prereleases. | [npm package record](https://registry.npmjs.org/vitest/4.1.10) |
| oxlint | 1.78.0 | 1.78.0 | 2026-08-10 | This development-only tool requires Node 20.19. CI uses Node 24. It is not part of the published package or its Node 20.17 contract. | [npm package record](https://registry.npmjs.org/oxlint/1.78.0) |

## Rust crates

The default is the latest stable release. The N-API rows form one older stable generation because the latest generation requires prerelease Emnapi packages.

| Crate | Selected version | Current stable | Released | Decision | Source |
|---|---:|---:|---:|---|---|
| serde | 1 / 1.0.229 | 1.0.229 | 2026-07-18 | Latest stable. | [crates.io](https://crates.io/api/v1/crates/serde) |
| serde_json | 1.0.151 | 1.0.151 | 2026-07-20 | Keep as the ordered public value model and compatibility serializer. | [crates.io](https://crates.io/api/v1/crates/serde_json) |
| sonic-rs | 0.5.8 | 0.5.8 | 2026-03-25 | Latest stable SIMD parser and writer. | [crates.io](https://crates.io/api/v1/crates/sonic-rs) |
| regex | 1.13.1 | 1.13.1 | 2026-07-15 | Latest stable. | [crates.io](https://crates.io/api/v1/crates/regex) |
| jiff | 0.2.35 | 0.2.35 | 2026-07-25 | Latest stable. | [crates.io](https://crates.io/api/v1/crates/jiff) |
| memchr | 2.8.3 | 2.8.3 | 2026-07-08 | Latest stable. | [crates.io](https://crates.io/api/v1/crates/memchr) |
| smallvec | 1.15.2 | 1.15.2 | 2026-06-11 | Latest stable. Exclude the 2.0 prerelease. | [crates.io](https://crates.io/api/v1/crates/smallvec) |
| compact_str | 0.10.0 | 0.10.0 | 2026-07-13 | Latest stable. | [crates.io](https://crates.io/api/v1/crates/compact_str) |
| slab | 0.4.12 | 0.4.12 | 2026-01-31 | Latest stable resolution. | [crates.io](https://crates.io/api/v1/crates/slab) |
| napi | 3.11.0 | 3.12.1 | 2026-07-21 | Exact pin. Version 3.11 accepts `napi-build` 2.3.2; version 3.12 raises that dependency to 2.4. | [3.11.0 manifest](https://docs.rs/crate/napi/3.11.0/source/Cargo.toml) and [3.12.1 manifest](https://docs.rs/crate/napi/3.12.1/source/Cargo.toml) |
| napi-derive | 3.5.10 | 3.6.3 | 2026-07-12 | Exact pin. Version 3.5.10 selects backend 5.1.2, which matches napi 3.11. | [3.5.10 manifest](https://docs.rs/crate/napi-derive/3.5.10/source/Cargo.toml) and [changelog](https://napi.rs/changelog/napi_derive) |
| napi-build | 2.3.2 | 2.4.1 | 2026-05-13 | Exact pin. Version 2.4 exports the native Emnapi-v2 environment functions that stable Emnapi 1.11 does not provide. | [2.3.2 WASI source](https://docs.rs/crate/napi-build/2.3.2/source/src/wasi.rs) and [2.4.1 WASI source](https://docs.rs/crate/napi-build/2.4.1/source/src/wasi.rs) |
| rstest | 0.26.1 | 0.26.1 | 2025-07-27 | Latest stable. | [crates.io](https://crates.io/api/v1/crates/rstest) |

## npm workspace and published runtime

| Package | Selected version | Current stable | Released | Decision | Source |
|---|---:|---:|---:|---|---|
| @napi-rs/cli | 3.8.6 | 3.8.6 | 2026-08-12 | Latest stable. Its peer ranges accept stable Emnapi 1.11.3; native and WASM artifact gates pass with that generation. | [3.8.6 package record](https://registry.npmjs.org/%40napi-rs%2Fcli/3.8.6) |
| @emnapi/core | 1.11.3 | 1.11.3 stable | 2026-07-25 | Latest stable 1.x peer for the selected CLI and WASM runtime. | [npm package record](https://registry.npmjs.org/%40emnapi%2Fcore/1.11.3) |
| @emnapi/runtime | 1.11.3 | 1.11.3 stable | 2026-07-25 | Latest stable 1.x peer for the selected CLI and WASM runtime. | [npm package record](https://registry.npmjs.org/%40emnapi%2Fruntime/1.11.3) |
| @napi-rs/wasm-runtime | 1.1.6 | 1.2.3 | 2026-06-24 | Version 1.1.6 is the newest stable line that supports Emnapi 1.x and does not raise the Node floor to 20.19. | [npm package record](https://registry.npmjs.org/%40napi-rs%2Fwasm-runtime/1.1.6) |
| @types/node | 22.20.1 | 26.2.0 | 2026-07-08 | Keep the Node 22 type line. Newer types could admit APIs outside the public Node 20.17 contract. | [npm package record](https://registry.npmjs.org/%40types%2Fnode/22.20.1) |
| tsx | 4.23.12 | 4.23.12 | 2026-08-10 | Latest stable. | [npm package record](https://registry.npmjs.org/tsx/4.23.12) |
| zod | 4.4.3 | 4.4.3 | 2026-05-04 | Latest stable and the conformance oracle. | [npm package record](https://registry.npmjs.org/zod/4.4.3) |
| arktype | 2.2.3 | 2.2.3 | 2026-07-07 | Latest stable resolution. | [npm package record](https://registry.npmjs.org/arktype/2.2.3) |
| valibot | 1.4.2 | 1.4.2 | 2026-06-28 | Latest stable resolution. | [npm package record](https://registry.npmjs.org/valibot/1.4.2) |
| tinybench | 6.1.3 | 6.1.3 | 2026-08-10 | Latest stable. It replaces dormant mitata. | [npm package record](https://registry.npmjs.org/tinybench/6.1.3) |
| recheck | 4.5.0 | 4.5.0 stable | 2025-03-02 | Use the stable release instead of 4.6.0-beta.3. | [npm package record](https://registry.npmjs.org/recheck/4.5.0) |
| @seriousme/openapi-schema-validator | 2.9.1 | 2.9.1 | 2026-08-05 | Latest stable. | [npm package record](https://registry.npmjs.org/%40seriousme%2Fopenapi-schema-validator/2.9.1) |

## Removed choices

- `@web-std/file` 3.0.3 was last released on 2023-08-29. Node 20 provides the global `File` class, so the platform API replaces it: [Node 20.17 globals](https://nodejs.org/download/release/v20.17.0/docs/api/globals.html#class-file).
- `mitata` 1.0.34 was last released on 2025-02-04. `tinybench` 6.1.3 replaces it after passing the three-run performance gate: [mitata package record](https://registry.npmjs.org/mitata/1.0.34).
- `recheck` 4.6.0-beta.3 was replaced by stable 4.5.0: [recheck package record](https://registry.npmjs.org/recheck/4.5.0).
- Emnapi 2.0.0-alpha.3 was removed. The stable 1.11.3 generation passed native and WASM builds, installed-artifact checks, all backend conformance lanes, and a Node 20.17 WASM load.

## SIMD JSON boundary

`sonic-rs` 0.5.8 already parses deferred raw input and writes raw values. `simd-json` 0.17.3 parses through a mutable-byte API, which would force a copy at the immutable `&[u8]` zodrs boundary: [simd-json `from_slice`](https://docs.rs/simd-json/0.17.3/simd_json/fn.from_slice.html).

The remaining broad `serde_json` writer replacement was measured and rejected. It reduced status-1 throughput and status-0 throughput. A full Sonic value-model replacement was also rejected because constructed Sonic objects do not preserve the issue wire's insertion order.

The selected boundary streams issue arrays through Sonic without constructing a second `serde_json::Value` tree. It preserves the old ordered-map behavior, including duplicate field replacement and `path` shadowing. The issue-heavy Rust probe improved from 77.15 ms to 22.6 ms, or 3.414x. The three-run public release gate still passes all ten suites. `serde_json` remains the ordered plan and issue value model; the hot raw-input parser remains Sonic.
