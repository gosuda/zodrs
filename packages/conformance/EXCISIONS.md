# Excisions — packages/conformance

Every departure from the vendored Zod v4 test corpus is recorded here.
The excision policy is narrow: only tests that pin **legacy** behavior
(cut by the zodrs plan) are removed. A failing test that pins current v4
behavior is a bug in zodrs, not an excision.

## Excised files

### `core/tests/index.test.ts` — REMOVED

- **Behavior pinned:** Zod v3 API surface (`zod/v3` import). Tests v3
  `z.string().parse(234)` error shape with `expected`/`received` fields
  and v3-style async validation.
- **Reason:** zodrs cuts the entire v3 surface. The file imported
  `from "zod/v3"` (rewritten to `zodrs/v3` before excision). No v3
  compat layer ships in zodrs.

## Excised test cases

### `classic/tests/error.test.ts` — test `"do not allow error and message together"`

- **Behavior pinned:** The deprecated `params.message` alias for `error`.
  The test asserts that passing both `message` and `error` to a `.refine()`
  call throws — it specifically tests the interaction between the
  deprecated `message` parameter and the current `error` parameter.
- **Reason:** zodrs cuts deprecated parameter aliases. The `message`
  parameter alias is not supported; only `error` is. The test was replaced
  with a comment pointing here.

## Noted: compat-only symbols used in tests (not excised)

These tests use symbols exported only from Zod's `classic/compat.ts`,
which zodrs does not ship. The imports are rewritten to the closest
zodrs surface (`zodrs`), but the symbol will not resolve until zodrs
provides it or the test is updated. They are **not excised** because the
tests exercise non-legacy behavior (transforms, locale rendering) that
zodrs intends to support; only the API used to access that behavior is
deprecated.

### `classic/tests/transform.test.ts` — `z.ZodIssueCode`

- **Test:** `"z.NEVER in transform"` — uses `z.ZodIssueCode.custom` in
  `ctx.addIssue()`.
- **Test:** `"short circuit on dirty"` — uses
  `z.ZodIssueCode.invalid_type` in an assertion.
- **Compat symbol:** `ZodIssueCode` (deprecated object mapping code
  strings to themselves; use raw string literals like `"custom"` instead).
- **Closest zodrs surface:** `zodrs` (classic). zodrs should export
  `ZodIssueCode` or these tests should be updated to use string literals.

### `classic/tests/function.test.ts` — `z.ZodIssueCode`

- **Test:** `"implement async with transforms"` — uses
  `z.ZodIssueCode.custom` in `ctx.addIssue()`.
- **Compat symbol:** `ZodIssueCode` (same as above).

### `classic/tests/locales_ka.test.ts` — `z.setErrorMap`

- **Test:** `"Georgian locale uses 'ველი' instead of 'სტრინგი'"` — uses
  `z.setErrorMap(z.locales.ka().localeError)` to install a locale.
- **Compat symbol:** `setErrorMap` (deprecated; use `z.config({ customError })`
  instead).
- **Closest zodrs surface:** `zodrs` (classic). The test exercises locale
  rendering, which zodrs supports; only the installation API is deprecated.

### `classic/tests/locales_ro.test.ts` — `z.setErrorMap`

- **Test:** `"Romanian locale uses 'șir' instead of 'string'"` — uses
  `z.setErrorMap(z.locales.ro().localeError)` to install a locale.
- **Compat symbol:** `setErrorMap` (same as above).

## Noted: deprecated `message` parameter alias (not excised)

Many tests use `{ message: "..." }` as a check/schema parameter. In Zod v4
this is a deprecated alias for `{ error: "..." }`. zodrs cuts deprecated
parameter aliases, so these tests will fail until either zodrs provides the
alias or the tests are updated to use `error`.

This is not an excision — the tests pin current v4 validation behavior and
error message content. Only the parameter name used to set the custom
message is deprecated. Files using `{ message: "..." }` as a parameter
include (non-exhaustive):

- `classic/tests/error.test.ts` — `z.string().max(1, { message: "" })`,
  `z.string().datetime({ message: "Bad date!" })`
- `classic/tests/string.test.ts` — `z.string().url({ message: "badurl" })`,
  `z.string().regex(..., { message: "..." })`
- `classic/tests/record.test.ts` — `.refine(..., { message: "..." })`
- `classic/tests/object.test.ts` — `.refine(..., { message: "..." })`
- `classic/tests/pipe.test.ts` — `.refine(..., { message: "..." })`
- `classic/tests/enum.test.ts` — `error: () => ({ message: "..." })`
  (this is an error-map return, not a parameter alias — not deprecated)
