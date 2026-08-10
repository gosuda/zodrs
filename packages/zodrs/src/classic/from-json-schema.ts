/**
 * `fromJSONSchema` — build a zodrs schema from a JSON Schema document.
 *
 * Lives in the classic layer because it constructs schemas through the classic
 * builder API (`./schemas.js`); placing it in `core` would form a core→classic
 * import cycle. Behavior is defined by the vendored corpus
 * (packages/conformance/tests/classic/from-json-schema.test.ts) and mirrors
 * Zod v4's `classic/from-json-schema.ts` semantics without copying its code.
 *
 * Semi-experimental, matching Zod: this is a best-effort JSON Schema → schema
 * conversion, not a total one. Unsupported keywords throw.
 */

import * as z from "./schemas.js";
import type { $ZodType, ZodString } from "./schemas.js";
import { globalRegistry } from "../core/registries.js";
import type { $ZodRegistry, GlobalMeta } from "../core/registries.js";
import { isObject } from "../core/util.js";

type JSONSchemaVersion = "draft-2020-12" | "draft-7" | "draft-4" | "openapi-3.0";

export interface FromJSONSchemaParams {
  readonly defaultTarget?: JSONSchemaVersion | undefined;
  readonly registry?: $ZodRegistry<GlobalMeta> | undefined;
}

interface ConversionContext {
  readonly version: JSONSchemaVersion;
  readonly defs: Record<string, unknown>;
  readonly refs: Map<string, $ZodType>;
  readonly processing: Set<string>;
  readonly rootSchema: Record<string, unknown>;
  readonly registry: $ZodRegistry<GlobalMeta>;
}

/** Keys the converter understands directly; every other key becomes registry metadata. */
const RECOGNIZED_KEYS: Record<string, true> = {
  $schema: true, $ref: true, $defs: true, definitions: true,
  $id: true, id: true, $comment: true, $anchor: true, $vocabulary: true, $dynamicRef: true, $dynamicAnchor: true,
  type: true, enum: true, const: true,
  anyOf: true, oneOf: true, allOf: true, not: true,
  properties: true, required: true, additionalProperties: true, patternProperties: true, propertyNames: true,
  minProperties: true, maxProperties: true,
  items: true, prefixItems: true, additionalItems: true, minItems: true, maxItems: true, uniqueItems: true,
  contains: true, minContains: true, maxContains: true,
  minLength: true, maxLength: true, pattern: true, format: true,
  minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true,
  description: true, default: true,
  contentEncoding: true, contentMediaType: true, contentSchema: true,
  // `then` is a JSON Schema keyword, not a promise-like callback.
  // oxlint-disable-next-line unicorn/no-thenable
  unevaluatedItems: true, unevaluatedProperties: true, if: true, ["then"]: true, else: true,
  dependentSchemas: true, dependentRequired: true,
  nullable: true, readOnly: true,
};

/** JSON Schema `format` name → zodrs format schema factory. Absent → plain string. */
const FORMAT_FACTORY: Record<string, () => ZodString> = {
  email: () => z.email(),
  uri: () => z.url(),
  "uri-reference": () => z.url(),
  uuid: () => z.uuid(),
  guid: () => z.uuid(),
  "date-time": () => z.iso.datetime(),
  date: () => z.iso.date(),
  time: () => z.iso.time(),
  duration: () => z.iso.duration(),
  ipv4: () => z.ipv4(),
  ipv6: () => z.ipv6(),
  mac: () => z.mac(),
  cidr: () => z.cidrv4(),
  "cidr-v6": () => z.cidrv6(),
  base64: () => z.base64(),
  base64url: () => z.base64url(),
  e164: () => z.e164(),
  jwt: () => z.jwt(),
  emoji: () => z.emoji(),
  nanoid: () => z.nanoid(),
  cuid: () => z.cuid(),
  cuid2: () => z.cuid2(),
  ulid: () => z.ulid(),
  xid: () => z.xid(),
  ksuid: () => z.ksuid(),
};

// Small boundary readers — the input is untrusted, normalized JSON walked as
// `Record<string, unknown>`, so each field read is narrowed at the point of use.
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function detectVersion(schema: Record<string, unknown>, defaultTarget?: JSONSchemaVersion): JSONSchemaVersion {
  const dollarSchema = schema["$schema"];
  if (dollarSchema === "https://json-schema.org/draft/2020-12/schema") return "draft-2020-12";
  if (dollarSchema === "http://json-schema.org/draft-07/schema#") return "draft-7";
  if (dollarSchema === "http://json-schema.org/draft-04/schema#") return "draft-4";
  return defaultTarget ?? "draft-2020-12";
}

