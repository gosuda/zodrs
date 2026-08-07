import type { $ZodRawIssue, ParseContext } from "./errors.js";
import { finalizeNested, ZodError } from "./errors.js";
import { checkUrl, patternForFormat, testFormat } from "./formats.js";
import { optinOf, optoutOf } from "./introspect.js";
import type {
  Check,
  HostRuntimeCheck,
  RuntimeCheck,
  SchemaNode,
} from "./nodes.js";
import {
  BIGINT_FORMAT_RANGES,
  FAIL,
  floatSafeRemainder,
  isObject,
  isPlainObject,
  NUMBER_FORMAT_RANGES,
  shallowClone,
} from "./util.js";
import type { FAIL as FailType, MaybeAsync, Primitive } from "./util.js";

export interface ValidationContext extends ParseContext {
  issues: $ZodRawIssue[] | null;
  async: boolean;
  direction?: "forward" | "backward";
  /** Incremented when a `catch` fires; lets `optional` swallow fallback values. */
  fallback?: number;
}

export type Validator = (input: unknown, context: ValidationContext) => unknown | FailType;

export type AsyncValidator = (input: unknown, context: ValidationContext) => Promise<unknown | FailType>;

export class $ZodAsyncError extends Error {
  constructor() {
    super("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
    this.name = "$ZodAsyncError";
  }
}

export class $ZodEncodeError extends Error {
  constructor(name: string) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
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

export function isPromise(value: unknown): value is PromiseLike<unknown> {
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
        // Key order matches Zod's `util.issue` string form: message, code, then path at finalize.
        addIssue(context, { message: raw, code: "custom", input: value, path } as $ZodRawIssue);
        return;
      }
      const fatal = (raw as Record<string, unknown>)["fatal"] === true;
      const merged: Record<string, unknown> = {
        ...raw,
        input: raw.input ?? value,
        path: [...path, ...(raw.path ?? [])],
        // fatal: true is sugar for continue: false; absent continue defaults true
        // (Zod `_superRefine`: `continue ??= !def.abort`, and abort is always unset).
        continue: fatal ? false : (raw.continue ?? true),
      };
      if (raw.inst) merged["inst"] = raw.inst;
      addIssue(context, merged as $ZodRawIssue);
    },
  };
}

function numeric(checkValue: number | string, bigint: boolean): number | bigint {
  return bigint ? BigInt(checkValue) : Number(checkValue);
}

export function applyOverwrite(op: "trim" | "toLowerCase" | "toUpperCase" | "normalize" | "slugify", value: unknown, form?: string): unknown {
  if (typeof value !== "string") return value;
  switch (op) {
    case "trim": return value.trim();
    case "toLowerCase": return value.toLowerCase();
    case "toUpperCase": return value.toUpperCase();
    case "normalize": return value.normalize(form);
    case "slugify":
      return value.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
  }
}

/** True when any issue added from `startIndex` onward is non-continuable. */
function abortedSince(context: ValidationContext, startIndex: number): boolean {
  const issues = context.issues;
  if (!issues) return false;
  for (let index = startIndex; index < issues.length; index += 1) {
    if (issues[index]?.continue !== true) return true;
  }
  return false;
}

function checkPayloadIssues(
  context: ValidationContext,
  node: SchemaNode,
  path: PropertyKey[],
  details: Readonly<Record<string, unknown>>,
  input: unknown,
  runtime: RuntimeCheck,
): void {
  const raw: Record<string, unknown> = { ...details, input, path, inst: { error: runtime.error }, continue: runtime.abort !== true };
  addIssue(context, raw as $ZodRawIssue);
}

