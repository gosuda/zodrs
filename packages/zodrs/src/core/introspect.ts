import type { FormatId, SchemaNode } from "./nodes.js";
import { patternForFormat } from "./formats.js";
import { BIGINT_FORMAT_RANGES, NUMBER_FORMAT_RANGES, escapeRegex } from "./util.js";

/**
 * Lazy `_zod` introspection mirrors Zod v4.4.3: `values`, `pattern`, `optin`,
 * `optout`, and `propValues` derived from the node graph. Results are memoized
 * per node, but memoization alone cannot terminate a `lazy` back-edge (the
 * cache is only written after a call returns), so each recursive function
 * guards in-flight lazy nodes the way Zod's `defineLazy` does — a re-entrant
 * read contributes `undefined`, which bottoms cyclic evaluations out at the
 * least fixed point instead of overflowing the stack.
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
        const range = NUMBER_FORMAT_RANGES[check.v as keyof typeof NUMBER_FORMAT_RANGES];
        bag = { ...bag, format: check.v, ...(range ? { minimum: range[0], maximum: range[1] } : {}) };
        break;
      }
      case "bigint_format": {
        const range = BIGINT_FORMAT_RANGES[check.v as keyof typeof BIGINT_FORMAT_RANGES];
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
      case "format": {
        bag = { ...bag, format: check.v === "uuidv4" || check.v === "uuidv6" || check.v === "uuidv7" ? "uuid" : check.v };
        // Zod assigns `def.pattern` on most format schemas; it lands in bag.patterns.
        const pattern = patternForFormat(check.v, check.params);
        if (pattern) bag = { ...bag, patterns: [...(bag.patterns ?? []), pattern] };
        break;
      }
      case "regex":
        bag = { ...bag, patterns: [...(bag.patterns ?? []), new RegExp(check.src, check.flags)] };
        break;
      case "lowercase":
        bag = { ...bag, patterns: [...(bag.patterns ?? []), /^[^A-Z]*$/] };
        break;
      case "uppercase":
        bag = { ...bag, patterns: [...(bag.patterns ?? []), /^[^a-z]*$/] };
        break;
      case "starts_with":
        bag = { ...bag, patterns: [...(bag.patterns ?? []), new RegExp(`^${escapeRegex(check.v)}.*`)] };
        break;
      case "ends_with":
        bag = { ...bag, patterns: [...(bag.patterns ?? []), new RegExp(`.*${escapeRegex(check.v)}$`)] };
        break;
      case "host_runtime":
        if (check.op === "custom_format" && check.format !== undefined) bag = { ...bag, format: check.format };
        if (check.op === "custom_format" && check.pattern) bag = { ...bag, patterns: [...(bag.patterns ?? []), check.pattern] };
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
const lazyPatternInProgress = new Set<SchemaNode>();

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
    case "lazy": {
      // Delegate like Zod's $ZodLazy; guard cycles from recursive schemas.
      if (lazyPatternInProgress.has(node)) return undefined;
      lazyPatternInProgress.add(node);
      try {
        return patternOf(node.getter());
      } finally {
        lazyPatternInProgress.delete(node);
      }
    }
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

const lazyOptionalityInProgress = new Set<SchemaNode>();

/** `_zod.optin`: "optional" when the INPUT may be absent. */
export function optinOf(node: SchemaNode): "optional" | undefined {
  if (optinCache.has(node)) return optinCache.get(node);
  const computed = computeOptionality(node, "in");
  optinCache.set(node, computed);
  return computed;
}

/** `_zod.optout`: "optional" when the OUTPUT may be absent. */
export function optoutOf(node: SchemaNode): "optional" | undefined {
  if (optoutCache.has(node)) return optoutCache.get(node);
  const computed = computeOptionality(node, "out");
  optoutCache.set(node, computed);
  return computed;
}

function computeOptionality(node: SchemaNode, side: "in" | "out"): "optional" | undefined {
  const at = (child: SchemaNode) => (side === "in" ? optinOf(child) : optoutOf(child));
  switch (node.kind) {
    case "optional":
    case "exactOptional":
      return "optional";
    case "default":
    case "prefault":
      // Input-optional, but the materialized output is never absent: Zod
      // leaves optout undefined here rather than delegating to the inner type.
      return side === "in" ? "optional" : undefined;
    case "catch":
      return side === "in" ? "optional" : at(node.inner);
    case "nullable":
    case "readonly":
      return at(node.inner);
    case "pipe":
      return at(side === "in" ? node.a : node.b);
    case "union":
    case "discunion":
      return node.options.some((option) => at(option) === "optional") ? "optional" : undefined;
    case "lazy":
      // Cycle guard, matching Zod's defineLazy: a re-entrant read contributes
      // undefined, so purely cyclic optionality claims resolve to "required".
      if (lazyOptionalityInProgress.has(node)) return undefined;
      lazyOptionalityInProgress.add(node);
      try {
        return at(node.getter());
      } finally {
        lazyOptionalityInProgress.delete(node);
      }
    case "host":
      // $ZodTransform and preprocess declare optin "optional"; other host ops
      // do not, and no host op is output-optional.
      return side === "in" && (node.op === "transform" || node.op === "preprocess") ? "optional" : undefined;
    default:
      return undefined;
  }
}

const lazyPropValuesInProgress = new Set<SchemaNode>();

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
      return propValuesOf(node.inner);
    case "pipe":
      return propValuesOf(node.a);
    case "lazy":
      if (lazyPropValuesInProgress.has(node)) return undefined;
      lazyPropValuesInProgress.add(node);
      try {
        return propValuesOf(node.getter());
      } finally {
        lazyPropValuesInProgress.delete(node);
      }
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
