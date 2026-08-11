/**
 * Suite: number — z.number().parse across zodrs, zod4, arktype, valibot.
 *
 * Mirrors Zod's bench/number.ts. 10 000 random number samples.
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { consume, metabench } from "./metabench.js";
import { makeData } from "./benchUtil.js";

const zodrsSchema = z.number();
const z4Schema = z4.number();
const valibotSchema = v.number();
const arkSchema = ark("number");

const DATA = makeData(10000, () => Math.random()) as number[];

// Smoke checks
zodrsSchema.parse(DATA[0]);
z4Schema.parse(DATA[0]);
v.parse(valibotSchema, DATA[0]);
arkSchema(DATA[0]);

const bench = metabench("z.number().parse", {
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

await bench.run();
