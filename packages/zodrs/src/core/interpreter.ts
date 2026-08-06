import type { $ZodRawIssue, ParseContext } from "./errors.js";
import { testFormat } from "./formats.js";
import type { HostRuntimeCheck, RuntimeCheck, SchemaNode } from "./nodes.js";
import { BIGINT_FORMAT_RANGES, FAIL, isObject, NUMBER_FORMAT_RANGES, parsedType, shallowClone } from "./util.js";
import type { FAIL as FailType, MaybeAsync } from "./util.js";

export interface ValidationContext extends ParseContext {
  issues: $ZodRawIssue[] | null;
  readonly async?: boolean;
  readonly direction?: "forward" | "backward";
}

export type Validator = (input: unknown, context: ValidationContext) => unknown | FailType;

/** Mirrors `_zod.values`: the finite key set for enum/literal/union-of-those, else undefined. */
function keyValues(node: SchemaNode): (string | number)[] | undefined {
  switch (node.kind) {
    case "enum": return [...node.values];
    case "literal": {
      const out: (string | number)[] = [];
      for (const value of node.values) { if (typeof value === "string" || typeof value === "number") out.push(value); else return undefined; }
      return out;
    }
    case "union": {
      const out: (string | number)[] = [];
      for (const option of node.options) { const inner = keyValues(option); if (!inner) return undefined; out.push(...inner); }
      return out;
    }
    case "pipe": return keyValues(node.a); // input-side values (e.g. literal().transform())
    case "optional": case "nullable": case "readonly": case "nonoptional": case "default": case "prefault": case "catch": case "exactOptional": return keyValues(node.inner);
    case "lazy": return keyValues(node.getter());
    default: return undefined;
  }
}

/**
 * Mirrors Zod's `_zod.optin === "optional"` — a slot whose INPUT may be absent.
 * Set by `optional`, `default`, `prefault`, `catch`, `transform`; propagates through
 * single-inner wrappers (nullable/readonly/nonoptional/pipe.b) and unions.
 */
function isOptinOptional(node: SchemaNode | null | undefined): boolean {
  if (!node) return false;
  switch (node.kind) {
    case "optional": case "exactOptional": case "default": case "prefault": case "catch": return true;
    case "host": return node.inner ? isOptinOptional(node.inner) : true; // transform-like
    case "nullable": case "readonly": case "nonoptional": return isOptinOptional(node.inner);
    case "union": return node.options.some((option) => isOptinOptional(option));
    case "lazy": return isOptinOptional(node.getter());
    case "pipe": return isOptinOptional(node.a); // input-may-be-absent flows from the input side
    default: return false;
  }
}

/**
 * Mirrors `_zod.optout === "optional"` — a slot whose OUTPUT may be absent, so a tuple
 * may trim it. Set ONLY by `optional`; propagates through single-inner wrappers and unions.
 * `default`/`prefault`/`undefined`/`exactOptional` do NOT set it (their output is defined).
 */
function isOptoutOptional(node: SchemaNode | null | undefined): boolean {
  if (!node) return false;
  switch (node.kind) {
    case "optional": case "exactOptional": return true;
    case "nullable": case "readonly": case "nonoptional": case "default": case "prefault": case "catch": return isOptoutOptional(node.inner);
    case "host": return isOptoutOptional(node.inner);
    case "union": return node.options.some((option) => isOptoutOptional(option));
    case "lazy": return isOptoutOptional(node.getter());
    case "pipe": return isOptoutOptional(node.b);
    default: return false;
  }
}
export type AsyncValidator = (input: unknown, context: ValidationContext) => Promise<unknown | FailType>;

