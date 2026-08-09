# DIVERGENCE: Zod v4.4.3 core walk vs zodrs

Branch-by-branch audit of Zod v4.4.3's `core/schemas.ts`, `core/checks.ts`, and
`core/api.ts` (`.references/zod/packages/zod/src/v4/core/`) against the zodrs
implementation. Every runtime unit in those files is classified:

- **essential**: observable behavior zodrs must reproduce. The zodrs file(s)
  carrying it and the `docs/CONTRACT.md` section covering it are cited.
- **residue**: deliberately cut, with the reason.
- **gap**: essential but currently missing or behaviorally wrong in zodrs.
  These are listed in `## Gaps found` and become fix tasks.

## Scope and unit counts

| File | Runtime units walked | Composition |
|---|---|---|
| `core/schemas.ts` | **98** | 74 `$Zod*` constructors + 3 exported format helpers (`isValidBase64`, `isValidBase64URL`, `isValidJWT`) + 21 internal `handle*`/`normalizeDef`/`getTupleOptStart`/`mergeValues` functions |
| `core/checks.ts` | **23** | `$ZodCheck` base + 21 check classes + `handleCheckPropertyResult` |
| `core/api.ts` | **120 functions + 1 const** | 120 `export function` declarations (counting the `_tuple` ×3, `_enum` ×3, `_literal` ×3 overload signatures individually; 114 unique names) + the `TimePrecision` const |
| **Total** | **242** | |

Interfaces and type aliases are type-level only (zero runtime) and are covered
by the inference-parity contract rather than this walk; they are not counted as
units. Self-check: every function/const name from the three files appears in
the classification tables below.

zodrs location shorthand used in the tables:

| Tag | File |
|---|---|
| IR | `packages/zodrs/src/core/nodes.ts` + `core/plan.ts` (node kinds, plan emission) |
| INT | `packages/zodrs/src/core/interpreter.ts` (reference validator) |
| CG | `packages/zodrs/src/core/codegen.ts` (specialized-closure compiler) |
| CL | `packages/zodrs/src/classic/schemas.ts` (classic factories + `$ZodType` methods) |
| MINI | `packages/zodrs/src/mini/mini.ts` (mini projection) |
| FMT | `packages/zodrs/src/core/formats.ts` (string-format engines) |
| PARSE | `packages/zodrs/src/core/parse.ts` (16 entry points, encode/decode) |
| RS | `crates/zodrs/src/{plan,compile,validate,formats,issue}.rs` (Rust byte path) |

---

## Intentional divergences

Behaviors zodrs does **not** reproduce, because reproducing them would carry a
zod bug across.

### A valid `__proto__` field survives the parse

Zod writes results with `result[key] = value`. For a shape key named
`__proto__` that assignment reaches the inherited setter, so the field is
validated and then silently dropped: `z.object({ __proto__: z.string() })`
parsing `{"__proto__":"s"}` returns `{}`.

zodrs defines the property instead (`defineValue`), so the field it just
validated is the field it returns. Pinned by `keeps a valid __proto__ field in
the output` in `packages/zodrs/src/core/shape-access.test.ts`.

Everything else about the key matches zod: a wrong value is rejected, and the
key is dropped when it arrives as an *unknown* key rather than a declared one.
A plan carrying a `__proto__` shape key is not byte-path eligible, for the same
prototype-visibility reason as `constructor` and its siblings.

---

## Gaps found

Essential behaviors missing or behaviorally wrong in zodrs at audit time. Each
entry names the Zod unit, the evidence, and the zodrs behavior that should
exist. (Codegen conformance was at 999/1306 and being ground to green in
parallel; several of these are live conformance failures.)

1. **`$ZodFunction` is a bare typeof check.** Zod (schemas.ts:4423–4519)
   validates `{input, output}` and produces a wrapper via `.implement(fn)` /
   `.implementAsync`, plus `.args()`, input/output getters, and `this`
   preservation; vendored `classic/tests/function.test.ts` pins all of it.
   zodrs `function_` (CL:631) emits `node({kind:"function"})` with no
   input/output and INT:237 only checks `typeof input === "function"`.
   *Should exist:* the full function schema of CONTRACT §13: `.implement()`
   returning a function that parses args against the input schema and the
   return value against the output schema, `.args()`, async variant.

2. **Encode direction is unimplemented.** PARSE:94–115 sets
   `direction: "backward"` on the context, but nothing consumes it: INT/CG
   never branch on `direction` (grep: only the type declaration at INT:10).
   Consequences: `z.encode` on a pipe runs `a→b` forward instead of reverse;
   `z.codec` (CL:667) builds a decode-only pipe (`a → decode host → b`), so
   `z.encode(codec)` runs the decode path; `z.stringbool` (CL:617) is a
   decode-only transform with no `truthy[0]`/`falsy[0]` encode; no
   `ZodEncodeError` exists for unidirectional transforms on encode; fallback
   wrappers short-circuit in both directions instead of decode-only. Vendored
   `classic/tests/codec.test.ts:36,49,118` and `codec-examples.test.ts` pin
   reverse behavior. *Should exist:* CONTRACT §15–§16: pipes reverse
   (`b` then `a`), codecs run `B`(reverse) → `encode()` → `A`(reverse),
   stringbool encodes to `truthy[0]`/`falsy[0]`, transforms throw
   `ZodEncodeError` on encode, `.default/.prefault/.catch` short-circuit in
   decode direction only.

3. **`.exactOptional()` aliases `.optional()` (wrong semantics).**
   `$ZodExactOptional` (schemas.ts:3537–3559) delegates to the inner parse
   with **no** undefined short-circuit: absent object keys pass (via
   `optin/optout = "optional"`) but a present `undefined` is rejected.
   zodrs CL:212 `exactOptional()` returns `this.optional()`, which accepts
   present `undefined`. Vendored `classic/tests/optional.test.ts:185–214`
   pins `safeParse(undefined).success === false`, `unwrap()`, and
   absent-key behavior. *Should exist:* an `exactOptional` node kind (or
   flag) with delegate-only parse and `optin/optout = "optional"`, no
   `| undefined` in the output/input types.

4. **Under-length tuples don't emit the single `too_small`.**
   `$ZodTuple` + `getTupleOptStart` (schemas.ts:2666–2760): when
   `input.length < optinStart` and no `rest`, one
   `too_small {origin:"array", minimum: optStart, inclusive: true}` issue and
   no element-level errors. INT tuple case only guards over-length; short
   input yields per-item `invalid_type` issues on `undefined`.
   Vendored `classic/tests/tuple.test.ts:215,377,410` pins the single
   `too_small`. *Should exist:* the optStart length precheck in both INT and
   CG tuple paths.

