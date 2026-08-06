import { CODEGEN_AVAILABLE, createCodegenValidator } from "../core/codegen.js";
import { config } from "../core/config.js";
import type { $ZodErrorMap, $ZodIssue, ParseContext } from "../core/errors.js";
import { createAsyncInterpreter, createInterpreter } from "../core/interpreter.js";
import type { ValidationContext } from "../core/interpreter.js";
import type {
  Check,
  DynamicValue,
  FormatId,
  HostFunction,
  MetadataBag,
  ObjectMode,
  RuntimeCheck,
  SchemaNode,
} from "../core/nodes.js";
import { cloneNode, node } from "../core/nodes.js";
import * as parsing from "../core/parse.js";
import type { RuntimeSchema, SafeParseResult } from "../core/parse.js";
import { compilePlan } from "../core/plan.js";
import { toJSONSchema as coreToJSONSchema } from "../core/json-schema.js";
import type { JSONSchema } from "../core/json-schema-types.js";
import type { ToJSONSchemaParams } from "../core/json-schema.js";
import { globalRegistry } from "../core/registries.js";
import type { $ZodRegistry, $replace, GlobalMeta } from "../core/registries.js";
import { createStandardProps } from "../core/standard-schema.js";
import type { StandardSchemaV1 } from "../core/standard-schema.js";
import { escapeRegex, isObject } from "../core/util.js";
import type { JSONType, MaybeAsync, NoUndefined, Primitive } from "../core/util.js";

export type output<T extends $ZodType> = T["_zod"]["output"];
export type input<T extends $ZodType> = T["_zod"]["input"];
export type infer<T extends $ZodType> = output<T>;
export type SomeType = $ZodType<unknown, unknown>;
export type ZodTypeAny = SomeType;
export type ZodSafeParseResult<T> = SafeParseResult<T>;
export type ZodSafeParseSuccess<T> = parsing.SafeParseSuccess<T>;
export type ZodSafeParseError<T> = parsing.SafeParseError<T>;

export const $brand: unique symbol = Symbol("zodrs.brand");
export type BRAND<T extends PropertyKey> = { readonly [$brand]: { readonly [K in T]: true } };

// T is a phantom parameter kept for API compatibility; it is intentionally
// structurally inert so `$ZodCheck<number>` and `$ZodCheck<string>` unify.
export interface $ZodCheck<T = unknown> {
  readonly _zod: RuntimeCheck;
}
export type CheckFn = (payload: { value: unknown; issues: $ZodIssue[] }) => MaybeAsync<void>;
export type AnyCheckInput = $ZodCheck | RuntimeCheck | CheckFn;

export type SchemaInternals<Output, Input> = RuntimeSchema<Output, Input>["_zod"] & {
  readonly node: SchemaNode;
  readonly parent?: $ZodType | undefined;
  readonly def: SchemaNode;
};

export type ErrorParam = string | {
  readonly error?: string | $ZodErrorMap | undefined;
  /** Deprecated alias for `error`, kept for Zod v4 parity. */
  readonly message?: string | $ZodErrorMap | undefined;
  readonly abort?: boolean | undefined;
  /** Catchall metadata carried onto the emitted issue. */
  readonly params?: Record<string, unknown> | undefined;
  /** Path prefix appended to the emitted issue path (refinements). */
  readonly path?: PropertyKey[] | undefined;
};
export type RefinementCtx<T = unknown> = {
  readonly value: T;
  readonly issues: $ZodIssue[];
  addIssue(issue: $ZodIssue | string): void;
};

export type Shape = Readonly<Record<string, SomeType>>;
type OptionalOutputKeys<S extends Shape> = { [K in keyof S]-?: undefined extends output<S[K]> ? K : never }[keyof S];
type RequiredOutputKeys<S extends Shape> = Exclude<keyof S, OptionalOutputKeys<S>>;
type OptionalInputKeys<S extends Shape> = { [K in keyof S]-?: undefined extends input<S[K]> ? K : never }[keyof S];
type RequiredInputKeys<S extends Shape> = Exclude<keyof S, OptionalInputKeys<S>>;
export type ObjectOutput<S extends Shape> = { [K in RequiredOutputKeys<S>]: output<S[K]> } & { [K in OptionalOutputKeys<S>]?: output<S[K]> };
export type ObjectInput<S extends Shape> = { [K in RequiredInputKeys<S>]: input<S[K]> } & { [K in OptionalInputKeys<S>]?: input<S[K]> };
export type TupleOutput<T extends readonly SomeType[], Rest extends SomeType | null = null> = Rest extends SomeType
  ? [...{ [K in keyof T]: output<T[K]> }, ...output<Rest>[]]
  : { [K in keyof T]: output<T[K]> };
export type TupleInput<T extends readonly SomeType[], Rest extends SomeType | null = null> = Rest extends SomeType
  ? [...{ [K in keyof T]: input<T[K]> }, ...input<Rest>[]]
  : { [K in keyof T]: input<T[K]> };

function errorMap(params?: ErrorParam): $ZodErrorMap | undefined {
  if (typeof params === "string") return () => params;
  const candidate = params?.error ?? params?.message;
  if (typeof candidate === "string") return () => candidate;
  return candidate;
}

function runtimeCheck(check: RuntimeCheck["check"], params?: ErrorParam): $ZodCheck {
  const extra = typeof params === "object" ? params : undefined;
  return {
    _zod: {
      check,
      error: errorMap(params),
      abort: extra?.abort,
      params: extra?.params,
      path: extra?.path,
    },
  };
}

function checksOf(values: readonly ($ZodCheck | RuntimeCheck | ((payload: { value: unknown; issues: $ZodIssue[] }) => MaybeAsync<void>))[]): RuntimeCheck[] {
  return values.map((value) => {
    if (typeof value === "function") {
      const fn: HostFunction = async (input, context) => value({ value: input, issues: context.issues as $ZodIssue[] });
      return { check: { c: "host_runtime", op: "check", fn } };
    }
    return "_zod" in value ? value._zod : value;
  });
}

const schemaByNode = new WeakMap<SchemaNode, $ZodType>();
function fromNode<T extends $ZodType = $ZodType>(schemaNode: SchemaNode, parent?: $ZodType): T {
  // The runtime instance is structurally `$ZodType<unknown, unknown>`; the caller's
  // contextual return type refines the phantom Output/Input at zero runtime cost.
  return new $ZodType(schemaNode, parent) as T;
}

function childSchema(schemaNode: SchemaNode): $ZodType {
  return schemaByNode.get(schemaNode) ?? fromNode(schemaNode);
}

function withCheck<Output, Input>(schema: $ZodType<Output, Input>, check: $ZodCheck | RuntimeCheck): $ZodType<Output, Input> {
  const runtime = "_zod" in check ? check._zod : check;
  return fromNode(cloneNode(schema._zod.node, { checks: [...schema._zod.node.checks, runtime] }), schema);
}

export class $ZodType<Output = unknown, Input = Output> implements RuntimeSchema<Output, Input> {
  readonly _zod: SchemaInternals<Output, Input>;
  readonly def: SchemaNode;
  readonly _def: SchemaNode;
  readonly type: SchemaNode["kind"];
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;

