import { checkUrl, patternForFormat, testFormat } from "./formats.js";
import { optinOf, optoutOf } from "./introspect.js";
import { applyOverwrite, runtime } from "./interpreter.js";
import type { ValidationContext, Validator } from "./interpreter.js";
import type { RuntimeCheck, SchemaNode, WireCheck } from "./nodes.js";
import type { $ZodRawIssue } from "./errors.js";
import {
  BIGINT_FORMAT_RANGES,
  FAIL,
  floatSafeRemainder,
  isObject,
  NUMBER_FORMAT_RANGES,
  shallowClone,
} from "./util.js";
import type { FAIL as FailType, Primitive } from "./util.js";

/**
 * zodrs emits specialized closures instead of evaluating generated source text
 * (CSP-strict runtimes stay supported, and no dynamic eval is used anywhere).
 * Each node kind compiles to a direct closure per node: object keys get
 * monomorphic leaf calls, primitive checks become straight-line code with
 * compile-time-hoisted constants, regexes are precompiled once per schema, and
 * discriminated unions dispatch through a single Map lookup. Node kinds too
 * rare to justify compilation (host, promise, function, intersection, record,
 * map, set, tuple, xor unions) delegate to the shared interpreter runtime, so
 * the two backends can never drift on observable behavior.
 *
 * Path threading — key-deferred: every compiled node takes the shared mutable
 * path stack plus an OPTIONAL trailing `key` (the segment its caller owed it).
 * Issue sites snapshot `[...path, key]` (or `path.slice()` when keyless), so
 * success paths perform zero path-stack work: containers push/pop their own
 * key around their body; leaves never touch the stack at all. Calls into the
 * shared runtime always receive a fresh snapshot array because the
 * interpreter stores (never mutates) the array it is given.
 */

type Ctx = ValidationContext;
type Path = PropertyKey[];
type CNode = {
  (input: unknown, context: Ctx, path: Path, key?: PropertyKey): unknown | FailType;
  /**
   * May push onto the path stack when called with key === undefined. When the
   * root's whole graph is push-free, parses share one module-level empty
   * array (never mutated) instead of allocating a path stack per parse.
   */
  pushes?: boolean;
  /** May push onto the path stack when called with a defined key (containers). */
  pushesKeyed?: boolean;
  /**
   * Fully-fused object-step factory (hot leaf kinds only): the child logic
   * inlined into the step, saving the child call. Lives beside the leaf
   * closure it mirrors so the two packagings cannot drift apart.
   */
  stepInto?: ((key: string, optIn: boolean, optOut: boolean, dangerous: boolean) => ShapeStep) | undefined;
  /**
   * Leaf kinds only: build a step factory for a wrapper-fused mode
   * (optional/nullable/default around this leaf). Same source of truth as
   * stepInto, so wrapper fusion cannot drift from the leaf semantics.
   */
  stepIntoUndef?: ((undef: UndefMode) => ((key: string, optIn: boolean, optOut: boolean, dangerous: boolean) => ShapeStep) | undefined) | undefined;
  /** Set on no-check, non-coerce string/number/boolean leaves so arrays can fuse the element test into the loop. */
  rawLeaf?: ("string" | "number" | "boolean") | undefined;
};

const hasOwn = Object.hasOwn as (obj: unknown, key: PropertyKey) => boolean;

/** How a fused step treats undefined/null before the leaf test (wrapper fusion). */
type UndefMode =
  | { readonly m: 0 } // reject via the leaf test (plain leaf)
  | { readonly m: 1 } // optional: undefined short-circuits to undefined
  | { readonly m: 2 } // nullable: null short-circuits to null, undefined falls through to rejection
  | { readonly m: 3; readonly dv: unknown }; // default: undefined short-circuits to dv (primitive)

/**
 * Cold half of a fused primitive step: the value read came back `undefined`.
 *
 * Every branch that needs to tell "absent" from "present and undefined" lives
 * here, so the hot path costs one `=== undefined` compare instead of an
 * `Object.hasOwn` call plus one compare per wrapper mode. Returns `true` when
 * the step is finished and the caller returns `false` (no issue); `false`
 * when the leaf test should still run and reject the `undefined`.
 */
function settledUndefined(
  undef: UndefMode,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  key: string,
  dangerous: boolean,
  swallow: boolean,
): boolean {
  const present = hasOwn(input, key);
  if (undef.m === 1) {
    if (present) {
      if (dangerous) defineValue(result, key, undefined);
      else result[key] = undefined;
    }
    return true;
  }
  if (undef.m === 3) {
    const d = undef.dv;
    if (d === undefined) {
      if (present) {
        if (dangerous) defineValue(result, key, undefined);
        else result[key] = undefined;
      }
    } else if (dangerous) defineValue(result, key, d);
    else result[key] = d;
    return true;
  }
  return swallow && !present;
}

/** A single wire check whose test can inline into a fused leaf step. */
type InlineSingle =
  | { readonly i: "numfmt"; readonly format: string; readonly integer: boolean; readonly min: number; readonly max: number; readonly rangeOrigin: string }
  | { readonly i: "pattern"; readonly re: RegExp; readonly format: string; readonly patternString: string }
  | { readonly i: "gt" | "lt"; readonly target: number; readonly inclusive: boolean; readonly origin: string };

/** Shared never-mutated path stack for graphs proven push-free at compile time. */
const EMPTY_PATH: Path = [];

/** Snapshot the current path plus an optionally deferred key (fresh array). */
function snap(path: Path, key: PropertyKey | undefined): Path {
  return key === undefined ? path.slice() : [...path, key];
}

/** Type-issue shape: `{ ...details, input, path, inst }` — interpreter key order. */
function nodeIssue(context: Ctx, error: unknown, details: Readonly<Record<string, unknown>>, input: unknown, path: Path, key: PropertyKey | undefined): void {
  (context.issues ??= []).push({ ...details, input, path: snap(path, key), inst: { error } } as $ZodRawIssue);
}

/** Check-issue shape for compiled checks (abort !== true ⇒ continue: true). */
function checkIssue(context: Ctx, error: unknown, details: Readonly<Record<string, unknown>>, input: unknown, path: Path, key: PropertyKey | undefined): void {
  (context.issues ??= []).push({ ...details, input, path: snap(path, key), inst: { error }, continue: true } as $ZodRawIssue);
}

// ─── Wire-check leaves ─────────────────────────────────────────────────────
//
// A leaf returns the (possibly rewritten) value, or FAIL when it pushed an
// issue. Failing checks never alter the value, so a FAIL return exactly
// mirrors the interpreter's "issues grew" bookkeeping while subsequent checks
// keep running against the original value.

type Leaf = (value: unknown, context: Ctx, path: Path, key: PropertyKey | undefined) => unknown;

/** Size probe per node kind; the generic chain matches applyChecksSync. */
function sizeCompiler(kind: SchemaNode["kind"]): (value: unknown) => number {
  if (kind === "string" || kind === "array") return (value) => (value as { length: number }).length;
  if (kind === "set" || kind === "map") return (value) => (value as { size: number }).size;
  return (value) =>
    typeof value === "string" || Array.isArray(value)
      ? value.length
      : value instanceof Set || value instanceof Map
        ? value.size
        : isObject(value) && typeof value["size"] === "number"
          ? (value as { size: number }).size
          : 0;
}