export class $ZodAsyncError extends Error {
  constructor() {
    super("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
    this.name = "$ZodAsyncError";
  }
}

function addIssue(context: ValidationContext, issue: $ZodRawIssue): void {
  (context.issues ??= []).push(issue);
}

function issue(
  context: ValidationContext,
  node: SchemaNode,
  path: PropertyKey[],
  details: Readonly<Record<string, unknown>>,
  input: unknown,
): void {
  const raw: Record<string, unknown> = { ...details, input, path, inst: { error: node.error } };
  addIssue(context, raw as $ZodRawIssue);
}

function isPromise(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && "then" in value && typeof value["then"] === "function";
}

function makeRefinementContext(context: ValidationContext, node: SchemaNode, path: PropertyKey[], value: unknown) {
  return {
    value,
    get issues(): $ZodRawIssue[] {
      // Live array: a check that does `ctx.issues.push(...)` must persist into the
      // parse context, so initialize (not a throwaway copy) on first access.
      return (context.issues ??= []);
    },
    addIssue(raw: $ZodRawIssue | string): void {
      if (typeof raw === "string") {
        issue(context, node, path, { code: "custom", message: raw }, value);
      } else {
        const merged: Record<string, unknown> = { ...raw, input: raw.input ?? value, path: [...path, ...(raw.path ?? [])], inst: raw.inst ?? { error: node.error } };
        addIssue(context, merged as $ZodRawIssue);
      }
    },
  };
}

function numeric(checkValue: number | string, bigint: boolean): number | bigint {
  return bigint ? BigInt(checkValue) : Number(checkValue);
}

function applyOverwrite(op: "trim" | "toLowerCase" | "toUpperCase" | "normalize" | "slugify", value: unknown, form?: string): unknown {
  if (typeof value !== "string") return value;
  switch (op) {
    case "trim": return value.trim();
    case "toLowerCase": return value.toLowerCase();
    case "toUpperCase": return value.toUpperCase();
    case "normalize": return value.normalize(form);
    case "slugify":
      return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
}

function applyChecksSync(node: SchemaNode, initial: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  let value = initial;
  let failed = false;
  for (const runtime of node.checks) {
    const check = runtime.check;
    const before = context.issues?.length ?? 0;
    if (check.c === "host_runtime") {
      const refinement = makeRefinementContext(context, node, path, value);
      const result = check.fn(value, refinement);
      if (isPromise(result)) throw new $ZodAsyncError();
      if (check.op === "refine" && !result) {
        const error = runtime.error ?? node.error;
        const issuePath = runtime.path ? [...path, ...runtime.path] : path;
        addIssue(context, { code: "custom", input: value, inst: { error }, path: issuePath, continue: runtime.abort !== true, ...(runtime.params ? { params: runtime.params } : {}) } as $ZodRawIssue);
      } else if (check.op === "overwrite" || check.op === "transform" || check.op === "preprocess") value = result;
    } else if (check.c === "property") {
      if (isObject(value)) {
        const result = runSync(check.schema, value[check.key], context, [...path, check.key]);
        if (result === FAIL) failed = true;
      }
    } else {
      const origin = node.kind === "array" ? "array" : node.kind === "set" ? "set" : node.kind === "map" ? "map" : node.kind;
      switch (check.c) {
        case "min_length":
        case "min_size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : 0;
          if (size < check.v) issue(context, node, path, { origin, code: "too_small", minimum: check.v, inclusive: true }, value);
          break;
        }
        case "max_length":
        case "max_size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : 0;
          if (size > check.v) issue(context, node, path, { origin, code: "too_big", maximum: check.v, inclusive: true }, value);
          break;
        }
        case "length":
        case "size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : 0;
          if (size !== check.v) {
            const small = size < check.v;
            issue(context, node, path, small
              ? { origin, code: "too_small", minimum: check.v, inclusive: true, exact: true }
              : { origin, code: "too_big", maximum: check.v, inclusive: true, exact: true }, value);
          }
          break;
        }
        case "gt":
        case "lt": {
          const target = numeric(check.v, check.bigint === true);
          const actual: unknown = value instanceof Date ? value.getTime() : value;
          if (typeof actual !== "number" && typeof actual !== "bigint") break;
          const okay = check.c === "gt"
            ? (check.inclusive ? actual >= target : actual > target)
            : (check.inclusive ? actual <= target : actual < target);
          if (!okay) {
            issue(context, node, path, check.c === "gt"
              ? { origin, code: "too_small", minimum: target, inclusive: check.inclusive }
              : { origin, code: "too_big", maximum: target, inclusive: check.inclusive }, value);
          }
          break;
        }
        case "multiple_of": {
          const divisor = Number(check.v);
          if (typeof value === "bigint" ? value % BigInt(check.v) !== 0n : typeof value !== "number" || Math.abs(value / divisor - Math.round(value / divisor)) > Number.EPSILON) {
            issue(context, node, path, { code: "not_multiple_of", divisor }, value);
          }
          break;
        }
        case "number_format": {
          if (typeof value !== "number") break;
          const integer = check.v === "int32" || check.v === "uint32" || check.v === "safeint";
          if (integer && !Number.isInteger(value)) {
            issue(context, node, path, { expected: "int", format: check.v, code: "invalid_type" }, value);
            break;
          }
          const bounds = NUMBER_FORMAT_RANGES[check.v as keyof typeof NUMBER_FORMAT_RANGES] ?? NUMBER_FORMAT_RANGES.float64;
          const [min, max] = bounds;
          if (value < min) issue(context, node, path, { origin: integer ? "int" : "number", code: "too_small", minimum: min, inclusive: true }, value);
          if (value > max) issue(context, node, path, { origin: integer ? "int" : "number", code: "too_big", maximum: max, inclusive: true }, value);
          break;
        }
        case "bigint_format": {
          if (typeof value !== "bigint") break;
          const [min, max] = BIGINT_FORMAT_RANGES[check.v as keyof typeof BIGINT_FORMAT_RANGES];
          if (value < min) issue(context, node, path, { origin: "bigint", code: "too_small", minimum: min, inclusive: true }, value);
          if (value > max) issue(context, node, path, { origin: "bigint", code: "too_big", maximum: max, inclusive: true }, value);
          break;
        }
        case "format":
          if (typeof value === "string" && !testFormat(check.v, value, check.params)) issue(context, node, path, { code: "invalid_format", format: check.v, ...(check.params ?? {}) }, value);
          break;
        case "regex":
          if (typeof value === "string" && !new RegExp(check.src, check.flags).test(value)) issue(context, node, path, { code: "invalid_format", format: "regex", pattern: `/${check.src}/${check.flags}` }, value);
          break;
        case "starts_with":
          if (typeof value === "string" && !value.startsWith(check.v)) issue(context, node, path, { code: "invalid_format", format: "starts_with", prefix: check.v }, value);
          break;
        case "ends_with":
          if (typeof value === "string" && !value.endsWith(check.v)) issue(context, node, path, { code: "invalid_format", format: "ends_with", suffix: check.v }, value);
          break;
        case "includes":
          if (typeof value === "string" && !value.includes(check.v, check.position)) issue(context, node, path, { code: "invalid_format", format: "includes", includes: check.v }, value);
          break;
        case "lowercase":
          if (typeof value === "string" && value !== value.toLowerCase()) issue(context, node, path, { code: "invalid_format", format: "lowercase" }, value);
          break;
        case "uppercase":
          if (typeof value === "string" && value !== value.toUpperCase()) issue(context, node, path, { code: "invalid_format", format: "uppercase" }, value);
          break;
        case "overwrite":
          value = applyOverwrite(check.op, value, check.form);
          break;
        case "mime": {
          if (isObject(value) && "type" in value && typeof value["type"] === "string" && !check.v.includes(value["type"])) issue(context, node, path, { code: "invalid_value", values: check.v }, value);
          break;
        }
      }
    }
    const added = (context.issues?.length ?? 0) - before;
    if (added > 0) {
      failed = true;
      // A check-emitted issue carries the CHECK's error (e.g. `.min(3, "msg")`),
      // never the schema node's type error. Overwrite inst.error with the check
      // error (possibly undefined, so the global chain applies) for built-in checks.
      if (check.c !== "host_runtime" && context.issues) {
        for (let i = before; i < context.issues.length; i += 1) {
          context.issues[i] = { ...context.issues[i], inst: { error: runtime.error } } as $ZodRawIssue;
        }
      }
      if (runtime.abort) break;
    }
  }
  return failed ? FAIL : value;
}