  constructor(schemaNode: SchemaNode, parent?: $ZodType) {
    // Compilation is deferred to first use so self-referential schemas
    // (`const N = z.object({ next: z.lazy(() => N) })`) don't recurse into their
    // own lazy getters during construction (which would throw a TDZ error).
    let cachedPlan: SchemaInternals<Output, Input>["plan"] | undefined;
    let cachedValidate: SchemaInternals<Output, Input>["validate"] | undefined;
    let cachedValidateAsync: SchemaInternals<Output, Input>["validateAsync"] | undefined;
    this._zod = {
      output: undefined as Output,
      input: undefined as Input,
      node: schemaNode,
      def: schemaNode,
      parent,
      get validate() { return (cachedValidate ??= CODEGEN_AVAILABLE && !config().jitless ? createCodegenValidator(schemaNode) : createInterpreter(schemaNode)); },
      get validateAsync() { return (cachedValidateAsync ??= createAsyncInterpreter(schemaNode)); },
      get plan() { return (cachedPlan ??= compilePlan(schemaNode)); },
      nativeHandle: null,
    };
    this.def = schemaNode;
    this._def = schemaNode;
    this.type = schemaNode.kind;
    this["~standard"] = createStandardProps<Input, Output>({ safeParse: this.safeParse, safeParseAsync: this.safeParseAsync });
    schemaByNode.set(schemaNode, this);
    const prototype = $ZodType.prototype;
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      Object.defineProperty(this, key, { value: descriptor.value.bind(this), configurable: true, writable: true });
    }
  }

  parse(data: unknown, params?: ParseContext): Output { return parsing.parse(this, data, params); }
  safeParse(data: unknown, params?: ParseContext): SafeParseResult<Output> { return parsing.safeParse(this, data, params); }
  parseAsync(data: unknown, params?: ParseContext): Promise<Output> { return parsing.parseAsync(this, data, params); }
  safeParseAsync(data: unknown, params?: ParseContext): Promise<SafeParseResult<Output>> { return parsing.safeParseAsync(this, data, params); }
  spa(data: unknown, params?: ParseContext): Promise<SafeParseResult<Output>> { return parsing.safeParseAsync(this, data, params); }
  parseJson(data: Uint8Array | ArrayBuffer | string, params?: ParseContext): Output { return parsing.parseJson(this, data, params); }
  safeParseJson(data: Uint8Array | ArrayBuffer | string, params?: ParseContext): SafeParseResult<Output> { return parsing.safeParseJson(this, data, params); }
  encode(data: Output, params?: ParseContext): Input { return parsing.encode(this, data, params); }
  decode(data: Input, params?: ParseContext): Output { return parsing.decode(this, data, params); }
  encodeAsync(data: Output, params?: ParseContext): Promise<Input> { return parsing.encodeAsync(this, data, params); }
  decodeAsync(data: Input, params?: ParseContext): Promise<Output> { return parsing.decodeAsync(this, data, params); }
  safeEncode(data: Output, params?: ParseContext): SafeParseResult<Input> { return parsing.safeEncode(this, data, params); }
  safeDecode(data: Input, params?: ParseContext): SafeParseResult<Output> { return parsing.safeDecode(this, data, params); }
  safeEncodeAsync(data: Output, params?: ParseContext): Promise<SafeParseResult<Input>> { return parsing.safeEncodeAsync(this, data, params); }
  safeDecodeAsync(data: Input, params?: ParseContext): Promise<SafeParseResult<Output>> { return parsing.safeDecodeAsync(this, data, params); }

  check(...values: readonly ($ZodCheck<Output> | RuntimeCheck | ((payload: { value: Output; issues: $ZodIssue[] }) => MaybeAsync<void>))[]): this {
    const next = cloneNode(this._zod.node, { checks: [...this._zod.node.checks, ...checksOf(values as readonly AnyCheckInput[])] });
    return fromNode(next, this) as this;
  }
  with(...values: readonly ($ZodCheck<Output> | RuntimeCheck | ((payload: { value: Output; issues: $ZodIssue[] }) => MaybeAsync<void>))[]): this { return this.check(...values); }
  clone(definition: SchemaNode = this._zod.node): this { return fromNode(cloneNode(definition), this) as this; }
  register(registry: $ZodRegistry, ...metadata: [unknown?]): this { registry.add(this, metadata[0] as never); return this; }
  brand<T extends PropertyKey = PropertyKey>(): $ZodType<Output & BRAND<T>, Input> { return this as $ZodType<Output & BRAND<T>, Input>; }

  refine<Refined extends Output>(predicate: (arg: Output) => arg is Refined, params?: ErrorParam): $ZodType<Refined, Input>;
  refine(predicate: (arg: Output) => MaybeAsync<unknown>, params?: ErrorParam): this;
  refine(predicate: (arg: Output) => MaybeAsync<unknown>, params?: ErrorParam): this {
    const fn: HostFunction = (value) => predicate(value as Output);
    return this.check(runtimeCheck({ c: "host_runtime", op: "refine", fn }, params)) as this;
  }
  superRefine(refinement: (arg: Output, context: RefinementCtx<Output>) => MaybeAsync<void>, params?: ErrorParam): this {
    const fn: HostFunction = (value, context) => refinement(value as Output, context as RefinementCtx<Output>);
    return this.check(runtimeCheck({ c: "host_runtime", op: "superRefine", fn }, params)) as this;
  }
  overwrite(fn: (value: Output) => Output): this {
    const host: HostFunction = (value) => fn(value as Output);
    return this.check(runtimeCheck({ c: "host_runtime", op: "overwrite", fn: host })) as this;
  }

  optional(): $ZodType<Output | undefined, Input | undefined> { return fromNode(node({ kind: "optional", inner: this._zod.node }), this); }
  exactOptional(): $ZodType<Output | undefined, Input | undefined> { return this.optional(); }
  nonoptional(params?: ErrorParam): $ZodType<Exclude<Output, undefined>, Input> { return fromNode(node({ kind: "nonoptional", inner: this._zod.node }, { error: errorMap(params) }), this); }
  nullable(): $ZodType<Output | null, Input | null> { return fromNode(node({ kind: "nullable", inner: this._zod.node }), this); }
  nullish(): $ZodType<Output | null | undefined, Input | null | undefined> { return this.nullable().optional(); }
  array(): $ZodType<Output[], Input[]> { return array(this); }
  or<T extends SomeType>(option: T): $ZodType<Output | output<T>, Input | input<T>> { return union([this, option]); }
  and<T extends SomeType>(incoming: T): $ZodType<Output & output<T>, Input & input<T>> { return intersection(this, incoming); }
  transform<NewOutput>(fn: (arg: Output, context: RefinementCtx<Output>) => MaybeAsync<NewOutput>): $ZodType<Awaited<NewOutput>, Input> {
    const host: HostFunction = (value, context) => fn(value as Output, context as RefinementCtx<Output>);
    // Match Zod: `.transform` is `pipe(this, transform(fn))`, so the result is a
    // ZodPipe whose `.out` is a standalone ZodTransform node.
    const transformNode = node({ kind: "host", inner: null, fn: host, op: "transform" });
    return fromNode(node({ kind: "pipe", a: this._zod.node, b: transformNode }), this);
  }
  default(value: NoUndefined<Output> | (() => NoUndefined<Output>)): $ZodType<Exclude<Output, undefined>, Input | undefined> {
    return fromNode(node({ kind: "default", inner: this._zod.node, value, dynamic: typeof value === "function" }), this);
  }
  prefault(value: Input | (() => Input)): $ZodType<Output, Input | undefined> {
    return fromNode(node({ kind: "prefault", inner: this._zod.node, value, dynamic: typeof value === "function" }), this);
  }
  catch(value: Output | ((context: { readonly error: unknown; readonly input: unknown }) => Output)): $ZodType<Output, Input> {
    return fromNode(node({ kind: "catch", inner: this._zod.node, value, dynamic: typeof value === "function" }), this);
  }
  pipe<T extends SomeType>(target: T): $ZodType<output<T>, Input> { return fromNode(node({ kind: "pipe", a: this._zod.node, b: target._zod.node }), this); }
  readonly(): $ZodType<Readonly<Output>, Input> { return fromNode(node({ kind: "readonly", inner: this._zod.node }), this); }

  describe(description: string): this { const copy = this.clone(); globalRegistry.add(copy, { description }); return copy; }
  get description(): string | undefined { return globalRegistry.get(this)?.description; }
  meta(): $replace<GlobalMeta, this> | undefined;
  meta(data: $replace<GlobalMeta, this>): this;
  meta(data?: $replace<GlobalMeta, this>): $replace<GlobalMeta, this> | this | undefined {
    if (data === undefined) return globalRegistry.get(this);
    const copy = this.clone(); globalRegistry.add(copy, data); return copy;
  }
  isOptional(): boolean { return this.safeParse(undefined).success; }
  isNullable(): boolean { return this.safeParse(null).success; }
  apply<T>(fn: (schema: this) => T): T { return fn(this); }

  min(value: number | bigint | Date, params?: ErrorParam): this {
    const kind = this._zod.node.kind;
    if (kind === "string" || kind === "array") return this.check(minLength(Number(value), params));
    if (kind === "set" || kind === "map") return this.check(minSize(Number(value), params));
    return this.check(gte(value, params));
  }
  max(value: number | bigint | Date, params?: ErrorParam): this {
    const kind = this._zod.node.kind;
    if (kind === "string" || kind === "array") return this.check(maxLength(Number(value), params));
    if (kind === "set" || kind === "map") return this.check(maxSize(Number(value), params));
    return this.check(lte(value, params));
  }
  gt(value: number | bigint | Date, params?: ErrorParam): this { return this.check(gt(value, params)); }
  gte(value: number | bigint | Date, params?: ErrorParam): this { return this.check(gte(value, params)); }
  lt(value: number | bigint | Date, params?: ErrorParam): this { return this.check(lt(value, params)); }
  lte(value: number | bigint | Date, params?: ErrorParam): this { return this.check(lte(value, params)); }
  positive(params?: ErrorParam): this { return this.check(gt(0, params)); }
  negative(params?: ErrorParam): this { return this.check(lt(0, params)); }
  nonpositive(params?: ErrorParam): this { return this.check(lte(0, params)); }
  nonnegative(params?: ErrorParam): this { return this.check(gte(0, params)); }
  multipleOf(value: number | bigint, params?: ErrorParam): this { return this.check(multipleOf(value, params)); }
  step(value: number | bigint, params?: ErrorParam): this { return this.multipleOf(value, params); }
  int(params?: ErrorParam): this { return this.check(int(params)); }
  safe(params?: ErrorParam): this { return this.check(int(params)); }
  finite(params?: ErrorParam): this { return this.refine((value) => typeof value === "number" && Number.isFinite(value), params); }

  minLength(value: number, params?: ErrorParam): this { return this.check(minLength(value, params)); }
  maxLength(value: number, params?: ErrorParam): this { return this.check(maxLength(value, params)); }
  length(value: number, params?: ErrorParam): this {
    const kind = this._zod.node.kind;
    if (kind === "set" || kind === "map") return this.check(size(value, params));
    return this.check(length(value, params));
  }
  nonempty(params?: ErrorParam): this {
    const kind = this._zod.node.kind;
    if (kind === "set" || kind === "map") return this.check(minSize(1, params));
    return this.check(minLength(1, params));
  }
  regex(pattern: RegExp, params?: ErrorParam): this { return this.check(regex(pattern, params)); }
  includes(value: string, params?: ErrorParam & { readonly position?: number }): this { return this.check(includes(value, params)); }
  startsWith(value: string, params?: ErrorParam): this { return this.check(startsWith(value, params)); }
  endsWith(value: string, params?: ErrorParam): this { return this.check(endsWith(value, params)); }
  lowercase(params?: ErrorParam): this { return this.check(lowercase(params)); }
  uppercase(params?: ErrorParam): this { return this.check(uppercase(params)); }
  trim(): this { return this.check(trim()); }
  toLowerCase(): this { return this.check(toLowerCase()); }
  toUpperCase(): this { return this.check(toUpperCase()); }
  normalize(form?: string): this { return this.check(normalize(form)); }
  slugify(): this { return this.check(slugify()); }

  email(params?: ErrorParam): this { return this.check(format("email", params)); }
  url(params?: ErrorParam): this { return this.check(format("url", params)); }
  jwt(params?: ErrorParam): this { return this.check(format("jwt", params)); }
  emoji(params?: ErrorParam): this { return this.check(format("emoji", params)); }
  guid(params?: ErrorParam): this { return this.check(format("guid", params)); }
  uuid(params?: ErrorParam): this { return this.check(format("uuid", params)); }
  uuidv4(params?: ErrorParam): this { return this.check(format("uuidv4", params)); }
  uuidv6(params?: ErrorParam): this { return this.check(format("uuidv6", params)); }
  uuidv7(params?: ErrorParam): this { return this.check(format("uuidv7", params)); }
  nanoid(params?: ErrorParam): this { return this.check(format("nanoid", params)); }
  cuid(params?: ErrorParam): this { return this.check(format("cuid", params)); }
  cuid2(params?: ErrorParam): this { return this.check(format("cuid2", params)); }
  ulid(params?: ErrorParam): this { return this.check(format("ulid", params)); }
  xid(params?: ErrorParam): this { return this.check(format("xid", params)); }
  ksuid(params?: ErrorParam): this { return this.check(format("ksuid", params)); }
  base64(params?: ErrorParam): this { return this.check(format("base64", params)); }
  base64url(params?: ErrorParam): this { return this.check(format("base64url", params)); }

  minSize(value: number, params?: ErrorParam): this { return this.check(minSize(value, params)); }
  maxSize(value: number, params?: ErrorParam): this { return this.check(maxSize(value, params)); }
  size(value: number, params?: ErrorParam): this { return this.check(size(value, params)); }
  mime(types: string | readonly string[], params?: ErrorParam): this { return this.check(mime(types, params)); }

  get shape(): Readonly<Record<string, SomeType>> {
    if (this._zod.node.kind !== "object") return {};
    return Object.fromEntries(Object.entries(this._zod.node.shape).map(([key, child]) => [key, childSchema(child)]));
  }
  keyof(): $ZodType<string, string> { return enum_(Object.keys(this.shape)); }
  extend<Extension extends Shape>(extension: Extension): $ZodType<Output & ObjectOutput<Extension>, Input & ObjectInput<Extension>> {
    if (this._zod.node.kind !== "object") throw new TypeError("extend() is only valid on object schemas");
    // Merge base and extension shapes lazily so recursive getter shapes in the
    // extension (`get self() { return z.array(Self) }`) don't hit a TDZ.
    const baseShape = this._zod.node.shape;
    const extShape = extension as Readonly<Record<string, SomeType>>;
    const merged: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) defineLazyNode(merged, key, () => requireNode(baseShape, key));
    for (const key of Object.keys(extShape)) defineLazyNode(merged, key, () => resolveShapeNode(extShape, key));
    return fromNode(cloneNode(this._zod.node, { shape: merged }), this);
  }
  safeExtend<Extension extends Shape>(extension: Extension): $ZodType<Output & ObjectOutput<Extension>, Input & ObjectInput<Extension>> { return this.extend(extension); }
  merge<T extends SomeType>(other: T): $ZodType<Output & output<T>, Input & input<T>> {
    if (other._zod.node.kind !== "object") throw new TypeError("merge() requires an object schema");
    const baseShape = this._zod.node.kind === "object" ? this._zod.node.shape : {};
    const otherShape = other._zod.node.shape;
    const merged: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) defineLazyNode(merged, key, () => requireNode(baseShape, key));
    for (const key of Object.keys(otherShape)) defineLazyNode(merged, key, () => requireNode(otherShape, key));
    return fromNode(cloneNode(this._zod.node, { shape: merged }), this);
  }
  pick<K extends keyof Output & string>(mask: Readonly<Partial<Record<K, boolean>>>): $ZodType<Pick<Output, K>, Pick<Input, Extract<K, keyof Input>>> {
    if (this._zod.node.kind !== "object") throw new TypeError("pick() is only valid on object schemas");
    const baseShape = this._zod.node.shape;
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) if (mask[key as K]) defineLazyNode(shape, key, () => requireNode(baseShape, key));
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  omit<K extends keyof Output & string>(mask: Readonly<Partial<Record<K, boolean>>>): $ZodType<Omit<Output, K>, Omit<Input, Extract<K, keyof Input>>> {
    if (this._zod.node.kind !== "object") throw new TypeError("omit() is only valid on object schemas");
    const baseShape = this._zod.node.shape;
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) if (!mask[key as K]) defineLazyNode(shape, key, () => requireNode(baseShape, key));
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  partial(): $ZodType<Partial<Output>, Partial<Input>> {
    if (this._zod.node.kind !== "object") throw new TypeError("partial() is only valid on object schemas");
    const baseShape = this._zod.node.shape;
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) defineLazyNode(shape, key, () => node({ kind: "optional", inner: requireNode(baseShape, key) }));
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  required(): $ZodType<Required<Output>, Required<Input>> {
    if (this._zod.node.kind !== "object") throw new TypeError("required() is only valid on object schemas");
    const baseShape = this._zod.node.shape;
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) defineLazyNode(shape, key, () => { const inner = requireNode(baseShape, key); return inner.kind === "optional" ? inner.inner : inner; });
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  passthrough(): this { return this.objectMode("passthrough"); }
  loose(): this { return this.passthrough(); }
  strict(): this { return this.objectMode("strict"); }
  strip(): this { return this.objectMode("strip"); }
  catchall(schema: SomeType): this {
    if (this._zod.node.kind !== "object") throw new TypeError("catchall() is only valid on object schemas");
    return fromNode(cloneNode(this._zod.node, { catchall: schema._zod.node }), this) as this;
  }
  private objectMode(mode: ObjectMode): this {
    if (this._zod.node.kind !== "object") throw new TypeError("Object mode methods require an object schema");
    return fromNode(cloneNode(this._zod.node, { mode }), this) as this;
  }

  get element(): SomeType { return this._zod.node.kind === "array" ? childSchema(this._zod.node.element) : never(); }
  get options(): readonly SomeType[] { return this._zod.node.kind === "union" || this._zod.node.kind === "discunion" ? this._zod.node.options.map(childSchema) : []; }
  get items(): readonly SomeType[] { return this._zod.node.kind === "tuple" ? this._zod.node.items.map(childSchema) : []; }
  rest<T extends SomeType>(schema: T): $ZodType<Output, Input> { if (this._zod.node.kind !== "tuple") throw new TypeError("rest() requires a tuple schema"); return fromNode(cloneNode(this._zod.node, { rest: schema._zod.node }), this); }
  unwrap(): SomeType {
    const current = this._zod.node;
    if (current.kind === "optional" || current.kind === "nullable" || current.kind === "nonoptional" || current.kind === "readonly" || current.kind === "promise" || current.kind === "default" || current.kind === "prefault" || current.kind === "catch") return childSchema(current.inner);
    if (current.kind === "lazy") return childSchema(current.getter());
    throw new TypeError("unwrap() is not supported by this schema");
  }
  removeDefault(): SomeType { return this.unwrap(); }
  get keyType(): SomeType { return this._zod.node.kind === "record" || this._zod.node.kind === "map" ? childSchema(this._zod.node.key) : never(); }
  get valueType(): SomeType { const current = this._zod.node; return current.kind === "record" || current.kind === "map" || current.kind === "set" ? childSchema(current.value) : never(); }
  get in(): SomeType { return this._zod.node.kind === "pipe" ? childSchema(this._zod.node.a) : never(); }
  get out(): SomeType { return this._zod.node.kind === "pipe" ? childSchema(this._zod.node.b) : never(); }

  implement<F extends (...args: never[]) => unknown>(fn: F): F { return fn; }
  implementAsync<F extends (...args: never[]) => Promise<unknown>>(fn: F): F { return fn; }
  input<T extends SomeType>(schema: T): this { return this; }
  output<T extends SomeType>(schema: T): this { return this; }

  toJSONSchema(params?: ToJSONSchemaParams): JSONSchema { return coreToJSONSchema(this, params); }
}

