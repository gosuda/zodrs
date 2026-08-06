import type { $ZodRawIssue, ParseContext } from "./errors.js";
import { testFormat } from "./formats.js";
import type { HostRuntimeCheck, RuntimeCheck, SchemaNode } from "./nodes.js";
import { FAIL, isObject, parsedType } from "./util.js";
import type { FAIL as FailType, MaybeAsync } from "./util.js";

export interface ValidationContext extends ParseContext {
  issues: $ZodRawIssue[] | null;
  readonly async?: boolean;
  readonly direction?: "forward" | "backward";
}

export type Validator = (input: unknown, context: ValidationContext) => unknown | FailType;
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
      return context.issues ?? [];
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
      if (check.op === "refine" && !result) issue(context, node, path, { code: "custom" }, value);
      else if (check.op === "overwrite" || check.op === "transform" || check.op === "preprocess") value = result;
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
          if (size < check.v) issue(context, node, path, { code: "too_small", origin, minimum: check.v, inclusive: true }, value);
          break;
        }
        case "max_length":
        case "max_size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : 0;
          if (size > check.v) issue(context, node, path, { code: "too_big", origin, maximum: check.v, inclusive: true }, value);
          break;
        }
        case "length":
        case "size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : 0;
          if (size !== check.v) {
            const small = size < check.v;
            issue(context, node, path, small
              ? { code: "too_small", origin, minimum: check.v, inclusive: true, exact: true }
              : { code: "too_big", origin, maximum: check.v, inclusive: true, exact: true }, value);
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
              ? { code: "too_small", origin, minimum: target, inclusive: check.inclusive }
              : { code: "too_big", origin, maximum: target, inclusive: check.inclusive }, value);
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
            issue(context, node, path, { code: "invalid_type", expected: "int", format: check.v }, value);
            break;
          }
          const bounds: Readonly<Record<string, readonly [number, number]>> = {
            int32: [-2147483648, 2147483647], uint32: [0, 4294967295], safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
            float32: [-3.4028234663852886e38, 3.4028234663852886e38], float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
          };
          const [min, max] = bounds[check.v] ?? [-Number.MAX_VALUE, Number.MAX_VALUE];
          if (value < min) issue(context, node, path, { code: "too_small", origin: integer ? "int" : "number", minimum: min, inclusive: true }, value);
          if (value > max) issue(context, node, path, { code: "too_big", origin: integer ? "int" : "number", maximum: max, inclusive: true }, value);
          break;
        }
        case "bigint_format": {
          if (typeof value !== "bigint") break;
          const min = check.v === "uint64" ? 0n : -(2n ** 63n);
          const max = check.v === "uint64" ? 2n ** 64n - 1n : 2n ** 63n - 1n;
          if (value < min) issue(context, node, path, { code: "too_small", origin: "bigint", minimum: min, inclusive: true }, value);
          if (value > max) issue(context, node, path, { code: "too_big", origin: "bigint", maximum: max, inclusive: true }, value);
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
    if ((context.issues?.length ?? 0) > before) {
      failed = true;
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
    case "never": issue(context, node, path, { code: "invalid_type", expected: "never" }, input); return FAIL;
    case "string": if (typeof input !== "string") { issue(context, node, path, { code: "invalid_type", expected: "string" }, input); return FAIL; } output = input; break;
    case "number": if (typeof input !== "number" || Number.isNaN(input)) { issue(context, node, path, { code: "invalid_type", expected: "number" }, input); return FAIL; } output = input; break;
    case "bigint": if (typeof input !== "bigint") { issue(context, node, path, { code: "invalid_type", expected: "bigint" }, input); return FAIL; } output = input; break;
    case "boolean": if (typeof input !== "boolean") { issue(context, node, path, { code: "invalid_type", expected: "boolean" }, input); return FAIL; } output = input; break;
    case "symbol": if (typeof input !== "symbol") { issue(context, node, path, { code: "invalid_type", expected: "symbol" }, input); return FAIL; } output = input; break;
    case "undefined": case "void": if (input !== undefined) { issue(context, node, path, { code: "invalid_type", expected: node.kind }, input); return FAIL; } output = input; break;
    case "null": if (input !== null) { issue(context, node, path, { code: "invalid_type", expected: "null" }, input); return FAIL; } output = input; break;
    case "nan": if (typeof input !== "number" || !Number.isNaN(input)) { issue(context, node, path, { code: "invalid_type", expected: "nan" }, input); return FAIL; } output = input; break;
    case "date": if (!(input instanceof Date) || Number.isNaN(input.getTime())) { issue(context, node, path, { code: "invalid_type", expected: "date" }, input); return FAIL; } output = new Date(input.getTime()); break;
    case "file": if (!isObject(input) || !("name" in input) || !("size" in input) || !("type" in input)) { issue(context, node, path, { code: "invalid_type", expected: "file" }, input); return FAIL; } output = input; break;
    case "literal": if (!node.values.some((value) => Object.is(value, input))) { issue(context, node, path, { code: "invalid_value", values: [...node.values] }, input); return FAIL; } output = input; break;
    case "enum": if (!node.values.includes(input as string | number)) { issue(context, node, path, { code: "invalid_value", values: [...node.values] }, input); return FAIL; } output = input; break;
    case "object": {
      if (!isObject(input)) { issue(context, node, path, { code: "invalid_type", expected: "object" }, input); return FAIL; }
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
      if (failed) return FAIL;
      output = result;
      break;
    }
    case "array": {
      if (!Array.isArray(input)) { issue(context, node, path, { code: "invalid_type", expected: "array" }, input); return FAIL; }
      const result: unknown[] = [];
      let failed = false;
      for (let index = 0; index < input.length; index += 1) {
        const childResult = runSync(node.element, input[index], context, [...path, index]);
        if (childResult === FAIL) failed = true; else result.push(childResult);
      }
      if (failed) return FAIL;
      output = result;
      break;
    }
    case "tuple": {
      if (!Array.isArray(input)) { issue(context, node, path, { code: "invalid_type", expected: "tuple" }, input); return FAIL; }
      if (!node.rest && input.length > node.items.length) { issue(context, node, path, { code: "too_big", origin: "array", maximum: node.items.length, inclusive: true }, input); return FAIL; }
      const result: unknown[] = [];
      let failed = false;
      for (let index = 0; index < Math.max(input.length, node.items.length); index += 1) {
        const child = node.items[index] ?? node.rest;
        if (!child) continue;
        const childResult = runSync(child, input[index], context, [...path, index]);
        if (childResult === FAIL) failed = true; else result.push(childResult);
      }
      if (failed) return FAIL;
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
      if (!isObject(input)) { issue(context, node, path, { code: "invalid_type", expected: "record" }, input); return FAIL; }
      const result: Record<string, unknown> = {};
      let failed = false;
      for (const [key, value] of Object.entries(input)) {
        const keyContext: ValidationContext = { ...context, issues: null };
        const parsedKey = runSync(node.key, key, keyContext, [...path, key]);
        if (parsedKey === FAIL) { issue(context, node, [...path, key], { code: "invalid_key", origin: "record", issues: keyContext.issues ?? [] }, key); failed = true; continue; }
        const parsed = runSync(node.value, value, context, [...path, key]);
        if (parsed === FAIL) failed = true; else result[String(parsedKey)] = parsed;
      }
      if (failed) return FAIL;
      output = result;
      break;
    }
    case "map": {
      if (!(input instanceof Map)) { issue(context, node, path, { code: "invalid_type", expected: "map" }, input); return FAIL; }
      const result = new Map<unknown, unknown>();
      let failed = false;
      let index = 0;
      for (const [key, value] of input) {
        const parsedKey = runSync(node.key, key, context, [...path, index]);
        const parsedValue = runSync(node.value, value, context, [...path, index]);
        if (parsedKey === FAIL || parsedValue === FAIL) failed = true; else result.set(parsedKey, parsedValue);
        index += 1;
      }
      if (failed) return FAIL;
      output = result;
      break;
    }
    case "set": {
      if (!(input instanceof Set)) { issue(context, node, path, { code: "invalid_type", expected: "set" }, input); return FAIL; }
      const result = new Set<unknown>(); let failed = false; let index = 0;
      for (const value of input) { const parsed = runSync(node.value, value, context, [...path, index]); if (parsed === FAIL) failed = true; else result.add(parsed); index += 1; }
      if (failed) return FAIL; output = result; break;
    }
    case "optional": if (input === undefined) return undefined; else return runSync(node.inner, input, context, path);
    case "nullable": if (input === null) return null; else return runSync(node.inner, input, context, path);
    case "nonoptional": if (input === undefined) { issue(context, node, path, { code: "invalid_type", expected: "nonoptional" }, input); return FAIL; } else return runSync(node.inner, input, context, path);
    case "readonly": { const parsed = runSync(node.inner, input, context, path); if (parsed === FAIL) return FAIL; if (typeof parsed === "object" && parsed !== null) Object.freeze(parsed); return parsed; }
    case "lazy": return runSync(node.getter(), input, context, path);
    case "promise": if (!isPromise(input)) { issue(context, node, path, { code: "invalid_type", expected: "promise" }, input); return FAIL; } return Promise.resolve(input).then((value) => runAsync(node.inner, value, { ...context, async: true }, path));
    case "default": if (input === undefined) return node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : node.value; else return runSync(node.inner, input, context, path);
    case "prefault": { const value = input === undefined ? node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : node.value : input; return runSync(node.inner, value, context, path); }
    case "catch": { const local: ValidationContext = { ...context, issues: null }; const parsed = runSync(node.inner, input, local, path); return parsed === FAIL ? node.dynamic ? (node.value as (context?: { error?: unknown; input: unknown }) => unknown)({ error: local.issues, input }) : node.value : parsed; }
    case "pipe": { const first = runSync(node.a, input, context, path); return first === FAIL ? FAIL : runSync(node.b, first, context, path); }
    case "templateLiteral": if (typeof input !== "string" || !node.pattern.test(input)) { issue(context, node, path, { code: "invalid_format", format: "template_literal", pattern: node.pattern.source }, input); return FAIL; } output = input; break;
    case "host": {
      const base = node.inner ? runSync(node.inner, input, context, path) : input;
      if (base === FAIL) return FAIL;
      const refinement = makeRefinementContext(context, node, path, base);
      const result = node.fn(base, refinement);
      if (isPromise(result)) throw new $ZodAsyncError();
      if (node.op === "refine" && !result) { issue(context, node, path, { code: "custom" }, base); return FAIL; }
      if (node.op === "superRefine" || node.op === "check") return context.issues ? FAIL : base;
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
    if (check.op === "refine" && !result) issue(context, node, path, { code: "custom" }, value);
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
    const result = await node.fn(base, makeRefinementContext(context, node, path, base));
    if (node.op === "refine" && !result) { issue(context, node, path, { code: "custom" }, base); return FAIL; }
    if (node.op === "superRefine" || node.op === "check") return context.issues ? FAIL : base;
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
    return failed ? FAIL : applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "array" && Array.isArray(input)) {
    const result: unknown[] = []; let failed = false;
    for (let index = 0; index < input.length; index += 1) { const parsed = await runAsync(node.element, input[index], context, [...path, index]); if (parsed === FAIL) failed = true; else result.push(parsed); }
    return failed ? FAIL : applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "union") {
    const errors: $ZodRawIssue[][] = [];
    for (const option of node.options) { const branch: ValidationContext = { ...context, issues: null }; const parsed = await runAsync(option, input, branch, path); if (parsed !== FAIL) return applyChecksAsync(node, parsed, context, path); errors.push(branch.issues ?? []); }
    issue(context, node, path, { code: "invalid_union", errors }, input); return FAIL;
  }
  if (node.kind === "optional" && input !== undefined) return runAsync(node.inner, input, context, path);
  if (node.kind === "nullable" && input !== null) return runAsync(node.inner, input, context, path);
  if (node.kind === "nonoptional" && input !== undefined) return runAsync(node.inner, input, context, path);
  if (node.kind === "readonly") { const parsed = await runAsync(node.inner, input, context, path); if (parsed !== FAIL && typeof parsed === "object" && parsed !== null) Object.freeze(parsed); return parsed; }
  if (node.kind === "lazy") return runAsync(node.getter(), input, context, path);
  if (node.kind === "promise" && isPromise(input)) return runAsync(node.inner, await input, context, path);
  if (node.kind === "default" && input !== undefined) return runAsync(node.inner, input, context, path);
  if (node.kind === "prefault") { const value = input === undefined ? node.dynamic ? await (node.value as (context?: { input: unknown }) => MaybeAsync<unknown>)({ input }) : node.value : input; return runAsync(node.inner, value, context, path); }
  if (node.kind === "catch") { const local: ValidationContext = { ...context, issues: null }; const parsed = await runAsync(node.inner, input, local, path); return parsed === FAIL ? node.dynamic ? await (node.value as (context?: { error?: unknown; input: unknown }) => MaybeAsync<unknown>)({ error: local.issues, input }) : node.value : parsed; }
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
    issue(context, node, path, { code: "invalid_type", expected }, input);
  },
  keyIssue(context, node, path, keys, input) {
    issue(context, node, path, { code: "unrecognized_keys", keys }, input);
  },
};
