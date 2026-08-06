/**
 * Type-level cost corpus generator for @zodrs/tsc-bench.
 *
 * Emits a large TypeScript corpus that exercises type inference across the
 * shapes the plan calls out (object schemas, nested inference, unions,
 * discriminated unions, generics via z.infer composition, plus extend/omit/pick
 * chains mirroring Zod's own generated corpus). The SAME corpus body is written
 * for both libraries; only the import line differs.
 *
 * Deterministic: a fixed-seed PRNG guarantees the zodrs and zod4 variants are
 * byte-identical apart from the import specifier, so the only variable in the
 * tsc --extendedDiagnostics measurement is the library's type-instantiation cost.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Lib = "zodrs" | "zod4";

const OUT = resolve(import.meta.dirname, "generated/corpus.ts");
const SEED = 0x5eed_1337;
const CHARSET = "abcdefghijklmnopqrstuvwxyz";

// --- Seeded PRNG (mulberry32): identical seed => identical corpus body. ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStr(len: number, rng: () => number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = CHARSET[Math.floor(rng() * CHARSET.length)];
    if (c === undefined) throw new Error("CHARSET is empty");
    s += c;
  }
  return s;
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  const value = arr[Math.floor(rng() * arr.length)];
  if (value === undefined) throw new Error("pick: empty array");
  return value;
}

function randint(lo: number, hi: number, rng: () => number): number {
  return Math.floor(rng() * (hi - lo)) + lo;
}

// Value-type pool for object fields. Every entry is valid under both zodrs and
// zod@4.4.3 (v4 classic surface).
const VALUE_TYPES = [
  "z.string()",
  "z.number()",
  "z.boolean()",
  "z.string().min(1).max(100)",
  "z.number().int().positive()",
  "z.string().email()",
  "z.string().optional()",
  "z.number().nullable()",
  "z.array(z.string())",
  "z.array(z.number())",
  'z.literal("a")',
  "z.literal(1)",
  "z.union([z.string(), z.number()])",
] as const;

const N_BULK = 300;
const N_NESTED = 50;
const N_UNION = 30;
const N_DISC = 30;
const N_CHAIN = 40;
const N_COMPOSED = 40;
const N_GENERIC_FN = 20;

function buildBody(): string[] {
  const rng = mulberry32(SEED);
  const lines: string[] = [];

  // A. Bulk object schemas + z.infer aliases.
  for (let i = 0; i < N_BULK; i++) {
    const name = `Obj${i}`;
    lines.push(`export const ${name} = z.object({`);
    for (let k = 0; k < 5; k++) {
      lines.push(`  ${makeStr(8, rng)}: ${pick(VALUE_TYPES, rng)},`);
    }
    lines.push(`});`);
    lines.push(`export type T_${name} = z.infer<typeof ${name}>;`);
    lines.push("");
  }

  // B. Nested inference: objects with object-valued and array-of-object fields.
  for (let i = 0; i < N_NESTED; i++) {
    const name = `Nested${i}`;
    lines.push(`export const ${name} = z.object({`);
    lines.push(`  child: z.object({ a: z.string(), b: z.number(), c: z.boolean() }),`);
    lines.push(`  children: z.array(z.object({ id: z.string(), val: z.number() })),`);
    lines.push(`  deep: z.object({ inner: z.object({ x: z.string(), y: z.number() }) }),`);
    lines.push(`  ${makeStr(8, rng)}: ${pick(VALUE_TYPES, rng)},`);
    lines.push(`});`);
    lines.push(`export type T_${name} = z.infer<typeof ${name}>;`);
    lines.push("");
  }

  // C. Unions over existing object schemas.
  for (let i = 0; i < N_UNION; i++) {
    const a = `Obj${randint(0, N_BULK, rng)}`;
    const b = `Obj${randint(0, N_BULK, rng)}`;
    const name = `Union${i}`;
    lines.push(`export const ${name} = z.union([${a}, ${b}]);`);
    lines.push(`export type T_${name} = z.infer<typeof ${name}>;`);
    lines.push("");
  }

  // D. Discriminated unions.
  for (let i = 0; i < N_DISC; i++) {
    const name = `Disc${i}`;
    lines.push(`export const ${name} = z.discriminatedUnion("type", [`);
    lines.push(`  z.object({ type: z.literal("a"), value: z.string() }),`);
    lines.push(`  z.object({ type: z.literal("b"), count: z.number() }),`);
    lines.push(`  z.object({ type: z.literal("c"), flag: z.boolean() }),`);
    lines.push(`]);`);
    lines.push(`export type T_${name} = z.infer<typeof ${name}>;`);
    lines.push("");
  }

  // E. Extend / omit / pick chains (keys are real members of the base object).
  for (let i = 0; i < N_CHAIN; i++) {
    const base = `ChainBase${i}`;
    const keys = [makeStr(8, rng), makeStr(8, rng), makeStr(8, rng), makeStr(8, rng)];
    lines.push(`export const ${base} = z.object({`);
    for (const key of keys) {
      lines.push(`  ${key}: ${pick(VALUE_TYPES, rng)},`);
    }
    lines.push(`});`);
    lines.push(`export type T_${base} = z.infer<typeof ${base}>;`);

    const ext = `ChainExt${i}`;
    lines.push(`export const ${ext} = ${base}.extend({ ${makeStr(8, rng)}: z.string(), ${makeStr(8, rng)}: z.number() });`);
    lines.push(`export type T_${ext} = z.infer<typeof ${ext}>;`);

    const k0 = keys[0] ?? "k0";
    const k1 = keys[1] ?? "k1";
    lines.push(`export const ${base}_omit = ${base}.omit({ ${k0}: true, ${k1}: true });`);
    lines.push(`export type T_${base}_omit = z.infer<typeof ${base}_omit>;`);

    lines.push(`export const ${base}_pick = ${base}.pick({ ${k0}: true, ${k1}: true });`);
    lines.push(`export type T_${base}_pick = z.infer<typeof ${base}_pick>;`);
    lines.push("");
  }

  // F. Generics via z.infer composition.
  lines.push(`export type Compose<A extends z.ZodType, B extends z.ZodType> = z.infer<A> & z.output<B>;`);
  lines.push(`export type InputOf<T extends z.ZodType> = z.input<T>;`);
  lines.push(`export type OutputOf<T extends z.ZodType> = z.output<T>;`);
  lines.push(`export type PipeOut<A extends z.ZodType, B extends z.ZodType> = z.output<B>;`);
  lines.push("");
  for (let i = 0; i < N_COMPOSED; i++) {
    const a = `Obj${randint(0, N_BULK, rng)}`;
    const b = `Obj${randint(0, N_BULK, rng)}`;
    lines.push(`export type Composed${i} = Compose<typeof ${a}, typeof ${b}>;`);
  }
  lines.push("");
  for (let i = 0; i < N_GENERIC_FN; i++) {
    lines.push(
      `declare function parseWrap${i}<T extends z.ZodType>(schema: T, value: z.input<T>): z.output<T>;`,
    );
  }
  lines.push("");

  return lines;
}

/** Write the corpus for the given library. Only the import line varies. */
export function generateCorpus(lib: Lib): string {
  const specifier = lib === "zod4" ? "zod4" : "zodrs";
  const header = `// Generated by @zodrs/tsc-bench. Do not edit.\nimport * as z from "${specifier}";\n`;
  const body = buildBody();
  const content = header + "\n" + body.join("\n") + "\n";
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content, { flag: "w" });
  return OUT;
}

// CLI entry: `tsx generate.ts [--lib=zodrs|zod4]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find((a) => a.startsWith("--lib="));
  const flag = arg?.slice("--lib=".length) as Lib | undefined;
  if (flag !== "zodrs" && flag !== "zod4") {
    process.stderr.write(`Unknown --lib=${flag ?? "(none)"}; expected zodrs or zod4\n`);
    process.exit(1);
  }
  const lib: Lib = flag;
  const path = generateCorpus(lib);
  process.stdout.write(`Wrote ${lib} corpus -> ${path}\n`);
}