export const ZodType: typeof $ZodType = $ZodType;
export type ZodType<Output = unknown, Input = Output> = $ZodType<Output, Input>;
export type ZodString = $ZodType<string, string>;
export type ZodNumber = $ZodType<number, number>;
export type ZodBigInt = $ZodType<bigint, bigint>;
export type ZodBoolean = $ZodType<boolean, boolean>;
export type ZodDate = $ZodType<Date, Date>;
export type ZodSymbol = $ZodType<symbol, symbol>;
export type ZodUndefined = $ZodType<undefined, undefined>;
export type ZodNull = $ZodType<null, null>;
export type ZodVoid = $ZodType<void, void>;
export type ZodAny = $ZodType<unknown, unknown>;
export type ZodUnknown = $ZodType<unknown, unknown>;
export type ZodNever = $ZodType<never, never>;
export type ZodNaN = $ZodType<number, number>;
export type ZodLiteral<T extends Primitive = Primitive> = $ZodType<T, T>;
export type ZodEnum<T extends string | number = string | number> = $ZodType<T, T>;
export type ZodObject<S extends Shape = Shape> = $ZodType<ObjectOutput<S>, ObjectInput<S>>;
export type ZodArray<T extends SomeType = SomeType> = $ZodType<output<T>[], input<T>[]>;
export type ZodTuple<T extends readonly SomeType[] = readonly SomeType[], Rest extends SomeType | null = null> = $ZodType<TupleOutput<T, Rest>, TupleInput<T, Rest>>;
export type ZodUnion<T extends readonly SomeType[] = readonly SomeType[]> = $ZodType<output<T[number]>, input<T[number]>>;
export type ZodIntersection<A extends SomeType = SomeType, B extends SomeType = SomeType> = $ZodType<output<A> & output<B>, input<A> & input<B>>;
export type ZodRecord<K extends SomeType = SomeType, V extends SomeType = SomeType> = $ZodType<Record<string, output<V>>, Record<string, input<V>>>;
export type ZodMap<K extends SomeType = SomeType, V extends SomeType = SomeType> = $ZodType<Map<output<K>, output<V>>, Map<input<K>, input<V>>>;
export type ZodSet<T extends SomeType = SomeType> = $ZodType<Set<output<T>>, Set<input<T>>>;
export type ZodOptional<T extends SomeType = SomeType> = $ZodType<output<T> | undefined, input<T> | undefined>;
export type ZodNullable<T extends SomeType = SomeType> = $ZodType<output<T> | null, input<T> | null>;
export type ZodDefault<T extends SomeType = SomeType> = $ZodType<Exclude<output<T>, undefined>, input<T> | undefined>;
export type ZodCatch<T extends SomeType = SomeType> = $ZodType<output<T>, input<T>>;
export type ZodPromise<T extends SomeType = SomeType> = $ZodType<Promise<output<T>>, Promise<input<T>>>;
export type ZodReadonly<T extends SomeType = SomeType> = $ZodType<Readonly<output<T>>, input<T>>;
export type ZodPipe<A extends SomeType = SomeType, B extends SomeType = SomeType> = $ZodType<output<B>, input<A>>;
export type ZodLazy<T extends SomeType = SomeType> = $ZodType<output<T>, input<T>>;
export type ZodFile = $ZodType<{ readonly name: string; readonly size: number; readonly type: string }, { readonly name: string; readonly size: number; readonly type: string }>;
export type ZodFunction = $ZodType<(...args: never[]) => unknown, (...args: never[]) => unknown>;

