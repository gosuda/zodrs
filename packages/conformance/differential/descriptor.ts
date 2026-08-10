/**
 * Schema descriptor tree for the differential fuzz harness.
 *
 * A descriptor is a plain JSON-serializable value describing a generated
 * schema. It serves two purposes: `buildSchema` compiles it into a real
 * zodrs schema, and on a fuzz mismatch it is printed verbatim as the
 * reproduction artifact.
 *
 * Only JSON-eligible constructs are represented: no refine/transform/host
 * closures, no bigint/date/symbol (not representable in JSON bytes), no
 * intersections, maps, sets, pipes, or lazy nodes (out of scope for this
 * harness per the assignment).
 */

import * as z from "zodrs";

export type JsonScalar = null | boolean | number | string;
export type Json = JsonScalar | Json[] | { [key: string]: Json };

export type StringCheck =
  | { c: "min" | "max" | "length"; v: number }
  | { c: "startsWith" | "endsWith" | "includes"; v: string }
  | { c: "lowercase" | "uppercase" | "trim" | "toLowerCase" | "toUpperCase" }
  | { c: "regex"; src: string }
  | { c: "format"; f: FormatName };

export type FormatName =
  | "email"
  | "uuid"
  | "url"
  | "iso.datetime"
  | "iso.date"
  | "iso.time"
  | "iso.duration"
  | "ipv4"
  | "nanoid"
  | "ulid"
  | "base64"
  | "emoji"
  | "e164";

export type NumberCheck =
  | { c: "int" }
  | { c: "min" | "max"; v: number }
  | { c: "gt" | "lt"; v: number }
  | { c: "multipleOf"; v: number }
  | { c: "positive" | "negative" };

export type Descriptor =
  | { k: "string"; checks: StringCheck[]; coerce?: false }
  | { k: "string"; checks: Exclude<StringCheck, { c: "format" }>[]; coerce: true }
  | { k: "number"; checks: NumberCheck[]; coerce?: boolean }
  | { k: "boolean"; coerce?: boolean }
  | { k: "null" }
  | { k: "any" }
  | { k: "unknown" }
  | { k: "literal"; values: (string | number | boolean | null)[] }
  | { k: "enum"; values: string[] }
  | { k: "object"; mode: "strip" | "strict" | "passthrough"; shape: [string, Descriptor][]; catchall: Descriptor | null }
  | { k: "array"; el: Descriptor; min: number; max: number }
  | { k: "tuple"; items: Descriptor[]; rest: Descriptor | null }
  | { k: "union"; options: Descriptor[] }
  | { k: "discunion"; key: string; options: { tag: string; shape: [string, Descriptor][] }[] }
  | { k: "record"; value: Descriptor }
  | { k: "partialRecord"; keys: string[]; value: Descriptor }
  | { k: "optional"; inner: Descriptor }
  | { k: "exactOptional"; inner: Descriptor }
  | { k: "nullable"; inner: Descriptor }
  | { k: "nonoptional"; inner: Descriptor }
  | { k: "default"; inner: Descriptor; value: JsonScalar }
  | { k: "prefault"; inner: Descriptor; value: JsonScalar }
  | { k: "catch"; inner: Descriptor; value: JsonScalar }
  | { k: "templateLiteral"; prefix: string; suffix: string }
  | { k: "lazy"; inner: Descriptor };

export type AnySchema = z.ZodType;

/** Defines an own data property; plain assignment to "__proto__" would invoke the setter. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function applyStringCheck(schema: AnySchema, check: StringCheck): AnySchema {
  switch (check.c) {
    case "min": return (schema as z.ZodString).min(check.v);
    case "max": return (schema as z.ZodString).max(check.v);
    case "length": return (schema as z.ZodString).length(check.v);
    case "startsWith": return (schema as z.ZodString).startsWith(check.v);
    case "endsWith": return (schema as z.ZodString).endsWith(check.v);
    case "includes": return (schema as z.ZodString).includes(check.v);
    case "lowercase": return (schema as z.ZodString).lowercase();
    case "uppercase": return (schema as z.ZodString).uppercase();
    case "trim": return (schema as z.ZodString).trim();
    case "toLowerCase": return (schema as z.ZodString).toLowerCase();
    case "toUpperCase": return (schema as z.ZodString).toUpperCase();
    case "regex": return (schema as z.ZodString).regex(new RegExp(check.src));
    case "format": return schema; // unreachable: the format IS the base schema; filtered in buildSchema // base already carries the format; see buildSchema
  }
}

/** Format factories are string schemas in their own right, not checks applied to one. */
function formatSchema(f: FormatName): AnySchema {
  switch (f) {
    case "email": return z.email();
    case "uuid": return z.uuid();
    case "url": return z.url();
    case "iso.datetime": return z.iso.datetime();
    case "iso.date": return z.iso.date();
    case "iso.time": return z.iso.time();
    case "iso.duration": return z.iso.duration();
    case "ipv4": return z.ipv4();
    case "nanoid": return z.nanoid();
    case "ulid": return z.ulid();
    case "base64": return z.base64();
    case "emoji": return z.emoji();
    case "e164": return z.e164();
  }
}