function compileWireCheck(check: WireCheck, error: unknown, kind: SchemaNode["kind"], origin: string): Leaf {
  switch (check.c) {
    case "min_length":
    case "min_size": {
      const v = check.v;
      const sizeOf = sizeCompiler(kind);
      return (value, context, path, key) =>
        sizeOf(value) < v
          ? (checkIssue(context, error, { origin, code: "too_small", minimum: v, inclusive: true }, value, path, key), FAIL)
          : value;
    }
    case "max_length":
    case "max_size": {
      const v = check.v;
      const sizeOf = sizeCompiler(kind);
      return (value, context, path, key) =>
        sizeOf(value) > v
          ? (checkIssue(context, error, { origin, code: "too_big", maximum: v, inclusive: true }, value, path, key), FAIL)
          : value;
    }
    case "length":
    case "size": {
      const v = check.v;
      const sizeOf = sizeCompiler(kind);
      return (value, context, path, key) => {
        const size = sizeOf(value);
        if (size === v) return value;
        if (size < v) checkIssue(context, error, { origin, code: "too_small", minimum: v, inclusive: true, exact: true }, value, path, key);
        else checkIssue(context, error, { origin, code: "too_big", maximum: v, inclusive: true, exact: true }, value, path, key);
        return FAIL;
      };
    }
    case "gt":
    case "lt": {
      const isGt = check.c === "gt";
      const inclusive = check.inclusive;
      const isBig = check.bigint === true;
      const target: number | bigint = isBig ? BigInt(check.v) : Number(check.v);
      return (value, context, path, key) => {
        const actual: unknown = value instanceof Date ? value.getTime() : value;
        if (typeof actual !== "number" && typeof actual !== "bigint") return value;
        const okay = isGt
          ? inclusive
            ? actual >= (target as number)
            : actual > (target as number)
          : inclusive
            ? actual <= (target as number)
            : actual < (target as number);
        if (okay) return value;
        if (isGt) checkIssue(context, error, { origin, code: "too_small", minimum: target, inclusive }, value, path, key);
        else checkIssue(context, error, { origin, code: "too_big", maximum: target, inclusive }, value, path, key);
        return FAIL;
      };
    }
    case "multiple_of": {
      const raw = check.v;
      const divisor = Number(raw);
      return (value, context, path, key) => {
        const bad = typeof value === "bigint"
          ? value % BigInt(raw) !== 0n
          : typeof value !== "number" || floatSafeRemainder(value, divisor) !== 0;
        return bad
          ? (checkIssue(context, error, { code: "not_multiple_of", origin: typeof value, divisor }, value, path, key), FAIL)
          : value;
      };
    }
    case "number_format": {
      const format = check.v;
      const integer = format === "int32" || format === "uint32" || format === "safeint";
      const [min, max] = NUMBER_FORMAT_RANGES[format as keyof typeof NUMBER_FORMAT_RANGES] ?? NUMBER_FORMAT_RANGES.float64;
      const rangeOrigin = integer ? "int" : "number";
      return (value, context, path, key) => {
        if (typeof value !== "number") return value;
        if (integer && !Number.isInteger(value)) {
          checkIssue(context, error, { expected: "int", format, code: "invalid_type" }, value, path, key);
          return FAIL;
        }
        let failed = false;
        if (value < min) { checkIssue(context, error, { origin: rangeOrigin, code: "too_small", minimum: min, inclusive: true }, value, path, key); failed = true; }
        if (value > max) { checkIssue(context, error, { origin: rangeOrigin, code: "too_big", maximum: max, inclusive: true }, value, path, key); failed = true; }
        return failed ? FAIL : value;
      };
    }
    case "bigint_format": {
      const [min, max] = BIGINT_FORMAT_RANGES[check.v as keyof typeof BIGINT_FORMAT_RANGES];
      return (value, context, path, key) => {
        if (typeof value !== "bigint") return value;
        let failed = false;
        if (value < min) { checkIssue(context, error, { origin: "bigint", code: "too_small", minimum: min, inclusive: true }, value, path, key); failed = true; }
        if (value > max) { checkIssue(context, error, { origin: "bigint", code: "too_big", maximum: max, inclusive: true }, value, path, key); failed = true; }
        return failed ? FAIL : value;
      };
    }
    case "format": {
      const format = check.v;
      const params = check.params;
      if (format === "url" || format === "httpUrl") {
        const httpOnly = format === "httpUrl";
        return (value, context, path, key) => {
          if (typeof value !== "string") return value;
          const verdict = checkUrl(value, params, httpOnly);
          if (verdict.ok) return verdict.value;
          checkIssue(context, error, {
            code: "invalid_format", format: "url",
            ...(verdict.note ? { note: verdict.note } : {}),
            ...(verdict.pattern ? { pattern: verdict.pattern } : {}),
          }, value, path, key);
          return FAIL;
        };
      }
      const formatName = format === "uuidv4" || format === "uuidv6" || format === "uuidv7" ? "uuid" : format;
      const procedural = format === "jwt" || format === "ipv6" || format === "cidrv6" || format === "base64" || format === "base64url";
      // Regex-backed formats precompile their pattern once per schema instead of
      // letting testFormat rebuild it (datetime/time/mac/hash build per call).
      const pattern = procedural ? undefined : patternForFormat(format, params);
      if (procedural || !pattern) {
        return (value, context, path, key) => {
          if (typeof value !== "string") return value;
          if (testFormat(format, value, params)) return value;
          if (procedural) checkIssue(context, error, { code: "invalid_format", format }, value, path, key);
          else checkIssue(context, error, { origin: "string", code: "invalid_format", format: formatName }, value, path, key);
          return FAIL;
        };
      }
      const patternString = pattern.toString();
      return (value, context, path, key) => {
        if (typeof value !== "string") return value;
        return pattern.test(value)
          ? value
          : (checkIssue(context, error, { origin: "string", code: "invalid_format", format: formatName, pattern: patternString }, value, path, key), FAIL);
      };
    }
    case "regex": {
      const expression = new RegExp(check.src, check.flags);
      const stateful = check.flags.includes("g") || check.flags.includes("y");
      const pattern = `/${check.src}/${check.flags}`;
      return (value, context, path, key) => {
        if (typeof value !== "string") return value;
        if (stateful) expression.lastIndex = 0;
        return expression.test(value)
          ? value
          : (checkIssue(context, error, { origin: "string", code: "invalid_format", format: "regex", pattern }, value, path, key), FAIL);
      };
    }
    case "starts_with": {
      const prefix = check.v;
      return (value, context, path, key) =>
        typeof value === "string" && !value.startsWith(prefix)
          ? (checkIssue(context, error, { origin: "string", code: "invalid_format", format: "starts_with", prefix }, value, path, key), FAIL)
          : value;
    }
    case "ends_with": {
      const suffix = check.v;
      return (value, context, path, key) =>
        typeof value === "string" && !value.endsWith(suffix)
          ? (checkIssue(context, error, { origin: "string", code: "invalid_format", format: "ends_with", suffix }, value, path, key), FAIL)
          : value;
    }
    case "includes": {
      const needle = check.v;
      const position = check.position;
      return (value, context, path, key) =>
        typeof value === "string" && !value.includes(needle, position)
          ? (checkIssue(context, error, { origin: "string", code: "invalid_format", format: "includes", includes: needle }, value, path, key), FAIL)
          : value;
    }
    case "lowercase":
      return (value, context, path, key) =>
        typeof value === "string" && value !== value.toLowerCase()
          ? (checkIssue(context, error, { origin: "string", code: "invalid_format", format: "lowercase", pattern: "/^[^A-Z]*$/" }, value, path, key), FAIL)
          : value;
    case "uppercase":
      return (value, context, path, key) =>
        typeof value === "string" && value !== value.toUpperCase()
          ? (checkIssue(context, error, { origin: "string", code: "invalid_format", format: "uppercase", pattern: "/^[^a-z]*$/" }, value, path, key), FAIL)
          : value;
    case "overwrite": {
      const op = check.op;
      const form = check.form;
      return (value) => applyOverwrite(op, value, form);
    }
    case "mime": {
      const allowed = check.v;
      return (value, context, path, key) =>
        isObject(value) && "type" in value && typeof (value as { type?: unknown })["type"] === "string" && !allowed.includes((value as { type: string }).type)
          ? (checkIssue(context, error, { code: "invalid_value", values: allowed }, value, path, key), FAIL)
          : value;
    }
  }
}

