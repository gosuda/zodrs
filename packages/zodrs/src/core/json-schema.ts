/**
 * `toJSONSchema` — generate JSON Schema from a zodrs schema graph.
 *
 * Pure TypeScript: walks core nodes (`./nodes.ts`), check metadata, and the
 * metadata registries (`./registries.ts`). Behavior is defined by the Zod v4
 * conformance corpus (packages/conformance/tests/classic/to-json-schema*.test.ts).
 *
 * Architecture: three phases mirroring the observable contract —
 *   1. `process`     walks the schema graph, building a per-schema JSON object
 *                    and a `seen` map with counts, cycle markers, and ref links.
 *   2. `extractDefs` converts schemas with registry ids, cycles, and reused
 *                    schemas (policy `reused: "ref"`) into `$ref`s, snapshotting
 *                    their bodies for `$defs`.
 *   3. `finalize`    flattens wrapper/ref inheritance, runs user overrides,
 *                    and assembles `$schema`, `$defs`, and the root result.
 */

import { globalRegistry } from "./registries.js";
import type { $ZodRegistry, $ZodRegistrySchema, GlobalMeta } from "./registries.js";
import type { Check, FormatId, SchemaNode } from "./nodes.js";
import { bagOf } from "./introspect.js";
import { escapeRegex } from "./util.js";
import type { BaseSchema, JSONSchema } from "./json-schema-types.js";

// ---------------------------------------------------------------------------
// Public parameter types (mirroring Zod's names)
// ---------------------------------------------------------------------------

/** The `zodSchema` surface handed to `override` callbacks. */
export interface ToJSONSchemaSourceDef {
  readonly type: string;
  readonly catchall?: unknown;
  readonly [k: string]: unknown;
}

export interface ToJSONSchemaSource {
  readonly _zod: {
    readonly node: SchemaNode;
    readonly def: ToJSONSchemaSourceDef;
    readonly parent?: ToJSONSchemaSource | undefined;
    readonly output: unknown;
    readonly input: unknown;
  };
}

export interface ToJSONSchemaOverrideContext {
  readonly zodSchema: ToJSONSchemaSource;
  readonly jsonSchema: BaseSchema;
  readonly path: (string | number)[];
}

/** Parameters for the `toJSONSchema` function. */
export interface ToJSONSchemaParams {
  /** Registry used to look up metadata for each schema. Schemas with an `id` are extracted into `$defs`. @default globalRegistry */
  readonly metadata?: $ZodRegistry<GlobalMeta> | undefined;
  /** The JSON Schema version to target. `"draft-4"`/`"draft-7"` are normalized to `"draft-04"`/`"draft-07"`. */
  readonly target?: "draft-04" | "draft-07" | "draft-2020-12" | "openapi-3.0" | (string & {}) | undefined;
  /** How to handle unrepresentable types: throw (default) or become `{}`. */
  readonly unrepresentable?: "throw" | "any" | undefined;
  /** Arbitrary custom logic to modify the generated JSON Schema. */
  readonly override?: ((ctx: ToJSONSchemaOverrideContext) => void) | undefined;
  /** Whether to extract the `"input"` or `"output"` (default) side of piped schemas. */
  readonly io?: "input" | "output" | undefined;
  /** How to handle cyclical schemas: resolve with `$ref` + `$defs` (default) or throw. */
  readonly cycles?: "ref" | "throw" | undefined;
  /** How to handle schemas referenced more than once: inline (default) or extract into `$defs`. */
  readonly reused?: "ref" | "inline" | undefined;
}

