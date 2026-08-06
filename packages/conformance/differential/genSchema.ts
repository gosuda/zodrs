/**
 * Random schema descriptor generator, drawing from the JSON-eligible subset
 * of the Plan IR grammar. Deterministic given an Rng.
 */

import type { Descriptor, FormatName, Json, NumberCheck, StringCheck } from "./descriptor.js";
import { Rng } from "./prng.js";

const MAX_DEPTH = 5;
const NODE_BUDGET = 40;

const SHAPE_KEYS = ["a", "b", "name", "age", "id", "x", "y", "tag", "value", "user", "items", "k1", "k2", "email", "count"];
const WEIRD_KEYS = ["__proto__", "constructor", "a b", "", "héllo", "0"];
const DISCRIM_TAGS = ["circle", "square", "triangle", "red", "blue", "cat", "dog"];
const EXTRA_KEYS = ["extra", "zz", "$weird", "0", "__meta"];

/** Exemplars guaranteed valid per format; pools also drive near-miss generation. */
export const FORMAT_VALID: Record<FormatName, string[]> = {
  email: ["ada@example.com", "a.b+c@sub.example.org", "x@y.io"],
  uuid: ["550e8400-e29b-41d4-a716-446655440000", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
  url: ["https://example.com", "http://sub.example.org:8080/path?q=1", "ftp://files.example.net/a"],
  "iso.datetime": ["2020-01-01T00:00:00Z", "2023-06-30T23:59:59.123Z", "2024-02-29T12:00:00+02:00"],
  "iso.date": ["2020-01-01", "2024-02-29", "1999-12-31"],
  "iso.time": ["10:20:30", "23:59:59", "00:00:00.5"],
  "iso.duration": ["P1DT2H", "PT30M", "P3Y6M4DT12H30M5S"],
  ipv4: ["1.2.3.4", "192.168.0.1", "255.255.255.0"],
  nanoid: ["V1StGXR8_Z5jdHi6B-myT", "0123456789abcdefghij"],
  ulid: ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01BX5ZZKBKACTAV9WEVGEMMVRY"],
  base64: ["aGVsbG8=", "AAECAwQFBgc=", "eA=="],
  emoji: ["😀", "🎉", "🚀"],
  e164: ["+15551234567", "+442071234567"],
};

/** Rust-regex-crate-safe patterns (no lookaround/backrefs) with matching exemplars. */
const REGEX_POOL: { src: string; ok: string[] }[] = [
  { src: "^[a-z]+$", ok: ["abc", "zzz", "q"] },
  { src: "^\\d{2,4}$", ok: ["12", "123", "9999"] },
  { src: "^[A-Z][a-z]*$", ok: ["Hello", "A", "Zzz"] },
  { src: "^x?y{1,3}$", ok: ["y", "xyyy", "yy"] },
];

export interface GenState {
  nodes: number;
}

function pickKey(rng: Rng, taken: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = rng.chance(0.08) ? rng.pick(WEIRD_KEYS) : rng.pick(SHAPE_KEYS);
    if (!taken.has(key)) return key;
  }
  return `k${rng.int(100, 999)}`;
}

function genStringChecks(rng: Rng): StringCheck[] {
  const checks: StringCheck[] = [];
  // Content checks come from conflict-free presets; formats/regexes are exclusive.
  const preset = rng.int(0, 9);
  if (preset === 0) {
    const format = rng.pick(Object.keys(FORMAT_VALID) as FormatName[]);
    checks.push({ c: "format", f: format });
    return checks; // formats carry their own length profile; no bounds presets
  }
  if (preset === 1) {
    const entry = rng.pick(REGEX_POOL);
    checks.push({ c: "regex", src: entry.src });
    return checks;
  }
  if (preset <= 3) checks.push({ c: "startsWith", v: rng.pick(["pre", "ab", "x"]) });
  else if (preset === 4) checks.push({ c: "endsWith", v: rng.pick(["post", "yz"]) });
  else if (preset === 5) checks.push({ c: "includes", v: rng.pick(["mid", "ell"]) });
  else if (preset === 6) checks.push({ c: "lowercase" });
  else if (preset === 7) checks.push({ c: "uppercase" });
  // Length bounds, kept compatible with the required content parts.
  const required = checks.reduce((n, c) => n + ("v" in c ? c.v.length : 0), 0);
  const bounds = rng.int(0, 3);
  if (bounds === 1) checks.push({ c: "min", v: required + rng.int(0, 4) });
  else if (bounds === 2) checks.push({ c: "max", v: required + rng.int(2, 10) });
  else if (bounds === 3) {
    const min = required + rng.int(0, 3);
    checks.push({ c: "min", v: min }, { c: "max", v: min + rng.int(0, 8) });
  }
  // Overwrites (dirty-path coverage) compose with anything.
  if (rng.chance(0.15)) checks.push({ c: rng.pick(["trim", "toLowerCase", "toUpperCase"] as const) });
  return checks;
}

