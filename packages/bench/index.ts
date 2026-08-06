/**
 * Bench CLI — mirrors Zod's own bench/index.ts.
 *
 * Usage:  pnpm -C packages/bench run object,string,number,...
 *
 * Each argument is a comma-separated list of suite names. Each suite is a
 * sibling .ts file that registers mitata benchmarks and calls `bench.run()`.
 */
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(
      "Usage: pnpm -C packages/bench run <suite1>,<suite2>,...\n" +
        "Suites: object object-safe string number datetime union discriminated-union array init\n",
    );
    process.exit(1);
  }

  const suites = arg.split(",").map((s) => s.trim()).filter(Boolean);

  for (const suite of suites) {
    const file = resolve(__dirname, `${suite}.ts`);
    // Dynamic import: suite name is runtime-selected from CLI args, not known at author time.
    await import(pathToFileURL(file).href);
  }
}

main().catch((err) => {
  process.stderr.write(`bench: ${err?.stack ?? err}\n`);
  process.exit(1);
});

process.on("SIGINT", () => {
  process.exit(0);
});
