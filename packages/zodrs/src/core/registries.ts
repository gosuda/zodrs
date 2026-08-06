/**
 * Metadata registries: a WeakMap-keyed store from schema object to per-schema
 * metadata, with an `id` secondary index for JSON Schema generation.
 */
export const $output: unique symbol = Symbol("zodrs.output");
export type $output = typeof $output;
export const $input: unique symbol = Symbol("zodrs.input");
export type $input = typeof $input;

type OutputOf<S> = S extends { readonly _zod: { readonly output: infer O } } ? O : unknown;
type InputOf<S> = S extends { readonly _zod: { readonly input: infer I } } ? I : unknown;

export type $replace<Meta, S> = Meta extends $output
  ? OutputOf<S>
  : Meta extends $input
    ? InputOf<S>
    : Meta extends (infer M)[]
      ? $replace<M, S>[]
      : Meta extends (...args: infer P) => infer R
        ? (...args: { [K in keyof P]: $replace<P[K], S> }) => $replace<R, S>
        : Meta extends object
          ? { [K in keyof Meta]: $replace<Meta[K], S> }
          : Meta;

/** Minimal structural shape a schema must have to carry registry metadata. */
export interface $ZodRegistrySchema {
  readonly _zod: {
    readonly output: unknown;
    readonly input: unknown;
    readonly parent?: $ZodRegistrySchema | undefined;
  };
}

type MetadataType = object | undefined;

type MetaArg<Meta, S extends $ZodRegistrySchema> = undefined extends Meta ? [$replace<Meta, S>?] : [$replace<Meta, S>];

export class $ZodRegistry<
  Meta extends MetadataType = MetadataType,
  Schema extends $ZodRegistrySchema = $ZodRegistrySchema,
> {
  declare _meta: Meta;
  declare _schema: Schema;
  _map: WeakMap<Schema, $replace<Meta, Schema>> = new WeakMap();
  _idmap: Map<string, Schema> = new Map();

  add<S extends Schema>(schema: S, ..._meta: MetaArg<Meta, S>): this {
    const meta = _meta[0] as $replace<Meta, Schema>;
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta && typeof meta["id"] === "string") this._idmap.set(meta["id"], schema);
    return this;
  }

  clear(): this {
    this._map = new WeakMap();
    this._idmap = new Map();
    return this;
  }

  remove(schema: Schema): this {
    const meta: unknown = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta && typeof meta["id"] === "string") this._idmap.delete(meta["id"]);
    this._map.delete(schema);
    return this;
  }

  get<S extends Schema>(schema: S): $replace<Meta, S> | undefined {
    // Child schemas inherit their parent's metadata, except `id`.
    const parent = schema._zod.parent;
    if (parent) {
      const inherited: Record<string, unknown> = { ...((this.get(parent as Schema) ?? {}) as Record<string, unknown>) };
      delete inherited["id"];
      const own = this._map.get(schema);
      const merged: Record<string, unknown> = { ...inherited, ...(own as Record<string, unknown> | undefined) };
      if (Object.keys(merged).length === 0) return undefined;
      return merged as $replace<Meta, S>;
    }
    return this._map.get(schema) as $replace<Meta, S> | undefined;
  }

  has(schema: Schema): boolean {
    return this._map.has(schema);
  }
}

export interface JSONSchemaMeta {
  id?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  deprecated?: boolean | undefined;
  [k: string]: unknown;
}

export interface GlobalMeta extends JSONSchemaMeta {}

export function registry<
  T extends MetadataType = MetadataType,
  S extends $ZodRegistrySchema = $ZodRegistrySchema,
>(): $ZodRegistry<T, S> {
  return new $ZodRegistry<T, S>();
}

interface GlobalThisWithRegistry {
  /**
   * Shared across CJS/ESM dual loads: attaching to `globalThis` keeps a single
   * deduplicated registry instance regardless of module format.
   */
  __zod_globalRegistry?: $ZodRegistry<GlobalMeta>;
}

(globalThis as GlobalThisWithRegistry).__zod_globalRegistry ??= registry<GlobalMeta>();
export const globalRegistry: $ZodRegistry<GlobalMeta> =
  (globalThis as GlobalThisWithRegistry).__zod_globalRegistry ?? registry<GlobalMeta>();
