/**
 * Suite: object-safe — z.object().safeParse across zodrs, zod4, arktype, valibot.
 *
 * Mirrors Zod's bench/object-safe.ts. Same 3-field object as object.ts but
 * using safeParse (non-throwing) instead of parse.
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { metabench } from "./metabench.js";

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

// Smoke checks
zodrsSchema.safeParse(DATA[0]);
z4Schema.safeParse(DATA[0]);
v.safeParse(valibotSchema, DATA[0]);
arkSchema(DATA[0]);

const bench = metabench("z.object().safeParse", {
  zodrs() {
    for (const d of DATA) zodrsSchema.safeParse(d);
  },
  zod4() {
    for (const d of DATA) z4Schema.safeParse(d);
  },
  arktype() {
    for (const d of DATA) arkSchema(d);
  },
  valibot() {
    for (const d of DATA) v.safeParse(valibotSchema, d);
  },
});

await bench.run();