function resolveRef(ref: string, ctx: ConversionContext): unknown {
  if (!ref.startsWith("#")) {
    throw new Error("External $ref is not supported, only local refs (#/...) are allowed");
  }
  const path = ref.slice(1).split("/").filter(Boolean);
  if (path.length === 0) return ctx.rootSchema;

  const defsKey = ctx.version === "draft-2020-12" ? "$defs" : "definitions";
  if (path[0] === defsKey) {
    const key = path[1];
    const resolved = key === undefined ? undefined : ctx.defs[key];
    if (resolved === undefined) throw new Error(`Reference not found: ${ref}`);
    return resolved;
  }
  throw new Error(`Reference not found: ${ref}`);
}

/** A passthrough object whose pattern-matching keys are validated against their sub-schemas. */
function patternObject(shape: Record<string, $ZodType>, patternEntries: readonly (readonly [RegExp, $ZodType])[]): $ZodType {
  return z.object(shape).passthrough().superRefine((value, ctx) => {
    if (!isObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      for (const [regex, sub] of patternEntries) {
        if (!regex.test(key)) continue;
        const result = sub.safeParse(entry);
        if (!result.success) {
          for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
      }
    }
  });
}

/**
 * Exclusive union (JSON Schema `oneOf`): the value must validate under exactly
 * one option, and is returned unchanged. Built on `unknown` + `superRefine`
 * rather than `z.xor`, whose bare host node currently yields the predicate
 * boolean instead of the input value.
 */
function exclusiveUnion(options: readonly $ZodType[]): $ZodType {
  return z.unknown().superRefine((value, ctx) => {
    let matches = 0;
    for (const option of options) {
      if (option.safeParse(value).success) matches++;
    }
    if (matches !== 1) ctx.addIssue("Invalid input: expected the value to match exactly one schema (oneOf)");
  });
}

function convertBaseSchema(schema: Record<string, unknown>, ctx: ConversionContext): $ZodType {
  const not = schema["not"];
  if (not !== undefined) {
    if (isObject(not) && Object.keys(not).length === 0) return z.never();
    throw new Error("not is not supported in Zod (except { not: {} } for never)");
  }
  if (schema["unevaluatedItems"] !== undefined) throw new Error("unevaluatedItems is not supported");
  if (schema["unevaluatedProperties"] !== undefined) throw new Error("unevaluatedProperties is not supported");
  if (schema["if"] !== undefined || schema["then"] !== undefined || schema["else"] !== undefined) {
    throw new Error("Conditional schemas (if/then/else) are not supported");
  }
  if (schema["dependentSchemas"] !== undefined || schema["dependentRequired"] !== undefined) {
    throw new Error("dependentSchemas and dependentRequired are not supported");
  }

  const ref = asString(schema["$ref"]);
  if (ref) {
    const cached = ctx.refs.get(ref);
    if (cached) return cached;
    if (ctx.processing.has(ref)) {
      return z.lazy(() => {
        const resolved = ctx.refs.get(ref);
        if (!resolved) throw new Error(`Circular reference not resolved: ${ref}`);
        return resolved;
      });
    }
    ctx.processing.add(ref);
    const resolvedSchema = convertSchema(resolveRef(ref, ctx), ctx);
    ctx.refs.set(ref, resolvedSchema);
    ctx.processing.delete(ref);
    return resolvedSchema;
  }

  const enumField = schema["enum"];
  if (enumField !== undefined) {
    const enumValues = Array.isArray(enumField) ? (enumField as (string | number | boolean | null)[]) : [];
    if (
      ctx.version === "openapi-3.0" &&
      schema["nullable"] === true &&
      enumValues.length === 1 &&
      enumValues[0] === null
    ) {
      return z.null_();
    }
    if (enumValues.length === 0) return z.never();
    if (enumValues.length === 1) {
      const [only] = enumValues;
      return z.literal(only);
    }
    if (enumValues.every((v) => typeof v === "string")) return z.enum_(enumValues as string[]);
    const literals = enumValues.map((v) => z.literal(v));
    return z.union(literals);
  }

  if ("const" in schema) {
    const constValue = schema["const"] as string | number | boolean | null; // JSON const in the corpus is always primitive
    return z.literal(constValue);
  }

  const type = schema["type"];
  if (Array.isArray(type)) {
    const typeSchemas = type.map((t) => convertBaseSchema({ ...schema, type: t }, ctx));
    if (typeSchemas.length === 0) return z.never();
    if (typeSchemas.length === 1) {
      const first = typeSchemas[0];
      if (first) return first;
    }
    return z.union(typeSchemas);
  }
  if (typeof type !== "string" || type.length === 0) return z.any();

  switch (type) {
    case "string": {
      const format = asString(schema["format"]);
      const factory = format === undefined ? undefined : FORMAT_FACTORY[format];
      let stringSchema = factory ? factory() : z.string();
      const minLength = asNumber(schema["minLength"]);
      const maxLength = asNumber(schema["maxLength"]);
      const pattern = asString(schema["pattern"]);
      if (minLength !== undefined) stringSchema = stringSchema.min(minLength);
      if (maxLength !== undefined) stringSchema = stringSchema.max(maxLength);
      // JSON Schema patterns are not implicitly anchored (match anywhere).
      if (pattern) stringSchema = stringSchema.regex(new RegExp(pattern));
      return stringSchema;
    }

    case "number":
    case "integer": {
      let numberSchema = type === "integer" ? z.number().int() : z.number();
      const minimum = asNumber(schema["minimum"]);
      const maximum = asNumber(schema["maximum"]);
      const exclusiveMinimum = schema["exclusiveMinimum"];
      const exclusiveMaximum = schema["exclusiveMaximum"];
      const multipleOf = asNumber(schema["multipleOf"]);
      if (minimum !== undefined) numberSchema = numberSchema.min(minimum);
      if (maximum !== undefined) numberSchema = numberSchema.max(maximum);
      if (typeof exclusiveMinimum === "number") numberSchema = numberSchema.gt(exclusiveMinimum);
      else if (exclusiveMinimum === true && minimum !== undefined) numberSchema = numberSchema.gt(minimum);
      if (typeof exclusiveMaximum === "number") numberSchema = numberSchema.lt(exclusiveMaximum);
      else if (exclusiveMaximum === true && maximum !== undefined) numberSchema = numberSchema.lt(maximum);
      if (multipleOf !== undefined) numberSchema = numberSchema.multipleOf(multipleOf);
      return numberSchema;
    }

    case "boolean":
      return z.boolean();
    case "null":
      return z.null_();

    case "object": {
      const shape: Record<string, $ZodType> = {};
      const properties = isObject(schema["properties"]) ? schema["properties"] : {};
      const requiredList = Array.isArray(schema["required"]) ? schema["required"] : [];
      const requiredSet = new Set<string>(requiredList.filter((k): k is string => typeof k === "string"));
      for (const [key, propSchema] of Object.entries(properties)) {
        const propZodSchema = convertSchema(propSchema, ctx);
        shape[key] = requiredSet.has(key) ? propZodSchema : propZodSchema.optional();
      }

      const propertyNames = schema["propertyNames"];
      const additionalProperties = schema["additionalProperties"];
      if (propertyNames !== undefined) {
        const keySchema = convertSchema(propertyNames, ctx);
        const valueSchema = isObject(additionalProperties) ? convertSchema(additionalProperties, ctx) : z.any();
        if (Object.keys(shape).length === 0) return z.record(keySchema, valueSchema);
        // Object with constrained key names: validate every own key's name and
        // any non-declared key's value, keeping all keys (passthrough).
        return z.object(shape).passthrough().superRefine((value, ctx2) => {
          if (!isObject(value)) return;
          for (const [key, entry] of Object.entries(value)) {
            const keyResult = keySchema.safeParse(key);
            if (!keyResult.success) {
              for (const issue of keyResult.error.issues) ctx2.addIssue({ ...issue, path: [key, ...issue.path] });
            }
            if (!(key in shape)) {
              const valueResult = valueSchema.safeParse(entry);
              if (!valueResult.success) {
                for (const issue of valueResult.error.issues) ctx2.addIssue({ ...issue, path: [key, ...issue.path] });
              }
            }
          }
        });
      }

      const patternProperties = schema["patternProperties"];
      if (isObject(patternProperties)) {
        const patternEntries: (readonly [RegExp, $ZodType])[] = [];
        for (const [pattern, sub] of Object.entries(patternProperties)) {
          patternEntries.push([new RegExp(pattern), convertSchema(sub, ctx)]);
        }
        return patternObject(shape, patternEntries);
      }

      const objectSchema = z.object(shape);
      if (additionalProperties === false) return objectSchema.strict();
      if (isObject(additionalProperties)) return objectSchema.catchall(convertSchema(additionalProperties, ctx));
      return objectSchema.passthrough();
    }

    case "array": {
      const prefixItems = schema["prefixItems"];
      const items = schema["items"];
      const minItems = asNumber(schema["minItems"]);
      const maxItems = asNumber(schema["maxItems"]);

      if (Array.isArray(prefixItems)) {
        const tupleItems = prefixItems.map((item) => convertSchema(item, ctx));
        const rest = isObject(items) ? convertSchema(items, ctx) : undefined;
        let tupleSchema = rest ? z.tuple(tupleItems).rest(rest) : z.tuple(tupleItems);
        if (minItems !== undefined) tupleSchema = tupleSchema.check(z.minLength(minItems));
        if (maxItems !== undefined) tupleSchema = tupleSchema.check(z.maxLength(maxItems));
        return tupleSchema;
      }
      if (Array.isArray(items)) {
        const tupleItems = items.map((item) => convertSchema(item, ctx));
        const rest = isObject(schema["additionalItems"]) ? convertSchema(schema["additionalItems"], ctx) : undefined;
        let tupleSchema = rest ? z.tuple(tupleItems).rest(rest) : z.tuple(tupleItems);
        if (minItems !== undefined) tupleSchema = tupleSchema.check(z.minLength(minItems));
        if (maxItems !== undefined) tupleSchema = tupleSchema.check(z.maxLength(maxItems));
        return tupleSchema;
      }
      if (items !== undefined) {
        let arraySchema = z.array(convertSchema(items, ctx));
        if (minItems !== undefined) arraySchema = arraySchema.min(minItems);
        if (maxItems !== undefined) arraySchema = arraySchema.max(maxItems);
        return arraySchema;
      }
      return z.array(z.any());
    }

    default:
      throw new Error(`Unsupported type: ${type}`);
  }
}

function convertSchema(schema: unknown, ctx: ConversionContext): $ZodType {
  if (typeof schema === "boolean") return schema ? z.any() : z.never();
  if (!isObject(schema)) return z.any();

  let result = convertBaseSchema(schema, ctx);
  const hasExplicitType =
    schema["type"] !== undefined || schema["enum"] !== undefined || "const" in schema;

  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) {
    const union = z.union(anyOf.map((s) => convertSchema(s, ctx)));
    result = hasExplicitType ? z.intersection(result, union) : union;
  }

  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    const exclusive = exclusiveUnion(oneOf.map((s) => convertSchema(s, ctx)));
    result = hasExplicitType ? z.intersection(result, exclusive) : exclusive;
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    if (allOf.length === 0) {
      if (!hasExplicitType) result = z.any();
    } else {
      let combined = hasExplicitType ? result : convertSchema(allOf[0], ctx);
      const startIdx = hasExplicitType ? 0 : 1;
      for (let i = startIdx; i < allOf.length; i++) combined = z.intersection(combined, convertSchema(allOf[i], ctx));
      result = combined;
    }
  }

  if (schema["nullable"] === true && ctx.version === "openapi-3.0") result = z.nullable(result);
  if (schema["readOnly"] === true) result = z.readonly(result);
  if (schema["default"] !== undefined) result = result.default(schema["default"]);

  // Every unrecognized key becomes registry metadata; `description` is applied
  // via `.describe()` so `schema.description` continues to read from the registry.
  const extraMeta: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    if (!RECOGNIZED_KEYS[key]) extraMeta[key] = schema[key];
  }
  const coreMetadataKeys = ["$id", "id", "$comment", "$anchor", "$vocabulary", "$dynamicRef", "$dynamicAnchor"];
  for (const key of coreMetadataKeys) if (key in schema) extraMeta[key] = schema[key];
  const contentMetadataKeys = ["contentEncoding", "contentMediaType", "contentSchema"];
  for (const key of contentMetadataKeys) if (key in schema) extraMeta[key] = schema[key];
  if (Object.keys(extraMeta).length > 0) ctx.registry.add(result, extraMeta);

  const description = asString(schema["description"]);
  if (description) result = result.describe(description);

  return result;
}