function applyChecksSync(node: SchemaNode, initial: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  let value = initial;
  let failed = false;
  let aborted = false;
  for (const runtime of node.checks) {
    if (runtime.when) {
      const shouldRun = runtime.when({ value, issues: context.issues ?? [] });
      if (!shouldRun) continue;
    } else if (aborted) {
      continue;
    }
    const check = runtime.check;
    const before = context.issues?.length ?? 0;
    if (check.c === "host_runtime") {
      const refinement = makeRefinementContext(context, node, path, value);
      const result = check.fn(value, refinement);
      if (isPromise(result)) throw new $ZodAsyncError();
      if (context.issues) {
        // Direct `ctx.issues.push(...)` bypasses addIssue's path back-fill;
        // stamp pathless issues with the current path, matching Zod v4.
        for (let index = before; index < context.issues.length; index += 1) {
          const pushed: { path?: PropertyKey[] } = context.issues[index] as $ZodRawIssue;
          if (pushed.path === undefined) pushed.path = [...path];
        }
      }
      if (check.op === "refine" && !result) {
        const issuePath = runtime.path ? [...path, ...runtime.path] : path;
        addIssue(context, { code: "custom", input: value, inst: { error: runtime.error }, path: issuePath, continue: runtime.abort !== true, ...(runtime.params ? { params: runtime.params } : {}) } as $ZodRawIssue);
      } else if (check.op === "custom_format" && !result) {
        addIssue(context, { code: "invalid_format", format: check.format ?? "unknown", input: value, inst: { error: runtime.error }, path, continue: runtime.abort !== true } as $ZodRawIssue);
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
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : isObject(value) && typeof value["size"] === "number" ? (value as { size: number }).size : 0;
          if (size < check.v) checkPayloadIssues(context, node, path, { origin, code: "too_small", minimum: check.v, inclusive: true }, value, runtime);
          break;
        }
        case "max_length":
        case "max_size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : isObject(value) && typeof value["size"] === "number" ? (value as { size: number }).size : 0;
          if (size > check.v) checkPayloadIssues(context, node, path, { origin, code: "too_big", maximum: check.v, inclusive: true }, value, runtime);
          break;
        }
        case "length":
        case "size": {
          const size = typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Set || value instanceof Map ? value.size : isObject(value) && typeof value["size"] === "number" ? (value as { size: number }).size : 0;
          if (size !== check.v) {
            const small = size < check.v;
            checkPayloadIssues(context, node, path, small
              ? { origin, code: "too_small", minimum: check.v, inclusive: true, exact: true }
              : { origin, code: "too_big", maximum: check.v, inclusive: true, exact: true }, value, runtime);
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
            checkPayloadIssues(context, node, path, check.c === "gt"
              ? { origin, code: "too_small", minimum: target, inclusive: check.inclusive }
              : { origin, code: "too_big", maximum: target, inclusive: check.inclusive }, value, runtime);
          }
          break;
        }
        case "multiple_of": {
          if (typeof value === "bigint" ? value % BigInt(check.v) !== 0n : typeof value !== "number" || floatSafeRemainder(value, Number(check.v)) !== 0) {
            checkPayloadIssues(context, node, path, { code: "not_multiple_of", divisor: Number(check.v) }, value, runtime);
          }
          break;
        }
        case "number_format": {
          if (typeof value !== "number") break;
          const integer = check.v === "int32" || check.v === "uint32" || check.v === "safeint";
          if (integer && !Number.isInteger(value)) {
            checkPayloadIssues(context, node, path, { expected: "int", format: check.v, code: "invalid_type" }, value, runtime);
            break;
          }
          const bounds = NUMBER_FORMAT_RANGES[check.v as keyof typeof NUMBER_FORMAT_RANGES] ?? NUMBER_FORMAT_RANGES.float64;
          const [min, max] = bounds;
          if (value < min) checkPayloadIssues(context, node, path, { origin: integer ? "int" : "number", code: "too_small", minimum: min, inclusive: true }, value, runtime);
          if (value > max) checkPayloadIssues(context, node, path, { origin: integer ? "int" : "number", code: "too_big", maximum: max, inclusive: true }, value, runtime);
          break;
        }
        case "bigint_format": {
          if (typeof value !== "bigint") break;
          const [min, max] = BIGINT_FORMAT_RANGES[check.v as keyof typeof BIGINT_FORMAT_RANGES];
          if (value < min) checkPayloadIssues(context, node, path, { origin: "bigint", code: "too_small", minimum: min, inclusive: true }, value, runtime);
          if (value > max) checkPayloadIssues(context, node, path, { origin: "bigint", code: "too_big", maximum: max, inclusive: true }, value, runtime);
          break;
        }
        case "format": {
          if (typeof value !== "string") break;
          if (check.v === "url" || check.v === "httpUrl") {
            const verdict = checkUrl(value, check.params, check.v === "httpUrl");
            if (!verdict.ok) {
              checkPayloadIssues(context, node, path, {
                code: "invalid_format", format: "url",
                ...(verdict.note ? { note: verdict.note } : {}),
                ...(verdict.pattern ? { pattern: verdict.pattern } : {}),
              }, value, runtime);
            } else {
              value = verdict.value;
            }
            break;
          }
          if (!testFormat(check.v, value, check.params)) {
            // Procedural formats (Zod overrides `_zod.check`) push neither
            // `origin` nor `pattern`; regex-backed formats push both.
            if (check.v === "jwt" || check.v === "ipv6" || check.v === "cidrv6" || check.v === "base64" || check.v === "base64url") {
              checkPayloadIssues(context, node, path, { code: "invalid_format", format: check.v }, value, runtime);
              break;
            }
            const pattern = patternForFormat(check.v, check.params);
            const formatName = check.v === "uuidv4" || check.v === "uuidv6" || check.v === "uuidv7" ? "uuid" : check.v;
            checkPayloadIssues(context, node, path, {
              origin: "string", code: "invalid_format", format: formatName,
              ...(pattern ? { pattern: pattern.toString() } : {}),
            }, value, runtime);
          }
          break;
        }
        case "regex":
          if (typeof value === "string" && !new RegExp(check.src, check.flags).test(value)) {
            checkPayloadIssues(context, node, path, { origin: "string", code: "invalid_format", format: "regex", pattern: `/${check.src}/${check.flags}` }, value, runtime);
          }
          break;
        case "starts_with":
          if (typeof value === "string" && !value.startsWith(check.v)) checkPayloadIssues(context, node, path, { origin: "string", code: "invalid_format", format: "starts_with", prefix: check.v }, value, runtime);
          break;
        case "ends_with":
          if (typeof value === "string" && !value.endsWith(check.v)) checkPayloadIssues(context, node, path, { origin: "string", code: "invalid_format", format: "ends_with", suffix: check.v }, value, runtime);
          break;
        case "includes":
          if (typeof value === "string" && !value.includes(check.v, check.position)) checkPayloadIssues(context, node, path, { origin: "string", code: "invalid_format", format: "includes", includes: check.v }, value, runtime);
          break;
        case "lowercase":
          if (typeof value === "string" && value !== value.toLowerCase()) checkPayloadIssues(context, node, path, { origin: "string", code: "invalid_format", format: "lowercase", pattern: "/^[^A-Z]*$/" }, value, runtime);
          break;
        case "uppercase":
          if (typeof value === "string" && value !== value.toUpperCase()) checkPayloadIssues(context, node, path, { origin: "string", code: "invalid_format", format: "uppercase", pattern: "/^[^a-z]*$/" }, value, runtime);
          break;
        case "overwrite":
          value = applyOverwrite(check.op, value, check.form);
          break;
        case "mime": {
          if (isObject(value) && "type" in value && typeof value["type"] === "string" && !check.v.includes(value["type"])) checkPayloadIssues(context, node, path, { code: "invalid_value", values: check.v }, value, runtime);
          break;
        }
      }
    }
    if ((context.issues?.length ?? 0) > before) {
      failed = true;
      if (!aborted) aborted = abortedSince(context, before);
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

interface MergeResult {
  readonly valid: boolean;
  readonly data?: unknown;
  readonly mergeErrorPath?: PropertyKey[];
}

function mergeValues(a: unknown, b: unknown): MergeResult {
  if (a === b) return { valid: true, data: a };
  if (a instanceof Date && b instanceof Date && +a === +b) return { valid: true, data: a };
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj: Record<string, unknown> = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false, mergeErrorPath: [key, ...(sharedValue.mergeErrorPath ?? [])] };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { valid: false, mergeErrorPath: [] };
    const newArray: unknown[] = [];
    for (let index = 0; index < a.length; index += 1) {
      const sharedValue = mergeValues(a[index], b[index]);
      if (!sharedValue.valid) {
        return { valid: false, mergeErrorPath: [index, ...(sharedValue.mergeErrorPath ?? [])] };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}

function intersectionResult(node: SchemaNode & { readonly kind: "intersection" }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  const issueStart = context.issues?.length ?? 0;
  const leftContext: ValidationContext = { ...context, issues: null };
  const rightContext: ValidationContext = { ...context, issues: null };
  const left = runSync(node.left, input, leftContext, path);
  const right = runSync(node.right, input, rightContext, path);

  // unrecognized_keys reported only when BOTH sides reject the key
  const unrecKeys = new Map<string, { l?: true; r?: true }>();
  let unrecIssue: $ZodRawIssue | undefined;
  for (const iss of leftContext.issues ?? []) {
    if (iss.code === "unrecognized_keys") {
      unrecIssue ??= iss;
      for (const key of iss.keys) {
        const flags = unrecKeys.get(key) ?? {};
        flags.l = true;
        unrecKeys.set(key, flags);
      }
    } else {
      addIssue(context, iss);
    }
  }
  for (const iss of rightContext.issues ?? []) {
    if (iss.code === "unrecognized_keys") {
      for (const key of iss.keys) {
        const flags = unrecKeys.get(key) ?? {};
        flags.r = true;
        unrecKeys.set(key, flags);
      }
    } else {
      addIssue(context, iss);
    }
  }
  const bothKeys = [...unrecKeys].filter(([, flags]) => flags.l && flags.r).map(([key]) => key);
  if (bothKeys.length > 0 && unrecIssue) {
    addIssue(context, { code: "unrecognized_keys", keys: bothKeys, input, path, inst: { error: node.error } } as $ZodRawIssue);
  }
  // Aborted (non-continuable) issues stop before the merge; continuable ones let
  // the merged value propagate (the issues still fail the top-level parse).
  if (abortedSince(context, issueStart)) return FAIL;
  const merged = mergeValues(left === FAIL ? input : left, right === FAIL ? input : right);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath ?? [])}`);
  }
  return merged.data;
}

function objectResult(node: SchemaNode & { readonly kind: "object" }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  if (!isObject(input)) { issue(context, node, path, { expected: "object", code: "invalid_type" }, input); return FAIL; }
  if (context.direction === "backward" && node.checks.length > 0) {
    // Canary: the object's own checks see the ORIGINAL output-side value, and
    // the encoded result still comes from the backward shape parse.
    const canary = objectShapeResult(node, input, context, path);
    if (canary === FAIL) return FAIL;
    const checked = applyChecksSync(node, input, context, path);
    if (checked === FAIL) return FAIL;
    return checked === input ? canary : objectShapeResult(node, checked as Record<PropertyKey, unknown>, context, path);
  }
  const result = objectShapeResult(node, input, context, path);
  if (result === FAIL) { if (node.checks.length > 0) applyChecksSync(node, input, context, path); return FAIL; }
  if (context.direction === "backward") {
    return applyChecksSync(node, input, context, path) === FAIL ? FAIL : result;
  }
  return applyChecksSync(node, result, context, path);
}

function objectShapeResult(node: SchemaNode & { readonly kind: "object" }, input: Record<PropertyKey, unknown>, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  const result: Record<string, unknown> = {};
  let failed = false;
  const known: Record<string, true> = Object.create(null) as Record<string, true>;
  for (const [key, child] of Object.entries(node.shape)) {
    known[key] = true;
    const present = Object.prototype.hasOwnProperty.call(input, key);
    const optionalIn = optinOf(child) === "optional";
    const optionalOut = optoutOf(child) === "optional";
    const before = context.issues?.length ?? 0;
    const childResult = runSync(child, present ? input[key] : undefined, context, [...path, key]);
    if (childResult === FAIL) {
      // For optional-in/out schemas, ignore errors on absent keys.
      if (optionalIn && optionalOut && !present) {
        if (context.issues) context.issues.length = before;
        continue;
      }
      failed = true;
      continue;
    }
    if (!present && !optionalIn) {
      addIssue(context, { code: "invalid_type", expected: "nonoptional", input: undefined, path: [...path, key] } as $ZodRawIssue);
      failed = true;
      continue;
    }
    if (childResult === undefined) {
      if (present) result[key] = undefined;
    } else {
      Object.defineProperty(result, key, { value: childResult, enumerable: true, writable: true, configurable: true });
    }
  }
  const extra = Object.keys(input).filter((key) => !known[key] && key !== "__proto__");
  if (node.catchall) {
    for (const key of extra) {
      const childResult = runSync(node.catchall, input[key], context, [...path, key]);
      if (childResult === FAIL) failed = true;
      else Object.defineProperty(result, key, { value: childResult, enumerable: true, writable: true, configurable: true });
    }
  } else if (node.mode === "passthrough") {
    for (const key of extra) Object.defineProperty(result, key, { value: input[key], enumerable: true, writable: true, configurable: true });
  } else if (node.mode === "strict" && extra.length > 0) {
    // unrecognized_keys is recorded but the stripped value stays usable (Zod's
    // payload model): intersections merge it, the top-level parse still fails.
    issue(context, node, path, { code: "unrecognized_keys", keys: extra }, input);
  }
  if (failed) return FAIL;
  return result;
}

function optionalResult(node: SchemaNode & { readonly inner: SchemaNode }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  if (optinOf(node.inner) !== "optional") {
    if (input === undefined) return applyChecksSync(node, undefined, context, path);
    const parsed = runSync(node.inner, input, context, path);
    return parsed === FAIL ? FAIL : applyChecksSync(node, parsed, context, path);
  }
  const before = context.issues?.length ?? 0;
  const fallbacks = context.fallback ?? 0;
  const parsed = runSync(node.inner, input, context, path);
  if (input === undefined && (parsed === FAIL || (context.fallback ?? 0) > fallbacks)) {
    if (context.issues) context.issues.length = before;
    return applyChecksSync(node, undefined, context, path);
  }
  return parsed === FAIL ? FAIL : applyChecksSync(node, parsed, context, path);
}

function discunionResult(node: SchemaNode & { readonly kind: "discunion" }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  if (node.invalidOptionIndex !== undefined) throw new Error(`Invalid discriminated union option at index "${node.invalidOptionIndex}"`);
  if (!isObject(input)) { issue(context, node, path, { code: "invalid_type", expected: "object" }, input); return FAIL; }
  const option = node.map.get(input[node.key] as Primitive);
  if (option) {
    const output = runSync(option, input, context, path);
    return output === FAIL ? FAIL : applyChecksSync(node, output, context, path);
  }
  if (node.unionFallback === true || context.direction === "backward") {
    return unionResult({ ...node, kind: "union" }, input, context, path);
  }
  issue(context, node, [...path, node.key], {
    code: "invalid_union",
    errors: [],
    note: "No matching discriminator",
    discriminator: node.key,
    options: [...node.map.keys()],
  }, input);
  return FAIL;
}

function unionResult(node: SchemaNode & { readonly kind: "union" }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  if (node.inclusive === false) {
    // Exclusive union (xor): exactly one option must match.
    if (node.options.length === 1) {
      const only = node.options[0];
      if (!only) return FAIL;
      const parsed = runSync(only, input, context, path);
      return parsed === FAIL ? FAIL : applyChecksSync(node, parsed, context, path);
    }
    const successes: unknown[] = [];
    const branchErrors: $ZodRawIssue[][] = [];
    for (const option of node.options) {
      const branchContext: ValidationContext = { ...context, issues: null };
      const result = runSync(option, input, branchContext, []);
      if (result !== FAIL && !(branchContext.issues?.length)) successes.push(result);
      else branchErrors.push(branchContext.issues ?? []);
    }
    if (successes.length === 1) {
      const value = successes[0];
      return applyChecksSync(node, value, context, path);
    }
    if (successes.length === 0) {
      issue(context, node, path, { code: "invalid_union", errors: branchErrors }, input);
      return FAIL;
    }
    issue(context, node, path, { code: "invalid_union", errors: [], inclusive: false }, input);
    return FAIL;
  }
  const branchResults: { readonly value: unknown; readonly issues: $ZodRawIssue[] }[] = [];
  for (const option of node.options) {
    const branchContext: ValidationContext = { ...context, issues: null };
    const result = runSync(option, input, branchContext, []);
    const issues = branchContext.issues ?? [];
    if (result !== FAIL && issues.length === 0) { return applyChecksSync(node, result, context, path); }
    branchResults.push({ value: result === FAIL ? input : result, issues });
  }
  // A single non-aborted branch surfaces its own issues instead of invalid_union.
  const nonaborted = branchResults.filter((branch) => branch.issues.every((iss) => iss.continue === true));
  if (nonaborted.length === 1) {
    const only = nonaborted[0];
    if (only) {
      for (const iss of only.issues) addIssue(context, { ...iss, path: [...path, ...(iss.path ?? [])] });
      return FAIL;
    }
  }
  issue(context, node, path, { code: "invalid_union", errors: branchResults.map((branch) => branch.issues) }, input);
  return FAIL;
}

function hostResult(node: SchemaNode & { readonly kind: "host" }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  if (context.direction === "backward" && node.op === "transform") throw new $ZodEncodeError("ZodTransform");
  if (context.direction === "backward" && node.op === "preprocess") throw new $ZodEncodeError("ZodPreprocess");
  const base = node.inner ? runSync(node.inner, input, context, path) : input;
  if (base === FAIL) return FAIL;
  const before = context.issues?.length ?? 0;
  const refinement = makeRefinementContext(context, node, path, base);
  const result = node.fn(base, refinement);
  if (isPromise(result)) throw new $ZodAsyncError();
  if (context.issues) {
    // Direct `ctx.issues.push(...)` bypasses addIssue's path back-fill;
    // stamp pathless issues with the current path, matching Zod v4.
    for (let index = before; index < context.issues.length; index += 1) {
      const pushed: { path?: PropertyKey[] } = context.issues[index] as $ZodRawIssue;
      if (pushed.path === undefined) pushed.path = [...path];
    }
  }
  if (node.op === "refine") {
    if (!result) { issue(context, node, path, { code: "custom" }, base); return FAIL; }
    return applyChecksSync(node, base, context, path);
  }
  if (node.op === "superRefine" || node.op === "check") return (context.issues?.length ?? 0) > before ? FAIL : applyChecksSync(node, base, context, path);
  // transform / preprocess / overwrite / codec_*: a fn that reported issues fails
  if ((context.issues?.length ?? 0) > before) return FAIL;
  // $ZodTransform always marks the payload as a fallback value, which lets an
  // outer `optional` clobber it when the original input was undefined.
  if (node.op === "transform" || node.op === "preprocess" || node.op === "codec_decode" || node.op === "codec_encode") {
    context.fallback = (context.fallback ?? 0) + 1;
  }
  return applyChecksSync(node, result, context, path);
}

function pipeResult(node: SchemaNode & { readonly kind: "pipe" }, input: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  if (context.direction === "backward") {
    if (node.checks.length > 0) {
      // Zod runs a no-checks canary first; the pipe's own checks then see the
      // ORIGINAL output-side value, never the backward-transformed one.
      const canary = pipeResult({ ...node, checks: [] }, input, context, path);
      if (canary === FAIL) return FAIL;
      const checked = applyChecksSync(node, input, context, path);
      if (checked === FAIL) return FAIL;
      return checked === input ? canary : pipeResult({ ...node, checks: [] }, checked, context, path);
    }
    if (node.codec === true) {
      // Codec backward: validate against the OUTPUT side, run the encode
      // transform, then validate against the INPUT side.
      const inner = node.b;
      const outputSide = inner.kind === "pipe" ? inner.b : inner;
      const right = runSync(outputSide, input, context, path);
      if (right === FAIL) return FAIL;
      let encoded: unknown = right;
      if (node.encodeHost) {
        const before = context.issues?.length ?? 0;
        const refinement = makeRefinementContext(context, node, path, right);
        encoded = node.encodeHost(right, refinement);
        if (isPromise(encoded)) throw new $ZodAsyncError();
        if ((context.issues?.length ?? 0) > before) return FAIL;
      }
      return runSync(node.a, encoded, context, path);
    }
    const right = runSync(node.b, input, context, path);
    if (right === FAIL) return FAIL;
    return runSync(node.a, right, context, path);
  }
  const first = runSync(node.a, input, context, path);
  if (first === FAIL) return FAIL;
  const second = runSync(node.b, first, context, path);
  return second === FAIL ? FAIL : (node.checks.length === 0 ? second : applyChecksSync(node, second, context, path));
}

function runSync(node: SchemaNode, original: unknown, context: ValidationContext, path: PropertyKey[]): unknown | FailType {
  const input = coercePrimitive(node, original);
  let output: unknown;
  switch (node.kind) {
    case "any": case "unknown": output = input; break;
    case "never": issue(context, node, path, { expected: "never", code: "invalid_type" }, input); return FAIL;
    case "string": if (typeof input !== "string") { issue(context, node, path, { expected: "string", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "number": {
      if (typeof input !== "number" || Number.isNaN(input) || !Number.isFinite(input)) {
        const received = typeof input === "number" ? (Number.isNaN(input) ? "NaN" : "Infinity") : undefined;
        issue(context, node, path, { expected: "number", code: "invalid_type", ...(received ? { received } : {}) }, input);
        return FAIL;
      }
      output = input;
      break;
    }
    case "bigint": if (typeof input !== "bigint") { issue(context, node, path, { expected: "bigint", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "boolean": if (typeof input !== "boolean") { issue(context, node, path, { expected: "boolean", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "symbol": if (typeof input !== "symbol") { issue(context, node, path, { expected: "symbol", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "function": {
      if (typeof input !== "function") { issue(context, node, path, { code: "invalid_type", expected: "function" }, input); return FAIL; }
      const argsSchema = node.input;
      const returnsSchema = node.output;
      if (!argsSchema && !returnsSchema) { output = input; break; }
      const fn = input as (...args: unknown[]) => unknown;
      output = returnsSchema?.kind === "promise"
        ? async function (this: unknown, ...args: unknown[]) {
          const failingArgs: ValidationContext = { issues: null, async: true };
          const parsedArgs = argsSchema ? await runAsync(argsSchema, args, failingArgs, []) : args;
          if (parsedArgs === FAIL) throw makeCallError(failingArgs);
          const returned = await fn.apply(this, parsedArgs as unknown[]);
          if (!returnsSchema) return returned;
          const failingReturns: ValidationContext = { issues: null, async: true };
          const parsedReturn = await runAsync(returnsSchema, returned, failingReturns, []);
          if (parsedReturn === FAIL) throw makeCallError(failingReturns);
          return parsedReturn;
        }
        : function (this: unknown, ...args: unknown[]) {
          const failingArgs: ValidationContext = { issues: null, async: false };
          const parsedArgs = argsSchema ? runSync(argsSchema, args, failingArgs, []) : args;
          if (parsedArgs === FAIL) throw makeCallError(failingArgs);
          const returned = fn.apply(this, parsedArgs as unknown[]);
          if (!returnsSchema) return returned;
          const failingReturns: ValidationContext = { issues: null, async: false };
          const parsedReturn = runSync(returnsSchema, returned, failingReturns, []);
          if (parsedReturn === FAIL) throw makeCallError(failingReturns);
          return parsedReturn;
        };
      break;
    }
    case "undefined": case "void": if (input !== undefined) { issue(context, node, path, { expected: node.kind, code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "null": if (input !== null) { issue(context, node, path, { expected: "null", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "nan": if (typeof input !== "number" || !Number.isNaN(input)) { issue(context, node, path, { expected: "nan", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "date": if (!(input instanceof Date) || Number.isNaN(input.getTime())) { issue(context, node, path, { expected: "date", code: "invalid_type", ...(input instanceof Date ? { received: "Invalid Date" } : {}) }, input); return FAIL; } output = new Date(input.getTime()); break;
    case "file": if (!isObject(input) || !("name" in input) || !("size" in input) || !("type" in input)) { issue(context, node, path, { expected: "file", code: "invalid_type" }, input); return FAIL; } output = input; break;
    case "literal": if (!node.values.some((value) => Object.is(value, input))) { issue(context, node, path, { code: "invalid_value", values: [...node.values] }, input); return FAIL; } output = input; break;
    case "enum": if (!node.values.includes(input as string | number)) { issue(context, node, path, { code: "invalid_value", values: [...node.values] }, input); return FAIL; } output = input; break;
    case "object": return objectResult(node, input, context, path);
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
        if (item && optinOf(item) === "optional") optinStart = index; else break;
      }
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const item = node.items[index];
        if (item && optoutOf(item) === "optional") optoutStart = index; else break;
      }
      if (!node.rest && input.length < optinStart) { issue(context, node, path, { code: "too_small", minimum: optinStart, inclusive: true, origin: "array" }, input); return FAIL; }
      const oversized = !node.rest && input.length > node.items.length;
      if (oversized) { issue(context, node, path, { code: "too_big", maximum: node.items.length, inclusive: true, origin: "array" }, input); }
      const result: unknown[] = [];
      let failed = oversized;
      for (let index = 0; index < node.items.length; index += 1) {
        const child = node.items[index];
        if (!child) continue;
        const before = context.issues?.length ?? 0;
        const childResult = runSync(child, input[index], context, [...path, index]);
        if (childResult === FAIL) {
          // Swallow only when BOTH input & output may be absent at this tail position.
          if (index >= input.length && index >= optinStart && index >= optoutStart) { if (context.issues) context.issues.length = before; result.length = index; break; }
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
        const item = node.items[index];
        if (result[index] === undefined && item && optoutOf(item) === "optional") result.length = index; else break;
      }
      if (failed) { if (node.checks.length > 0) applyChecksSync(node, input, context, path); return FAIL; }
      output = result;
      break;
    }
    case "union": return unionResult(node, input, context, path);
    case "discunion": return discunionResult(node, input, context, path);
    case "intersection": return intersectionResult(node, input, context, path);
    case "record": {
      if (!isObject(input)) { issue(context, node, path, { expected: "record", code: "invalid_type" }, input); return FAIL; }
      const result: Record<PropertyKey, unknown> = {};
      let failed = false;
      const enumerated = node.partial ? undefined : keyValuesOf(node.key);
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
        let parsedKey = runSync(node.key, key, keyContext, path);
        // Numeric-string fallback: a numeric key that failed as a string may pass as a number.
        if (parsedKey === FAIL && typeof key === "string" && key !== "" && !Number.isNaN(Number(key))) {
          const retry: ValidationContext = { ...context, issues: null };
          const numericKey = runSync(node.key, Number(key), retry, path);
          if (numericKey !== FAIL) { parsedKey = numericKey; keyContext.issues = retry.issues; }
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
    case "optional": return optionalResult(node, input, context, path);
    case "exactOptional": {
      const parsedExact = runSync(node.inner, input, context, path);
      return parsedExact === FAIL ? FAIL : applyChecksSync(node, parsedExact, context, path);
    }
    case "nullable": if (input === null) return null; { const parsedNul = runSync(node.inner, input, context, path); return parsedNul === FAIL ? FAIL : applyChecksSync(node, parsedNul, context, path); }
    case "nonoptional": {
      const parsedNon = runSync(node.inner, input, context, path);
      if (parsedNon === FAIL) return FAIL;
      if (parsedNon === undefined) { issue(context, node, path, { code: "invalid_type", expected: "nonoptional" }, input); return FAIL; }
      return applyChecksSync(node, parsedNon, context, path);
    }
    case "readonly": { const parsed = runSync(node.inner, input, context, path); if (parsed === FAIL) return FAIL; if (typeof parsed === "object" && parsed !== null) Object.freeze(parsed); return parsed; }
    case "lazy": return runSync(node.getter(), input, context, path);
    case "promise": throw new $ZodAsyncError();
    case "default": {
      if (context.direction === "backward") return runSync(node.inner, input, context, path);
      const fallbackValue = (): unknown => node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : shallowClone(node.value);
      if (input === undefined) return applyChecksSync(node, fallbackValue(), context, path);
      const result = runSync(node.inner, input, context, path);
      if (result === FAIL) return FAIL;
      return applyChecksSync(node, result === undefined ? fallbackValue() : result, context, path);
    }
    case "prefault": {
      if (context.direction === "backward") return runSync(node.inner, input, context, path);
      const value = input === undefined ? node.dynamic ? (node.value as (context?: { input: unknown }) => unknown)({ input }) : shallowClone(node.value) : input;
      const parsed = runSync(node.inner, value, context, path);
      return parsed === FAIL ? FAIL : applyChecksSync(node, parsed, context, path);
    }
    case "catch": {
      if (context.direction === "backward") return runSync(node.inner, input, context, path);
      const local: ValidationContext = { ...context, issues: null };
      const parsed = runSync(node.inner, input, local, path);
      if (parsed !== FAIL && !(local.issues?.length)) return applyChecksSync(node, parsed, context, path);
      context.fallback = (context.fallback ?? 0) + 1;
      const caught = node.dynamic ? (node.value as (context?: { error?: unknown; input: unknown }) => unknown)({ error: { issues: local.issues ?? [] }, input }) : node.value;
      return applyChecksSync(node, caught, context, path);
    }
    case "pipe": return pipeResult(node, input, context, path);
    case "templateLiteral": if (typeof input !== "string" || !node.pattern.test(input)) { issue(context, node, path, { code: "invalid_format", format: "template_literal", pattern: node.pattern.source }, input); return FAIL; } output = input; break;
    case "host": return hostResult(node, input, context, path);
  }
  return applyChecksSync(node, context.direction === "backward" ? input : output, context, path);
}

function makeCallError(context: ValidationContext): Error {
  return new ZodError((context.issues ?? []).map((raw) => finalizeNested(raw, undefined)) as never);
}

async function applyChecksAsync(node: SchemaNode, initial: unknown, context: ValidationContext, path: PropertyKey[]): Promise<unknown | FailType> {
  let value = initial;
  const synchronous: RuntimeCheck[] = [];
  for (const runtime of node.checks) {
    if (runtime.check.c !== "host_runtime") { synchronous.push(runtime); continue; }
    if (runtime.when) {
      const shouldRun = runtime.when({ value, issues: context.issues ?? [] });
      if (!shouldRun) continue;
    }
    const check: HostRuntimeCheck = runtime.check;
    const before = context.issues?.length ?? 0;
    const result = await check.fn(value, makeRefinementContext(context, node, path, value));
    if (context.issues) {
      // Direct `ctx.issues.push(...)` bypasses addIssue's path back-fill;
      // stamp pathless issues with the current path, matching Zod v4.
      for (let index = before; index < context.issues.length; index += 1) {
        const pushed: { path?: PropertyKey[] } = context.issues[index] as $ZodRawIssue;
        if (pushed.path === undefined) pushed.path = [...path];
      }
    }
    if (check.op === "refine" && !result) {
      const issuePath = runtime.path ? [...path, ...runtime.path] : path;
      addIssue(context, { code: "custom", input: value, inst: { error: runtime.error }, path: issuePath, continue: runtime.abort !== true, ...(runtime.params ? { params: runtime.params } : {}) } as $ZodRawIssue);
    }
    else if (check.op === "custom_format" && !result) {
      addIssue(context, { code: "invalid_format", format: check.format ?? "unknown", input: value, inst: { error: runtime.error }, path, continue: runtime.abort !== true } as $ZodRawIssue);
    }
    else if (check.op === "overwrite" || check.op === "transform" || check.op === "preprocess") value = result;
    if ((context.issues?.length ?? 0) > before && abortedSince(context, before)) break;
  }
  if (synchronous.length === 0) return context.issues ? FAIL : value;
  const syncNode = { ...node, checks: synchronous } as SchemaNode;
  return applyChecksSync(syncNode, value, context, path);
}

async function runAsync(node: SchemaNode, input: unknown, context: ValidationContext, path: PropertyKey[]): Promise<unknown | FailType> {
  if (node.kind === "host") {
    if (context.direction === "backward" && node.op === "transform") throw new $ZodEncodeError("ZodTransform");
    if (context.direction === "backward" && node.op === "preprocess") throw new $ZodEncodeError("ZodPreprocess");
    const base = node.inner ? await runAsync(node.inner, input, context, path) : input;
    if (base === FAIL) return FAIL;
    const before = context.issues?.length ?? 0;
    const result = await node.fn(base, makeRefinementContext(context, node, path, base));
    if (context.issues) {
      for (let index = before; index < context.issues.length; index += 1) {
        const pushed: { path?: PropertyKey[] } = context.issues[index] as $ZodRawIssue;
        if (pushed.path === undefined) pushed.path = [...path];
      }
    }
    if (node.op === "refine") {
      if (!result) { issue(context, node, path, { code: "custom" }, base); return FAIL; }
      return base;
    }
    if (node.op === "superRefine" || node.op === "check") return (context.issues?.length ?? 0) > before ? FAIL : base;
    if ((context.issues?.length ?? 0) > before) return FAIL;
    if (node.op === "transform" || node.op === "preprocess" || node.op === "codec_decode" || node.op === "codec_encode") {
      context.fallback = (context.fallback ?? 0) + 1;
    }
    return result;
  }
  if (node.kind === "pipe") {
    if (context.direction === "backward") {
      if (node.checks.length > 0) {
        // Canary: the pipe's own checks see the ORIGINAL output-side value.
        const canary = await runAsync({ ...node, checks: [] }, input, context, path);
        if (canary === FAIL) return FAIL;
        const checked = await applyChecksAsync(node, input, context, path);
        if (checked === FAIL) return FAIL;
        return checked === input ? canary : runAsync({ ...node, checks: [] }, checked, context, path);
      }
      if (node.codec === true) {
        const inner = node.b;
        const outputSide = inner.kind === "pipe" ? inner.b : inner;
        const right = await runAsync(outputSide, input, context, path);
        if (right === FAIL) return FAIL;
        let encoded: unknown = right;
        if (node.encodeHost) {
          const before = context.issues?.length ?? 0;
          encoded = await node.encodeHost(right, makeRefinementContext(context, node, path, right));
          if ((context.issues?.length ?? 0) > before) return FAIL;
        }
        return runAsync(node.a, encoded, context, path);
      }
      const right = await runAsync(node.b, input, context, path);
      if (right === FAIL) return FAIL;
      return runAsync(node.a, right, context, path);
    }
    const first = await runAsync(node.a, input, context, path);
    return first === FAIL ? FAIL : runAsync(node.b, first, context, path);
  }
  if (node.kind === "intersection") {
    const issueStart = context.issues?.length ?? 0;
    const leftContext: ValidationContext = { ...context, issues: null };
    const rightContext: ValidationContext = { ...context, issues: null };
    const [left, right] = await Promise.all([
      runAsync(node.left, input, leftContext, path),
      runAsync(node.right, input, rightContext, path),
    ]);
    const unrecKeys = new Map<PropertyKey, { l?: true; r?: true }>();
    let unrecIssue: $ZodRawIssue | undefined;
    for (const iss of leftContext.issues ?? []) {
      if (iss.code === "unrecognized_keys") {
        unrecIssue ??= iss;
        for (const key of iss.keys) { const flags = unrecKeys.get(key) ?? {}; flags.l = true; unrecKeys.set(key, flags); }
      } else addIssue(context, iss);
    }
    for (const iss of rightContext.issues ?? []) {
      if (iss.code === "unrecognized_keys") {
        for (const key of iss.keys) { const flags = unrecKeys.get(key) ?? {}; flags.r = true; unrecKeys.set(key, flags); }
      } else addIssue(context, iss);
    }
    const bothKeys = [...unrecKeys].filter(([, flags]) => flags.l && flags.r).map(([key]) => key);
    if (bothKeys.length > 0 && unrecIssue) addIssue(context, { code: "unrecognized_keys", keys: bothKeys, input, path, inst: { error: node.error } } as $ZodRawIssue);
    if (abortedSince(context, issueStart)) return FAIL;
    const merged = mergeValues(left === FAIL ? input : left, right === FAIL ? input : right);
    if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath ?? [])}`);
    return merged.data;
  }
  if (node.kind === "discunion" && isObject(input)) {
    if (node.invalidOptionIndex !== undefined) throw new Error(`Invalid discriminated union option at index "${node.invalidOptionIndex}"`);
    const option = node.map.get(input[node.key] as Primitive);
    if (option) return runAsync(option, input, context, path);
    if (node.unionFallback === true || context.direction === "backward") {
      return runAsync({ ...node, kind: "union" }, input, context, path);
    }
    issue(context, node, [...path, node.key], {
      code: "invalid_union", errors: [], note: "No matching discriminator",
      discriminator: node.key, options: [...node.map.keys()],
    }, input);
    return FAIL;
  }
  if (node.kind === "object" && isObject(input)) {
    if (context.direction === "backward" && node.checks.length > 0) {
      // Canary: the object's own checks see the ORIGINAL output-side value.
      const canary = await runAsync({ ...node, checks: [] }, input, context, path);
      if (canary === FAIL) return FAIL;
      const checked = await applyChecksAsync(node, input, context, path);
      if (checked === FAIL) return FAIL;
      return checked === input ? canary : runAsync({ ...node, checks: [] }, checked, context, path);
    }
    const result: Record<string, unknown> = {}; let failed = false; const known: Record<string, true> = Object.create(null) as Record<string, true>;
    for (const [key, child] of Object.entries(node.shape)) {
      known[key] = true;
      const present = Object.prototype.hasOwnProperty.call(input, key);
      const optionalIn = optinOf(child) === "optional";
      const optionalOut = optoutOf(child) === "optional";
      const before = context.issues?.length ?? 0;
      const parsed = await runAsync(child, present ? input[key] : undefined, context, [...path, key]);
      if (parsed === FAIL) {
        if (optionalIn && optionalOut && !present) { if (context.issues) context.issues.length = before; continue; }
        failed = true;
        continue;
      }
      if (!present && !optionalIn) {
        addIssue(context, { code: "invalid_type", expected: "nonoptional", input: undefined, path: [...path, key] } as $ZodRawIssue);
        failed = true;
        continue;
      }
      if (parsed === undefined) { if (present) result[key] = undefined; }
      else result[key] = parsed;
    }
    const extraKeys = Object.keys(input).filter((entry) => !known[entry] && entry !== "__proto__");
    for (const key of extraKeys) {
      if (node.catchall) { const parsed = await runAsync(node.catchall, input[key], context, [...path, key]); if (parsed === FAIL) failed = true; else result[key] = parsed; }
      else if (node.mode === "passthrough") result[key] = input[key];
      else if (node.mode === "strict") { issue(context, node, path, { code: "unrecognized_keys", keys: extraKeys }, input); break; }
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
      if (item && optinOf(item) === "optional") optinStart = index; else break;
    }
    for (let index = node.items.length - 1; index >= 0; index -= 1) {
      const item = node.items[index];
      if (item && optoutOf(item) === "optional") optoutStart = index; else break;
    }
    if (!node.rest && input.length < optinStart) { issue(context, node, path, { code: "too_small", minimum: optinStart, inclusive: true, origin: "array" }, input); return FAIL; }
    const oversized = !node.rest && input.length > node.items.length;
    if (oversized) { issue(context, node, path, { code: "too_big", maximum: node.items.length, inclusive: true, origin: "array" }, input); }
    const result: unknown[] = [];
    let failed = oversized;
    for (let index = 0; index < node.items.length; index += 1) {
      const child = node.items[index];
      if (!child) continue;
      const before = context.issues?.length ?? 0;
      const parsed = await runAsync(child, input[index], context, [...path, index]);
      if (parsed === FAIL) {
        if (index >= input.length && index >= optinStart && index >= optoutStart) { if (context.issues) context.issues.length = before; result.length = index; break; }
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
      const item = node.items[index];
      if (result[index] === undefined && item && optoutOf(item) === "optional") result.length = index; else break;
    }
    if (failed) { if (node.checks.length > 0) await applyChecksAsync(node, input, context, path); return FAIL; }
    return applyChecksAsync(node, result, context, path);
  }
  if (node.kind === "union") {
    if (node.inclusive === false) {
      if (node.options.length === 1) {
        const only = node.options[0];
        if (!only) return FAIL;
        return runAsync(only, input, context, path);
      }
      const results = await Promise.all(node.options.map((option) => {
        const branch: ValidationContext = { ...context, issues: null };
        return runAsync(option, input, branch, []).then((parsed) => ({ parsed, issues: branch.issues ?? [] }));
      }));
      const successes = results.filter((entry) => entry.parsed !== FAIL && entry.issues.length === 0);
      if (successes.length === 1) return successes[0]?.parsed;
      if (successes.length === 0) {
        issue(context, node, path, { code: "invalid_union", errors: results.map((entry) => entry.issues) }, input);
        return FAIL;
      }
      issue(context, node, path, { code: "invalid_union", errors: [], inclusive: false }, input);
      return FAIL;
    }
    const branchResults: { readonly value: unknown; readonly issues: $ZodRawIssue[] }[] = [];
    for (const option of node.options) {
      const branch: ValidationContext = { ...context, issues: null };
      const parsed = await runAsync(option, input, branch, []);
      const issues = branch.issues ?? [];
      if (parsed !== FAIL && issues.length === 0) return applyChecksAsync(node, parsed, context, path);
      branchResults.push({ value: parsed === FAIL ? input : parsed, issues });
    }
    const nonaborted = branchResults.filter((branch) => branch.issues.every((iss) => iss.continue === true));
    if (nonaborted.length === 1) {
      const only = nonaborted[0];
      if (only) {
        for (const iss of only.issues) addIssue(context, { ...iss, path: [...path, ...(iss.path ?? [])] });
        return FAIL;
      }
    }
    issue(context, node, path, { code: "invalid_union", errors: branchResults.map((branch) => branch.issues) }, input); return FAIL;
  }
  if (node.kind === "optional") {
    if (optinOf(node.inner) !== "optional") {
      if (input === undefined) return applyChecksAsync(node, undefined, context, path);
      const parsedInner = await runAsync(node.inner, input, context, path);
      return parsedInner === FAIL ? FAIL : applyChecksAsync(node, parsedInner, context, path);
    }
    const before = context.issues?.length ?? 0;
    const fallbacks = context.fallback ?? 0;
    const parsedInner = await runAsync(node.inner, input, context, path);
    if (input === undefined && (parsedInner === FAIL || (context.fallback ?? 0) > fallbacks)) {
      if (context.issues) context.issues.length = before;
      return applyChecksAsync(node, undefined, context, path);
    }
    return parsedInner === FAIL ? FAIL : applyChecksAsync(node, parsedInner, context, path);
  }
  if (node.kind === "exactOptional") { const parsedExact = await runAsync(node.inner, input, context, path); return parsedExact === FAIL ? FAIL : applyChecksAsync(node, parsedExact, context, path); }
  if (node.kind === "nullable") { if (input === null) return applyChecksAsync(node, null, context, path); const parsedNul = await runAsync(node.inner, input, context, path); return parsedNul === FAIL ? FAIL : applyChecksAsync(node, parsedNul, context, path); }
  if (node.kind === "nonoptional") {
    const parsedNon = await runAsync(node.inner, input, context, path);
    if (parsedNon === FAIL) return FAIL;
    if (parsedNon === undefined) { issue(context, node, path, { code: "invalid_type", expected: "nonoptional" }, input); return FAIL; }
    return applyChecksAsync(node, parsedNon, context, path);
  }
  if (node.kind === "readonly") { const parsed = await runAsync(node.inner, input, context, path); if (parsed !== FAIL && typeof parsed === "object" && parsed !== null) Object.freeze(parsed); return parsed; }
  if (node.kind === "lazy") return runAsync(node.getter(), input, context, path);
  if (node.kind === "promise") return runAsync(node.inner, await Promise.resolve(input), context, path);
  if (node.kind === "default") {
    if (context.direction === "backward") return runAsync(node.inner, input, context, path);
    const fallbackValue = (): unknown => node.dynamic ? (node.value as (context?: { input: unknown }) => MaybeAsync<unknown>)({ input }) : shallowClone(node.value);
    if (input === undefined) return applyChecksAsync(node, await fallbackValue(), context, path);
    const result = await runAsync(node.inner, input, context, path);
    if (result === FAIL) return FAIL;
    return applyChecksAsync(node, result === undefined ? await fallbackValue() : result, context, path);
  }
  if (node.kind === "prefault") {
    if (context.direction === "backward") return runAsync(node.inner, input, context, path);
    const value = input === undefined ? node.dynamic ? await (node.value as (context?: { input: unknown }) => MaybeAsync<unknown>)({ input }) : shallowClone(node.value) : input;
    const parsed = await runAsync(node.inner, value, context, path);
    return parsed === FAIL ? FAIL : applyChecksAsync(node, parsed, context, path);
  }
  if (node.kind === "catch") {
    if (context.direction === "backward") return runAsync(node.inner, input, context, path);
    const local: ValidationContext = { ...context, issues: null };
    const parsed = await runAsync(node.inner, input, local, path);
    if (parsed !== FAIL && !(local.issues?.length)) return applyChecksAsync(node, parsed, context, path);
    context.fallback = (context.fallback ?? 0) + 1;
    const caught = node.dynamic ? await (node.value as (context?: { error?: unknown; input: unknown }) => MaybeAsync<unknown>)({ error: { issues: local.issues ?? [] }, input }) : node.value;
    return applyChecksAsync(node, caught, context, path);
  }
  if (node.kind === "record" && isObject(input)) {
    const result: Record<PropertyKey, unknown> = {}; let failed = false;
    const enumerated = node.partial ? undefined : keyValuesOf(node.key);
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
      let parsedKey = await runAsync(node.key, key, keyContext, path);
      if (parsedKey === FAIL && typeof key === "string" && key !== "" && !Number.isNaN(Number(key))) {
        const retry: ValidationContext = { ...context, issues: null };
        const numeric = await runAsync(node.key, Number(key), retry, path);
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

/** Mirrors `_zod.values`: the finite key set for enum/literal/union-of-those, else undefined. */
function keyValuesOf(node: SchemaNode): (string | number)[] | undefined {
  switch (node.kind) {
    case "enum":
      return [...node.values];
    case "literal":
      return node.values.filter((value): value is string | number => typeof value === "string" || typeof value === "number");
    case "pipe":
      return keyValuesOf(node.a);
    case "union": {
      const all: (string | number)[] = [];
      for (const option of node.options) {
        const values = keyValuesOf(option);
        if (!values) return undefined;
        all.push(...values);
      }
      return all;
    }
    default:
      return undefined;
  }
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