5. **Record exhaustiveness and `partialRecord`/`looseRecord` missing.**
   `$ZodRecord` (schemas.ts:2875–3028) reads `def.keyType._zod.values` and
   requires every enum/literal key to be present (unless the key type is
   `$partial`); INT's record case only iterates input keys, so missing keys
   are never reported. `z.partialRecord` and `z.looseRecord` factories exist
   in Zod classic (classic/schemas.ts:1814,1829) but nowhere in zodrs
   (grep: no matches). Vendored `classic/tests/record.test.ts:297,487,510`
   and `to-json-schema.test.ts` pin them. *Should exist:* exhaustive
   enum/literal-key checking per CONTRACT §11, plus the two factories
   (`partialRecord` opts out of exhaustiveness; `looseRecord` = record
   without key-exhaustiveness guarantees).

6. **Enum extras missing.** `$ZodEnum` (schemas.ts:3220–3256) exposes
   `.enum.NAME` member access, `.options`, `.extract([...])`,
   `.exclude([...])`. zodrs `enum_` (CL:518–524) returns a bare schema with
   none of these (grep: no `extract`/`exclude` in CL or MINI). Vendored
   `classic/tests/enum.test.ts:138–173` pins extract/exclude. *Should
   exist:* the member-access/extract/exclude surface of CONTRACT §4.

7. **`z.hash()` factory and `ZodCustomStringFormat` type missing from
   classic.** Zod classic exports `hash(alg, {enc?})`
   (classic/schemas.ts:1013); zodrs has `hash` only in MINI (mini.ts:744) and
   no `ZodCustomStringFormat` type anywhere (grep: no matches). Vendored
   `classic/tests/hash.test.ts:2` imports both from `"zodrs"`. *Should
   exist:* classic `hash()` dispatching to the `md5…sha512` format checks
   (CONTRACT §5) and the exported `ZodCustomStringFormat<"alg_enc">` type.

8. **`z.success()` missing from classic.** `$ZodSuccess`
   (schemas.ts:3841–3869) parses the inner schema and returns a boolean.
   MINI implements it (mini.ts:1068, via a host transform node); classic has
   no `success` factory (grep: no matches in CL). *Should exist:* classic
   `z.success(inner)`.

9. **`z.invertCodec()` missing from classic.** Zod classic exports
   `invertCodec` (classic/schemas.ts:2420); zodrs has it only in MINI
   (mini.ts:1092). *Should exist:* classic `invertCodec(codec)` swapping
   decode/encode directions (CONTRACT §15), once gap 2 lands.

10. **Discriminated-union discriminator traversal is literal/enum only.**
    `$ZodDiscriminatedUnion` (schemas.ts:2360–2449) resolves discriminators
    through `propValues`, which traverses optional/nullable/readonly/default
    wrappers and nested unions, supports `null`/boolean/number/bigint
    discriminants, and honors `{ unionFallback: true }` (fall back to a
    plain-union scan when no discriminator matches; also forced in the
    backward direction, schemas.ts:2420–2423). zodrs `discriminantValues`
    (CL:581–586) reads only direct `literal`/`enum` shape entries; no
    `unionFallback` anywhere (grep: no matches). CONTRACT §9 claims the full
    set. *Should exist:* wrapper-traversing discriminator resolution and
    `unionFallback` in CL + INT + CG discunion paths.

11. **`when` check param unimplemented.** Every Zod check honors
    `{ when: (payload) => boolean }` (checks.ts `onattach`/run gating);
    zodrs `RuntimeCheck` (IR) has `abort` but no `when`, and
    INT's `applyChecksSync`/host execution never consults it. Vendored
    `classic/tests/refine.test.ts:434,466` pins gated `superRefine`.
    *Should exist:* `when` on `RuntimeCheck`, evaluated per parse before the
    check runs.

12. **`safeExtend` is `extend` with no safety distinction.** Zod `extend`
    throws `Cannot overwrite keys on object schemas containing refinements.
    Use .safeExtend()` (util.ts:672), while `safeExtend` (util.ts:687)
    performs the merge unconditionally. zodrs `extend` (CL:328) never throws
    and `safeExtend` (CL:339) just calls it. *Should exist:* the
    refinement-guard throw in `extend`, with `safeExtend` bypassing it
    (CONTRACT §7).

13. **`core.util.allowsEval` export missing.** Vendored
    `classic/tests/jitless-allows-eval.test.ts:4` imports
    `core.util.allowsEval` and pins its jitless short-circuit (Zod
    util.ts:365–367). zodrs `core/util.ts` has no `allowsEval` (grep: no
    matches). With closure codegen (decision 1) no eval ever happens, so the
    export should be a memoized `{ value: false }` that still honors the
    `config({jitless:true})` short-circuit contract the test asserts.

14. **`describe` / `meta` core check factories not exported.** api.ts:1696
    and api.ts:1709 export `describe(s)` / `meta(obj)` as check-producing
    core functions (used to attach registry metadata through `.check()`).
    zodrs has the `.describe()`/`.meta()` **methods** (CONTRACT §18) but
    `zodrs/core` exports no `describe`/`meta` functions (core/index.ts:2–37).
    Not pinned by the vendored corpus. *Should exist:* `z.core.describe` /
    `z.core.meta` equivalents, or a recorded decision to cut them as
    core-internal API.

---

## Orchestrator decisions recorded during execution

1. **Codegen uses compiled closures, not `new Function`.** The repo's
   `js-no-dynamic-eval` rule forbids string eval. `core/codegen.ts` compiles
   each schema node into a specialized closure
   (`CompiledNode = (input, context, path) => unknown | FAIL`) over a
   per-schema cache, delegating un-specialized kinds to the interpreter.
   This preserves the plan's straight-line, zero-allocation-success-path and
   switch-dispatch properties without dynamic eval. `CODEGEN_AVAILABLE` is
   therefore the constant `true`; the interpreter remains the backend of
   record for node kinds codegen does not specialize and for the
   `ZODRS_BACKEND=interpreter` conformance tier.
2. **JSON Schema generation is TypeScript-side only.** `toJSONSchema` lives in
   `packages/zodrs/src/core/json-schema.ts` and `fromJSONSchema` in
   `packages/zodrs/src/classic/from-json-schema.ts`. The plan's Rust
   `to_json_schema(plan, opts)` was cut because the `ZODRS_LOADER=none`
   conformance tier must pass to-json-schema tests with no native backend, so
   one TS implementation serves all tiers. `crates/zodrs/src/jsonschema.rs`
   remains a 1-line placeholder slated for deletion (verified: file contains
   only a doc comment).
