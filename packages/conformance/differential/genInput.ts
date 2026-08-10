import type { Descriptor, Json } from "./descriptor.js";
import type { AnySchema } from "./descriptor.js";
import { EXTRA_KEYS, FORMAT_VALID, WEIRD_KEYS } from "./genSchema.js";
import { Rng } from "./prng.js";

export interface FuzzCase {
  /** Family tag, e.g. "valid", "mutate:drop-key", "dup-keys". */
  kind: string;
  bytes: Uint8Array;
  /** The decoded text the TS reference path parses (BOM stripped by TextDecoder). */
  text: string;
}

const encoder = new TextEncoder();

/** The exemplar pools keyed here must stay in sync with genSchema's REGEX_POOL. */
const REGEX_EXEMPLARS: Record<string, string[]> = {
  "^[a-z]+$": ["abc", "zzz", "q"],
  "^\\d{2,4}$": ["12", "123", "9999"],
  "^[A-Z][a-z]*$": ["Hello", "A", "Zzz"],
  "^x?y{1,3}$": ["y", "xyyy", "yy"],
};

/** Defines an own data property; plain assignment to "__proto__" hits the setter. */
function setOwn(target: Record<string, Json>, key: string, value: Json): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function genValidString(rng: Rng, checks: Extract<Descriptor, { k: "string" }>["checks"]): string {
  const format = checks.find((c) => c.c === "format");
  if (format && format.c === "format") return rng.pick(FORMAT_VALID[format.f]);
  const regex = checks.find((c) => c.c === "regex");
  if (regex && regex.c === "regex") return rng.pick(REGEX_EXEMPLARS[regex.src]);
  const prefix = checks.find((c) => c.c === "startsWith");
  const suffix = checks.find((c) => c.c === "endsWith");
  const infix = checks.find((c) => c.c === "includes");
  const upper = checks.some((c) => c.c === "uppercase" || c.c === "toUpperCase");
  const lower = checks.some((c) => c.c === "lowercase" || c.c === "toLowerCase");
  const min = checks.reduce((n, c) => (c.c === "min" || c.c === "length" ? Math.max(n, c.v) : n), 0);
  const required =
    (prefix && prefix.c === "startsWith" ? prefix.v.length : 0) +
    (suffix && suffix.c === "endsWith" ? suffix.v.length : 0) +
    (infix && infix.c === "includes" ? infix.v.length : 0);
  const target = Math.max(min, required, rng.int(0, 12));
  const alphabet = upper ? "ABCDEFGH" : lower ? "abcdefgh" : "abc XYZ123";
  const parts = [
    prefix && prefix.c === "startsWith" ? prefix.v : "",
    infix && infix.c === "includes" ? infix.v : "",
    suffix && suffix.c === "endsWith" ? suffix.v : "",
  ];
  let fill = "";
  while (parts.join("").length + fill.length < target) fill += alphabet[rng.next() % alphabet.length];
  let out = parts[0] + fill.slice(0, target - required) + parts[1] + parts[2];
  if (upper) out = out.toUpperCase();
  if (lower) out = out.toLowerCase();
  // Overwrite checks (trim/case) are exercised by occasionally dirtying the input.
  if (checks.some((c) => c.c === "trim") && rng.chance(0.6)) out = `  ${out}\t`;
  return out;
}

function genValidNumber(rng: Rng, checks: Extract<Descriptor, { k: "number" }>["checks"]): number {
  const isInt = checks.some((c) => c.c === "int");
  let lo = -1000;
  let hi = 1000;
  for (const c of checks) {
    if (c.c === "min") lo = Math.max(lo, c.v);
    if (c.c === "max") hi = Math.min(hi, c.v);
    if (c.c === "gt") lo = Math.max(lo, isInt ? c.v + 1 : c.v + 0.25);
    if (c.c === "lt") hi = Math.min(hi, isInt ? c.v - 1 : c.v - 0.25);
    if (c.c === "positive") lo = Math.max(lo, isInt ? 1 : 0.25);
    if (c.c === "negative") hi = Math.min(hi, isInt ? -1 : -0.25);
  }
  if (hi < lo) [lo, hi] = [0, 10];
  const mult = checks.find((c) => c.c === "multipleOf");
  if (mult && mult.c === "multipleOf") {
    const kLo = Math.ceil(lo / mult.v);
    const kHi = Math.floor(hi / mult.v);
    return (kLo > kHi ? Math.ceil(lo / mult.v) : rng.int(kLo, kHi)) * mult.v;
  }
  if (isInt) return rng.int(Math.ceil(lo), Math.floor(hi));
  return Math.round((lo + rng.float() * (hi - lo)) * 8) / 8;
}

