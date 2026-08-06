/**
 * Benchmark runner abstraction built on mitata 1.0.34.
 *
 * Mirrors the shape of Zod's own metabench.ts: a `metabench(name, benchmarks)`
 * factory that registers named benchmark functions and runs them as a mitata
 * group. The key addition over Zod's version is machine-readable result capture:
 * after `bench.run()` the per-library ops/sec averages are collected and written
 * to `results/<suite>.json` so the orchestrator can check thresholds
 * programmatically.
 */
import { bench, group, run as mitataRun } from "mitata";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Benchmarks = Record<string, () => void>;

export type SuiteResults = Record<string, { avgOpsPerSec: number }>;

export interface SuiteResult {
  suite: string;
  results: SuiteResults;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

/** Write machine-readable JSON for a suite. */
export function writeResult(suite: string, results: SuiteResults): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload: SuiteResult = { suite, results };
  const outPath = join(RESULTS_DIR, `${suite}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  process.stdout.write(`\n  results written to ${outPath}\n`);
}

export class Metabench {
  private benchmarks: Benchmarks;

  constructor(
    public name: string,
    benchmarks: Benchmarks = {},
  ) {
    this.benchmarks = benchmarks;
  }

  add(name: string, fn: () => void): this {
    this.benchmarks[name] = fn;
    return this;
  }

  async run(): Promise<void> {
    const entries = Object.entries(this.benchmarks);

    // Register all benchmarks inside a mitata group so they share a header.
    group(this.name, () => {
      for (const [name, fn] of entries) {
        bench(name, fn);
      }
    });

    // `run` returns { context, benchmarks: trial[] }. Each trial has `runs[]`
    // where each run carries `stats.avg` in nanoseconds per iteration.
    // ops/sec = 1e9 / avg.
    const result = await mitataRun({ format: "mitata" });

    const results: SuiteResults = {};
    for (const trial of result.benchmarks) {
      for (const runEntry of trial.runs) {
        if (runEntry.stats && runEntry.stats.avg > 0) {
          const opsPerSec = Math.round(1e9 / runEntry.stats.avg);
          results[runEntry.name] = { avgOpsPerSec: opsPerSec };
        } else {
          results[runEntry.name] = { avgOpsPerSec: 0 };
        }
      }
    }

    // Derive the suite name from the file that called run() — fall back to the
    // group name with spaces replaced by dashes.
    const suiteSlug = this.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    writeResult(suiteSlug, results);
  }
}

export function metabench(name: string, benchmarks?: Benchmarks): Metabench {
  return new Metabench(name, benchmarks);
}
