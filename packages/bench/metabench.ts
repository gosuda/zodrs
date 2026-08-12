/**
 * Benchmark runner abstraction built on Tinybench 6.1.3.
 *
 * Mirrors the shape of Zod's own metabench.ts: a `metabench(name, benchmarks)`
 * factory that registers named functions in one benchmark suite. Isolated runs
 * add their filter and forced backend to the result filename so they cannot
 * overwrite the full-matrix baseline.
 */
import { Bench } from "tinybench";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** V8 must observe benchmark results so it cannot eliminate measured work. */
export let benchmarkResultSink: unknown;
export function consume(value: unknown): void {
  benchmarkResultSink = value;
}
export type Benchmarks = Record<string, () => void>;

export type SuiteResults = Record<string, { avgOpsPerSec: number }>;

export interface SuiteResult {
  suite: string;
  results: SuiteResults;
}

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR?.trim() || join(BENCH_DIR, "results");
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

    const benchmark = new Bench({ name: this.name, throws: true });
    for (const [name, fn] of entries) benchmark.add(name, fn);

    const tasks = await benchmark.run();
    console.table(benchmark.table());

    const results: SuiteResults = {};
    for (const task of tasks) {
      if (task.result.state !== "completed") {
        throw new Error(`benchmark ${JSON.stringify(task.name)} ended in state ${task.result.state}`);
      }
      const latencyMs = task.result.latency.mean;
      const opsPerSec = latencyMs > 0 ? 1000 / latencyMs : 0;
      results[task.name] = {
        avgOpsPerSec: Number.isFinite(opsPerSec) ? Math.round(opsPerSec) : 0,
      };
    }

    const suiteSlug = slug(this.name);
    writeResult(suiteSlug, results);
  }
}

export function metabench(name: string, benchmarks?: Benchmarks): Metabench {
  return new Metabench(name, benchmarks);
}
