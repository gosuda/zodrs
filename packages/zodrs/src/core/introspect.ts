import type { FormatId, MetadataBag, SchemaNode } from "./nodes.js";
import { escapeRegex } from "./util.js";

/**
 * Lazy `_zod` introspection mirrors Zod v4.4.3: `values`, `pattern`, `optin`,
 * `optout`, and `propValues` derived from the node graph. Memoized per node so
 * `lazy` back-edges terminate (a cycle is only reachable through a thunk that
 * itself bottoms out in a non-lazy node before recurring).
 */

const valuesCache = new WeakMap<SchemaNode, ReadonlySet<unknown> | undefined>();
const patternCache = new WeakMap<SchemaNode, RegExp | undefined>();
const optinCache = new WeakMap<SchemaNode, "optional" | undefined>();
const optoutCache = new WeakMap<SchemaNode, "optional" | undefined>();
const propValuesCache = new WeakMap<SchemaNode, Readonly<Record<string, ReadonlySet<unknown>>> | undefined>();
const bagCache = new WeakMap<SchemaNode, CheckBag>();

export interface CheckBag {
  readonly minimum?: number | bigint;
  readonly maximum?: number | bigint;
  readonly exclusiveMinimum?: number | bigint;
  readonly exclusiveMaximum?: number | bigint;
  readonly multipleOf?: number | bigint;
  readonly format?: string;
  readonly patterns?: RegExp[];
}

function maxOf(a: number | bigint | undefined, b: number | bigint): number | bigint {
  if (a === undefined) return b;
  return a > b ? a : b;
}
function minOf(a: number | bigint | undefined, b: number | bigint): number | bigint {
  if (a === undefined) return b;
  return a < b ? a : b;
}

/** Collapse a node's checks into the metadata bag Zod maintains via onattach. */
export function bagOf(node: SchemaNode): CheckBag {
  const cached = bagCache.get(node);
  if (cached) return cached as CheckBag;
  let bag: CheckBag = {};
  for (const runtime of node.checks) {
    const check = runtime.check;
    switch (check.c) {
      case "gt": {
        const v = check.bigint === true ? BigInt(check.v) : Number(check.v);
        bag = check.inclusive
          ? { ...bag, minimum: maxOf(bag.minimum, v) }
          : { ...bag, exclusiveMinimum: maxOf(bag.exclusiveMinimum, v) };
        break;
      }
      case "lt": {
        const v = check.bigint === true ? BigInt(check.v) : Number(check.v);
        bag = check.inclusive
          ? { ...bag, maximum: minOf(bag.maximum, v) }
          : { ...bag, exclusiveMaximum: minOf(bag.exclusiveMaximum, v) };
        break;
      }
      case "multiple_of":
        bag = { ...bag, multipleOf: typeof check.v === "string" ? BigInt(check.v) : check.v };
        break;
      case "number_format": {
        const ranges: Readonly<Record<string, readonly [number, number]>> = {
          safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
          int32: [-2147483648, 2147483647],
          uint32: [0, 4294967295],
          float32: [-3.4028234663852886e38, 3.4028234663852886e38],
          float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
        };
        const range = ranges[check.v];
        bag = { ...bag, format: check.v, ...(range ? { minimum: range[0], maximum: range[1] } : {}) };
        break;
      }
      case "bigint_format": {
        const ranges: Readonly<Record<string, readonly [bigint, bigint]>> = {
          int64: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")],
          uint64: [BigInt(0), BigInt("18446744073709551615")],
        };
        const range = ranges[check.v];
        bag = { ...bag, format: check.v, ...(range ? { minimum: range[0], maximum: range[1] } : {}) };
        break;
      }
      case "min_length":
      case "min_size":
        bag = { ...bag, minimum: maxOf(bag.minimum, check.v) };
        break;
      case "max_length":
      case "max_size":
        bag = { ...bag, maximum: minOf(bag.maximum, check.v) };
        break;
      case "length":
      case "size":
        bag = { ...bag, minimum: check.v, maximum: check.v };
        break;
      case "format":
        bag = { ...bag, format: check.v };
        break;
      default:
        break;
    }
  }
  bagCache.set(node, bag);
  return bag;
}

