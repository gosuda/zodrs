/**
 * Suite: object — z.object().parse across zodrs, zod4, arktype, valibot.
 *
 * Mirrors Zod's bench/object.ts. Each library validates the same 3-field
 * object (string, boolean, number) over 1000 frozen data samples.
 *
 * Also includes a parseJson variant: zodrs.safeParseJson(bytes) vs
 * JSON.parse-then-zod4.safeParse on a ~4KB nested object payload.
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { consume, metabench } from "./metabench.js";

// ── Simple 3-field object (matches Zod's bench) ──────────────────────────

const zodrsSchema = z.object({
  string: z.string(),
  boolean: z.boolean(),
  number: z.number(),
});

const z4Schema = z4.object({
  string: z4.string(),
  boolean: z4.boolean(),
  number: z4.number(),
});

const valibotSchema = v.object({
  string: v.string(),
  boolean: v.boolean(),
  number: v.number(),
});

const arkSchema = ark({
  string: "string",
  boolean: "boolean",
  number: "number",
});

const DATA = Array.from({ length: 1000 }, () =>
  Object.freeze({
    number: Math.random(),
    string: `${Math.random()}`,
    boolean: Math.random() > 0.5,
  }),
);

// ── ~4KB nested payload for parseJson variant ────────────────────────────

function buildLargePayload(): Record<string, unknown> {
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < 35; i++) {
    items.push({
      idx: i,
      val: `value_${i}_padding_string_for_size`,
      flag: i % 2 === 0,
      nested: { a: i * 1.5, b: `desc_${i}`, c: i % 3 === 0 ? null : "x" },
    });
  }
  return {
    id: 12345,
    name: "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor",
    email: "user@example.com",
    active: true,
    score: 42.5,
    tags: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"],
    description: "A".repeat(250),
    nested: {
      foo: "bar",
      num: 100,
      bool: false,
      deep: { a: 1, b: "two", c: null, d: [1, 2, 3, 4, 5], e: "F".repeat(120) },
    },
    items,
  };
}

const largePayload = buildLargePayload();
const largeJson = JSON.stringify(largePayload);
const largeBuf = Buffer.from(largeJson);

const zodrsLargeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.email(),
  active: z.boolean(),
  score: z.number(),
  tags: z.array(z.string()),
  description: z.string(),
  nested: z.object({
    foo: z.string(),
    num: z.number(),
    bool: z.boolean(),
    deep: z.object({
      a: z.number(),
      b: z.string(),
      c: z.nullable(z.string()),
      d: z.array(z.number()),
      e: z.string(),
    }),
  }),
  items: z.array(
    z.object({
      idx: z.number().int(),
      val: z.string(),
      flag: z.boolean(),
      nested: z.object({
        a: z.number(),
        b: z.string(),
        c: z.nullable(z.string()),
      }),
    }),
  ),
});

const z4LargeSchema = z4.object({
  id: z4.number().int(),
  name: z4.string(),
  email: z4.email(),
  active: z4.boolean(),
  score: z4.number(),
  tags: z4.array(z4.string()),
  description: z4.string(),
  nested: z4.object({
    foo: z4.string(),
    num: z4.number(),
    bool: z4.boolean(),
    deep: z4.object({
      a: z4.number(),
      b: z4.string(),
      c: z4.nullable(z4.string()),
      d: z4.array(z4.number()),
      e: z4.string(),
    }),
  }),
  items: z4.array(
    z4.object({
      idx: z4.number().int(),
      val: z4.string(),
      flag: z4.boolean(),
      nested: z4.object({
        a: z4.number(),
        b: z4.string(),
        c: z4.nullable(z4.string()),
      }),
    }),
  ),
});

// Smoke checks
zodrsSchema.parse(DATA[0]);
z4Schema.parse(DATA[0]);
v.parse(valibotSchema, DATA[0]);
arkSchema(DATA[0]);
zodrsLargeSchema.safeParseJson(largeBuf);
z4LargeSchema.safeParse(JSON.parse(largeJson));

const bench = metabench("z.object().parse", {
  zodrs() {
    for (const d of DATA) consume(zodrsSchema.parse(d));
  },
  zod4() {
    for (const d of DATA) consume(z4Schema.parse(d));
  },
  arktype() {
    for (const d of DATA) consume(arkSchema(d));
  },
  valibot() {
    for (const d of DATA) consume(v.parse(valibotSchema, d));
  },
});

// parseJson variant — separate group so it gets its own table
const benchJson = metabench("object.safeParseJson (4KB payload)", {
  "zodrs.safeParseJson"() {
    consume(zodrsLargeSchema.safeParseJson(largeBuf));
  },
  "zod4 (JSON.parse + safeParse)"() {
    consume(z4LargeSchema.safeParse(JSON.parse(largeJson)));
  },
});

await bench.run();
await benchJson.run();
