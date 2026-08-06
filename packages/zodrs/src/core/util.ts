/** Shared internal helpers for the zodrs core. No public surface. */

export type Primitive = string | number | symbol | bigint | boolean | null | undefined;

export type JSONType = string | number | boolean | null | JSONType[] | { [key: string]: JSONType };

export type MaybeAsync<T> = T | Promise<T>;

/** A stable, module-level sentinel returned by validators on failure. */
export const FAIL: unique symbol = Symbol.for("zodrs.fail");
export type FAIL = typeof FAIL;

/** Runtime type label matching Zod's `parsedType`. */
export function parsedType(data: unknown): string {
  switch (typeof data) {
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "object": {
      if (data === null) return "null";
      if (Array.isArray(data)) return "array";
      const proto: unknown = Object.getPrototypeOf(data);
      if (proto !== Object.prototype && proto !== null && "constructor" in data) {
        const ctor: unknown = data.constructor;
        if (typeof ctor === "function" && ctor.name) return ctor.name;
      }
      return "object";
    }
    default:
      return typeof data;
  }
}

export function stringifyPrimitive(value: Primitive): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return `"${value}"`;
  return `${String(value)}`;
}

export function joinValues(array: readonly Primitive[], separator = "|"): string {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}

export function jsonStringifyReplacer(_: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

type CaptureStackTrace = (targetObject: object, constructorOpt?: abstract new (...args: never[]) => unknown) => void;
export const captureStackTrace: CaptureStackTrace =
  "captureStackTrace" in Error
    ? (Error.captureStackTrace as CaptureStackTrace)
    : () => {
        /* no-op on runtimes without Error.captureStackTrace */
      };

export function isObject(data: unknown): data is Record<PropertyKey, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

export function isPlainObject(data: unknown): data is Record<string, unknown> {
  if (!isObject(data)) return false;
  const proto: unknown = Object.getPrototypeOf(data);
  return proto === Object.prototype || proto === null;
}

/** Lazily-computed, memoized getter. */
export function cached<T>(getter: () => T): { readonly value: T } {
  let computed = false;
  let value: T | undefined;
  return {
    get value(): T {
      if (!computed) {
        value = getter();
        computed = true;
      }
      // computed is true here, so value has type T at runtime.
      return value as T;
    },
  };
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Flatten<T> = T extends unknown ? { [K in keyof T]: T[K] } : never;
export type NoUndefined<T> = T extends undefined ? never : T;
export type Identity<T> = T;
export type AnyFunc = (...args: never[]) => unknown;
