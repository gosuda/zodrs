/**
 * Loader self-test: exercises each backend tier end to end through the
 * `native.ts` seam. Run once per tier:
 *
 *   node dist/core/loader.selftest.js                  # native (or wasm fallback)
 *   ZODRS_LOADER=wasm node dist/core/loader.selftest.js
 *   ZODRS_LOADER=none node dist/core/loader.selftest.js
 *
 * Exits non-zero on the first contract violation.
 */

import { loaderDiagnostics } from "./loader.js";
import { isNativeAvailable, validateJson } from "./native.js";
import { compilePlan } from "./plan.js";
import { object, string } from "../classic/schemas.js";

declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write(chunk: string): unknown };
  exitCode: number;
};

function emit(record: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(record) + "\n");
}
declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

const encoder = new TextEncoder();
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  emit({ case: name, ok, ...(ok ? {} : { detail }) });
  if (!ok) failures += 1;
}

const tier = typeof process !== "undefined" ? (process.env["ZODRS_LOADER"] ?? "native") : "native";

// z.object({ a: z.string().min(3) })
const schema = object({ a: string().min(3) });
const plan = compilePlan(schema._zod.node);
check("plan is JSON-eligible", plan.jsonEligible && plan.hostFns.length === 0, plan);

const validBytes = encoder.encode('{"a":"abcd"}');
const stripBytes = encoder.encode('{"a":"abcd","extra":1}');
const invalidBytes = encoder.encode('{"a":"ab"}');

if (tier === "none") {
  check("none tier: no backend registered", !isNativeAvailable());
  const result = validateJson(plan.json, null, validBytes);
  check(
    "none tier: seam reports unavailable",
    !result.available && result.handle === null && result.verdict === null,
    result,
  );
} else {
  check(`${tier} tier: backend registered`, isNativeAvailable(), loaderDiagnostics);

  // Valid, already canonical: single schema key, schema key order, no extras.
  const valid = validateJson(plan.json, null, validBytes);
  check("valid input: available with a handle", valid.available && typeof valid.handle === "number", valid);
  check("valid input: status 0 (canonical)", valid.verdict?.status === 0, valid.verdict);

  // Handle reuse: a second call passes the cached handle back through.
  const reused = validateJson(plan.json, valid.handle, validBytes);
  check(
    "handle reuse: same handle, status 0",
    reused.available && reused.handle === valid.handle && reused.verdict?.status === 0,
    reused,
  );

  // Compile dedupe: a fresh call with no handle resolves to the same handle.
  const deduped = validateJson(plan.json, null, validBytes);
  check("compile dedupe: identical plan shares the handle", deduped.handle === valid.handle, {
    first: valid.handle,
    second: deduped.handle,
  });

  // Valid but rewritten: the unknown key is stripped, so status 1.
  const stripped = validateJson(plan.json, valid.handle, stripBytes);
  check("unknown key: status 1 (rewritten)", stripped.verdict?.status === 1, stripped.verdict);
  const strippedPayload = stripped.verdict?.payload;
  check(
    "unknown key: payload holds canonical output",
    typeof strippedPayload === "string" && JSON.stringify(JSON.parse(strippedPayload)) === '{"a":"abcd"}',
    strippedPayload,
  );

  // Invalid: status 2 with a raw issue array.
  const invalid = validateJson(plan.json, valid.handle, invalidBytes);
  check("invalid input: status 2 (issues)", invalid.verdict?.status === 2, invalid.verdict);
  const issuePayload = invalid.verdict?.payload;
  const issues = typeof issuePayload === "string" ? (JSON.parse(issuePayload) as unknown) : null;
  check(
    "invalid input: too_small issue for a",
    Array.isArray(issues) &&
      issues.length === 1 &&
      issues[0] !== null &&
      typeof issues[0] === "object" &&
      "code" in issues[0] &&
      issues[0].code === "too_small" &&
      "path" in issues[0] &&
      JSON.stringify(issues[0].path) === '["a"]',
    issues,
  );
}

for (const line of loaderDiagnostics) emit({ diagnostic: line });
emit({ tier, failures });
if (failures > 0) process.exitCode = 1;