// One runtime implementation backs every schema (single core, no duplicated
// class hierarchy). The named wrappers are `instanceof` matchers keyed by the
// underlying node kind via `Symbol.hasInstance`, so `x instanceof z.ZodString`
// is true exactly when `x` is a string schema, without a real subclass.
type ZodMatcher = { readonly [Symbol.hasInstance]: (value: unknown) => boolean };
function kindMatcher(...kinds: readonly SchemaNode["kind"][]): ZodMatcher {
  return { [Symbol.hasInstance]: (value: unknown): boolean => value instanceof $ZodType && kinds.includes(value._zod.node.kind) };
}

export const ZodString: ZodMatcher = kindMatcher("string");
export const ZodNumber: ZodMatcher = kindMatcher("number");
export const ZodBigInt: ZodMatcher = kindMatcher("bigint");
export const ZodBoolean: ZodMatcher = kindMatcher("boolean");
export const ZodDate: ZodMatcher = kindMatcher("date");
export const ZodSymbol: ZodMatcher = kindMatcher("symbol");
export const ZodUndefined: ZodMatcher = kindMatcher("undefined");
export const ZodNull: ZodMatcher = kindMatcher("null");
export const ZodVoid: ZodMatcher = kindMatcher("void");
export const ZodAny: ZodMatcher = kindMatcher("any");
export const ZodUnknown: ZodMatcher = kindMatcher("unknown");
export const ZodNever: ZodMatcher = kindMatcher("never");
export const ZodNaN: ZodMatcher = kindMatcher("nan");
export const ZodLiteral: ZodMatcher = kindMatcher("literal");
export const ZodEnum: ZodMatcher = kindMatcher("enum");
export const ZodObject: ZodMatcher = kindMatcher("object");
export const ZodArray: ZodMatcher = kindMatcher("array");
export const ZodTuple: ZodMatcher = kindMatcher("tuple");
export const ZodUnion: ZodMatcher = kindMatcher("union", "discunion");
export const ZodDiscriminatedUnion: ZodMatcher = kindMatcher("discunion");
export const ZodIntersection: ZodMatcher = kindMatcher("intersection");
export const ZodRecord: ZodMatcher = kindMatcher("record");
export const ZodMap: ZodMatcher = kindMatcher("map");
export const ZodSet: ZodMatcher = kindMatcher("set");
export const ZodOptional: ZodMatcher = kindMatcher("optional");
export const ZodNullable: ZodMatcher = kindMatcher("nullable");
export const ZodDefault: ZodMatcher = kindMatcher("default");
export const ZodPrefault: ZodMatcher = kindMatcher("prefault");
export const ZodNonOptional: ZodMatcher = kindMatcher("nonoptional");
export const ZodCatch: ZodMatcher = kindMatcher("catch");
export const ZodPromise: ZodMatcher = kindMatcher("promise");
export const ZodReadonly: ZodMatcher = kindMatcher("readonly");
export const ZodLazy: ZodMatcher = kindMatcher("lazy");
export const ZodFile: ZodMatcher = kindMatcher("file");
export const ZodFunction: ZodMatcher = kindMatcher("function");
export const ZodTemplateLiteral: ZodMatcher = kindMatcher("templateLiteral");
export const ZodPipe: ZodMatcher = kindMatcher("pipe");
export const ZodTransform: ZodMatcher = {
  [Symbol.hasInstance]: (value: unknown): boolean => {
    if (!(value instanceof $ZodType)) return false;
    const current = value._zod.node;
    return current.kind === "host" && current.op === "transform";
  },
};
export const ZodCodec: ZodMatcher = {
  [Symbol.hasInstance]: (value: unknown): boolean => {
    if (!(value instanceof $ZodType)) return false;
    const current = value._zod.node;
    return current.kind === "pipe" && current.codec === true;
  },
};

