import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const COMPARISONS = Object.freeze([
  { file: "z-object-parse.json", zodrs: "zodrs", zod4: "zod4" },
  {
    file: "object-safeParseJson-4KB-payload.json",
    zodrs: "zodrs.safeParseJson",
    zod4: "zod4 (JSON.parse + safeParse)",
  },
  { file: "z-object-safeParse.json", zodrs: "zodrs", zod4: "zod4" },
  { file: "z-string-parse.json", zodrs: "zodrs", zod4: "zod4" },
  { file: "z-number-parse.json", zodrs: "zodrs", zod4: "zod4" },
  { file: "z-string-datetime-parse.json", zodrs: "zodrs", zod4: "zod4" },
  { file: "z-union-parse.json", zodrs: "zodrs", zod4: "zod4" },
  { file: "z-discriminatedUnion-parse.json", zodrs: "zodrs", zod4: "zod4" },
  { file: "z-array-parse.json", zodrs: "zodrs", zod4: "zod4" },
  {
    file: "z-object-schema-initialization-1000-schemas.json",
    zodrs: "zodrs",
    zod4: "zod4",
  },
]);

export function medianOfThree(values) {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`expected three positive finite measurements, got ${JSON.stringify(values)}`);
  }
  return values.toSorted((left, right) => left - right)[1];
}

function readOps(directory, comparison, implementation) {
  const path = join(directory, comparison.file);
  const document = JSON.parse(readFileSync(path, "utf8"));
  const value = document?.results?.[implementation]?.avgOpsPerSec;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} has no positive avgOpsPerSec for ${JSON.stringify(implementation)}`);
  }
  return value;
}

export function evaluateGate(directories) {
  if (directories.length !== 3) {
    throw new Error(`expected three result directories, got ${directories.length}`);
  }

  const canonical = directories.map((directory) => realpathSync(directory));
  if (new Set(canonical).size !== 3) {
    throw new Error("expected three distinct result directories");
  }

  return COMPARISONS.map((comparison) => {
    const zodrs = medianOfThree(canonical.map((directory) => readOps(directory, comparison, comparison.zodrs)));
    const zod4 = medianOfThree(canonical.map((directory) => readOps(directory, comparison, comparison.zod4)));
    return {
      suite: basename(comparison.file, ".json"),
      zodrs,
      zod4,
      ratio: zodrs / zod4,
      pass: zodrs >= zod4,
    };
  });
}

function main() {
  const results = evaluateGate(process.argv.slice(2));
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
