import type { ValidationContext, Validator } from "./interpreter.js";
import { runtime } from "./interpreter.js";
import type { SchemaNode } from "./nodes.js";
import { isObject } from "./util.js";
import type { FAIL } from "./util.js";

/**
 * zodrs emits specialized closures instead of evaluating generated source text.
 * This preserves the codegen backend's monomorphic, straight-line hot paths
 * without turning schema data into executable JavaScript.
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
    case "string":
      implementation = (input, context, path) => {
        const value = node.coerce ? String(input) : input;
        if (typeof value !== "string") {
          runtime.typeIssue(context, node, path, "string", value);
          return runtime.FAIL;
        }
        return node.checks.length === 0 ? value : runtime.applyChecks(node, value, context, path);
      };
      break;
    case "number":
      implementation = (input, context, path) => {
        const value = node.coerce ? Number(input) : input;
        if (typeof value !== "number" || Number.isNaN(value)) {
          runtime.typeIssue(context, node, path, "number", value);
          return runtime.FAIL;
        }
        return node.checks.length === 0 ? value : runtime.applyChecks(node, value, context, path);
      };
      break;
    case "bigint":
      implementation = (input, context, path) => {
        let value = input;
        if (node.coerce) {
          try { value = BigInt(input as string | number | bigint | boolean); } catch { value = input; }
        }
        if (typeof value !== "bigint") {
          runtime.typeIssue(context, node, path, "bigint", value);
          return runtime.FAIL;
        }
        return node.checks.length === 0 ? value : runtime.applyChecks(node, value, context, path);
      };
      break;
    case "boolean":
      implementation = (input, context, path) => {
        const value = node.coerce ? Boolean(input) : input;
        if (typeof value !== "boolean") {
          runtime.typeIssue(context, node, path, "boolean", value);
          return runtime.FAIL;
        }
        return value;
      };
      break;
    case "object": {
      const entries = Object.entries(node.shape).map(([key, child]) => ({ key, validate: compileNode(child, cache) }));
      const known: Record<string, true> = {};
      for (const entry of entries) known[entry.key] = true;
      const catchall = node.catchall ? compileNode(node.catchall, cache) : null;
      implementation = (input, context, path) => {
        if (!isObject(input)) {
          runtime.typeIssue(context, node, path, "object", input);
          return runtime.FAIL;
        }
        const output: Record<string, unknown> = {};
        let failed = false;
        for (const entry of entries) {
          const present = Object.prototype.hasOwnProperty.call(input, entry.key);
          const value = entry.validate(present ? input[entry.key] : undefined, context, [...path, entry.key]);
          if (value === runtime.FAIL) failed = true;
          else if (present || value !== undefined) Object.defineProperty(output, entry.key, { value, enumerable: true, writable: true, configurable: true });
        }
        const extras = Object.keys(input).filter((key) => !known[key]);
        if (catchall) {
          for (const key of extras) {
            const value = catchall(input[key], context, [...path, key]);
            if (value === runtime.FAIL) failed = true; else output[key] = value;
          }
        } else if (node.mode === "passthrough") {
          for (const key of extras) output[key] = input[key];
        } else if (node.mode === "strict" && extras.length > 0) {
          runtime.keyIssue(context, node, path, extras, input);
          failed = true;
        }
        if (failed) { if (node.checks.length > 0) runtime.applyChecks(node, input, context, path); return runtime.FAIL; }
        return node.checks.length === 0 ? output : runtime.applyChecks(node, output, context, path);
      };
      break;
    }
    case "array": {
      const element = compileNode(node.element, cache);
      implementation = (input, context, path) => {
        if (!Array.isArray(input)) {
          runtime.typeIssue(context, node, path, "array", input);
          return runtime.FAIL;
        }
        const output: unknown[] = [];
        let failed = false;
        for (let index = 0; index < input.length; index += 1) {
          const value = element(input[index], context, [...path, index]);
          if (value === runtime.FAIL) failed = true; else output.push(value);
        }
        if (failed) { if (node.checks.length > 0) runtime.applyChecks(node, input, context, path); return runtime.FAIL; }
        return node.checks.length === 0 ? output : runtime.applyChecks(node, output, context, path);
      };
      break;
    }
    case "union": {
      const options = node.options.map((option) => compileNode(option, cache));
      implementation = (input, context, path) => {
        for (const option of options) {
          const branch: ValidationContext = { ...context, issues: null };
          const result = option(input, branch, path);
          if (result !== runtime.FAIL) return result;
        }
        return runtime.run(node, input, context, path);
      };
      break;
    }
    case "discunion": {
      const options = new Map<unknown, CompiledNode>();
      for (const [value, child] of node.map) options.set(value, compileNode(child, cache));
      implementation = (input, context, path) => {
        if (!isObject(input)) return runtime.run(node, input, context, path);
        const option = options.get(input[node.key]);
        return option ? option(input, context, path) : runtime.run(node, input, context, path);
      };
      break;
    }
    case "optional": {
      const inner = compileNode(node.inner, cache);
      implementation = (input, context, path) => input === undefined ? undefined : inner(input, context, path);
      break;
    }
    case "nullable": {
      const inner = compileNode(node.inner, cache);
      implementation = (input, context, path) => input === null ? null : inner(input, context, path);
      break;
    }
    case "readonly": {
      const inner = compileNode(node.inner, cache);
      implementation = (input, context, path) => {
        const output = inner(input, context, path);
        if (output !== runtime.FAIL && typeof output === "object" && output !== null) Object.freeze(output);
        return output;
      };
      break;
    }
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