function genNumberChecks(rng: Rng): NumberCheck[] {
  const checks: NumberCheck[] = [];
  if (rng.chance(0.45)) checks.push({ c: "int" });
  const bounds = rng.int(0, 5);
  if (bounds === 0) {
    const min = rng.int(-100, 0);
    checks.push({ c: "min", v: min }, { c: "max", v: min + rng.int(1, 200) });
  } else if (bounds === 1) {
    const lo = rng.int(-50, 50);
    checks.push({ c: "gt", v: lo }, { c: "lt", v: lo + rng.int(2, 100) });
  } else if (bounds === 2) checks.push({ c: "positive" });
  else if (bounds === 3) checks.push({ c: "negative" });
  else if (bounds === 4) checks.push({ c: "min", v: rng.int(-100, 0) });
  if (rng.chance(0.2)) checks.push({ c: "multipleOf", v: rng.pick([2, 3, 5, 10, 0.5, 0.25]) });
  return checks;
}

export function genJsonScalar(rng: Rng): Json {
  const roll = rng.int(0, 5);
  if (roll === 0) return null;
  if (roll === 1) return rng.chance(0.5);
  if (roll === 2) return rng.int(-1000, 1000);
  if (roll === 3) return Math.round(rng.float() * 2000 - 1000) / 8;
  return rng.pick(["s", "hello world", "", "héllo", "🎉", "with \"quotes\"", "line\nbreak"]);
}

function genLeaf(rng: Rng): Descriptor {
  switch (rng.int(0, 6)) {
    case 0:
    case 1: return { k: "string", checks: genStringChecks(rng) };
    case 2:
    case 3: return { k: "number", checks: genNumberChecks(rng) };
    case 4: return { k: "boolean" };
    case 5: {
      const values = Array.from({ length: rng.int(1, 4) }, () =>
        rng.pick([null, true, false, 0, 1, -7, 2.5, "red", "blue", "", "héllo"] as const));
      return { k: "literal", values: [...new Set(values)] };
    }
    default: {
      const pool = ["a", "b", "c", "red", "blue", "", "with space", "héllo"];
      const values = [...new Set(Array.from({ length: rng.int(2, 5) }, () => rng.pick(pool)))];
      return { k: "enum", values };
    }
  }
}

export function genDescriptor(rng: Rng, state: GenState, depth: number, allowWrapper: boolean): Descriptor {
  state.nodes++;
  if (depth >= MAX_DEPTH || state.nodes >= NODE_BUDGET) return genLeaf(rng);
  const roll = rng.int(0, 19);
  if (roll <= 8) return genLeaf(rng);
  if (roll <= 12) {
    // object
    const mode = rng.pick(["strip", "strip", "strict", "passthrough"] as const);
    const taken = new Set<string>();
    const shape: [string, Descriptor][] = Array.from({ length: rng.int(0, 5) }, () => {
      const key = pickKey(rng, taken);
      taken.add(key);
      return [key, genWrapped(rng, state, depth + 1)];
    });
    return { k: "object", mode, shape };
  }
  if (roll <= 14) {
    const min = rng.int(0, 2);
    return { k: "array", el: genWrapped(rng, state, depth + 1), min, max: min + rng.int(0, 5) };
  }
  if (roll === 15) return { k: "tuple", items: Array.from({ length: rng.int(0, 3) }, () => genWrapped(rng, state, depth + 1)) };
  if (roll === 16) {
    const options = Array.from({ length: rng.int(2, 3) }, () => genDescriptor(rng, state, depth + 1, false));
    return { k: "union", options };
  }
  if (roll === 17) {
    const key = "kind";
    const tags = [...DISCRIM_TAGS].sort(() => rng.float() - 0.5).slice(0, rng.int(2, 3));
    return {
      k: "discunion",
      key,
      options: tags.map((tag) => {
        const taken = new Set<string>([key]);
        return {
          tag,
          shape: Array.from({ length: rng.int(0, 3) }, (): [string, Descriptor] => {
            const field = pickKey(rng, taken);
            taken.add(field);
            return [field, genWrapped(rng, state, depth + 1)];
          }),
        };
      }),
    };
  }
  return { k: "record", value: genWrapped(rng, state, depth + 1) };
}

/** Wrappers apply anywhere except the root (undefined is not byte-representable). */
function genWrapped(rng: Rng, state: GenState, depth: number): Descriptor {
  const inner = genDescriptor(rng, state, depth, true);
  if (!rng.chance(0.22)) return inner;
  const roll = rng.int(0, 4);
  if (roll === 0) return { k: "optional", inner };
  if (roll === 1) return { k: "nullable", inner };
  if (roll === 2) return { k: "default", inner, value: defaultValueFor(inner) };
  return { k: "catch", inner, value: defaultValueFor(inner) };
}

/** A fixed, obviously-valid fallback value for default/catch, by descriptor kind. */
function defaultValueFor(d: Descriptor): Json {
  switch (d.k) {
    case "string": return "fallback";
    case "number": return 7;
    case "boolean": return true;
    case "null": return null;
    case "literal":
    case "enum": return d.values[0] as Json;
    case "object": return {};
    case "array": return [];
    case "tuple": return d.items.map(defaultValueFor);
    case "union": return defaultValueFor(d.options[0]);
    case "discunion": return { [d.key]: d.options[0].tag };
    case "record": return {};
    case "optional":
    case "nullable": return null;
    case "default":
    case "catch": return d.value;
  }
}

export function genSchemaDescriptor(seed: number): Descriptor {
  const rng = new Rng(seed);
  return genDescriptor(rng, { nodes: 0 }, 0, false);
}

export { EXTRA_KEYS, WEIRD_KEYS };
