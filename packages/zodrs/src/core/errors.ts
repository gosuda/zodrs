import type { $ZodConfig } from "./config.js";
import { config } from "./config.js";
import { flattenError, formatError } from "./error-utils.js";
import type { $ZodFlattenedError, $ZodFormattedError } from "./error-utils.js";
import { captureStackTrace, joinValues, jsonStringifyReplacer, parsedType, stringifyPrimitive } from "./util.js";
import type { Primitive } from "./util.js";

export interface $ZodIssueBase {
  readonly code?: string;
  readonly input?: unknown;
  readonly path: PropertyKey[];
  readonly message: string;
}

export type $ZodInvalidTypeExpected =
  | "string"
  | "number"
  | "int"
  | "boolean"
  | "bigint"
  | "symbol"
  | "undefined"
  | "null"
  | "never"
  | "void"
  | "date"
  | "array"
  | "object"
  | "tuple"
  | "record"
  | "map"
  | "set"
  | "file"
  | "nonoptional"
  | "nan"
  | "function"
  | (string & {});

export interface $ZodIssueInvalidType<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_type";
  readonly expected: $ZodInvalidTypeExpected;
  readonly input?: Input;
}

export interface $ZodIssueTooBig<Input = unknown> extends $ZodIssueBase {
  readonly code: "too_big";
  readonly origin: "number" | "int" | "bigint" | "date" | "string" | "array" | "set" | "file" | (string & {});
  readonly maximum: number | bigint;
  readonly inclusive?: boolean;
  readonly exact?: boolean;
  readonly input?: Input;
}

export interface $ZodIssueTooSmall<Input = unknown> extends $ZodIssueBase {
  readonly code: "too_small";
  readonly origin: "number" | "int" | "bigint" | "date" | "string" | "array" | "set" | "file" | (string & {});
  readonly minimum: number | bigint;
  readonly inclusive?: boolean;
  readonly exact?: boolean;
  readonly input?: Input;
}

export type $ZodStringFormats =
  | "email" | "url" | "emoji" | "uuid" | "guid" | "nanoid" | "cuid" | "cuid2" | "ulid" | "xid" | "ksuid"
  | "datetime" | "date" | "time" | "duration" | "ipv4" | "ipv6" | "cidrv4" | "cidrv6" | "base64" | "base64url"
  | "json_string" | "e164" | "lowercase" | "uppercase" | "regex" | "jwt" | "starts_with" | "ends_with" | "includes";

export interface $ZodIssueInvalidStringFormat extends $ZodIssueBase {
  readonly code: "invalid_format";
  readonly format: $ZodStringFormats | (string & {});
  readonly pattern?: string;
  readonly origin?: string;
  readonly input?: string;
}

export interface $ZodIssueNotMultipleOf<Input extends number | bigint = number | bigint> extends $ZodIssueBase {
  readonly code: "not_multiple_of";
  readonly divisor: number;
  readonly origin?: string;
  readonly input?: Input;
}

export interface $ZodIssueUnrecognizedKeys extends $ZodIssueBase {
  readonly code: "unrecognized_keys";
  readonly keys: string[];
  readonly input?: Record<string, unknown>;
}

interface $ZodIssueInvalidUnionNoMatch extends $ZodIssueBase {
  readonly code: "invalid_union";
  readonly errors: $ZodIssue[][];
  readonly input?: unknown;
  readonly discriminator?: string | undefined;
  readonly options?: Primitive[];
  readonly inclusive?: true;
}

interface $ZodIssueInvalidUnionMultipleMatch extends $ZodIssueBase {
  readonly code: "invalid_union";
  readonly errors: [];
  readonly input?: unknown;
  readonly discriminator?: string | undefined;
  readonly inclusive: false;
}

export type $ZodIssueInvalidUnion = $ZodIssueInvalidUnionNoMatch | $ZodIssueInvalidUnionMultipleMatch;

export interface $ZodIssueInvalidKey<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_key";
  readonly origin: "map" | "record";
  readonly issues: $ZodIssue[];
  readonly input?: Input;
}

export interface $ZodIssueInvalidElement<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_element";
  readonly origin: "map" | "set";
  readonly key: unknown;
  readonly issues: $ZodIssue[];
  readonly input?: Input;
}

export interface $ZodIssueInvalidValue<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_value";
  readonly values: Primitive[];
  readonly input?: Input;
}

export interface $ZodIssueCustom extends $ZodIssueBase {
  readonly code: "custom";
  readonly params?: Record<string, unknown> | undefined;
  readonly input?: unknown;
}

