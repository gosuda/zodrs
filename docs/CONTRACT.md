# zodrs Behavior Contract

The observable-behavior specification for `zodrs`, a drop-in replacement for `zod` v4.4.3.
Both backends (TypeScript codegen/interpreter for `.parse`, Rust core for `.parseJson`) are
derived from this document and nothing else.

**Sources, in priority order:**

1. Zod's v4 test corpus — `.references/zod/packages/zod/src/v4/{classic,core}/tests/` — the
   conformance oracle. Claims below are traceable to those tests.
2. `.references/zod/packages/zod/src/v4/core/errors.ts` — issue codes and payload fields.
3. `.references/zod/packages/docs/` — public documentation.

**Conventions.** "Accepts"/"rejects" describe `.parse`/`.safeParse` on a JS value. "Issue"
means an entry in `ZodError.issues`. `{...}` in an outcome column names issue payload fields
beyond the base fields (`code`, `path`, `message`, `input`). Every rejection is a `ZodError`
from `parse`, `{ success: false, error }` from `safeParse`, unless noted.

---

## 1. Parse pipeline invariants

| Rule | Behavior | Oracle |
|---|---|---|
| Issue accumulation | Validation collects issues and continues where possible. Sibling object keys, array elements, record entries, union options all report their own issues in one pass. A failing transform/refinement aborts only its own subtree. | `continuability.test.ts` |
| `path` | Property keys (`string`), array/tuple indices (`number`) in traversal order, outermost last. Root-level issue: `path: []`. | every object/array test |
| `input` | Each issue carries the value that failed (per-node input). With parse param `reportInput: true`, `input` is the original root input instead. | `error.test.ts` |
| `message` | Resolved through the precedence chain in §3 at issue-finalization time. | `error.test.ts` |
| Sync vs async | Sync `.parse`/`.safeParse` encountering an async refinement/transform **throws** (not a ZodError). Async variants resolve them. | `async-parsing.test.ts`, `async-refinements.test.ts` |
| `ZodError.message` | Pretty-printed JSON of the issues array. `ZodError extends Error`, has `.issues: $ZodIssue[]`. | inline snapshots throughout |
| Params immutability | The caller's parse-params object is never mutated. | `codec.test.ts` "context immutability" |
| Success output | The validated (and possibly transformed/rewritten) value. No wrapper object. | everywhere |

## 2. Issue taxonomy

Base fields on every issue: `code`, `path: PropertyKey[]`, `message: string`, `input?`.

