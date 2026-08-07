import type {
  Check,
  DynamicValue,
  HostFunction,
  NodeId,
  PlanNode,
  RuntimeCheck,
  SchemaNode,
} from "./nodes.js";
import type { JSONType, Primitive } from "./util.js";

export interface CompiledPlan {
  readonly json: string;
  readonly hostFns: HostFunction[];
  readonly jsonEligible: boolean;
}

/**
 * `Object.prototype` members, minus `__proto__` which every layer already
 * special-cases. A shape key naming one of these reads through the prototype
 * on a plain object, which the byte path cannot reproduce. Derived from the
 * runtime rather than hand-listed, so it cannot drift.
 */
const PROTO_KEYS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype).filter((k) => k !== "__proto__"),
);

interface EmitState {
  readonly nodes: (PlanNode | null)[];
  readonly ids: Map<SchemaNode, NodeId>;
  readonly hostFns: HostFunction[];
  /** Set when a bigint node is emitted; `compilePlan` explains why that disqualifies the byte path. */
  bigint: boolean;
  /** Set when a shape key names an `Object.prototype` member; see `PROTO_KEYS`. */
  protoKey: boolean;
}

function toJsonValue(value: unknown): JSONType | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry) ?? null);
  if (typeof value === "object") {
    const out: Record<string, JSONType> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJsonValue(entry) ?? null;
    return out;
  }
  return null;
}

/** Convert a build-time check into its wire form, hoisting host closures. */
function emitCheck(check: RuntimeCheck, state: EmitState): Check {
  const inner = check.check;
  if (inner.c === "host_runtime") {
    const fn = state.hostFns.length;
    state.hostFns.push(inner.fn);
    return { c: "host", fn };
  }
  if (inner.c === "property") {
    return { c: "property", key: inner.key, node: emit(inner.schema, state) };
  }
  return inner;
}

function emitChecks(checks: readonly RuntimeCheck[], state: EmitState): Check[] {
  return checks.map((check) => emitCheck(check, state));
}

