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
import { bagOf, optinOf, optoutOf, patternOf, propValuesOf, valuesOf } from "../core/introspect.js";
import { patternForFormat } from "../core/formats.js";
import { REGEXES } from "../core/formats.js";
import * as parsing from "../core/parse.js";
import type { RuntimeSchema, SafeParseResult } from "../core/parse.js";
import { compilePlan } from "../core/plan.js";
import { toJSONSchema as coreToJSONSchema } from "../core/json-schema.js";
import type { JSONSchema } from "../core/json-schema-types.js";
import type { ToJSONSchemaParams } from "../core/json-schema.js";
import { globalRegistry } from "../core/registries.js";
import type { $ZodRegistry, $replace, GlobalMeta } from "../core/registries.js";
import { createStandardProps } from "../core/standard-schema.js";
import type { StandardJSONSchemaV1, StandardSchemaV1, StandardSchemaWithJSONProps } from "../core/standard-schema.js";
import { escapeRegex, FAIL, isObject } from "../core/util.js";
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
  readonly def: SchemaDef;
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
  /** Gate: run the check only when this returns true (bypasses abort short-circuit). */
  readonly when?: ((payload: { value: unknown; issues: $ZodIssue[] }) => boolean) | undefined;
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
      when: extra?.when as RuntimeCheck["when"],
    },
  };
}


function checksOf(values: readonly ($ZodCheck | RuntimeCheck | ((payload: { value: unknown; issues: $ZodIssue[] }) => MaybeAsync<void>))[]): RuntimeCheck[] {
  return values.map((value) => {
    if (typeof value === "function") {
      const fn: HostFunction = (input, context) => value({ value: input, issues: context.issues as $ZodIssue[] });
      return { check: { c: "host_runtime", op: "check", fn } };
    }
    if (value instanceof $ZodType) {
      // A passed SCHEMA becomes a host check that runs the schema's raw validator so
      // any produced issues stay in raw (unfinalized) form for the outer context.
      const fn: HostFunction = (input, context) => {
        const sub: ValidationContext = { ...context, issues: null, async: false };
        const result = value._zod.validate(input, sub);
        if (result === FAIL) {
          for (const raw of sub.issues ?? []) context.addIssue(raw);
        }
      };
      return { check: { c: "host_runtime", op: "check", fn } };
    }
    if (value && typeof value === "object" && "_zod" in value) return (value as $ZodCheck)._zod;
    return value as RuntimeCheck;
  });
}

const schemaByNode = new WeakMap<SchemaNode, $ZodType>();

declare const process: { readonly env: Record<string, string | undefined> } | undefined;

/** Conformance tier switch: `ZODRS_BACKEND=interpreter` forces the tree-walking
 *  interpreter for every schema, mirroring how `ZODRS_LOADER` switches loaders. */
const FORCE_INTERPRETER = typeof process !== "undefined" && process.env?.["ZODRS_BACKEND"] === "interpreter";
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

/** Zod v4-style `.def` facade: the raw `SchemaNode` plus a `type` string (the
 * kind) and lazy structural accessors that surface child schemas as full
 * `$ZodType` instances. Non-generic so phantom `$ZodType<Output,Input>` types
 * are unaffected. The intersection with `SchemaNode` keeps `_zod.def`
 * compatible with code that reads raw node fields (kind, checks, inner, …). */
export type SchemaDef = SchemaNode & {
  readonly type: string;
  readonly keyType?: $ZodType;
  readonly valueType?: $ZodType;
  readonly entries?: Readonly<Record<string, string | number>>;
  readonly discriminator?: string;
  readonly innerType?: $ZodType;
  readonly in?: $ZodType;
  readonly out?: $ZodType;
};

/** Build a lazy `SchemaDef` facade for a node. The node's own enumerable props
 * are copied via `Object.assign` (kind, checks, inner, a, b, mode, pattern,
 * values, …); accessors are defined as lazy getters that only construct child
 * schemas on first access, so `makeDef` never recurses during construction. */
function makeDef(node: SchemaNode): SchemaDef {
  const facade = Object.assign({}, node, { type: node.kind }) as SchemaDef;
  Object.defineProperties(facade, {
    keyType: { enumerable: true, configurable: true, get: () => node.kind === "record" || node.kind === "map" ? childSchema(node.key) : never() },
    valueType: { enumerable: true, configurable: true, get: () => { const n = node; return n.kind === "record" || n.kind === "map" || n.kind === "set" ? childSchema(n.value) : never(); } },
    element: { enumerable: true, configurable: true, get: () => node.kind === "array" ? childSchema(node.element) : never() },
    shape: { enumerable: true, configurable: true, get: () => { const n = node; return n.kind === "object" ? Object.fromEntries(Object.entries(n.shape).map(([k, child]) => [k, childSchema(child)])) : {}; } },
    catchall: { enumerable: true, configurable: true, get: () => { const n = node; if (n.kind !== "object") return undefined; if (n.catchall) return childSchema(n.catchall); if (n.mode === "strict") return never(); if (n.mode === "passthrough") return unknown(); return undefined; } },
    entries: { enumerable: true, configurable: true, get: () => { const n = node; return n.kind === "enum" ? Object.fromEntries(n.values.map((v) => [v, v] as const)) : undefined; } },
    discriminator: { enumerable: true, configurable: true, get: () => { const n = node; return n.kind === "discunion" ? n.key : undefined; } },
    innerType: { enumerable: true, configurable: true, get: () => { const n = node; if (n.kind === "optional" || n.kind === "exactOptional" || n.kind === "nullable" || n.kind === "nonoptional" || n.kind === "readonly" || n.kind === "promise" || n.kind === "default" || n.kind === "prefault" || n.kind === "catch") return childSchema(n.inner); if (n.kind === "host" && n.inner) return childSchema(n.inner); return undefined; } },
    in: { enumerable: true, configurable: true, get: () => node.kind === "pipe" ? childSchema(node.a) : never() },
    out: { enumerable: true, configurable: true, get: () => node.kind === "pipe" ? childSchema(node.b) : never() },
    options: { enumerable: true, configurable: true, get: () => { const n = node; return n.kind === "union" || n.kind === "discunion" ? n.options.map(childSchema) : []; } },
    items: { enumerable: true, configurable: true, get: () => { const n = node; return n.kind === "tuple" ? n.items.map(childSchema) : []; } },
    pattern: { enumerable: true, configurable: true, get: () => {
      let found: RegExp | undefined;
      for (const runtime of node.checks) {
        const check = runtime.check;
        if (check.c === "format") { const p = patternForFormat(check.v, check.params); if (p) found = p; }
        else if (check.c === "host_runtime" && check.op === "custom_format" && check.pattern) found = check.pattern;
      }
      return found;
    } },
  });
  return facade;
}

type AnyInternals = SchemaInternals<unknown, unknown>;

