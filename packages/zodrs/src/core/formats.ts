import type { FormatId } from "./nodes.js";
import { escapeRegex } from "./util.js";

// URL/atob are WHATWG globals on Node, browsers, and wasip1; typed locally since the build lib excludes DOM/Node types.
declare const URL: {
  new (input: string): { readonly protocol: string; readonly hostname: string; readonly href: string };
};
declare const atob: (data: string) => string;

export const PATTERNS: Readonly<Record<string, RegExp>> = {
  cuid: /^[cC][0-9a-z]{6,}$/,
  cuid2: /^[0-9a-z]+$/,
  ulid: /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/,
  xid: /^[0-9a-vA-V]{20}$/,
  ksuid: /^[A-Za-z0-9]{27}$/,
  nanoid: /^[a-zA-Z0-9_-]{21}$/,
  duration: /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/,
  extendedDuration: /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/,
  guid: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  uuid: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
  uuidv4: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/,
  uuidv6: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-6[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/,
  uuidv7: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/,
  // Preserve escapes because RegExp.source is observable Zod output.
  // oxlint-disable-next-line eslint/no-useless-escape
  email: /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/,
  html5Email: /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  rfc5322Email: /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  unicodeEmail: /^[^\s@"]{1,64}@[^\s@]{1,255}$/u,
  emoji: /^(\p{Extended_Pictographic}|\p{Emoji_Component})+$/u,
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
  ipv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/,
  cidrv4: /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/,
  cidrv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
  base64: /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/,
  base64url: /^[A-Za-z0-9_-]*$/,
  hostname: /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/,
  domain: /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
  httpProtocol: /^https?$/,
  e164: /^\+[1-9]\d{6,14}$/,
  lowercase: /^[^A-Z]*$/,
  uppercase: /^[^a-z]*$/,
  hex: /^[0-9a-fA-F]*$/,
};

/** Unanchored date source — also the JSON Schema `pattern` atom. */
export const DATE_SOURCE =
  "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";

const DATE = new RegExp(`^${DATE_SOURCE}$`);

/** Time-of-day pattern source for a `precision` parameter value. */
export function timeSource(precision: unknown): string {
  const hhmm = "(?:[01]\\d|2[0-3]):[0-5]\\d";
  if (typeof precision === "number") {
    if (precision === -1) return hhmm;
    if (precision === 0) return `${hhmm}:[0-5]\\d`;
    return `${hhmm}:[0-5]\\d\\.\\d{${precision}}`;
  }
  return `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}

/** Anchored datetime pattern source honoring local/offset/precision params. */
export function datetimePattern(params: Readonly<Record<string, unknown>>): string {
  const opts = ["Z"];
  if (params["local"] === true) opts.push("");
  if (params["offset"] === true) opts.push("([+-](?:[01]\\d|2[0-3]):[0-5]\\d)");
  return `^${DATE_SOURCE}T(?:${timeSource(params["precision"])}(?:${opts.join("|")}))$`;
}

/** [hex length, base64 length, padding] per hash format. */
export const HASH_LENGTHS: Readonly<Record<string, readonly [number, number, string]>> = {
  md5: [32, 22, "=="], sha1: [40, 27, "="], sha256: [64, 43, "="], sha384: [96, 64, ""], sha512: [128, 86, "=="],
};

/** Anchored pattern source for a hash format in a given encoding, or undefined for non-hash formats. */
export function hashFormatPattern(format: string, encoding: string): string | undefined {
  const entry = HASH_LENGTHS[format];
  if (!entry) return undefined;
  const [hex, b64, padding] = entry;
  if (encoding === "hex") return `^[0-9a-fA-F]{${hex}}$`;
  if (encoding === "base64url") return `^[A-Za-z0-9_-]{${b64}}$`;
  return `^[A-Za-z0-9+/]{${b64}}${escapeRegex(padding)}$`;
}

/** Anchored pattern source for a MAC address with the given delimiter. */
export function macPattern(delimiter: string): string {
  const d = escapeRegex(delimiter);
  return `^(?:[0-9A-F]{2}${d}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${d}){5}[0-9a-f]{2}$`;
}

// Parameterized formats build regexes per (format, params) pair. `testFormat`
// can run once per parsed element, so compiled patterns are memoized — keyed
// on the params that shape the pattern, not the whole wire params (an `error`
// message must not mint a new entry), and bounded so schema churn cannot grow
// the module-global table without limit.
const dynamicCache = new Map<string, RegExp | undefined>();
const DYNAMIC_CACHE_LIMIT = 512;

function dynamicKey(format: FormatId, params: Readonly<Record<string, unknown>>): string {
  switch (format) {
    case "time":
      return `time ${params["precision"]}`;
    case "datetime":
      return `datetime ${params["precision"]} ${params["local"]} ${params["offset"]}`;
    case "mac":
      return `mac ${params["delimiter"]}`;
    default:
      return `${format} ${params["enc"]}`;
  }
}

function dynamicPattern(format: FormatId, params: Readonly<Record<string, unknown>>): RegExp | undefined {
  switch (format) {
    case "time":
      return new RegExp(`^${timeSource(params["precision"])}$`);
    case "datetime":
      return new RegExp(datetimePattern(params));
    case "mac": {
      const delimiter = typeof params["delimiter"] === "string" ? params["delimiter"] : ":";
      return new RegExp(macPattern(delimiter));
    }
    case "md5":
    case "sha1":
    case "sha256":
    case "sha384":
    case "sha512": {
      const encoding = typeof params["enc"] === "string" ? params["enc"] : "hex";
      const source = hashFormatPattern(format, encoding);
      return source === undefined ? undefined : new RegExp(source);
    }
    default:
      return undefined;
  }
}

function cachedPattern(format: FormatId, params: Readonly<Record<string, unknown>>): RegExp | undefined {
  const key = dynamicKey(format, params);
  if (dynamicCache.has(key)) return dynamicCache.get(key);
  const re = dynamicPattern(format, params);
  if (dynamicCache.size < DYNAMIC_CACHE_LIMIT) dynamicCache.set(key, re);
  return re;
}

function isValidBase64(data: string): boolean {
  if (data === "") return true;
  // atob ignores whitespace, so reject it up front.
  if (/\s/.test(data)) return false;
  if (data.length % 4 !== 0) return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}

function isValidBase64URL(data: string): boolean {
  if (!PATTERNS["base64url"]?.test(data)) return false;
  const base64 = data.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/"));
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}

function isValidJWT(token: string, algorithm: string | null = null): boolean {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3) return false;
    const [header] = tokensParts;
    if (!header) return false;
    const parsedHeader: unknown = JSON.parse(atob(header));
    if (typeof parsedHeader !== "object" || parsedHeader === null) return false;
    if ("typ" in parsedHeader && (parsedHeader as Record<string, unknown>)["typ"] !== "JWT") return false;
    if (!(parsedHeader as Record<string, unknown>)["alg"]) return false;
    if (algorithm && (!("alg" in parsedHeader) || (parsedHeader as Record<string, unknown>)["alg"] !== algorithm)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface UrlVerdict {
  readonly ok: boolean;
  readonly value: string;
  readonly note?: string;
  readonly pattern?: string;
}

/** Zod v4.4 `$ZodURL` semantics: trims, validates via WHATWG URL, optional
 * protocol/hostname constraints, rewrites to trimmed or normalized href. */
export function checkUrl(input: string, params: Readonly<Record<string, unknown>> = {}, httpOnly = false): UrlVerdict {
  const normalize = params["normalize"] === true;
  const asRegExp = (value: unknown): RegExp | undefined => {
    if (value instanceof RegExp) return value;
    if (typeof value === "string") return new RegExp(value);
    return undefined;
  };
  const protocol = httpOnly ? /^https?$/ : asRegExp(params["protocol"]);
  const hostname = asRegExp(params["hostname"]);
  const trimmed = input.trim();

  // When normalize is off, require :// for http/https URLs
  if (!normalize && protocol?.source === "^https?$") {
    if (!/^https?:\/\//i.test(trimmed)) {
      return { ok: false, value: trimmed, note: "Invalid URL format" };
    }
  }

  let url: InstanceType<typeof URL>;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, value: trimmed };
  }

  let ok = true;
  let note: string | undefined;
  let pattern: string | undefined;
  if (hostname) {
    hostname.lastIndex = 0;
    if (!hostname.test(url.hostname)) {
      ok = false;
      note = "Invalid hostname";
      pattern = hostname.source;
    }
  }

  if (protocol) {
    protocol.lastIndex = 0;
    const candidate = url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol;
    if (!protocol.test(candidate)) {
      ok = false;
      if (note === undefined) {
        note = "Invalid protocol";
        pattern = protocol.source;
      }
    }
  }

  if (!ok) return { ok: false, value: trimmed, ...(note ? { note } : {}), ...(pattern ? { pattern } : {}) };
  return { ok: true, value: normalize ? url.href : trimmed };
}

export function testFormat(format: FormatId, input: string, params: Readonly<Record<string, unknown>> = {}): boolean {
  if (format === "url" || format === "httpUrl") {
    return checkUrl(input, params, format === "httpUrl").ok;
  }
  if (format === "jwt") {
    const alg = typeof params["alg"] === "string" ? params["alg"] : null;
    return isValidJWT(input, alg);
  }
  if (format === "base64") return isValidBase64(input);
  if (format === "base64url") return isValidBase64URL(input);
  if (format === "ipv6") {
    try {
      new URL(`http://[${input}]`);
      return true;
    } catch {
      return false;
    }
  }
  if (format === "date") return DATE.test(input);
  if (
    format === "time"
    || format === "datetime"
    || format === "mac"
    || format === "md5"
    || format === "sha1"
    || format === "sha256"
    || format === "sha384"
    || format === "sha512"
  ) {
    return cachedPattern(format, params)?.test(input) ?? false;
  }
  return PATTERNS[format]?.test(input) ?? false;
}

