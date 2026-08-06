/**
 * Suite: array — z.array().parse across zodrs, zod4, arktype, valibot.
 *
 * Mirrors Zod's bench/array.ts. Array of strings, 1000 samples of 3-element
 * arrays.
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { metabench } from "./metabench.js";
import { makeData, randomString } from "./benchUtil.js";

const zodrsSchema = z.array(z.string());
const z4Schema = z4.array(z4.string());
const valibotSchema = v.array(v.string());
const arkSchema = ark("string[]");

const DATA = makeData(1000, () =>
  Array.from({ length: 3 }, () => randomString(10)),
) as string[][];

// Smoke checks
zodrsSchema.parse(DATA[0]);
z4Schema.parse(DATA[0]);
v.parse(valibotSchema, DATA[0]);
arkSchema(DATA[0]);

const bench = metabench("z.array().parse", {
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