export function string(params?: ErrorParam): ZodString { return fromNode(node({ kind: "string" }, { error: errorMap(params) })); }
export function number(params?: ErrorParam): ZodNumber { return fromNode(node({ kind: "number" }, { error: errorMap(params) })); }
export function bigint(params?: ErrorParam): ZodBigInt { return fromNode(node({ kind: "bigint" }, { error: errorMap(params) })); }
export function boolean(params?: ErrorParam): ZodBoolean { return fromNode(node({ kind: "boolean" }, { error: errorMap(params) })); }
export function date(params?: ErrorParam): ZodDate { return fromNode(node({ kind: "date" }, { error: errorMap(params) })); }
export function symbol(params?: ErrorParam): ZodSymbol { return fromNode(node({ kind: "symbol" }, { error: errorMap(params) })); }
export function undefined_(params?: ErrorParam): ZodUndefined { return fromNode(node({ kind: "undefined" }, { error: errorMap(params) })); }
export function null_(params?: ErrorParam): ZodNull { return fromNode(node({ kind: "null" }, { error: errorMap(params) })); }
export function void_(params?: ErrorParam): ZodVoid { return fromNode(node({ kind: "void" }, { error: errorMap(params) })); }
export function any(): ZodAny { return fromNode(node({ kind: "any" })); }
export function unknown(): ZodUnknown { return fromNode(node({ kind: "unknown" })); }
export function never(params?: ErrorParam): ZodNever { return fromNode(node({ kind: "never" }, { error: errorMap(params) })); }
export function nan(params?: ErrorParam): ZodNaN { return fromNode(node({ kind: "nan" }, { error: errorMap(params) })); }
export function file(params?: ErrorParam): ZodFile { return fromNode(node({ kind: "file" }, { error: errorMap(params) })); }

export function literal<const T extends Primitive>(value: T | readonly T[], params?: ErrorParam): ZodLiteral<T> {
  return fromNode(node({ kind: "literal", values: Array.isArray(value) ? value : [value] }, { error: errorMap(params) }));
}
export function enum_<const T extends readonly string[]>(values: T, params?: ErrorParam): $ZodType<T[number], T[number]>;
export function enum_<const T extends Readonly<Record<string, string | number>>>(values: T, params?: ErrorParam): $ZodType<T[keyof T], T[keyof T]>;
export function enum_(values: readonly string[] | Readonly<Record<string, string | number>>, params?: ErrorParam): $ZodType<string | number, string | number> {
  const entries = Array.isArray(values) ? values : [...new Set(Object.values(values).filter((value) => typeof value === "string" || typeof value === "number"))];
  return fromNode(node({ kind: "enum", values: entries }, { error: errorMap(params) }));
}
export const nativeEnum: typeof enum_ = enum_;

/** Define a memoized lazy shape entry. Getter-style recursive shapes
 * (`get self() { return z.array(Self) }`) must not resolve until the referenced
 * schema is bound, so resolution is deferred to first access to avoid a TDZ. */
function defineLazyNode(target: Record<string, SchemaNode>, key: string, resolve: () => SchemaNode): void {
  let cached: SchemaNode | undefined;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get(): SchemaNode { return (cached ??= resolve()); },
  });
}