export interface $ZodIssueStringCommonFormats extends $ZodIssueInvalidStringFormat {
  readonly format: Exclude<$ZodStringFormats, "regex" | "jwt" | "starts_with" | "ends_with" | "includes">;
}
export interface $ZodIssueStringInvalidRegex extends $ZodIssueInvalidStringFormat {
  readonly format: "regex";
  readonly pattern: string;
}
export interface $ZodIssueStringInvalidJWT extends $ZodIssueInvalidStringFormat {
  readonly format: "jwt";
  readonly algorithm?: string;
}
export interface $ZodIssueStringStartsWith extends $ZodIssueInvalidStringFormat {
  readonly format: "starts_with";
  readonly prefix: string;
}
export interface $ZodIssueStringEndsWith extends $ZodIssueInvalidStringFormat {
  readonly format: "ends_with";
  readonly suffix: string;
}
export interface $ZodIssueStringIncludes extends $ZodIssueInvalidStringFormat {
  readonly format: "includes";
  readonly includes: string;
}
export type $ZodStringFormatIssues =
  | $ZodIssueStringCommonFormats
  | $ZodIssueStringInvalidRegex
  | $ZodIssueStringInvalidJWT
  | $ZodIssueStringStartsWith
  | $ZodIssueStringEndsWith
  | $ZodIssueStringIncludes;

export type $ZodIssue =
  | $ZodIssueInvalidType
  | $ZodIssueTooBig
  | $ZodIssueTooSmall
  | $ZodIssueInvalidStringFormat
  | $ZodIssueNotMultipleOf
  | $ZodIssueUnrecognizedKeys
  | $ZodIssueInvalidUnion
  | $ZodIssueInvalidKey
  | $ZodIssueInvalidElement
  | $ZodIssueInvalidValue
  | $ZodIssueCustom;

export type $ZodIssueCode = $ZodIssue["code"];

export interface $ZodErrorMap<T extends $ZodIssueBase = $ZodIssue> {
  (issue: $ZodRawIssue<T>): { message: string } | string | undefined | null;
}

export interface ErrorSource {
  readonly error?: $ZodErrorMap | undefined;
}

type RawIssue<T extends $ZodIssueBase> = Omit<T, "message" | "path"> & {
  readonly message?: string;
  readonly path?: PropertyKey[];
  readonly input: unknown;
  readonly inst?: ErrorSource;
  readonly continue?: boolean | undefined;
} & Record<string, unknown>;
export type $ZodRawIssue<T extends $ZodIssueBase = $ZodIssue> = T extends unknown ? RawIssue<T> : never;

export interface ParseContext<T extends $ZodIssueBase = $ZodIssue> {
  readonly error?: $ZodErrorMap<T> | undefined;
  readonly reportInput?: boolean | undefined;
}

export interface $ZodError<T = unknown> extends Error {
  readonly type: T;
  readonly issues: $ZodIssue[];
  readonly _zod: { readonly output: T; readonly def: $ZodIssue[] };
  readonly isEmpty: boolean;
}

export class ZodError<T = unknown> extends Error implements $ZodError<T> {
  declare readonly type: T;
  readonly issues: $ZodIssue[];
  readonly _zod: { readonly output: T; readonly def: $ZodIssue[] };

  constructor(issues: $ZodIssue[] = []) {
    super(JSON.stringify(issues, jsonStringifyReplacer, 2));
    this.name = "ZodError";
    this.issues = issues;
    this._zod = { output: undefined as T, def: issues };
    captureStackTrace(this, ZodError);
  }

  get isEmpty(): boolean {
    return this.issues.length === 0;
  }

  addIssue(issue: $ZodIssue): void {
    this.issues.push(issue);
    this.message = JSON.stringify(this.issues, jsonStringifyReplacer, 2);
  }

  addIssues(issues: $ZodIssue[]): void {
    this.issues.push(...issues);
    this.message = JSON.stringify(this.issues, jsonStringifyReplacer, 2);
  }

  format(): $ZodFormattedError<T>;
  format<U>(mapper: (issue: $ZodIssue) => U): $ZodFormattedError<T, U>;
  format<U>(mapper?: (issue: $ZodIssue) => U): $ZodFormattedError<T, U> {
    return formatError(this, mapper as (issue: $ZodIssue) => U);
  }

  flatten(): $ZodFlattenedError<T>;
  flatten<U>(mapper: (issue: $ZodIssue) => U): $ZodFlattenedError<T, U>;
  flatten<U>(mapper?: (issue: $ZodIssue) => U): $ZodFlattenedError<T, U> {
    return flattenError(this, mapper as (issue: $ZodIssue) => U);
  }

  override toString(): string {
    return this.message;
  }
}

// `$ZodError` (the core class value), `$ZodRealError`, and `ZodRealError` are all
// the one `ZodError` class; the aliases mirror Zod's export surface for instanceof.
export const $ZodError: typeof ZodError = ZodError;
export const $ZodRealError: typeof ZodError = ZodError;
export const ZodRealError: typeof ZodError = ZodError;

function unwrapMessage(value: string | { message: string } | undefined | null): string | undefined {
  return typeof value === "string" ? value : value?.message;
}

