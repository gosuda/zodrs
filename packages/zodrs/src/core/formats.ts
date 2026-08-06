import type { FormatId } from "./nodes.js";
import { escapeRegex } from "./util.js";

// URL is a WHATWG global on Node, browsers, and wasip1; typed locally since the build lib excludes DOM/Node types.
declare const URL: { new (input: string): { readonly protocol: string } };

const PATTERNS: Readonly<Record<string, RegExp>> = {
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
  email: /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/,
  html5Email: /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  rfc5322Email: /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  unicodeEmail: /^[^\s@"]{1,64}@[^\s@]{1,255}$/u,
  emoji: /^(\p{Extended_Pictographic}|\p{Emoji_Component})+$/u,
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
  ipv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/,
  cidrv4: /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/,
  cidrv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
  base64: /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/,
  base64url: /^[A-Za-z0-9_-]*$/,
  hostname: /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/,
  e164: /^\+[1-9]\d{6,14}$/,
  lowercase: /^[^A-Z]*$/,
  uppercase: /^[^a-z]*$/,
  hex: /^[0-9a-fA-F]*$/,
};

const DATE = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$/;

function timeSource(params: Readonly<Record<string, unknown>>): string {
  const precision = typeof params["precision"] === "number" ? params["precision"] : null;
  const hhmm = "(?:[01]\\d|2[0-3]):[0-5]\\d";
  if (typeof precision === "number") {
    if (precision === -1) return hhmm;
    if (precision === 0) return `${hhmm}:[0-5]\\d`;
    return `${hhmm}:[0-5]\\d\\.\\d{${precision}}`;
  }
  return `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}

function hashPattern(format: string, encoding: string): RegExp | undefined {
  const lengths: Readonly<Record<string, readonly [number, number, string]>> = {
    md5: [32, 22, "=="], sha1: [40, 27, "="], sha256: [64, 43, "="], sha384: [96, 64, ""], sha512: [128, 86, "=="],
  };
  const entry = lengths[format];
  if (!entry) return undefined;
  const [hex, b64, padding] = entry;
  if (encoding === "hex") return new RegExp(`^[0-9a-fA-F]{${hex}}$`);
  if (encoding === "base64url") return new RegExp(`^[A-Za-z0-9_-]{${b64}}$`);
  return new RegExp(`^[A-Za-z0-9+/]{${b64}}${escapeRegex(padding)}$`);
}

export function testFormat(format: FormatId, input: string, params: Readonly<Record<string, unknown>> = {}): boolean {
  if (format === "url" || format === "httpUrl") {
    try {
      const parsed = new URL(input);
      return format === "url" || parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  if (format === "jwt") return input.split(".").length === 3;
  if (format === "date") return DATE.test(input);
  if (format === "time") {
    return new RegExp(`^${timeSource(params)}$`).test(input);
  }
  if (format === "datetime") {
    const [date, time] = input.split("T");
    if (!date || !time || !DATE.test(date)) return false;
    const opts = ["Z"];
    if (params["local"] === true) opts.push("");
    if (params["offset"] === true) opts.push("(?:[+-](?:[01]\\d|2[0-3]):[0-5]\\d)");
    return new RegExp(`^${timeSource(params)}(?:${opts.join("|")})$`).test(time);
  }
  if (format === "mac") {
    const delimiter = typeof params["delimiter"] === "string" ? params["delimiter"] : ":";
    return new RegExp(`^(?:[0-9A-F]{2}${escapeRegex(delimiter)}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${escapeRegex(delimiter)}){5}[0-9a-f]{2}$`).test(input);
  }
  if (format === "md5" || format === "sha1" || format === "sha256" || format === "sha384" || format === "sha512") {
    const encoding = typeof params["enc"] === "string" ? params["enc"] : "hex";
    return hashPattern(format, encoding)?.test(input) ?? false;
  }
  return PATTERNS[format]?.test(input) ?? false;
}
