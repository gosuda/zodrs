/**
 * Suite: union — z.union().parse across zodrs, zod4, arktype, valibot.
 *
 * Mirrors Zod's bench/union.ts. A 3-option union of objects discriminated by
 * a literal "type" field. The input always matches the last option (worst case
 * for naive union scanning).
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { consume, metabench } from "./metabench.js";

const zodrsSchema = z.union([
  z.object({ type: z.literal("a") }),
  z.object({ type: z.literal("b") }),
  z.object({ type: z.literal("c") }),
]);

const z4Schema = z4.union([
  z4.object({ type: z4.literal("a") }),
  z4.object({ type: z4.literal("b") }),
  z4.object({ type: z4.literal("c") }),
]);

const valibotSchema = v.union([
  v.object({ type: v.literal("a") }),
  v.object({ type: v.literal("b") }),
  v.object({ type: v.literal("c") }),
]);

const arkSchema = ark({ type: "'a'" }).or(ark({ type: "'b'" })).or(ark({ type: "'c'" }));

const DATA = { type: "c" };

// Smoke checks
zodrsSchema.parse(DATA);
z4Schema.parse(DATA);
v.parse(valibotSchema, DATA);
arkSchema(DATA);

const bench = metabench("z.union().parse", {
  zodrs() {
    consume(zodrsSchema.parse(DATA));
  },
  zod4() {
    consume(z4Schema.parse(DATA));
  },
  arktype() {
    consume(arkSchema(DATA));
  },
  valibot() {
    consume(v.parse(valibotSchema, DATA));
  },
});

await bench.run();