function genJsonScalar(rng: Rng): Json {
  const roll = rng.int(0, 4);
  if (roll === 0) return null;
  if (roll === 1) return rng.chance(0.5);
  if (roll === 2) return rng.int(-500, 500);
  return rng.pick(["s", "t", "", "x y"]);
}

function genValidObject(
  rng: Rng,
  shape: [string, Descriptor][],
  mode: string,
  catchall: Descriptor | null,
): Json {
  const out: Record<string, Json> = {};
  for (const [key, child] of shape) {
    if ((child.k === "optional" || child.k === "exactOptional" || child.k === "default" || child.k === "prefault") && rng.chance(0.35)) continue;
    setOwn(out, key, genValid(rng, child));
  }
  if (catchall !== null && rng.chance(0.5)) {
    for (let i = 0, extras = rng.int(1, 2); i < extras; i++) setOwn(out, rng.pick(EXTRA_KEYS), genValid(rng, catchall));
  } else if (mode !== "strict" && rng.chance(0.3)) {
    for (let i = 0, extras = rng.int(1, 2); i < extras; i++) setOwn(out, rng.pick(EXTRA_KEYS), genJsonScalar(rng));
  }
  return out;
}

function genValid(rng: Rng, d: Descriptor): Json {
  switch (d.k) {
    case "string": return genValidString(rng, d.checks);
    case "number": return genValidNumber(rng, d.checks);
    case "boolean": return rng.chance(0.5);
    case "null": return null;
    case "any":
    case "unknown": return genJsonScalar(rng);
    case "literal":
    case "enum": return rng.pick(d.values) as Json;
    case "object": return genValidObject(rng, d.shape, d.mode, d.catchall);
    case "array": return Array.from({ length: rng.int(d.min, Math.max(d.min, Math.min(d.max, d.min + 4))) }, () => genValid(rng, d.el));
    case "tuple": {
      const result = d.items.map((item) => genValid(rng, item));
      if (d.rest !== null) {
        for (let i = 0, count = rng.int(0, 2); i < count; i++) result.push(genValid(rng, d.rest));
      }
      return result;
    }
    case "union": return genValid(rng, rng.pick(d.options));
    case "discunion": {
      const opt = rng.pick(d.options);
      const out: Record<string, Json> = { [d.key]: opt.tag };
      for (const [field, child] of opt.shape) setOwn(out, field, genValid(rng, child));
      return out;
    }
    case "record": {
      const out: Record<string, Json> = {};
      const keys = rng.chance(0.12) ? WEIRD_KEYS : ["a", "b", "k1", "k2", "name"];
      const taken = new Set<string>();
      for (let i = 0, n = rng.int(0, 3); i < n; i++) {
        const key = rng.pick(keys);
        if (taken.has(key)) continue;
        taken.add(key);
        setOwn(out, key, genValid(rng, d.value));
      }
      return out;
    }
    case "partialRecord": {
      const out: Record<string, Json> = {};
      for (const key of d.keys) {
        if (rng.chance(0.5)) setOwn(out, key, genValid(rng, d.value));
      }
      return out;
    }
    case "optional":
    case "exactOptional":
    case "nonoptional":
    case "default":
    case "prefault":
    case "lazy": return genValid(rng, d.inner);
    case "nullable": return rng.chance(0.3) ? null : genValid(rng, d.inner);
    case "catch":
      if (rng.chance(0.25)) {
        const wrong = mistypedValue(rng, d.inner);
        if (wrong !== undefined) return wrong;
      }
      return genValid(rng, d.inner);
    case "templateLiteral": return `${d.prefix}${rng.pick(["value", "", "héllo"])}${d.suffix}`;
  }
}

