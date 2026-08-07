/**
 * Ambient declarations for the `node:module` built-in.
 * The project does not depend on @types/node, so these are hand-written.
 */
declare module "node:module" {
  export function createRequire(filename: string): NodeRequire;
}

interface NodeRequire {
  (id: string): unknown;
  resolve(id: string): string;
  readonly cache: Record<string, unknown>;
}