/** Parameters for `toJSONSchema` when converting a registry of schemas. */
export interface RegistryToJSONSchemaParams extends ToJSONSchemaParams {
  /** Maps a registry `id` to the URI used in `$ref`/`$id`. */
  readonly uri?: ((id: string) => string) | undefined;
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

/**
 * The structural view of a schema the generator needs. Real classic `$ZodType`
 * instances satisfy this; light wrappers are synthesized for graph nodes that
 * have no reachable schema object (catchall, tuple rest, intersection arms).
 */
interface SchemaLike extends $ZodRegistrySchema {
  readonly _zod: {
    readonly node: SchemaNode;
    readonly parent?: SchemaLike | undefined;
    readonly output: unknown;
    readonly input: unknown;
    readonly toJSONSchema?: (() => Record<string, unknown>) | undefined;
  };
  readonly shape?: Readonly<Record<string, SchemaLike>>;
  readonly element?: SchemaLike;
  readonly options?: readonly SchemaLike[];
  readonly items?: readonly SchemaLike[];
  readonly keyType?: SchemaLike;
  readonly valueType?: SchemaLike;
  readonly in?: SchemaLike;
  readonly out?: SchemaLike;
  readonly unwrap?: () => SchemaLike;
  readonly "~standard"?: unknown;
}

type JsonObject = Record<string, unknown>;

interface Seen {
  schema: JsonObject;
  def?: JsonObject | undefined;
  defId?: string | undefined;
  count: number;
  cycle?: (string | number)[] | undefined;
  ref?: SchemaLike | null | undefined;
  path?: (string | number)[] | undefined;
}

interface ExternalContext {
  readonly registry: $ZodRegistry<{ id?: string | undefined }>;
  readonly uri: ((id: string) => string) | undefined;
  readonly defs: Record<string, JsonObject>;
}

interface GenContext {
  readonly metadataRegistry: $ZodRegistry<GlobalMeta>;
  readonly target: string;
  readonly unrepresentable: "throw" | "any";
  readonly runOverride: (ctx: ToJSONSchemaOverrideContext) => void;
  readonly io: "input" | "output";
  counter: number;
  readonly seen: Map<SchemaLike, Seen>;
  readonly cycles: "ref" | "throw";
  readonly reused: "ref" | "inline";
  external?: ExternalContext | undefined;
  /** Node → best-known schema (real schema when reachable, else wrapper). */
  readonly nodeSchema: Map<SchemaNode, SchemaLike>;
  /** Memoized lazy resolution so getter-side-effect lazies resolve once. */
  readonly lazyInner: Map<SchemaLike, SchemaLike>;
  readonly lazyNode: Map<SchemaNode, SchemaNode>;
  /** Override-callback views, cached per schema. */
  readonly views: Map<SchemaLike, ToJSONSchemaSource>;
}

interface ProcessParams {
  readonly schemaPath: readonly SchemaLike[];
  readonly path: (string | number)[];
}

function initializeContext(params?: ToJSONSchemaParams): GenContext {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4") target = "draft-04";
  if (target === "draft-7") target = "draft-07";
  const metadataRegistry = params?.metadata ?? globalRegistry;
  const ctx: GenContext = {
    metadataRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    runOverride: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map(),
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    nodeSchema: new Map(),
    lazyInner: new Map(),
    lazyNode: new Map(),
    views: new Map(),
  };
  // Registry ids let the generator recover real schema objects for graph
  // positions no accessor reaches (tuple rest, catchall, intersection arms).
  for (const raw of ctx.metadataRegistry._idmap.values()) {
    const schema = raw as SchemaLike; // registry erased the concrete schema to $ZodRegistrySchema
    ctx.nodeSchema.set(schema._zod.node, schema);
  }
  return ctx;
}

function nodeToSchema(node: SchemaNode, ctx: GenContext): SchemaLike {
  const known = ctx.nodeSchema.get(node);
  if (known) return known;
  const wrapper: SchemaLike = { _zod: { node, output: undefined, input: undefined } };
  ctx.nodeSchema.set(node, wrapper);
  return wrapper;
}

function resolveLazyNode(node: SchemaNode, ctx: GenContext): SchemaNode {
  if (node.kind !== "lazy") return node;
  let inner = ctx.lazyNode.get(node);
  if (!inner) {
    inner = node.getter();
    ctx.lazyNode.set(node, inner);
  }
  return inner;
}

function resolveLazy(schema: SchemaLike, ctx: GenContext): SchemaLike {
  const cached = ctx.lazyInner.get(schema);
  if (cached) return cached;
  const node = schema._zod.node;
  const inner = typeof schema.unwrap === "function" && node.kind === "lazy" ? schema.unwrap() : nodeToSchema(resolveLazyNode(node, ctx), ctx);
  ctx.lazyInner.set(schema, inner);
  return inner;
}

/**
 * The metadata/refinement "parent" of a schema: clones created by `.meta()`,
 * `.describe()`, and `.check()` share the parent's node kind; wrappers
 * (optional/nullable/pipe/...) introduce a new kind and are not parents.
 */
function jsonParent(schema: SchemaLike): SchemaLike | undefined {
  const parent = schema._zod.parent;
  if (!parent) return undefined;
  if (parent._zod.node.kind !== schema._zod.node.kind) return undefined;
  return parent;
}

// ---------------------------------------------------------------------------
// Format patterns (behavior pinned byte-for-byte by corpus snapshots)
// ---------------------------------------------------------------------------

const FORMAT_NAME_MAP: Record<string, string> = {
  guid: "uuid",
  url: "uri",
  httpUrl: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: "", // sentinel: delete the format key
};

const STATIC_FORMAT_PATTERNS: Record<string, string> = {
  cuid: "^[cC][0-9a-z]{6,}$",
  cuid2: "^[0-9a-z]+$",
  ulid: "^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$",
  xid: "^[0-9a-vA-V]{20}$",
  ksuid: "^[A-Za-z0-9]{27}$",
  nanoid: "^[a-zA-Z0-9_-]{21}$",
  duration:
    "^P(?:(\\d+W)|(?!.*W)(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+([.,]\\d+)?S)?)?)$",
  extendedDuration:
    "^[-+]?P(?!$)(?:(?:[-+]?\\d+Y)|(?:[-+]?\\d+[.,]\\d+Y$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M$))?(?:(?:[-+]?\\d+W)|(?:[-+]?\\d+[.,]\\d+W$))?(?:(?:[-+]?\\d+D)|(?:[-+]?\\d+[.,]\\d+D$))?(?:T(?=[\\d+-])(?:(?:[-+]?\\d+H)|(?:[-+]?\\d+[.,]\\d+H$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M$))?(?:[-+]?\\d+(?:[.,]\\d+)?S)??)$",
  guid: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
  uuid: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
  uuidv4: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
  uuidv6: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-6[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
  uuidv7: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
  email: "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
  html5Email:
    "^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$",
  rfc5322Email:
    "^(([^<>()\\[\\]\\\\.,;:\\s@\"]+(\\.[^<>()\\[\\]\\\\.,;:\\s@\"]+)*)|(\".+\"))@((\\[[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}])|(([a-zA-Z\\-0-9]+\\.)+[a-zA-Z]{2,}))$",
  unicodeEmail: "^[^\\s@\"]{1,64}@[^\\s@]{1,255}$",
  emoji: "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$",
  ipv4: "^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$",
  ipv6: "^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$",
  cidrv4: "^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/([0-9]|[1-2][0-9]|3[0-2])$",
  cidrv6: "^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$",
  base64: "^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$",
  base64url: "^[A-Za-z0-9_-]*$",
  hostname: "^(?=.{1,253}\\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$",
  e164: "^\\+[1-9]\\d{6,14}$",
  lowercase: "^[^A-Z]*$",
  uppercase: "^[^a-z]*$",
  hex: "^[0-9a-fA-F]*$",
};

const DATE_SOURCE =
  "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";

const HASH_LENGTHS: Record<string, readonly [number, number, string]> = {
  md5: [32, 22, "=="],
  sha1: [40, 27, "="],
  sha256: [64, 43, "="],
  sha384: [96, 64, ""],
  sha512: [128, 86, "=="],
};

function timeSource(precision: unknown): string {
  const hhmm = "(?:[01]\\d|2[0-3]):[0-5]\\d";
  if (typeof precision === "number") {
    if (precision === -1) return hhmm;
    if (precision === 0) return `${hhmm}:[0-5]\\d`;
    return `${hhmm}:[0-5]\\d\\.\\d{${precision}}`;
  }
  return `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}

/** JSON Schema `pattern` for a string format check, or undefined when the format carries no pattern. */
function formatPattern(format: FormatId, params: Record<string, unknown> | undefined): string | undefined {
  if (format === "date") return `^${DATE_SOURCE}$`;
  if (format === "time") return `^${timeSource(params?.["precision"])}$`;
  if (format === "datetime") {
    const time = timeSource(params?.["precision"]);
    const opts = ["Z"];
    if (params?.["local"] === true) opts.push("");
    if (params?.["offset"] === true) opts.push("([+-](?:[01]\\d|2[0-3]):[0-5]\\d)");
    return `^${DATE_SOURCE}T(?:${time}(?:${opts.join("|")}))$`;
  }
  if (format === "mac") {
    const delimiter = typeof params?.["delimiter"] === "string" ? params["delimiter"] : ":";
    const d = escapeRegex(delimiter);
    return `^(?:[0-9A-F]{2}${d}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${d}){5}[0-9a-f]{2}$`;
  }
  const hash = HASH_LENGTHS[format];
  if (hash) {
    const [hexLength, base64Length, padding] = hash;
    const encoding = typeof params?.["enc"] === "string" ? params["enc"] : "hex";
    if (encoding === "hex") return `^[0-9a-fA-F]{${hexLength}}$`;
    if (encoding === "base64url") return `^[A-Za-z0-9_-]{${base64Length}}$`;
    return `^[A-Za-z0-9+/]{${base64Length}}${escapeRegex(padding)}$`;
  }
  return STATIC_FORMAT_PATTERNS[format];
}

const NUMBER_FORMAT_BOUNDS: Record<string, readonly [number, number]> = {
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-3.4028234663852886e38, 3.4028234663852886e38],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
  safeint: [-9007199254740991, 9007199254740991],
};

// ---------------------------------------------------------------------------
// Node-shape predicates
// ---------------------------------------------------------------------------

/** Whether parsing through this node can change the JS value (drives io=input example/default stripping). */
function isTransforming(node: SchemaNode, ctx: GenContext, visited: Set<SchemaNode>): boolean {
  if (visited.has(node)) return false;
  visited.add(node);
  switch (node.kind) {
    case "host":
      return node.op === "transform" || node.op === "preprocess" || node.op === "codec_decode" || node.op === "codec_encode";
    case "array":
      return isTransforming(node.element, ctx, visited);
    case "set":
      return isTransforming(node.value, ctx, visited);
    case "lazy":
      return isTransforming(resolveLazyNode(node, ctx), ctx, visited);
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
    case "default":
    case "prefault":
      return isTransforming(node.inner, ctx, visited);
    case "intersection":
      return isTransforming(node.left, ctx, visited) || isTransforming(node.right, ctx, visited);
    case "record":
    case "map":
      return isTransforming(node.key, ctx, visited) || isTransforming(node.value, ctx, visited);
    case "pipe":
      return isTransforming(node.a, ctx, visited) || isTransforming(node.b, ctx, visited);
    case "object":
      return Object.values(node.shape).some((child) => isTransforming(child, ctx, visited));
    case "union":
    case "discunion":
      return node.options.some((option) => isTransforming(option, ctx, visited));
    case "tuple":
      return (
        node.items.some((item) => isTransforming(item, ctx, visited)) ||
        (node.rest !== null && isTransforming(node.rest, ctx, visited))
      );
    default:
      return false;
  }
}

/** Zod `optin === undefined` equivalent: whether the property may be absent from valid input. */
function inputOptional(node: SchemaNode, ctx: GenContext, visited: Set<SchemaNode>): boolean {
  if (visited.has(node)) return false;
  visited.add(node);
  switch (node.kind) {
    case "optional":
    case "exactOptional":
    case "default":
    case "prefault":
    case "catch":
      return true;
    case "nonoptional":
      return false;
    case "nullable":
    case "readonly":
    case "promise":
      return inputOptional(node.inner, ctx, visited);
    case "lazy":
      return inputOptional(resolveLazyNode(node, ctx), ctx, visited);
    case "pipe":
      return inputOptional(node.a, ctx, visited);
    case "union":
      return node.options.some((option) => inputOptional(option, ctx, visited));
    case "host":
      return node.inner !== null && inputOptional(node.inner, ctx, visited);
    default:
      return false;
  }
}

/** Zod `optout === undefined` equivalent: whether the property may be absent from valid output. */
function outputOptional(node: SchemaNode, ctx: GenContext, visited: Set<SchemaNode>): boolean {
  if (visited.has(node)) return false;
  visited.add(node);
  switch (node.kind) {
    case "optional":
    case "exactOptional":
      return true;
    case "nonoptional":
      return false;
    case "nullable":
    case "readonly":
    case "promise":
      return outputOptional(node.inner, ctx, visited);
    case "lazy":
      return outputOptional(resolveLazyNode(node, ctx), ctx, visited);
    case "pipe":
      return outputOptional(node.b, ctx, visited);
    case "union":
      return node.options.some((option) => outputOptional(option, ctx, visited));
    case "host":
      return node.inner !== null && outputOptional(node.inner, ctx, visited);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// process: walk the graph, build per-schema JSON, track seen/cycles
// ---------------------------------------------------------------------------

function process(schema: SchemaLike, ctx: GenContext, params: ProcessParams): JsonObject {
  const node = schema._zod.node;
  if (!ctx.nodeSchema.has(node)) ctx.nodeSchema.set(node, schema);

  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    if (params.schemaPath.includes(schema)) seen.cycle = params.path;
    return seen.schema;
  }

  const result: Seen = { schema: {}, count: 1, path: params.path };
  ctx.seen.set(schema, result);

  // A schema-level `_zod.toJSONSchema` override replaces default behavior.
  const customSchema = schema._zod.toJSONSchema?.();
  if (customSchema) {
    result.schema = customSchema;
  } else {
    const innerParams: ProcessParams = { schemaPath: [...params.schemaPath, schema], path: params.path };
    processNode(schema, node, result, ctx, innerParams);

    const parent = jsonParent(schema);
    if (parent) {
      if (!result.ref) result.ref = parent;
      process(parent, ctx, innerParams);
    }
  }

  const meta: Record<string, unknown> | undefined = ctx.metadataRegistry.get(schema);
  if (meta) Object.assign(result.schema, meta);

  if (ctx.io === "input" && isTransforming(node, ctx, new Set())) {
    delete result.schema["examples"];
    delete result.schema["default"];
  }

  // Promote `_prefault` to `default` after the transforming-scrub so prefaults survive it.
  if (ctx.io === "input" && "_prefault" in result.schema) result.schema["default"] ??= result.schema["_prefault"];
  delete result.schema["_prefault"];

  return result.schema;
}

/** Throws the unrepresentable error or, under policy `"any"`, emits `{}` (writes nothing). */
function handleUnrepresentable(ctx: GenContext, message: string): void {
  if (ctx.unrepresentable === "throw") throw new Error(message);
}

function processNode(schema: SchemaLike, node: SchemaNode, seen: Seen, ctx: GenContext, params: ProcessParams): void {
  const json = seen.schema;
  const legacyTarget = ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0";

  switch (node.kind) {
    case "string": {
      json["type"] = "string";
      let minimum: number | undefined;
      let maximum: number | undefined;
      let format: string | undefined;
      let contentEncoding: string | undefined;
      const patterns: string[] = [];
      for (const runtime of node.checks) {
        const check = runtime.check;
        switch (check.c) {
          case "min_length":
            if (check.v > (minimum ?? Number.NEGATIVE_INFINITY)) minimum = check.v;
            break;
          case "max_length":
            if (check.v < (maximum ?? Number.POSITIVE_INFINITY)) maximum = check.v;
            break;
          case "length":
            minimum = check.v;
            maximum = check.v;
            break;
          case "format": {
            format = check.v;
            const pattern = formatPattern(check.v, check.params);
            if (pattern) patterns.push(pattern);
            if (check.v === "base64" || check.v === "base64url") contentEncoding = check.v;
            break;
          }
          case "regex":
            patterns.push(check.src);
            break;
          case "starts_with":
            patterns.push(`^${escapeRegex(check.v)}.*`);
            break;
          case "ends_with":
            patterns.push(`.*${escapeRegex(check.v)}$`);
            break;
          case "includes":
            patterns.push(typeof check.position === "number" ? `^.{${check.position}}${escapeRegex(check.v)}` : escapeRegex(check.v));
            break;
          case "lowercase":
            format = "lowercase";
            patterns.push("^[^A-Z]*$");
            break;
          case "uppercase":
            format = "uppercase";
            patterns.push("^[^a-z]*$");
            break;
          default:
            break;
        }
      }
      if (typeof minimum === "number") json["minLength"] = minimum;
      if (typeof maximum === "number") json["maxLength"] = maximum;
      if (format) {
        const mapped = FORMAT_NAME_MAP[format] ?? format;
        if (mapped !== "" && format !== "time") json["format"] = mapped;
      }
      if (contentEncoding) json["contentEncoding"] = contentEncoding;
      if (patterns.length === 1) {
        json["pattern"] = patterns[0];
      } else if (patterns.length > 1) {
        json["allOf"] = patterns.map((pattern) => (legacyTarget ? { type: "string", pattern } : { pattern }));
      }
      break;
    }

    case "number": {
      let minimum: number | undefined;
      let maximum: number | undefined;
      let exclusiveMinimum: number | undefined;
      let exclusiveMaximum: number | undefined;
      let multipleOf: number | undefined;
      let integer = false;
      for (const runtime of node.checks) {
        const check = runtime.check;
        switch (check.c) {
          case "gt":
            if (typeof check.v === "number") {
              if (check.inclusive) {
                if (check.v > (minimum ?? Number.NEGATIVE_INFINITY)) minimum = check.v;
              } else if (check.v > (exclusiveMinimum ?? Number.NEGATIVE_INFINITY)) exclusiveMinimum = check.v;
            }
            break;
          case "lt":
            if (typeof check.v === "number") {
              if (check.inclusive) {
                if (check.v < (maximum ?? Number.POSITIVE_INFINITY)) maximum = check.v;
              } else if (check.v < (exclusiveMaximum ?? Number.POSITIVE_INFINITY)) exclusiveMaximum = check.v;
            }
            break;
          case "multiple_of":
            if (typeof check.v === "number") multipleOf ??= check.v;
            break;
          case "number_format": {
            const bounds = NUMBER_FORMAT_BOUNDS[check.v];
            if (bounds) {
              [minimum, maximum] = bounds;
              if (check.v.includes("int")) integer = true;
            }
            break;
          }
          default:
            break;
        }
      }
      json["type"] = integer ? "integer" : "number";

      // When both inclusive and exclusive bounds exist, the more restrictive wins.
      const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
      const useExclusiveMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
      const useExclusiveMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
      if (useExclusiveMin) {
        if (legacy) {
          json["minimum"] = exclusiveMinimum;
          json["exclusiveMinimum"] = true;
        } else {
          json["exclusiveMinimum"] = exclusiveMinimum;
        }
      } else if (typeof minimum === "number") {
        json["minimum"] = minimum;
      }
      if (useExclusiveMax) {
        if (legacy) {
          json["maximum"] = exclusiveMaximum;
          json["exclusiveMaximum"] = true;
        } else {
          json["exclusiveMaximum"] = exclusiveMaximum;
        }
      } else if (typeof maximum === "number") {
        json["maximum"] = maximum;
      }
      if (typeof multipleOf === "number") json["multipleOf"] = multipleOf;
      break;
    }

    case "boolean":
      json["type"] = "boolean";
      break;
    case "null":
      if (ctx.target === "openapi-3.0") {
        json["type"] = "string";
        json["nullable"] = true;
        json["enum"] = [null];
      } else {
        json["type"] = "null";
      }
      break;
    case "never":
      json["not"] = {};
      break;
    case "any":
    case "unknown":
      break;
    case "bigint":
      handleUnrepresentable(ctx, "BigInt cannot be represented in JSON Schema");
      break;
    case "symbol":
      handleUnrepresentable(ctx, "Symbols cannot be represented in JSON Schema");
      break;
    case "undefined":
      handleUnrepresentable(ctx, "Undefined cannot be represented in JSON Schema");
      break;
    case "void":
      handleUnrepresentable(ctx, "Void cannot be represented in JSON Schema");
      break;
    case "date":
      handleUnrepresentable(ctx, "Date cannot be represented in JSON Schema");
      break;
    case "nan":
      handleUnrepresentable(ctx, "NaN cannot be represented in JSON Schema");
      break;
    case "function":
      handleUnrepresentable(ctx, "Function types cannot be represented in JSON Schema");
      break;
    case "map":
      handleUnrepresentable(ctx, "Map cannot be represented in JSON Schema");
      break;
    case "set":
      handleUnrepresentable(ctx, "Set cannot be represented in JSON Schema");
      break;

    case "enum": {
      const values = [...node.values];
      if (values.every((v) => typeof v === "number")) json["type"] = "number";
      if (values.every((v) => typeof v === "string")) json["type"] = "string";
      json["enum"] = values;
      break;
    }

    case "literal": {
      const vals: (string | number | boolean | null)[] = [];
      for (const val of node.values) {
        if (val === undefined) {
          handleUnrepresentable(ctx, "Literal `undefined` cannot be represented in JSON Schema");
        } else if (typeof val === "symbol") {
          handleUnrepresentable(ctx, "Symbol literals cannot be represented in JSON Schema");
        } else if (typeof val === "bigint") {
          if (ctx.unrepresentable === "throw") {
            throw new Error("BigInt literals cannot be represented in JSON Schema");
          }
          vals.push(Number(val));
        } else {
          vals.push(val);
        }
      }
      if (vals.length === 0) {
        // all values stripped as unrepresentable
      } else if (vals.length === 1) {
        const [val] = vals;
        json["type"] = val === null ? "null" : typeof val;
        if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
          json["enum"] = [val];
        } else {
          json["const"] = val;
        }
      } else {
        if (vals.every((v) => typeof v === "number")) json["type"] = "number";
        if (vals.every((v) => typeof v === "string")) json["type"] = "string";
        if (vals.every((v) => typeof v === "boolean")) json["type"] = "boolean";
        if (vals.every((v) => v === null)) json["type"] = "null";
        json["enum"] = vals;
      }
      break;
    }

    case "templateLiteral":
      json["type"] = "string";
      json["pattern"] = node.pattern.source;
      break;

    case "file": {
      json["type"] = "string";
      json["format"] = "binary";
      json["contentEncoding"] = "binary";
      let minimum: number | undefined;
      let maximum: number | undefined;
      let mime: readonly string[] | undefined;
      for (const runtime of node.checks) {
        const check = runtime.check;
        if (check.c === "min_size") {
          if (check.v > (minimum ?? Number.NEGATIVE_INFINITY)) minimum = check.v;
        } else if (check.c === "max_size") {
          if (check.v < (maximum ?? Number.POSITIVE_INFINITY)) maximum = check.v;
        } else if (check.c === "size") {
          minimum = check.v;
          maximum = check.v;
        } else if (check.c === "mime") {
          mime = check.v;
        }
      }
      if (typeof minimum === "number") json["minLength"] = minimum;
      if (typeof maximum === "number") json["maxLength"] = maximum;
      if (mime) {
        if (mime.length === 1) {
          json["contentMediaType"] = mime[0];
        } else {
          json["anyOf"] = mime.map((m) => ({ contentMediaType: m }));
        }
      }
      break;
    }

    case "object": {
      json["type"] = "object";
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, childNode] of Object.entries(node.shape)) {
        const child = schema.shape?.[key] ?? nodeToSchema(childNode, ctx);
        properties[key] = process(child, ctx, { schemaPath: params.schemaPath, path: [...params.path, "properties", key] });
      }
      json["properties"] = properties;
      for (const [key, childNode] of Object.entries(node.shape)) {
        const optional =
          ctx.io === "input" ? inputOptional(childNode, ctx, new Set()) : outputOptional(childNode, ctx, new Set());
        if (!optional) required.push(key);
      }
      if (required.length > 0) json["required"] = required;

      if (node.mode === "strict") {
        json["additionalProperties"] = false;
      } else if (node.catchall) {
        json["additionalProperties"] = process(nodeToSchema(node.catchall, ctx), ctx, {
          schemaPath: params.schemaPath,
          path: [...params.path, "additionalProperties"],
        });
      } else if (node.mode === "passthrough") {
        json["additionalProperties"] = {};
      } else if (ctx.io === "output") {
        json["additionalProperties"] = false;
      }
      break;
    }

    case "union":
    case "discunion": {
      // Discriminated unions and xor are exclusive: exactly one option may match.
      const keyword = node.kind === "discunion" ? "oneOf" : "anyOf";
      json[keyword] = node.options.map((option, i) =>
        process(schema.options?.[i] ?? nodeToSchema(option, ctx), ctx, {
          schemaPath: params.schemaPath,
          path: [...params.path, keyword, i],
        })
      );
      break;
    }

    case "intersection": {
      const a = process(nodeToSchema(node.left, ctx), ctx, { schemaPath: params.schemaPath, path: [...params.path, "allOf", 0] });
      const b = process(nodeToSchema(node.right, ctx), ctx, { schemaPath: params.schemaPath, path: [...params.path, "allOf", 1] });
      // Flatten nested bare intersections into a single allOf.
      const aSimple = "allOf" in a && Object.keys(a).length === 1;
      const bSimple = "allOf" in b && Object.keys(b).length === 1;
      const aAllOf = a["allOf"];
      const bAllOf = b["allOf"];
      json["allOf"] = [
        ...(aSimple && Array.isArray(aAllOf) ? aAllOf : [a]),
        ...(bSimple && Array.isArray(bAllOf) ? bAllOf : [b]),
      ];
      break;
    }

    case "tuple": {
      json["type"] = "array";
      const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
      const restPath = ctx.target === "draft-07" || ctx.target === "draft-04" ? "additionalItems" : "items";
      const prefixItems = node.items.map((item, i) =>
        process(schema.items?.[i] ?? nodeToSchema(item, ctx), ctx, {
          schemaPath: params.schemaPath,
          path: [...params.path, prefixPath, i],
        })
      );
      const rest = node.rest
        ? process(nodeToSchema(node.rest, ctx), ctx, {
            schemaPath: params.schemaPath,
            path: [...params.path, restPath, ...(ctx.target === "openapi-3.0" ? [node.items.length] : [])],
          })
        : null;

      if (ctx.target === "draft-2020-12") {
        json["prefixItems"] = prefixItems;
        if (rest) json["items"] = rest;
      } else if (ctx.target === "openapi-3.0") {
        const anyOf = rest ? [...prefixItems, rest] : prefixItems;
        json["items"] = { anyOf };
        // Zod pushes `rest` into the prefix array before reading its length, so
        // minItems counts the rest schema as a required item.
        json["minItems"] = prefixItems.length + (rest ? 1 : 0);
        if (!rest) json["maxItems"] = prefixItems.length;
      } else {
        json["items"] = prefixItems;
        if (rest) json["additionalItems"] = rest;
      }

      let minimum: number | undefined;
      let maximum: number | undefined;
      for (const runtime of node.checks) {
        const check = runtime.check;
        if (check.c === "min_length") {
          if (check.v > (minimum ?? Number.NEGATIVE_INFINITY)) minimum = check.v;
        } else if (check.c === "max_length") {
          if (check.v < (maximum ?? Number.POSITIVE_INFINITY)) maximum = check.v;
        } else if (check.c === "length") {
          minimum = check.v;
          maximum = check.v;
        }
      }
      if (typeof minimum === "number") json["minItems"] = minimum;
      if (typeof maximum === "number") json["maxItems"] = maximum;
      break;
    }

    case "array": {
      let minimum: number | undefined;
      let maximum: number | undefined;
      for (const runtime of node.checks) {
        const check = runtime.check;
        if (check.c === "min_length") {
          if (check.v > (minimum ?? Number.NEGATIVE_INFINITY)) minimum = check.v;
        } else if (check.c === "max_length") {
          if (check.v < (maximum ?? Number.POSITIVE_INFINITY)) maximum = check.v;
        } else if (check.c === "length") {
          minimum = check.v;
          maximum = check.v;
        }
      }
      if (typeof minimum === "number") json["minItems"] = minimum;
      if (typeof maximum === "number") json["maxItems"] = maximum;
      json["type"] = "array";
      json["items"] = process(schema.element ?? nodeToSchema(node.element, ctx), ctx, {
        schemaPath: params.schemaPath,
        path: [...params.path, "items"],
      });
      break;
    }

    case "record": {
      json["type"] = "object";
      const keyNode = node.key;
      const keyPatterns = bagOf(keyNode).patterns;
      if (node.mode === "loose" && keyPatterns && keyPatterns.length > 0) {
        // Loose records with regex keys validate only matching keys: patternProperties.
        const valueSchema = process(schema.valueType ?? nodeToSchema(node.value, ctx), ctx, {
          schemaPath: params.schemaPath,
          path: [...params.path, "patternProperties", "*"],
        });
        const patternProperties: Record<string, JSONSchema> = {};
        for (const pattern of keyPatterns) patternProperties[pattern.source] = valueSchema;
        json["patternProperties"] = patternProperties;
      } else {
        if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
          json["propertyNames"] = process(schema.keyType ?? nodeToSchema(keyNode, ctx), ctx, {
            schemaPath: params.schemaPath,
            path: [...params.path, "propertyNames"],
          });
        }
        json["additionalProperties"] = process(schema.valueType ?? nodeToSchema(node.value, ctx), ctx, {
          schemaPath: params.schemaPath,
          path: [...params.path, "additionalProperties"],
        });
      }

      // Keys with discrete values (enum/literal) become required entries.
      const keyValues = keyNode.kind === "enum" || keyNode.kind === "literal" ? keyNode.values : undefined;
      if (keyValues) {
        const valid = keyValues.filter((v): v is string | number => typeof v === "string" || typeof v === "number");
        if (valid.length > 0) json["required"] = valid;
      }
      break;
    }

    case "nullable": {
      const inner = unwrapInner(schema, node.inner, ctx);
      const innerJson = process(inner, ctx, params);
      if (ctx.target === "openapi-3.0") {
        seen.ref = inner;
        json["nullable"] = true;
      } else {
        json["anyOf"] = [innerJson, { type: "null" }];
      }
      break;
    }

    case "optional":
    case "nonoptional":
    case "promise": {
      const inner = unwrapInner(schema, node.inner, ctx);
      process(inner, ctx, params);
      seen.ref = inner;
      break;
    }

    case "readonly": {
      const inner = unwrapInner(schema, node.inner, ctx);
      process(inner, ctx, params);
      seen.ref = inner;
      json["readOnly"] = true;
      break;
    }

    case "default":
    case "prefault": {
      const inner = unwrapInner(schema, node.inner, ctx);
      process(inner, ctx, params);
      seen.ref = inner;
      const raw = node.dynamic && typeof node.value === "function" ? (node.value as () => unknown)() : node.value;
      const serialized = JSON.parse(JSON.stringify(raw)) as unknown;
      if (node.kind === "default") json["default"] = serialized;
      else if (ctx.io === "input") json["_prefault"] = serialized;
      break;
    }

    case "catch": {
      const inner = unwrapInner(schema, node.inner, ctx);
      process(inner, ctx, params);
      seen.ref = inner;
      let catchValue: unknown;
      try {
        catchValue = node.dynamic && typeof node.value === "function" ? (node.value as (ctx?: unknown) => unknown)(undefined) : node.value;
      } catch {
        if (ctx.unrepresentable === "throw") {
          throw new Error("Dynamic catch values are not supported in JSON Schema");
        }
        break;
      }
      json["default"] = catchValue;
      break;
    }

    case "lazy": {
      const inner = resolveLazy(schema, ctx);
      process(inner, ctx, params);
      seen.ref = inner;
      break;
    }

    case "pipe": {
      let side: SchemaLike;
      if (ctx.io === "output") {
        side = schema.out ?? nodeToSchema(node.b, ctx);
      } else {
        // An in-side that is itself a bare transform (preprocess, codec decode)
        // has no representable input side; use the out side instead.
        const a = node.a;
        const bareTransformIn =
          a.kind === "host" && (a.inner === null || a.op === "preprocess" || a.op === "codec_decode" || a.op === "codec_encode");
        side = bareTransformIn ? (schema.out ?? nodeToSchema(node.b, ctx)) : (schema.in ?? nodeToSchema(node.a, ctx));
      }
      process(side, ctx, params);
      seen.ref = side;
      break;
    }

    case "host": {
      if (node.op === "transform" || node.op === "preprocess" || node.op === "codec_decode" || node.op === "codec_encode") {
        if (ctx.io === "input" && node.inner !== null) {
          const inner = nodeToSchema(node.inner, ctx);
          process(inner, ctx, params);
          seen.ref = inner;
        } else {
          handleUnrepresentable(ctx, "Transforms cannot be represented in JSON Schema");
        }
      } else {
        handleUnrepresentable(ctx, "Custom types cannot be represented in JSON Schema");
      }
      break;
    }
  }
}

/** Wrapper children resolve through the real `.unwrap()` when available so registry metadata stays reachable. */
function unwrapInner(schema: SchemaLike, innerNode: SchemaNode, ctx: GenContext): SchemaLike {
  return typeof schema.unwrap === "function" ? schema.unwrap() : nodeToSchema(innerNode, ctx);
}

// ---------------------------------------------------------------------------
// extractDefs: convert ids/cycles/reused schemas into $ref + $defs
// ---------------------------------------------------------------------------

function extractDefs(ctx: GenContext, schema: SchemaLike): void {
  const root = ctx.seen.get(schema);
  if (!root) throw new Error("Unprocessed schema. This is a bug in zodrs.");

  // Two different schemas sharing one registry id cannot be converted together.
  const idToSchema = new Map<string, SchemaLike>();
  for (const [entry] of ctx.seen) {
    const id = ctx.metadataRegistry.get(entry)?.id;
    if (typeof id === "string") {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry) {
        throw new Error(
          `Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`
        );
      }
      idToSchema.set(id, entry);
    }
  }

  const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";

  // Returns the `$ref` string for a seen entry, plus the `$defs` key when the
  // entry is extracted into the local/shared defs (absent for the root and for
  // schemas that live in the external registry).
  const makeURI = (entry: [SchemaLike, Seen]): { ref: string; defId?: string | undefined } => {
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id: string) => id);
      if (externalId) return { ref: uriGenerator(externalId) };
      const rawExternalId = entry[1].schema["id"];
      const id = entry[1].defId ?? (typeof rawExternalId === "string" ? rawExternalId : undefined) ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
    }
    if (entry[1] === root) return { ref: "#" };
    const rawLocalId = entry[1].schema["id"];
    const defId = (typeof rawLocalId === "string" ? rawLocalId : undefined) ?? `__schema${ctx.counter++}`;
    return { defId, ref: `#/${defsSegment}/${defId}` };
  };

  // Snapshot the body into `def`, then wipe the live schema down to a `$ref`.
  const extractToDef = (entry: [SchemaLike, Seen]): void => {
    if (entry[1].schema["$ref"]) return;
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId) seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) delete schema[key];
    schema["$ref"] = ref;
  };

  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error(
          "Cycle detected: " +
            `#/${seen.cycle.join("/")}/<root>` +
            '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.'
        );
      }
    }
  }

  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      if (externalId) {
        extractToDef(entry);
        continue;
      }
    }
    if (typeof ctx.metadataRegistry.get(entry[0])?.id === "string") {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1 && ctx.reused === "ref") {
      extractToDef(entry);
    }
  }
}