/** The finite value set a schema accepts, mirroring Zod's `_zod.values`. */
export function valuesOf(node: SchemaNode): ReadonlySet<unknown> | undefined {
  if (valuesCache.has(node)) return valuesCache.get(node);
  const computed = computeValues(node);
  valuesCache.set(node, computed);
  return computed;
}

function computeValues(node: SchemaNode): ReadonlySet<unknown> | undefined {
  switch (node.kind) {
    case "undefined":
    case "void":
      return new Set([undefined]);
    case "null":
      return new Set([null]);
    case "literal":
    case "enum":
      return new Set(node.values);
    case "optional": {
      const inner = valuesOf(node.inner);
      return inner ? new Set([...inner, undefined]) : undefined;
    }
    case "exactOptional":
      return valuesOf(node.inner);
    case "nullable": {
      const inner = valuesOf(node.inner);
      return inner ? new Set([...inner, null]) : undefined;
    }
    case "nonoptional": {
      const inner = valuesOf(node.inner);
      return inner ? new Set([...inner].filter((value) => value !== undefined)) : undefined;
    }
    case "readonly":
    case "default":
    case "prefault":
    case "catch":
      return valuesOf(node.inner);
    case "pipe":
      return valuesOf(node.a);
    case "union":
    case "discunion": {
      const sets: ReadonlySet<unknown>[] = [];
      for (const option of node.options) {
        const values = valuesOf(option);
        if (!values) return undefined;
        sets.push(values);
      }
      const merged = new Set<unknown>();
      for (const set of sets) for (const value of set) merged.add(value);
      return merged;
    }
    default:
      return undefined;
  }
}

/** The validation pattern a schema implies, mirroring Zod's `_zod.pattern`. */
export function patternOf(node: SchemaNode): RegExp | undefined {
  if (patternCache.has(node)) return patternCache.get(node);
  const computed = computePattern(node);
  patternCache.set(node, computed);
  return computed;
}

function computePattern(node: SchemaNode): RegExp | undefined {
  switch (node.kind) {
    case "string": {
      const bag = bagOf(node);
      const patterns = bag.patterns;
      if (patterns && patterns.length > 0) return patterns[patterns.length - 1];
      const minimum = typeof bag.minimum === "number" ? bag.minimum : 0;
      const maximum = typeof bag.maximum === "number" ? bag.maximum : "";
      return new RegExp(`^[\\s\\S]{${minimum},${maximum}}$`);
    }
    case "number": {
      const bag = bagOf(node);
      const format = bag.format;
      if (format === "safeint" || format === "int32" || format === "uint32") return /^-?\d+$/;
      return /^-?\d+(?:\.\d+)?$/;
    }
    case "bigint":
      return /^-?\d+n?$/;
    case "boolean":
      return /^(?:true|false)$/i;
    case "undefined":
    case "void":
      return /^undefined$/i;
    case "null":
      return /^null$/i;
    case "literal":
    case "enum":
      return new RegExp(`^(${node.values.map((value) => escapeRegex(String(value))).join("|")})$`);
    case "optional": {
      const inner = patternOf(node.inner);
      return inner ? new RegExp(`^(${cleanSource(inner.source)})?$`) : undefined;
    }
    case "exactOptional":
      return patternOf(node.inner);
    case "nullable": {
      const inner = patternOf(node.inner);
      return inner ? new RegExp(`^(${cleanSource(inner.source)}|null)$`) : undefined;
    }
    case "readonly":
    case "lazy":
      return undefined;
    case "union":
    case "discunion": {
      const sources: string[] = [];
      for (const option of node.options) {
        const pattern = patternOf(option);
        if (!pattern) return undefined;
        sources.push(cleanSource(pattern.source));
      }
      return new RegExp(`^(${sources.join("|")})$`);
    }
    case "templateLiteral":
      return node.pattern;
    default:
      return undefined;
  }
}

