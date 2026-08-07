/** zodrs core surface (`zodrs/core`). */
import "./loader.js";
import { config } from "./config.js";
import { bagOf } from "./introspect.js";

export * from "./errors.js";
export * from "./config.js";
export * from "./registries.js";
export * from "./error-utils.js";
export * from "./standard-schema.js";
export * from "./native.js";
export { compilePlan } from "./plan.js";
export type { CompiledPlan } from "./plan.js";
export { createInterpreter, createAsyncInterpreter, $ZodAsyncError } from "./interpreter.js";
export type { Validator, AsyncValidator, ValidationContext } from "./interpreter.js";
export { createCodegenValidator, CODEGEN_AVAILABLE } from "./codegen.js";
export { testFormat } from "./formats.js";
export { node, cloneNode } from "./nodes.js";
export type {
  Check,
  FormatId,
  HostFunction,
  MetadataBag,
  NodeId,
  ObjectMode,
  PlanNode,
  RuntimeCheck,
  SchemaNode,
} from "./nodes.js";
export type { output, input, infer, SafeParseResult, RuntimeSchema } from "./parse.js";
export * as util from "./util.js";
export { FAIL, parsedType, joinValues, stringifyPrimitive } from "./util.js";
export { bagOf, optinOf, optoutOf, patternOf, propValuesOf, valuesOf } from "./introspect.js";
export { toJSONSchema } from "./json-schema.js";
export type {
  ToJSONSchemaParams,
  RegistryToJSONSchemaParams,
  ToJSONSchemaSource,
  ToJSONSchemaSourceDef,
  ToJSONSchemaOverrideContext,
} from "./json-schema.js";
export * as JSONSchema from "./json-schema-types.js";

export { allowsEval } from "./util.js";

interface SchemaLike { readonly _zod: { readonly node: { readonly kind: string; readonly codec?: boolean } } }
type CoreMatcher = { readonly [Symbol.hasInstance]: (value: unknown) => boolean };
function coreMatcher(kinds: readonly string[], extra?: (value: SchemaLike) => boolean): CoreMatcher {
  return {
    [Symbol.hasInstance]: (value: unknown): boolean => {
      if (!value || typeof value !== "object" || !("_zod" in value)) return false;
      const like = value as SchemaLike;
      return kinds.includes(like._zod.node.kind) && (extra ? extra(like) : true);
    },
  };
}