3. **Crate renamed `zodrs-core` → `zodrs`** for the crates.io publication
   requirement (verified: `crates/zodrs/Cargo.toml` `name = "zodrs"`).

---

## Tier payload/trace divergences (native vs TS)

zodrs has four validation tiers, all designed to produce identical observable
results. The loader (`core/loader.ts`) selects the first available:

| Tier | Backend | Loader key | Selection |
|---|---|---|---|
| Native | Rust napi cdylib (`crates/zodrs-node/`) | `ZODRS_LOADER=native` (default) | Synchronous; first choice |
| WASM | wasm32-wasip1-threads addon (`packages/zodrs/wasm/`) | `ZODRS_LOADER=wasm` | Async fire-and-forget; second choice |
| TS codegen | Compiled closures (`core/codegen.ts`) | `ZODRS_BACKEND=codegen` (default) | Fallback when no native/WASM |
| TS interpreter | Reference validator (`core/interpreter.ts`) | `ZODRS_BACKEND=interpreter` | Fallback when `config().jitless` or codegen unavailable |

The TS codegen and interpreter share the same issue-construction code paths
(`issue()`, `addIssue()`, `checkPayloadIssues()` in `interpreter.ts`), so
payload/trace divergences between them are not expected. The native tier
constructs issues independently in Rust (`issue.rs`, `validate.rs`), then
serializes them as JSON for the TS side to finalize (`parse.ts`).

### Native issue pipeline

The native path produces **raw issues** (no `message`, no `input`) and the TS
side finalizes them:

1. Rust `validate.rs` walks a `sonic-rs` DOM against the compiled plan arena,
   constructing `Issue` structs with ordered `(field, value)` pairs and a
   `Path` (`issue.rs:69–79`). Fields are pushed in insertion order; `path` is
   serialized last (`Issue::to_json`, `issue.rs:122–130`).
2. Issues serialize as a JSON array string (`issues_to_json`) in the
   `Verdict.payload` (`validate.rs:36–43`).
3. TS `parse.ts:parseRawIssues` (line 183) parses the payload into
   `$ZodRawIssue[]`.
4. TS `parse.ts:backFillInput` (line 207) walks each issue's path against the
   original `JSON.parse`'d value to attach the `input` field — needed for
   message resolution ("received X") and stripped by `finalizeIssue` unless
   `reportInput` is set.
5. TS `errors.ts:finalizeNested` (line 354) recursively finalizes nested
   union/key/element sub-issues, then `finalizeIssue` (line 336) resolves
   `message` through the error-map precedence chain:
   `issue.message → inst.error → context.error → global.customError →
   global.localeError → defaultError → "Invalid input"`.

### Differential fuzz harness

The differential fuzz harness (`packages/conformance/differential/`) asserts
the two-backend invariant: for random schemas and inputs,
`schema.safeParseJson(bytes)` (Rust) and `schema.safeParse(JSON.parse(bytes))`
(TS) produce deep-equal results — same success flag, deep-equal data,
deep-equal issue arrays including code, path, payload fields, message, and
back-filled input (`compare.ts:106–148`).

**Current status (2026-08-07):** The gate FAILS. The fuzz found 12 distinct
root-cause divergence classes between the backends. Last survey (seed 24301,
20000 cases): 19535 compared, 13009 matched, 4810 known-skips, 1716 new
mismatches across 52 signatures, wall ~2s. `KNOWN-MISMATCHES.json` is
currently empty (`"entries": []`); previously recorded entries were cleared
after their fixes landed.

The `compare.ts:deepEqual` function (line 77) compares issue objects by
filtered key set — keys with `undefined` values count as absent (line 93–94),
so a field present-but-undefined on one side and absent on the other is NOT a
mismatch. This means payload field **presence** is the primary divergence
surface, not field value differences.

### Known payload/trace divergence classes

Each class is grounded in the source files that produce the divergent payloads.
The fuzz harness classifies mismatches by `caseKind|diffTag` signatures; the
classes below map to the source-level root causes.

#### P1. Issue field key insertion order

Rust `issue.rs` constructs issues with `Issue::new("code", path).with("k", v)`
— fields pushed in insertion order, `path` serialized last
(`issue.rs:122–130`). TS `interpreter.ts:issue()` (line 56) constructs
`{...details, input, path, inst: {error: node.error}}` — the key order depends
on the `details` object literal construction at each call site. The
`issue.rs` doc comment (line 64–67) states insertion order "mirrors the TS
interpreter's issue-construction sites exactly", and `insert_before_code`
(`issue.rs:114`) handles codes whose canonical key order has `origin` or
`expected` before `code` (e.g. `too_small`, `invalid_format`, `invalid_type`).
Divergences occur when a Rust issue-construction site pushes fields in a
different order than the corresponding TS `details` object literal.

**Files:** `crates/zodrs/src/issue.rs:64–130`, `packages/zodrs/src/core/interpreter.ts:56–65`

#### P2. `received` field on `invalid_type`

TS `interpreter.ts` includes a `received` field on `invalid_type` issues for
NaN (`"NaN"`), Infinity (`"Infinity"`), and invalid Date (`"Invalid Date"`)
cases (lines 654, 697). Rust `validate.rs:invalid_type` (line 154) emits only
`code` and `expected` — no `received` field. Since `compare.ts` treats
`undefined` as absent, a missing `received` on the Rust side matches an absent
`received` on the TS side, but a present `received` on the TS side with no
corresponding Rust field is a mismatch.

**Files:** `crates/zodrs/src/validate.rs:154–156`, `packages/zodrs/src/core/interpreter.ts:652–654,697`

#### P3. `origin` field presence on format issues

TS `interpreter.ts` conditionally includes `origin: "string"` on
`invalid_format` issues — present for regex-backed formats (line 284), absent
for procedural formats like `jwt`, `ipv6`, `cidrv6`, `base64`, `base64url`
(line 278). Rust `validate.rs:format_issue` (line 1061) includes `origin` when
a `pattern` is present but omits it for patternless formats (line 1068). The
two sides must agree on which formats are "procedural" (no `origin`) vs
"regex-backed" (with `origin`).

**Files:** `crates/zodrs/src/validate.rs:1053–1072`, `packages/zodrs/src/core/interpreter.ts:259–288`

#### P4. Number representation edge cases