// ---------------------------------------------------------------------------
// finalize: flatten wrapper inheritance, run overrides, assemble output
// ---------------------------------------------------------------------------

const ZOD_TYPE_NAMES: Record<string, string> = {
  discunion: "union",
  templateLiteral: "template_literal",
};

const STRICT_CATCHALL: ToJSONSchemaSourceDef = Object.freeze({ type: "never" });

function finalize(ctx: GenContext, schema: SchemaLike): JSONSchema {
  const root = ctx.seen.get(schema);
  if (!root) throw new Error("Unprocessed schema. This is a bug in zodrs.");

  const legacyRefTarget = ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0";

  // Merge each schema's JSON with the schema it references (wrappers inherit
  // from their inner schema, clones from their parent). Child keys win.
  const flattenRef = (zodSchema: SchemaLike): void => {
    const seen = ctx.seen.get(zodSchema);
    if (!seen || seen.ref === null) return;

    const schema = seen.def ?? seen.schema;
    const cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null; // each schema flattens once

    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      if (!refSeen) return;
      const refSchema = refSeen.schema;

      if (refSchema["$ref"] && legacyRefTarget) {
        // Older drafts cannot combine $ref with sibling properties.
        const existingAllOf = schema["allOf"];
        const allOf: unknown[] = Array.isArray(existingAllOf) ? existingAllOf : [];
        allOf.push(refSchema);
        schema["allOf"] = allOf;
      } else {
        Object.assign(schema, refSchema);
      }
      Object.assign(schema, cached); // restore own keys over inherited ones

      // A metadata/refinement clone keeps only its own keys plus the ref link.
      if (jsonParent(zodSchema) === ref) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf") continue;
          if (!(key in cached)) delete schema[key];
        }
      }

      // When the ref target was extracted into $defs, drop keys identical to the def.
      if (refSchema["$ref"] && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf") continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }

    // An extracted parent propagates its $ref down to clones of wrappers
    // (e.g. readonly().meta({id}).describe("...")).
    const parent = jsonParent(zodSchema);
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen && parentSeen.schema["$ref"]) {
        schema["$ref"] = parentSeen.schema["$ref"];
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf") continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }

    ctx.runOverride({ zodSchema: viewOf(zodSchema, ctx), jsonSchema: schema as BaseSchema, path: seen.path ?? [] });
  };

  for (const entry of [...ctx.seen.entries()].reverse()) {
    flattenRef(entry[0]);
  }

  const result: JsonObject = {};
  if (ctx.target === "draft-2020-12") {
    result["$schema"] = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result["$schema"] = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result["$schema"] = "http://json-schema.org/draft-04/schema#";
  }

  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id) throw new Error("Schema is missing an `id` property");
    result["$id"] = ctx.external.uri(id);
  }

  Object.assign(result, root.def ?? root.schema);

  // The registry `id` is a registration tag for $defs extraction, not
  // user-facing JSON Schema metadata; strip it from the root body.
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result["id"] === rootMetaId) delete result["id"];

  const defs: Record<string, JsonObject> = ctx.external?.defs ?? {};
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (seen.def && seen.defId) {
      if (seen.def["id"] === seen.defId) delete seen.def["id"];
      defs[seen.defId] = seen.def;
    }
  }

  if (!ctx.external && Object.keys(defs).length > 0) {
    if (ctx.target === "draft-2020-12") {
      result["$defs"] = defs;
    } else {
      result["definitions"] = defs;
    }
  }

  let finalized: JsonObject;
  try {
    finalized = JSON.parse(JSON.stringify(result)) as JsonObject;
  } catch {
    throw new Error("Error converting schema to JSON.");
  }

  // Attach the Standard Schema payload (non-enumerable, mirroring Zod).
  const standardProps = schema["~standard"];
  const standardBase = typeof standardProps === "object" && standardProps !== null ? standardProps : {};
  Object.defineProperty(finalized, "~standard", {
    value: {
      ...standardBase,
      jsonSchema: {
        input: (params?: { target?: string | undefined; libraryOptions?: ToJSONSchemaParams | undefined }) =>
          generate(schema, { ...(params?.libraryOptions ?? {}), target: params?.target, io: "input" }),
        output: (params?: { target?: string | undefined; libraryOptions?: ToJSONSchemaParams | undefined }) =>
          generate(schema, { ...(params?.libraryOptions ?? {}), target: params?.target, io: "output" }),
      },
    },
    enumerable: false,
    writable: false,
  });

  return finalized as JSONSchema;
}