/** A JSON value the descriptor's top-level type definitely rejects, or undefined. */
function mistypedValue(rng: Rng, d: Descriptor): Json | undefined {
  switch (d.k) {
    case "string": return d.coerce ? undefined : rng.int(0, 1000);
    case "enum": return rng.int(0, 1000);
    case "number": return d.coerce ? undefined : "not-a-number";
    case "boolean": return d.coerce ? undefined : rng.int(0, 1);
    case "null": return rng.int(0, 1);
    case "any":
    case "unknown": return undefined;
    case "literal": return "\0literal-miss";
    case "templateLiteral": return rng.int(0, 1000);
    case "object":
    case "discunion":
    case "record":
    case "partialRecord": return [1, 2];
    case "array":
    case "tuple": return { wrong: true };
    case "union": return undefined;
    case "optional":
    case "exactOptional":
    case "nullable":
    case "nonoptional":
    case "default":
    case "prefault":
    case "catch":
    case "lazy": return mistypedValue(rng, d.inner);
  }
}

// ---------------------------------------------------------------------------
// Near-miss mutations
// ---------------------------------------------------------------------------

interface Slot { parent: Json[] | Record<string, Json>; key: string | number; value: Json }

function collectSlots(value: Json, into: Slot[], parent: Slot["parent"] | null, key: string | number | null): void {
  if (parent !== null && key !== null) into.push({ parent, key, value });
  if (Array.isArray(value)) value.forEach((item, i) => collectSlots(item, into, value, i));
  else if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) collectSlots((value as Record<string, Json>)[k], into, value as Record<string, Json>, k);
  }
}

function setSlot(slot: Slot, next: Json): void {
  if (Array.isArray(slot.parent) && typeof slot.key === "number") slot.parent[slot.key] = next;
  else setOwn(slot.parent as Record<string, Json>, String(slot.key), next);
}

const MUTATIONS = ["type-flip", "drop-key", "extra-key", "number-oob", "string-tweak", "null-leaf"] as const;

function mutate(rng: Rng, value: Json): string | null {
  const slots: Slot[] = [];
  collectSlots(value, slots, null, null);
  if (slots.length === 0) return null;
  const choice = rng.pick(MUTATIONS);
  if (choice === "drop-key" || choice === "extra-key") {
    const objects = slots.filter((s) => s.value !== null && typeof s.value === "object" && !Array.isArray(s.value));
    if (objects.length === 0) return null;
    const target = rng.pick(objects).value as Record<string, Json>;
    if (choice === "drop-key") {
      const keys = Object.keys(target);
      if (keys.length === 0) return null;
      delete target[rng.pick(keys)];
    } else setOwn(target, rng.pick(EXTRA_KEYS), genJsonScalar(rng));
    return choice;
  }
  const slot = rng.pick(slots);
  if (choice === "type-flip") {
    const flip: Json = typeof slot.value === "string" ? rng.int(0, 999) : typeof slot.value === "number" ? "flipped" : typeof slot.value === "boolean" ? null : "flip";
    setSlot(slot, flip);
  } else if (choice === "number-oob") {
    const numbers = slots.filter((s) => typeof s.value === "number");
    if (numbers.length === 0) return null;
    const picked = rng.pick(numbers);
    setSlot(picked, rng.pick([10 ** 9, -(10 ** 9), 0.5, -0.5, Number.MAX_SAFE_INTEGER]));
  } else if (choice === "string-tweak") {
    const strings = slots.filter((s) => typeof s.value === "string");
    if (strings.length === 0) return null;
    const picked = rng.pick(strings);
    setSlot(picked, rng.pick(["", `${picked.value}${picked.value}${picked.value}${picked.value}`, " ", ""]));
  } else if (choice === "null-leaf") setSlot(slot, null);
  return choice;
}

// ---------------------------------------------------------------------------
// Adversarial byte-level inputs
// ---------------------------------------------------------------------------

const LONE_SURROGATE = "\ud800";

function firstNumberText(value: Json): string | null {
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNumberText(item);
      if (found !== null) return found;
    }
  } else if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const found = firstNumberText((value as Record<string, Json>)[k]);
      if (found !== null) return found;
    }
  }
  return null;
}

