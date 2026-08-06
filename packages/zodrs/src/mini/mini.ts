/**
 * zodrs mini surface: a functional projection over the shared core node graph.
 *
 * Mini schemas wrap the same `SchemaNode` validators the classic surface uses
 * (validation, plan compilation, and parse entry points are inherited from the
 * classic `$ZodType` base). This module only adds the mini-shaped construction
 * API, the Zod-style `def` metadata view, and free-function wrappers.
 */
import { config } from "../core/config.js";
import { ZodError, $ZodRealError } from "../core/errors.js";
import type { $ZodErrorMap, $ZodIssue, ParseContext } from "../core/errors.js";
import * as coreModule from "../core/index.js";
import { cloneNode, node } from "../core/nodes.js";
import type { FormatId, HostFunction, MetadataBag, ObjectNode, RuntimeCheck, SchemaNode } from "../core/nodes.js";
import type { SafeParseResult } from "../core/parse.js";
import type { Flatten, JSONType, MaybeAsync, NoUndefined, Primitive } from "../core/util.js";
import {
  $ZodType as ClassicType,
  $brand,
  codec as classicCodec,
  custom as classicCustom,
  discriminatedUnion as classicDiscriminatedUnion,
  enum_ as classicEnum,
  format as classicFormat,
  function_ as classicFunction,
  instanceOf as classicInstanceOf,
  int as classicInt,
  int32 as classicInt32,
  uint32 as classicUint32,
  float32 as classicFloat32,
  float64 as classicFloat64,
  int64 as classicInt64,
  uint64 as classicUint64,
  json as classicJson,
  literal as classicLiteral,
  preprocess as classicPreprocess,
  stringbool as classicStringbool,
  stringFormat as classicStringFormat,
  templateLiteral as classicTemplateLiteral,
  transform as classicTransform,
} from "../classic/schemas.js";
import type { $ZodCheck as ClassicCheck, CheckFn, ErrorParam, RefinementCtx, SomeType, ZodFile } from "../classic/schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type output<T extends SomeMini> = T["_zod"]["output"];
export type input<T extends SomeMini> = T["_zod"]["input"];
export type infer<T extends SomeMini> = output<T>;
type SomeMini = SomeType;
type ShapeOf<T> = T extends ZodMiniObject<infer S> ? S : MiniShape;

type MiniOptionalOut<S extends MiniShape> = { [K in keyof S]-?: undefined extends output<S[K]> ? K : never }[keyof S];
type MiniOptionalIn<S extends MiniShape> = { [K in keyof S]-?: undefined extends input<S[K]> ? K : never }[keyof S];
type ObjectOutput<S extends MiniShape> = Flatten<
  { [K in Exclude<keyof S, MiniOptionalOut<S>>]: output<S[K]> } & { [K in MiniOptionalOut<S>]?: output<S[K]> }
>;
type ObjectInput<S extends MiniShape> = Flatten<
  { [K in Exclude<keyof S, MiniOptionalIn<S>>]: input<S[K]> } & { [K in MiniOptionalIn<S>]?: input<S[K]> }
>;
type TupleOutput<T extends readonly SomeMini[], Rest extends SomeMini | null> = Rest extends SomeMini
  ? [...{ [K in keyof T]: output<T[K]> }, ...output<Rest>[]]
  : { [K in keyof T]: output<T[K]> };
type TupleInput<T extends readonly SomeMini[], Rest extends SomeMini | null> = Rest extends SomeMini
  ? [...{ [K in keyof T]: input<T[K]> }, ...input<Rest>[]]
  : { [K in keyof T]: input<T[K]> };

export type { $brand, BRAND } from "../classic/schemas.js";
import type { BRAND, SchemaInternals, output as ClassicInfer } from "../classic/schemas.js";

export type $ZodBrand<T extends PropertyKey> = BRAND<T>;

/** The Zod-style metadata view every mini schema exposes as `.def` / `_zod.def`. */
export interface MiniDef {
  readonly type: string;
  readonly checks?: readonly RuntimeCheck[] | undefined;
  readonly error?: $ZodErrorMap | undefined;
  readonly format?: string | undefined;
  readonly shape?: MiniShape | undefined;
  readonly element?: SomeMini | undefined;
  readonly items?: readonly SomeMini[] | undefined;
  readonly rest?: SomeMini | null | undefined;
  readonly options?: readonly SomeMini[] | undefined;
  readonly left?: SomeMini | undefined;
  readonly right?: SomeMini | undefined;
  readonly keyType?: SomeMini | undefined;
  readonly valueType?: SomeMini | undefined;
  readonly innerType?: SomeMini | undefined;
  readonly in?: SomeMini | undefined;
  readonly out?: SomeMini | undefined;
  readonly values?: readonly unknown[] | undefined;
  readonly entries?: Readonly<Record<string, string | number>> | undefined;
  readonly parts?: readonly unknown[] | undefined;
  readonly getter?: (() => SomeMini) | undefined;
  readonly defaultValue?: unknown;
  readonly catchValue?: unknown;
  readonly transform?: ((value: never, payload: never) => MaybeAsync<unknown>) | undefined;
  readonly reverseTransform?: ((value: never, payload: never) => MaybeAsync<unknown>) | undefined;
  readonly fn?: unknown;
  readonly catchall?: SomeMini | undefined;
  readonly coerce?: boolean | undefined;
}

export type MiniShape = Readonly<Record<string, SomeMini>>;
type Writeable<T> = { -readonly [K in keyof T]: T[K] };

type MiniConstructor<T extends ZodMiniType = ZodMiniType> = new (
  def: MiniDef,
  schemaNode: SchemaNode,
  parent?: ZodMiniType,
) => T;

/** Read view over the mini overlay the constructor grafts onto the classic internals. */
type MiniInternalsView<O, I> = Omit<SchemaInternals<O, I>, "def"> & {
  def: MiniDef & SchemaNode;
  bag: MetadataBag;
  optin: "optional" | undefined;
  optout: "optional" | undefined;
};

function internalsOf<O, I>(schema: ZodMiniType<O, I>): MiniInternalsView<O, I> {
  return schema._zod as MiniInternalsView<O, I>;
}

// ---------------------------------------------------------------------------
// Metadata derivation (bag, optin/optout) — views over the node, not validation
// ---------------------------------------------------------------------------

const NUMBER_FORMAT_RANGES = {
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-3.4028234663852886e38, 3.4028234663852886e38],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
} as const;

const BIGINT_FORMAT_RANGES = {
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
} as const;

function computeBag(schemaNode: SchemaNode): MetadataBag {
  const bag: Record<string, unknown> = {};
  for (const runtime of schemaNode.checks) {
    const check = runtime.check;
    switch (check.c) {
      case "gt":
      case "lt": {
        const value = typeof check.v === "number" ? check.v : BigInt(check.v);
        const key = check.c === "gt" ? (check.inclusive ? "minimum" : "exclusiveMinimum") : check.inclusive ? "maximum" : "exclusiveMaximum";
        const current = bag[key];
        if (current === undefined) bag[key] = value;
        else if ((typeof current === "number" && typeof value === "number") || (typeof current === "bigint" && typeof value === "bigint")) {
          bag[key] = (check.c === "gt" ? current > value : current < value) ? current : value;
        }
        break;
      }
      case "multiple_of":
        bag["multipleOf"] = typeof check.v === "string" ? BigInt(check.v) : check.v;
        break;
      case "number_format": {
        const range = NUMBER_FORMAT_RANGES[check.v];
        bag["format"] = check.v;
        bag["minimum"] = range[0];
        bag["maximum"] = range[1];
        break;
      }
      case "bigint_format": {
        const range = BIGINT_FORMAT_RANGES[check.v];
        bag["format"] = check.v;
        bag["minimum"] = range[0];
        bag["maximum"] = range[1];
        break;
      }
      case "min_length":
      case "min_size": {
        const current = bag["minimum"];
        bag["minimum"] = typeof current === "number" ? Math.max(current, check.v) : check.v;
        break;
      }
      case "max_length":
      case "max_size": {
        const current = bag["maximum"];
        bag["maximum"] = typeof current === "number" ? Math.min(current, check.v) : check.v;
        break;
      }
      case "length":
        bag["length"] = check.v;
        bag["minimum"] = check.v;
        bag["maximum"] = check.v;
        break;
      case "size":
        bag["size"] = check.v;
        bag["minimum"] = check.v;
        bag["maximum"] = check.v;
        break;
      case "format":
        bag["format"] = check.v;
        break;
      case "regex":
        bag["pattern"] = `/${check.src}/${check.flags}`;
        break;
      case "lowercase":
      case "uppercase":
        bag["format"] = check.c;
        break;
      default:
        break;
    }
  }
  return bag;
}

