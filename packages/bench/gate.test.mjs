import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { COMPARISONS, evaluateGate, medianOfThree } from "./gate.mjs";

const root = mkdtempSync(join(tmpdir(), "zodrs-bench-gate-"));
after(() => rmSync(root, { recursive: true, force: true }));

function writeRun(name, zodrs, zod4) {
  const directory = join(root, name);
  mkdirSync(directory);
  for (const comparison of COMPARISONS) {
    writeFileSync(
      join(directory, comparison.file),
      `${JSON.stringify({
        results: {
          [comparison.zodrs]: { avgOpsPerSec: zodrs },
          [comparison.zod4]: { avgOpsPerSec: zod4 },
        },
      })}\n`,
    );
  }
  return directory;
}

test("medianOfThree returns the middle finite measurement", () => {
  assert.equal(medianOfThree([30, 10, 20]), 20);
  assert.throws(() => medianOfThree([10, 20]));
  assert.throws(() => medianOfThree([10, 0, 20]));
});

test("evaluateGate compares the median throughput for every required suite", () => {
  const directories = [writeRun("pass-1", 110, 90), writeRun("pass-2", 90, 80), writeRun("pass-3", 100, 95)];
  const results = evaluateGate(directories);

  assert.equal(results.length, COMPARISONS.length);
  assert.ok(results.every((result) => result.pass));
  assert.ok(results.every((result) => result.zodrs === 100 && result.zod4 === 90));
});

test("evaluateGate rejects a median regression", () => {
  const directories = [writeRun("fail-1", 70, 90), writeRun("fail-2", 80, 100), writeRun("fail-3", 120, 110)];
  const results = evaluateGate(directories);

  assert.ok(results.every((result) => !result.pass));
  assert.ok(results.every((result) => result.ratio < 1));
});

test("evaluateGate rejects malformed benchmark output", () => {
  const directories = [writeRun("bad-1", 100, 90), writeRun("bad-2", 100, 90), writeRun("bad-3", 100, 90)];
  writeFileSync(join(directories[1], COMPARISONS[0].file), '{"results":{}}\n');

  assert.throws(() => evaluateGate(directories), /avgOpsPerSec/);
});

test("evaluateGate rejects a repeated result directory", () => {
  const run = writeRun("repeat-1", 100, 90);
  const other = writeRun("repeat-2", 100, 90);

  assert.throws(() => evaluateGate([run, run, other]), /distinct/);
});

test("evaluateGate rejects a filesystem alias that resolves to the same directory", () => {
  const real = writeRun("alias-real", 100, 90);
  const alias = join(root, "alias-link");
  symlinkSync(real, alias, "dir");
  const other = writeRun("alias-other", 100, 90);

  assert.throws(() => evaluateGate([real, alias, other]), /distinct/);
});

test("evaluateGate fails closed for a missing result directory", () => {
  const a = writeRun("missing-a", 100, 90);
  const b = writeRun("missing-b", 100, 90);

  assert.throws(() => evaluateGate([a, b, join(root, "does-not-exist")]), /ENOENT|distinct/);
});