export const $ZodType: CoreMatcher = coreMatcher(["string", "number", "bigint", "boolean", "date", "file", "null", "undefined", "any", "unknown", "never", "void", "symbol", "nan", "function", "literal", "enum", "object", "array", "tuple", "union", "discunion", "intersection", "record", "map", "set", "optional", "exactOptional", "nullable", "nonoptional", "readonly", "lazy", "promise", "default", "prefault", "catch", "pipe", "templateLiteral", "host"]);
export const $ZodString: CoreMatcher = coreMatcher(["string"]);
export const $ZodStringFormat: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] !== undefined);
export const $ZodGUID: CoreMatcher = coreMatcher(["string"], (value) => ["guid", "uuid", "uuidv4", "uuidv6", "uuidv7"].includes(bagOf(value._zod.node as never)["format"] as string));
export const $ZodUUID: CoreMatcher = $ZodGUID;
export const $ZodEmail: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "email");
export const $ZodURL: CoreMatcher = coreMatcher(["string"], (value) => { const f = bagOf(value._zod.node as never)["format"]; return f === "url" || f === "httpUrl"; });
export const $ZodEmoji: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "emoji");
export const $ZodNanoID: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "nanoid");
export const $ZodCUID: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "cuid");
export const $ZodCUID2: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "cuid2");
export const $ZodULID: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "ulid");
export const $ZodXID: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "xid");
export const $ZodKSUID: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "ksuid");
export const $ZodISODateTime: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "datetime");
export const $ZodISODate: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "date");
export const $ZodISOTime: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "time");
export const $ZodISODuration: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "duration");
export const $ZodIPv4: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "ipv4");
export const $ZodIPv6: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "ipv6");
export const $ZodCIDRv4: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "cidrv4");
export const $ZodCIDRv6: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "cidrv6");
export const $ZodBase64: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "base64");
export const $ZodBase64URL: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "base64url");
export const $ZodE164: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "e164");
export const $ZodJWT: CoreMatcher = coreMatcher(["string"], (value) => bagOf(value._zod.node as never)["format"] === "jwt");
export const $ZodNumber: CoreMatcher = coreMatcher(["number"]);
export const $ZodNumberFormat: CoreMatcher = coreMatcher(["number"], (value) => bagOf(value._zod.node as never)["format"] !== undefined);
export const $ZodBigInt: CoreMatcher = coreMatcher(["bigint"]);
export const $ZodBigIntFormat: CoreMatcher = coreMatcher(["bigint"], (value) => bagOf(value._zod.node as never)["format"] !== undefined);
export const $ZodBoolean: CoreMatcher = coreMatcher(["boolean"]);
export const $ZodSymbol: CoreMatcher = coreMatcher(["symbol"]);
export const $ZodUndefined: CoreMatcher = coreMatcher(["undefined"]);
export const $ZodNull: CoreMatcher = coreMatcher(["null"]);
export const $ZodAny: CoreMatcher = coreMatcher(["any"]);
export const $ZodUnknown: CoreMatcher = coreMatcher(["unknown"]);
export const $ZodNever: CoreMatcher = coreMatcher(["never"]);
export const $ZodVoid: CoreMatcher = coreMatcher(["void"]);
export const $ZodDate: CoreMatcher = coreMatcher(["date"]);
export const $ZodArray: CoreMatcher = coreMatcher(["array"]);
export const $ZodObject: CoreMatcher = coreMatcher(["object"]);
export const $ZodObjectJIT: CoreMatcher = coreMatcher(["object"]);
export const $ZodUnion: CoreMatcher = coreMatcher(["union", "discunion"]);
export const $ZodDiscriminatedUnion: CoreMatcher = coreMatcher(["discunion"]);
export const $ZodIntersection: CoreMatcher = coreMatcher(["intersection"]);
export const $ZodTuple: CoreMatcher = coreMatcher(["tuple"]);
export const $ZodRecord: CoreMatcher = coreMatcher(["record"]);
export const $ZodMap: CoreMatcher = coreMatcher(["map"]);
export const $ZodSet: CoreMatcher = coreMatcher(["set"]);
export const $ZodEnum: CoreMatcher = coreMatcher(["enum"]);
export const $ZodLiteral: CoreMatcher = coreMatcher(["literal"]);
export const $ZodFile: CoreMatcher = coreMatcher(["file"]);
export const $ZodTransform: CoreMatcher = coreMatcher(["host"], (value) => { const n = value._zod.node as { op?: string }; return n.op === "transform" || n.op === "preprocess"; });
export const $ZodOptional: CoreMatcher = coreMatcher(["optional"]);
export const $ZodNullable: CoreMatcher = coreMatcher(["nullable"]);
export const $ZodDefault: CoreMatcher = coreMatcher(["default"]);
export const $ZodPrefault: CoreMatcher = coreMatcher(["prefault"]);
export const $ZodNonOptional: CoreMatcher = coreMatcher(["nonoptional"]);
export const $ZodSuccess: CoreMatcher = coreMatcher(["host"]);
export const $ZodCatch: CoreMatcher = coreMatcher(["catch"]);
export const $ZodNaN: CoreMatcher = coreMatcher(["nan"]);
export const $ZodPipe: CoreMatcher = coreMatcher(["pipe"]);
export const $ZodCodec: CoreMatcher = coreMatcher(["pipe"], (value) => value._zod.node.codec === true);
export const $ZodReadonly: CoreMatcher = coreMatcher(["readonly"]);
export const $ZodTemplateLiteral: CoreMatcher = coreMatcher(["templateLiteral"]);
export const $ZodLazy: CoreMatcher = coreMatcher(["lazy"]);
export const $ZodPromise: CoreMatcher = coreMatcher(["promise"]);
export const $ZodCustom: CoreMatcher = coreMatcher(["host"]);
export const $ZodFunction: CoreMatcher = coreMatcher(["function"]);
export const $ZodCheck: CoreMatcher = { [Symbol.hasInstance]: (value: unknown): boolean => !!value && typeof value === "object" && "_zod" in value && "check" in (value as { _zod: object })._zod };