function coercePrimitive(node: SchemaNode, input: unknown): unknown {
  if (!("coerce" in node) || !node.coerce) return input;
  try {
    switch (node.kind) {
      case "string": return String(input);
      case "number": return Number(input);
      case "bigint": return BigInt(input as string | number | bigint | boolean);
      case "boolean": return Boolean(input);
      case "date": return new Date(input as string | number);
      default: return input;
    }
  } catch {
    return input;
  }
}

function runSync(node: SchemaNode, original: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  const input = coercePrimitive(node, original);
  let output: unknown;
  switch (node.kind) {
    case "any": case "unknown": output = input; break;
    case "never": issue(context, node, path, { expected: "never", code: "invalid_type" }, input); return FAIL;
    case "string": if (typeof input !== "string") { issue(context, node, path, { expected: "string", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "number": if (typeof input !== "number" || Number.isNaN(input)) { issue(context, node, path, { expected: "number", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "bigint": if (typeof input !== "bigint") { issue(context, node, path, { expected: "bigint", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "boolean": if (typeof input !== "boolean") { issue(context, node, path, { expected: "boolean", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "symbol": if (typeof input !== "symbol") { issue(context, node, path, { expected: "symbol", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "function": if (typeof input !== "function") { issue(context, node, path, { code: "invalid_type", expected: "function" }, input); return FAIL; } output = input; break;
    case "undefined": case "void": if (input !== undefined) { issue(context, node, path, { expected: node.kind, code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "null": if (input !== null) { issue(context, node, path, { expected: "null", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "nan": if (typeof input !== "number" || !Number.isNaN(input)) { issue(context, node, path, { expected: "nan", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "date": if (!(input instanceof Date) || Number.isNaN(input.getTime())) { issue(context, node, path, { expected: "date", code: "invalid_type" }, input); return FAIL; } output = new Date(input.getTime()); break;
    case "file": if (!isObject(input) || !("name" in input) || !("size" in input) || !("type" in input)) { issue(context, node, path, { expected: "file", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "literal": if (!node.values.some((value) => Object.is(value, input))) { issue(context, node, path, { code: "invalid_value", values: [...node.values] }, input); return FAIL; } output = input; break;
    case "enum": if (!node.values.includes(input as string | number)) { issue(context, node, path, { code: "invalid_value", values: [...node.values] }, input); return FAIL; } output = input; break;
    case "object": {
      if (!isObject(input)) { issue(context, node, path, { expected: "object", code: "invalid_type" }, input); return FAIL; }
      const result: Record<string, unknown> = {};
      let failed = false;
      const known: Record<string, true> = {};
      for (const [key, child] of Object.entries(node.shape)) {
        known[key] = true;
        const present = Object.prototype.hasOwnProperty.call(input, key);
        const childResult = runSync(child, present ? input[key] : undefined, context, [...path, key]);
        if (childResult === FAIL) failed = true;
        else if (present || childResult !== undefined) Object.defineProperty(result, key, { value: childResult, enumerable: true, writable: true, configurable: true });
      }
      const extra = Object.keys(input).filter((key) => !known[key]);
      if (node.catchall) {
        for (const key of extra) {
          const childResult = runSync(node.catchall, input[key], context, [...path, key]);
          if (childResult === FAIL) failed = true; else result[key] = childResult;
        }
      } else if (node.mode === "passthrough") {
        for (const key of extra) result[key] = input[key];
      } else if (node.mode === "strict" && extra.length > 0) {
        issue(context, node, path, { code: "unrecognized_keys", keys: extra }, input);
        failed = true;
      }
      if (failed) { if (node.checks.length > 0) applyChecksSync(node, input, context, path); return FAIL; }
      output = result;
      break;
    }
    case "array": {
      if (!Array.isArray(input)) { issue(context, node, path, { expected: "array", code: "invalid_type" }, input); return FAIL; }
      const result: unknown[] = [];
      let failed = false;
      for (let index = 0; index < input.length; index += 1) {
        const childResult = runSync(node.element, input[index], context, [...path, index]);
        if (childResult === FAIL) failed = true; else result.push(childResult);
      }
      if (failed) { if (node.checks.length > 0) applyChecksSync(node, input, context, path); return FAIL; }
      output = result;
      break;
    }
    case "tuple": {
      if (!Array.isArray(input)) { issue(context, node, path, { expected: "tuple", code: "invalid_type" }, input); return FAIL; }
      // First index of a trailing run of optin/optout-optional items. Below these
      // indices the input/output tail is required, so short input collapses to one
      // too_small rather than element-level errors.
      let optinStart = node.items.length;
      let optoutStart = node.items.length;
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const item = node.items[index];
        if (item && isOptinOptional(item)) optinStart = index; else break;
      }
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const item = node.items[index];
        if (item && isOptoutOptional(item)) optoutStart = index; else break;
      }
      if (!node.rest && input.length < optinStart) { issue(context, node, path, { code: "too_small", minimum: optinStart, inclusive: true, origin: "array" }, input); return FAIL; }
      const oversized = !node.rest && input.length > node.items.length;
      if (oversized) { issue(context, node, path, { code: "too_big", maximum: node.items.length, inclusive: true, origin: "array" }, input); }
      const result: unknown[] = [];
      let failed = oversized;
      for (let index = 0; index < node.items.length; index += 1) {
        const child = node.items[index];
        if (!child) continue;
        const childResult = runSync(child, input[index], context, [...path, index]);
        if (childResult === FAIL) {
          // Swallow only when BOTH input & output may be absent at this tail position.
          if (index >= input.length && index >= optinStart && index >= optoutStart) { result.length = index; break; }
          failed = true;
        } else {
          result[index] = childResult;
        }
      }
      if (!failed && node.rest) {
        for (let index = node.items.length; index < input.length; index += 1) {
          const childResult = runSync(node.rest, input[index], context, [...path, index]);
          if (childResult === FAIL) failed = true; else result[index] = childResult;
        }
      }
      // Trim trailing slots that resolved undefined for absent input on optout-optional items.
      for (let index = result.length - 1; index >= input.length; index -= 1) {
        if (result[index] === undefined && isOptoutOptional(node.items[index])) result.length = index; else break;
      }
      if (failed) { if (node.checks.length > 0) applyChecksSync(node, input, context, path); return FAIL; }
      output = result;
      break;
    }
    case "union": {
      const branchErrors: $ZodRawIssue[][] = [];
      for (const option of node.options) {
        const branchContext: ValidationContext = { ...context, issues: null };
        const result = runSync(option, input, branchContext, path);
        if (result !== FAIL) { output = result; return applyChecksSync(node, output, context, path); }
        branchErrors.push(branchContext.issues ?? []);
      }
      issue(context, node, path, { code: "invalid_union", errors: branchErrors }, input);
      return FAIL;
    }
    case "discunion": {
      if (!isObject(input)) { issue(context, node, path, { code: "invalid_type", expected: "object" }, input); return FAIL; }
      const option = node.map.get(input[node.key] as string | number | boolean | null);
      if (!option) { issue(context, node, [...path, node.key], { code: "invalid_union", errors: [], discriminator: node.key, options: [...node.map.keys()] }, input); return FAIL; }
      output = runSync(option, input, context, path);
      if (output === FAIL) return FAIL;
      break;
    }
    case "intersection": {
      const left = runSync(node.left, input, context, path);
      const right = runSync(node.right, input, context, path);
      if (left === FAIL || right === FAIL) return FAIL;
      if (isObject(left) && isObject(right)) output = { ...left, ...right };
      else if (Object.is(left, right)) output = left;
      else throw new Error("Unmergable intersection");
      break;
    }
    case "record": {
      if (!isObject(input)) { issue(context, node, path, { expected: "record", code: "invalid_type" }, input); return FAIL; }
      const result: Record<PropertyKey, unknown> = {};
      let failed = false;
      const enumerated = node.partial ? undefined : keyValues(node.key);
      if (enumerated) {
        // Exhaustive key set: validate each expected input key (absent → invalid_type at [key]),
        // apply the key schema to derive the output key, then report leftover keys as unrecognized.
        const expected = new Set<string>(enumerated.map((value) => String(value)));
        for (const key of enumerated) {
          const stringKey = String(key);
          const keyContext: ValidationContext = { ...context, issues: null };
          const parsedKey = runSync(node.key, key, keyContext, []);
          if (parsedKey === FAIL) {
            issue(context, node, [...path, stringKey], { code: "invalid_key", origin: "record", issues: keyContext.issues ?? [] }, key);
            failed = true;
            continue;
          }
          const outKey = String(parsedKey);
          const parsed = runSync(node.value, (input as Record<PropertyKey, unknown>)[stringKey], context, [...path, key]);
          if (parsed === FAIL) failed = true; else result[outKey] = parsed;
        }
        const extra = Object.keys(input).filter((key) => !expected.has(key));
        if (extra.length > 0) { issue(context, node, path, { code: "unrecognized_keys", keys: extra }, input); failed = true; }
        if (failed) return FAIL;
        output = result;
        break;
      }
      // Reflect.ownKeys for Symbol keys; skip non-enumerable to match z.object(); __proto__ is data.
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__") continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
        const value = (input as Record<PropertyKey, unknown>)[key];
        const keyContext: ValidationContext = { ...context, issues: null };
        let parsedKey = runSync(node.key, key, keyContext, [...path, key]);
        // Numeric-string fallback: a numeric key that failed as a string may pass as a number.
        if (parsedKey === FAIL && typeof key === "string" && key !== "" && !Number.isNaN(Number(key))) {
          const retry: ValidationContext = { ...context, issues: null };
          const numeric = runSync(node.key, Number(key), retry, [...path, key]);
          if (numeric !== FAIL) { parsedKey = numeric; keyContext.issues = retry.issues; }
        }
        if (parsedKey === FAIL) {
          if (node.mode === "loose") { result[key] = value; continue; } // pass non-matching keys through unchanged
          issue(context, node, [...path, key], { code: "invalid_key", origin: "record", issues: keyContext.issues ?? [] }, key);
          failed = true;
          continue;
        }
        const parsed = runSync(node.value, value, context, [...path, key]);
        if (parsed === FAIL) failed = true; else result[parsedKey as PropertyKey] = parsed;
      }
      if (failed) return FAIL;
      output = result;
      break;
    }
    case "map": {
      if (!(input instanceof Map)) { issue(context, node, path, { expected: "map", code: "invalid_type" }, input); return FAIL; }
      const result = new Map<unknown, unknown>();
      let failed = false;
      for (const [key, value] of input) {
        const keyContext: ValidationContext = { ...context, issues: null };
        const valueContext: ValidationContext = { ...context, issues: null };
        const parsedKey = runSync(node.key, key, keyContext, []);
        const parsedValue = runSync(node.value, value, valueContext, []);
        const propertyKey = typeof key === "string" || typeof key === "number" || typeof key === "symbol";
        if (keyContext.issues?.length) {
          failed = true;
          if (propertyKey) for (const nested of keyContext.issues) addIssue(context, { ...nested, path: [key, ...(nested.path ?? [])] });
          else addIssue(context, { code: "invalid_key", origin: "map", input, issues: keyContext.issues, path, inst: { error: node.error } } as $ZodRawIssue);
        }
        if (valueContext.issues?.length) {
          failed = true;
          if (propertyKey) for (const nested of valueContext.issues) addIssue(context, { ...nested, path: [key, ...(nested.path ?? [])] });
          else addIssue(context, { origin: "map", code: "invalid_element", input, key, issues: valueContext.issues, path, inst: { error: node.error } } as $ZodRawIssue);
        }
        if (parsedKey !== FAIL && parsedValue !== FAIL) result.set(parsedKey, parsedValue);
      }
      if (failed) return FAIL;
      output = result;
      break;
    }
    case "set": {
      if (!(input instanceof Set)) { issue(context, node, path, { expected: "set", code: "invalid_type" }, input); return FAIL; }
      const result = new Set<unknown>(); let failed = false;
      for (const value of input) {
        const valueContext: ValidationContext = { ...context, issues: null };
        const parsed = runSync(node.value, value, valueContext, []);
        if (valueContext.issues?.length) { failed = true; for (const nested of valueContext.issues) addIssue(context, nested); }
        if (parsed !== FAIL) result.add(parsed);
      }
      if (failed) return FAIL; output = result; break;
    }
    case "optional": if (input === undefined) return applyChecksSync(node, undefined, context, path); { const parsedOpt = runSync(node.inner, input, context, path); return parsedOpt === FAIL ? FAIL : applyChecksSync(node, parsedOpt, context, path); }
    case "exactOptional": { const parsedExact = runSync(node.inner, input, context, path); return parsedExact === FAIL ? FAIL : applyChecksSync(node, parsedExact, context, path); }
    case "nullable": if (input === null) return null; { const parsedNul = runSync(node.inner, input, context, path); return parsedNul === FAIL ? FAIL : applyChecksSync(node, parsedNul, context, path); }
    case "nonoptional": if (input === undefined) { issue(context, node, path, { code: "invalid_type", expected: "nonoptional" }, input); return FAIL; } else { const parsedNon = runSync(node.inner, input, context, path); return parsedNon === FAIL ? FAIL : applyChecksSync(node, parsedNon, context, path); }
    case "readonly": { const parsed = runSync(node.inner, input, context, path); if (parsed === FAIL) return FAIL; if (typeof parsed === "object" && parsed !== null) Object.freeze(parsed); return parsed; }
    case "lazy": return runSync(node.getter(), input, context, path);
    case "promise": if (!isPromise(input)) { issue(context, node, path, { expected: "promise", code: "invalid_type" }, input); return FAIL; } return Promise.resolve(input).then((value) => runAsync(node.inner, value, { ...context, async: true }, path));
    case "default": {
      if (input === undefined) return node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : shallowClone(node.value);
      const result = runSync(node.inner, input, context, path);
      if (result === FAIL) return FAIL;
      return result === undefined ? (node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : shallowClone(node.value)) : result;
    }
    case "prefault": { const value = input === undefined ? node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : shallowClone(node.value) : input; return runSync(node.inner, value, context, path); }
    case "catch": { const local: ValidationContext = { ...context, issues: null }; const parsed = runSync(node.inner, input, local, path); return parsed === FAIL ? node.dynamic ? (node.value as (context?: { error?: unknown; input: unknown }) => unknown)({ error: { issues: local.issues ?? [] }, input }) : node.value : parsed; }
    case "pipe": { const first = runSync(node.a, input, context, path); if (first === FAIL) return FAIL; const second = runSync(node.b, first, context, path); return second === FAIL ? FAIL : (node.checks.length === 0 ? second : applyChecksSync(node, second, context, path)); }
    case "templateLiteral": if (typeof input !== "string" || !node.pattern.test(input)) { issue(context, node, path, { code: "invalid_format", format: "template_literal", pattern: node.pattern.source }, input); return FAIL; } output = input; break;
    case "host": {
      const base = node.inner ? runSync(node.inner, input, context, path) : input;
      if (base === FAIL) return FAIL;
      const before = context.issues?.length ?? 0;
      const refinement = makeRefinementContext(context, node, path, base);
      const result = node.fn(base, refinement);
      if (isPromise(result)) throw new $ZodAsyncError();
      if (node.op === "refine") {
        if (!result) { issue(context, node, path, { code: "custom" }, base); return FAIL; }
        output = base; // a passing refinement is transparent: yield the input value, not the predicate result
        break;
      }
      if (node.op === "superRefine" || node.op === "check") return (context.issues?.length ?? 0) > before ? FAIL : base;
      // transform / preprocess / overwrite / codec_*: a fn that reported issues fails
      if ((context.issues?.length ?? 0) > before) return FAIL;
      output = result;
      break;
    }
  }
  return applyChecksSync(node, output, context, path);
}

async function applyChecksAsync(node: SchemaNode, initial: unknown, context: ValidationContext, path: PropertyKey[]): Promise<unknown | FailType> {
  let value = initial;
  const synchronous: RuntimeCheck[] = [];
  for (const runtime of node.checks) {
    if (runtime.check.c !== "host_runtime") { synchronous.push(runtime); continue; }
    const check: HostRuntimeCheck = runtime.check;
    const before = context.issues?.length ?? 0;
    const result = await check.fn(value, makeRefinementContext(context, node, path, value));
    if (check.op === "refine" && !result) {
      const error = runtime.error ?? node.error;
      const issuePath = runtime.path ? [...path, ...runtime.path] : path;
      addIssue(context, { code: "custom", input: value, inst: { error }, path: issuePath, continue: runtime.abort !== true, ...(runtime.params ? { params: runtime.params } : {}) } as $ZodRawIssue);
    }
    else if (check.op === "overwrite" || check.op === "transform" || check.op === "preprocess") value = result;
    if ((context.issues?.length ?? 0) > before && runtime.abort) return FAIL;
  }
  if (synchronous.length === 0) return context.issues ? FAIL : value;
  const syncNode = { ...node, checks: synchronous } as SchemaNode;
  return applyChecksSync(syncNode, value, context, path);
}

async function runAsync(node: SchemaNode, input: unknown, context: ValidationContext, path: PropertyKey[]): Promise<unknown | FailType> {
  if (node.kind === "host") {
    const base = node.inner ? await runAsync(node.inner, input, context, path) : input;
    if (base === FAIL) return FAIL;
    const before = context.issues?.length ?? 0;
    const result = await node.fn(base, makeRefinementContext(context, node, path, base));
    if (node.op === "refine") {
      if (!result) { issue(context, node, path, { code: "custom" }, base); return FAIL; }
      return base;
    }
    if (node.op === "superRefine" || node.op === "check") return (context.issues?.length ?? 0) > before ? FAIL : base;
    if ((context.issues?.length ?? 0) > before) return FAIL;
    return result;
  }
  if (node.kind === "pipe") {
    const first = await runAsync(node.a, input, context, path);
    return first === FAIL ? FAIL : runAsync(node.b, first, context, path);
  }
  if (node.kind === "object" && isObject(input)) {
    const result: Record<string, unknown> = {}; let failed = false; const known: Record<string, true> = {};
    for (const [key, child] of Object.entries(node.shape)) { known[key] = true; const present = Object.prototype.hasOwnProperty.call(input, key); const parsed = await runAsync(child, present ? input[key] : undefined, context, [...path, key]); if (parsed === FAIL) failed = true; else if (present || parsed !== undefined) result[key] = parsed; }
    for (const key of Object.keys(input).filter((entry) => !known[entry])) {
      if (node.catchall) { const parsed = await runAsync(node.catchall, input[key], context, [...path, key]); if (parsed === FAIL) failed = true; else result[key] = parsed; }
      else if (node.mode === "passthrough") result[key] = input[key];
      else if (node.mode === "strict") { issue(context, node, path, { code: "unrecognized_keys", keys: Object.keys(input).filter((entry) => !known[entry]) }, input); failed = true; break; }
    }
    if (failed) { if (node.checks.length > 0) await applyChecksAsync(node, input, context, path); return FAIL; }
    return applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "array" && Array.isArray(input)) {
    const result: unknown[] = []; let failed = false;
    for (let index = 0; index < input.length; index += 1) { const parsed = await runAsync(node.element, input[index], context, [...path, index]); if (parsed === FAIL) failed = true; else result.push(parsed); }
    if (failed) { if (node.checks.length > 0) await applyChecksAsync(node, input, context, path); return FAIL; }
    return applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "tuple" && Array.isArray(input)) {
    let optinStart = node.items.length;
    let optoutStart = node.items.length;
    for (let index = node.items.length - 1; index >= 0; index -= 1) {
      const item = node.items[index];
      if (item && isOptinOptional(item)) optinStart = index; else break;
    }
    for (let index = node.items.length - 1; index >= 0; index -= 1) {
      const item = node.items[index];
      if (item && isOptoutOptional(item)) optoutStart = index; else break;
    }
    if (!node.rest && input.length < optinStart) { issue(context, node, path, { code: "too_small", minimum: optinStart, inclusive: true, origin: "array" }, input); return FAIL; }
    const oversized = !node.rest && input.length > node.items.length;
    if (oversized) { issue(context, node, path, { code: "too_big", maximum: node.items.length, inclusive: true, origin: "array" }, input); }
    const result: unknown[] = [];
    let failed = oversized;
    for (let index = 0; index < node.items.length; index += 1) {
      const child = node.items[index];
      if (!child) continue;
      const parsed = await runAsync(child, input[index], context, [...path, index]);
      if (parsed === FAIL) {
        if (index >= input.length && index >= optinStart && index >= optoutStart) { result.length = index; break; }
        failed = true;
      } else {
        result[index] = parsed;
      }
    }
    if (!failed && node.rest) {
      for (let index = node.items.length; index < input.length; index += 1) {
        const parsed = await runAsync(node.rest, input[index], context, [...path, index]);
        if (parsed === FAIL) failed = true; else result[index] = parsed;
      }
    }
    for (let index = result.length - 1; index >= input.length; index -= 1) {
      if (result[index] === undefined && isOptoutOptional(node.items[index])) result.length = index; else break;
    }
    if (failed) { if (node.checks.length > 0) await applyChecksAsync(node, input, context, path); return FAIL; }
    return applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "union") {
    const errors: $ZodRawIssue[][] = [];
    for (const option of node.options) { const branch: ValidationContext = { ...context, issues: null }; const parsed = await runAsync(option, input, branch, path); if (parsed !== FAIL) return applyChecksAsync(node, parsed, context, path); errors.push(branch.issues ?? []); }
    issue(context, node, path, { code: "invalid_union", errors }, input); return FAIL;
  }
  if (node.kind === "optional") { if (input === undefined) return applyChecksAsync(node, undefined, context, path); const parsed = await runAsync(node.inner, input, context, path); return parsed === FAIL ? FAIL : applyChecksAsync(node, parsed, context, path); }
  if (node.kind === "exactOptional") { const parsed = await runAsync(node.inner, input, context, path); return parsed === FAIL ? FAIL : applyChecksAsync(node, parsed, context, path); }
  if (node.kind === "nullable") { if (input === null) return applyChecksAsync(node, null, context, path); const parsed = await runAsync(node.inner, input, context, path); return parsed === FAIL ? FAIL : applyChecksAsync(node, parsed, context, path); }
  if (node.kind === "nonoptional") { if (input === undefined) { issue(context, node, path, { code: "invalid_type", expected: "nonoptional" }, input); return FAIL; } const parsed = await runAsync(node.inner, input, context, path); return parsed === FAIL ? FAIL : applyChecksAsync(node, parsed, context, path); }
  if (node.kind === "readonly") { const parsed = await runAsync(node.inner, input, context, path); if (parsed !== FAIL && typeof parsed === "object" && parsed !== null) Object.freeze(parsed); return parsed; }
  if (node.kind === "lazy") return runAsync(node.getter(), input, context, path);
  if (node.kind === "promise" && isPromise(input)) return runAsync(node.inner, await input, context, path);
  if (node.kind === "default") {
    if (input === undefined) return node.dynamic ? await (node.value as (context?: { input: unknown }) => MaybeAsync<unknown>)({ input }) : shallowClone(node.value);
    const result = await runAsync(node.inner, input, context, path);
    if (result === FAIL) return FAIL;
    return result === undefined ? (node.dynamic ? await (node.value as (context?: { input: unknown }) => MaybeAsync<unknown>)({ input }) : shallowClone(node.value)) : result;
  }
  if (node.kind === "prefault") { const value = input === undefined ? node.dynamic ? await (node.value as (context?: { input: unknown }) => MaybeAsync<unknown>)({ input }) : shallowClone(node.value) : input; return runAsync(node.inner, value, context, path); }
  if (node.kind === "catch") { const local: ValidationContext = { ...context, issues: null }; const parsed = await runAsync(node.inner, input, local, path); return parsed === FAIL ? node.dynamic ? await (node.value as (context?: { error?: unknown; input: unknown }) => MaybeAsync<unknown>)({ error: { issues: local.issues ?? [] }, input }) : node.value : parsed; }
  if (node.kind === "record" && isObject(input)) {
    const result: Record<PropertyKey, unknown> = {}; let failed = false;
    const enumerated = node.partial ? undefined : keyValues(node.key);
    if (enumerated) {
      const expected = new Set<string>(enumerated.map((value) => String(value)));
      for (const key of enumerated) {
        const stringKey = String(key);
        const keyContext: ValidationContext = { ...context, issues: null };
        const parsedKey = await runAsync(node.key, key, keyContext, []);
        if (parsedKey === FAIL) { issue(context, node, [...path, stringKey], { code: "invalid_key", origin: "record", issues: keyContext.issues ?? [] }, key); failed = true; continue; }
        const parsed = await runAsync(node.value, (input as Record<PropertyKey, unknown>)[stringKey], context, [...path, key]);
        if (parsed === FAIL) failed = true; else result[String(parsedKey)] = parsed;
      }
      const extra = Object.keys(input).filter((key) => !expected.has(key));
      if (extra.length > 0) { issue(context, node, path, { code: "unrecognized_keys", keys: extra }, input); failed = true; }
      return failed ? FAIL : applyChecksAsync(node, result, context, path);
    }
    for (const key of Reflect.ownKeys(input)) {
      if (key === "__proto__") continue;
      if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
      const value = (input as Record<PropertyKey, unknown>)[key];
      const keyContext: ValidationContext = { ...context, issues: null };
      let parsedKey = await runAsync(node.key, key, keyContext, []);
      if (parsedKey === FAIL && typeof key === "string" && key !== "" && !Number.isNaN(Number(key))) {
        const retry: ValidationContext = { ...context, issues: null };
        const numeric = await runAsync(node.key, Number(key), retry, []);
        if (numeric !== FAIL) { parsedKey = numeric; keyContext.issues = retry.issues; }
      }
      if (parsedKey === FAIL) {
        if (node.mode === "loose") { result[key] = value; continue; }
        issue(context, node, [...path, key], { code: "invalid_key", origin: "record", issues: keyContext.issues ?? [] }, key);
        failed = true;
        continue;
      }
      const parsed = await runAsync(node.value, value, context, [...path, key]);
      if (parsed === FAIL) failed = true; else result[parsedKey as PropertyKey] = parsed;
    }
    if (failed) { if (node.checks.length > 0) await applyChecksAsync(node, input, context, path); return FAIL; }
    return applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "map" && input instanceof Map) {
    const result = new Map<unknown, unknown>(); let failed = false;
    for (const [key, value] of input) {
      const keyContext: ValidationContext = { ...context, issues: null };
      const valueContext: ValidationContext = { ...context, issues: null };
      const parsedKey = await runAsync(node.key, key, keyContext, []);
      const parsedValue = await runAsync(node.value, value, valueContext, []);
      const propertyKey = typeof key === "string" || typeof key === "number" || typeof key === "symbol";
      if (keyContext.issues?.length) {
        failed = true;
        if (propertyKey) for (const nested of keyContext.issues) addIssue(context, { ...nested, path: [key, ...(nested.path ?? [])] });
        else addIssue(context, { code: "invalid_key", origin: "map", input, issues: keyContext.issues, path, inst: { error: node.error } } as $ZodRawIssue);
      }
      if (valueContext.issues?.length) {
        failed = true;
        if (propertyKey) for (const nested of valueContext.issues) addIssue(context, { ...nested, path: [key, ...(nested.path ?? [])] });
        else addIssue(context, { origin: "map", code: "invalid_element", input, key, issues: valueContext.issues, path, inst: { error: node.error } } as $ZodRawIssue);
      }
      if (parsedKey !== FAIL && parsedValue !== FAIL) result.set(parsedKey, parsedValue);
    }
    return failed ? FAIL : applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "set" && input instanceof Set) {
    const result = new Set<unknown>(); let failed = false;
    for (const value of input) {
      const valueContext: ValidationContext = { ...context, issues: null };
      const parsed = await runAsync(node.value, value, valueContext, []);
      if (valueContext.issues?.length) { failed = true; for (const nested of valueContext.issues) addIssue(context, nested); }
      if (parsed !== FAIL) result.add(parsed);
    }
    return failed ? FAIL : applyChecksAsync(node, result, context, path);
  }
  if (node.checks.some((runtime) => runtime.check.c === "host_runtime")) {
    // Leaf/compound node carrying host (possibly async) checks: validate the
    // underlying type without running checks synchronously, then apply them async.
    const base = runSync({ ...node, checks: [] }, input, context, path);
    return base === FAIL ? FAIL : applyChecksAsync(node, base, context, path);
  }
  return runSync(node, input, context, path);
}

export function createInterpreter(root: SchemaNode): Validator {
  return (input, context) => runSync(root, input, context, []);
}

export function createAsyncInterpreter(root: SchemaNode): AsyncValidator {
  return (input, context) => runAsync(root, input, context, []);
}

export interface Runtime {
  run(node: SchemaNode, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType;
  runAsync(node: SchemaNode, input: unknown, context: ValidationContext, path: PropertyKey[]): Promise<unknown | FailType>;
  typeIssue(context: ValidationContext, node: SchemaNode, path: PropertyKey[], expected: string, input: unknown): void;
  applyChecks(node: SchemaNode, value: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType;
  keyIssue(context: ValidationContext, node: SchemaNode, path: PropertyKey[], keys: string[], input: unknown): void;
  readonly FAIL: FailType;
}

export const runtime: Runtime = {
  run: runSync,
  runAsync,
  applyChecks: applyChecksSync,
  FAIL,
  typeIssue(context, node, path, expected, input) {
    issue(context, node, path, { expected, code: "invalid_type" }, input);
  },
  keyIssue(context, node, path, keys, input) {
    issue(context, node, path, { code: "unrecognized_keys", keys }, input);
  },
};
