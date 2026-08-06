/**
 * Type-level cost bench runner for @zodrs/tsc-bench.
 *
 * For each library (zodrs, zod4): generate the identical corpus, run
 * `tsc -p tsconfig.bench.json --extendedDiagnostics`, parse Instantiations and
 * Check time, then print a comparison and write results/tsc-results.json.
 *
 * Acceptance target (checked by the orchestrator, not here):
 *   zodrs instantiations <= zod4 instantiations on the same corpus.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCorpus, type Lib } from "./generate.ts";

const ROOT = import.meta.dirname;
const TSC_BIN = resolve(ROOT, "node_modules/.bin/tsc");
const TSCONFIG = resolve(ROOT, "tsconfig.bench.json");
const RESULTS_DIR = resolve(ROOT, "results");
const RESULTS_FILE = resolve(RESULTS_DIR, "tsc-results.json");

interface VariantResult {
  lib: Lib;
  instantiations: number;
  checkTimeMs: number;
}

function runTsc(): string {
  try {
    return execFileSync(TSC_BIN, ["-p", TSCONFIG, "--extendedDiagnostics"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    // tsc exits non-zero on type errors; stdout still carries diagnostics.
    if (e.stdout) return e.stdout;
    throw err;
  }
}

function parseDiagnostics(out: string): { instantiations: number; checkTimeMs: number } {
  const inst = /Instantiations:\s*([\d,]+)/.exec(out);
  const time = /Check time:\s*([\d.]+)\s*s/.exec(out);
  if (!inst || !time || !inst[1] || !time[1]) {
    throw new Error(
      `Could not parse tsc extendedDiagnostics output.\n--- output ---\n${out.slice(-2000)}`,
    );
  }
  return {
    instantiations: Number(inst[1].replace(/,/g, "")),
    checkTimeMs: Math.round(Number(time[1]) * 1000),
  };
}

function bench(lib: Lib): VariantResult {
  process.stdout.write(`\n╔══════════════════╗\n`);
  process.stdout.write(`║  ${lib.padEnd(14)}  ║\n`);
  process.stdout.write(`╚══════════════════╝\n`);
  const path = generateCorpus(lib);
  process.stdout.write(`generated: ${path}\n`);
  const raw = runTsc();
  const { instantiations, checkTimeMs } = parseDiagnostics(raw);
  process.stdout.write(`instantiations: ${instantiations.toLocaleString()}\n`);
  process.stdout.write(`check time:      ${(checkTimeMs / 1000).toFixed(2)}s\n`);
  return { lib, instantiations, checkTimeMs };
}

function main() {
  const results: VariantResult[] = [bench("zodrs"), bench("zod4")];

  const [zodrs, zod4] = results;
  if (!zodrs || !zod4) throw new Error("expected two results");
  const delta = zodrs.instantiations - zod4.instantiations;
  const ratio = (zodrs.instantiations / zod4.instantiations).toFixed(3);

  const bar = "═══════════════════════════════════════════════════════════";
  process.stdout.write(`\n${bar}\n`);
  process.stdout.write(`  lib       instantiations     check time\n`);
  process.stdout.write(`  zodrs     ${zodrs.instantiations.toLocaleString().padStart(14)}     ${zodrs.checkTimeMs}ms\n`);
  process.stdout.write(`  zod4      ${zod4.instantiations.toLocaleString().padStart(14)}     ${zod4.checkTimeMs}ms\n`);
  process.stdout.write(`  delta     ${delta >= 0 ? "+" : ""}${delta.toLocaleString().padStart(13)}   (zodrs/zod4 = ${ratio})\n`);
  process.stdout.write(`${bar}\n`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n", { flag: "w" });
  process.stdout.write(`wrote: ${RESULTS_FILE}\n`);
}

main();
