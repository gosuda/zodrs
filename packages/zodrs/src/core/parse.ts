import { config } from "./config.js";
import { finalizeIssue, ZodError } from "./errors.js";
import type { $ZodIssue, $ZodRawIssue, ParseContext } from "./errors.js";
import type { AsyncValidator, ValidationContext, Validator } from "./interpreter.js";
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
  };
}

export type output<T extends RuntimeSchema> = T["_zod"]["output"];
export type input<T extends RuntimeSchema> = T["_zod"]["input"];
export type infer<T extends RuntimeSchema> = output<T>;

export interface SafeParseSuccess<T> { readonly success: true; readonly data: T; readonly error?: never }
export interface SafeParseError<T> { readonly success: false; readonly error: ZodError<T>; readonly data?: never }
export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError<T>;

function finalizeNested(raw: $ZodRawIssue, context: ParseContext | undefined): $ZodIssue {
  const global = config();
  if (raw.code === "invalid_union" && Array.isArray(raw.errors)) {
    const errors = raw.errors.map((branch: unknown) => Array.isArray(branch)
      ? branch.map((entry: unknown) => finalizeNested(entry as $ZodRawIssue, context))
      : []);
    return finalizeIssue({ ...raw, errors } as $ZodRawIssue, context, global);
  }
  if ((raw.code === "invalid_key" || raw.code === "invalid_element") && Array.isArray(raw.issues)) {
    const issues = raw.issues.map((entry: unknown) => finalizeNested(entry as $ZodRawIssue, context));
    return finalizeIssue({ ...raw, issues } as $ZodRawIssue, context, global);
  }
  return finalizeIssue(raw, context, global);
}

function makeError<T>(raw: $ZodRawIssue[] | null, context: ParseContext | undefined): ZodError<T> {
  return new ZodError<T>((raw ?? []).map((issue) => finalizeNested(issue, context)));
}

function validationContext(context: ParseContext | undefined, async: boolean, direction: "forward" | "backward" = "forward"): ValidationContext {
  return { ...context, issues: null, async, direction };
}

export function parse<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): output<T> {
  const ctx = validationContext(context, false);
  const result = schema._zod.validate(value, ctx);
  if (result === FAIL) throw makeError<output<T>>(ctx.issues, context);
  return result as output<T>;
}

export function safeParse<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): SafeParseResult<output<T>> {
  const ctx = validationContext(context, false);
  const result = schema._zod.validate(value, ctx);
  return result === FAIL
    ? { success: false, error: makeError<output<T>>(ctx.issues, context) }
    : { success: true, data: result as output<T> };
}

export async function parseAsync<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): Promise<output<T>> {
  const ctx = validationContext(context, true);
  const result = await schema._zod.validateAsync(value, ctx);
  if (result === FAIL) throw makeError<output<T>>(ctx.issues, context);
  return result as output<T>;
}

export async function safeParseAsync<T extends RuntimeSchema>(schema: T, value: unknown, context?: ParseContext): Promise<SafeParseResult<output<T>>> {
  const ctx = validationContext(context, true);
  const result = await schema._zod.validateAsync(value, ctx);
  return result === FAIL
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
  if (result === FAIL) throw makeError<input<T>>(ctx.issues, context);
  return result as input<T>;
}
export function safeEncode<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): SafeParseResult<input<T>> {
  const ctx = validationContext(context, false, "backward");
  const result = schema._zod.validate(value, ctx);
  return result === FAIL ? { success: false, error: makeError<input<T>>(ctx.issues, context) } : { success: true, data: result as input<T> };
}
export async function encodeAsync<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): Promise<input<T>> {
  const ctx = validationContext(context, true, "backward");
  const result = await schema._zod.validateAsync(value, ctx);
  if (result === FAIL) throw makeError<input<T>>(ctx.issues, context);
  return result as input<T>;
}
export async function safeEncodeAsync<T extends RuntimeSchema>(schema: T, value: output<T>, context?: ParseContext): Promise<SafeParseResult<input<T>>> {
  const ctx = validationContext(context, true, "backward");
  const result = await schema._zod.validateAsync(value, ctx);
  return result === FAIL ? { success: false, error: makeError<input<T>>(ctx.issues, context) } : { success: true, data: result as input<T> };
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
    if (!(segment in current)) return undefined;
    current = current[segment as keyof typeof current];
  }
  return current;
}

/** Back-fill `input` on an issue and, recursively, on any nested sub-issues. */
function backFillInput(raw: $ZodRawIssue, original: unknown): $ZodRawIssue {
  const withInput = { ...raw, input: inputAtPath(original, raw.path ?? []) } as $ZodRawIssue;
  if (Array.isArray(withInput.errors)) {
    const errors = withInput.errors.map((branch: unknown) => Array.isArray(branch)
      ? branch.map((entry: unknown) => backFillInput(entry as $ZodRawIssue, original))
      : branch);
    return { ...withInput, errors } as $ZodRawIssue;
  }
  if (Array.isArray(withInput.issues)) {
    const issues = withInput.issues.map((entry: unknown) => backFillInput(entry as $ZodRawIssue, original));
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
      // Canonical Zod strips `input` unless reportInput:true; only back-fill then.
      if (context?.reportInput) {
        const original: unknown = JSON.parse(source.text);
        raw = raw.map((entry) => backFillInput(entry, original));
      }
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