function cleanSource(source: string): string {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}

/** `_zod.optin`: "optional" when the INPUT may be absent. */
export function optinOf(node: SchemaNode): "optional" | undefined {
  if (optinCache.has(node)) return optinCache.get(node);
  const computed = computeOptin(node);
  optinCache.set(node, computed);
  return computed;
}

function computeOptin(node: SchemaNode): "optional" | undefined {
  switch (node.kind) {
    case "optional":
    case "exactOptional":
    case "default":
    case "prefault":
    case "catch":
      return "optional";
    case "nullable":
    case "readonly":
      return optinOf(node.inner);
    case "pipe":
      return optinOf(node.a);
    case "union":
    case "discunion":
      return node.options.some((option) => optinOf(option) === "optional") ? "optional" : undefined;
    case "lazy":
      return optinOf(node.getter());
    case "host":
      // $ZodTransform and preprocess declare optin "optional"; other host ops do not.
      return node.op === "transform" || node.op === "preprocess" ? "optional" : undefined;
    default:
      return undefined;
  }
}

/** `_zod.optout`: "optional" when the OUTPUT may be absent. */
export function optoutOf(node: SchemaNode): "optional" | undefined {
  if (optoutCache.has(node)) return optoutCache.get(node);
  const computed = computeOptout(node);
  optoutCache.set(node, computed);
  return computed;
}

function computeOptout(node: SchemaNode): "optional" | undefined {
  switch (node.kind) {
    case "optional":
    case "exactOptional":
      return "optional";
    case "nullable":
    case "readonly":
    case "default":
    case "prefault":
    case "catch":
      return optoutOf(node.inner);
    case "pipe":
      return optoutOf(node.b);
    case "union":
    case "discunion":
      return node.options.some((option) => optoutOf(option) === "optional") ? "optional" : undefined;
    case "lazy":
      return optoutOf(node.getter());
    default:
      return undefined;
  }
}

/** `_zod.propValues`: per-property accepted value sets (discriminator source). */
export function propValuesOf(node: SchemaNode): Readonly<Record<string, ReadonlySet<unknown>>> | undefined {
  if (propValuesCache.has(node)) return propValuesCache.get(node);
  const computed = computePropValues(node);
  propValuesCache.set(node, computed);
  return computed;
}

function computePropValues(node: SchemaNode): Readonly<Record<string, ReadonlySet<unknown>>> | undefined {
  switch (node.kind) {
    case "object": {
      const propValues: Record<string, ReadonlySet<unknown>> = {};
      for (const [key, child] of Object.entries(node.shape)) {
        const values = valuesOf(child);
        if (values) propValues[key] = values;
      }
      return propValues;
    }
    case "discunion": {
      const propValues: Record<string, Set<unknown>> = {};
      for (const option of node.options) {
        const theirs = propValuesOf(option);
        if (!theirs || Object.keys(theirs).length === 0) {
          throw new Error(`Invalid discriminated union option at index "${node.options.indexOf(option)}"`);
        }
        for (const [key, values] of Object.entries(theirs)) {
          const target = (propValues[key] ??= new Set<unknown>());
          for (const value of values) target.add(value);
        }
      }
      return propValues;
    }
    case "readonly":
    case "default":
    case "prefault":
    case "catch":
      return propValuesOf(node.inner);
    case "pipe":
      return propValuesOf(node.a);
    case "lazy":
      return propValuesOf(node.getter());
    default:
      return undefined;
  }
}

/** Values accepted for `key` by a discriminated-union option, or none. */
export function discriminatorValues(option: SchemaNode, key: string): ReadonlySet<unknown> | undefined {
  const propValues = propValuesOf(option);
  const values = propValues?.[key];
  return values && values.size > 0 ? values : undefined;
}

export type { FormatId };