| `code` | Extra payload fields | Emitted by |
|---|---|---|
| `invalid_type` | `expected: string` (one of `string number int boolean bigint symbol undefined null never void date array object tuple record map set file nonoptional nan function`, or a class name for `instanceof`) | wrong runtime type |
| `too_big` | `origin: "number"\|"int"\|"bigint"\|"date"\|"string"\|"array"\|"set"\|"map"\|"file"`, `maximum: number\|bigint`, `inclusive?: boolean`, `exact?: boolean` | size/value over max |
| `too_small` | `origin` (same set), `minimum: number\|bigint`, `inclusive?: boolean`, `exact?: boolean` | size/value under min |
| `invalid_format` | `format: string`, `pattern?: string` (regex-family only); subtypes add `prefix` / `suffix` / `includes` / `alg?` | string-format checks, number/bigint format checks |
| `not_multiple_of` | `divisor: number` (payload may carry bigint for bigint schemas) | `multipleOf`/`step` |
| `unrecognized_keys` | `keys: string[]` | strict objects |
| `invalid_union` | `errors: $ZodIssue[][]` (per-option issues; `[]` for no-discriminator-match and xor multi-match), `discriminator?: string`, `options?: Primitive[]`, `inclusive?: true \| false` (`false` = xor multiple match) | union/discriminatedUnion/xor |
| `invalid_key` | `origin: "map"\|"record"`, `issues: $ZodIssue[]` | record/map key failures |
| `invalid_element` | `origin: "map"\|"set"`, `key: unknown` (map: the entry's key; set: `null`), `issues: $ZodIssue[]` | map/set element failures |
| `invalid_value` | `values: Primitive[]` | literal/enum/nativeEnum/mime |
| `custom` | `params?: Record<string, any>` | `refine`, `superRefine`, `check`, `custom`, `ctx.addIssue` |

Default English messages (`locales/en.ts`, the fallback locale) interpolate these fields:

- `invalid_type`: `Invalid input: expected {expected}, received {parsedType(input)}` (`nan` → `NaN`; `Infinity` input → `received Infinity` in the raw issue, displayed via parsedType).
- `too_big`/`too_small`: sizable origins (string→characters, file→bytes, array/set→items, map→entries) render `expected {origin} to have {<=|>=}{n} {unit}`; value origins render `to be {<=|>=|<|>}{n}`.
- `invalid_format`: `Invalid {format-name}` (`email address`, `UUID`, `URL`, `ISO datetime`, …); regex → `Invalid string: must match pattern {pattern}`; starts_with/ends_with/includes → `Invalid string: must start with "{prefix}"` / `end with "{suffix}"` / `include "{includes}"`.
- `invalid_value`: single value → `Invalid input: expected {v}`; multiple → `Invalid option: expected one of {a|b|c}`.
- `invalid_union` with `options`: `Invalid discriminator value. Expected 'a' | 'b'`; otherwise `Invalid input`.
- `unrecognized_keys`: `Unrecognized key(s): "k1", "k2"`.
- `not_multiple_of`: `Invalid number: must be a multiple of {divisor}`.
- `invalid_key`/`invalid_element`: `Invalid key in {origin}` / `Invalid value in {origin}`.
- `custom`: `Invalid input`.

## 3. Error-message precedence chain

Highest to lowest (docs: `error-customization.mdx` "Error precedence"; tests: `error.test.ts`, `global-config.test.ts`):

1. **Schema-level `error`** — the `error` param on a factory or on an individual check (`z.string("…")`, `.min(3, "…")`, `z.string({ error: (iss) => … })`). A function map returning `undefined` yields to the next level.
2. **Parse-call `error`** — second arg to `.parse`/`.safeParse`/top-level `z.parse`.
3. **Global `customError`** — `z.config({ customError })`.
4. **Global `localeError`** — set via `z.config(z.locales.en())`-style locale modules; locale modules are factories returning `{ localeError }`.
5. **Default** — the built-in English messages (§2).

Params style: `error` accepts a string, a function `(issue) => string | undefined | { message }`, or an object `{ error: ... }` (the unified `error` param; the deprecated v3 `message`/`invalid_type_error`/`required_error` aliases are **cut**).

---

## 4. Primitive schemas

| Schema | Accepts | Rejects (issue) | Output |
|---|---|---|---|
| `z.string()` | any string | non-string → `invalid_type {expected:"string"}` | input as-is |
| `z.number()` | finite numbers only | `NaN` → `invalid_type {expected:"number"}`; `±Infinity` → `invalid_type {expected:"number"}` (raw `received:"Infinity"`); non-number → `invalid_type` | input as-is |
| `z.bigint()` | bigints | non-bigint → `invalid_type {expected:"bigint"}` | input as-is |
| `z.boolean()` | `true`/`false` | else → `invalid_type {expected:"boolean"}` | input as-is |
| `z.date()` | `Date` instances with valid time | invalid `Date` (`getTime()` NaN) and non-Date → `invalid_type {expected:"date"}` | the same Date |
| `z.symbol()` | symbols | else → `invalid_type {expected:"symbol"}` | input as-is |
| `z.undefined()` | `undefined` only | else → `invalid_type {expected:"undefined"}` | `undefined` |
| `z.null()` | `null` only | else → `invalid_type {expected:"null"}` | `null` |
| `z.void()` | `undefined` only | else → `invalid_type {expected:"void"}` | `undefined` |
| `z.any()` | everything | — | input as-is |
| `z.unknown()` | everything | — | input as-is |
| `z.never()` | nothing | everything → `invalid_type {expected:"never"}` | — |
| `z.nan()` | `NaN` only | else → `invalid_type {expected:"nan"}` | `NaN` |
| `z.literal(v)` / `z.literal([v1,v2])` | exactly `v` (one of listed values; supports string/number/boolean/null/bigint/symbol/undefined) | mismatch → `invalid_value {values:[...]}` | the literal |
| `z.enum([...])` | one of the listed strings (numeric literals allowed in v4) | else → `invalid_value {values:[...]}` | the matched member |
| `z.nativeEnum(E)` | any valid value of the TS enum (numeric enums: the numeric values, not reverse-mapped keys) | else → `invalid_value {values:[...valid values]}` | the matched value |

`z.enum` extras: `.enum.NAME` property access for members, `.extract([...])`/`.exclude([...])` produce derived enums, `.options` lists members. Type-level: single-value literal infers the literal type; multi-value infers union.

## 5. String formats

All are `z.string()` subtypes: input must be a string (else `invalid_type {expected:"string"}`), then the format check runs. Failure → `invalid_format {format: <name>}` (+`pattern` for regex-backed formats). Success output is the input string.

| Factory / method | `format` payload | Contract |
|---|---|---|
| `z.email()` | `email` | Default email pattern (lookaround regex; Rust uses a hand-written scanner). Variants: `html5Email`, `rfc5322Email`, `unicodeEmail` via `pattern` param. |
| `z.guid()` | `guid` | `{8-4-4-4-12}` hex with any version. |
| `z.uuid()` | `uuid` | RFC 9562 UUID, nil excluded; accepts any version nibble `[0-9a-f]` per pattern. |
| `z.uuidv4()` | `uuidv4` | Version nibble `4`. `z.uuidv6()` → `uuidv6` (nibble `6`), `z.uuidv7()` → `uuidv7` (nibble `7`). |
| `z.url()` | `url` | Valid absolute URL per `new URL()`; optional `protocol`/`hostname` params constrain. |
| `z.httpUrl()` | `url` | `z.url()` restricted to `http:`/`https:`. |
| `z.hostname()` | `hostname` | Valid hostname (lookaround regex; hand-written scanner in Rust). |
| `z.emoji()` | `emoji` | Single emoji grapheme. |
| `z.nanoid()` | `nanoid` | 21 chars, `[A-Za-z0-9_-]`. |
| `z.cuid()` | `cuid` | `^c...` CUID v1. |
| `z.cuid2(opts?)` | `cuid2` | CUID2 (optional `length`). |
| `z.ulid()` | `ulid` | 26-char Crockford base32. |
| `z.xid()` | `xid` | 20 chars. |
| `z.ksuid()` | `ksuid` | 27 chars. |
| `z.ipv4()` | `ipv4` | Dotted-quad, each octet 0–255. |
| `z.ipv6()` | `ipv6` | Full/compressed IPv6. |
| `z.mac()` | `mac` | `aa:bb:cc:dd:ee:ff` hex pairs. |
| `z.cidrv4()` / `z.cidrv6()` | `cidrv4` / `cidrv6` | CIDR with prefix length. |
| `z.base64()` | `base64` | Valid base64 including correct padding/length. |
| `z.base64url()` | `base64url` | Unpadded base64url alphabet. |
| `z.e164()` | `e164` | `+` + up to 15 digits. |
| `z.jwt({alg?}?)` | `jwt` | Three base64url segments; header decodes to JSON with matching `alg` when given. |
| `z.hex()` | `hex` | Even-length lowercase/uppercase hex string. |
| `z.hash("md5"\|"sha1"\|"sha256"\|"sha384"\|"sha512", {enc?})` | `md5`…`sha512` | Correct-length digest in hex (default), base64, or base64url encoding. Method aliases `z.md5()` etc. |
| `z.iso.datetime({precision?, offset?, local?}?)` | `datetime` | ISO 8601 datetime shape **and** semantic calendar validity (real month/day/hour ranges). `offset: true` requires numeric offset (no `Z`); `local: true` forbids offset; `precision` fixes fractional-second digits. |
| `z.iso.date()` | `date` | `YYYY-MM-DD`, semantically valid calendar date. |
| `z.iso.time({precision?}?)` | `time` | `HH:mm[:ss[.fff]]`, valid ranges. |
| `z.iso.duration()` | `duration` | ISO 8601 duration (lookaround pattern → hand-written scanner in Rust). |
| `z.stringFormat(name, fn\|regex, opts?)` | `<name>` | Custom named format; predicate/regex decides; issue `invalid_format {format: name}` (`pattern` when regex). |

## 6. Checks catalog

Checks attach to schemas via methods or `.check(...)`. Failure issues as below; "origin" per §2.
Bound checks: `inclusive: true` for `min/max/gte/lte/length/size`, `false` for `gt/lt`;
`exact: true` only for `length`/`size`.

| Check (methods) | Applies to | Issue on failure |
|---|---|---|
| `min(n)` / `gte(n)` | number/bigint: value ≥ n; string: length ≥ n; array: len ≥ n; date: time ≥ n | `too_small {minimum:n, inclusive:true, origin}` |
| `max(n)` / `lte(n)` | same, upper bound | `too_big {maximum:n, inclusive:true, origin}` |
| `gt(n)` | number/bigint/date: value > n | `too_small {minimum:n, inclusive:false, origin}` |
| `lt(n)` | number/bigint/date: value < n | `too_big {maximum:n, inclusive:false, origin}` |
| `positive()` | `gt(0)` | `too_small {minimum:0, inclusive:false, origin:"number"}` |
| `negative()` | `lt(0)` | `too_big {maximum:0, inclusive:false, origin:"number"}` |
| `nonpositive()` | `lte(0)` | `too_big {maximum:0, inclusive:true}` |
| `nonnegative()` | `gte(0)` | `too_small {minimum:0, inclusive:true}` |
| `length(n)` | string/array exact length | `too_small`/`too_big {minimum\|maximum:n, inclusive:true, exact:true}` |
| `size(n)` | set/map exact size | same, origin `set`/`map` |
| `minSize(n)` / `maxSize(n)` | set/map size bounds | `too_small`/`too_big {origin:"set"\|"map"}` |
| `multipleOf(n)` / `step(n)` | number/bigint | `not_multiple_of {divisor:n}`; float-safe (scientific-notation divisors handled) |
| `finite()` | number | rejects ±Infinity (and NaN) → `invalid_type {expected:"number"}`; no-op on finite values |
| `int()` / `z.int()` | number | integer **and** safe (`Number.isSafeInteger`) → else `invalid_format {format:"safeint", origin:"number"}` |
| `int32()` / `uint32()` | number | range −2³¹…2³¹−1 / 0…2³²−1 → `invalid_format {format:"int32"\|"uint32", origin:"number"}` |
| `float32()` / `float64()` | number | representable in the float width → `invalid_format {format:"float32"\|"float64"}` |
| `int64()` / `uint64()` | bigint | range ±2⁶³ / 0…2⁶⁴−1 → `invalid_format {format:"int64"\|"uint64", origin:"bigint"}` |
| `regex(re)` | string | `invalid_format {format:"regex", pattern:re.source}` |
| `lowercase()` / `uppercase()` | string | `invalid_format {format:"lowercase"\|"uppercase"}` |
| `includes(s, {position?}?)` | string | `invalid_format {format:"includes", includes:s}` |
| `startsWith(s)` | string | `invalid_format {format:"starts_with", prefix:s}` |
| `endsWith(s)` | string | `invalid_format {format:"ends_with", suffix:s}` |
| `trim()` | string | **overwrite** — never fails; output is `input.trim()` |
| `toLowerCase()` / `toUpperCase()` | string | **overwrite** — case-mapped output |
| `normalize(form?)` | string | **overwrite** — Unicode `String.prototype.normalize` (default NFC) |
| `slugify()` | string | **overwrite** — lowercased slug |
| `mime(types)` | file | `invalid_value {values:types}` against `file.type` |
| `property(key, schema)` | object | validates `input[key]` against `schema`; issues land at `path: [..., key]` |
| `min(n)`/`max(n)` on file | file | `too_small`/`too_big {origin:"file"}` over byte size |
| `overwrite(fn)` | any | **overwrite** — output `fn(value)`; runs with other checks, no issue unless `fn` throws (propagates) |
| `refine(fn, params?)` | any | falsy return → `custom {params?}`; `fn` may be async (async path only) |
| `superRefine(fn)` | any | `fn(value, ctx)`; `ctx.addIssue({code:"custom"\|…})` appends issues; any added issue fails |
| `check(...checks)` | any | attaches check instances (e.g. `z.minLength(3)`), evaluated in order after base parse |

Ordering: base type check → format/size checks in attach order → overwrites mutate the value →
refinements see the overwritten value. Checks with `abort: true` stop later checks in the same schema.

## 7. Object schemas

`z.object(shape)` — input must be a plain-ish object (non-null `typeof "object"`); else
`invalid_type {expected:"object"}`. Each present property is parsed by its shape schema; issues
get `path` prefixed with the key. A missing key feeds `undefined` to the value schema (so optional/
default/catch properties handle absence). Output is a **new object** whose key order is the **schema
shape order** (verified: `Object.keys(result)` equals shape order). Success output never aliases the
input object.

Unknown-key modes:

| Mode | Set by | Behavior on unknown keys |
|---|---|---|
| `strip` (default) | `z.object`, `.strip()` | Dropped from output; parse succeeds. |
| `strict` | `z.strictObject`, `.strict()` | One `unrecognized_keys {keys:[...]}` issue listing all unknown keys. |
| `passthrough` | `z.looseObject`, `.passthrough()` | Retained on output (values unparsed). |

- `.catchall(schema)`: overrides the mode entirely — unknown keys are retained after validating each against the catchall schema; failures issue at the key's path. `z.strictObject` ≡ catchall `never`; `z.looseObject` ≡ catchall `unknown`.
- Mode setters (`.strict()/.passthrough()/.strip()`) last-call-wins.
- Prototype safety (v4.4.3, GHSA-hardened): a `__proto__` key in input is **dropped** in strip/passthrough/catchall paths, never surfaces in `unrecognized_keys` for strict, and never pollutes the output's prototype. Output prototype is `Object.prototype`.
- `constructor`/`prototype` as shape keys parse normally.

Object methods:

| Method | Contract |
|---|---|
| `.shape` | The shape record (getter). |
| `.keyof()` | `z.enum` of shape keys. |
| `.extend(shape)` | New object with merged shape (incoming wins per key); preserves unknown-key mode of receiver. |
| `.safeExtend(shape)` | Like `extend` but refuses to overwrite existing keys with an incompatible schema (throws on conflict). |
| `.merge(other)` | Merge shape of `other` into receiver; incoming object's catchall/mode wins; throws if receiver has refinements. |
| `.pick({k:true})` / `.omit({k:true})` | Subset/superset shape; catchall preserved. |
| `.partial()` / `.partial({k:true})` | Wraps (selected) values in optional → keys may be absent. |
| `.required()` / `.required({k:true})` | Unwraps optionality (selected keys); `undefined` rejected. |

## 8. Array and tuple

| Schema | Accepts | Rejects | Output |
|---|---|---|---|
| `z.array(el)` | arrays; each element parsed by `el` | non-array → `invalid_type {expected:"array"}`; element failures → issues at `path:[i,…]`; `min/max/length` → `too_small`/`too_big {origin:"array"}` | new array of parsed elements |
| `z.tuple([a,b])` | arrays of exact length | wrong length → `too_small`/`too_big {origin:"array", minimum\|maximum:n, inclusive:true}`; per-item issues at index paths | new array |
| `z.tuple([a,b], rest)` | length ≥ items; extra items parsed by `rest` | shorter → `too_small {origin:"array"}`; rest item issues at their indices | new array |

Trailing tuple items wrapped in `.default()`/`.prefault()` (including through `.nullable()`/`.readonly()`)
are filled in when the input array is shorter — `[a, b.default("x")].parse(["v"]) → ["v","x"]`.

## 9. Union, discriminated union, xor

| Schema | Behavior |
|---|---|
| `z.union([...])` | Options tried in order; **first success wins** and its output (post-transform) is returned. All fail → single `invalid_union {errors:[issuesPerOption…]}`. `z.union([])` rejects everything. |
| `z.discriminatedUnion(key, [...])` | Dispatch on `input[key]`: matching option parses the whole input. Discriminator value with no option → `invalid_union {errors:[], discriminator:key, options:[...values], path:[key]}` + note "No matching discriminator". Matching option but bad data → that option's issues. Non-object input → `invalid_type`. Supports `literal`, `enum`, multi-value literal, optional, readonly, `null`, boolean, number, bigint discriminators, nested unions, and `{ unionFallback: true }` (falls back to plain-union scan on no discriminator match). Codecs as discriminators resolve per-direction. |
| `z.xor([...])` | Parses all options; **exactly one** may succeed. Zero matches → `invalid_union {errors:[…]}`; multiple matches → `invalid_union {errors:[], inclusive:false}`. `z.xor([])` rejects everything. Inference = plain union of options. |

## 10. Intersection

`z.intersection(a, b)` / `.and()`: both sides parse the input; failures from either side merge into
one issue list. Outputs are **deep-merged**: objects merge key-wise (recursively), equal primitives
pass, arrays merge element-wise. Unmergeable results (conflicting primitives, incompatible arrays)
**throw a plain `Error`** — `Unmergable intersection. Error path: [...]` — not a ZodError issue.

## 11. Record, map, set

| Schema | Accepts | Rejects | Output |
|---|---|---|---|
| `z.record(keySchema, valueSchema)` | plain objects; every key validated by `keySchema`, every value by `valueSchema` | non-object → `invalid_type`; bad key → `invalid_key {origin:"record", issues:[…]}`; bad value → issues at `path:[key,…]` | new object; keys are the **parsed** keys |
| `z.partialRecord(keySchema, valueSchema)` | as record, but enum/literal key sets are non-exhaustive | same | same |
| `z.map(k, v)` | `Map` instances; each key/entry parsed | bad key → `invalid_key {origin:"map", issues}`; bad value → `invalid_element {origin:"map", key:<the key>, issues}` | new `Map` of parsed entries |
| `z.set(v)` | `Set` instances; each element parsed | bad element → `invalid_element {origin:"set", key:null, issues}`; `min/max/size` → `too_small`/`too_big {origin:"set"}` | new `Set` |

Record with `z.enum` key schema is **exhaustive**: every enum key must be present. Key schemas that
transform (e.g. `z.string().toLowerCase()`) emit parsed keys. `z.looseRecord` = record without key
exhaustiveness guarantees.

## 12. File

`z.file()` — input must be a `File` instance → else `invalid_type {expected:"file"}`. Output is the
same File. Checks: `.min(bytes)`/`.max(bytes)` → `too_small`/`too_big {origin:"file", inclusive:true}`;
`.mime([...])` → `invalid_value {values:[mimeTypes]}` when `file.type` not listed.

## 13. Promise, lazy, function, custom, instanceof, templateLiteral

| Schema | Contract |
|---|---|
| `z.promise(inner)` | Input must be a `Promise`. **Async contexts only** — sync parse throws. Awaits input, parses resolution with `inner`; rejection/async failure rejects the parse promise. |
| `z.lazy(getter)` | `getter()` is invoked to obtain the inner schema (recursive schemas; memoization is an implementation detail, semantics = parse against `getter()` result). Enables cycles. |
| `z.function({input?, output?})` | Wraps a function: `.implement(fn)` returns a function that parses args against `input` (array/tuple of schemas; rest arg via second element of `.input(args, rest)`) and return value against `output`; failures throw. `this` is preserved (method parsing). Async refinements in input/output require async usage. |
| `z.custom<T>(predicate?, params?)` | No base validation; `predicate(value)` falsy → `custom {params?}`. Default predicate: always pass. Type-level wrapper. |
| `z.instanceof(cls, params?)` | `input instanceof cls` → else `invalid_type {expected:<class name>}`. Output is the instance. |
| `z.templateLiteral([...parts])` | Parts (strings, literals, enums, numbers, constrained schemas) compile to one pattern. Input is stringified (accepts string/number/bigint) then matched; mismatch → `invalid_format {format:"template_literal", pattern:<generated regex source>}`. Output is the (stringified) input. |

## 14. Wrapper schemas

| Wrapper | Forward (decode) behavior |
|---|---|
| `.optional()` / `z.optional(s)` | `undefined` → `undefined` (inner not run); else inner. |
| `.nullable()` / `z.nullable(s)` | `null` → `null`; else inner. |
| `.nullish()` / `z.nullish(s)` | `undefined` → `undefined`; `null` → `null`; else inner. |
| `.nonoptional()` / `z.nonoptional(s)` | `undefined` → `invalid_type {expected:"nonoptional"}`; else inner. |
| `.readonly()` / `z.readonly(s)` | Parses inner, then **deep-freezes** output (`Object.freeze`). Type `Readonly<T>`. |
| `.brand<T>()` | No runtime effect; type-level brand only. |
| `.default(v)` / `z.default(s, v)` | `undefined` input → **short-circuit**: `v` returned **without** running inner validation. `v` may be a function (called per parse). In objects, absent keys also trigger. |
| `.prefault(v)` / `z.prefault(s, v)` | `undefined` input → `v` is **parsed through the inner schema** ("pre-parse default"). Function form supported. Object-level prefault returns a shallow clone per parse. **Decode-direction only**: encoding `undefined` into a prefault schema fails inner validation. |
| `.catch(v)` / `z.catch(s, v)` | Any inner failure → `v` (or `v(ctx)`) returned, issues discarded. `undefined` input on `.catch().optional()` short-circuits to `undefined` (property omitted from object output), while bare `.catch` yields the catch value. |

## 15. Transforms, pipes, preprocess, codecs — direction rules

| Schema | Decode (`.parse`, `z.decode`, forward) | Encode (`z.encode`, reverse) |
|---|---|---|
| `.transform(fn)` / `z.transform(fn)` | Runs `fn(value, ctx)` after base parse; return value is output. `ctx.addIssue` adds issues (fails the parse). Thrown errors propagate. Output type unconstrained. | **Forbidden**: throws `ZodEncodeError: Encountered unidirectional transform during encode: ZodTransform`. |
| `.pipe(a, b)` / `z.pipe(a, b)` | Parses `a`, feeds `a`'s output into `b` as input; result is `b`'s output. | Reverse: encodes through `b` then `a`. |
| `z.preprocess(fn, schema)` | `fn` runs **before** `schema` sees the input (`pipe(transform, schema)`). | Reverse of pipe. |
| `z.codec(A, B, {decode, encode})` | `A.parse(input)` → `decode()` → `B.parse(result)` → output. | `B` (reverse) parses output-side input → `encode()` → `A` (reverse) validates → input-side value. Round-trip: `encode(decode(x)) ≈ x` when user functions are inverses. Refinements/overwrites attached via `.check`/`.overwrite` run in **both** directions. |
| `z.invertCodec(codec)` | Swaps directions: the inverted codec decodes what the original encodes. Double inversion = identity. | |

Fallback wrappers (`.default/.prefault/.catch`) short-circuit in the **decode direction only**.
Top-level: `z.parse ≡ z.decode`; `z.safeEncode` mirrors `z.safeParse` returning
`{success:true,data}|{success:false,error}`. Async variants (`parseAsync/safeParseAsync/encodeAsync…`
and `z.parseAsync` family) support async transforms/codecs/refinements.

## 16. stringbool

`z.stringbool({truthy?, falsy?, case?}?)` — a codec: input `string`, output `boolean`.

- Default truthy: `true yes 1 on y enabled`; falsy: `false no 0 off n disabled` — **case-insensitive** (`case: "sensitive"` opts out).
- Recognized string → `true`/`false`; anything else (incl. non-strings, `""`) → `invalid_value`-family failure (parse fails; `z.stringbool("msg")` sets the error).
- `z.encode(schema, true)` → **first** truthy string (`"true"` default); `false` → first falsy. Custom lists: encode returns `truthy[0]`/`falsy[0]`.

## 17. Coercion (`z.coerce.*`)

Input is run through a JS conversion primitive **before** base validation; failures of the base type
then produce normal issues. Verified conversions (`coerce.test.ts`):

| Schema | Conversion | Notable results |
|---|---|---|
| `z.coerce.string()` | `String(input)` | `12→"12"`, `null→"null"`, `undefined→"undefined"`, `true→"true"`, `{}`→`"[object Object]"`, `["a","b"]→"a,b"`, `NaN→"NaN"`. Everything converts; string checks then apply. |
| `z.coerce.number()` | `Number(input)` | `"12"→12`, `""→0`, `true→1`, `null→0`, `[]→0`, `Date→ms`. `"abc"`→NaN → `invalid_type`; `undefined`→NaN → fails; object/array-with-2+ → NaN → fails. |
| `z.coerce.boolean()` | `Boolean(input)` | Truthiness: `""/0/NaN/null/undefined→false`; `"false"→true`; `{}`→true. |
| `z.coerce.bigint()` | `BigInt(input)` | `"5"→5n`, `true→1n`, `[]→0n`. **Invalid conversions throw non-Zod `SyntaxError`** (`"3.14"`, `null`, `undefined`, objects) — propagate as-is. |
| `z.coerce.date()` | `new Date(input)` | strings/numbers/bools → Date; invalid (`""`, `"NOT_A_DATE"`, NaN, ±Infinity, objects, arrays) → invalid Date → `invalid_type {expected:"date"}`. `BigInt` input throws non-Zod TypeError. |

## 18. Instance methods (all schemas)

| Method | Contract |
|---|---|
| `.parse(data, params?)` / `.safeParse(data, params?)` | §1. `safeParse` → `{success:true,data} \| {success:false,error:ZodError}`. |
| `.parseAsync` / `.safeParseAsync` / `.spa` | async variants; `spa` = `safeParseAsync` alias. |
| `.parseJson(bytes)` / `.safeParseJson(bytes)` | **zodrs addition**, see §21. |
| `.optional() .nullable() .nullish() .readonly() .brand()` | §14 wrappers. |
| `.array()` | `z.array(this)`. |
| `.or(other)` | `z.union([this, other])`. `.and(other)` = `z.intersection`. |
| `.transform(fn)` | §15. |
| `.default(v) .prefault(v) .catch(v)` | §14. |
| `.describe(s)` / `.meta(obj)` | Write description/metadata into the registry (see §20); `.meta()` merges. Getters read back. |
| `.pipe(schema)` | §15. |
| `.refine(fn, params?) .superRefine(fn) .check(...)` `.overwrite(fn)` | §6. |
| `.clone()` / `z.clone(schema)` | Structural clone of the schema (new instance, same def semantics). |
| `.register(reg, meta)` | Adds metadata to registry `reg` for this schema. |
| `.def` / `.type` | `.def` = internal definition object; `.type` = string type tag (`"string"`, `"object"`, …). |

## 19. Top-level surface

| Member | Contract |
|---|---|
| `z.infer` / `z.output` / `z.input` | Type-level only: output/input types of a schema. Zero runtime. |
| `z.parse(s,d,p?)` `z.safeParse` `z.encode` `z.decode` `z.safeEncode` `z.safeDecode` (+`*Async`) | Free-function forms of the instance methods; encode/decode per §15. |
| `z.ZodError` | `class ZodError extends Error` with `.issues`; `message` = pretty JSON of issues. |
| `z.treeifyError(err, mapper?)` | `{ errors: string[], properties?: {…}, items?: [...] }` — nested tree mirroring issue paths. |
| `z.flattenError(err, mapper?)` | `{ formErrors: [], fieldErrors: { key: [] } }` — root issues vs first-level-path issues. |
| `z.formatError(err, mapper?)` | Nested object with `_errors: []` at every level along issue paths. |
| `z.prettifyError(err)` | Multi-line string `✖ {message}\n  → at {dot.path}` per issue. |
| `z.globalRegistry` | Default registry backing `.meta()`/`.describe()`. |
| `z.registry<T>()` | New `$ZodRegistry`: `.add(schema, meta)`, `.get(schema)`, `.remove`, `.has`; keyed by schema identity (WeakMap semantics). |
| `z.config({customError?, localeError?})` | Sets global error maps (precedence §3); called with a locale module factory result (`z.config(z.locales.en())`). |
| `z.locales.*` | 53 locale modules, each a factory returning `{ localeError }`. |
| `z.toJSONSchema(schema, opts?)` | Emits JSON Schema (draft 2020-12). `io: "input"\|"output"` chooses the side for directional schemas; cycles → `$ref`; `unrepresentable: "throw"\|"any"` policy for non-representable schemas; `default`/`prefault` surface as `default` (incl. falsy values); reused schemas → `$defs`. zodrs: emitted by the Rust core from the compiled plan. |

## 20. Standard Schema

Every schema exposes `~standard = { version: 1, vendor: "zodrs", validate }` (Zod uses vendor
`"zod"`). `validate(value)` returns `{ value }` on success, `{ issues: StandardSchemaV1.Issue[] }`
on failure — issues shaped `{ message, path? }`. Async schemas return a Promise from `validate`.

## 21. `parseJson` / `safeParseJson` (zodrs additions)

```ts
parseJson(input: Uint8Array | ArrayBuffer | string): Output          // throws ZodError
safeParseJson(input: Uint8Array | ArrayBuffer | string): SafeParseResult<Output>
```

| Condition | Observable behavior |
|---|---|
| Schema JSON-eligible (no host closures; all regexes compile in Rust) | Bytes validated in Rust. Result **deep-equal** to `JSON.parse` + `.parse`: same output value, same key order, and on failure **deep-equal issue arrays** (codes, payload fields, paths, `input` back-filled by path, messages through the §3 chain). |
| Not eligible, or no native/WASM backend | Transparent fallback: `JSON.parse(input)` then the TS validator. Identical observable result. |
| `string` input | Encoded to UTF-8 once, then as bytes. |
| Output | `status 0`: `JSON.parse(original bytes)`. `status 1` (dirty: key stripping, defaults, overwrites, coercion, key reorder): `JSON.parse(canonical payload)`. Invalid: issues JSON + back-filled inputs. `status 3` at runtime = planner bug → internal invariant error (never silently slow-paths). |

There is no `parseJsonAsync`; async schemas always take the TS path.

## 22. Prototype-safety invariants (contract-level)

- Output objects/arrays/maps/sets are freshly allocated per parse; no aliasing of mutable input.
- `__proto__` keys never reach output objects in any object mode (§7).
- `JSON.parse` materialization is the canonicalization boundary on the byte path; the differential
  fuzz suite asserts byte-path/value-path parity including `__proto__`, lone surrogates, duplicate
  keys, `1e400`, and NaN-adjacent inputs.
