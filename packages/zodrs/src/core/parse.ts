import { finalizeNested, ZodError } from "./errors.js";
import type { $ZodRawIssue, ParseContext } from "./errors.js";
import type { AsyncValidator, ValidationContext, Validator } from "./interpreter.js";
import { $ZodAsyncError, isPromise } from "./interpreter.js";
import { validateJson as validateNativeJson } from "./native.js";
import type { NativePlanRef } from "./native.js";
import type { CompiledPlan } from "./plan.js";
import { isProtoPolluted } from "./plan.js";
import { FAIL } from "./util.js";

export interface RuntimeSchema<Output = unknown, Input = unknown> {
  readonly _zod: {
    readonly output: Output;
    readonly input: Input;
    readonly validate: Validator;
    readonly validateAsync: AsyncValidator;
    readonly plan: CompiledPlan;
    nativePlan: NativePlanRef | null;
    /** Finite accepted value set (enum/literal/derived), else undefined. */
    readonly values?: ReadonlySet<unknown> | undefined;
    /** Per-property accepted value sets, else undefined. */
    readonly propValues?: Readonly<Record<string, ReadonlySet<unknown>>> | undefined;
    /** "optional" when the input may be absent. */
    readonly optin?: "optional" | undefined;
    /** "optional" when the output may be absent. */
    readonly optout?: "optional" | undefined;
    /** Implied validation pattern, else undefined. */
    readonly pattern?: RegExp | undefined;
    /** Resolved inner schema for wrappers/lazy, else undefined. */
    readonly innerType?: RuntimeSchema | undefined;
  };
}

export type output<T extends RuntimeSchema> = T["_zod"]["output"];
export type input<T extends RuntimeSchema> = T["_zod"]["input"];
export type infer<T extends RuntimeSchema> = output<T>;

export interface SafeParseSuccess<T> { readonly success: true; readonly data: T; readonly error?: never }
export interface SafeParseError<T> { readonly success: false; readonly error: ZodError<T>; readonly data?: never }
export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError<T>;

function makeError<T>(raw: $ZodRawIssue[] | null, context: ParseContext | undefined): ZodError<T> {
  return new ZodError<T>((raw ?? []).map((issue) => finalizeNested(issue, context)));
}

/** True when the context carries any non-continuable (fatal) issue.
 *  The strict-object path records `unrecognized_keys` without returning FAIL so
 *  intersections can merge the stripped value; this guard makes the top-level
 *  parse fail on those issues while continuable refinements still pass through. */
function hasFatalIssue(issues: $ZodRawIssue[] | null): boolean {
  if (!issues) return false;
  for (let i = 0; i < issues.length; i += 1) {
    if (issues[i]?.continue !== true) return true;
  }
  return false;
}


/**
 * Reusable validation contexts for the hot path: forward, sync, and no caller
 * context (the overwhelmingly common parse shape). A host refine that parses
 * nested data simply draws another slot; anything unusual allocates fresh.
 */
const CTX_POOL_MAX = 8;
const CTX_POOL: ValidationContext[] = [];

function validationContext(context: ParseContext | undefined, async: boolean, direction: "forward" | "backward" = "forward"): ValidationContext {
  if (context === undefined && !async && direction === "forward") {
    const pooled = CTX_POOL.pop();
    if (pooled) return pooled;
    return { issues: null, async, direction, poolable: true };
  }
  return { ...context, issues: null, async, direction };
}

function releaseContext(ctx: ValidationContext): void {
  if (ctx.poolable !== true || ctx.exposed === true || CTX_POOL.length >= CTX_POOL_MAX) return;
  ctx.issues = null;
  ctx.fallback = 0;
  // Clear the exposure flag before pooling so a reused slot starts clean.
  ctx.exposed = undefined;
  CTX_POOL.push(ctx);
}