// Optionality mirrors Zod core: wrappers propagate, defaults are input-optional,
// unions are optional when any option is, pipes defer to the relevant side.
function optFlag(schemaNode: SchemaNode, which: "optin" | "optout"): "optional" | undefined {
  switch (schemaNode.kind) {
    case "optional":
      return "optional";
    case "default":
    case "prefault":
      return which === "optin" ? "optional" : undefined;
    case "catch":
      return which === "optin" ? "optional" : optFlag(schemaNode.inner, "optout");
    case "nullable":
    case "readonly":
    case "promise":
      return optFlag(schemaNode.inner, which);
    case "lazy":
      return optFlag(schemaNode.getter(), which);
    case "union":
    case "discunion":
      return schemaNode.options.some((option) => optFlag(option, which) === "optional") ? "optional" : undefined;
    case "pipe":
      return optFlag(which === "optin" ? schemaNode.a : schemaNode.b, which);
    case "host":
      return schemaNode.op === "transform" && which === "optin" ? "optional" : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export class ZodMiniType<Output = unknown, Input = unknown> extends ClassicType<Output, Input> {
  constructor(def: MiniDef, schemaNode: SchemaNode, parent?: ZodMiniType) {
    super(schemaNode, parent);
    Object.defineProperty(this, "def", { value: def, writable: true, configurable: true });
    Object.defineProperty(this._zod, "def", { value: def, writable: true, configurable: true });
    Object.defineProperty(this._zod, "bag", { value: computeBag(schemaNode), writable: true, configurable: true });
    for (const which of ["optin", "optout"] as const) {
      let computed = false;
      let value: "optional" | undefined;
      Object.defineProperty(this._zod, which, {
        get: () => {
          if (!computed) {
            value = optFlag(schemaNode, which);
            computed = true;
          }
          return value;
        },
        configurable: true,
      });
    }
    // The classic constructor bound its prototype methods onto the instance;
    // re-bind the mini variants of the two methods whose behavior differs.
    for (const key of ["check", "with"] as const) {
      Object.defineProperty(this, key, { value: ZodMiniType.prototype[key].bind(this), configurable: true, writable: true });
    }
  }

  // These classic object mutators are not part of the mini surface (mini uses
  // the free z.pick/z.omit/z.partial/... functions). Their mapped-type return
  // signatures break structural assignability between mini schema classes, so
  // they are narrowed to `never`. Runtime is unaffected: the classic constructor
  // binds working implementations as own properties that shadow these.
  override readonly(): never {
    return super.readonly() as never;
  }
  override partial(): never {
    return super.partial() as never;
  }
  override required(): never {
    return super.required() as never;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override pick(mask: any): never {
    return super.pick(mask) as never;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override omit(mask: any): never {
    return super.omit(mask) as never;
  }

  override check(
    ...values: readonly (ClassicCheck<Output> | RuntimeCheck | CheckFn | ((payload: { value: Output; issues: $ZodIssue[] }) => MaybeAsync<void>) | SomeType)[]
  ): this {
    const nextNode = cloneNode(this._zod.node, { checks: [...this._zod.node.checks, ...toRuntimeChecks(values)] });
    const nextDef: MiniDef = { ...internalsOf(this).def, checks: nextNode.checks };
    const Ctor = this.constructor as MiniConstructor<this>;
    return new Ctor(nextDef, nextNode, this);
  }

  override with(
    ...values: readonly (ClassicCheck<Output> | RuntimeCheck | CheckFn | ((payload: { value: Output; issues: $ZodIssue[] }) => MaybeAsync<void>) | SomeType)[]
  ): this {
    return this.check(...values);
  }
}

// Schemas may act as checks: a format schema contributes its checks, a bare
// host schema (z.custom) contributes its refinement. Anything else is rejected.
function toRuntimeChecks(values: readonly unknown[]): RuntimeCheck[] {
  const out: RuntimeCheck[] = [];
  for (const value of values) {
    if (typeof value === "function") {
      const checkFn = value as CheckFn;
      const fn: HostFunction = (input, context) => checkFn({ value: input, issues: context.issues as $ZodIssue[] });
      out.push({ check: { c: "host_runtime", op: "check", fn } });
    } else if (value instanceof ZodMiniType || value instanceof ClassicType) {
      const schemaNode = value._zod.node;
      if (schemaNode.kind === "host" && schemaNode.inner === null) {
        out.push({ check: { c: "host_runtime", op: schemaNode.op, fn: schemaNode.fn }, error: schemaNode.error });
      } else if (schemaNode.checks.length > 0) {
        out.push(...schemaNode.checks);
      } else {
        throw new TypeError("Only schemas carrying checks (formats, z.custom) can be used as a check");
      }
    } else if (typeof value === "object" && value !== null && "_zod" in value) {
      out.push((value as ClassicCheck)._zod);
    } else {
      out.push(value as RuntimeCheck);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema classes (behavior lives in the base; subclasses carry type identity)
// ---------------------------------------------------------------------------

export class ZodMiniString<Input = unknown> extends ZodMiniType<string, Input> {
  declare readonly type: "string";
}
export class ZodMiniStringFormat<Format extends string = string> extends ZodMiniString<string> {}
export class ZodMiniCustomStringFormat<Format extends string = string> extends ZodMiniStringFormat<Format> {}
export class ZodMiniEmail extends ZodMiniStringFormat<"email"> {}
export class ZodMiniGUID extends ZodMiniStringFormat<"guid"> {}
export class ZodMiniUUID extends ZodMiniStringFormat<"uuid"> {}
export class ZodMiniURL extends ZodMiniStringFormat<"url"> {}
export class ZodMiniEmoji extends ZodMiniStringFormat<"emoji"> {}
export class ZodMiniNanoID extends ZodMiniStringFormat<"nanoid"> {}
export class ZodMiniCUID extends ZodMiniStringFormat<"cuid"> {}
export class ZodMiniCUID2 extends ZodMiniStringFormat<"cuid2"> {}
export class ZodMiniULID extends ZodMiniStringFormat<"ulid"> {}
export class ZodMiniXID extends ZodMiniStringFormat<"xid"> {}
export class ZodMiniKSUID extends ZodMiniStringFormat<"ksuid"> {}
export class ZodMiniIPv4 extends ZodMiniStringFormat<"ipv4"> {}
export class ZodMiniIPv6 extends ZodMiniStringFormat<"ipv6"> {}
export class ZodMiniCIDRv4 extends ZodMiniStringFormat<"cidrv4"> {}
export class ZodMiniCIDRv6 extends ZodMiniStringFormat<"cidrv6"> {}
export class ZodMiniMAC extends ZodMiniStringFormat<"mac"> {}
export class ZodMiniBase64 extends ZodMiniStringFormat<"base64"> {}
export class ZodMiniBase64URL extends ZodMiniStringFormat<"base64url"> {}
export class ZodMiniE164 extends ZodMiniStringFormat<"e164"> {}
export class ZodMiniJWT extends ZodMiniStringFormat<"jwt"> {}
export class ZodMiniISODateTime extends ZodMiniStringFormat<"datetime"> {}
export class ZodMiniISODate extends ZodMiniStringFormat<"date"> {}
export class ZodMiniISOTime extends ZodMiniStringFormat<"time"> {}
export class ZodMiniISODuration extends ZodMiniStringFormat<"duration"> {}
export class ZodMiniNumber<Input = unknown> extends ZodMiniType<number, Input> {
  declare readonly type: "number";
}
export class ZodMiniNumberFormat extends ZodMiniNumber<number> {}
export class ZodMiniBigInt<Input = unknown> extends ZodMiniType<bigint, Input> {
  declare readonly type: "bigint";
}
export class ZodMiniBigIntFormat extends ZodMiniBigInt<bigint> {}
export class ZodMiniBoolean<Input = unknown> extends ZodMiniType<boolean, Input> {
  declare readonly type: "boolean";
}
export class ZodMiniDate<Input = unknown> extends ZodMiniType<Date, Input> {
  declare readonly type: "date";
}
export class ZodMiniSymbol extends ZodMiniType<symbol, symbol> {
  declare readonly type: "symbol";
}
export class ZodMiniUndefined extends ZodMiniType<undefined, undefined> {
  declare readonly type: "undefined";
}
export class ZodMiniNull extends ZodMiniType<null, null> {
  declare readonly type: "null";
}
// `any` is intentional: ZodMiniAny must stay assignable to and from everything.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class ZodMiniAny extends ZodMiniType<any, any> {
  declare readonly type: "any";
}
export class ZodMiniUnknown extends ZodMiniType<unknown, unknown> {
  declare readonly type: "unknown";
}
export class ZodMiniNever extends ZodMiniType<never, never> {
  declare readonly type: "never";
}
export class ZodMiniVoid extends ZodMiniType<void, void> {
  declare readonly type: "void";
}
export class ZodMiniNaN extends ZodMiniType<number, number> {
  declare readonly type: "nan";
}
export class ZodMiniArray<T extends SomeMini = SomeMini> extends ZodMiniType<output<T>[], input<T>[]> {
  declare readonly type: "array";
}
export class ZodMiniObject<S extends MiniShape = MiniShape> extends ZodMiniType<ObjectOutput<S>, ObjectInput<S>> {
  declare readonly type: "object";
}
export class ZodMiniUnion<T extends readonly SomeMini[] = readonly SomeMini[]> extends ZodMiniType<output<T[number]>, input<T[number]>> {
  declare readonly type: "union";
}
export class ZodMiniXor<T extends readonly SomeMini[] = readonly SomeMini[]> extends ZodMiniUnion<T> {}
export class ZodMiniDiscriminatedUnion<T extends readonly SomeMini[] = readonly SomeMini[]> extends ZodMiniUnion<T> {}
export class ZodMiniIntersection<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> extends ZodMiniType<output<A> & output<B>, input<A> & input<B>> {
  declare readonly type: "intersection";
}
export class ZodMiniTuple<T extends readonly SomeMini[] = readonly SomeMini[], Rest extends SomeMini | null = null> extends ZodMiniType<
  TupleOutput<T, Rest>,
  TupleInput<T, Rest>
> {
  declare readonly type: "tuple";
}
export class ZodMiniRecord<K extends SomeMini = SomeMini, V extends SomeMini = SomeMini> extends ZodMiniType<Record<string, output<V>>, Record<string, input<V>>> {
  declare readonly type: "record";
}
export class ZodMiniMap<Key extends SomeMini = SomeMini, Value extends SomeMini = SomeMini> extends ZodMiniType<
  Map<output<Key>, output<Value>>,
  Map<input<Key>, input<Value>>
> {
  declare readonly type: "map";
}
export class ZodMiniSet<T extends SomeMini = SomeMini> extends ZodMiniType<Set<output<T>>, Set<input<T>>> {
  declare readonly type: "set";
}
export class ZodMiniEnum<T extends string | number = string | number> extends ZodMiniType<T, T> {
  declare readonly type: "enum";
}
export class ZodMiniLiteral<T extends Primitive = Primitive> extends ZodMiniType<T, T> {
  declare readonly type: "literal";
}
type FileValue = ClassicInfer<ZodFile>;
export class ZodMiniFile extends ZodMiniType<FileValue, FileValue> {
  declare readonly type: "file";
}
export class ZodMiniTransform<O = unknown, I = unknown> extends ZodMiniType<O, I> {
  declare readonly type: "host";
}
export class ZodMiniOptional<T extends SomeMini = SomeMini> extends ZodMiniType<output<T> | undefined, input<T> | undefined> {
  declare readonly type: "optional";
}
export class ZodMiniNullable<T extends SomeMini = SomeMini> extends ZodMiniType<output<T> | null, input<T> | null> {
  declare readonly type: "nullable";
}
export class ZodMiniDefault<T extends SomeMini = SomeMini> extends ZodMiniType<NoUndefined<output<T>>, input<T> | undefined> {
  declare readonly type: "default";
}
export class ZodMiniPrefault<T extends SomeMini = SomeMini> extends ZodMiniType<output<T>, input<T> | undefined> {
  declare readonly type: "prefault";
}
export class ZodMiniNonOptional<T extends SomeMini = SomeMini> extends ZodMiniType<Exclude<output<T>, undefined>, input<T>> {
  declare readonly type: "nonoptional";
}
export class ZodMiniSuccess<T extends SomeMini = SomeMini> extends ZodMiniType<boolean, unknown> {
  declare readonly type: "host";
}
export class ZodMiniCatch<T extends SomeMini = SomeMini> extends ZodMiniType<output<T>, input<T>> {
  declare readonly type: "catch";
}
export class ZodMiniPipe<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> extends ZodMiniType<output<B>, input<A>> {
  declare readonly type: "pipe";
}
export class ZodMiniCodec<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> extends ZodMiniPipe<A, B> {}
export class ZodMiniReadonly<T extends SomeMini = SomeMini> extends ZodMiniType<Readonly<output<T>>, input<T>> {
  declare readonly type: "readonly";
}
export class ZodMiniTemplateLiteral<Template extends string = string> extends ZodMiniType<Template, Template> {
  declare readonly type: "templateLiteral";
}
export class ZodMiniLazy<T extends SomeMini = SomeMini> extends ZodMiniType<output<T>, input<T>> {
  declare readonly type: "lazy";
}
export class ZodMiniPromise<T extends SomeMini = SomeMini> extends ZodMiniType<Promise<output<T>>, Promise<input<T>>> {
  declare readonly type: "promise";
}
export class ZodMiniCustom<O = unknown, I = unknown> extends ZodMiniType<O, I> {
  declare readonly type: "host";
}
export class ZodMiniFunction extends ZodMiniType<(...args: never[]) => unknown, (...args: never[]) => unknown> {
  declare readonly type: "function";
}
export class ZodMiniJSONSchema extends ZodMiniType<JSONType, unknown> {
  declare readonly type: "host";
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

function errorMap(params?: ErrorParam): $ZodErrorMap | undefined {
  if (typeof params === "string") return () => params;
  const candidate = params?.error;
  if (typeof candidate === "string") return () => candidate;
  return candidate;
}

function formatString(id: FormatId, params?: ErrorParam, formatParams?: Readonly<Record<string, unknown>>): SchemaNode {
  return node({ kind: "string" }, { checks: [classicFormat(id, params, formatParams)._zod] });
}

function formattedDef(format: string, schemaNode: SchemaNode): MiniDef {
  return { type: "string", format, checks: schemaNode.checks };
}

// Object shapes may use getters for recursion; each getter becomes a memoized
// lazy node so evaluation is deferred until parse time (after the schema name
// has left its TDZ).
function shapeNodes(shape: MiniShape): Record<string, SchemaNode> {
  const nodes: Record<string, SchemaNode> = {};
  for (const key of Reflect.ownKeys(shape)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(shape, key);
    if (!descriptor) continue;
    if ("value" in descriptor) {
      nodes[key] = (descriptor.value as SomeMini)._zod.node;
    } else if (descriptor.get) {
      const getter = descriptor.get.bind(shape) as () => SomeMini;
      let resolved: SchemaNode | undefined;
      nodes[key] = node({ kind: "lazy", getter: () => (resolved ??= getter()._zod.node) });
    }
  }
  return nodes;
}

function mergeDescriptors(base: MiniShape, extension: MiniShape): MiniShape {
  const merged: Record<string, unknown> = {};
  for (const source of [base, extension]) {
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor) Object.defineProperty(merged, key, descriptor);
    }
  }
  return merged as MiniShape;
}

function objectNode(shape: MiniShape, mode: ObjectNode["mode"], params?: ErrorParam, catchall: SchemaNode | null = null): SchemaNode {
  return node({ kind: "object", shape: shapeNodes(shape), mode, catchall }, { error: errorMap(params) });
}

function assertKnownKeys(schema: ZodMiniObject, mask: Readonly<Record<string, boolean | undefined>>, caller: string): void {
  const shape = internalsOf(schema).def.shape ?? {};
  for (const key of Reflect.ownKeys(mask)) {
    if (mask[key as string] && !(key in shape)) throw new Error(`${caller}: unrecognized key "${String(key)}"`);
  }
}

// ---------------------------------------------------------------------------
// Primitive factories
// ---------------------------------------------------------------------------

export function string(params?: ErrorParam): ZodMiniString<string> {
  return new ZodMiniString({ type: "string", error: errorMap(params) }, node({ kind: "string" }, { error: errorMap(params) }));
}
export function number(params?: ErrorParam): ZodMiniNumber<number> {
  return new ZodMiniNumber({ type: "number", error: errorMap(params) }, node({ kind: "number" }, { error: errorMap(params) }));
}
export function bigint(params?: ErrorParam): ZodMiniBigInt<bigint> {
  return new ZodMiniBigInt({ type: "bigint", error: errorMap(params) }, node({ kind: "bigint" }, { error: errorMap(params) }));
}
export function boolean(params?: ErrorParam): ZodMiniBoolean<boolean> {
  return new ZodMiniBoolean({ type: "boolean", error: errorMap(params) }, node({ kind: "boolean" }, { error: errorMap(params) }));
}
export function date(params?: ErrorParam): ZodMiniDate<Date> {
  return new ZodMiniDate({ type: "date", error: errorMap(params) }, node({ kind: "date" }, { error: errorMap(params) }));
}
export function symbol(params?: ErrorParam): ZodMiniSymbol {
  return new ZodMiniSymbol({ type: "symbol", error: errorMap(params) }, node({ kind: "symbol" }, { error: errorMap(params) }));
}
export function undefined_(params?: ErrorParam): ZodMiniUndefined {
  return new ZodMiniUndefined({ type: "undefined", error: errorMap(params) }, node({ kind: "undefined" }, { error: errorMap(params) }));
}
export function null_(params?: ErrorParam): ZodMiniNull {
  return new ZodMiniNull({ type: "null", error: errorMap(params) }, node({ kind: "null" }, { error: errorMap(params) }));
}
export function void_(params?: ErrorParam): ZodMiniVoid {
  return new ZodMiniVoid({ type: "void", error: errorMap(params) }, node({ kind: "void" }, { error: errorMap(params) }));
}
export function any(): ZodMiniAny {
  return new ZodMiniAny({ type: "any" }, node({ kind: "any" }));
}
export function unknown(): ZodMiniUnknown {
  return new ZodMiniUnknown({ type: "unknown" }, node({ kind: "unknown" }));
}
export function never(params?: ErrorParam): ZodMiniNever {
  return new ZodMiniNever({ type: "never", error: errorMap(params) }, node({ kind: "never" }, { error: errorMap(params) }));
}
export function nan(params?: ErrorParam): ZodMiniNaN {
  return new ZodMiniNaN({ type: "nan", error: errorMap(params) }, node({ kind: "nan" }, { error: errorMap(params) }));
}
export function file(params?: ErrorParam): ZodMiniFile {
  return new ZodMiniFile({ type: "file", error: errorMap(params) }, node({ kind: "file" }, { error: errorMap(params) }));
}

export const coerce: {
  readonly string: (params?: ErrorParam) => ZodMiniString<unknown>;
  readonly number: (params?: ErrorParam) => ZodMiniNumber<unknown>;
  readonly boolean: (params?: ErrorParam) => ZodMiniBoolean<unknown>;
  readonly bigint: (params?: ErrorParam) => ZodMiniBigInt<unknown>;
  readonly date: (params?: ErrorParam) => ZodMiniDate<unknown>;
} = {
  string: (params) => new ZodMiniString({ type: "string", coerce: true, error: errorMap(params) }, node({ kind: "string", coerce: true }, { error: errorMap(params) })),
  number: (params) => new ZodMiniNumber({ type: "number", coerce: true, error: errorMap(params) }, node({ kind: "number", coerce: true }, { error: errorMap(params) })),
  boolean: (params) => new ZodMiniBoolean({ type: "boolean", coerce: true, error: errorMap(params) }, node({ kind: "boolean", coerce: true }, { error: errorMap(params) })),
  bigint: (params) => new ZodMiniBigInt({ type: "bigint", coerce: true, error: errorMap(params) }, node({ kind: "bigint", coerce: true }, { error: errorMap(params) })),
  date: (params) => new ZodMiniDate({ type: "date", coerce: true, error: errorMap(params) }, node({ kind: "date", coerce: true }, { error: errorMap(params) })),
};

// ---------------------------------------------------------------------------
// String format factories
// ---------------------------------------------------------------------------

export function email(params?: ErrorParam): ZodMiniEmail {
  const schemaNode = formatString("email", params);
  return new ZodMiniEmail(formattedDef("email", schemaNode), schemaNode);
}
export function guid(params?: ErrorParam): ZodMiniGUID {
  const schemaNode = formatString("guid", params);
  return new ZodMiniGUID(formattedDef("guid", schemaNode), schemaNode);
}
export function uuid(params?: ErrorParam): ZodMiniUUID {
  const schemaNode = formatString("uuid", params);
  return new ZodMiniUUID(formattedDef("uuid", schemaNode), schemaNode);
}
export function uuidv4(params?: ErrorParam): ZodMiniUUID {
  const schemaNode = formatString("uuidv4", params);
  return new ZodMiniUUID(formattedDef("uuidv4", schemaNode), schemaNode);
}
export function uuidv6(params?: ErrorParam): ZodMiniUUID {
  const schemaNode = formatString("uuidv6", params);
  return new ZodMiniUUID(formattedDef("uuidv6", schemaNode), schemaNode);
}
export function uuidv7(params?: ErrorParam): ZodMiniUUID {
  const schemaNode = formatString("uuidv7", params);
  return new ZodMiniUUID(formattedDef("uuidv7", schemaNode), schemaNode);
}
export function url(params?: ErrorParam & { readonly hostname?: RegExp; readonly protocol?: RegExp }): ZodMiniURL {
  const formatParams = typeof params === "object" ? { hostname: params.hostname, protocol: params.protocol } : undefined;
  const schemaNode = formatString("url", params, formatParams);
  return new ZodMiniURL(formattedDef("url", schemaNode), schemaNode);
}
export function httpUrl(params?: ErrorParam): ZodMiniURL {
  const schemaNode = formatString("httpUrl", params);
  return new ZodMiniURL(formattedDef("httpUrl", schemaNode), schemaNode);
}
export function hostname(params?: ErrorParam): ZodMiniCustomStringFormat<"hostname"> {
  const schemaNode = formatString("hostname", params);
  return new ZodMiniCustomStringFormat(formattedDef("hostname", schemaNode), schemaNode);
}
export function emoji(params?: ErrorParam): ZodMiniEmoji {
  const schemaNode = formatString("emoji", params);
  return new ZodMiniEmoji(formattedDef("emoji", schemaNode), schemaNode);
}
export function nanoid(params?: ErrorParam): ZodMiniNanoID {
  const schemaNode = formatString("nanoid", params);
  return new ZodMiniNanoID(formattedDef("nanoid", schemaNode), schemaNode);
}
export function cuid(params?: ErrorParam): ZodMiniCUID {
  const schemaNode = formatString("cuid", params);
  return new ZodMiniCUID(formattedDef("cuid", schemaNode), schemaNode);
}
export function cuid2(params?: ErrorParam): ZodMiniCUID2 {
  const schemaNode = formatString("cuid2", params);
  return new ZodMiniCUID2(formattedDef("cuid2", schemaNode), schemaNode);
}
export function ulid(params?: ErrorParam): ZodMiniULID {
  const schemaNode = formatString("ulid", params);
  return new ZodMiniULID(formattedDef("ulid", schemaNode), schemaNode);
}
export function xid(params?: ErrorParam): ZodMiniXID {
  const schemaNode = formatString("xid", params);
  return new ZodMiniXID(formattedDef("xid", schemaNode), schemaNode);
}
export function ksuid(params?: ErrorParam): ZodMiniKSUID {
  const schemaNode = formatString("ksuid", params);
  return new ZodMiniKSUID(formattedDef("ksuid", schemaNode), schemaNode);
}
export function ipv4(params?: ErrorParam): ZodMiniIPv4 {
  const schemaNode = formatString("ipv4", params);
  return new ZodMiniIPv4(formattedDef("ipv4", schemaNode), schemaNode);
}
export function ipv6(params?: ErrorParam): ZodMiniIPv6 {
  const schemaNode = formatString("ipv6", params);
  return new ZodMiniIPv6(formattedDef("ipv6", schemaNode), schemaNode);
}
export function ip(params?: ErrorParam): ZodMiniUnion<readonly [ZodMiniIPv4, ZodMiniIPv6]> {
  return union([ipv4(params), ipv6(params)]);
}
export function cidrv4(params?: ErrorParam): ZodMiniCIDRv4 {
  const schemaNode = formatString("cidrv4", params);
  return new ZodMiniCIDRv4(formattedDef("cidrv4", schemaNode), schemaNode);
}
export function cidrv6(params?: ErrorParam): ZodMiniCIDRv6 {
  const schemaNode = formatString("cidrv6", params);
  return new ZodMiniCIDRv6(formattedDef("cidrv6", schemaNode), schemaNode);
}
export function mac(params?: ErrorParam & { readonly delimiter?: string }): ZodMiniMAC {
  const schemaNode = formatString("mac", params, typeof params === "object" ? { delimiter: params.delimiter } : undefined);
  return new ZodMiniMAC(formattedDef("mac", schemaNode), schemaNode);
}
export function base64(params?: ErrorParam): ZodMiniBase64 {
  const schemaNode = formatString("base64", params);
  return new ZodMiniBase64(formattedDef("base64", schemaNode), schemaNode);
}
export function base64url(params?: ErrorParam): ZodMiniBase64URL {
  const schemaNode = formatString("base64url", params);
  return new ZodMiniBase64URL(formattedDef("base64url", schemaNode), schemaNode);
}
export function e164(params?: ErrorParam): ZodMiniE164 {
  const schemaNode = formatString("e164", params);
  return new ZodMiniE164(formattedDef("e164", schemaNode), schemaNode);
}
export function jwt(params?: ErrorParam): ZodMiniJWT {
  const schemaNode = formatString("jwt", params);
  return new ZodMiniJWT(formattedDef("jwt", schemaNode), schemaNode);
}
export function hex(params?: ErrorParam): ZodMiniCustomStringFormat<"hex"> {
  const schemaNode = formatString("hex", params);
  return new ZodMiniCustomStringFormat(formattedDef("hex", schemaNode), schemaNode);
}

type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha384" | "sha512";
type HashEncoding = "hex" | "base64" | "base64url";

export function hash<Alg extends HashAlgorithm, Enc extends HashEncoding = "hex">(
  algorithm: Alg,
  params?: ErrorParam & { readonly enc?: Enc },
): ZodMiniCustomStringFormat<`${Alg}_${Enc}`> {
  const schemaNode = formatString(algorithm, params, typeof params === "object" ? { enc: params.enc } : undefined);
  return new ZodMiniCustomStringFormat(formattedDef(algorithm, schemaNode), schemaNode);
}

export function stringFormat<Format extends string>(
  name: Format,
  validator: RegExp | ((value: string) => MaybeAsync<unknown>),
  params?: ErrorParam,
): ZodMiniCustomStringFormat<Format> {
  return new ZodMiniCustomStringFormat({ type: "string", format: name }, classicStringFormat(name, validator, params)._zod.node);
}

export const iso: {
  readonly datetime: (params?: ErrorParam & { readonly precision?: number | null; readonly offset?: boolean; readonly local?: boolean }) => ZodMiniISODateTime;
  readonly date: (params?: ErrorParam) => ZodMiniISODate;
  readonly time: (params?: ErrorParam & { readonly precision?: number | null }) => ZodMiniISOTime;
  readonly duration: (params?: ErrorParam) => ZodMiniISODuration;
} = {
  datetime: (params) => {
    const schemaNode = formatString("datetime", params, typeof params === "object" ? params : undefined);
    return new ZodMiniISODateTime(formattedDef("datetime", schemaNode), schemaNode);
  },
  date: (params) => {
    const schemaNode = formatString("date", params);
    return new ZodMiniISODate(formattedDef("date", schemaNode), schemaNode);
  },
  time: (params) => {
    const schemaNode = formatString("time", params, typeof params === "object" ? params : undefined);
    return new ZodMiniISOTime(formattedDef("time", schemaNode), schemaNode);
  },
  duration: (params) => {
    const schemaNode = formatString("duration", params);
    return new ZodMiniISODuration(formattedDef("duration", schemaNode), schemaNode);
  },
};

// ---------------------------------------------------------------------------
// Number / bigint format factories
// ---------------------------------------------------------------------------

export function int(params?: ErrorParam): ZodMiniNumberFormat {
  const schemaNode = classicInt(params)._zod.node;
  return new ZodMiniNumberFormat({ type: "number", format: "safeint", checks: schemaNode.checks }, schemaNode);
}
export function int32(params?: ErrorParam): ZodMiniNumberFormat {
  const schemaNode = classicInt32(params)._zod.node;
  return new ZodMiniNumberFormat({ type: "number", format: "int32", checks: schemaNode.checks }, schemaNode);
}
export function uint32(params?: ErrorParam): ZodMiniNumberFormat {
  const schemaNode = classicUint32(params)._zod.node;
  return new ZodMiniNumberFormat({ type: "number", format: "uint32", checks: schemaNode.checks }, schemaNode);
}
export function float32(params?: ErrorParam): ZodMiniNumberFormat {
  const schemaNode = classicFloat32(params)._zod.node;
  return new ZodMiniNumberFormat({ type: "number", format: "float32", checks: schemaNode.checks }, schemaNode);
}
export function float64(params?: ErrorParam): ZodMiniNumberFormat {
  const schemaNode = classicFloat64(params)._zod.node;
  return new ZodMiniNumberFormat({ type: "number", format: "float64", checks: schemaNode.checks }, schemaNode);
}
export function int64(params?: ErrorParam): ZodMiniBigIntFormat {
  const schemaNode = classicInt64(params)._zod.node;
  return new ZodMiniBigIntFormat({ type: "bigint", format: "int64", checks: schemaNode.checks }, schemaNode);
}
export function uint64(params?: ErrorParam): ZodMiniBigIntFormat {
  const schemaNode = classicUint64(params)._zod.node;
  return new ZodMiniBigIntFormat({ type: "bigint", format: "uint64", checks: schemaNode.checks }, schemaNode);
}

// ---------------------------------------------------------------------------
// Composite factories
// ---------------------------------------------------------------------------

export function literal<const T extends Primitive>(value: T | readonly T[], params?: ErrorParam): ZodMiniLiteral<T> {
  const schemaNode = classicLiteral(value, params)._zod.node;
  const values = schemaNode.kind === "literal" ? schemaNode.values : [];
  return new ZodMiniLiteral({ type: "literal", values: [...values], error: errorMap(params) }, schemaNode);
}

export function enum_<const T extends readonly string[]>(values: T, params?: ErrorParam): ZodMiniEnum<T[number]>;
export function enum_<const T extends Readonly<Record<string, string | number>>>(values: T, params?: ErrorParam): ZodMiniEnum<T[keyof T]>;
export function enum_(values: readonly string[] | Readonly<Record<string, string | number>>, params?: ErrorParam): ZodMiniEnum<string | number> {
  const schemaNode = classicEnum(values as Readonly<Record<string, string | number>>, params)._zod.node;
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((entry) => [entry, entry])) : values;
  const nodeValues = schemaNode.kind === "enum" ? schemaNode.values : [];
  return new ZodMiniEnum({ type: "enum", entries, values: [...nodeValues], error: errorMap(params) }, schemaNode);
}
export const nativeEnum: typeof enum_ = enum_;

export function object<const S extends MiniShape = Record<never, SomeMini>>(shape?: S, params?: ErrorParam): ZodMiniObject<Writeable<S>> {
  const value = (shape ?? {}) as Writeable<S>;
  return new ZodMiniObject({ type: "object", shape: value, error: errorMap(params) }, objectNode(value, "strip", params));
}
export function strictObject<const S extends MiniShape>(shape: S, params?: ErrorParam): ZodMiniObject<Writeable<S>> {
  const value = shape as Writeable<S>;
  return new ZodMiniObject({ type: "object", shape: value, error: errorMap(params) }, objectNode(value, "strict", params));
}
export function looseObject<const S extends MiniShape>(shape: S, params?: ErrorParam): ZodMiniObject<Writeable<S>> {
  const value = shape as Writeable<S>;
  return new ZodMiniObject({ type: "object", shape: value, error: errorMap(params) }, objectNode(value, "passthrough", params));
}

export function extend<T extends ZodMiniObject, U extends MiniShape>(schema: T, extension: U): ZodMiniObject<Writeable<ShapeOf<T> & U>> {
  const merged = mergeDescriptors(internalsOf(schema).def.shape ?? {}, extension) as Writeable<ShapeOf<T> & U>;
  const baseNode = schema._zod.node;
  if (baseNode.kind !== "object") throw new TypeError("extend() is only valid on object schemas");
  return new ZodMiniObject(
    { ...internalsOf(schema).def, shape: merged },
    cloneNode(baseNode, { shape: { ...baseNode.shape, ...shapeNodes(extension) } }),
    schema,
  );
}

export function safeExtend<T extends ZodMiniObject, U extends MiniShape>(schema: T, extension: U): ZodMiniObject<Writeable<ShapeOf<T> & U>> {
  return extend(schema, extension);
}

export function merge<T extends ZodMiniObject, U extends ZodMiniObject>(a: T, b: U): ZodMiniObject<Writeable<ShapeOf<T> & U["shape"]>> {
  return extend(a, internalsOf(b).def.shape ?? {}) as ZodMiniObject<Writeable<ShapeOf<T> & U["shape"]>>;
}

function maskedObject(schema: ZodMiniObject, mask: Readonly<Record<string, boolean | undefined>>, keep: (key: string) => boolean, caller: string): ZodMiniObject {
  assertKnownKeys(schema, mask, caller);
  const baseNode = schema._zod.node;
  if (baseNode.kind !== "object") throw new TypeError(`${caller}() is only valid on object schemas`);
  const shape = internalsOf(schema).def.shape ?? {};
  const nextShape: Record<string, unknown> = {};
  const nextNodes: Record<string, SchemaNode> = {};
  for (const key of Reflect.ownKeys(shape)) {
    if (!keep(key as string)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(shape, key);
    const childNode = baseNode.shape[key as string];
    if (descriptor && childNode) {
      Object.defineProperty(nextShape, key, descriptor);
      nextNodes[key as string] = childNode;
    }
  }
  return new ZodMiniObject({ ...internalsOf(schema).def, shape: nextShape as MiniShape }, cloneNode(baseNode, { shape: nextNodes }), schema);
}

export function pick<T extends ZodMiniObject, M extends Readonly<Partial<Record<keyof ShapeOf<T>, boolean>>>>(
  schema: T,
  mask: M,
): ZodMiniObject<Pick<ShapeOf<T>, Extract<keyof M, keyof ShapeOf<T>>>> {
  return maskedObject(schema, mask, (key) => mask[key as keyof M] === true, "pick") as ZodMiniObject<Pick<ShapeOf<T>, Extract<keyof M, keyof ShapeOf<T>>>>;
}

export function omit<T extends ZodMiniObject, M extends Readonly<Partial<Record<keyof ShapeOf<T>, boolean>>>>(
  schema: T,
  mask: M,
): ZodMiniObject<Omit<ShapeOf<T>, Extract<keyof M, keyof ShapeOf<T>>>> {
  return maskedObject(schema, mask, (key) => mask[key as keyof M] !== true, "omit") as ZodMiniObject<Omit<ShapeOf<T>, Extract<keyof M, keyof ShapeOf<T>>>>;
}

function wrapShape(schema: ZodMiniObject, mask: Readonly<Record<string, boolean | undefined>> | undefined, wrap: (child: SomeMini) => SomeMini, unwrap: (childNode: SchemaNode) => SchemaNode, caller: string): ZodMiniObject {
  if (mask) assertKnownKeys(schema, mask, caller);
  const baseNode = schema._zod.node;
  if (baseNode.kind !== "object") throw new TypeError(`${caller}() is only valid on object schemas`);
  const shape = internalsOf(schema).def.shape ?? {};
  const targeted = (key: string): boolean => mask === undefined || mask[key] === true;
  const nextShape: Record<string, unknown> = {};
  const nextNodes: Record<string, SchemaNode> = {};
  for (const key of Reflect.ownKeys(shape)) {
    const descriptor = Object.getOwnPropertyDescriptor(shape, key);
    const childNode = baseNode.shape[key as string];
    if (!descriptor || !childNode) continue;
    if (!targeted(key as string) || !("value" in descriptor)) {
      Object.defineProperty(nextShape, key, descriptor);
      nextNodes[key as string] = childNode;
      continue;
    }
    nextShape[key as string] = wrap(descriptor.value as SomeMini);
    nextNodes[key as string] = unwrap(childNode);
  }
  return new ZodMiniObject({ ...internalsOf(schema).def, shape: nextShape as MiniShape }, cloneNode(baseNode, { shape: nextNodes }), schema);
}

export function partial<T extends ZodMiniObject>(schema: T): ZodMiniObject<{ [K in keyof ShapeOf<T>]: ZodMiniOptional<ShapeOf<T>[K]> }>;
export function partial<T extends ZodMiniObject, M extends Readonly<Partial<Record<keyof ShapeOf<T>, boolean>>>>(
  schema: T,
  mask: M,
): ZodMiniObject<{ [K in keyof ShapeOf<T>]: K extends keyof M ? (M[K] extends true ? ZodMiniOptional<ShapeOf<T>[K]> : ShapeOf<T>[K]) : ShapeOf<T>[K] }>;
export function partial(schema: ZodMiniObject, mask?: Readonly<Record<string, boolean | undefined>>): ZodMiniObject {
  return wrapShape(schema, mask, (child) => optional(child), (childNode) => node({ kind: "optional", inner: childNode }), "partial");
}

export function required<T extends ZodMiniObject>(schema: T): ZodMiniObject<{ [K in keyof ShapeOf<T>]: ZodMiniNonOptional<ShapeOf<T>[K]> }>;
export function required<T extends ZodMiniObject, M extends Readonly<Partial<Record<keyof ShapeOf<T>, boolean>>>>(
  schema: T,
  mask: M,
): ZodMiniObject<{ [K in keyof ShapeOf<T>]: K extends keyof M ? (M[K] extends true ? ZodMiniNonOptional<ShapeOf<T>[K]> : ShapeOf<T>[K]) : ShapeOf<T>[K] }>;
export function required(schema: ZodMiniObject, mask?: Readonly<Record<string, boolean | undefined>>): ZodMiniObject {
  return wrapShape(
    schema,
    mask,
    (child) => nonoptional(child),
    (childNode) => (childNode.kind === "optional" ? childNode.inner : childNode),
    "required",
  );
}

export function catchall<T extends ZodMiniObject, U extends SomeMini>(schema: T, catchallSchema: U): ZodMiniObject<ShapeOf<T>> {
  const baseNode = schema._zod.node;
  if (baseNode.kind !== "object") throw new TypeError("catchall() is only valid on object schemas");
  return new ZodMiniObject(
    { ...internalsOf(schema).def, catchall: catchallSchema },
    cloneNode(baseNode, { catchall: catchallSchema._zod.node }),
    schema,
  );
}

export function keyof<T extends ZodMiniObject>(schema: T): ZodMiniEnum<Extract<keyof ShapeOf<T>, string>> {
  const keys = Reflect.ownKeys(internalsOf(schema).def.shape ?? {}).filter((key): key is string => typeof key === "string");
  const schemaNode = node({ kind: "enum", values: keys });
  return new ZodMiniEnum({ type: "enum", entries: Object.fromEntries(keys.map((key) => [key, key])), values: keys }, schemaNode) as ZodMiniEnum<
    Extract<keyof ShapeOf<T>, string>
  >;
}

export function array<T extends SomeMini>(element: T, params?: ErrorParam): ZodMiniArray<T> {
  return new ZodMiniArray({ type: "array", element, error: errorMap(params) }, node({ kind: "array", element: element._zod.node }, { error: errorMap(params) }));
}

export function tuple<const T extends readonly SomeMini[], Rest extends SomeMini | null = null>(
  items: T,
  restOrParams?: Rest | ErrorParam,
  params?: ErrorParam,
): ZodMiniTuple<T, Rest> {
  const rest = restOrParams instanceof ZodMiniType ? restOrParams : null;
  const error = rest ? params : (restOrParams as ErrorParam | undefined);
  return new ZodMiniTuple(
    { type: "tuple", items, rest, error: errorMap(error) },
    node({ kind: "tuple", items: items.map((item) => item._zod.node), rest: rest?._zod.node ?? null }, { error: errorMap(error) }),
  );
}

export function union<const T extends readonly SomeMini[]>(options: T, params?: ErrorParam): ZodMiniUnion<T> {
  return new ZodMiniUnion(
    { type: "union", options, error: errorMap(params) },
    node({ kind: "union", options: options.map((option) => option._zod.node) }, { error: errorMap(params) }),
  );
}

export function xor<const T extends readonly SomeMini[]>(options: T, params?: ErrorParam): ZodMiniXor<T> {
  return new ZodMiniXor({ type: "union", options, error: errorMap(params) }, node({ kind: "union", options: options.map((option) => option._zod.node) }, { error: errorMap(params) }));
}

export function discriminatedUnion<const T extends readonly SomeMini[]>(key: string, options: T, params?: ErrorParam): ZodMiniDiscriminatedUnion<T> {
  return new ZodMiniDiscriminatedUnion({ type: "union", options, error: errorMap(params) }, classicDiscriminatedUnion(key, options as readonly SomeType[], params)._zod.node);
}

export function intersection<A extends SomeMini, B extends SomeMini>(left: A, right: B): ZodMiniIntersection<A, B> {
  return new ZodMiniIntersection({ type: "intersection", left, right }, node({ kind: "intersection", left: left._zod.node, right: right._zod.node }));
}

export function record<K extends SomeMini, V extends SomeMini>(key: K, value?: V, params?: ErrorParam): ZodMiniRecord<K, V> {
  const keySchema = (value === undefined ? string() : key) as K;
  const valueSchema = (value === undefined ? key : value) as V;
  return new ZodMiniRecord(
    { type: "record", keyType: keySchema, valueType: valueSchema, error: errorMap(params) },
    node({ kind: "record", key: keySchema._zod.node, value: valueSchema._zod.node }, { error: errorMap(params) }),
  );
}

export function map<Key extends SomeMini, Value extends SomeMini>(key: Key, value: Value, params?: ErrorParam): ZodMiniMap<Key, Value> {
  return new ZodMiniMap(
    { type: "map", keyType: key, valueType: value, error: errorMap(params) },
    node({ kind: "map", key: key._zod.node, value: value._zod.node }, { error: errorMap(params) }),
  );
}

export function set<T extends SomeMini>(value: T, params?: ErrorParam): ZodMiniSet<T> {
  return new ZodMiniSet({ type: "set", valueType: value, error: errorMap(params) }, node({ kind: "set", value: value._zod.node }, { error: errorMap(params) }));
}

// ---------------------------------------------------------------------------
// Wrapper factories
// ---------------------------------------------------------------------------

export function optional<T extends SomeMini>(inner: T): ZodMiniOptional<T> {
  return new ZodMiniOptional({ type: "optional", innerType: inner }, node({ kind: "optional", inner: inner._zod.node }));
}
export function nullable<T extends SomeMini>(inner: T): ZodMiniNullable<T> {
  return new ZodMiniNullable({ type: "nullable", innerType: inner }, node({ kind: "nullable", inner: inner._zod.node }));
}
export function nullish<T extends SomeMini>(inner: T): ZodMiniOptional<ZodMiniNullable<T>> {
  return optional(nullable(inner));
}
export function nonoptional<T extends SomeMini>(inner: T, params?: ErrorParam): ZodMiniNonOptional<T> {
  return new ZodMiniNonOptional({ type: "nonoptional", innerType: inner, error: errorMap(params) }, node({ kind: "nonoptional", inner: inner._zod.node }, { error: errorMap(params) }));
}
export function readonly<T extends SomeMini>(inner: T): ZodMiniReadonly<T> {
  return new ZodMiniReadonly({ type: "readonly", innerType: inner }, node({ kind: "readonly", inner: inner._zod.node }));
}
export function promise<T extends SomeMini>(inner: T): ZodMiniPromise<T> {
  return new ZodMiniPromise({ type: "promise", innerType: inner }, node({ kind: "promise", inner: inner._zod.node }));
}
export function lazy<T extends SomeMini>(getter: () => T): ZodMiniLazy<T> {
  return new ZodMiniLazy({ type: "lazy", getter }, node({ kind: "lazy", getter: () => getter()._zod.node }));
}
export function _default<T extends SomeMini>(inner: T, value: NoUndefined<output<T>> | (() => NoUndefined<output<T>>)): ZodMiniDefault<T> {
  return new ZodMiniDefault(
    { type: "default", innerType: inner, defaultValue: value },
    node({ kind: "default", inner: inner._zod.node, value, dynamic: typeof value === "function" }),
  );
}
export function prefault<T extends SomeMini>(inner: T, value: input<T> | (() => input<T>)): ZodMiniPrefault<T> {
  return new ZodMiniPrefault(
    { type: "prefault", innerType: inner, defaultValue: value },
    node({ kind: "prefault", inner: inner._zod.node, value, dynamic: typeof value === "function" }),
  );
}
export function catch_<T extends SomeMini>(inner: T, value: output<T> | ((context: { readonly error: ZodError; readonly input: unknown }) => output<T>)): ZodMiniCatch<T> {
  return new ZodMiniCatch(
    { type: "catch", innerType: inner, catchValue: value },
    node({ kind: "catch", inner: inner._zod.node, value, dynamic: typeof value === "function" }),
  );
}
export function success<T extends SomeMini>(inner: T): ZodMiniSuccess<T> {
  const fn: HostFunction = (value) => inner.safeParse(value).success;
  return new ZodMiniSuccess({ type: "success", innerType: inner }, node({ kind: "host", inner: null, fn, op: "transform" }));
}

// ---------------------------------------------------------------------------
// Pipes, codecs, transforms
// ---------------------------------------------------------------------------

export function pipe<A extends SomeMini, B extends SomeMini>(a: A, b: B): ZodMiniPipe<A, B> {
  return new ZodMiniPipe({ type: "pipe", in: a, out: b }, node({ kind: "pipe", a: a._zod.node, b: b._zod.node }));
}

export interface CodecHandlers<A extends SomeMini, B extends SomeMini> {
  readonly decode: (value: output<A>, context: RefinementCtx<output<A>>) => MaybeAsync<input<B>>;
  readonly encode: (value: input<B>, context: RefinementCtx<input<B>>) => MaybeAsync<output<A>>;
}

export function codec<A extends SomeMini, B extends SomeMini>(inputSchema: A, outputSchema: B, handlers: CodecHandlers<A, B>): ZodMiniCodec<A, B> {
  const schemaNode = classicCodec(inputSchema, outputSchema, handlers)._zod.node;
  return new ZodMiniCodec(
    { type: "pipe", in: inputSchema, out: outputSchema, transform: handlers.decode, reverseTransform: handlers.encode },
    schemaNode,
  );
}

export function invertCodec<A extends SomeMini, B extends SomeMini>(schema: ZodMiniCodec<A, B>): ZodMiniCodec<B, A> {
  const def = internalsOf(schema).def;
  if (!def.out || !def.in || !def.transform || !def.reverseTransform) throw new TypeError("invertCodec() requires a codec schema");
  const handlers = { decode: def.reverseTransform, encode: def.transform } as CodecHandlers<B, A>;
  return codec(def.out as B, def.in as A, handlers);
}

export function transform<I = unknown, O = I>(fn: (input: I, context: RefinementCtx<I>) => MaybeAsync<O>): ZodMiniTransform<Awaited<O>, I> {
  return new ZodMiniTransform({ type: "transform", transform: fn as MiniDef["transform"] }, classicTransform(fn)._zod.node);
}

export function preprocess<A, U extends SomeMini, B = unknown>(fn: (arg: B, context: RefinementCtx<B>) => MaybeAsync<A>, schema: U): ZodMiniPipe<ZodMiniTransform<A, B>, U> {
  return new ZodMiniPipe({ type: "pipe", out: schema }, classicPreprocess(fn, schema as SomeType)._zod.node);
}

export function stringbool(params?: {
  readonly truthy?: readonly string[];
  readonly falsy?: readonly string[];
  readonly case?: "sensitive" | "insensitive";
  readonly error?: string | $ZodErrorMap;
}): ZodMiniCodec<ZodMiniString<string>, ZodMiniBoolean<boolean>> {
  return new ZodMiniCodec({ type: "pipe" }, classicStringbool(params)._zod.node);
}

export function jsonString(params?: ErrorParam): ZodMiniCodec<ZodMiniString<string>, ZodMiniJSONSchema> {
  return codec(string(params), json(), {
    decode: (value) => JSON.parse(value) as JSONType,
    encode: (value) => JSON.stringify(value),
  });
}

type TemplatePart = string | number | bigint | boolean | null | SomeMini;
type PartString<P> = P extends SomeMini ? (output<P> extends infer V ? (V extends string | number | bigint | boolean | null ? `${V}` : string) : string) : `${P & string}`;
type TemplateString<Parts extends readonly unknown[], Acc extends string = ""> = Parts extends readonly [infer Head, ...infer Tail]
  ? TemplateString<Tail, `${Acc}${PartString<Head>}`>
  : Acc;

export function templateLiteral<const Parts extends readonly TemplatePart[]>(parts: Parts, params?: ErrorParam): ZodMiniTemplateLiteral<TemplateString<Parts>> {
  return new ZodMiniTemplateLiteral({ type: "template_literal", parts, error: errorMap(params) }, classicTemplateLiteral(parts as readonly (string | number | bigint | boolean | null | SomeType)[], params)._zod.node);
}

// ---------------------------------------------------------------------------
// Custom / refine / instanceof / function / json
// ---------------------------------------------------------------------------

export function custom<O = unknown>(predicate: (data: unknown) => MaybeAsync<unknown> = () => true, params?: ErrorParam): ZodMiniCustom<O, O> {
  return new ZodMiniCustom({ type: "custom", fn: predicate, error: errorMap(params) }, classicCustom(predicate, params)._zod.node);
}

export function instanceOf<T extends abstract new (...args: never[]) => object>(constructor: T, params?: ErrorParam): ZodMiniCustom<InstanceType<T>, InstanceType<T>> {
  return new ZodMiniCustom(
    { type: "custom", error: errorMap(params ?? `Input not instance of ${constructor.name}`) },
    classicInstanceOf(constructor, params)._zod.node,
  );
}

export function _function(params?: ErrorParam): ZodMiniFunction {
  return new ZodMiniFunction({ type: "function", error: errorMap(params) }, classicFunction(undefined, params)._zod.node);
}

export function json(params?: ErrorParam): ZodMiniJSONSchema {
  return new ZodMiniJSONSchema({ type: "custom", error: errorMap(params) }, classicJson(params)._zod.node);
}

// ---------------------------------------------------------------------------
// Check factories (mini-owned host checks; wire checks are re-exported below)
// ---------------------------------------------------------------------------

export function refine<T>(refinement: (arg: T) => MaybeAsync<unknown>, params?: ErrorParam): ClassicCheck<T> {
  const fn: HostFunction = (value) => refinement(value as T);
  return { _zod: { check: { c: "host_runtime", op: "refine", fn }, error: errorMap(params), abort: typeof params === "object" ? params.abort : undefined } };
}

export function superRefine<T>(refinement: (arg: T, context: RefinementCtx<T>) => MaybeAsync<void>, params?: ErrorParam): ClassicCheck<T> {
  const fn: HostFunction = (value, context) => refinement(value as T, context as RefinementCtx<T>);
  return { _zod: { check: { c: "host_runtime", op: "superRefine", fn }, error: errorMap(params), abort: typeof params === "object" ? params.abort : undefined } };
}

export function check<O = unknown>(fn: CheckFn, params?: ErrorParam): ClassicCheck<O> {
  const host: HostFunction = (value, context) => fn({ value: value as O, issues: context.issues as $ZodIssue[] });
  return { _zod: { check: { c: "host_runtime", op: "check", fn: host }, error: errorMap(params), abort: typeof params === "object" ? params.abort : undefined } };
}

// ---------------------------------------------------------------------------
// Parse entry points (free functions delegating to the schema's own methods)
// ---------------------------------------------------------------------------

export function parse<T extends SomeMini>(schema: T, value: unknown, params?: ParseContext): output<T> {
  return schema.parse(value, params) as output<T>;
}
export function safeParse<T extends SomeMini>(schema: T, value: unknown, params?: ParseContext): SafeParseResult<output<T>> {
  return schema.safeParse(value, params) as SafeParseResult<output<T>>;
}
export function parseAsync<T extends SomeMini>(schema: T, value: unknown, params?: ParseContext): Promise<output<T>> {
  return schema.parseAsync(value, params) as Promise<output<T>>;
}
export function safeParseAsync<T extends SomeMini>(schema: T, value: unknown, params?: ParseContext): Promise<SafeParseResult<output<T>>> {
  return schema.safeParseAsync(value, params) as Promise<SafeParseResult<output<T>>>;
}
export function encode<T extends SomeMini>(schema: T, value: output<T>, params?: ParseContext): input<T> {
  return schema.encode(value, params) as input<T>;
}
export function decode<T extends SomeMini>(schema: T, value: input<T>, params?: ParseContext): output<T> {
  return schema.decode(value, params) as output<T>;
}
export function encodeAsync<T extends SomeMini>(schema: T, value: output<T>, params?: ParseContext): Promise<input<T>> {
  return schema.encodeAsync(value, params) as Promise<input<T>>;
}
export function decodeAsync<T extends SomeMini>(schema: T, value: input<T>, params?: ParseContext): Promise<output<T>> {
  return schema.decodeAsync(value, params) as Promise<output<T>>;
}
export function safeEncode<T extends SomeMini>(schema: T, value: output<T>, params?: ParseContext): SafeParseResult<input<T>> {
  return schema.safeEncode(value, params) as SafeParseResult<input<T>>;
}
export function safeDecode<T extends SomeMini>(schema: T, value: input<T>, params?: ParseContext): SafeParseResult<output<T>> {
  return schema.safeDecode(value, params) as SafeParseResult<output<T>>;
}
export function safeEncodeAsync<T extends SomeMini>(schema: T, value: output<T>, params?: ParseContext): Promise<SafeParseResult<input<T>>> {
  return schema.safeEncodeAsync(value, params) as Promise<SafeParseResult<input<T>>>;
}
export function safeDecodeAsync<T extends SomeMini>(schema: T, value: input<T>, params?: ParseContext): Promise<SafeParseResult<output<T>>> {
  return schema.safeDecodeAsync(value, params) as Promise<SafeParseResult<output<T>>>;
}
export function parseJson<T extends SomeMini>(schema: T, value: Uint8Array | ArrayBuffer | string, params?: ParseContext): output<T> {
  return schema.parseJson(value, params) as output<T>;
}
export function safeParseJson<T extends SomeMini>(schema: T, value: Uint8Array | ArrayBuffer | string, params?: ParseContext): SafeParseResult<output<T>> {
  return schema.safeParseJson(value, params) as SafeParseResult<output<T>>;
}

// ---------------------------------------------------------------------------
// JSON Schema (projection over the classic node walker, standard-schema shaped)
// ---------------------------------------------------------------------------

export interface MiniJSONSchemaResult {
  readonly [key: string]: unknown;
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (params?: Readonly<Record<string, unknown>>) => Record<string, unknown>;
      readonly output: (params?: Readonly<Record<string, unknown>>) => Record<string, unknown>;
    };
  };
}

export function toJSONSchema(schema: SomeMini, params?: Readonly<Record<string, unknown>>): MiniJSONSchemaResult {
  const json = schema.toJSONSchema(params);
  return { ...json, "~standard": { jsonSchema: { input: () => json, output: () => json } } };
}

// ---------------------------------------------------------------------------
// Wire check factories re-exported from the shared implementation
// ---------------------------------------------------------------------------

export {
  minLength,
  maxLength,
  length,
  minSize,
  maxSize,
  size,
  gt,
  gte,
  gte as minimum,
  lt,
  lte,
  lte as maximum,
  positive,
  negative,
  nonpositive,
  nonnegative,
  multipleOf,
  regex,
  lowercase,
  uppercase,
  includes,
  startsWith,
  endsWith,
  trim,
  toLowerCase,
  toUpperCase,
  normalize,
  slugify,
  property,
  mime,
  overwrite,
  format,
  clone,
  NEVER,
  TimePrecision,
  regexes,
} from "../classic/schemas.js";
export type { $ZodCheck, CheckFn, RefinementCtx } from "../classic/schemas.js";

export { undefined_ as undefined, null_ as null, void_ as void, enum_ as enum, instanceOf as instanceof, _function as function, _default as default, catch_ as catch };

// ---------------------------------------------------------------------------
// Core namespace and misc re-exports
// ---------------------------------------------------------------------------

export { config, util, globalRegistry, registry, $output, $input, treeifyError, prettifyError, formatError, flattenError } from "../core/index.js";
export * as locales from "../locales/index.js";

export const core: typeof coreModule & {
  readonly $ZodType: typeof ClassicType;
  readonly $ZodCodec: typeof ZodMiniCodec;
  readonly $ZodPipe: typeof ZodMiniPipe;
  readonly $ZodError: typeof ZodError;
  readonly $ZodRealError: typeof $ZodRealError;
} = { ...coreModule, $ZodType: ClassicType, $ZodCodec: ZodMiniCodec, $ZodPipe: ZodMiniPipe, $ZodError: ZodError, $ZodRealError };

export declare namespace core {
  export type $ZodString<Input = unknown> = ZodMiniString<Input>;
  export type $ZodNumber<Input = unknown> = ZodMiniNumber<Input>;
  export type $ZodBigInt<Input = unknown> = ZodMiniBigInt<Input>;
  export type $ZodBoolean<Input = unknown> = ZodMiniBoolean<Input>;
  export type $ZodDate<Input = unknown> = ZodMiniDate<Input>;
  export type $ZodSymbol = ZodMiniSymbol;
  export type $ZodUndefined = ZodMiniUndefined;
  export type $ZodNullable<T extends SomeMini = SomeMini> = ZodMiniNullable<T>;
  export type $ZodNull = ZodMiniNull;
  export type $ZodAny = ZodMiniAny;
  export type $ZodUnknown = ZodMiniUnknown;
  export type $ZodNever = ZodMiniNever;
  export type $ZodVoid = ZodMiniVoid;
  export type $ZodArray<T extends SomeMini = SomeMini> = ZodMiniArray<T>;
  export type $ZodObject<S extends MiniShape = MiniShape> = ZodMiniObject<S>;
  export type $ZodUnion<T extends readonly SomeMini[] = readonly SomeMini[]> = ZodMiniUnion<T>;
  export type $ZodIntersection<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> = ZodMiniIntersection<A, B>;
  export type $ZodTuple<T extends readonly SomeMini[] = readonly SomeMini[], Rest extends SomeMini | null = null> = ZodMiniTuple<T, Rest>;
  export type $ZodRecord<K extends SomeMini = SomeMini, V extends SomeMini = SomeMini> = ZodMiniRecord<K, V>;
  export type $ZodMap<K extends SomeMini = SomeMini, V extends SomeMini = SomeMini> = ZodMiniMap<K, V>;
  export type $ZodSet<T extends SomeMini = SomeMini> = ZodMiniSet<T>;
  export type $ZodLiteral<T extends Primitive = Primitive> = ZodMiniLiteral<T>;
  export type $ZodEnum<T extends string | number = string | number> = ZodMiniEnum<T>;
  export type $ZodPromise<T extends SomeMini = SomeMini> = ZodMiniPromise<T>;
  export type $ZodLazy<T extends SomeMini = SomeMini> = ZodMiniLazy<T>;
  export type $ZodOptional<T extends SomeMini = SomeMini> = ZodMiniOptional<T>;
  export type $ZodDefault<T extends SomeMini = SomeMini> = ZodMiniDefault<T>;
  export type $ZodTemplateLiteral<T extends string = string> = ZodMiniTemplateLiteral<T>;
  export type $ZodCustom<O = unknown, I = unknown> = ZodMiniCustom<O, I>;
  export type $ZodTransform<O = unknown, I = unknown> = ZodMiniTransform<O, I>;
  export type $ZodNonOptional<T extends SomeMini = SomeMini> = ZodMiniNonOptional<T>;
  export type $ZodReadonly<T extends SomeMini = SomeMini> = ZodMiniReadonly<T>;
  export type $ZodNaN = ZodMiniNaN;
  export type $ZodPipe<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> = ZodMiniPipe<A, B>;
  export type $ZodCodec<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> = ZodMiniCodec<A, B>;
  export type $ZodSuccess<T extends SomeMini = SomeMini> = ZodMiniSuccess<T>;
  export type $ZodCatch<T extends SomeMini = SomeMini> = ZodMiniCatch<T>;
  export type $ZodFile = ZodMiniFile;
  export type $ZodCheck<T = unknown> = ClassicCheck<T>;
  export type $ZodNumberFormats = "int32" | "uint32" | "float32" | "float64" | "safeint";
  export interface ParsePayload<T = unknown> {
    value: T;
    issues: $ZodIssue[];
  }
  export interface $ZodCodecDef<A extends SomeMini = SomeMini, B extends SomeMini = SomeMini> {
    readonly type: "pipe";
    readonly in: A;
    readonly out: B;
    readonly transform: (value: output<A>, payload: ParsePayload<output<A>>) => MaybeAsync<input<B>>;
    readonly reverseTransform: (value: input<B>, payload: ParsePayload<input<B>>) => MaybeAsync<output<A>>;
  }
}