function serialize(schema: SchemaNode, state: EmitState): PlanNode {
  switch (schema.kind) {
    case "string":
    case "number":
    case "bigint":
    case "date":
    case "file": {
      if (schema.kind === "bigint") state.bigint = true;
      const base = { k: schema.kind, checks: emitChecks(schema.checks, state) };
      return schema.coerce ? { ...base, coerce: true } : base;
    }
    case "boolean":
      return schema.coerce ? { k: "boolean", coerce: true } : { k: "boolean" };
    case "null":
    case "undefined":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "symbol":
    case "nan":
      return { k: schema.kind };
    case "function": {
      // Functions are host-only: they cannot cross into Rust, so emit a host
      // node that poisons JSON eligibility while the TS backends validate typeof.
      state.hostFns.push(() => true);
      return { k: "host", inner: null, fn: state.hostFns.length - 1 };
    }
    case "literal":
      return { k: "literal", values: schema.values.map(normalizeLiteral) };
    case "enum":
      return { k: "enum", values: [...schema.values] };
    case "object": {
      const keys = Object.keys(schema.shape);
      const values: NodeId[] = [];
      const optional: boolean[] = [];
      for (const key of keys) {
        // A shape key that names an `Object.prototype` member resolves
        // through the prototype when absent from the input, so the TS walk
        // sees `Object.prototype.constructor` where the byte scanner sees
        // only a missing key. `__proto__` is already handled everywhere.
        if (PROTO_KEYS.has(key)) state.protoKey = true;
        const child = schema.shape[key];
        if (!child) continue;
        values.push(emit(child, state));
        optional.push(isOptionalNode(child));
      }
      return {
        k: "object",
        keys,
        values,
        optional,
        mode: schema.mode,
        catchall: schema.catchall ? emit(schema.catchall, state) : null,
      };
    }
    case "array":
      return { k: "array", element: emit(schema.element, state), checks: emitChecks(schema.checks, state) };
    case "tuple":
      return {
        k: "tuple",
        items: schema.items.map((item) => emit(item, state)),
        rest: schema.rest ? emit(schema.rest, state) : null,
      };
    case "union":
      return { k: "union", options: schema.options.map((option) => emit(option, state)) };
    case "discunion":
      return {
        k: "discunion",
        key: schema.key,
        map: [...schema.map.entries()].map(([value, target]) => [normalizeLiteral(value), emit(target, state)]),
      };
    case "intersection":
      return { k: "intersection", left: emit(schema.left, state), right: emit(schema.right, state) };
    case "record":
      return { k: "record", key: emit(schema.key, state), value: emit(schema.value, state) };
    case "map":
      return { k: "map", key: emit(schema.key, state), value: emit(schema.value, state), checks: emitChecks(schema.checks, state) };
    case "set":
      return { k: "set", value: emit(schema.value, state), checks: emitChecks(schema.checks, state) };
    case "optional":
    case "exactOptional":
    case "nullable":
    case "nonoptional":
    case "readonly":
    case "promise":
      // exactOptional is input-side optional on the wire (the Rust byte path does not
      // run refines); the TS backends distinguish it via the in-memory node kind.
      return { k: schema.kind === "exactOptional" ? "optional" : schema.kind, inner: emit(schema.inner, state) };
    case "lazy":
      return { k: "lazy", inner: emit(schema.getter(), state) };
    case "default":
    case "prefault":
    case "catch": {
      if (schema.dynamic) {
        const fn = state.hostFns.length;
        state.hostFns.push(dynamicToHost(schema.value));
        return { k: "host", inner: emit(schema.inner, state), fn };
      }
      return { k: schema.kind, inner: emit(schema.inner, state), value: toJsonValue(schema.value), dynamic: false };
    }
    case "pipe":
      return { k: "pipe", a: emit(schema.a, state), b: emit(schema.b, state) };
    case "templateLiteral":
      return { k: "templateLiteral", pattern: schema.pattern.source };
    case "host": {
      const fn = state.hostFns.length;
      state.hostFns.push(schema.fn);
      return { k: "host", inner: schema.inner ? emit(schema.inner, state) : null, fn };
    }
  }
}

function dynamicToHost(value: unknown): HostFunction {
  const producer = value as DynamicValue;
  return (input) => producer({ input });
}

function normalizeLiteral(value: Primitive): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

function isOptionalNode(schema: SchemaNode): boolean {
  if (schema.kind === "optional" || schema.kind === "default" || schema.kind === "prefault") return true;
  if (schema.kind === "readonly") return isOptionalNode(schema.inner);
  if (schema.kind === "catch") return isOptionalNode(schema.inner);
  return false;
}

/** Assign a stable id, reserving the slot before recursing so cycles become back-edges. */
function emit(schema: SchemaNode, state: EmitState): NodeId {
  const existing = state.ids.get(schema);
  if (existing !== undefined) return existing;
  const id = state.nodes.length;
  state.nodes.push(null);
  state.ids.set(schema, id);
  state.nodes[id] = serialize(schema, state);
  return id;
}

export function compilePlan(root: SchemaNode): CompiledPlan {
  const state: EmitState = { nodes: [], ids: new Map(), hostFns: [], bigint: false, protoKey: false };
  emit(root, state);
  return {
    json: JSON.stringify(state.nodes),
    hostFns: state.hostFns,
    // Two shapes disqualify the byte path outright. A bigint node parses to a
    // JS `BigInt`, which has no JSON encoding, so the Rust walk can neither
    // return the right value nor compare against bounds the plan carries as
    // decimal strings. A shape key naming an `Object.prototype` member reads
    // through the prototype when absent, which the scanner cannot see. The TS
    // path owns both.
    jsonEligible: state.hostFns.length === 0 && !state.bigint && !state.protoKey,
  };
}