Rust uses `f64` and `num_json()` to serialize numbers in issue payload fields
(`minimum`, `maximum`, `divisor`). TS uses JavaScript numbers. Edge cases:
`-0` serializes as `0` in Rust but `-0` in JS (though `Object.is(-0, 0)` is
false, `deepEqual` uses `Object.is` for numbers, `compare.ts:78`). Large
integers beyond `MAX_SAFE_INT` (2^53-1) may lose precision in `f64`. The
`compare.ts:show` function (line 62) preserves `-0`, `NaN`, `Infinity` in
mismatch reports, confirming these are known comparison concerns.

**Files:** `crates/zodrs/src/validate.rs:27,1029–1052`, `packages/conformance/differential/compare.ts:62–80`

#### P5. Union branch error flattening

Both sides flatten union branch errors into `invalid_union` issues with an
`errors` array of per-branch issue arrays. TS `interpreter.ts` (lines 547,
554, 577) has three distinct paths: first-success-wins, zero-success
(`errors: branchErrors`), and multi-success (`errors: [], inclusive: false`).
It also surfaces a single non-aborted branch's own issues instead of
`invalid_union` (line 569–575). Rust `validate.rs` (lines 516, 985) has two
paths: zero-success and disc-union no-match. The non-aborted-branch surfacing
and `inclusive: false` multi-match paths may not have Rust equivalents.

**Files:** `crates/zodrs/src/validate.rs:510–520,980–990`, `packages/zodrs/src/core/interpreter.ts:540–578`

#### P6. Record duplicate-key detection

Rust `scan.rs` has a 128-entry cap for duplicate-key detection in the byte
scanner; beyond that, `dirty_hint` is set and the DOM walk handles it
(`validate.rs` Record arm uses `HashMap` for O(n) duplicate detection). TS
`interpreter.ts` uses `Reflect.ownKeys` which naturally de-duplicates (last
value wins). The issue sets may differ when the scanner's cap changes which
path processes the input, or when the DOM walk's `HashMap`-based detection
produces different `unrecognized_keys` issues than `Reflect.ownKeys`.

**Files:** `crates/zodrs/src/scan.rs`, `crates/zodrs/src/validate.rs:360–390`, `packages/zodrs/src/core/interpreter.ts:766–818`

#### P7. `note` field on specific issue codes

Both sides include `note` fields on certain issues: "Integers must be within
the safe integer range." on `too_big`/`too_small` for int format checks
(Rust `validate.rs:720,732`; TS does not include this `note` — it's absent
from `interpreter.ts` number_format check, line 243–249), and "No matching
discriminator" on `invalid_union` for disc-union no-match (Rust
`validate.rs:1020`; TS `interpreter.ts:525`). The `note` field presence must
match on both sides.

**Files:** `crates/zodrs/src/validate.rs:706–734,1018–1022`, `packages/zodrs/src/core/interpreter.ts:243–249,522–528`

#### P8. `input` back-fill path walking

The native path back-fills `input` by walking the issue's `path` against the
original `JSON.parse`'d value (`parse.ts:backFillInput`, line 207). If the
Rust-constructed path differs from what the TS interpreter would have
constructed (e.g., different key order in a record, or a missing path segment
for a nested issue), the back-filled `input` will be the wrong value, causing
a data mismatch in the `input` field. Sub-issues inside `errors`/`issues`
carry paths relative to their parent, so the parent's path is prepended
(line 210–211).

**Files:** `packages/zodrs/src/core/parse.ts:204–225`, `crates/zodrs/src/issue.rs:17–62`

#### P9. `invalid_value` vs `invalid_format` for MIME checks

TS `interpreter.ts` emits `invalid_value` with `values: check.v` for MIME
type checks (line 314). Rust `validate.rs` must match this — emitting
`invalid_value` (not `invalid_format`) with the same `values` array. A
code-level mismatch here would produce a `diffTag` of `issue:code` in the
fuzz harness.

**Files:** `crates/zodrs/src/validate.rs` (MIME check path), `packages/zodrs/src/core/interpreter.ts:314`

#### P10. `template_literal` format issue fields

TS `interpreter.ts` emits `invalid_format` with `format: "template_literal"`
and `pattern: node.pattern.source` (line 895). Rust `validate.rs` emits
`invalid_format` with `format: "template_literal"` but without a `pattern`
field (line 432–436). The missing `pattern` field is a payload divergence.

**Files:** `crates/zodrs/src/validate.rs:428–437`, `packages/zodrs/src/core/interpreter.ts:895`

#### P11. `not_multiple_of` `origin` field

TS `interpreter.ts` sets `origin: typeof value` (which is `"number"` or
`"bigint"`) on `not_multiple_of` issues (line 235). Rust `validate.rs` sets
`origin: "number"` (line 686). For bigint inputs, the TS side produces
`origin: "bigint"` while the Rust side may produce `origin: "number"` or
omit `origin` entirely — a payload field mismatch.

**Files:** `crates/zodrs/src/validate.rs:682–690`, `packages/zodrs/src/core/interpreter.ts:233–236`

#### P12. Disc-union no-match issue path and fields

TS `interpreter.ts` emits the disc-union no-match `invalid_union` issue at
path `[...path, node.key]` (line 522) with fields `errors: []`, `note`,
`discriminator`, `options` (lines 523–528). Rust `validate.rs` emits at
path `[...path, disc_key]` (line 1016–1017) with `errors`, `note`,
`discriminator`, `options` (lines 1018–1022). The field sets match, but the
`options` array construction may differ: TS uses `[...node.map.keys()]`
(line 527), Rust uses `Json::Array(options)` from the compiled plan
(line 1022). If the plan's option ordering differs from the map's insertion
order, the `options` arrays will differ.

**Files:** `crates/zodrs/src/validate.rs:989–1025`, `packages/zodrs/src/core/interpreter.ts:511–528`

### Fuzz harness infrastructure

| Component | File | Role |
|---|---|---|
| Fuzz loop | `differential/fuzz.test.ts` | Schema-per-50-cases, per-case sub-seeds, mismatch classification, summary |
| Schema generator | `differential/genSchema.ts` | Random JSON-eligible plan IR: primitives, formats, objects, arrays, tuples, unions, records, enums, literals, wrappers |
| Input generator | `differential/genInput.ts` | Valid, near-miss mutations, adversarial bytes (`__proto__`, lone surrogates, `1e400`, 100-deep arrays, duplicate keys, BOM, NaN/Infinity) |
| Comparator | `differential/compare.ts` | Runs both paths, deep-compares results, classifies first difference |
| Mismatch ledger | `differential/ledger.ts` + `KNOWN-MISMATCHES.json` | Confirmed divergences with self-retiring skip rules |
| README | `differential/README.md` | Status, knobs, layout |