const SIZABLE: Readonly<Record<string, { readonly unit: string }>> = {
  string: { unit: "characters" },
  file: { unit: "bytes" },
  array: { unit: "items" },
  set: { unit: "items" },
  map: { unit: "entries" },
};

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  regex: "input", email: "email address", url: "URL", http_url: "URL", hostname: "hostname", emoji: "emoji",
  uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", uuidv7: "UUIDv7", nanoid: "nanoid", guid: "GUID",
  cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datetime",
  date: "ISO date", time: "ISO time", duration: "ISO duration", ipv4: "IPv4 address", ipv6: "IPv6 address",
  mac: "MAC address", cidrv4: "IPv4 range", cidrv6: "IPv6 range", base64: "base64-encoded string",
  base64url: "base64url-encoded string", json_string: "JSON string", e164: "E.164 number", jwt: "JWT",
  template_literal: "input", hex: "hexadecimal string", md5: "MD5 hash", sha1: "SHA-1 hash", sha256: "SHA-256 hash",
  sha384: "SHA-384 hash", sha512: "SHA-512 hash",
};

/** Built-in English fallback, byte-for-byte compatible with Zod v4.4.3's English locale. */
export const defaultError: $ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type": {
      const expected = issue.expected === "nan" ? "NaN" : issue.expected;
      const receivedType = parsedType(issue.input);
      const received = receivedType === "nan" ? "NaN" : receivedType;
      return `Invalid input: expected ${expected}, received ${received}`;
    }
    case "invalid_value":
      return issue.values.length === 1
        ? `Invalid input: expected ${stringifyPrimitive(issue.values[0] ?? undefined)}`
        : `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
    case "too_big": {
      const adj = issue.inclusive ? "<=" : "<";
      const sizing = SIZABLE[issue.origin];
      return sizing
        ? `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit}`
        : `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
    }
    case "too_small": {
      const adj = issue.inclusive ? ">=" : ">";
      const sizing = SIZABLE[issue.origin];
      return sizing
        ? `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`
        : `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
    }
    case "invalid_format": {
      if (issue.format === "starts_with" && "prefix" in issue) return `Invalid string: must start with "${issue["prefix"]}"`;
      if (issue.format === "ends_with" && "suffix" in issue) return `Invalid string: must end with "${issue["suffix"]}"`;
      if (issue.format === "includes" && "includes" in issue) return `Invalid string: must include "${issue["includes"]}"`;
      if (issue.format === "regex") return `Invalid string: must match pattern ${issue.pattern ?? ""}`;
      return `Invalid ${FORMAT_NAMES[issue.format] ?? issue.format}`;
    }
    case "not_multiple_of":
      return `Invalid number: must be a multiple of ${issue.divisor}`;
    case "unrecognized_keys":
      return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
    case "invalid_key":
      return `Invalid key in ${issue.origin}`;
    case "invalid_union": {
      const options: unknown = issue.options;
      return Array.isArray(options) && options.length > 0
        ? `Invalid discriminator value. Expected ${options.map((option: unknown) => `'${String(option)}'`).join(" | ")}`
        : "Invalid input";
    }
    case "invalid_element":
      return `Invalid value in ${issue.origin}`;
    case "custom":
      return "Invalid input";
  }
};

export function finalizeIssue(
  issue: $ZodRawIssue,
  context: ParseContext | undefined,
  global: $ZodConfig,
): $ZodIssue {
  const message = issue.message
    ?? unwrapMessage(issue.inst?.error?.(issue))
    ?? unwrapMessage(context?.error?.(issue))
    ?? unwrapMessage(global.customError?.(issue))
    ?? unwrapMessage(global.localeError?.(issue))
    ?? "Invalid input";
  const { inst: _inst, continue: _continue, input, ...rest } = issue;
  const finalized = { ...rest, path: rest.path ?? [], message };
  return (context?.reportInput ? { ...finalized, input } : finalized) as $ZodIssue;
}

/** Finalize a raw issue tree: nested union branch errors and key/element
 *  sub-issues are finalized recursively before the parent. */
export function finalizeNested(raw: $ZodRawIssue, context: ParseContext | undefined): $ZodIssue {
  const global = config();
  if (raw.code === "invalid_union" && Array.isArray(raw.errors)) {
    const errors = raw.errors.map((branch: unknown) => Array.isArray(branch)
      ? branch.map((entry: unknown) => finalizeNested(entry as $ZodRawIssue, context))
      : []);
    return finalizeIssue({ ...raw, errors } as $ZodRawIssue, context, global);
  }
  if ((raw.code === "invalid_key" || raw.code === "invalid_element") && Array.isArray(raw.issues)) {
    const issues = raw.issues.map((entry: unknown) => finalizeNested(entry as $ZodRawIssue, context));
    return finalizeIssue({ ...raw, issues } as $ZodRawIssue, context, global);
  }
  return finalizeIssue(raw, context, global);
}
