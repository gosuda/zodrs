/**
 * Benchmark runner abstraction built on mitata 1.0.34.
 *
 * Mirrors the shape of Zod's own metabench.ts: a `metabench(name, benchmarks)`
 * factory that registers named functions in a mitata group. Isolated runs add
 * their filter and forced backend to the result filename so they cannot
 * overwrite the full-matrix baseline.
 */
import { bench, do_not_optimize, group, run as mitataRun } from "mitata";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Prevents V8 from eliminating measured work whose result the caller ignores. */
export const consume: (value: unknown) => void = do_not_optimize;
export type Benchmarks = Record<string, () => void>;

export type SuiteResults = Record<string, { avgOpsPerSec: number }>;

export interface SuiteResult {
  suite: string;
  results: SuiteResults;
}

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(BENCH_DIR, "results");
const BENCH_FILTER = process.env.BENCH_FILTER?.trim() || undefined;
const LOADER = process.env.ZODRS_LOADER?.trim() || undefined;
const BACKEND = process.env.ZODRS_BACKEND?.trim() || undefined;
let filterMatched = BENCH_FILTER === undefined;

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const RESULT_DIMENSIONS = [
  BENCH_FILTER === undefined ? undefined : slug(BENCH_FILTER),
  LOADER === undefined ? undefined : `loader-${slug(LOADER)}`,
  BACKEND === undefined ? undefined : `backend-${slug(BACKEND)}`,
].filter((dimension): dimension is string => dimension !== undefined);

if (BENCH_FILTER !== undefined) {
  process.on("beforeExit", () => {
    if (filterMatched) return;
    process.stderr.write(`No benchmark callback matches BENCH_FILTER=${JSON.stringify(BENCH_FILTER)}\n`);
    process.exitCode = 2;
  });
}

/** Write machine-readable JSON for a suite. */
export function writeResult(suite: string, results: SuiteResults): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload: SuiteResult = { suite, results };
  const outPath = join(RESULTS_DIR, `${[suite, ...RESULT_DIMENSIONS].join(".")}.json`);
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
    const entries = Object.entries(this.benchmarks).filter(
      ([name]) => BENCH_FILTER === undefined || name === BENCH_FILTER,
    );
    if (entries.length === 0) return;
    filterMatched = true;

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

    const suiteSlug = slug(this.name);
    writeResult(suiteSlug, results);
  }
}

export function metabench(name: string, benchmarks?: Benchmarks): Metabench {
  return new Metabench(name, benchmarks);
}
