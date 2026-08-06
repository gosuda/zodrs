/**
 * Suite: init — schema construction cost across zodrs, zod4, arktype, valibot.
 *
 * Mirrors Zod's bench/init.ts. Constructs 1000 identical strict 7-field objects
 * (with a nested strict object) and parses one sample with the last schema to
 * prevent dead-code elimination.
 *
 * zodrs has additional plan-compilation work at construction time, so this
 * suite measures that overhead directly. The target is "at most Zod v4".
 */
import * as v from "valibot";
import * as z4 from "zod4";
import { type as ark, type Ark } from "arktype";
import { z } from "zodrs";
import { metabench } from "./metabench.js";

const SAMPLE = Object.freeze({
  number: 1,
  negNumber: -1,
  maxNumber: Number.MAX_VALUE,
  string: "string",
  longString:
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullam laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Vivendum intellegat et qui, ei denique consequuntur vix. Semper aeterno percipit ut his, sea ex utinam referrentur repudiandae. No epicuri hendrerit consetetur sit, sit dicta adipiscing ex, in facete detracto deterruisset duo. Quot populo ad qui. Sit fugit nostrum et. Ad per diam dicant interesset, lorem iusto sensibus ut sed. No dicam aperiam vis. Pri posse graeco definitiones cu, id eam populo quaestio adipiscing, usu quod malorum te. Ex nam agam veri, dicunt efficiantur ad qui, ad legere adversarium sit. Commune platonem mel id, brute adipiscing duo an. Vivendum intellegat et qui, ei denique consequuntur vix. Offendit eleifend moderatius ex vix, quem odio mazim et qui, purto expetendis cotidieque quo cu, veri persius vituperata ei nec. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.",
  boolean: true,
  deeplyNested: {
    foo: "bar",
    num: 1,
    bool: false,
  },
});

const bench = metabench("z.object() schema initialization (1000 schemas)", {
  zodrs() {
    const schemas: ReturnType<typeof z.strictObject>[] = [];
    for (let i = 0; i < 1000; i++) {
      schemas.push(
        z.strictObject({
          number: z.number(),
          negNumber: z.number(),
          maxNumber: z.number(),
          string: z.string(),
          longString: z.string(),
          boolean: z.boolean(),
          deeplyNested: z.strictObject({
            foo: z.string(),
            num: z.number(),
            bool: z.boolean(),
          }),
        }),
      );
    }
    schemas[999].parse(SAMPLE);
  },
  zod4() {
    const schemas: ReturnType<typeof z4.strictObject>[] = [];
    for (let i = 0; i < 1000; i++) {
      schemas.push(
        z4.strictObject({
          number: z4.number(),
          negNumber: z4.number(),
          maxNumber: z4.number(),
          string: z4.string(),
          longString: z4.string(),
          boolean: z4.boolean(),
          deeplyNested: z4.strictObject({
            foo: z4.string(),
            num: z4.number(),
            bool: z4.boolean(),
          }),
        }),
      );
    }
    schemas[999].parse(SAMPLE);
  },
  arktype() {
    const schemas: Ark[] = [];
    for (let i = 0; i < 1000; i++) {
      schemas.push(
        ark({
          number: "number",
          negNumber: "number",
          maxNumber: "number",
          string: "string",
          longString: "string",
          boolean: "boolean",
          deeplyNested: ark({
            foo: "string",
            num: "number",
            bool: "boolean",
          }),
        }).exact,
      );
    }
    schemas[999](SAMPLE);
  },
  valibot() {
    const schemas: Parameters<typeof v.parse>[0][] = [];
    for (let i = 0; i < 1000; i++) {
      schemas.push(
        v.strictObject({
          number: v.number(),
          negNumber: v.number(),
          maxNumber: v.number(),
          string: v.string(),
          longString: v.string(),
          boolean: v.boolean(),
          deeplyNested: v.strictObject({
            foo: v.string(),
            num: v.number(),
            bool: v.boolean(),
          }),
        }),
      );
    }
    v.parse(schemas[999], SAMPLE);
  },
});

await bench.run();