Run: `pnpm -C packages/conformance test:differential` (100k cases, plan §4 CI count).

## Plan residue items: confirmation

Each item from plan step 9, verified by grep over `packages/zodrs/src`
(2026-08-07). "Confirmed" = the symbol appears nowhere; the grep output is
recorded.

| Plan residue item | Verdict | Evidence |
|---|---|---|
| `src/v3/**` (legacy major version) | **Confirmed.** No v3 surface anywhere in zodrs. | `packages/zodrs/package.json` exports map has no `v3` entry; `ls packages/zodrs/src/classic/` shows no v3 tree. Corpus side: `packages/conformance/EXCISIONS.md` records the removal of `core/tests/index.test.ts` (the only file importing `zod/v3`). |
| `classic/compat.ts` (v3 compat shims) | **Confirmed.** | No `compat.ts` under `packages/zodrs/src/classic/`; `grep -rn "compat" packages/zodrs/src` matches only the words "compatible"/"compatibility" in comments. Compat symbols (`ZodIssueCode`, `setErrorMap`) are absent; `EXCISIONS.md` "compat-only symbols" section records the vendored tests that reference them. |
| `params.message` alias (deprecated alias for `error`) | **Corrected: not fully cut.** | The plan said cut; the implementation accepts it: `errorMap()` in `classic/schemas.ts` resolves `params?.error ?? params?.message`. Rationale: `EXCISIONS.md` documents that much of the vendored corpus uses `{ message: "..." }` as a parameter, so the alias stays as a silent fallback to keep the conformance oracle meaningful. Only the v3-throw interaction test (`"do not allow error and message together"`) is excised. `invalid_type_error`/`required_error` remain fully cut (`grep` → no matches). |
| `core/zsf.ts` (type-only, dead) | **Confirmed.** | `grep -rn "zsf" packages/zodrs/src` → no matches. |
| `core/doc.ts` `Doc` builder (replaced by codegen) | **Confirmed.** | `grep -rn "Doc" packages/zodrs/src` → no matches. Codegen is `core/codegen.ts` compiled closures (decision 1). |
| `util.jitless` global flag (replaced by capability probing + interpreter) | **Confirmed with a correction.** Zod 4.4.3 has no `util.jitless` symbol; the flag lives on `globalConfig.jitless` (Zod `util.ts:367` reads `globalConfig.jitless`). | `grep -rn "util.jitless" packages/zodrs/src` → no matches. The *behavior* is essential and present: `core/config.ts:9` declares `jitless?: boolean`, `classic/schemas.ts:152` selects the interpreter when `config().jitless` is set, and `CODEGEN_AVAILABLE` (CG) is the capability probe. Vendored `jitless-allows-eval.test.ts` pins the config path (see gap 13 for the missing `allowsEval` export). |
| `$ZodObject`/`$ZodObjectJIT` split (one object implementation) | **Confirmed.** | `grep -rn "ZodObjectJIT" packages/zodrs/src` → no matches. One `"object"` node kind in IR, validated by INT's object case and specialized by CG's object case. |
| `classic`/`mini` duplicated hierarchies (one core, two projections) | **Confirmed.** | `mini/mini.ts:1–15` is a projection: it imports `node`/`cloneNode` from `core/nodes.js`, wraps the same `SchemaNode` graph, and inherits validation/parse from the classic `$ZodType` base. No second validator exists. |

