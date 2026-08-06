import type { $ZodErrorMap, $ZodRawIssue } from "./errors.js";
import type { JSONType, MaybeAsync, Primitive } from "./util.js";

export type NodeId = number;
export type ObjectMode = "strip" | "strict" | "passthrough";
export type Numeric = number | bigint | Date;

export type FormatId =
  | "email" | "html5Email" | "rfc5322Email" | "unicodeEmail" | "url" | "httpUrl" | "hostname" | "emoji"
  | "uuid" | "uuidv4" | "uuidv6" | "uuidv7" | "guid" | "cuid" | "cuid2" | "ulid" | "xid" | "ksuid"
  | "nanoid" | "ipv4" | "ipv6" | "mac" | "cidrv4" | "cidrv6" | "base64" | "base64url" | "e164" | "jwt"
  | "date" | "time" | "datetime" | "duration" | "extendedDuration" | "hex" | "md5" | "sha1" | "sha256"
  | "sha384" | "sha512" | (string & {});

export type Check =
  | { readonly c: "min_length" | "max_length" | "length" | "min_size" | "max_size" | "size"; readonly v: number }
  | { readonly c: "gt" | "lt"; readonly v: number | string; readonly inclusive: boolean; readonly bigint?: true }
  | { readonly c: "multiple_of"; readonly v: number | string }
  | { readonly c: "number_format"; readonly v: "int32" | "uint32" | "float32" | "float64" | "safeint" }
  | { readonly c: "bigint_format"; readonly v: "int64" | "uint64" }
  | { readonly c: "format"; readonly v: FormatId; readonly params?: Record<string, unknown> }
  | { readonly c: "regex"; readonly src: string; readonly flags: string }
  | { readonly c: "starts_with" | "ends_with"; readonly v: string }
  | { readonly c: "includes"; readonly v: string; readonly position?: number }
  | { readonly c: "lowercase" | "uppercase" }
  | { readonly c: "overwrite"; readonly op: "trim" | "toLowerCase" | "toUpperCase" | "normalize" | "slugify"; readonly form?: string }
  | { readonly c: "mime"; readonly v: string[] }
  | { readonly c: "property"; readonly key: string; readonly node: NodeId }
  | { readonly c: "host"; readonly fn: number };

export type PlanNode =
  | { readonly k: "string" | "number" | "bigint" | "date" | "file"; readonly checks: Check[]; readonly coerce?: true }
  | { readonly k: "boolean"; readonly coerce?: true }
  | { readonly k: "null" | "undefined" | "any" | "unknown" | "never" | "void" | "symbol" | "nan" }
  | { readonly k: "literal"; readonly values: (string | number | boolean | null)[] }
  | { readonly k: "enum"; readonly values: (string | number)[] }
  | { readonly k: "object"; readonly keys: string[]; readonly values: NodeId[]; readonly optional: boolean[]; readonly mode: ObjectMode; readonly catchall: NodeId | null }
  | { readonly k: "array"; readonly element: NodeId; readonly checks: Check[] }
  | { readonly k: "tuple"; readonly items: NodeId[]; readonly rest: NodeId | null }
  | { readonly k: "union"; readonly options: NodeId[] }
  | { readonly k: "discunion"; readonly key: string; readonly map: [string | number | boolean | null, NodeId][] }
  | { readonly k: "intersection"; readonly left: NodeId; readonly right: NodeId }
  | { readonly k: "record"; readonly key: NodeId; readonly value: NodeId }
  | { readonly k: "map" | "set"; readonly key?: NodeId; readonly value: NodeId; readonly checks: Check[] }
  | { readonly k: "optional" | "nullable" | "nonoptional" | "readonly" | "lazy" | "promise"; readonly inner: NodeId }
  | { readonly k: "default" | "prefault" | "catch"; readonly inner: NodeId; readonly value: JSONType | null; readonly dynamic: boolean }
  | { readonly k: "pipe"; readonly a: NodeId; readonly b: NodeId }
  | { readonly k: "templateLiteral"; readonly pattern: string }
  | { readonly k: "host"; readonly inner: NodeId | null; readonly fn: number };

export interface MetadataBag {
  readonly description?: string;
  readonly format?: string;
  readonly minimum?: number | bigint;
  readonly maximum?: number | bigint;
  readonly exclusiveMinimum?: number | bigint;
  readonly exclusiveMaximum?: number | bigint;
  readonly pattern?: string;
  readonly [key: string]: unknown;
}

export interface RefinementContext {
  readonly value: unknown;
  readonly issues: $ZodRawIssue[];
  addIssue(issue: $ZodRawIssue | string): void;
}

export type HostOperation = "refine" | "superRefine" | "check" | "transform" | "preprocess" | "overwrite" | "codec_decode" | "codec_encode";
export type HostFunction = (value: unknown, context: RefinementContext) => MaybeAsync<unknown>;
export type DynamicValue = (context?: { readonly error?: unknown; readonly input: unknown }) => unknown;

export type HostRuntimeCheck = { readonly c: "host_runtime"; readonly op: HostOperation; readonly fn: HostFunction };
export type PropertyBuildCheck = { readonly c: "property"; readonly key: string; readonly schema: SchemaNode };
export type WireCheck = Exclude<Check, { readonly c: "property" } | { readonly c: "host" }>;

export interface RuntimeCheck {
  readonly check: WireCheck | PropertyBuildCheck | HostRuntimeCheck;
  readonly error?: $ZodErrorMap | undefined;
  readonly abort?: boolean | undefined;
  readonly params?: Record<string, unknown> | undefined;
  readonly path?: PropertyKey[] | undefined;
  /** Gate: the check runs only when this returns true (bypasses abort short-circuit). */
  readonly when?: ((payload: { value: unknown; issues: $ZodRawIssue[] }) => boolean) | undefined;
  /** Side effect applied to the schema a `.check()` call produces (describe/meta). */
  readonly attach?: ((target: unknown) => void) | undefined;
}

