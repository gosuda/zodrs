import { defineConfig } from "vitest/config";

/**
 * Conformance harness for zodrs.
 *
 * Four loader/backend tiers run the same vendored test tree (tests/**)
 * so every configuration exercises identical assertions:
 *
 *   codegen      — default; closure-compiled codegen backend, native addon
 *   interpreter  — tree-walking interpreter backend (ZODRS_BACKEND=interpreter)
 *   wasm         — WASM loader tier (ZODRS_LOADER=wasm)
 *   none         — TypeScript-only fallback, no native/WASM (ZODRS_LOADER=none)
 *
 * A fifth project, `differential`, points at differential/ where the
 * differential fuzz generator will land (later task). The directory is
 * empty for now; passWithNoTests keeps the config valid.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        root: import.meta.dirname,
        test: {
          name: "codegen",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        root: import.meta.dirname,
        test: {
          name: "interpreter",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          env: {
            ZODRS_BACKEND: "interpreter",
          },
        },
      },
      {
        root: import.meta.dirname,
        test: {
          name: "wasm",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          env: {
            ZODRS_LOADER: "wasm",
          },
        },
      },
      {
        root: import.meta.dirname,
        test: {
          name: "none",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          env: {
            ZODRS_LOADER: "none",
          },
        },
      },
      {
        root: new URL("./differential", import.meta.url).pathname,
        test: {
          name: "differential",
          include: ["**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