type CompiledChecks = {
  (value: unknown, context: Ctx, path: Path, key: PropertyKey | undefined): unknown | FailType;
  /** Single inlineable wire check: fused steps test inline instead of calling. */
  inline?: InlineSingle | undefined;
  /** Error ref for the inline issue payload. */
  inlineError?: unknown;
};

/**
 * Compile a node's check array to one closure. Returns null when the node has
 * no checks. Check sets containing host closures, property checks, `when`
 * gates, or abort semantics delegate to `runtime.applyChecks` verbatim, so
 * abort/continuability behavior stays byte-identical to the interpreter.
 */
function compileChecks(node: SchemaNode): CompiledChecks | null {
  const runtimes: readonly RuntimeCheck[] = node.checks;
  if (runtimes.length === 0) return null;
  for (const rt of runtimes) {
    const c = rt.check.c;
    if (c === "host_runtime" || c === "property" || rt.when || rt.abort === true) {
      return (value, context, path, key) => runtime.applyChecks(node, value, context, snap(path, key));
    }
  }
  const origin = node.kind === "array" ? "array" : node.kind === "set" ? "set" : node.kind === "map" ? "map" : node.kind;
  const leaves = runtimes.map((rt) => compileWireCheck(rt.check as WireCheck, rt.error, node.kind, origin));
  if (leaves.length === 1) {
    const leaf = leaves[0] as Leaf;
    const rt = runtimes[0] as RuntimeCheck;
    const check = rt.check as WireCheck;
    const single: CompiledChecks = (value, context, path, key) => leaf(value, context, path, key);
    if (check.c === "number_format") {
      const format = check.v;
      const integer = format === "int32" || format === "uint32" || format === "safeint";
      const [min, max] = NUMBER_FORMAT_RANGES[format as keyof typeof NUMBER_FORMAT_RANGES] ?? NUMBER_FORMAT_RANGES.float64;
      single.inline = { i: "numfmt", format, integer, min, max, rangeOrigin: integer ? "int" : "number" };
      single.inlineError = rt.error;
    } else if ((check.c === "gt" || check.c === "lt") && typeof check.v === "number" && !check.bigint) {
      single.inline = { i: check.c, target: check.v, inclusive: check.inclusive, origin };
      single.inlineError = rt.error;
    } else if (check.c === "regex" && !check.flags.includes("g") && !check.flags.includes("y")) {
      single.inline = { i: "pattern", re: new RegExp(check.src, check.flags), format: "regex", patternString: `/${check.src}/${check.flags}` };
      single.inlineError = rt.error;
    } else if (check.c === "format") {
      const format = check.v;
      const procedural = format === "jwt" || format === "ipv6" || format === "cidrv6" || format === "base64" || format === "base64url"
        || format === "url" || format === "httpUrl";
      const pattern = procedural ? undefined : patternForFormat(format, check.params);
      if (!procedural && pattern) {
        single.inline = {
          i: "pattern",
          re: pattern,
          format: format === "uuidv4" || format === "uuidv6" || format === "uuidv7" ? "uuid" : format,
          patternString: pattern.toString(),
        };
        single.inlineError = rt.error;
      }
    }
    return single;
  }
  return (value, context, path, key) => {
    let v = value;
    let failed = false;
    for (let index = 0; index < leaves.length; index += 1) {
      const r = (leaves[index] as Leaf)(v, context, path, key);
      if (r === FAIL) failed = true;
      else v = r;
    }
    return failed ? FAIL : v;
  };
}

// ─── Node compilers ────────────────────────────────────────────────────────

function fallback(node: SchemaNode): CNode {
  return (input, context, path, key) => runtime.run(node, input, context, snap(path, key));
}