export interface NodeCommon {
  readonly checks: readonly RuntimeCheck[];
  readonly error?: $ZodErrorMap | undefined;
  readonly bag: MetadataBag;
}

export interface PrimitiveNode extends NodeCommon {
  readonly kind: "string" | "number" | "bigint" | "boolean" | "date" | "file" | "null" | "undefined" | "any" | "unknown" | "never" | "void" | "symbol" | "nan" | "function";
  readonly coerce?: boolean;
  /** function schemas: argument tuple and return schemas for call wrapping. */
  readonly input?: SchemaNode;
  readonly output?: SchemaNode;
}
export interface LiteralNode extends NodeCommon { readonly kind: "literal"; readonly values: readonly Primitive[] }
export interface EnumNode extends NodeCommon { readonly kind: "enum"; readonly values: readonly (string | number)[] }
export interface ObjectNode extends NodeCommon {
  readonly kind: "object";
  readonly shape: Readonly<Record<string, SchemaNode>>;
  readonly mode: ObjectMode;
  readonly catchall: SchemaNode | null;
}
export interface ArrayNode extends NodeCommon { readonly kind: "array"; readonly element: SchemaNode }
export interface TupleNode extends NodeCommon { readonly kind: "tuple"; readonly items: readonly SchemaNode[]; readonly rest: SchemaNode | null }
export interface UnionNode extends NodeCommon { readonly kind: "union"; readonly options: readonly SchemaNode[]; readonly inclusive?: false }
export interface DiscriminatedUnionNode extends NodeCommon {
  readonly kind: "discunion";
  readonly key: string;
  readonly options: readonly SchemaNode[];
  readonly map: ReadonlyMap<Primitive, SchemaNode>;
  readonly unionFallback?: boolean;
  /** Option index lacking discriminator values; parse must throw when set. */
  readonly invalidOptionIndex?: number;
}
export interface IntersectionNode extends NodeCommon { readonly kind: "intersection"; readonly left: SchemaNode; readonly right: SchemaNode }
export interface RecordNode extends NodeCommon {
  readonly kind: "record";
  readonly key: SchemaNode;
  readonly value: SchemaNode;
  /** "strict" errors on non-matching keys; "loose" passes them through unchanged. */
  readonly mode?: "strict" | "loose";
  /** partialRecord: keys are partial (Record value becomes Partial). Runtime-neutral marker. */
  readonly partial?: boolean;
}
export interface MapNode extends NodeCommon { readonly kind: "map"; readonly key: SchemaNode; readonly value: SchemaNode }
export interface SetNode extends NodeCommon { readonly kind: "set"; readonly value: SchemaNode }
export interface WrapperNode extends NodeCommon {
  readonly kind: "optional" | "exactOptional" | "nullable" | "nonoptional" | "readonly" | "promise";
  readonly inner: SchemaNode;
}
export interface LazyNode extends NodeCommon { readonly kind: "lazy"; readonly getter: () => SchemaNode }
export interface FallbackNode extends NodeCommon {
  readonly kind: "default" | "prefault" | "catch";
  readonly inner: SchemaNode;
  readonly value: unknown | DynamicValue;
  readonly dynamic: boolean;
}
export interface PipeNode extends NodeCommon { readonly kind: "pipe"; readonly a: SchemaNode; readonly b: SchemaNode; readonly codec?: boolean; readonly encodeHost?: HostFunction }
export interface TemplateLiteralNode extends NodeCommon { readonly kind: "templateLiteral"; readonly pattern: RegExp }
export interface HostNode extends NodeCommon { readonly kind: "host"; readonly inner: SchemaNode | null; readonly fn: HostFunction; readonly op: HostOperation }

export type SchemaNode =
  | PrimitiveNode | LiteralNode | EnumNode | ObjectNode | ArrayNode | TupleNode | UnionNode | DiscriminatedUnionNode
  | IntersectionNode | RecordNode | MapNode | SetNode | WrapperNode | LazyNode | FallbackNode | PipeNode
  | TemplateLiteralNode | HostNode;

export type NodeInput = Omit<PrimitiveNode, keyof NodeCommon> | Omit<LiteralNode, keyof NodeCommon>
  | Omit<EnumNode, keyof NodeCommon> | Omit<ObjectNode, keyof NodeCommon> | Omit<ArrayNode, keyof NodeCommon>
  | Omit<TupleNode, keyof NodeCommon> | Omit<UnionNode, keyof NodeCommon> | Omit<DiscriminatedUnionNode, keyof NodeCommon>
  | Omit<IntersectionNode, keyof NodeCommon> | Omit<RecordNode, keyof NodeCommon> | Omit<MapNode, keyof NodeCommon>
  | Omit<SetNode, keyof NodeCommon> | Omit<WrapperNode, keyof NodeCommon> | Omit<LazyNode, keyof NodeCommon>
  | Omit<FallbackNode, keyof NodeCommon> | Omit<PipeNode, keyof NodeCommon> | Omit<TemplateLiteralNode, keyof NodeCommon>
  | Omit<HostNode, keyof NodeCommon>;

/** Construct a fresh node. Node object identity is the graph identity. */
export function node<T extends NodeInput>(input: T, common?: Partial<NodeCommon>): T & NodeCommon {
  return {
    ...input,
    checks: common?.checks ?? [],
    error: common?.error,
    bag: common?.bag ?? {},
  };
}

export function cloneNode<T extends SchemaNode>(source: T, patch: Partial<T> = {}): T {
  return { ...source, ...patch };
}