/** The override-facing view: real schema, with `_zod.def` presented in Zod's `def.type` vocabulary. */
function viewOf(schema: SchemaLike, ctx: GenContext): ToJSONSchemaSource {
  const cached = ctx.views.get(schema);
  if (cached) return cached;
  const node = schema._zod.node;
  const def: ToJSONSchemaSourceDef = {
    ...node,
    type: node.kind === "host" ? (node.op === "transform" ? "transform" : "custom") : (ZOD_TYPE_NAMES[node.kind] ?? node.kind),
    catchall: node.kind === "object" ? (node.catchall ?? (node.mode === "strict" ? STRICT_CATCHALL : undefined)) : undefined,
  };
  const view: ToJSONSchemaSource = { _zod: { node, output: schema._zod.output, input: schema._zod.input, def } };
  ctx.views.set(schema, view);
  return view;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function generate(schema: SchemaLike, params?: ToJSONSchemaParams): JSONSchema {
  const ctx = initializeContext(params);
  process(schema, ctx, { path: [], schemaPath: [] });
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
}

/**
 * Converts a zodrs schema to JSON Schema, or every id-registered schema in a
 * registry to a `{ schemas }` map with cross-references resolved through `uri`.
 */
export function toJSONSchema(schema: $ZodRegistrySchema, params?: ToJSONSchemaParams): JSONSchema;
export function toJSONSchema(
  registry: $ZodRegistry<{ id?: string | undefined }>,
  params?: RegistryToJSONSchemaParams
): { schemas: Record<string, JSONSchema> };
export function toJSONSchema(
  input: $ZodRegistrySchema | $ZodRegistry<{ id?: string | undefined }>,
  params?: ToJSONSchemaParams | RegistryToJSONSchemaParams
): JSONSchema | { schemas: Record<string, JSONSchema> } {
  if ("_idmap" in input) {
    const registry = input;
    const ctx = initializeContext(params);
    const defs: Record<string, JsonObject> = {};

    // First pass: process every registered schema into one shared seen map.
    for (const raw of registry._idmap.values()) {
      const schema = raw as SchemaLike; // registry erased the concrete schema to $ZodRegistrySchema
      process(schema, ctx, { path: [], schemaPath: [] });
    }

    const uri = params && "uri" in params ? params.uri : undefined;
    ctx.external = { registry, uri, defs };
    for (const raw of registry._idmap.values()) {
      const schema = raw as SchemaLike;
      ctx.nodeSchema.set(schema._zod.node, schema);
    }

    const schemas: Record<string, JSONSchema> = {};
    for (const [key, raw] of registry._idmap.entries()) {
      const schema = raw as SchemaLike;
      extractDefs(ctx, schema);
      schemas[key] = finalize(ctx, schema);
    }

    if (Object.keys(defs).length > 0) {
      const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas["__shared"] = { [defsSegment]: defs } as JSONSchema;
    }

    return { schemas };
  }

  const rootSchema = input as SchemaLike; // the schema overload receives a real classic schema
  return generate(rootSchema, params);
}

export type { JSONSchema, BaseSchema } from "./json-schema-types.js";