function compilePrimitive(node: SchemaNode): CNode {
  const kind = node.kind;
  const checks = compileChecks(node);
  const error = node.error;
  const coerce = "coerce" in node && node.coerce === true;
  let fn: CNode;
  switch (kind) {
    case "any":
    case "unknown":
      fn = (input, context, path, key) => (checks ? checks(input, context, path, key) : input);
      break;
    case "never":
      fn = (input, context, path, key) => {
        nodeIssue(context, error, { expected: "never", code: "invalid_type" }, input, path, key);
        return FAIL;
      };
      break;
    case "string":
      fn = (input, context, path, key) => {
        let v = input;
        if (coerce) { try { v = String(v); } catch { v = input; } }
        if (typeof v !== "string") {
          nodeIssue(context, error, { expected: "string", code: "invalid_type" }, v, path, key);
          return FAIL;
        }
        return checks ? checks(v, context, path, key) : v;
      };
      break;
    case "number":
      fn = (input, context, path, key) => {
        let v = input;
        if (coerce) { try { v = Number(v); } catch { v = input; } }
        if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
          const received = typeof v === "number" ? (Number.isNaN(v) ? "NaN" : "Infinity") : undefined;
          nodeIssue(context, error, received
            ? { expected: "number", code: "invalid_type", received }
            : { expected: "number", code: "invalid_type" }, v, path, key);
          return FAIL;
        }
        return checks ? checks(v, context, path, key) : v;
      };
      break;
    case "bigint":
      fn = (input, context, path, key) => {
        let v = input;
        if (coerce) { try { v = BigInt(v as string | number | bigint | boolean); } catch { v = input; } }
        if (typeof v !== "bigint") {
          nodeIssue(context, error, { expected: "bigint", code: "invalid_type" }, v, path, key);
          return FAIL;
        }
        return checks ? checks(v, context, path, key) : v;
      };
      break;
    case "boolean":
      fn = (input, context, path, key) => {
        const v = coerce ? Boolean(input) : input;
        if (typeof v !== "boolean") {
          nodeIssue(context, error, { expected: "boolean", code: "invalid_type" }, v, path, key);
          return FAIL;
        }
        return checks ? checks(v, context, path, key) : v;
      };
      break;
    case "symbol":
      fn = (input, context, path, key) => {
        if (typeof input !== "symbol") {
          nodeIssue(context, error, { expected: "symbol", code: "invalid_type" }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    case "undefined":
    case "void":
      fn = (input, context, path, key) => {
        if (input !== undefined) {
          nodeIssue(context, error, { expected: kind, code: "invalid_type" }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    case "null":
      fn = (input, context, path, key) => {
        if (input !== null) {
          nodeIssue(context, error, { expected: "null", code: "invalid_type" }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    case "nan":
      fn = (input, context, path, key) => {
        if (typeof input !== "number" || !Number.isNaN(input)) {
          nodeIssue(context, error, { expected: "nan", code: "invalid_type" }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    case "date":
      fn = (input, context, path, key) => {
        let v = input;
        if (coerce) { try { v = new Date(v as string | number); } catch { v = input; } }
        if (!(v instanceof Date) || Number.isNaN(v.getTime())) {
          nodeIssue(context, error, v instanceof Date
            ? { expected: "date", code: "invalid_type", received: "Invalid Date" }
            : { expected: "date", code: "invalid_type" }, v, path, key);
          return FAIL;
        }
        const output = new Date(v.getTime());
        return checks ? checks(output, context, path, key) : output;
      };
      break;
    case "file":
      fn = (input, context, path, key) => {
        if (!isObject(input) || !("name" in input) || !("size" in input) || !("type" in input)) {
          nodeIssue(context, error, { expected: "file", code: "invalid_type" }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    case "literal": {
      // zod matches with `Set.has`, i.e. SameValueZero: `-0` satisfies a `0`
      // literal, where `Object.is` would reject it.
      const values = node.values;
      const accepted = new Set<unknown>(values);
      fn = (input, context, path, key) => {
        const ok = accepted.has(input);
        if (!ok) {
          nodeIssue(context, error, { code: "invalid_value", values: [...values] }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    }
    case "enum": {
      const values = node.values;
      const accepted: ReadonlySet<string | number> | undefined = values.length >= 8 ? new Set(values) : undefined;
      fn = (input, context, path, key) => {
        const ok = accepted ? accepted.has(input as string | number) : values.includes(input as string | number);
        if (!ok) {
          nodeIssue(context, error, { code: "invalid_value", values: [...values] }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    }
    case "templateLiteral": {
      const pattern = node.pattern;
      fn = (input, context, path, key) => {
        if (typeof input !== "string" || !pattern.test(input)) {
          nodeIssue(context, error, { code: "invalid_format", format: "template_literal", pattern: pattern.source }, input, path, key);
          return FAIL;
        }
        return checks ? checks(input, context, path, key) : input;
      };
      break;
    }
    default:
      return fallback(node);
  }
  if (!coerce) {
    fn.stepInto = primitiveStepFactory(node, checks, error, REJECT_UNDEF);
    fn.stepIntoUndef = (undef) => primitiveStepFactory(node, checks, error, undef);
    if (!checks && (kind === "string" || kind === "number" || kind === "boolean")) fn.rawLeaf = kind;
  }
  return fn;
}

const REJECT_UNDEF: UndefMode = { m: 0 };
const OPTIONAL_UNDEF: UndefMode = { m: 1 };
const NULLABLE_UNDEF: UndefMode = { m: 2 };

/**
 * Step factories for the hot leaf kinds. Each mirrors the corresponding
 * closure in compilePrimitive exactly, minus one function call per field.
 * `undef` fuses a wrapper's short-circuit (optional/nullable/default) into
 * the same body; `checks.inline` replaces the single-check call with the
 * test itself (issue payloads mirror compileWireCheck exactly).
 */
function primitiveStepFactory(node: SchemaNode, checks: CompiledChecks | null, error: unknown, undef: UndefMode): CNode["stepInto"] {
  const kind = node.kind;
  const inline = checks?.inline;
  const inlineError = checks?.inlineError;
  switch (kind) {
    case "string":
      return (key, optIn, optOut, dangerous) => {
        const swallow = optIn && optOut;
        return (input, result, context, path) => {
          const v = input[key];
          if (v === undefined && settledUndefined(undef, input, result, key, dangerous, swallow)) return false;
          if (undef.m === 2 && v === null) {
            if (dangerous) defineValue(result, key, null); else result[key] = null;
            return false;
          }
          if (typeof v !== "string") {
            nodeIssue(context, error, { expected: "string", code: "invalid_type" }, v, path, key);
            return true;
          }
          if (inline) {
            if (inline.i === "pattern" && !inline.re.test(v)) {
              checkIssue(context, inlineError, { origin: "string", code: "invalid_format", format: inline.format, pattern: inline.patternString }, v, path, key);
              return true;
            }
            if (dangerous) defineValue(result, key, v); else result[key] = v;
            return false;
          }
          if (checks) {
            // `v` is defined here, so the key counts as present: the
            // absent-key suppression `swallow` exists for cannot apply.
            const r = checks(v, context, path, key);
            if (r === FAIL) return true;
            if (r === undefined) {
              if (dangerous) defineValue(result, key, undefined);
              else result[key] = undefined;
            } else if (dangerous) defineValue(result, key, r);
            else result[key] = r;
          } else if (dangerous) {
            defineValue(result, key, v);
          } else {
            result[key] = v;
          }
          return false;
        };
      };
    case "number":
      return (key, optIn, optOut, dangerous) => {
        const swallow = optIn && optOut;
        return (input, result, context, path) => {
          const v = input[key];
          if (v === undefined && settledUndefined(undef, input, result, key, dangerous, swallow)) return false;
          if (undef.m === 2 && v === null) {
            if (dangerous) defineValue(result, key, null); else result[key] = null;
            return false;
          }
          if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
            const received = typeof v === "number" ? (Number.isNaN(v) ? "NaN" : "Infinity") : undefined;
            nodeIssue(context, error, received
              ? { expected: "number", code: "invalid_type", received }
              : { expected: "number", code: "invalid_type" }, v, path, key);
            return true;
          }
          if (inline) {
            if (inline.i === "numfmt") {
              if (inline.integer && !Number.isInteger(v)) {
                checkIssue(context, inlineError, { expected: "int", format: inline.format, code: "invalid_type" }, v, path, key);
                return true;
              }
              if (v < inline.min) {
                checkIssue(context, inlineError, { origin: inline.rangeOrigin, code: "too_small", minimum: inline.min, inclusive: true }, v, path, key);
                return true;
              }
              if (v > inline.max) {
                checkIssue(context, inlineError, { origin: inline.rangeOrigin, code: "too_big", maximum: inline.max, inclusive: true }, v, path, key);
                return true;
              }
            } else if (inline.i === "gt") {
              if (inline.inclusive ? v < inline.target : v <= inline.target) {
                checkIssue(context, inlineError, { origin: inline.origin, code: "too_small", minimum: inline.target, inclusive: inline.inclusive }, v, path, key);
                return true;
              }
            } else if (inline.i === "lt") {
              if (inline.inclusive ? v > inline.target : v >= inline.target) {
                checkIssue(context, inlineError, { origin: inline.origin, code: "too_big", maximum: inline.target, inclusive: inline.inclusive }, v, path, key);
                return true;
              }
            }
            if (dangerous) defineValue(result, key, v); else result[key] = v;
            return false;
          }
          if (checks) {
            // `v` is defined here, so the key counts as present.
            const r = checks(v, context, path, key);
            if (r === FAIL) return true;
            if (r === undefined) {
              if (dangerous) defineValue(result, key, undefined);
              else result[key] = undefined;
            } else if (dangerous) defineValue(result, key, r);
            else result[key] = r;
          } else if (dangerous) {
            defineValue(result, key, v);
          } else {
            result[key] = v;
          }
          return false;
        };
      };
    case "boolean":
      return (key, optIn, optOut, dangerous) => {
        const swallow = optIn && optOut;
        return (input, result, context, path) => {
          const v = input[key];
          if (v === undefined && settledUndefined(undef, input, result, key, dangerous, swallow)) return false;
          if (undef.m === 2 && v === null) {
            if (dangerous) defineValue(result, key, null); else result[key] = null;
            return false;
          }
          if (typeof v !== "boolean") {
            nodeIssue(context, error, { expected: "boolean", code: "invalid_type" }, v, path, key);
            return true;
          }
          if (checks) {
            // `v` is defined here, so the key counts as present.
            const r = checks(v, context, path, key);
            if (r === FAIL) return true;
            if (r === undefined) {
              if (dangerous) defineValue(result, key, undefined);
              else result[key] = undefined;
            } else if (dangerous) defineValue(result, key, r);
            else result[key] = r;
          } else if (dangerous) {
            defineValue(result, key, v);
          } else {
            result[key] = v;
          }
          return false;
        };
      };
    case "literal": {
      const values = node.values;
      // A literal `undefined` needs the absent-vs-present distinction that the
      // generic step draws, so leave those on the slow path.
      if (values.some((value) => value === undefined)) return undefined;
      const single = values.length === 1;
      const only = single ? values[0] : undefined;
      // `===` equals SameValueZero for a string, boolean or null literal, so a
      // single one of those skips the set entirely.
      const strictEq = single && (typeof only === "string" || typeof only === "boolean" || only === null);
      const accepted = strictEq ? null : new Set<unknown>(values);
      return (key, optIn, optOut, dangerous) => {
        const swallow = optIn && optOut;
        return (input, result, context, path) => {
          const v = input[key];
          if (v === undefined && settledUndefined(undef, input, result, key, dangerous, swallow)) return false;
          if (undef.m === 2 && v === null && !values.includes(null)) {
            if (dangerous) defineValue(result, key, null); else result[key] = null;
            return false;
          }
          const matched = accepted === null ? v === only : accepted.has(v);
          if (!matched) {
            nodeIssue(context, error, { code: "invalid_value", values: [...values] }, v, path, key);
            return true;
          }
          if (checks) {
            const r = checks(v, context, path, key);
            if (r === FAIL) return true;
            if (r === undefined) {
              if (dangerous) defineValue(result, key, undefined);
              else result[key] = undefined;
            } else if (dangerous) defineValue(result, key, r);
            else result[key] = r;
          } else if (dangerous) {
            defineValue(result, key, v);
          } else {
            result[key] = v;
          }
          return false;
        };
      };
    }
    case "any":
    case "unknown":
      if (undef.m !== 0) return undefined;
      return (key, optIn, optOut, dangerous) => {
        const swallow = optIn && optOut;
        return (input, result, context, path) => {
          const present = hasOwn(input, key);
          const before = swallow ? (context.issues?.length ?? 0) : 0;
          const v = present ? input[key] : undefined;
          const r = checks ? checks(v, context, path, key) : v;
          if (r === FAIL) {
            if (swallow && !present) {
              if (context.issues) context.issues.length = before;
              return false;
            }
            return true;
          }
          if (!present && !optIn) {
            (context.issues ??= []).push({ code: "invalid_type", expected: "nonoptional", input: undefined, path: [...path, key] } as $ZodRawIssue);
            return true;
          }
          if (r === undefined) {
            if (present) {
              if (dangerous) defineValue(result, key, undefined);
              else result[key] = undefined;
            }
          } else if (dangerous) defineValue(result, key, r);
          else result[key] = r;
          return false;
        };
      };
    case "undefined":
    case "void": {
      if (undef.m !== 0) return undefined;
      const expected = kind;
      return (key, optIn, optOut, dangerous) => {
        const swallow = optIn && optOut;
        return (input, result, context, path) => {
          const present = hasOwn(input, key);
          const before = swallow ? (context.issues?.length ?? 0) : 0;
          const v = present ? input[key] : undefined;
          if (v !== undefined) {
            nodeIssue(context, error, { expected, code: "invalid_type" }, v, path, key);
            return true;
          }
          const r = checks ? checks(v, context, path, key) : v;
          if (r === FAIL) {
            if (swallow && !present) {
              if (context.issues) context.issues.length = before;
              return false;
            }
            return true;
          }
          if (!present && !optIn) {
            (context.issues ??= []).push({ code: "invalid_type", expected: "nonoptional", input: undefined, path: [...path, key] } as $ZodRawIssue);
            return true;
          }
          if (r === undefined) {
            if (present) {
              if (dangerous) defineValue(result, key, undefined);
              else result[key] = undefined;
            }
          } else if (dangerous) defineValue(result, key, r);
          else result[key] = r;
          return false;
        };
      };
    }
    default:
      return undefined;
  }
}

// ─── Objects ───────────────────────────────────────────────────────────────

type ShapeStep = (input: Record<PropertyKey, unknown>, result: Record<string, unknown>, context: Ctx, path: Path) => boolean;

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function makeStep(key: string, child: CNode, optIn: boolean, optOut: boolean, dangerous: boolean): ShapeStep {
  const swallowAbsent = optIn && optOut;
  return (input, result, context, path) => {
    const present = hasOwn(input, key);
    const before = swallowAbsent ? (context.issues?.length ?? 0) : 0;
    const childResult = child(present ? input[key] : undefined, context, path, key);
    if (childResult === FAIL) {
      // For optional-in/out schemas, ignore errors on absent keys.
      if (swallowAbsent && !present) {
        if (context.issues) context.issues.length = before;
        return false;
      }
      return true;
    }
    if (!present && !optIn) {
      (context.issues ??= []).push({ code: "invalid_type", expected: "nonoptional", input: undefined, path: [...path, key] } as $ZodRawIssue);
      return true;
    }
    if (childResult === undefined) {
      if (present) {
        if (dangerous) defineValue(result, key, undefined);
        else result[key] = undefined;
      }
    } else if (dangerous) {
      defineValue(result, key, childResult);
    } else {
      result[key] = childResult;
    }
    return false;
  };
}

/** Unroll small step runs so per-key calls stay direct and monomorphic. */
function composeSteps(steps: ShapeStep[]): ShapeStep {
  switch (steps.length) {
    case 0:
      return () => false;
    case 1: {
      const s0 = steps[0] as ShapeStep;
      return (input, result, context, path) => s0(input, result, context, path);
    }
    case 2: {
      const [s0, s1] = steps as [ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        return a || b;
      };
    }
    case 3: {
      const [s0, s1, s2] = steps as [ShapeStep, ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        const c = s2(input, result, context, path);
        return a || b || c;
      };
    }
    case 4: {
      const [s0, s1, s2, s3] = steps as [ShapeStep, ShapeStep, ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        const c = s2(input, result, context, path);
        const d = s3(input, result, context, path);
        return a || b || c || d;
      };
    }
    case 5: {
      const [s0, s1, s2, s3, s4] = steps as [ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        const c = s2(input, result, context, path);
        const d = s3(input, result, context, path);
        const e = s4(input, result, context, path);
        return a || b || c || d || e;
      };
    }
    case 6: {
      const [s0, s1, s2, s3, s4, s5] = steps as [ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        const c = s2(input, result, context, path);
        const d = s3(input, result, context, path);
        const e = s4(input, result, context, path);
        const f = s5(input, result, context, path);
        return a || b || c || d || e || f;
      };
    }
    case 7: {
      const [s0, s1, s2, s3, s4, s5, s6] = steps as [ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        const c = s2(input, result, context, path);
        const d = s3(input, result, context, path);
        const e = s4(input, result, context, path);
        const f = s5(input, result, context, path);
        const g = s6(input, result, context, path);
        return a || b || c || d || e || f || g;
      };
    }
    case 8: {
      const [s0, s1, s2, s3, s4, s5, s6, s7] = steps as [ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep, ShapeStep];
      return (input, result, context, path) => {
        const a = s0(input, result, context, path);
        const b = s1(input, result, context, path);
        const c = s2(input, result, context, path);
        const d = s3(input, result, context, path);
        const e = s4(input, result, context, path);
        const f = s5(input, result, context, path);
        const g = s6(input, result, context, path);
        const h = s7(input, result, context, path);
        return a || b || c || d || e || f || g || h;
      };
    }
    default:
      return (input, result, context, path) => {
        let failed = false;
        for (let index = 0; index < steps.length; index += 1) {
          failed = (steps[index] as ShapeStep)(input, result, context, path) || failed;
        }
        return failed;
      };
  }
}

function compileObject(node: SchemaNode & { readonly kind: "object" }, compile: (child: SchemaNode) => CNode): CNode {
  const error = node.error;
  const checks = compileChecks(node);
  const entries = Object.entries(node.shape).map(([key, child]) => ({
    key,
    fn: compile(child),
    optIn: optinOf(child) === "optional",
    optOut: optoutOf(child) === "optional",
  }));
  const known: Record<string, true> = Object.create(null) as Record<string, true>;
  for (const { key } of entries) known[key] = true;
  const dangerous = (key: string): boolean => key === "__proto__";
  const runShape = composeSteps(entries.map(({ key, fn, optIn, optOut }) =>
    fn.stepInto?.(key, optIn, optOut, dangerous(key)) ?? makeStep(key, fn, optIn, optOut, dangerous(key))));
  const mode = node.mode;
  const catchall = node.catchall ? compile(node.catchall) : null;

  // The unknown-key policy is fixed when the schema is compiled, so resolve it
  // once here rather than re-testing `catchall` and two mode strings on every
  // parse. `strip` — the default and the common case — needs no pass at all,
  // so it resolves to null and costs a single null check.
  const extras: ShapeStep | null =
    catchall
      ? (input, result, context, path) => {
          let failed = false;
          for (const extraKey of Object.keys(input)) {
            if (known[extraKey] === true || extraKey === "__proto__") continue;
            const childResult = catchall(input[extraKey], context, path, extraKey);
            if (childResult === FAIL) failed = true;
            else defineValue(result, extraKey, childResult);
          }
          return failed;
        }
      : mode === "passthrough"
        ? (input, result) => {
            for (const extraKey of Object.keys(input)) {
              if (known[extraKey] === true || extraKey === "__proto__") continue;
              defineValue(result, extraKey, input[extraKey]);
            }
            return false;
          }
        : mode === "strict"
          ? (input, _result, context, path) => {
              let extra: string[] | null = null;
              for (const extraKey of Object.keys(input)) {
                if (known[extraKey] !== true && extraKey !== "__proto__") (extra ??= []).push(extraKey);
              }
              // unrecognized_keys is recorded but the stripped value stays usable (the
              // top-level parse fails it via the non-continuable continue field).
              if (extra) nodeIssue(context, error, { code: "unrecognized_keys", keys: extra }, input, path, undefined);
              return false;
            }
          : null;

  const fn: CNode = (input, context, path, key) => {
    if (!isObject(input)) {
      nodeIssue(context, error, { expected: "object", code: "invalid_type" }, input, path, key);
      return FAIL;
    }
    if (key !== undefined) path.push(key);
    const result: Record<string, unknown> = {};
    let failed = runShape(input, result, context, path);
    if (extras && extras(input, result, context, path)) failed = true;

    let output: unknown;
    if (failed) {
      if (checks) checks(input, context, path, undefined);
      output = FAIL;
    } else {
      output = checks ? checks(result, context, path, undefined) : result;
    }
    if (key !== undefined) path.pop();
    return output;
  };
  fn.pushesKeyed = true;
  fn.pushes = entries.some((entry) => entry.fn.pushes || entry.fn.pushesKeyed)
    || (catchall ? (catchall.pushes === true || catchall.pushesKeyed === true) : false);
  return fn;
}

function compileArray(node: SchemaNode & { readonly kind: "array" }, compile: (child: SchemaNode) => CNode): CNode {
  const error = node.error;
  const element = compile(node.element);
  const checks = compileChecks(node);
  const raw = element.rawLeaf;
  if (raw !== undefined) {
    // Fused loop: the element test inlines into the iteration; the issue
    // payloads mirror the leaf closures in compilePrimitive exactly.
    const elementError = node.element.error;
    const fn: CNode = (input, context, path, key) => {
      if (!Array.isArray(input)) {
        nodeIssue(context, error, { expected: "array", code: "invalid_type" }, input, path, key);
        return FAIL;
      }
      if (key !== undefined) path.push(key);
      const result: unknown[] = [];
      let failed = false;
      for (let index = 0; index < input.length; index += 1) {
        const v = input[index];
        let ok = true;
        if (raw === "string") {
          if (typeof v !== "string") {
            nodeIssue(context, elementError, { expected: "string", code: "invalid_type" }, v, path, index);
            ok = false;
          }
        } else if (raw === "number") {
          if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
            const received = typeof v === "number" ? (Number.isNaN(v) ? "NaN" : "Infinity") : undefined;
            nodeIssue(context, elementError, received
              ? { expected: "number", code: "invalid_type", received }
              : { expected: "number", code: "invalid_type" }, v, path, index);
            ok = false;
          }
        } else if (typeof v !== "boolean") {
          nodeIssue(context, elementError, { expected: "boolean", code: "invalid_type" }, v, path, index);
          ok = false;
        }
        if (ok) result.push(v);
        else failed = true;
      }
      let output: unknown;
      if (failed) {
        if (checks) checks(input, context, path, undefined);
        output = FAIL;
      } else {
        output = checks ? checks(result, context, path, undefined) : result;
      }
      if (key !== undefined) path.pop();
      return output;
    };
    fn.pushesKeyed = true;
    // Fused elements are check-free primitive leaves: they never touch the stack.
    fn.pushes = false;
    return fn;
  }
  const fn: CNode = (input, context, path, key) => {
    if (!Array.isArray(input)) {
      nodeIssue(context, error, { expected: "array", code: "invalid_type" }, input, path, key);
      return FAIL;
    }
    if (key !== undefined) path.push(key);
    const result: unknown[] = [];
    let failed = false;
    for (let index = 0; index < input.length; index += 1) {
      const childResult = element(input[index], context, path, index);
      if (childResult === FAIL) failed = true;
      else result.push(childResult);
    }
    let output: unknown;
    if (failed) {
      if (checks) checks(input, context, path, undefined);
      output = FAIL;
    } else {
      output = checks ? checks(result, context, path, undefined) : result;
    }
    if (key !== undefined) path.pop();
    return output;
  };
  fn.pushesKeyed = true;
  fn.pushes = element.pushes === true || element.pushesKeyed === true;
  return fn;
}

function compileUnion(node: SchemaNode & { readonly kind: "union" }, compile: (child: SchemaNode) => CNode): CNode {
  if (node.inclusive === false) return fallback(node);
  const error = node.error;
  const checks = compileChecks(node);
  const options = node.options.map(compile);
  const fn: CNode = (input, context, path, key) => {
    if (key !== undefined) path.push(key);
    const relative: Path = [];
    let branches: { readonly value: unknown; readonly issues: $ZodRawIssue[] }[] | null = null;
    let output: unknown;
    let matched = false;
    for (let index = 0; index < options.length; index += 1) {
      const start = context.issues?.length ?? 0;
      const fallbackCount = context.fallback ?? 0;
      const option = options[index] as CNode;
      const parsed = option(input, context, relative, undefined);
      const issues = context.issues ? (context.issues.slice(start) as $ZodRawIssue[]) : [];
      if (context.issues) context.issues.length = start;
      context.fallback = fallbackCount;
      if (parsed !== FAIL && issues.length === 0) {
        const checked = checks ? checks(parsed, context, path, undefined) : parsed;
        output = checked;
        matched = true;
        break;
      }
      (branches ??= []).push({ value: parsed === FAIL ? input : parsed, issues });
    }
    if (!matched) {
      // A single non-aborted branch surfaces its own issues instead of invalid_union.
      let only: { readonly value: unknown; readonly issues: $ZodRawIssue[] } | null = null;
      let nonaborted = 0;
      for (const branch of branches ?? []) {
        if (branch.issues.every((iss) => iss.continue === true)) {
          nonaborted += 1;
          only = branch;
        }
      }
      if (nonaborted === 1 && only) {
        for (const iss of only.issues) {
          (context.issues ??= []).push({ ...iss, path: [...path, ...(iss.path ?? [])] });
        }
      } else {
        nodeIssue(context, error, { code: "invalid_union", errors: (branches ?? []).map((branch) => branch.issues) }, input, path, undefined);
      }
      output = FAIL;
    }
    if (key !== undefined) path.pop();
    return output;
  };
  // Options validate against a per-union relative path, so a keyless union
  // never pushes onto the caller's stack.
  fn.pushesKeyed = true;
  return fn;
}

function compileDiscriminatedUnion(node: SchemaNode & { readonly kind: "discunion" }, compile: (child: SchemaNode) => CNode): CNode {
  if (node.invalidOptionIndex !== undefined) {
    const index = node.invalidOptionIndex;
    return () => {
      throw new Error(`Invalid discriminated union option at index "${index}"`);
    };
  }
  const error = node.error;
  const checks = compileChecks(node);
  const key = node.key;
  const dispatch = new Map<Primitive, CNode>();
  for (const [discriminant, option] of node.map) dispatch.set(discriminant, compile(option));
  const unionFallback = node.unionFallback === true;
  const fn: CNode = (input, context, path, deferredKey) => {
    if (!isObject(input)) {
      nodeIssue(context, error, { code: "invalid_type", expected: "object" }, input, path, deferredKey);
      return FAIL;
    }
    const option = dispatch.get(input[key] as Primitive);
    if (option) {
      if (deferredKey !== undefined) path.push(deferredKey);
      const parsed = option(input, context, path, undefined);
      const output = parsed === FAIL ? FAIL : checks ? checks(parsed, context, path, undefined) : parsed;
      if (deferredKey !== undefined) path.pop();
      return output;
    }
    if (unionFallback || context.direction === "backward") {
      return runtime.run(node, input, context, snap(path, deferredKey));
    }
    nodeIssue(context, error, {
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: key,
      options: [...dispatch.keys()],
    }, input, deferredKey === undefined ? [...path, key] : [...path, deferredKey, key], undefined);
    return FAIL;
  };
  fn.pushesKeyed = true;
  fn.pushes = [...dispatch.values()].some((option) => option.pushes === true);
  return fn;
}

// ─── Wrappers ──────────────────────────────────────────────────────────────

/** Wrappers forward the input (and deferred key) to their inner node, so path-push behavior propagates. */
function propagate<F extends CNode>(fn: F, inners: readonly CNode[]): F {
  fn.pushes = inners.some((inner) => inner.pushes === true);
  fn.pushesKeyed = inners.some((inner) => inner.pushesKeyed === true);
  return fn;
}

function compileWrapper(node: SchemaNode, compile: (child: SchemaNode) => CNode): CNode {
  const error = node.error;
  const checks = compileChecks(node);
  switch (node.kind) {
    case "optional": {
      const inner = compile(node.inner);
      if (optinOf(node.inner) !== "optional") {
        const fn: CNode = propagate((input, context, path, key) => {
          if (input === undefined) return checks ? checks(undefined, context, path, key) : undefined;
          const parsed = inner(input, context, path, key);
          return parsed === FAIL ? FAIL : checks ? checks(parsed, context, path, key) : parsed;
        }, [inner]);
        if (checks === null && inner.stepIntoUndef) fn.stepInto = inner.stepIntoUndef(OPTIONAL_UNDEF);
        return fn;
      }
      return propagate((input, context, path, key) => {
        const before = context.issues?.length ?? 0;
        const fallbackCount = context.fallback ?? 0;
        const parsed = inner(input, context, path, key);
        if (input === undefined && (parsed === FAIL || (context.fallback ?? 0) > fallbackCount)) {
          if (context.issues) context.issues.length = before;
          return checks ? checks(undefined, context, path, key) : undefined;
        }
        return parsed === FAIL ? FAIL : checks ? checks(parsed, context, path, key) : parsed;
      }, [inner]);
    }
    case "exactOptional": {
      const inner = compile(node.inner);
      const fn: CNode = propagate((input, context, path, key) => {
        const parsed = inner(input, context, path, key);
        return parsed === FAIL ? FAIL : checks ? checks(parsed, context, path, key) : parsed;
      }, [inner]);
      if (checks === null && inner.stepInto) fn.stepInto = inner.stepInto;
      return fn;
    }
    case "nullable": {
      const inner = compile(node.inner);
      const fn: CNode = propagate((input, context, path, key) => {
        if (input === null) return null;
        const parsed = inner(input, context, path, key);
        return parsed === FAIL ? FAIL : checks ? checks(parsed, context, path, key) : parsed;
      }, [inner]);
      if (checks === null && inner.stepIntoUndef) fn.stepInto = inner.stepIntoUndef(NULLABLE_UNDEF);
      return fn;
    }
    case "nonoptional": {
      const inner = compile(node.inner);
      return propagate((input, context, path, key) => {
        const parsed = inner(input, context, path, key);
        if (parsed === FAIL) return FAIL;
        if (parsed === undefined) {
          nodeIssue(context, error, { code: "invalid_type", expected: "nonoptional" }, input, path, key);
          return FAIL;
        }
        return checks ? checks(parsed, context, path, key) : parsed;
      }, [inner]);
    }
    case "readonly": {
      const inner = compile(node.inner);
      return propagate((input, context, path, key) => {
        const parsed = inner(input, context, path, key);
        if (parsed === FAIL) return FAIL;
        if (typeof parsed === "object" && parsed !== null) Object.freeze(parsed);
        return parsed;
      }, [inner]);
    }
    case "lazy":
      return compile(node.getter());
    case "default": {
      const inner = compile(node.inner);
      const dynamic = node.dynamic;
      const value = node.value;
      const fallbackValue = dynamic
        ? (input: unknown) => (value as (context?: { input: unknown }) => unknown)({ input })
        : () => shallowClone(value);
      const fn: CNode = propagate((input, context, path, key) => {
        if (input === undefined) {
          const defaulted = fallbackValue(input);
          return checks ? checks(defaulted, context, path, key) : defaulted;
        }
        const parsed = inner(input, context, path, key);
        if (parsed === FAIL) return FAIL;
        const output = parsed === undefined ? fallbackValue(input) : parsed;
        return checks ? checks(output, context, path, key) : output;
      }, [inner]);
      if (checks === null && !dynamic && inner.stepIntoUndef
        && (value === null || (typeof value !== "object" && typeof value !== "function"))) {
        fn.stepInto = inner.stepIntoUndef({ m: 3, dv: value });
      }
      return fn;
    }
    case "prefault": {
      const inner = compile(node.inner);
      const dynamic = node.dynamic;
      const value = node.value;
      return propagate((input, context, path, key) => {
        const resolved = input === undefined
          ? dynamic
            ? (value as (context?: { input: unknown }) => unknown)({ input })
            : shallowClone(value)
          : input;
        const parsed = inner(resolved, context, path, key);
        return parsed === FAIL ? FAIL : checks ? checks(parsed, context, path, key) : parsed;
      }, [inner]);
    }
    case "catch": {
      const inner = compile(node.inner);
      const dynamic = node.dynamic;
      const value = node.value;
      return propagate((input, context, path, key) => {
        const start = context.issues?.length ?? 0;
        const fallbackCount = context.fallback ?? 0;
        const parsed = inner(input, context, path, key);
        const newIssues = context.issues ? context.issues.slice(start) : [];
        if (parsed !== FAIL && newIssues.length === 0) {
          context.fallback = fallbackCount;
          return checks ? checks(parsed, context, path, key) : parsed;
        }
        if (context.issues) context.issues.length = start;
        context.fallback = fallbackCount + 1;
        const caught = dynamic
          ? (value as (context?: { error?: unknown; input: unknown }) => unknown)({ error: { issues: newIssues }, input })
          : value;
        return checks ? checks(caught, context, path, key) : caught;
      }, [inner]);
    }
    case "pipe": {
      const a = compile(node.a);
      const b = compile(node.b);
      return propagate((input, context, path, key) => {
        const first = a(input, context, path, key);
        if (first === FAIL) return FAIL;
        const second = b(first, context, path, key);
        return second === FAIL ? FAIL : checks ? checks(second, context, path, key) : second;
      }, [a, b]);
    }
    default:
      return fallback(node);
  }
}

// ─── The compile walk ──────────────────────────────────────────────────────

function compileNode(
  node: SchemaNode,
  cache: Map<SchemaNode, CNode>,
  placeholders: Map<SchemaNode, CNode>,
  active: Set<SchemaNode>,
): CNode {
  const existing = cache.get(node);
  if (existing) return existing;
  if (active.has(node)) {
    // Cycle (z.lazy back-edge): hand out a placeholder that resolves to the
    // finished implementation once the outer compile walk completes.
    let placeholder = placeholders.get(node);
    if (!placeholder) {
      placeholder = (input, context, path, key) => {
        const impl = cache.get(node);
        if (!impl) throw new Error("Schema compiler cycle was invoked before initialization");
        return impl(input, context, path, key);
      };
      placeholder.pushes = true;
      placeholder.pushesKeyed = true;
      placeholders.set(node, placeholder);
    }
    return placeholder;
  }
  active.add(node);
  const compile = (child: SchemaNode): CNode => compileNode(child, cache, placeholders, active);
  let implementation: CNode;
  switch (node.kind) {
    case "object":
      implementation = compileObject(node, compile);
      break;
    case "array":
      implementation = compileArray(node, compile);
      break;
    case "union":
      implementation = compileUnion(node, compile);
      break;
    case "discunion":
      implementation = compileDiscriminatedUnion(node, compile);
      break;
    case "optional":
    case "exactOptional":
    case "nullable":
    case "nonoptional":
    case "readonly":
    case "lazy":
    case "default":
    case "prefault":
    case "catch":
    case "pipe":
      implementation = compileWrapper(node, compile);
      break;
    default:
      implementation = compilePrimitive(node);
      break;
  }
  active.delete(node);
  cache.set(node, implementation);
  return implementation;
}

export function createCodegenValidator(root: SchemaNode): Validator {
  const compiled = compileNode(root, new Map(), new Map(), new Set());
  const freshPath = compiled.pushes === true;
  return (input, context) => {
    // Backward (encode) parses stay on the shared runtime: they are cold, and
    // their canary/reversal semantics are subtle enough to keep single-sourced.
    if (context.direction === "backward") return runtime.run(root, input, context, []);
    if (freshPath) return compiled(input, context, []);
    const output = compiled(input, context, EMPTY_PATH);
    if (EMPTY_PATH.length !== 0) {
      EMPTY_PATH.length = 0;
      throw new Error("zodrs codegen: a node mutated the shared path stack; `pushes` propagation is wrong");
    }
    return output;
  };
}

/** Closure generation is always available, including CSP-strict runtimes. */
export const CODEGEN_AVAILABLE: true = true;