export function parse<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): output<T> {
  // Fast path: no caller context, sync, forward — the overwhelmingly common shape.
  // Inlined here to avoid the validationContext/releaseContext/isPromise call chain
  // that added ~20ns per parse on primitive schemas (where validate itself is ~10ns).
  if (context === undefined) {
    let ctx = CTX_POOL.pop();
    if (!ctx) ctx = { issues: null, async: false, direction: "forward", poolable: true };
    let result: unknown;
    let issues: $ZodRawIssue[] | null = null;
    try {
      result = schema._zod.validate(value, ctx);
      issues = ctx.issues;
    } finally {
      if (ctx.poolable === true && ctx.exposed !== true && CTX_POOL.length < CTX_POOL_MAX) {
        ctx.issues = null;
        ctx.fallback = 0;
        ctx.exposed = undefined;
        CTX_POOL.push(ctx);
      }
    }
    if (typeof result === "object" && result !== null && "then" in result) throw new $ZodAsyncError();
    if (result === FAIL || hasFatalIssue(issues)) throw makeError<output<T>>(issues, context);
    return result as output<T>;
  }
  // Slow path: caller context present.
  const ctx = validationContext(context, false);
  let issues: $ZodRawIssue[] | null;
  let result: unknown;
  try {
    result = schema._zod.validate(value, ctx);
    if (isPromise(result)) throw new $ZodAsyncError();
    issues = ctx.issues;
  } finally {
    releaseContext(ctx);
  }
  if (result === FAIL || hasFatalIssue(issues)) throw makeError<output<T>>(issues, context);
  return result as output<T>;
}

export function safeParse<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): SafeParseResult<output<T>> {
  if (context === undefined) {
    let ctx = CTX_POOL.pop();
    if (!ctx) ctx = { issues: null, async: false, direction: "forward", poolable: true };
    let result: unknown;
    let issues: $ZodRawIssue[] | null = null;
    try {
      result = schema._zod.validate(value, ctx);
      issues = ctx.issues;
    } finally {
      if (ctx.poolable === true && ctx.exposed !== true && CTX_POOL.length < CTX_POOL_MAX) {
        ctx.issues = null;
        ctx.fallback = 0;
        ctx.exposed = undefined;
        CTX_POOL.push(ctx);
      }
    }
    if (typeof result === "object" && result !== null && "then" in result) throw new $ZodAsyncError();
    return result === FAIL || hasFatalIssue(issues)
      ? { success: false, error: makeError<output<T>>(issues, context) }
      : { success: true, data: result as output<T> };
  }
  const ctx = validationContext(context, false);
  let issues: $ZodRawIssue[] | null;
  let result: unknown;
  try {
    result = schema._zod.validate(value, ctx);
    if (isPromise(result)) throw new $ZodAsyncError();
    issues = ctx.issues;
  } finally {
    releaseContext(ctx);
  }
  return result === FAIL || hasFatalIssue(issues)
    ? { success: false, error: makeError<output<T>>(issues, context) }
    : { success: true, data: result as output<T> };
}

export async function parseAsync<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): Promise<output<T>> {
  const ctx = validationContext(context, true);
  const result = await schema._zod.validateAsync(value, ctx);
  if (result === FAIL || hasFatalIssue(ctx.issues)) throw makeError<output<T>>(ctx.issues, context);
  return result as output<T>;
}

export async function safeParseAsync<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): Promise<SafeParseResult<output<T>>> {
  const ctx = validationContext(context, true);
  const result = await schema._zod.validateAsync(value, ctx);
  return result === FAIL || hasFatalIssue(ctx.issues)
    ? { success: false, error: makeError<output<T>>(ctx.issues, context) }
    : { success: true, data: result as output<T> };
}

export function decode<T extends RuntimeSchema>(schema: T, value: input<T>, context?: ParseContext): output<T> {
  return parse(schema, value, context);
}
export function safeDecode<T extends RuntimeSchema>(schema: T, value: input<T>, context?: ParseContext): SafeParseResult<output<T>> {
  return safeParse(schema, value, context);
}
export function decodeAsync<T extends RuntimeSchema>(schema: T, value: input<T>, context?: ParseContext): Promise<output<T>> {
  return parseAsync(schema, value, context);
}
export function safeDecodeAsync<T extends RuntimeSchema>(schema: T, value: input<T>, context?: ParseContext): Promise<SafeParseResult<output<T>>> {
  return safeParseAsync(schema, value, context);
}
export function encode<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): input<T> {
  const ctx = validationContext(context, false, "backward");
  const result = schema._zod.validate(value, ctx);
  if (isPromise(result)) throw new $ZodAsyncError();
  if (result === FAIL || hasFatalIssue(ctx.issues)) throw makeError<input<T>>(ctx.issues, context);
  return result as input<T>;
}
export function safeEncode<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): SafeParseResult<input<T>> {
  const ctx = validationContext(context, false, "backward");
  const result = schema._zod.validate(value, ctx);
  if (isPromise(result)) throw new $ZodAsyncError();
  return result === FAIL || hasFatalIssue(ctx.issues)
    ? { success: false, error: makeError<input<T>>(ctx.issues, context) }
    : { success: true, data: result as input<T> };
}
export async function encodeAsync<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): Promise<input<T>> {
  const ctx = validationContext(context, true, "backward");
  const result = await schema._zod.validateAsync(value, ctx);
  if (result === FAIL || hasFatalIssue(ctx.issues)) throw makeError<input<T>>(ctx.issues, context);
  return result as input<T>;
}
export async function safeEncodeAsync<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): Promise<SafeParseResult<input<T>>> {
  const ctx = validationContext(context, true, "backward");
  const result = await schema._zod.validateAsync(value, ctx);
  return result === FAIL || hasFatalIssue(ctx.issues)
    ? { success: false, error: makeError<input<T>>(ctx.issues, context) }
    : { success: true, data: result as input<T> };
}

declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(input?: ArrayBufferView | ArrayBuffer): string } };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function jsonBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof value === "string") return textEncoder.encode(value);
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function jsonText(value: Uint8Array | ArrayBuffer | string): string {
  return typeof value === "string" ? value : textDecoder.decode(value);
}


function parseRawIssues(payload: string): $ZodRawIssue[] {
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed)) throw new TypeError("Native validator returned a non-array issue payload");
  return parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("code" in entry) || typeof entry.code !== "string") {
      throw new TypeError("Native validator returned an invalid issue payload");
    }
    return entry as $ZodRawIssue;
  });
}

function inputAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined || (typeof current !== "object" && typeof current !== "function")) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment as keyof typeof current];
  }
  return current;
}

/** Back-fill `input` on an issue and, recursively, on any nested sub-issues.
 *  Sub-issues inside `errors`/`issues` carry paths relative to their parent,
 *  so the parent's path is prepended when walking `original`. */
function backFillInput(
  raw: $ZodRawIssue,
  original: unknown,
  parentPath: readonly PropertyKey[] = [],
): $ZodRawIssue {
  const fullPath = [...parentPath, ...(raw.path ?? [])];
  const coercedInput = raw.received === "NaN"
    ? Number.NaN
    : raw.received === "Infinity"
      ? Number.POSITIVE_INFINITY
      : inputAtPath(original, fullPath);
  const withInput = { ...raw, input: coercedInput } as $ZodRawIssue;
  if (Array.isArray(withInput.errors)) {
    const errors = withInput.errors.map((branch: unknown) => Array.isArray(branch)
      ? branch.map((entry: unknown) => backFillInput(entry as $ZodRawIssue, original, fullPath))
      : branch);
    return { ...withInput, errors } as $ZodRawIssue;
  }
  if (Array.isArray(withInput.issues)) {
    const issues = withInput.issues.map((entry: unknown) => backFillInput(entry as $ZodRawIssue, original, fullPath));
    return { ...withInput, issues } as $ZodRawIssue;
  }
  return withInput;
}

export function parseJson<T extends RuntimeSchema>(schema: T, value: Uint8Array | ArrayBuffer | string, context?: ParseContext): output<T> {
  const plan = schema._zod.plan;
  if (!plan.jsonEligible || isProtoPolluted(plan)) return parse(schema, JSON.parse(jsonText(value)), context);

  const native = validateNativeJson(plan.json, schema._zod.nativePlan, jsonBytes(value));
  schema._zod.nativePlan = native.plan;
  if (!native.available || !native.verdict) return parse(schema, JSON.parse(jsonText(value)), context);

  switch (native.verdict.status) {
    case 0: return JSON.parse(jsonText(value)) as output<T>;
    case 1:
      if (native.verdict.payload === null) throw new Error("Native validator omitted rewritten payload");
      return JSON.parse(native.verdict.payload) as output<T>;
    case 2: {
      if (native.verdict.payload === null) throw new Error("Native validator omitted issue payload");
      let raw = parseRawIssues(native.verdict.payload);
      // Message resolution needs `input` ("received X"); finalizeIssue strips
      // it from delivered issues unless reportInput is set. Back-fill always.
      const original: unknown = JSON.parse(jsonText(value));
      raw = raw.map((entry) => backFillInput(entry, original));
      throw makeError<output<T>>(raw, context);
    }
    case 3:
      // The native parser rejected syntax that JSON.parse handles differently.
      return parse(schema, JSON.parse(jsonText(value)), context);
    default:
      throw new Error(`Native validator returned unknown status ${native.verdict.status}`);
  }
}

export function safeParseJson<T extends RuntimeSchema>(schema: T, value: Uint8Array | ArrayBuffer | string, context?: ParseContext): SafeParseResult<output<T>> {
  try {
    return { success: true, data: parseJson(schema, value, context) };
  } catch (error: unknown) {
    if (error instanceof ZodError) return { success: false, error: error as ZodError<output<T>> };
    throw error;
  }
}