function applyNumberCheck(schema: AnySchema, check: NumberCheck): AnySchema {
  switch (check.c) {
    case "int": return (schema as z.ZodNumber).int();
    case "min": return (schema as z.ZodNumber).min(check.v);
    case "max": return (schema as z.ZodNumber).max(check.v);
    case "gt": return (schema as z.ZodNumber).gt(check.v);
    case "lt": return (schema as z.ZodNumber).lt(check.v);
    case "multipleOf": return (schema as z.ZodNumber).multipleOf(check.v);
    case "positive": return (schema as z.ZodNumber).positive();
    case "negative": return (schema as z.ZodNumber).negative();
  }
}

/** Compiles a descriptor into a zodrs schema using only the public classic API. */
export function buildSchema(d: Descriptor): AnySchema {
  switch (d.k) {
    case "string": {
      const format = d.checks.find((c) => c.c === "format");
      const base = d.coerce ? z.coerce.string() : format && format.c === "format" ? formatSchema(format.f) : z.string();
      return d.checks.filter((c) => c.c !== "format").reduce<AnySchema>(applyStringCheck, base);
    }
    case "number": {
      const base = d.coerce ? z.coerce.number() : z.number();
      return d.checks.reduce<AnySchema>(applyNumberCheck, base);
    }
    case "boolean": return d.coerce ? z.coerce.boolean() : z.boolean();
    case "null": return z.null();
    case "any": return z.any();
    case "unknown": return z.unknown();
    case "literal": return z.literal(d.values);
    case "enum": return z.enum(d.values);
    case "object": {
      const shape: Record<string, unknown> = {};
      for (const [key, child] of d.shape) setOwn(shape, key, buildSchema(child));
      const make = d.mode === "strict" ? z.strictObject : d.mode === "passthrough" ? z.looseObject : z.object;
      const schema = make(shape as z.ZodRawShape);
      return d.catchall === null ? schema : schema.catchall(buildSchema(d.catchall));
    }
    case "array": {
      let s = z.array(buildSchema(d.el));
      if (d.min > 0) s = s.min(d.min);
      if (d.max < 8) s = s.max(d.max);
      return s;
    }
    case "tuple": {
      const schema = z.tuple(d.items.map(buildSchema));
      return d.rest === null ? schema : schema.rest(buildSchema(d.rest));
    }
    case "union": return z.union(d.options.map(buildSchema) as [AnySchema, AnySchema, ...AnySchema[]]);
    case "discunion":
      return z.discriminatedUnion(
        d.key,
        d.options.map((opt) => {
          const shape: Record<string, unknown> = {};
          setOwn(shape, d.key, z.literal(opt.tag));
          for (const [key, child] of opt.shape) setOwn(shape, key, buildSchema(child));
          return z.object(shape as z.ZodRawShape);
        }) as [AnySchema, AnySchema, ...AnySchema[]],
      );
    case "record": return z.record(z.string(), buildSchema(d.value));
    case "partialRecord": return z.partialRecord(z.enum(d.keys), buildSchema(d.value));
    case "optional": return buildSchema(d.inner).optional();
    case "exactOptional": return buildSchema(d.inner).exactOptional();
    case "nullable": return buildSchema(d.inner).nullable();
    case "nonoptional": return buildSchema(d.inner).nonoptional();
    case "default": return buildSchema(d.inner).default(d.value);
    case "prefault": return buildSchema(d.inner).prefault(d.value);
    case "catch": return buildSchema(d.inner).catch(d.value);
    case "templateLiteral": return z.templateLiteral([d.prefix, z.string(), d.suffix]);
    case "lazy": {
      const inner = buildSchema(d.inner);
      return z.lazy(() => inner);
    }
  }
}
