import { defineConfig } from "vitest/config";

// `tsc` emits the `*.test.ts` sources into `dist/` and `dist-cjs/` alongside
// the shipped code. Without this, vitest collects those compiled copies too:
// every test runs twice, and the CJS copies fail outright because vitest
// cannot be `require`d. Only the TypeScript sources are the suite.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "dist-cjs/**"],
  },
});