Additional residue identified during the walk (beyond the plan's list):

| Residue | Reason |
|---|---|
| `ParsePayload` wrapper object (`{value, issues}` per node) | Replaced by direct value returns + `FAIL` sentinel and a lazy per-parse issue array (INT `ValidationContext`); zero-allocation success path. |
| `numericOriginMap` (checks.ts:55) | Internal lookup for issue `origin` strings; INT derives `origin` directly from the node kind in `applyChecksSync`. |
| `_$ZodTypeInternals` lazy `values`/`pattern`/`propValues` machinery (`util.defineLazy`) | zodrs computes discriminators at factory time (`discriminantValues`, CL) and template patterns at construction (`templatePattern`, CL); no per-instance lazy internals. |
| Per-direction `$ZodCodec`/`$ZodPipe` `handleCodec*` direction dispatch | Cut together with the unimplemented encode direction; tracked as gap 2, not silently dropped. |

---

## Classification: `core/schemas.ts` (98 units)

### Base and primitives

| Unit | Class | zodrs | CONTRACT |
|---|---|---|---|
| `$ZodType` (base init, checks attach, `run`) | essential | IR `NodeCommon`; CL `$ZodType` base class (schemas.ts:132); INT `runSync`/`applyChecksSync` | §1, §6 |
| `$ZodString` | essential | IR `"string"`; INT/CG string cases; CL `string()` | §4 |
| `$ZodNumber` (incl. NaN/±Infinity rejection) | essential | IR `"number"`; INT/CG number cases; CL `number()` | §4 |
| `$ZodNumberFormat` | essential | check `number_format`; FMT; CL `int32()` etc. | §6 |
| `$ZodBoolean` | essential | IR `"boolean"`; CL `boolean()` | §4 |
| `$ZodBigInt` | essential | IR `"bigint"`; CL `bigint()` | §4 |
| `$ZodBigIntFormat` | essential | check `bigint_format`; FMT; CL `int64()`/`uint64()` | §6 |
| `$ZodSymbol` | essential | IR `"symbol"`; CL `symbol()` | §4 |
| `$ZodUndefined` | essential | IR `"undefined"`; CL `undefined_()` | §4 |
| `$ZodNull` | essential | IR `"null"`; CL `null_()` | §4 |
| `$ZodAny` | essential | IR `"any"`; CL `any()` | §4 |
| `$ZodUnknown` | essential | IR `"unknown"`; CL `unknown()` | §4 |
| `$ZodNever` | essential | IR `"never"`; CL `never()` | §4 |
| `$ZodVoid` | essential | IR `"void"`; CL `void_()` | §4 |
| `$ZodDate` (invalid-Date rejection) | essential | IR `"date"`; CL `date()` | §4 |
| `$ZodNaN` | essential | IR `"nan"`; CL `nan()` | §4 |
| `$ZodFile` | essential | IR `"file"`; CL `file()` | §12 |
| `$ZodLiteral` | essential | IR `"literal"`; CL `literal()` | §4 |
| `$ZodEnum` (values, `.enum` access, `.options`, extract/exclude) | essential, **partially missing** | IR `"enum"`; CL `enum_()`; member access/extract/exclude → gap 6 | §4 |

### String formats

All are `format` checks (`{c:"format", v: FormatId}`) over FMT engines, with
classic factories CL:706–741 and `iso.*` (CL:741); Rust mirrors them in
`crates/zodrs/src/formats.rs` (hand-written scanners for the four lookaround
formats). CONTRACT §5 covers every row.

| Unit | Class | zodrs |
|---|---|---|
| `$ZodStringFormat` (base) | essential | FMT `testFormat`; check `{c:"format"}` |
| `$ZodGUID` / `$ZodUUID` (+v4/v6/v7 patterns) | essential | FMT; CL `guid()`/`uuid()`/`uuidv4/6/7()` |
| `$ZodEmail` (default lookaround + html5/rfc5322/unicode variants) | essential | FMT; CL `email()`; RS hand scanner |
| `$ZodURL` (`new URL` semantics, protocol/hostname params; httpUrl) | essential | FMT; CL `url()`/`httpUrl()` |
| `$ZodEmoji` | essential | FMT; CL `emoji()` |
| `$ZodNanoID` | essential | FMT; CL `nanoid()` |
| `$ZodCUID` / `$ZodCUID2` | essential | FMT; CL `cuid()`/`cuid2()` |
| `$ZodULID` / `$ZodXID` / `$ZodKSUID` | essential | FMT; CL `ulid()`/`xid()`/`ksuid()` |
| `$ZodISODateTime` (precision/offset/local + semantic ranges) | essential | FMT; CL `iso.datetime()`; RS via jiff |
| `$ZodISODate` / `$ZodISOTime` | essential | FMT; CL `iso.date()`/`iso.time()` |
| `$ZodISODuration` (lookaround → hand scanner) | essential | FMT; CL `iso.duration()`; RS hand scanner |
| `$ZodIPv4` / `$ZodIPv6` | essential | FMT; CL `ipv4()`/`ipv6()` |
| `$ZodMAC` (delimiter param) | essential | FMT; CL `mac({delimiter?})` |
| `$ZodCIDRv4` / `$ZodCIDRv6` | essential | FMT; CL `cidrv4()`/`cidrv6()` |
| `isValidBase64` / `$ZodBase64` | essential | FMT base64 shape+length arithmetic; CL `base64()` |
| `isValidBase64URL` / `$ZodBase64URL` | essential | FMT; CL `base64url()` |
| `$ZodE164` | essential | FMT; CL `e164()` |
| `isValidJWT` / `$ZodJWT` (alg matching) | essential | FMT; CL `jwt()` |
| `$ZodCustomStringFormat` (named predicate/regex formats) | essential, **type export missing** | CL `stringFormat()` (behavior); `ZodCustomStringFormat` type → gap 7 |

### Array, object, tuple

| Unit | Class | zodrs | CONTRACT |
|---|---|---|---|
| `$ZodArray` + `handleArrayResult` | essential | IR `"array"`; INT/CG array cases | §8 |
| `$ZodObject` | essential | IR `"object"`; INT/CG object cases (strip/strict/passthrough/catchall, schema key order, `__proto__` drop) | §7, §22 |
| `$ZodObjectJIT` | **residue** | (none) | JIT split cut; one object implementation (see residue table) |
| `normalizeDef` (catchall shorthand expansion) | essential (behavior) | CL `strict()`/`passthrough()`/`strip()`/`catchall()` mode setters on the object node | §7 |
| `handlePropertyResult` | essential | INT object per-key parse + path prefixing | §7 |
| `handleCatchall` | essential | INT object unknown-key catchall branch | §7 |
| `$ZodTuple` | essential, **under-length precheck missing** | IR `"tuple"`; INT tuple case; gap 4 for the single-`too_small` optStart precheck | §8 |
| `getTupleOptStart` | essential, **missing** | gap 4 | §8 |
| `handleTupleResult` / `handleTupleResults` (optional-tail truncation, default fill) | essential | INT tuple loop runs `max(input.length, items.length)` so trailing `.default()/.optional()` items fill from `undefined` | §8 |

### Unions and intersection

| Unit | Class | zodrs | CONTRACT |
|---|---|---|---|
| `$ZodUnion` + `handleUnionResults` (first success wins, per-option issue arrays) | essential | IR `"union"`; INT/CG union cases | §9 |
| `$ZodXor` + `handleExclusiveUnionResults` (exactly-one semantics, `inclusive:false` multi-match) | essential | CL `xor()` (schemas.ts:583–601, counts option successes via a host closure; poisons JSON eligibility, acceptable since xor is rare) | §9 |
| `$ZodDiscriminatedUnion` (map dispatch, no-match issue, wrapper traversal, `unionFallback`, backward-direction fallback) | essential, **partially missing** | IR `"discunion"`; INT/CG discunion cases + CL `discriminantValues`; wrapper traversal/`unionFallback` → gap 10 | §9 |
| `$ZodIntersection` | essential | IR `"intersection"`; INT intersection case | §10 |
| `mergeValues` (deep object merge, array element merge, primitive equality, `Unmergable intersection` throw) | essential | INT intersection merge branch (`{...left, ...right}` object merge, `Object.is` primitives, plain-`Error` throw). Note: Zod merges nested objects recursively and arrays element-wise; zodrs merges top-level keys only. Deep-merge divergence risk → covered by vendored `intersection` tests; flagged here as a watch item, not a confirmed gap. | §10 |
| `handleIntersectionResults` (issue merge from both sides) | essential | INT intersection case runs both sides against one context | §10 |

### Record, map, set

| Unit | Class | zodrs | CONTRACT |
|---|---|---|---|
| `$ZodRecord` (key+value parse, parsed-key output) | essential, **exhaustiveness missing** | IR `"record"`; INT record case; enum-key exhaustiveness + `partialRecord`/`looseRecord` → gap 5 | §11 |
| `$ZodMap` + `handleMapResult` (property-key prefixing vs `invalid_key`/`invalid_element` wrapping) | essential | IR `"map"`; INT map case (same property-key split, verified line-by-line against Zod) | §11 |
| `$ZodSet` + `handleSetResult` | essential | IR `"set"`; INT set case | §11 |

### Wrappers and directionals

| Unit | Class | zodrs | CONTRACT |
|---|---|---|---|
| `$ZodOptional` + `handleOptionalResult` | essential | IR `"optional"`; INT/CG optional cases | §14 |
| `$ZodExactOptional` | essential, **wrong semantics** | CL `.exactOptional()` aliases `.optional()` → gap 3 | §14 |
| `$ZodNullable` | essential | IR `"nullable"`; INT/CG | §14 |
| `$ZodDefault` + `handleDefaultResult` (short-circuit, dynamic values, decode-only) | essential, **decode-only short-circuit unenforced** | IR `"default"`; INT default case; encode-side → gap 2 | §14 |
| `$ZodPrefault` (pre-parse default) | essential | IR `"prefault"`; INT prefault case | §14 |
| `$ZodNonOptional` + `handleNonOptionalResult` | essential | IR `"nonoptional"`; INT nonoptional case | §14 |
| `$ZodSuccess` | essential, **classic factory missing** | MINI `ZodMiniSuccess` (host transform); classic → gap 8 | §13/§14 |
| `$ZodCatch` (failure substitution, ctx-aware dynamic values) | essential | IR `"catch"`; INT catch case | §14 |
| `$ZodReadonly` + `handleReadonlyResult` (**shallow** `Object.freeze`) | essential | IR `"readonly"`; INT readonly case (shallow freeze, matching Zod). CONTRACT §14 says "deep-freezes"; the contract wording is wrong; Zod 4.4.3 freezes shallowly (`handleReadonlyResult`, schemas.ts:4210). Recorded here as a contract correction. | §14 |
| `$ZodTransform` (fallback marking, ctx.addIssue, thrown-error propagation) | essential | IR `"host"` op `transform`; INT host case | §15 |
| `$ZodPipe` + `handlePipeResult` | essential, **reverse missing** | IR `"pipe"`; INT pipe case; encode direction → gap 2 | §15 |
| `$ZodCodec` + `handleCodecAResult` + `handleCodecTxResult` | essential, **encode half missing** | CL `codec()` builds decode pipe only → gap 2; `invertCodec` classic → gap 9 | §15 |
| `$ZodPreprocess` | essential | CL `preprocess()` = `pipe(host transform, schema)` | §15 |
| `$ZodLazy` | essential | IR `"lazy"`; INT/CG lazy cases (reserved-id cycle handling in plan emission, core/plan.ts) | §13 |
| `$ZodPromise` (async-only) | essential | IR `"promise"`; INT promise case (returns a Promise; sync contexts surface `$ZodAsyncError` from PARSE) | §13 |
| `$ZodCustom` + `handleRefineResult` | essential | CL `custom()`; INT host case (`refine`/`superRefine`/`check` ops) | §13, §6 |
| `$ZodTemplateLiteral` (part-to-pattern compilation, stringification) | essential, **narrower input domain** | IR `"templateLiteral"`; CL `templatePattern` builds the regex at construction; INT matches strings. Zod stringifies number/bigint inputs before matching; zodrs requires `typeof "string"`. Vendored `template-literal` tests cover this; watch item, not a confirmed gap. | §13 |
| `$ZodFunction` | essential, **mostly missing** | CL `function_()` bare kind; INT typeof check only → gap 1 | §13 |

### `$ZodTypes` / `$ZodStringFormatTypes` unions

Type-level only; zero runtime. Covered by inference parity, not this walk.

---

## Classification: `core/checks.ts` (23 units)

All 21 check classes map to zodrs `RuntimeCheck` kinds executed by INT
`applyChecksSync` (+ CG specialized paths and RS `validate.rs` for the byte
path). Classic check factories: CL:667–703. CONTRACT §6 covers every row;
issue payload fields per §2.

| Unit | Class | zodrs |
|---|---|---|
| `$ZodCheck` (base init, `onattach`) | essential | IR `RuntimeCheck`; CL `runtimeCheck()` |
| `$ZodCheckLessThan` (`lt`/`lte`, inclusive flag, numeric origins) | essential | check `{c:"lt"}` incl. `inclusive`, bigint via string payload |
| `$ZodCheckGreaterThan` (`gt`/`gte`) | essential | check `{c:"gt"}` |
| `numericOriginMap` | **residue** | origin derived from node kind in INT (see residue table) |
| `$ZodCheckMultipleOf` (float-safe, bigint) | essential | check `{c:"multiple_of"}` (INT uses EPSILON-tolerant division; bigint via `%`) |
| `$ZodCheckNumberFormat` (int32/uint32/float32/float64/safeint ranges) | essential | check `{c:"number_format"}`; FMT; `NUMBER_FORMAT_RANGES` in core/util.ts |
| `$ZodCheckBigIntFormat` (int64/uint64) | essential | check `{c:"bigint_format"}`; `BIGINT_FORMAT_RANGES` in core/util.ts |
| `$ZodCheckMaxSize` / `$ZodCheckMinSize` / `$ZodCheckSizeEquals` | essential | checks `max_size`/`min_size`/`size` (Set/Map `.size`, `exact:true` on equals) |
| `$ZodCheckMaxLength` / `$ZodCheckMinLength` / `$ZodCheckLengthEquals` | essential | checks `max_length`/`min_length`/`length` |
| `$ZodCheckStringFormat` (format dispatch, `when` gating) | essential, **`when` missing** | check `{c:"format"}` + FMT; `when` → gap 11 |
| `$ZodCheckRegex` | essential | check `{c:"regex", src, flags}` |
| `$ZodCheckLowerCase` / `$ZodCheckUpperCase` | essential | checks `lowercase`/`uppercase` |
| `$ZodCheckIncludes` (position param) | essential | check `{c:"includes", position?}` |
| `$ZodCheckStartsWith` / `$ZodCheckEndsWith` | essential | checks `starts_with`/`ends_with` |
| `handleCheckPropertyResult` + `$ZodCheckProperty` | essential | check `{c:"property", key, schema}` (INT property branch; issues at `[..., key]`) |
| `$ZodCheckMimeType` | essential | check `{c:"mime"}` (`invalid_value` against `file.type`) |
| `$ZodCheckOverwrite` (trim/case/normalize/slugify/custom fn) | essential | check `{c:"overwrite", op, form?}` + `host_runtime` op `overwrite`; INT `applyOverwrite` |

---

## Classification: `core/api.ts` (120 functions + 1 const)

Every `_foo` is Zod's internal factory used to build classic/mini schemas.
The zodrs equivalent is the classic factory in CL (and its MINI projection);
behavior contract as cited. Grouped; overload signatures counted individually.

### Type factories

| Unit(s) | Class | zodrs | CONTRACT |
|---|---|---|---|
| `_string`, `_coercedString` | essential | CL `string()`, `coerce.string()` | §4, §17 |
| `_number`, `_coercedNumber` | essential | CL `number()`, `coerce.number()` | §4, §17 |
| `_boolean`, `_coercedBoolean` | essential | CL `boolean()`, `coerce.boolean()` | §4, §17 |
| `_bigint`, `_coercedBigint` (SyntaxError propagation) | essential | CL `bigint()`, `coerce.bigint()` | §4, §17 |
| `_date`, `_coercedDate` | essential | CL `date()`, `coerce.date()` | §4, §17 |
| `_symbol`, `_undefined`, `_null`, `_any`, `_unknown`, `_never`, `_void`, `_nan` | essential | CL `symbol()`, `undefined_()`, `null_()`, `any()`, `unknown()`, `never()`, `void_()`, `nan()` | §4 |
| `_file` | essential | CL `file()` | §12 |
| `_literal` (×3 overloads) | essential | CL `literal()` | §4 |
| `_enum` (×3 overloads), `_nativeEnum` | essential | CL `enum_()`, `nativeEnum` | §4 (extras → gap 6) |
| `_array` | essential | CL `array()` | §8 |
| `_union` | essential | CL `union()` | §9 |
| `_xor` | essential | CL `xor()` | §9 |
| `_discriminatedUnion` | essential, partial | CL `discriminatedUnion()`; traversal/`unionFallback` → gap 10 | §9 |
| `_intersection` | essential | CL `intersection()` | §10 |
| `_tuple` (×3 overloads) | essential | CL `tuple()` | §8 (precheck → gap 4) |
| `_record` | essential, partial | CL `record()`; exhaustiveness/`partialRecord`/`looseRecord` → gap 5 | §11 |
| `_map`, `_set` | essential | CL `map()`, `set()` | §11 |
| `_transform` | essential | CL `transform()` | §15 |
| `_optional`, `_nullable` | essential | CL `optional()`, `nullable()` | §14 |
| `_default` | essential | CL `.default()`/node `"default"` | §14 |
| `_nonoptional` | essential | CL `nonoptional()` | §14 |
| `_success` | essential, **missing in classic** | MINI `ZodMiniSuccess`; → gap 8 | §13 |
| `_catch` | essential | CL `.catch()`/node `"catch"` | §14 |
| `_pipe` | essential | CL `pipe()`/`.pipe()` | §15 (encode → gap 2) |
| `_readonly` | essential | CL `readonly()` | §14 |
| `_templateLiteral` | essential | CL `templateLiteral()` | §13 |
| `_lazy` | essential | CL `lazy()` | §13 |
| `_promise` | essential | CL `promise()` | §13 |
| `_custom` | essential | CL `custom()` | §13 |
| `_refine`, `_superRefine`, `_check` | essential | CL `.refine()/.superRefine()/.check()` methods; MINI free `refine`/`superRefine`/`check` (mini.ts:1160–1170) | §6 |

### String-format factories

All essential; each maps to the CL formatted factory of the same name
(CL:706–741) over FMT, contract §5. `when` param support → gap 11 applies to
all of them.

`_email`, `_guid`, `_uuid`, `_uuidv4`, `_uuidv6`, `_uuidv7`, `_url`, `_emoji`,
`_nanoid`, `_cuid`, `_cuid2`, `_ulid`, `_xid`, `_ksuid`, `_ipv4`, `_ipv6`,
`_mac`, `_cidrv4`, `_cidrv6`, `_base64`, `_base64url`, `_e164`, `_jwt`,
`_isoDateTime`, `_isoDate`, `_isoTime`, `_isoDuration`, `_stringFormat`
(→ CL `stringFormat`; `ZodCustomStringFormat` type → gap 7).

`TimePrecision` (const), essential. CL:772 `TimePrecision`
(`{minute:-1, second:0, millisecond:3, microsecond:6}`), used by
`iso.datetime({precision})`/`iso.time({precision})`. §5.

### Check factories

All essential; each maps to the CL check factory of the same name
(CL:667–703), contract §6. `when` → gap 11.

`_lt`, `_lte`, `_gt`, `_gte`, `_positive`, `_negative`, `_nonpositive`,
`_nonnegative`, `_multipleOf`, `_maxSize`, `_minSize`, `_size`, `_maxLength`,
`_minLength`, `_length`, `_regex`, `_lowercase`, `_uppercase`, `_includes`,
`_startsWith`, `_endsWith`, `_property`, `_mime`, `_overwrite`, `_normalize`,
`_trim`, `_toLowerCase`, `_toUpperCase`, `_slugify`.

Number/bigint format factories: `_int`, `_float32`, `_float64`, `_int32`,
`_uint32`, `_int64`, `_uint64`, essential. CL `int()`, `float32()`,
`float64()`, `int32()`, `uint32()`, `int64()`, `uint64()` (CL:682–688). §6.

### Metadata and misc

| Unit | Class | zodrs | CONTRACT |
|---|---|---|---|
| `describe` (api.ts:1696) | essential, **core export missing** | `.describe()` method exists; free function → gap 14 | §18 |
| `meta` (api.ts:1709) | essential, **core export missing** | `.meta()` method exists; free function → gap 14 | §18, §19 |
| `_stringbool` | essential, **decode-only** | CL `stringbool()` (default truthy/falsy sets, case-insensitive, `invalid_value` on unrecognized); encode → gap 2 | §16 |

### Params types

`Params`, `TypeParams`, `CheckParams`, `StringFormatParams`,
`CheckStringFormatParams`, `CheckTypeParams`, and the per-factory `*Params`
aliases are type-level; zero runtime. The runtime-relevant param *behavior*
(unified `error` param, string shorthand, `{error}` object form) is essential
and lives in CL `errorMap()`; the deprecated `message` alias status is recorded
in the residue table. CONTRACT §3.

---

## Notes and watch items (not confirmed gaps)

- **Intersection deep merge**: Zod `mergeValues` merges nested objects
  recursively and arrays element-wise; INT merges top-level keys
  (`{...left, ...right}`). Pinned by vendored intersection tests; if those go
  green without recursive merge, record the shallow merge as an intentional
  divergence here.
- **`templateLiteral` input domain**: Zod stringifies number/bigint inputs
  before matching; INT requires a string. Watch vendored template-literal
  tests.
- **CONTRACT wording corrections identified by this audit**: §14 says readonly
  "deep-freezes"; Zod and zodrs both freeze **shallowly**; §9 claims
  discriminator features (wrapper traversal, `unionFallback`) that are gap 10;
  §11 documents `partialRecord`/`looseRecord` that are gap 5; §19 says JSON
  Schema is "emitted by the Rust core", superseded by decision 2.
- **`z.json()`**: present in zodrs (CL:774) as a classic-surface factory. It
  is not a unit of the three walked files (it lives in Zod's classic layer),
  so it is outside this walk's scope; noted for completeness.