function shadowData(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

/**
 * Shared lazy accessors for `_zod` internals: one descriptor set serves every
 * schema instance, so construction allocates zero getter closures. Each
 * accessor self-shadows with a plain data property on first read, so hot
 * paths (`_zod.validate` on every parse) pay the accessor exactly once.
 */
const INTERNALS_ACCESSORS: PropertyDescriptorMap = {
  def: {
    get(this: AnyInternals): SchemaDef {
      const facade = makeDef(this.node);
      shadowData(this, "def", facade);
      return facade;
    },
    configurable: true, enumerable: true,
  },
  validate: {
    get(this: AnyInternals) {
      const compiled = CODEGEN_AVAILABLE && !FORCE_INTERPRETER && !config().jitless
        ? createCodegenValidator(this.node)
        : createInterpreter(this.node);
      shadowData(this, "validate", compiled);
      return compiled;
    },
    configurable: true,
  },
  validateAsync: {
    get(this: AnyInternals) {
      const compiled = createAsyncInterpreter(this.node);
      shadowData(this, "validateAsync", compiled);
      return compiled;
    },
    configurable: true,
  },
  plan: {
    get(this: AnyInternals) {
      const compiled = compilePlan(this.node);
      shadowData(this, "plan", compiled);
      return compiled;
    },
    configurable: true,
  },
  values: {
    get(this: AnyInternals) {
      const computed = valuesOf(this.node);
      shadowData(this, "values", computed);
      return computed;
    },
    configurable: true,
  },
  propValues: {
    get(this: AnyInternals) {
      const computed = propValuesOf(this.node);
      shadowData(this, "propValues", computed);
      return computed;
    },
    configurable: true,
  },
  optin: {
    get(this: AnyInternals) {
      const computed = optinOf(this.node);
      shadowData(this, "optin", computed);
      return computed;
    },
    configurable: true,
  },
  optout: {
    get(this: AnyInternals) {
      const computed = optoutOf(this.node);
      shadowData(this, "optout", computed);
      return computed;
    },
    configurable: true,
  },
  pattern: {
    get(this: AnyInternals) {
      const computed = patternOf(this.node);
      shadowData(this, "pattern", computed);
      return computed;
    },
    configurable: true,
  },
  innerType: {
    get(this: AnyInternals) {
      const current = this.node;
      const computed = current.kind === "lazy"
        ? childSchema(current.getter())
        : "inner" in current && current.inner
          ? childSchema(current.inner)
          : undefined;
      shadowData(this, "innerType", computed);
      return computed;
    },
    configurable: true,
  },
};

/* Method-syntax function types reproduce the original prototype methods'
 * bivariant parameter checking (property-of-function types are contravariant
 * under strictFunctionTypes, which would break `$ZodType<string>` ⊆
 * `$ZodType<unknown>` for the encode family whose `data` is the Output type). */
type EncodeMethod<O, I> = { m(data: O, params?: ParseContext): I }["m"];
type DecodeMethod<O, I> = { m(data: I, params?: ParseContext): O }["m"];
type SafeDecodeMethod<O, I> = { m(data: I, params?: ParseContext): SafeParseResult<O> }["m"];
type DecodeAsyncMethod<O, I> = { m(data: I, params?: ParseContext): Promise<O> }["m"];
type SafeDecodeAsyncMethod<O, I> = { m(data: I, params?: ParseContext): Promise<SafeParseResult<O>> }["m"];
type SafeEncodeMethod<O, I> = { m(data: O, params?: ParseContext): SafeParseResult<I> }["m"];
type EncodeAsyncMethod<O, I> = { m(data: O, params?: ParseContext): Promise<I> }["m"];
type SafeEncodeAsyncMethod<O, I> = { m(data: O, params?: ParseContext): Promise<SafeParseResult<I>> }["m"];

/** Bind a parse-family entry point as an enumerable own data property on
 *  first access: detached usage (`const { parse } = schema`) then holds a
 *  closure bound to this instance, and construction stays closure-free. */
function shadowParseMethod(inst: object, key: string, fn: unknown): void {
  Object.defineProperty(inst, key, { value: fn, configurable: true, writable: true, enumerable: true });
}

/** Shared `def`/`_def` accessor on schema instances: builds the facade lazily
 *  through `_zod.def` and self-shadows both properties. */
const SCHEMA_DEF_ACCESSOR: PropertyDescriptor = {
  get(this: $ZodType): SchemaDef {
    const facade = this._zod.def;
    shadowData(this, "def", facade);
    shadowData(this, "_def", facade);
    return facade;
  },
  configurable: true, enumerable: true,
};

export class $ZodType<Output = unknown, Input = Output> implements RuntimeSchema<Output, Input> {
  readonly _zod: SchemaInternals<Output, Input>;
  declare readonly def: SchemaDef;
  declare readonly _def: SchemaDef;
  readonly type: SchemaNode["kind"];
  readonly "~standard": StandardSchemaWithJSONProps<Input, Output>;

  constructor(schemaNode: SchemaNode, parent?: $ZodType) {
    // Compilation is deferred to first use so self-referential schemas
    // (`const N = z.object({ next: z.lazy(() => N) })`) don't recurse into their
    // own lazy getters during construction (which would throw a TDZ error).
    // Every derived property (def facade, compiled validators, plan) is a
    // shared lazy accessor that self-shadows on first read, so construction
    // allocates no getter closures per instance.
    const internals = {
      output: undefined as Output,
      input: undefined as Input,
      node: schemaNode,
      parent,
      nativeHandle: null,
    } as SchemaInternals<Output, Input>;
    Object.defineProperties(internals, INTERNALS_ACCESSORS);
    this._zod = internals;
    Object.defineProperties(this, { def: SCHEMA_DEF_ACCESSOR, _def: SCHEMA_DEF_ACCESSOR });
    this.type = schemaNode.kind;
    this["~standard"] = createStandardProps<Input, Output>({
      safeParse: (value) => this.safeParse(value),
      safeParseAsync: (value) => this.safeParseAsync(value),
    }) as StandardSchemaWithJSONProps<Input, Output>;
    // StandardJSONSchemaV1: expose jsonSchema.input/output on every schema.
    Object.assign(this["~standard"], {
      jsonSchema: {
        input: (options: StandardJSONSchemaV1.Options) => coreToJSONSchema(this, { target: options.target as ToJSONSchemaParams["target"], io: "input", ...(options.libraryOptions ?? {}) }),
        output: (options: StandardJSONSchemaV1.Options) => coreToJSONSchema(this, { target: options.target as ToJSONSchemaParams["target"], io: "output", ...(options.libraryOptions ?? {}) }),
      },
    });
    schemaByNode.set(schemaNode, this);
    // Parse-family entry points are prototype accessors that bind an own
    // closure on first access (see below): detached usage
    // (`const { parse } = schema`) works identically, while construction
    // allocates zero closures for schemas that never parse.
  }

  get parse(): (data: unknown, params?: ParseContext) => Output {
    const fn = (data: unknown, params?: ParseContext) => parsing.parse(this, data, params);
    shadowParseMethod(this, "parse", fn);
    return fn;
  }
  get safeParse(): (data: unknown, params?: ParseContext) => SafeParseResult<Output> {
    const fn = (data: unknown, params?: ParseContext) => parsing.safeParse(this, data, params);
    shadowParseMethod(this, "safeParse", fn);
    return fn;
  }
  get parseAsync(): (data: unknown, params?: ParseContext) => Promise<Output> {
    const fn = (data: unknown, params?: ParseContext) => parsing.parseAsync(this, data, params);
    shadowParseMethod(this, "parseAsync", fn);
    return fn;
  }
  get safeParseAsync(): (data: unknown, params?: ParseContext) => Promise<SafeParseResult<Output>> {
    const fn = (data: unknown, params?: ParseContext) => parsing.safeParseAsync(this, data, params);
    shadowParseMethod(this, "safeParseAsync", fn);
    return fn;
  }
  get spa(): (data: unknown, params?: ParseContext) => Promise<SafeParseResult<Output>> {
    const fn = this.safeParseAsync;
    shadowParseMethod(this, "spa", fn);
    return fn;
  }
  get parseJson(): (data: Uint8Array | ArrayBuffer | string, params?: ParseContext) => Output {
    const fn = (data: Uint8Array | ArrayBuffer | string, params?: ParseContext) => parsing.parseJson(this, data, params);
    shadowParseMethod(this, "parseJson", fn);
    return fn;
  }
  get safeParseJson(): (data: Uint8Array | ArrayBuffer | string, params?: ParseContext) => SafeParseResult<Output> {
    const fn = (data: Uint8Array | ArrayBuffer | string, params?: ParseContext) => parsing.safeParseJson(this, data, params);
    shadowParseMethod(this, "safeParseJson", fn);
    return fn;
  }
  get encode(): EncodeMethod<Output, Input> {
    const fn = (data: Output, params?: ParseContext) => parsing.encode(this, data, params);
    shadowParseMethod(this, "encode", fn);
    return fn;
  }
  get decode(): DecodeMethod<Output, Input> {
    const fn = (data: Input, params?: ParseContext) => parsing.decode(this, data, params);
    shadowParseMethod(this, "decode", fn);
    return fn;
  }
  get encodeAsync(): EncodeAsyncMethod<Output, Input> {
    const fn = (data: Output, params?: ParseContext) => parsing.encodeAsync(this, data, params);
    shadowParseMethod(this, "encodeAsync", fn);
    return fn;
  }
  get decodeAsync(): DecodeAsyncMethod<Output, Input> {
    const fn = (data: Input, params?: ParseContext) => parsing.decodeAsync(this, data, params);
    shadowParseMethod(this, "decodeAsync", fn);
    return fn;
  }
  get safeEncode(): SafeEncodeMethod<Output, Input> {
    const fn = (data: Output, params?: ParseContext) => parsing.safeEncode(this, data, params);
    shadowParseMethod(this, "safeEncode", fn);
    return fn;
  }
  get safeDecode(): SafeDecodeMethod<Output, Input> {
    const fn = (data: Input, params?: ParseContext) => parsing.safeDecode(this, data, params);
    shadowParseMethod(this, "safeDecode", fn);
    return fn;
  }
  get safeEncodeAsync(): SafeEncodeAsyncMethod<Output, Input> {
    const fn = (data: Output, params?: ParseContext) => parsing.safeEncodeAsync(this, data, params);
    shadowParseMethod(this, "safeEncodeAsync", fn);
    return fn;
  }
  get safeDecodeAsync(): SafeDecodeAsyncMethod<Output, Input> {
    const fn = (data: Input, params?: ParseContext) => parsing.safeDecodeAsync(this, data, params);
    shadowParseMethod(this, "safeDecodeAsync", fn);
    return fn;
  }

  check(...values: readonly ($ZodCheck<Output> | RuntimeCheck | SomeType | ((payload: { value: Output; issues: $ZodIssue[] }) => MaybeAsync<void>))[]): this {
    const runtimes = checksOf(values as readonly AnyCheckInput[]);
    const next = cloneNode(this._zod.node, { checks: [...this._zod.node.checks, ...runtimes] });
    const result = fromNode(next, this);
    for (const runtime of runtimes) runtime.attach?.(result);
    return result as this;
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

  optional(): $ZodType<Output | undefined, Input | undefined> { return fromNode(node({ kind: "optional", inner: this._zod.node })); }
  exactOptional(): $ZodType<Output | undefined, Input | undefined> { return fromNode(node({ kind: "exactOptional", inner: this._zod.node })); }
  nonoptional(params?: ErrorParam): $ZodType<Exclude<Output, undefined>, Input> { return fromNode(node({ kind: "nonoptional", inner: this._zod.node }, { error: errorMap(params) })); }
  nullable(): $ZodType<Output | null, Input | null> { return fromNode(node({ kind: "nullable", inner: this._zod.node })); }
  nullish(): $ZodType<Output | null | undefined, Input | null | undefined> { return this.nullable().optional(); }
  array(): $ZodType<Output[], Input[]> { return array(this); }
  or<T extends SomeType>(option: T): $ZodType<Output | output<T>, Input | input<T>> { return union([this, option]); }
  and<T extends SomeType>(incoming: T): $ZodType<Output & output<T>, Input & input<T>> { return intersection(this, incoming); }
  transform<NewOutput>(fn: (arg: Output, context: RefinementCtx<Output>) => MaybeAsync<NewOutput>): $ZodType<Awaited<NewOutput>, Input> {
    const host: HostFunction = (value, context) => fn(value as Output, context as RefinementCtx<Output>);
    // Match Zod: `.transform` is `pipe(this, transform(fn))`, so the result is a
    // ZodPipe whose `.out` is a standalone ZodTransform node.
    const transformNode = node({ kind: "host", inner: null, fn: host, op: "transform" });
    return fromNode(node({ kind: "pipe", a: this._zod.node, b: transformNode }));
  }
  default(value: NoUndefined<Output> | (() => NoUndefined<Output>)): $ZodType<Exclude<Output, undefined>, Input | undefined> {
    return fromNode(node({ kind: "default", inner: this._zod.node, value, dynamic: typeof value === "function" }));
  }
  prefault(value: Input | (() => Input)): $ZodType<Output, Input | undefined> {
    return fromNode(node({ kind: "prefault", inner: this._zod.node, value, dynamic: typeof value === "function" }));
  }
  catch(value: Output | ((context: { readonly error: unknown; readonly input: unknown }) => Output)): $ZodType<Output, Input> {
    return fromNode(node({ kind: "catch", inner: this._zod.node, value, dynamic: typeof value === "function" }));
  }
  pipe<T extends SomeType>(target: T): $ZodType<output<T>, Input> { return fromNode(node({ kind: "pipe", a: this._zod.node, b: target._zod.node })); }
  readonly(): $ZodType<Readonly<Output>, Input> { return fromNode(node({ kind: "readonly", inner: this._zod.node })); }

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
  get enum(): Record<string, string | number> | undefined {
    const definition = this._zod.node;
    if (definition.kind !== "enum") return undefined;
    const entries: Record<string, string | number> = {};
    for (const value of definition.values) entries[String(value)] = value;
    return entries;
  }
  get value(): unknown {
    const definition = this._zod.node;
    if (definition.kind !== "literal") return undefined;
    if (definition.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
    return definition.values[0];
  }
  get values(): ReadonlySet<unknown> | undefined { return valuesOf(this._zod.node); }
  extract(values: readonly unknown[], params?: ErrorParam): unknown {
    const definition = this._zod.node;
    if (definition.kind !== "enum") return this;
    const selected = new Set<unknown>(values);
    const kept = definition.values.filter((value) => selected.has(value));
    const resolved = errorMap(params) ?? definition.error;
    return fromNode(node({ kind: "enum", values: kept }, { error: resolved }), this);
  }
  exclude(values: readonly unknown[], params?: ErrorParam): unknown {
    const definition = this._zod.node;
    if (definition.kind !== "enum") return this;
    const skipped = new Set<unknown>(values);
    const kept = definition.values.filter((value) => !skipped.has(value));
    const resolved = errorMap(params) ?? definition.error;
    return fromNode(node({ kind: "enum", values: kept }, { error: resolved }), this);
  }
  get format(): string | null { return bagOf(this._zod.node)["format"] as string ?? null; }
  get minLength(): number | null { return bagOf(this._zod.node)["minimum"] as number ?? null; }
  get maxLength(): number | null { return bagOf(this._zod.node)["maximum"] as number ?? null; }
  get minDate(): Date | null {
    const minimum = bagOf(this._zod.node)["minimum"] as number | undefined;
    return minimum === undefined ? null : new Date(minimum);
  }
  get maxDate(): Date | null {
    const maximum = bagOf(this._zod.node)["maximum"] as number | undefined;
    return maximum === undefined ? null : new Date(maximum);
  }
  get minValue(): number | bigint | Date | null {
    const bag = bagOf(this._zod.node);
    const minimum = bag["minimum"] as number | bigint | undefined;
    const exclusive = bag["exclusiveMinimum"] as number | bigint | undefined;
    let candidate = minimum;
    if (candidate === undefined || (exclusive !== undefined && exclusive > candidate)) candidate = exclusive;
    if (candidate === undefined) return null;
    if (this._zod.node.kind === "date") return new Date(Number(candidate));
    return candidate;
  }
  get maxValue(): number | bigint | Date | null {
    const bag = bagOf(this._zod.node);
    const maximum = bag["maximum"] as number | bigint | undefined;
    const exclusive = bag["exclusiveMaximum"] as number | bigint | undefined;
    let candidate = maximum;
    if (candidate === undefined || (exclusive !== undefined && exclusive < candidate)) candidate = exclusive;
    if (candidate === undefined) return null;
    if (this._zod.node.kind === "date") return new Date(Number(candidate));
    return candidate;
  }
  get isInt(): boolean {
    const kind = this._zod.node.kind;
    if (kind === "bigint") return true;
    if (kind !== "number") return false;
    const fmt = bagOf(this._zod.node)["format"] as string | undefined;
    if (fmt && fmt.includes("int")) return true;
    return Number.isSafeInteger(bagOf(this._zod.node)["multipleOf"] as number | undefined ?? 0.5);
  }
  get isFinite(): boolean {
    const kind = this._zod.node.kind;
    if (kind === "number" || kind === "bigint") return true;
    const bag = bagOf(this._zod.node);
    return bag["maximum"] !== undefined || bag["minimum"] !== undefined;
  }
  apply<T>(fn: (schema: this) => T): T { return fn(this); }

  min(value: number | bigint | Date, params?: ErrorParam): this {
    const kind = this._zod.node.kind;
    if (kind === "string" || kind === "array") return this.check(minLength(Number(value), params));
    if (kind === "set" || kind === "map" || kind === "file") return this.check(minSize(Number(value), params));
    return this.check(gte(value, params));
  }
  max(value: number | bigint | Date, params?: ErrorParam): this {
    const kind = this._zod.node.kind;
    if (kind === "string" || kind === "array") return this.check(maxLength(Number(value), params));
    if (kind === "set" || kind === "map" || kind === "file") return this.check(maxSize(Number(value), params));
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
  int(params?: ErrorParam): this { return this.check(intCheck(params)); }
  safe(params?: ErrorParam): this { return this.check(intCheck(params)); }
  finite(params?: ErrorParam): this { return this.refine((value) => typeof value === "number" && Number.isFinite(value), params); }

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
  url(params?: ErrorParam & { readonly hostname?: RegExp; readonly protocol?: RegExp; readonly normalize?: boolean }): this { return this.check(format("url", params, urlFormatParams(params))); }
  jwt(params?: ErrorParam & { readonly alg?: string }): this { return this.check(format("jwt", params, typeof params === "object" && params.alg !== undefined ? { alg: params.alg } : undefined)); }
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
  ipv4(params?: ErrorParam): this { return this.check(format("ipv4", params)); }
  ipv6(params?: ErrorParam): this { return this.check(format("ipv6", params)); }
  cidrv4(params?: ErrorParam): this { return this.check(format("cidrv4", params)); }
  cidrv6(params?: ErrorParam): this { return this.check(format("cidrv6", params)); }
  e164(params?: ErrorParam): this { return this.check(format("e164", params)); }
  mac(params?: ErrorParam): this { return this.check(format("mac", params)); }
  hex(params?: ErrorParam): this { return this.check(format("hex", params)); }
  hash(algorithm: string, params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): this { return this.check(format(algorithm as FormatId, params, typeof params === "object" ? { enc: params.enc } : undefined)); }
  httpUrl(params?: ErrorParam & { readonly hostname?: RegExp; readonly protocol?: RegExp; readonly normalize?: boolean }): this { return this.check(format("httpUrl", params, urlFormatParams(params))); }
  hostname(params?: ErrorParam): this { return this.check(format("hostname", params)); }
  duration(params?: ErrorParam): this { return this.check(format("duration", params)); }
  date(params?: ErrorParam): this { return this.check(format("date", params)); }
  time(params?: ErrorParam & { readonly precision?: number | null }): this { return this.check(format("time", params, typeof params === "object" ? params : undefined)); }
  datetime(params?: ErrorParam & { readonly precision?: number | null; readonly offset?: boolean; readonly local?: boolean }): this { return this.check(format("datetime", params, typeof params === "object" ? params : undefined)); }
  int32(params?: ErrorParam): this { return this.check(int32Check(params)); }
  uint32(params?: ErrorParam): this { return this.check(uint32Check(params)); }
  float32(params?: ErrorParam): this { return this.check(float32Check(params)); }
  float64(params?: ErrorParam): this { return this.check(float64Check(params)); }
  int64(params?: ErrorParam): this { return this.check(int64Check(params)); }
  uint64(params?: ErrorParam): this { return this.check(uint64Check(params)); }
  jsonString(params?: ErrorParam): this {
    const inner = json();
    const parseHost: HostFunction = (value, context) => {
      try { return JSON.parse(value as string); } catch {
        context.addIssue({ code: "custom", message: "Invalid JSON", input: value } as never);
        return undefined;
      }
    };
    return fromNode(node({ kind: "pipe", a: this._zod.node, b: node({ kind: "pipe", a: node({ kind: "host", inner: null, fn: parseHost, op: "transform" }), b: inner._zod.node }) }), this) as this;
  }

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
    if (this._zod.node.checks.length > 0) {
      for (const key of Object.keys(extShape)) {
        if (Object.prototype.hasOwnProperty.call(baseShape, key)) {
          throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
        }
      }
    }
    const merged: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) defineLazyNode(merged, key, () => requireNode(baseShape, key));
    for (const key of Object.keys(extShape)) defineLazyNode(merged, key, () => resolveShapeNode(extShape, key));
    return fromNode(cloneNode(this._zod.node, { shape: merged }), this);
  }
  safeExtend<Extension extends Shape>(extension: Extension): $ZodType<Output & ObjectOutput<Extension>, Input & ObjectInput<Extension>> { return this.extend(extension); }
  merge<T extends SomeType>(other: T): $ZodType<Output & output<T>, Input & input<T>> {
    if (other._zod.node.kind !== "object") throw new TypeError("merge() requires an object schema");
    if (this._zod.node.checks.length > 0) {
      throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
    }
    const otherNode = other._zod.node;
    const baseShape = this._zod.node.kind === "object" ? this._zod.node.shape : {};
    const otherShape = otherNode.shape;
    const merged: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) defineLazyNode(merged, key, () => requireNode(baseShape, key));
    for (const key of Object.keys(otherShape)) defineLazyNode(merged, key, () => requireNode(otherShape, key));
    // Incoming object's catchall, mode, and refinements override the receiver's.
    return fromNode(cloneNode(this._zod.node, { shape: merged, catchall: otherNode.catchall, mode: otherNode.mode, checks: otherNode.checks }), this);
  }
  pick<K extends keyof Output & string>(mask: Readonly<Partial<Record<K, boolean>>>): $ZodType<Pick<Output, K>, Pick<Input, Extract<K, keyof Input>>> {
    if (this._zod.node.kind !== "object") throw new TypeError("pick() is only valid on object schemas");
    if (this._zod.node.checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
    const baseShape = this._zod.node.shape;
    for (const key of Object.keys(mask)) {
      if (!Object.prototype.hasOwnProperty.call(baseShape, key)) throw new Error(`Unrecognized key: "${key}"`);
    }
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) if (mask[key as K]) defineLazyNode(shape, key, () => requireNode(baseShape, key));
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  omit<K extends keyof Output & string>(mask: Readonly<Partial<Record<K, boolean>>>): $ZodType<Omit<Output, K>, Omit<Input, Extract<K, keyof Input>>> {
    if (this._zod.node.kind !== "object") throw new TypeError("omit() is only valid on object schemas");
    if (this._zod.node.checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
    const baseShape = this._zod.node.shape;
    for (const key of Object.keys(mask)) {
      if (!Object.prototype.hasOwnProperty.call(baseShape, key)) throw new Error(`Unrecognized key: "${key}"`);
    }
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) if (!mask[key as K]) defineLazyNode(shape, key, () => requireNode(baseShape, key));
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  partial(mask?: Readonly<Partial<Record<keyof Output & string, boolean>>>): $ZodType<Partial<Output>, Partial<Input>> {
    if (this._zod.node.kind !== "object") throw new TypeError("partial() is only valid on object schemas");
    if (this._zod.node.checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
    const baseShape = this._zod.node.shape;
    if (mask) for (const key of Object.keys(mask)) {
      if (!Object.prototype.hasOwnProperty.call(baseShape, key)) throw new Error(`Unrecognized key: "${key}"`);
    }
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) {
      if (mask && !mask[key as keyof Output & string]) { defineLazyNode(shape, key, () => requireNode(baseShape, key)); continue; }
      defineLazyNode(shape, key, () => node({ kind: "optional", inner: requireNode(baseShape, key) }));
    }
    return fromNode(cloneNode(this._zod.node, { shape }), this);
  }
  required(mask?: Readonly<Partial<Record<keyof Output & string, boolean>>>): $ZodType<Required<Output>, Required<Input>> {
    if (this._zod.node.kind !== "object") throw new TypeError("required() is only valid on object schemas");
    const baseShape = this._zod.node.shape;
    if (mask) for (const key of Object.keys(mask)) {
      if (!Object.prototype.hasOwnProperty.call(baseShape, key)) throw new Error(`Unrecognized key: "${key}"`);
    }
    const shape: Record<string, SchemaNode> = {};
    for (const key of Object.keys(baseShape)) {
      if (mask && !mask[key as keyof Output & string]) { defineLazyNode(shape, key, () => requireNode(baseShape, key)); continue; }
      // Zod v4 semantics: every selected key is wrapped in ZodNonOptional,
      // which rejects undefined without unwrapping the inner schema.
      defineLazyNode(shape, key, () => node({ kind: "nonoptional", inner: requireNode(baseShape, key) }));
    }
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
  get options(): readonly (SomeType | string | number)[] {
    const definition = this._zod.node;
    if (definition.kind === "enum") return [...definition.values];
    return definition.kind === "union" || definition.kind === "discunion" ? definition.options.map(childSchema) : [];
  }
  get items(): readonly SomeType[] { return this._zod.node.kind === "tuple" ? this._zod.node.items.map(childSchema) : []; }
  rest<T extends SomeType>(schema: T): $ZodType<Output, Input> { if (this._zod.node.kind !== "tuple") throw new TypeError("rest() requires a tuple schema"); return fromNode(cloneNode(this._zod.node, { rest: schema._zod.node }), this); }
  unwrap(): SomeType {
    const current = this._zod.node;
    if (current.kind === "optional" || current.kind === "exactOptional" || current.kind === "nullable" || current.kind === "nonoptional" || current.kind === "readonly" || current.kind === "promise" || current.kind === "default" || current.kind === "prefault" || current.kind === "catch") return childSchema(current.inner);
    if (current.kind === "lazy") return childSchema(current.getter());
    throw new TypeError("unwrap() is not supported by this schema");
  }
  removeDefault(): SomeType { return this.unwrap(); }
  get keyType(): SomeType { return this._zod.node.kind === "record" || this._zod.node.kind === "map" ? childSchema(this._zod.node.key) : never(); }
  get valueType(): SomeType { const current = this._zod.node; return current.kind === "record" || current.kind === "map" || current.kind === "set" ? childSchema(current.value) : never(); }
  get in(): SomeType { return this._zod.node.kind === "pipe" ? childSchema(this._zod.node.a) : never(); }
  get out(): SomeType { return this._zod.node.kind === "pipe" ? childSchema(this._zod.node.b) : never(); }

  implement<F extends (...args: never[]) => unknown>(fn: F): F {
    const definition = this._zod.node;
    if (definition.kind !== "function" || (!definition.input && !definition.output)) return fn;
    // The parse result is the wrapped callable; F is opaque to the compiler
    // (generic boundary), so assert through the constraint type.
    return this.parse(fn) as (...args: never[]) => unknown as F;
  }
  implementAsync<F extends (...args: never[]) => Promise<unknown>>(fn: F): F {
    const definition = this._zod.node;
    if (definition.kind !== "function" || (!definition.input && !definition.output)) return fn;
    const argsSchema = definition.input ? childSchema(definition.input) : undefined;
    const returnsSchema = definition.output ? childSchema(definition.output) : undefined;
    // Localized legacy-interop cast: the generic F cannot be reconstructed from
    // the runtime wrapper signature without erasing the argument tuple.
    const wrapped = async (...args: readonly unknown[]): Promise<unknown> => {
      const parsedArgs = argsSchema ? await argsSchema.parseAsync(args) : args;
      const returned = await fn(...(parsedArgs as never[]));
      return returnsSchema ? returnsSchema.parseAsync(returned) : returned;
    };
    return wrapped as (...args: never[]) => Promise<unknown> as F;
  }
  input<T extends SomeType | readonly SomeType[]>(schema: T, rest?: SomeType): this {
    const definition = this._zod.node;
    if (definition.kind !== "function") return this;
    const argsNode = Array.isArray(schema)
      ? tuple(schema as readonly SomeType[], rest)._zod.node
      : (schema as SomeType)._zod.node;
    return fromNode(cloneNode(definition, { input: argsNode }), this) as this;
  }
  output<T extends SomeType>(schema: T): this {
    const definition = this._zod.node;
    if (definition.kind !== "function") return this;
    return fromNode(cloneNode(definition, { output: schema._zod.node }), this) as this;
  }

  toJSONSchema(params?: ToJSONSchemaParams): JSONSchema { return coreToJSONSchema(this, params); }
}

/**
 * Detachability without per-instance binding cost (the pattern colinhacks/zod
 * uses after #5870): every prototype method outside the eagerly-bound parse
 * family is replaced, once at module load, by a lazy-bind getter. First access
 * per instance allocates the bound thunk and caches it as an own data
 * property, so construction is closure-free for unused methods while
 * `const m = schema.optional; m()` keeps working.
 */
{
  const EAGER = new Set([
    "parse", "safeParse", "parseAsync", "safeParseAsync", "spa",
    "parseJson", "safeParseJson", "encode", "decode", "encodeAsync", "decodeAsync",
    "safeEncode", "safeDecode", "safeEncodeAsync", "safeDecodeAsync",
  ]);
  const prototype = $ZodType.prototype;
  for (const key of Object.getOwnPropertyNames(prototype)) {
    if (key === "constructor" || EAGER.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const fn = descriptor.value as (this: $ZodType, ...args: never[]) => unknown;
    Object.defineProperty(prototype, key, {
      configurable: true,
      enumerable: false,
      get(this: $ZodType) {
        const bound = fn.bind(this);
        Object.defineProperty(this, key, { value: bound, configurable: true, writable: true });
        return bound;
      },
      set(this: $ZodType, value: unknown) {
        Object.defineProperty(this, key, { value, configurable: true, writable: true, enumerable: true });
      },
    });
  }
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
// class hierarchy). The named wrappers are constructor-shaped matchers keyed by
// the underlying node kind via `Symbol.hasInstance`, so `x instanceof z.ZodString`
// is true exactly when `x` is a string schema — and each is also callable as the
// corresponding factory (`z.ZodString() === z.string()`), matching Zod.
type ZodMatcher = { readonly [Symbol.hasInstance]: (value: unknown) => boolean };
function kindMatcher(factory: (...args: readonly unknown[]) => $ZodType, ...kinds: readonly SchemaNode["kind"][]): ZodMatcher {
  const matcher = Object.defineProperty(function (...args: readonly unknown[]) { return factory(...args); }, Symbol.hasInstance, {
    value: (value: unknown): boolean => value instanceof $ZodType && kinds.includes(value._zod.node.kind),
  });
  return matcher as unknown as ZodMatcher;
}

export const ZodString: ZodMatcher = kindMatcher(() => string(), "string");
export const ZodNumber: ZodMatcher = kindMatcher(() => number(), "number");
export const ZodBigInt: ZodMatcher = kindMatcher(() => bigint(), "bigint");
export const ZodBoolean: ZodMatcher = kindMatcher(() => boolean(), "boolean");
export const ZodDate: ZodMatcher = kindMatcher(() => date(), "date");
export const ZodSymbol: ZodMatcher = kindMatcher(() => symbol(), "symbol");
export const ZodUndefined: ZodMatcher = kindMatcher(() => undefined_(), "undefined");
export const ZodNull: ZodMatcher = kindMatcher(() => null_(), "null");
export const ZodVoid: ZodMatcher = kindMatcher(() => void_(), "void");
export const ZodAny: ZodMatcher = kindMatcher(() => any(), "any");
export const ZodUnknown: ZodMatcher = kindMatcher(() => unknown(), "unknown");
export const ZodNever: ZodMatcher = kindMatcher(() => never(), "never");
export const ZodNaN: ZodMatcher = kindMatcher(() => nan(), "nan");
export const ZodLiteral: ZodMatcher = kindMatcher((value) => literal(value as Primitive), "literal");
export const ZodEnum: ZodMatcher = kindMatcher((values) => enum_(values as readonly string[]), "enum");
export const ZodObject: ZodMatcher = kindMatcher((shape) => object(shape as Shape), "object");
export const ZodArray: ZodMatcher = kindMatcher((element) => array(element as SomeType), "array");
export const ZodTuple: ZodMatcher = kindMatcher((items) => tuple(items as readonly SomeType[]), "tuple");
export const ZodUnion: ZodMatcher = kindMatcher((options) => union(options as readonly SomeType[]), "union", "discunion");
export const ZodDiscriminatedUnion: ZodMatcher = kindMatcher((key, options) => discriminatedUnion(key as string, options as readonly SomeType[]), "discunion");
export const ZodIntersection: ZodMatcher = kindMatcher((left, right) => intersection(left as SomeType, right as SomeType), "intersection");
export const ZodRecord: ZodMatcher = kindMatcher((key, value) => record(key as SomeType, value as SomeType), "record");
export const ZodMap: ZodMatcher = kindMatcher((key, value) => map(key as SomeType, value as SomeType), "map");
export const ZodSet: ZodMatcher = kindMatcher((value) => set(value as SomeType), "set");
export const ZodOptional: ZodMatcher = kindMatcher((inner) => optional(inner as SomeType), "optional");
export const ZodNullable: ZodMatcher = kindMatcher((inner) => nullable(inner as SomeType), "nullable");
export const ZodDefault: ZodMatcher = kindMatcher((inner, value) => _default(inner as SomeType, value), "default");
export const ZodPrefault: ZodMatcher = kindMatcher((inner, value) => prefault(inner as SomeType, value as never), "prefault");
export const ZodNonOptional: ZodMatcher = kindMatcher((inner) => nonoptional(inner as SomeType), "nonoptional");
export const ZodCatch: ZodMatcher = kindMatcher((inner, value) => catch_(inner as SomeType, value as never), "catch");
export const ZodPromise: ZodMatcher = kindMatcher((inner) => promise(inner as SomeType), "promise");
export const ZodReadonly: ZodMatcher = kindMatcher((inner) => (inner as SomeType).readonly(), "readonly");
export const ZodLazy: ZodMatcher = kindMatcher((getter) => lazy(getter as () => SomeType), "lazy");
export const ZodFile: ZodMatcher = kindMatcher(() => file(), "file");
export const ZodFunction: ZodMatcher = kindMatcher(() => function_(), "function");
export const ZodTemplateLiteral: ZodMatcher = kindMatcher((parts) => templateLiteral(parts as readonly string[]), "templateLiteral");
export const ZodPipe: ZodMatcher = kindMatcher((a, b) => pipe(a as SomeType, b as SomeType), "pipe");
export const ZodCustom: ZodMatcher = kindMatcher((fn) => custom(fn as (data: unknown) => unknown), "host");
export const ZodStringFormat: ZodMatcher = kindMatcher(() => string(), "string");
export const ZodSuccess: ZodMatcher = kindMatcher((inner) => success(inner as SomeType), "host");
export const ZodJSONSchema: ZodMatcher = kindMatcher(() => json(), "host");
export const ZodNumberFormat: ZodMatcher = kindMatcher(() => number(), "number");
export const ZodBigIntFormat: ZodMatcher = kindMatcher(() => bigint(), "bigint");
export const ZodExactOptional: ZodMatcher = kindMatcher((inner) => (inner as SomeType).exactOptional(), "exactOptional");
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
export const ZodPreprocess: ZodMatcher = {
  [Symbol.hasInstance]: (value: unknown): boolean => {
    if (!(value instanceof $ZodType)) return false;
    const current = value._zod.node;
    return current.kind === "pipe" && current.a.kind === "host" && current.a.op === "preprocess";
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
  let entries: (string | number)[];
  if (Array.isArray(values)) {
    entries = [...values];
  } else {
    // Drop TS enum reverse-mappings: a numeric-valued member `Foo = 0` also creates
    // a `0 -> "Foo"` back-edge; exclude keys that are the string form of a numeric value.
    const record = values as Readonly<Record<string, string | number>>;
    const numericValues = Object.values(record).filter((value) => typeof value === "number");
    entries = Object.entries(record).filter(([key]) => !numericValues.includes(Number(key))).map(([, value]) => value);
  }
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
  const keys = Object.keys(source);
  // Getter-style entries (`get self() { ... }`) must resolve lazily to avoid a
  // TDZ on recursive shapes; plain schema values resolve eagerly, skipping the
  // per-key defineProperty + closure cost entirely.
  let hasGetter = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor && typeof descriptor.get === "function") { hasGetter = true; break; }
  }
  const nodes: Record<string, SchemaNode> = {};
  if (hasGetter) {
    for (const key of keys) defineLazyNode(nodes, key, () => resolveShapeNode(source, key));
  } else {
    for (const key of keys) nodes[key] = resolveShapeNode(source, key);
  }
  return nodes;
}

function objectNode<S extends Shape>(shape: S | undefined, mode: ObjectMode, params?: ErrorParam): ZodObject<S> {
  const nodes = lazyShapeFromSchemas((shape ?? {}) as Record<string, SomeType>);
  return fromNode(node({ kind: "object", shape: nodes, mode, catchall: null }, { error: errorMap(params) }));
}

export function object<const S extends Shape = Record<never, SomeType>>(shape?: S, params?: ErrorParam): ZodObject<S> {
  return objectNode(shape, "strip", params);
}
export function strictObject<const S extends Shape>(shape: S, params?: ErrorParam): ZodObject<S> { return objectNode(shape, "strict", params); }
export function looseObject<const S extends Shape>(shape: S, params?: ErrorParam): ZodObject<S> { return objectNode(shape, "passthrough", params); }
export function keyof<S extends SomeType>(schema: S): $ZodType<string, string> {
  const current = schema._zod.node;
  if (current.kind !== "object") throw new TypeError("keyof() is only valid on object schemas");
  return enum_(Object.keys(current.shape));
}
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

export function discriminatedUnion<const T extends readonly SomeType[]>(key: string, options: T, params?: ErrorParam & { readonly unionFallback?: boolean }): ZodUnion<T> {
  const map = new Map<Primitive, SchemaNode>();
  let invalidOptionIndex: number | undefined;
  for (const option of options) {
    const sets = (propValuesOf(option._zod.node) ?? {})[key];
    if (!sets) {
      if (invalidOptionIndex === undefined) invalidOptionIndex = options.indexOf(option);
      continue;
    }
    for (const value of sets) {
      if (map.has(value as Primitive)) throw new Error(`Duplicate discriminator value "${String(value)}"`);
      map.set(value as Primitive, option._zod.node);
    }
  }
  const fallback = typeof params === "object" && params.unionFallback === true;
  return fromNode(node({
    kind: "discunion", key,
    options: options.map((option) => option._zod.node),
    map, unionFallback: fallback,
    ...(invalidOptionIndex !== undefined ? { invalidOptionIndex } : {}),
  }, { error: errorMap(params) }));
}
export function xor<const T extends readonly SomeType[]>(options: T, params?: ErrorParam): ZodUnion<T> {
  return fromNode(node({ kind: "union", inclusive: false, options: options.map((option) => option._zod.node) }, { error: errorMap(params) }));
}
export function intersection<A extends SomeType, B extends SomeType>(left: A, right: B): ZodIntersection<A, B> { return fromNode(node({ kind: "intersection", left: left._zod.node, right: right._zod.node })); }
export function record<V extends SomeType>(value: V, params?: ErrorParam): ZodRecord<ZodString, V>;
export function record<K extends SomeType, V extends SomeType>(key: K, value: V, params?: ErrorParam): ZodRecord<K, V>;
export function record<K extends SomeType, V extends SomeType>(keyOrValue: K | V, valueOrParams?: V | ErrorParam, params?: ErrorParam): ZodRecord<K, V> {
  // v3-compat single-arg form: `z.record(valueType)` defaults keyType to z.string().
  if (valueOrParams === undefined || typeof valueOrParams === "string" || !("_zod" in (valueOrParams as object))) {
    const value = keyOrValue as V;
    const maybeParams = (valueOrParams === undefined ? params : valueOrParams) as ErrorParam;
    return fromNode(node({ kind: "record", key: node({ kind: "string" }), value: value._zod.node }, { error: errorMap(maybeParams) }));
  }
  const key = keyOrValue as K;
  const value = valueOrParams as V;
  return fromNode(node({ kind: "record", key: key._zod.node, value: value._zod.node }, { error: errorMap(params) }));
}
export function map<K extends SomeType, V extends SomeType>(key: K, value: V, params?: ErrorParam): ZodMap<K, V> { return fromNode(node({ kind: "map", key: key._zod.node, value: value._zod.node }, { error: errorMap(params) })); }
export function partialRecord<K extends SomeType, V extends SomeType>(keyType: K, valueType: V, params?: ErrorParam): ZodRecord<K, V> {
  return fromNode(node({ kind: "record", key: keyType._zod.node, value: valueType._zod.node, partial: true }, { error: errorMap(params) }));
}
export function looseRecord<K extends SomeType, V extends SomeType>(keyType: K, valueType: V, params?: ErrorParam): ZodRecord<K, V> {
  return fromNode(node({ kind: "record", key: keyType._zod.node, value: valueType._zod.node, mode: "loose" }, { error: errorMap(params) }));
}
export function set<T extends SomeType>(value: T, params?: ErrorParam): ZodSet<T> { return fromNode(node({ kind: "set", value: value._zod.node }, { error: errorMap(params) })); }
export function optional<T extends SomeType>(inner: T): ZodOptional<T> { return inner.optional(); }
export function nullable<T extends SomeType>(inner: T): ZodNullable<T> { return inner.nullable(); }
export function nullish<T extends SomeType>(inner: T): $ZodType<output<T> | null | undefined, input<T> | null | undefined> { return inner.nullish(); }
export function nonoptional<T extends SomeType>(inner: T, params?: ErrorParam): $ZodType<Exclude<output<T>, undefined>, input<T>> { return fromNode(node({ kind: "nonoptional", inner: inner._zod.node }, { error: errorMap(params) })); }
export function readonly<T extends SomeType>(inner: T): ZodReadonly<T> { return inner.readonly(); }
export function promise<T extends SomeType>(inner: T): ZodPromise<T> { return fromNode(node({ kind: "promise", inner: inner._zod.node })); }
export function lazy<T extends SomeType>(getter: () => T): ZodLazy<T> {
  let cached: SchemaNode | undefined;
  return fromNode(node({ kind: "lazy", getter: () => (cached ??= getter()._zod.node) }));
}
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
/** Standalone refine check: `z.refine(fn)` passed into `.check()`. */
export function refine<T = unknown>(fn: (value: T) => MaybeAsync<boolean>, params?: ErrorParam): $ZodCheck<T> {
  const host: HostFunction = (value) => (fn as (input: unknown) => MaybeAsync<boolean>)(value);
  return runtimeCheck({ c: "host_runtime", op: "refine", fn: host }, params);
}
/** Standalone check: `z.check(fn)` runs a function against `{ value, issues }`. */
export function check<T = unknown>(fn: (payload: { value: T; issues: $ZodIssue[] }) => MaybeAsync<void>): $ZodCheck<T> {
  const host: HostFunction = (value, context) => (fn as (payload: { value: unknown; issues: $ZodIssue[] }) => MaybeAsync<void>)({ value, issues: context.issues as $ZodIssue[] });
  return runtimeCheck({ c: "host_runtime", op: "check", fn: host });
}
/** Standalone default: `z._default(schema, value)` == `schema.default(value)`. */
export function _default<T extends SomeType>(inner: T, value: NoUndefined<output<T>> | (() => NoUndefined<output<T>>)): $ZodType<Exclude<output<T>, undefined>, input<T> | undefined> {
  return fromNode(node({ kind: "default", inner: inner._zod.node, value, dynamic: typeof value === "function" }));
}
/** Standalone catch: `z.catch(schema, value)` == `schema.catch(value)`. */
export function catch_<T extends SomeType>(inner: T, value: output<T> | ((context: { readonly error: unknown; readonly input: unknown }) => output<T>)): $ZodType<output<T>, input<T>> {
  return fromNode(node({ kind: "catch", inner: inner._zod.node, value, dynamic: typeof value === "function" }));
}
/** Standalone prefault: `z.prefault(schema, value)` == `schema.prefault(value)`. */
export function prefault<T extends SomeType>(inner: T, value: input<T> | (() => input<T>)): $ZodType<output<T>, input<T> | undefined> {
  return fromNode(node({ kind: "prefault", inner: inner._zod.node, value, dynamic: typeof value === "function" }));
}
export function instanceOf<T extends abstract new (...args: never[]) => object>(constructor: T, params?: ErrorParam): $ZodType<InstanceType<T>, InstanceType<T>> {
  const host: HostFunction = (value, context) => {
    if (value instanceof constructor) return value;
    context.addIssue({ code: "invalid_type", expected: constructor.name, input: value, path: [] } as never);
    return value;
  };
  return fromNode(node({ kind: "host", inner: null, fn: host, op: "check", error: errorMap(params) }));
}
export function function_(def?: { readonly input?: SomeType | readonly SomeType[]; readonly output?: SomeType }, params?: ErrorParam): ZodFunction {
  const argsNode = def?.input
    ? (Array.isArray(def.input) ? tuple(def.input as readonly SomeType[])._zod.node : (def.input as SomeType)._zod.node)
    : undefined;
  const returnsNode = def?.output ? def.output._zod.node : undefined;
  return fromNode(node({
    kind: "function",
    ...(argsNode ? { input: argsNode } : {}),
    ...(returnsNode ? { output: returnsNode } : {}),
  }, { error: errorMap(params) }));
}
export function stringbool(params: string | { readonly truthy?: readonly string[]; readonly falsy?: readonly string[]; readonly case?: "sensitive" | "insensitive"; readonly error?: string | $ZodErrorMap } = {}): $ZodType<boolean, string> {
  const normalized = typeof params === "string" ? { error: params } as const : params;
  let truthy: readonly string[] = normalized.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  let falsy: readonly string[] = normalized.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  const sensitive = normalized.case === "sensitive";
  if (!sensitive) { truthy = truthy.map((v) => v.toLowerCase()); falsy = falsy.map((v) => v.toLowerCase()); }
  const values = [...truthy, ...falsy];
  const codecError = errorMap(normalized);
  const decodeHost: HostFunction = (value, context) => {
    const candidate = sensitive ? (value as string) : (value as string).toLowerCase();
    if (truthy.includes(candidate)) return true;
    if (falsy.includes(candidate)) return false;
    context.addIssue({ code: "invalid_value", expected: "stringbool", values, input: value, path: [], continue: false, inst: { error: codecError } } as never);
    return false;
  };
  const encodeHost: HostFunction = (value) => ((value as boolean) ? truthy[0] : falsy[0]);
  return fromNode(node({
    kind: "pipe",
    codec: true,
    a: node({ kind: "string" }, { error: codecError }),
    b: node({ kind: "pipe", a: node({ kind: "host", inner: null, fn: decodeHost, op: "codec_decode" }, { error: codecError }), b: node({ kind: "boolean" }, { error: codecError }) }),
    encodeHost,
  }, { error: codecError }));
}

function templatePattern(part: string | number | bigint | boolean | null | SomeType): string {
  if (part instanceof $ZodType) {
    const pattern = patternOf(part._zod.node);
    if (!pattern) throw new Error(`One or more parts of the template literal does not have a regex pattern: ${part._zod.node.kind}`);
    const source = pattern.source;
    const start = source.startsWith("^") ? 1 : 0;
    const end = source.endsWith("$") ? source.length - 1 : source.length;
    return source.slice(start, end);
  }
  return escapeRegex(String(part));
}
export function templateLiteral<const Parts extends readonly (string | number | bigint | boolean | null | SomeType)[]>(parts: Parts, params?: ErrorParam): $ZodType<string, string> {
  const pattern = new RegExp(`^${parts.map(templatePattern).join("")}$`);
  return fromNode(node({ kind: "templateLiteral", pattern }, { error: errorMap(params) }));
}

export function codec<A extends SomeType, B extends SomeType>(inputSchema: A, outputSchema: B, handlers: {
  readonly decode: (value: output<A>, context: RefinementCtx<output<A>>) => MaybeAsync<input<B>>;
  readonly encode: (value: input<B>, context: RefinementCtx<input<B>>) => MaybeAsync<output<A>>;
}): $ZodType<output<B>, input<A>> {
  const decodeHost: HostFunction = (value, context) => handlers.decode(value as output<A>, context as RefinementCtx<output<A>>);
  const encodeHost: HostFunction = (value, context) => handlers.encode(value as input<B>, context as RefinementCtx<input<B>>);
  return fromNode(node({ kind: "pipe", codec: true, a: inputSchema._zod.node, b: node({ kind: "pipe", a: node({ kind: "host", inner: null, fn: decodeHost, op: "codec_decode" }), b: outputSchema._zod.node }), encodeHost }));
}
export function invertCodec<T extends SomeType>(codec: T): $ZodType<input<T>, output<T>> {
  const def = codec._zod.node;
  if (def.kind !== "pipe" || !def.codec || !def.encodeHost) throw new TypeError("invertCodec() requires a codec schema");
  const inner = def.b;
  if (inner.kind !== "pipe") throw new TypeError("invertCodec() requires a codec schema");
  const decodeHostNode = inner.a;
  if (decodeHostNode.kind !== "host") throw new TypeError("invertCodec() requires a codec schema");
  const encodeNode = node({ kind: "host", inner: null, fn: def.encodeHost, op: "codec_encode" });
  const reversedInner = node({ kind: "pipe", a: encodeNode, b: def.a });
  return fromNode(node({ kind: "pipe", codec: true, a: inner.b, b: reversedInner, encodeHost: decodeHostNode.fn }));
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
const intCheck = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "number_format", v: "safeint" }, params);
const int32Check = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "number_format", v: "int32" }, params);
const uint32Check = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "number_format", v: "uint32" }, params);
const float32Check = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "number_format", v: "float32" }, params);
const float64Check = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "number_format", v: "float64" }, params);
const int64Check = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "bigint_format", v: "int64" }, params);
const uint64Check = (params?: ErrorParam): $ZodCheck => runtimeCheck({ c: "bigint_format", v: "uint64" }, params);
/** Format-checked number/bigint schemas (Zod: z.int() is z.number().int()). */
export function int(params?: ErrorParam): $ZodType<number, number> { return number(params).check(intCheck(params)); }
export function int32(params?: ErrorParam): $ZodType<number, number> { return number(params).check(int32Check(params)); }
export function uint32(params?: ErrorParam): $ZodType<number, number> { return number(params).check(uint32Check(params)); }
export function float32(params?: ErrorParam): $ZodType<number, number> { return number(params).check(float32Check(params)); }
export function float64(params?: ErrorParam): $ZodType<number, number> { return number(params).check(float64Check(params)); }
export function int64(params?: ErrorParam): $ZodType<bigint, bigint> { return bigint(params).check(int64Check(params)); }
export function uint64(params?: ErrorParam): $ZodType<bigint, bigint> { return bigint(params).check(uint64Check(params)); }
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
function urlFormatParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const source = params as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  if (source["hostname"] !== undefined) out["hostname"] = source["hostname"];
  if (source["protocol"] !== undefined) out["protocol"] = source["protocol"];
  if (source["normalize"] !== undefined) out["normalize"] = source["normalize"];
  return Object.keys(out).length > 0 ? out : undefined;
}
export function url(params?: ErrorParam & { readonly hostname?: RegExp; readonly protocol?: RegExp; readonly normalize?: boolean }): ZodString { return formatted("url", params, urlFormatParams(params)); }
export function httpUrl(params?: ErrorParam & { readonly hostname?: RegExp; readonly protocol?: RegExp; readonly normalize?: boolean }): ZodString { return formatted("httpUrl", params, urlFormatParams(params)); }
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
export function jwt(params?: ErrorParam & { readonly alg?: string }): ZodString { return formatted("jwt", params, typeof params === "object" && params.alg !== undefined ? { alg: params.alg } : undefined); }
export function hex(params?: ErrorParam): ZodString { return formatted("hex", params); }
export function md5(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("md5", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha1(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha1", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha256(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha256", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha384(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha384", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export function sha512(params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString { return formatted("sha512", params, typeof params === "object" ? { enc: params.enc } : undefined); }
export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha384" | "sha512";
export function hash<Alg extends HashAlgorithm>(alg: Alg, params?: ErrorParam & { readonly enc?: "hex" | "base64" | "base64url" }): ZodString {
  return formatted(alg, params, typeof params === "object" ? { enc: params.enc } : undefined);
}
export function stringFormat(name: string, validator: RegExp | ((value: string) => MaybeAsync<unknown>), params?: ErrorParam): ZodString {
  const fn: HostFunction = validator instanceof RegExp ? (value) => validator.test(value as string) : (value) => validator(value as string);
  return string().check(runtimeCheck({ c: "host_runtime", op: "custom_format", fn, format: name, ...(validator instanceof RegExp ? { pattern: validator } : {}) }, params));
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
export const TimePrecision: Readonly<{ Any: null; Minute: -1; Second: 0; Millisecond: 3; Microsecond: 6 }> = { Any: null, Minute: -1, Second: 0, Millisecond: 3, Microsecond: 6 };
export const regexes: Readonly<Record<string, RegExp>> = REGEXES;
export function json(params?: ErrorParam): SomeType {
  const valid = (value: unknown): boolean => {
    if (value === null) return true;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return !Number.isNaN(value);
    if (Array.isArray(value)) return value.every(valid);
    if (isObject(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.values(value).every(valid);
    }
    return false;
  };
  return custom<JSONType>(valid, params);
}

/** Issue-code constants mirroring Zod v4's `z.ZodIssueCode` enum (lowercase codes). */
export const ZodIssueCode: Readonly<Record<string, string>> = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom",
};

export function setErrorMap(map: $ZodErrorMap): void { config({ customError: map }); }
export function getErrorMap(): $ZodErrorMap | undefined { return config().customError; }

/** Check form: `z.describe(str)` attaches a description to whatever schema `.check()` builds. */
export function describe(description: string): $ZodCheck {
  const runtime = runtimeCheck({ c: "host_runtime", op: "check", fn: () => {} });
  return {
    _zod: {
      ...runtime._zod,
      attach: (target) => {
        if (target instanceof $ZodType) {
          const existing = globalRegistry.get(target) ?? {};
          globalRegistry.add(target, { ...existing, description });
        }
      },
    },
  };
}
/** Check form: `z.meta({...})` registers metadata on the schema `.check()` builds. */
export function metaCheck(data: Record<string, unknown>): $ZodCheck {
  const runtime = runtimeCheck({ c: "host_runtime", op: "check", fn: () => {} });
  return {
    _zod: {
      ...runtime._zod,
      attach: (target) => {
        if (target instanceof $ZodType) {
          const existing = globalRegistry.get(target) ?? {};
          globalRegistry.add(target, { ...existing, ...data });
        }
      },
    },
  };
}
export const meta_: typeof metaCheck = metaCheck;

/** Wraps a schema so parsing always succeeds, yielding `true` when the inner
 * schema validates and `false` otherwise (mirrors Zod's `z.success`). */
export function success<T extends SomeType>(inner: T): $ZodType<boolean, input<T>> {
  const fn: HostFunction = (value) => inner.safeParse(value).success;
  return fromNode(node({ kind: "host", inner: null, fn, op: "transform" }));
}