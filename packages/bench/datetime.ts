/**
 * Suite: datetime — ISO datetime string validation across zodrs, zod4, valibot.
 *
 * Mirrors Zod's bench/datetime.ts. Zod uses z.string().datetime(); zodrs uses
 * z.iso.datetime(); valibot uses v.pipe(v.string(), v.isoTimestamp()).
 *
 * arktype has no built-in ISO datetime keyword, so it uses a .narrow() predicate
 * with a regex — this is the closest equivalent and tests the same hot path
 * (string → regex match → return).
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { metabench } from "./metabench.js";
import { makeData } from "./benchUtil.js";

const zodrsSchema = z.iso.datetime();
const z4Schema = z4.string().datetime();
const valibotSchema = v.pipe(v.string(), v.isoTimestamp());
const arkSchema = ark("string").narrow((s) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s as string),
);

const DATA = makeData(10000, () => new Date().toISOString()) as string[];

// Smoke checks
zodrsSchema.parse(DATA[0]);
z4Schema.parse(DATA[0]);
v.parse(valibotSchema, DATA[0]);
arkSchema(DATA[0]);

const bench = metabench("z.string().datetime().parse", {
  zodrs() {
    for (const d of DATA) zodrsSchema.parse(d);
  },
  zod4() {
    for (const d of DATA) z4Schema.parse(d);
  },
  arktype() {
    for (const d of DATA) arkSchema(d);
  },
  valibot() {
    for (const d of DATA) v.parse(valibotSchema, d);
  },
});

await bench.run();
