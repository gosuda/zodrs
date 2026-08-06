// Native smoke test for the zodrs-node napi addon.
//
// Loads the freshly built .node binding, compiles the 4-node round-trip plan
// (object{a: string.min(3), b: array(number.int32)}), then exercises the three
// verdict statuses: valid-clean (0), valid-rewritten (1), and invalid (2).
//
// Run: node smoke/smoke.mjs   (after `napi build ... --output-dir smoke`)
// Output is written to stdout via process.stdout.write; the script exits
// non-zero on the first contract violation.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Prefer the platform-suffixed addon this build produced.
const addon = require(join(here, "zodrs_node.linux-x64-gnu.node"));
const { compile, dispose, validateJson } = addon;

const plan = JSON.stringify([
  { k: "object", keys: ["a", "b"], values: [1, 3], optional: [false, false], mode: "strip", catchall: null },
  { k: "string", checks: [{ c: "min_length", v: 3 }] },
  { k: "number", checks: [{ c: "number_format", v: "int32" }] },
  { k: "array", element: 2, checks: [] },
]);

const handle = compile(plan);
if (typeof handle !== "number") {
  throw new Error(`compile did not return a numeric handle: ${handle}`);
}

const cases = [
  {
    name: "valid-clean (status 0)",
    bytes: '{"a":"Ada","b":[1,2]}',
    expectStatus: 0,
    expectPayload: null,
  },
  {
    name: "valid-rewritten (status 1, unknown key stripped + reorder)",
    bytes: '{"b":[1,2],"a":"Ada","extra":1}',
    expectStatus: 1,
    expectPayload: { a: "Ada", b: [1, 2] },
  },
  {
    name: "invalid (status 2, exact issue)",
    bytes: '{"a":"Ad","b":[1,2]}',
    expectStatus: 2,
    expectPayload: [
      { code: "too_small", origin: "string", minimum: 3, inclusive: true, path: ["a"] },
    ],
  },
];

const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
const equal = (x, y) => canonical(x) === canonical(y);

let failures = 0;
for (const c of cases) {
  const verdict = validateJson(handle, Buffer.from(c.bytes, "utf8"));
  const statusOk = verdict.status === c.expectStatus;
  const payloadOk =
    c.expectPayload === null
      ? verdict.payload === null || verdict.payload === undefined
      : equal(JSON.parse(verdict.payload), c.expectPayload);
  const ok = statusOk && payloadOk;
  if (!ok) failures += 1;
  process.stdout.write(
    JSON.stringify({
      case: c.name,
      ok,
      status: verdict.status,
      payload: verdict.payload ?? null,
    }) + "\n"
  );
}

dispose(handle);

// dispose of an unknown handle must be a no-op (no throw).
dispose(handle);

// An unknown handle after dispose must produce an napi Error, not a panic.
let unknownErrored = false;
try {
  validateJson(handle, Buffer.from("{}"));
} catch {
  unknownErrored = true;
}
process.stdout.write(
  JSON.stringify({ case: "unknown handle errors (not panic)", ok: unknownErrored }) + "\n"
);
if (!unknownErrored) failures += 1;

process.stdout.write(JSON.stringify({ failures, total: cases.length + 1 }) + "\n");
process.exit(failures === 0 ? 0 : 1);