/**
 * Converts a JSON Schema document to a zodrs schema. Semi-experimental; its
 * behavior is liable to change alongside the JSON Schema surface.
 */
export function fromJSONSchema(schema: unknown, params?: FromJSONSchemaParams): $ZodType {
  if (typeof schema === "boolean") return schema ? z.any() : z.never();

  // Normalize via a JSON round-trip: cyclic inputs throw here, getter/proxy
  // properties materialize, class instances collapse to plain objects, and
  // non-JSON values (bigint) fail fast.
  let normalized: unknown;
  try {
    normalized = JSON.parse(JSON.stringify(schema));
  } catch {
    throw new Error("fromJSONSchema input is not valid JSON (possibly cyclic); use $defs/$ref for recursive schemas");
  }
  if (!isObject(normalized)) return z.any();

  const version = detectVersion(normalized, params?.defaultTarget);
  const dollarDefs = normalized["$defs"];
  const definitions = normalized["definitions"];
  const defs = isObject(dollarDefs) ? dollarDefs : isObject(definitions) ? definitions : {};

  const ctx: ConversionContext = {
    version,
    defs,
    refs: new Map(),
    processing: new Set(),
    rootSchema: normalized,
    registry: params?.registry ?? globalRegistry,
  };

  return convertSchema(normalized, ctx);
}