function resolveShapeNode(source: Readonly<Record<string, SomeType>>, key: string): SchemaNode {
  const entry = source[key];
  if (!entry) throw new Error(`zodrs: object shape entry "${key}" resolved to undefined`);
  return entry._zod.node;
}

function requireNode(shape: Readonly<Record<string, SchemaNode>>, key: string): SchemaNode {
  const found = shape[key];
  if (!found) throw new Error(`zodrs: object shape entry "${key}" missing`);
  return found;
}

/** Build a lazy shape (map of node getters) from a shape of schemas. */
function lazyShapeFromSchemas(source: Readonly<Record<string, SomeType>>): Record<string, SchemaNode> {
  const nodes: Record<string, SchemaNode> = {};
  for (const key of Object.keys(source)) defineLazyNode(nodes, key, () => resolveShapeNode(source, key));
  return nodes;
}

export function object<const S extends Shape = Record<never, SomeType>>(shape?: S, params?: ErrorParam): ZodObject<S> {
  const nodes = lazyShapeFromSchemas((shape ?? {}) as Record<string, SomeType>);
  return fromNode(node({ kind: "object", shape: nodes, mode: "strip", catchall: null }, { error: errorMap(params) }));
}
export function strictObject<const S extends Shape>(shape: S, params?: ErrorParam): ZodObject<S> { return object(shape, params).strict(); }
export function looseObject<const S extends Shape>(shape: S, params?: ErrorParam): ZodObject<S> { return object(shape, params).passthrough(); }
export function array<T extends SomeType>(element: T, params?: ErrorParam): ZodArray<T> { return fromNode(node({ kind: "array", element: element._zod.node }, { error: errorMap(params) })); }
export function tuple<const T extends readonly SomeType[], Rest extends SomeType | null = null>(items: T, restOrParams?: Rest | ErrorParam, params?: ErrorParam): ZodTuple<T, Rest> {
  const rest = restOrParams instanceof $ZodType ? restOrParams : null;
  const error = rest ? params : restOrParams as ErrorParam | undefined;
  return fromNode(node({ kind: "tuple", items: items.map((item) => item._zod.node), rest: rest?._zod.node ?? null }, { error: errorMap(error) }));
}
export function union<const T extends readonly SomeType[]>(options: T, params?: ErrorParam): ZodUnion<T> { return fromNode(node({ kind: "union", options: options.map((option) => option._zod.node) }, { error: errorMap(params) })); }

function discriminantValues(schema: SomeType, key: string): Primitive[] {
  const current = schema._zod.node;
  if (current.kind !== "object") return [];
  const target = current.shape[key];
  if (!target) return [];
  if (target.kind === "literal") return [...target.values];
  if (target.kind === "enum") return [...target.values];
  return [];
}

export function discriminatedUnion<const T extends readonly SomeType[]>(key: string, options: T, params?: ErrorParam): ZodUnion<T> {
  const map = new Map<Primitive, SchemaNode>();
  for (const option of options) for (const value of discriminantValues(option, key)) {
    if (map.has(value)) throw new Error(`Duplicate discriminator value "${String(value)}"`);
    map.set(value, option._zod.node);
  }
  return fromNode(node({ kind: "discunion", key, options: options.map((option) => option._zod.node), map }, { error: errorMap(params) }));
}
export function xor<const T extends readonly SomeType[]>(options: T, params?: ErrorParam): ZodUnion<T> {
  const fn: HostFunction = (value) => options.filter((option) => option.safeParse(value).success).length === 1;
  return fromNode(node({ kind: "host", inner: null, fn, op: "refine" }, { error: errorMap(params) }));
}
export function intersection<A extends SomeType, B extends SomeType>(left: A, right: B): ZodIntersection<A, B> { return fromNode(node({ kind: "intersection", left: left._zod.node, right: right._zod.node })); }
export function record<K extends SomeType, V extends SomeType>(key: K, value: V, params?: ErrorParam): ZodRecord<K, V> { return fromNode(node({ kind: "record", key: key._zod.node, value: value._zod.node }, { error: errorMap(params) })); }
export function map<K extends SomeType, V extends SomeType>(key: K, value: V, params?: ErrorParam): ZodMap<K, V> { return fromNode(node({ kind: "map", key: key._zod.node, value: value._zod.node }, { error: errorMap(params) })); }
export function set<T extends SomeType>(value: T, params?: ErrorParam): ZodSet<T> { return fromNode(node({ kind: "set", value: value._zod.node }, { error: errorMap(params) })); }
export function optional<T extends SomeType>(inner: T): ZodOptional<T> { return inner.optional(); }
export function nullable<T extends SomeType>(inner: T): ZodNullable<T> { return inner.nullable(); }
export function nullish<T extends SomeType>(inner: T): $ZodType<output<T> | null | undefined, input<T> | null | undefined> { return inner.nullish(); }
export function nonoptional<T extends SomeType>(inner: T, params?: ErrorParam): $ZodType<Exclude<output<T>, undefined>, input<T>> { return fromNode(node({ kind: "nonoptional", inner: inner._zod.node }, { error: errorMap(params) })); }
export function readonly<T extends SomeType>(inner: T): ZodReadonly<T> { return inner.readonly(); }
export function promise<T extends SomeType>(inner: T): ZodPromise<T> { return fromNode(node({ kind: "promise", inner: inner._zod.node })); }
export function lazy<T extends SomeType>(getter: () => T): ZodLazy<T> { return fromNode(node({ kind: "lazy", getter: () => getter()._zod.node })); }
export function transform<I = unknown, O = I>(fn: (input: I, context: RefinementCtx<I>) => MaybeAsync<O>): $ZodType<Awaited<O>, I> {
  const host: HostFunction = (value, context) => fn(value as I, context as RefinementCtx<I>);
  return fromNode(node({ kind: "host", inner: null, fn: host, op: "transform" }));
}
export function pipe<A extends SomeType, B extends SomeType>(a: A, b: B): ZodPipe<A, B> { return a.pipe(b); }
export function preprocess<A, U extends SomeType, B = unknown>(fn: (arg: B, context: RefinementCtx<B>) => MaybeAsync<A>, schema: U): $ZodType<output<U>, B> {
  const host: HostFunction = (value, context) => fn(value as B, context as RefinementCtx<B>);
  return fromNode(node({ kind: "pipe", a: node({ kind: "host", inner: null, fn: host, op: "preprocess" }), b: schema._zod.node }));
}
export function custom<O = unknown>(predicate: (data: unknown) => MaybeAsync<unknown> = () => true, params?: ErrorParam): $ZodType<O, O> {
  const host: HostFunction = (value) => predicate(value);
  return fromNode(node({ kind: "host", inner: null, fn: host, op: "refine" }, { error: errorMap(params) }));
}
export function instanceOf<T extends abstract new (...args: never[]) => object>(constructor: T, params?: ErrorParam): $ZodType<InstanceType<T>, InstanceType<T>> {
  return custom<InstanceType<T>>((value) => value instanceof constructor, params ?? `Input not instance of ${constructor.name}`);
}
export function function_(params?: ErrorParam): ZodFunction {
  return fromNode(node({ kind: "function" }, { error: errorMap(params) }));
}
export function stringbool(params: { readonly truthy?: readonly string[]; readonly falsy?: readonly string[]; readonly case?: "sensitive" | "insensitive"; readonly error?: string | $ZodErrorMap } = {}): $ZodType<boolean, string> {
  const truthy = params.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  const falsy = params.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  return string().transform((value, context) => {
    const candidate = params.case === "sensitive" ? value : value.toLowerCase();
    if (truthy.includes(candidate)) return true;
    if (falsy.includes(candidate)) return false;
    context.addIssue({ code: "invalid_value", values: [...truthy, ...falsy], input: value, path: [], message: "" });
    return false;
  });
}

