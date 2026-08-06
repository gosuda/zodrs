/**
 * Suite: discriminated-union — z.discriminatedUnion().parse across zodrs, zod4,
 * arktype, valibot.
 *
 * Mirrors Zod's bench/discriminated-union.ts. A 7-option discriminated union
 * keyed on "type" with 3 string data fields per option. 100 random samples
 * cycling through all 7 discriminant values.
 *
 * API mapping:
 *   zodrs:  z.discriminatedUnion("type", [...])
 *   zod4:   z4.discriminatedUnion("type", [...])
 *   valibot: v.variant("type", [...])  — valibot's equivalent of discriminated union
 *   arktype: chained .or() on typed objects — arktype has no first-class
 *            discriminated-union constructor; the .or() union resolves by
 *            structural match, which is the closest equivalent.
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark } from "arktype";
import { z } from "zodrs";
import { metabench } from "./metabench.js";
import { makeData, randomPick, randomString } from "./benchUtil.js";

const types = ["a", "b", "c", "d", "e", "f", "g"] as const;

function makeFields(z: typeof z4) {
  return {
    data1: z.string(),
    data2: z.string(),
    data3: z.string(),
  };
}

function makeValibotFields() {
  return {
    data1: v.string(),
    data2: v.string(),
    data3: v.string(),
  };
}

function makeArkFields() {
  return {
    data1: "string",
    data2: "string",
    data3: "string",
  };
}

// zodrs
const zodrsUnion = z.discriminatedUnion(
  "type",
  types.map((t) => z.object({ type: z.literal(t), ...makeFields(z) })),
);

// zod4
const z4Union = z4.discriminatedUnion(
  "type",
  types.map((t) => z4.object({ type: z4.literal(t), ...makeFields(z4) })),
);

// valibot — v.variant is the discriminated-union equivalent
const valibotSchema = v.variant(
  "type",
  types.map((t) => v.object({ type: v.literal(t), ...makeValibotFields() })),
);

// arktype — chained .or() with literal discriminants
let arkSchema = ark({ type: "'a'", ...makeArkFields() });
for (let i = 1; i < types.length; i++) {
  arkSchema = arkSchema.or(ark({ type: `'${types[i]}'`, ...makeArkFields() }));
}

const DATA = makeData(100, () => ({
  type: randomPick([...types]),
  data1: randomString(10),
  data2: randomString(10),
  data3: randomString(10),
}));

// Smoke checks
zodrsUnion.parse(DATA[0]);
z4Union.parse(DATA[0]);
v.parse(valibotSchema, DATA[0]);
arkSchema(DATA[0]);

const bench = metabench("z.discriminatedUnion().parse", {
  zodrs() {
    for (const item of DATA) zodrsUnion.parse(item);
  },
  zod4() {
    for (const item of DATA) z4Union.parse(item);
  },
  arktype() {
    for (const item of DATA) arkSchema(item);
  },
  valibot() {
    for (const item of DATA) v.parse(valibotSchema, item);
  },
});

await bench.run();
