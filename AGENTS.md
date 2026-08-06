# zodrs

Greenfield rewrite of Zod v4.4.3: drop-in TypeScript surface, Rust validation core.

## Build and verify

```sh
cargo build --workspace                 # Rust crates
cargo nextest run --workspace           # Rust tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
pnpm install
pnpm -r build                           # TS packages (tsc)
pnpm -C packages/conformance test       # vendored Zod v4 corpus
pnpm exec oxlint --config .oxlintrc.json packages/
```

Pre-commit hooks are managed by lefthook (`lefthook.yml`); install once with
`pnpm exec lefthook install`.

## Conventions

- `crates/zodrs` is pure Rust and never depends on napi. The Rust core never
  calls JavaScript; a plan containing host closures is not JSON-eligible.
- `crates/zodrs-node` is the factored-out unsafe/napi surface (cdylib).
- The vendored corpus in `packages/conformance/tests/` is the conformance
  oracle. Excisions are recorded in `packages/conformance/EXCISIONS.md`;
  anything failing that was not excised is a bug in zodrs.
- Zod source under `.references/` is a behavior reference only. Never copy
  implementation code from it.

## Per-task goals

Task-scoped success criteria live in `.agent-tasks/<task-id>/GOALS.md` and
never in this file. The directory is git-ignored scratch; delete it when the
task merges.
