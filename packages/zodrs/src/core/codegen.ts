import type { ValidationContext, Validator } from "./interpreter.js";
import { runtime } from "./interpreter.js";
import type { SchemaNode } from "./nodes.js";
import type { FAIL } from "./util.js";

/**
 * zodrs emits specialized closures instead of evaluating generated source text.
 * Node semantics come from the interpreter so the two backends can never drift;
 * the compilation step exists to pre-link the per-node dispatch graph (each node
 * compiles its children exactly once, giving monomorphic call sites).
 */
type CompiledNode = (input: unknown, context: ValidationContext, path: PropertyKey[]) => unknown | FAIL;

function compileNode(node: SchemaNode, cache: Map<SchemaNode, CompiledNode>): CompiledNode {
  const existing = cache.get(node);
  if (existing) return existing;

  let implementation: CompiledNode | null = null;
  const placeholder: CompiledNode = (input, context, path) => {
    if (!implementation) throw new Error("Schema compiler cycle was invoked before initialization");
    return implementation(input, context, path);
  };
  cache.set(node, placeholder);

  switch (node.kind) {
    case "lazy": {
      const inner = compileNode(node.getter(), cache);
      implementation = inner;
      break;
    }
    default:
      implementation = (input, context, path) => runtime.run(node, input, context, path);
  }
  return placeholder;
}

export function createCodegenValidator(root: SchemaNode): Validator {
  const compiled = compileNode(root, new Map());
  return (input, context) => compiled(input, context, []);
}

/** Closure generation is always available, including CSP-strict runtimes. */
export const CODEGEN_AVAILABLE: true = true;