function firstStringSlot(value: Json): Slot | null {
  const slots: Slot[] = [];
  collectSlots(value, slots, null, null);
  return slots.find((s) => typeof s.value === "string") ?? null;
}

/** Byte-level hostilities; `validValue`/`validText` are the pre-attack valid input. */
function adversarial(rng: Rng, validValue: Json, validText: string): FuzzCase {
  const kind = rng.pick(["proto-inject", "lone-surrogate", "overflow", "nan-literal", "inf-literal", "dup-keys", "bom", "truncated", "deep-nest"] as const);
  if (kind === "deep-nest") {
    const text = `${"[".repeat(100)}1${"]".repeat(100)}`;
    return { kind, bytes: encoder.encode(text), text };
  }
  if (kind === "bom") {
    const encoded = encoder.encode(validText);
    const bytes = new Uint8Array(3 + encoded.length);
    bytes.set([0xef, 0xbb, 0xbf], 0);
    bytes.set(encoded, 3);
    return { kind, bytes, text: validText };
  }
  if (kind === "truncated") {
    const text = validText.slice(0, Math.max(1, Math.floor(validText.length / 2)));
    return { kind, bytes: encoder.encode(text), text };
  }
  if (kind === "proto-inject") {
    const payload = JSON.stringify(genJsonScalar(rng));
    const text = validText.startsWith("{")
      ? `{"__proto__":${payload},${validText.slice(1)}`
      : `{"__proto__":${payload},"v":${validText}}`;
    return { kind, bytes: encoder.encode(text), text };
  }
  if (kind === "dup-keys") {
    const match = /^\{"((?:[^"\\]|\\.)*)":/.exec(validText);
    // Root not an object: wrap so the duplicate key is still exercised.
    const text = match
      ? `{"${match[1]}":${JSON.stringify(genJsonScalar(rng))},${validText.slice(1)}`
      : `{"k":${validText},"k":${validText}}`;
    return { kind, bytes: encoder.encode(text), text };
  }
  if (kind === "lone-surrogate") {
    const slot = firstStringSlot(validValue);
    if (slot) {
      setSlot(slot, `${slot.value}${LONE_SURROGATE}A`);
      // JSON.stringify emits the lone surrogate raw; escape it so the byte
      // stream carries the \ud800 form (raw surrogates are not valid UTF-8).
      const text = JSON.stringify(validValue).replace(LONE_SURROGATE, "\\ud800");
      return { kind, bytes: encoder.encode(text), text };
    }
    const text = '"x\\ud800"';
    return { kind, bytes: encoder.encode(text), text };
  }
  // overflow / nan-literal / inf-literal: rewrite the first number token, or
  // wrap the value in an array carrying the hostile literal.
  const token = kind === "overflow" ? "1e400" : kind === "nan-literal" ? "NaN" : "Infinity";
  const numberText = firstNumberText(validValue);
  const text = numberText !== null ? validText.replace(numberText, token) : `[${validText},${token}]`;
  return { kind, bytes: encoder.encode(text), text };
}

// ---------------------------------------------------------------------------
// Case assembly
// ---------------------------------------------------------------------------

/**
 * Produces one fuzz case, or null when the valid-input generator could not
 * satisfy its own descriptor (a generator miss, never a backend mismatch).
 * The schema's TS-path safeParse self-checks "valid" candidates before they
 * become the basis of a case.
 */
export function genCase(rng: Rng, descriptor: Descriptor, schema: AnySchema): FuzzCase | null {
  let validValue: Json | null = null;
  for (let attempt = 0; attempt < 8 && validValue === null; attempt++) {
    const candidate = genValid(rng, descriptor);
    if (schema.safeParse(candidate).success) validValue = candidate;
  }
  if (validValue === null) return null;

  const roll = rng.float();
  if (roll < 0.5) {
    const text = JSON.stringify(validValue);
    return { kind: "valid", bytes: encoder.encode(text), text };
  }
  if (roll < 0.78) {
    const tag = mutate(rng, validValue);
    const text = JSON.stringify(validValue);
    return { kind: tag === null ? "valid" : `mutate:${tag}`, bytes: encoder.encode(text), text };
  }
  return adversarial(rng, validValue, JSON.stringify(validValue));
}