/** The regex a format check contributes to the schema's `_zod.pattern` bag,
 * or undefined for formats validated procedurally (url, jwt, base64* still
 * contribute their shape regex, matching Zod's `def.pattern ??=`). */
export function patternForFormat(format: FormatId, params: Readonly<Record<string, unknown>> = {}): RegExp | undefined {
  switch (format) {
    case "url":
    case "httpUrl":
    case "jwt":
      return undefined;
    case "base64":
      return PATTERNS["base64"];
    case "base64url":
      return PATTERNS["base64url"];
    case "date":
      return DATE;
    // Exposed `pattern` values get a fresh RegExp per schema: the memoized
    // instances serve the internal testFormat hot path only, so a consumer
    // mutating one schema's pattern cannot leak state into another's.
    case "time":
    case "datetime":
    case "mac":
    case "md5":
    case "sha1":
    case "sha256":
    case "sha384":
    case "sha512":
      return dynamicPattern(format, params);
    default:
      return PATTERNS[format];
  }
}

/** Zod's exported `regexes` table (classic surface mirrors these names). */
export const REGEXES: Readonly<Record<string, RegExp>> = {
  ...PATTERNS,
  uuid4: PATTERNS["uuidv4"] as RegExp,
  uuid6: PATTERNS["uuidv6"] as RegExp,
  uuid7: PATTERNS["uuidv7"] as RegExp,
};