function templatePattern(part: string | number | bigint | boolean | null | SomeType): string {
  if (part instanceof $ZodType) {
    const current = part._zod.node;
    if (current.kind === "literal") return current.values.map((value) => escapeRegex(String(value))).join("|");
    if (current.kind === "enum") return current.values.map((value) => escapeRegex(String(value))).join("|");
    if (current.kind === "number" || current.kind === "bigint") return "-?\\d+(?:\\.\\d+)?";
    if (current.kind === "boolean") return "(?:true|false)";
    if (current.kind === "null") return "null";
    return ".*";
  }
  return escapeRegex(String(part));
}
export function templateLiteral<const Parts extends readonly (string | number | bigint | boolean | null | SomeType)[]>(parts: Parts, params?: ErrorParam): $ZodType<string, string> {
  return fromNode(node({ kind: "templateLiteral", pattern: new RegExp(`^(?:${parts.map(templatePattern).join("")})$`) }, { error: errorMap(params) }));
}

export function codec<A extends SomeType, B extends SomeType>(inputSchema: A, outputSchema: B, handlers: {
  readonly decode: (value: output<A>, context: RefinementCtx<output<A>>) => MaybeAsync<input<B>>;
  readonly encode: (value: input<B>, context: RefinementCtx<input<B>>) => MaybeAsync<output<A>>;
}): $ZodType<output<B>, input<A>> {
  const decodeHost: HostFunction = (value, context) => handlers.decode(value as output<A>, context as RefinementCtx<output<A>>);
  return fromNode(node({ kind: "pipe", codec: true, a: inputSchema._zod.node, b: node({ kind: "pipe", a: node({ kind: "host", inner: null, fn: decodeHost, op: "codec_decode" }), b: outputSchema._zod.node }) }));
}

export const coerce: {
  readonly string: (params?: ErrorParam) => $ZodType<string, unknown>;
  readonly number: (params?: ErrorParam) => $ZodType<number, unknown>;
  readonly bigint: (params?: ErrorParam) => $ZodType<bigint, unknown>;
  readonly boolean: (params?: ErrorParam) => $ZodType<boolean, unknown>;
  readonly date: (params?: ErrorParam) => $ZodType<Date, unknown>;
} = {
  string: (params) => fromNode(node({ kind: "string", coerce: true }, { error: errorMap(params) })),
  number: (params) => fromNode(node({ kind: "number", coerce: true }, { error: errorMap(params) })),
  bigint: (params) => fromNode(node({ kind: "bigint", coerce: true }, { error: errorMap(params) })),
  boolean: (params) => fromNode(node({ kind: "boolean", coerce: true }, { error: errorMap(params) })),
  date: (params) => fromNode(node({ kind: "date", coerce: true }, { error: errorMap(params) })),
};

export function minLength(value: number, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "min_length", v: value }, params); }
export function maxLength(value: number, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "max_length", v: value }, params); }
export function length(value: number, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "length", v: value }, params); }
export function minSize(value: number, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "min_size", v: value }, params); }
export function maxSize(value: number, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "max_size", v: value }, params); }
export function size(value: number, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "size", v: value }, params); }
export function gt(value: number | bigint | Date, params?: ErrorParam): $ZodCheck { const literal = value instanceof Date ? value.getTime() : value; return runtimeCheck({ c: "gt", v: typeof literal === "bigint" ? literal.toString() : literal, inclusive: false, ...(typeof literal === "bigint" ? { bigint: true as const } : {}) }, params); }
export function gte(value: number | bigint | Date, params?: ErrorParam): $ZodCheck { const literal = value instanceof Date ? value.getTime() : value; return runtimeCheck({ c: "gt", v: typeof literal === "bigint" ? literal.toString() : literal, inclusive: true, ...(typeof literal === "bigint" ? { bigint: true as const } : {}) }, params); }
export function lt(value: number | bigint | Date, params?: ErrorParam): $ZodCheck { const literal = value instanceof Date ? value.getTime() : value; return runtimeCheck({ c: "lt", v: typeof literal === "bigint" ? literal.toString() : literal, inclusive: false, ...(typeof literal === "bigint" ? { bigint: true as const } : {}) }, params); }
export function lte(value: number | bigint | Date, params?: ErrorParam): $ZodCheck { const literal = value instanceof Date ? value.getTime() : value; return runtimeCheck({ c: "lt", v: typeof literal === "bigint" ? literal.toString() : literal, inclusive: true, ...(typeof literal === "bigint" ? { bigint: true as const } : {}) }, params); }
export function positive(params?: ErrorParam): $ZodCheck { return gt(0, params); }
export function negative(params?: ErrorParam): $ZodCheck { return lt(0, params); }
export function nonpositive(params?: ErrorParam): $ZodCheck { return lte(0, params); }
export function nonnegative(params?: ErrorParam): $ZodCheck { return gte(0, params); }
export function multipleOf(value: number | bigint, params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "multiple_of", v: typeof value === "bigint" ? value.toString() : value }, params); }
export function int(params?: ErrorParam): $ZodCheck<number> { return runtimeCheck({ c: "number_format", v: "safeint" }, params); }
export function int32(params?: ErrorParam): $ZodCheck<number> { return runtimeCheck({ c: "number_format", v: "int32" }, params); }
export function uint32(params?: ErrorParam): $ZodCheck<number> { return runtimeCheck({ c: "number_format", v: "uint32" }, params); }
export function float32(params?: ErrorParam): $ZodCheck<number> { return runtimeCheck({ c: "number_format", v: "float32" }, params); }
export function float64(params?: ErrorParam): $ZodCheck<number> { return runtimeCheck({ c: "number_format", v: "float64" }, params); }
export function int64(params?: ErrorParam): $ZodCheck<bigint> { return runtimeCheck({ c: "bigint_format", v: "int64" }, params); }
export function uint64(params?: ErrorParam): $ZodCheck<bigint> { return runtimeCheck({ c: "bigint_format", v: "uint64" }, params); }
export function regex(value: RegExp, params?: ErrorParam): $ZodCheck<string> { return runtimeCheck({ c: "regex", src: value.source, flags: value.flags }, params); }
export function lowercase(params?: ErrorParam): $ZodCheck<string> { return runtimeCheck({ c: "lowercase" }, params); }
export function uppercase(params?: ErrorParam): $ZodCheck<string> { return runtimeCheck({ c: "uppercase" }, params); }
export function includes(value: string, params?: ErrorParam & { readonly position?: number }): $ZodCheck<string> { return runtimeCheck({ c: "includes", v: value, ...(typeof params === "object" && params.position !== undefined ? { position: params.position } : {}) }, params); }
export function startsWith(value: string, params?: ErrorParam): $ZodCheck<string> { return runtimeCheck({ c: "starts_with", v: value }, params); }
export function endsWith(value: string, params?: ErrorParam): $ZodCheck<string> { return runtimeCheck({ c: "ends_with", v: value }, params); }
export function trim(): $ZodCheck<string> { return runtimeCheck({ c: "overwrite", op: "trim" }); }
export function toLowerCase(): $ZodCheck<string> { return runtimeCheck({ c: "overwrite", op: "toLowerCase" }); }
export function toUpperCase(): $ZodCheck<string> { return runtimeCheck({ c: "overwrite", op: "toUpperCase" }); }
export function normalize(form?: string): $ZodCheck<string> { return runtimeCheck({ c: "overwrite", op: "normalize", ...(form ? { form } : {}) }); }
export function slugify(): $ZodCheck<string> { return runtimeCheck({ c: "overwrite", op: "slugify" }); }
export function mime(value: string | readonly string[], params?: ErrorParam): $ZodCheck { return runtimeCheck({ c: "mime", v: typeof value === "string" ? [value] : [...value] }, params); }
export function property(key: string, schema: SomeType): $ZodCheck { return runtimeCheck({ c: "property", key, schema: schema._zod.node }); }
export function overwrite<T>(fn: (value: T) => T): $ZodCheck<T> { const host: HostFunction = (value) => fn(value as T); return runtimeCheck({ c: "host_runtime", op: "overwrite", fn: host }); }
export function format(id: FormatId, params?: ErrorParam, formatParams?: Readonly<Record<string, unknown>>): $ZodCheck<string> { return runtimeCheck({ c: "format", v: id, ...(formatParams ? { params: { ...formatParams } } : {}) }, params); }