- `classic/tests/hash.test.ts` — `z.hash("md5", { message: "..." })`

Error-map return values of the form `{ message: "..." }` are **not**
deprecated — that is the standard v4 error-map return shape. Only the
`message` **parameter** on schema/check constructors is deprecated.

## Noted: deprecated type aliases (not excised)

### `z.ZodErrorMap` — `classic/tests/error.test.ts`

- Used as a type annotation: `const errorMap: z.ZodErrorMap = ...`
- **Deprecated alias:** Re-exported from `classic/errors.ts` as
  `$ZodErrorMap as ZodErrorMap`. Use `z.core.$ZodErrorMap` instead.
- **Closest zodrs surface:** `zodrs` (classic) or `zodrs/core`.

## Noted: names imported from internal modules (not excised)

These imports were rewritten from relative paths into zod's internal module
tree to the closest zodrs public surface. The named import may not exist on
that surface if zodrs does not re-export it.

### `parsedType` — `core/tests/locales/en.test.ts`, `core/tests/locales/tr.test.ts`

- **Original:** `import { parsedType } from "../../util.js"` (core util)
- **Rewritten to:** `import { parsedType } from "zodrs/core"`
- **Note:** In Zod, `parsedType` is a bare export from `core/util.ts` but
  only re-exported as `util.parsedType` from `core/index.ts`. zodrs/core
  should export `parsedType` as a bare name or these tests need adjustment.

### `_ZodMiniJSONSchema` — `classic/tests/fix-json-issue.test.ts`

- **Original:** `import type { _ZodMiniJSONSchema } from "../../mini/schemas.js"`
- **Rewritten to:** `import type { _ZodMiniJSONSchema } from "zodrs/mini"`
- **Note:** Internal mini type; zodrs/mini should re-export it or the test
  needs adjustment.

### `StandardSchemaWithJSON` — `mini/tests/standard-schema.test.ts`

- **Original:** `import type { StandardSchemaWithJSON } from "../../core/standard-schema.js"`
- **Rewritten to:** `import type { StandardSchemaWithJSON } from "zodrs/core"`
- **Note:** Internal core type; zodrs/core should re-export it or the test
  needs adjustment.

### `util` — `classic/tests/index.test.ts`, `classic/tests/intersection.test.ts`, `mini/tests/index.test.ts`

- **Original:** `import type { util } from "zod/v4/core"`
- **Rewritten to:** `import type { util } from "zodrs/core"`
- **Note:** `util` is a namespace export from core. Should be available on
  `zodrs/core`.

### `util` (as `zc`) — `mini/tests/computed.test.ts`

- **Original:** `import { util as zc } from "zod/v4/core"`
- **Rewritten to:** `import { util as zc } from "zodrs/core"`
- **Note:** Same as above.

## Noted: inert upstream tests (not excised)

These files remain in the vendored corpus unchanged. Their active tests do not
exercise the behavior named by the file or test title, so passing them provides
no conformance evidence for that behavior.

### `classic/tests/lazy.test.ts` — `"mutual recursion with cyclical data"`

- **Present behavior:** The test constructs two plain objects, links them into a
  cycle, and makes no schema, parse call, or assertion.
- **Disposition:** The test is inert, not excised. zodrs owns a separate core
  regression that constructs mutually recursive lazy schemas, parses cyclic
  input, and pins the termination/error behavior under both interpreter and
  codegen execution.

### `classic/tests/coalesce.test.ts` — `"coalesce"`

- **Present behavior:** The only active assertion is `expect(true).toBe(true)`;
  the sample that calls `.coalesce()` is commented out.
- **Disposition:** The test is inert, not excised. Zod v4.4.3 exposes no
  `coalesce` API, so zodrs does not invent or test one.

## Summary

| Category | Count |
|---|---|
| Files excised | 1 (`core/tests/index.test.ts`) |
| Test cases excised | 1 (`error.test.ts` "do not allow error and message together") |
| Compat-only symbols noted (not excised) | 4 files (`ZodIssueCode` ×2, `setErrorMap` ×2) |
| Deprecated `message` parameter alias noted | ~6+ files (not excised) |
| Deprecated type aliases noted | 1 (`ZodErrorMap`) |
| Internal module names noted | 5 names across 6 files |
| Inert upstream tests noted (not excised) | 2 (`lazy.test.ts`, `coalesce.test.ts`) |
| **Total source files** | **109** |
| **Total vendored files** | **108** (109 − 1 excised) |
