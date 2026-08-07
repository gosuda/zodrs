import { config } from "./config.js";
import { finalizeIssue, finalizeNested, ZodError } from "./errors.js";
import type { $ZodIssue, $ZodRawIssue, ParseContext } from "./errors.js";
import type { AsyncValidator, ValidationContext, Validator } from "./interpreter.js";
import { $ZodAsyncError, isPromise } from "./interpreter.js";
import { validateJson as validateNativeJson } from "./native.js";
import type { CompiledPlan } from "./plan.js";
import { FAIL } from "./util.js";

export interface RuntimeSchema<Output = unknown, Input = unknown> {
  readonly _zod: {
    readonly output: Output;
    readonly input: Input;
    readonly validate: Validator;
    readonly validateAsync: AsyncValidator;
    readonly plan: CompiledPlan;
    nativeHandle: number | null;
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


function validationContext(context: ParseContext | undefined, async: boolean, direction: "forward" | "backward" = "forward"): ValidationContext {
  return { ...context, issues: null, async, direction };
}

export function parse<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): output<T> {
  const ctx = validationContext(context, false);
  const result = schema._zod.validate(value, ctx);
  if (isPromise(result)) throw new $ZodAsyncError();
  if (result === FAIL || hasFatalIssue(ctx.issues)) throw makeError<output<T>>(ctx.issues, context);
  return result as output<T>;
}

export function safeParse<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): SafeParseResult<output<T>> {
  const ctx = validationContext(context, false);
  const result = schema._zod.validate(value, ctx);
  if (isPromise(result)) throw new $ZodAsyncError();
  return result === FAIL || hasFatalIssue(ctx.issues)
    ? { success: false, error: makeError<output<T>>(ctx.issues, context) }
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

function bytesAndText(value: Uint8Array | ArrayBuffer | string): { readonly bytes: Uint8Array; readonly text: string } {
  if (typeof value === "string") return { bytes: textEncoder.encode(value), text: value };
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return { bytes, text: textDecoder.decode(bytes) };
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
  const withInput = { ...raw, input: inputAtPath(original, fullPath) } as $ZodRawIssue;
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
  const source = bytesAndText(value);
  const plan = schema._zod.plan;
  if (!plan.jsonEligible) return parse(schema, JSON.parse(source.text), context);
  const native = validateNativeJson(plan.json, schema._zod.nativeHandle, source.bytes);
  if (!native.available || !native.verdict) return parse(schema, JSON.parse(source.text), context);
  schema._zod.nativeHandle = native.handle;
  switch (native.verdict.status) {
    case 0: return JSON.parse(source.text) as output<T>;
    case 1:
      if (native.verdict.payload === null) throw new Error("Native validator omitted rewritten payload");
      return JSON.parse(native.verdict.payload) as output<T>;
    case 2: {
      if (native.verdict.payload === null) throw new Error("Native validator omitted issue payload");
      let raw = parseRawIssues(native.verdict.payload);
      // Message resolution needs `input` ("received X"); finalizeIssue strips
      // it from delivered issues unless reportInput is set. Back-fill always.
      const original: unknown = JSON.parse(source.text);
      raw = raw.map((entry) => backFillInput(entry, original));
      throw makeError<output<T>>(raw, context);
    }
    case 3:
      // Status 3: the native parser rejected input that JS handles differently
      // (BOM, lone-surrogate escapes, 1e400→Infinity, NaN/Infinity literals, truncated
      // JSON). Fall back to JSON.parse + the TS validator — identical observable result.
      // JSON.parse throwing SyntaxError propagates as-is.
      return parse(schema, JSON.parse(source.text), context);
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
