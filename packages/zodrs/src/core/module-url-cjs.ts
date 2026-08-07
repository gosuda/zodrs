/**
 * CJS shim for `#module-url`.
 *
 * `__filename` is injected by the Node CommonJS module wrapper and is
 * available at runtime in `module: commonjs` emit. `createRequire` accepts
 * a plain path (not just a `file://` URL), so this is a drop-in for the
 * ESM `import.meta.url` value.
 */
declare const __filename: string;

export const moduleUrl: string = __filename;
