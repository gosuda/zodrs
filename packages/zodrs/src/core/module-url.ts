/**
 * Isolated `import.meta.url` access — ESM build only.
 *
 * The CJS build excludes this file and compiles `module-url-cjs.ts` instead
 * (selected via the `#module-url` path alias in `tsconfig.cjs.json`). Both
 * export the same `moduleUrl` string so `loader.ts` can call
 * `createRequire(moduleUrl)` uniformly.
 */
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

export const moduleUrl: string = import.meta.url;