function formatted(id: FormatId, params?: ErrorParam, formatParams?: Readonly<Record<string, unknown>>): ZodString { return string().check(format(id, params, formatParams)); }
export function email(params?: ErrorParam): ZodString { return formatted("email", params); }
export function guid(params?: ErrorParam): ZodString { return formatted("guid", params); }
export function uuid(params?: ErrorParam): ZodString { return formatted("uuid", params); }
export function uuidv4(params?: ErrorParam): ZodString { return formatted("uuidv4", params); }
export function uuidv6(params?: ErrorParam): ZodString { return formatted("uuidv6", params); }
export function uuidv7(params?: ErrorParam): ZodString { return formatted("uuidv7", params); }
export function url(params?: ErrorParam): ZodString { return formatted("url", params); }
export function httpUrl(params?: ErrorParam): ZodString { return formatted("httpUrl", params); }
export function hostname(params?: ErrorParam): ZodString { return formatted("hostname", params); }
export function emoji(params?: ErrorParam): ZodString { return formatted("emoji", params); }
export function nanoid(params?: ErrorParam): ZodString { return formatted("nanoid", params); }
export function cuid(params?: ErrorParam): ZodString { return formatted("cuid", params); }
export function cuid2(params?: ErrorParam): ZodString { return formatted("cuid2", params); }
export function ulid(params?: ErrorParam): ZodString { return formatted("ulid", params); }
export function xid(params?: ErrorParam): ZodString { return formatted("xid", params); }
export function ksuid(params?: ErrorParam): ZodString { return formatted("ksuid", params); }
export function ipv4(params?: ErrorParam): ZodString { return formatted("ipv4", params); }
export function ipv6(params?: ErrorParam): ZodString { return formatted("ipv6", params); }
export function mac(params?: ErrorParam & { readonly delimiter?: string }): ZodString { return formatted("mac", params, typeof params === "object" ? { delimiter: params.delimiter } : undefined); }
export function cidrv4(params?: ErrorParam): ZodString { return formatted("cidrv4", params); }
export function cidrv6(params?: ErrorParam): ZodString { return formatted("cidrv6", params); }
export function base64(params?: ErrorParam): ZodString { return formatted("base64", params); }
export function base64url(params?: ErrorParam): ZodString { return formatted("base64url", params); }
export function e164(params?: ErrorParam): ZodString { return formatted("e164", params); }
export function jwt(params?: ErrorParam): ZodString { return formatted("jwt", params); }
export function hex(params?: ErrorParam): ZodString { return formatted("hex", params); }
export function md5(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("md5", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha1(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha1", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha256(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha256", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha384(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha384", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha512(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha512", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function stringFormat(name: string, validator: RegExp | ((value: string) => MaybeAsync<unknown>), params?: ErrorParam): ZodString {
  return validator instanceof RegExp ? string().regex(validator, params) : string().refine(validator, params);
}

export const iso: {
  readonly datetime: (params?: ErrorParam & { readonly precision?: number | null; readonly offset?: boolean; readonly local?: boolean }) => ZodString;
  readonly date: (params?: ErrorParam) => ZodString;
  readonly time: (params?: ErrorParam & { readonly precision?: number | null }) => ZodString;
  readonly duration: (params?: ErrorParam) => ZodString;
} = {
  datetime: (params) => formatted("datetime", params, typeof params === "object" ? params : undefined),
  date: (params) => formatted("date", params),
  time: (params) => formatted("time", params, typeof params === "object" ? params : undefined),
  duration: (params) => formatted("duration", params),
};


export function toJSONSchema(schema: SomeType, params?: ToJSONSchemaParams): JSONSchema { return coreToJSONSchema(schema, params); }
export function clone<T extends SomeType>(schema: T, definition?: SchemaNode): T { return schema.clone(definition); }
export function parse<T extends SomeType>(schema: T, value: unknown, params?: ParseContext): output<T> { return schema.parse(value, params); }
export function safeParse<T extends SomeType>(schema: T, value: unknown, params?: ParseContext): SafeParseResult<output<T>> { return schema.safeParse(value, params); }
export function parseAsync<T extends SomeType>(schema: T, value: unknown, params?: ParseContext): Promise<output<T>> { return schema.parseAsync(value, params); }
export function safeParseAsync<T extends SomeType>(schema: T, value: unknown, params?: ParseContext): Promise<SafeParseResult<output<T>>> { return schema.safeParseAsync(value, params); }
export function encode<T extends SomeType>(schema: T, value: output<T>, params?: ParseContext): input<T> { return schema.encode(value, params); }
export function decode<T extends SomeType>(schema: T, value: input<T>, params?: ParseContext): output<T> { return schema.decode(value, params); }
export function safeEncode<T extends SomeType>(schema: T, value: output<T>, params?: ParseContext): SafeParseResult<input<T>> { return schema.safeEncode(value, params); }
export function safeDecode<T extends SomeType>(schema: T, value: input<T>, params?: ParseContext): SafeParseResult<output<T>> { return schema.safeDecode(value, params); }
export function encodeAsync<T extends SomeType>(schema: T, value: output<T>, params?: ParseContext): Promise<input<T>> { return schema.encodeAsync(value, params); }
export function decodeAsync<T extends SomeType>(schema: T, value: input<T>, params?: ParseContext): Promise<output<T>> { return schema.decodeAsync(value, params); }
export function safeEncodeAsync<T extends SomeType>(schema: T, value: output<T>, params?: ParseContext): Promise<SafeParseResult<input<T>>> { return schema.safeEncodeAsync(value, params); }
export function safeDecodeAsync<T extends SomeType>(schema: T, value: input<T>, params?: ParseContext): Promise<SafeParseResult<output<T>>> { return schema.safeDecodeAsync(value, params); }
export function parseJson<T extends SomeType>(schema: T, value: Uint8Array | ArrayBuffer | string, params?: ParseContext): output<T> { return schema.parseJson(value, params); }
export function safeParseJson<T extends SomeType>(schema: T, value: Uint8Array | ArrayBuffer | string, params?: ParseContext): SafeParseResult<output<T>> { return schema.safeParseJson(value, params); }

export const NEVER: Readonly<{ status: "aborted" }> = Object.freeze({ status: "aborted" });
export const TimePrecision: Readonly<{ minute: -1; second: 0; millisecond: 3; microsecond: 6 }> = { minute: -1, second: 0, millisecond: 3, microsecond: 6 };
export const regexes: Readonly<Record<string, RegExp>> = {};
export function json(params?: ErrorParam): SomeType {
  const valid = (value: unknown): boolean => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    || Array.isArray(value) && value.every(valid)
    || isObject(value) && Object.values(value).every(valid);
  return custom<JSONType>(valid, params);
}
