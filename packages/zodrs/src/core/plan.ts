import type {
  Check,
  HostFunction,
  NodeId,
  PlanNode,
  RuntimeCheck,
  SchemaNode,
} from "./nodes.js";
import { optinOf } from "./introspect.js";
import type { JSONType } from "./util.js";

export interface CompiledPlan {
  readonly json: string;
  readonly hostFns: HostFunction[];
  readonly jsonEligible: boolean;
  /** All object shape keys emitted into the plan, for live prototype-pollution checks. */
  readonly objectShapeKeys: readonly string[];
}

/**
 * `Object.prototype` members. A shape key naming one of these reads through the
 * prototype when the input omits the key, so the TS walk sees the inherited
 * member where the byte scanner sees only a missing key. `__proto__` belongs here too:
 * it is a real shape key once the schema declares one. Derived from the runtime
 * rather than hand-listed, so it cannot drift.
 */
// PROTO_KEYS is now checked live against Object.prototype at emit time (see below).

interface EmitState {
  readonly nodes: (PlanNode | null)[];
  readonly ids: Map<SchemaNode, NodeId>;
  readonly hostFns: HostFunction[];
  /** Set when a bigint node is emitted; `compilePlan` explains why that disqualifies the byte path. */
  bigint: boolean;
  /** Set when a shape key names an `Object.prototype` member; see `PROTO_KEYS`. */
  protoKey: boolean;
  /** Set when any node, check, or static value is unsupported for the wire. */
  unsupported: boolean;
  readonly objectShapeKeys: Set<string>;
}

/** Scalar JSON literal: string, finite non-negative-zero number, boolean, or null. */
function toJsonLiteral(value: unknown, state: EmitState): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    state.unsupported = true;
    return null;
  }
  state.unsupported = true;
  return null;
}

/**
 * Total JSON representability check for static default/prefault/catch values.
 * Accepts only finite JSON primitives, arrays, and plain/null-prototype objects
 * with enumerable string keys and supported values. Shared acyclic references
 * may repeat; only current-path cycles poison. Never throws.
 */
function toJsonValue(value: unknown, state: EmitState, stack = new Set<unknown>()): JSONType | null {
  try {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value) && !Object.is(value, -0)) return value;
      state.unsupported = true;
      return null;
    }
    if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
      state.unsupported = true;
      return null;
    }

    if (Array.isArray(value)) {
      if (stack.has(value)) {
        state.unsupported = true;
        return null;
      }
      stack.add(value);
      try {
        const len = value.length;
        if (!Number.isInteger(len) || len < 0 || len > 0xFFFFFFFF) {
          state.unsupported = true;
          return null;
        }

        let keys: string[];
        try { keys = Object.keys(value); } catch { state.unsupported = true; return null; }
        if (keys.length !== len) { state.unsupported = true; return null; }
        for (const key of keys) {
          const n = Number(key);
          if (!Number.isInteger(n) || n < 0 || n >= len || String(n) !== key) { state.unsupported = true; return null; }
        }

        let symbols: symbol[];
        try { symbols = Object.getOwnPropertySymbols(value); } catch { state.unsupported = true; return null; }
        if (symbols.length > 0) { state.unsupported = true; return null; }

        const out: JSONType[] = [];
        for (let i = 0; i < len; i++) {
          let desc: PropertyDescriptor | undefined;
          try { desc = Object.getOwnPropertyDescriptor(value, i); } catch { state.unsupported = true; return null; }
          if (!desc) { state.unsupported = true; return null; }

          let entry: unknown;
          if (typeof desc.get === "function") {
            try { entry = desc.get.call(value); } catch { state.unsupported = true; return null; }
          } else if ("value" in desc) {
            entry = desc.value;
          } else { state.unsupported = true; return null; }

          const json = toJsonValue(entry, state, stack);
          if (state.unsupported) return null;
          out.push(json ?? null);
        }
        return out;
      } finally {
        stack.delete(value);
      }
    }

    if (typeof value === "object") {
      let tag: string;
      try { tag = Object.prototype.toString.call(value); } catch { state.unsupported = true; return null; }
      if (tag !== "[object Object]") { state.unsupported = true; return null; }

      let proto: unknown;
      try { proto = Object.getPrototypeOf(value); } catch { state.unsupported = true; return null; }
      if (proto !== Object.prototype && proto !== null) { state.unsupported = true; return null; }

      if (stack.has(value)) { state.unsupported = true; return null; }
      stack.add(value);
      try {
        let symbols: symbol[];
        try { symbols = Object.getOwnPropertySymbols(value); } catch { state.unsupported = true; return null; }
        if (symbols.length > 0) { state.unsupported = true; return null; }

        let keys: string[];
        try { keys = Object.keys(value); } catch { state.unsupported = true; return null; }

        const out = Object.create(null) as Record<string, JSONType>;
        for (const key of keys) {
          let desc: PropertyDescriptor | undefined;
          try { desc = Object.getOwnPropertyDescriptor(value, key); } catch { state.unsupported = true; return null; }
          if (!desc || !desc.enumerable) { state.unsupported = true; return null; }

          let entry: unknown;
          if (typeof desc.get === "function") {
            try { entry = desc.get.call(value); } catch { state.unsupported = true; return null; }
          } else if ("value" in desc) {
            entry = desc.value;
          } else { state.unsupported = true; return null; }

          const json = toJsonValue(entry, state, stack);
          if (state.unsupported) return null;
          out[key] = json ?? null;
        }
        return out;
      } finally {
        stack.delete(value);
      }
    }

    state.unsupported = true;
    return null;
  } catch {
    state.unsupported = true;
    return null;
  }
}

function poisonNode(state: EmitState): PlanNode {
  state.unsupported = true;
  return { k: "unsupported" };
}

function poisonCheck(state: EmitState): Check {
  state.unsupported = true;
  return { c: "unsupported" };
}

/** Convert a build-time check into its wire form, hoisting host closures. */
function emitCheck(check: RuntimeCheck, state: EmitState): Check {
  const inner = check.check;
  if (
    check.error != null ||
    check.abort === true ||
    check.when != null ||
    check.path != null ||
    check.params != null ||
    inner.c === "host_runtime" ||
    inner.c === "property"
  ) {
    return poisonCheck(state);
  }
  if (inner.c === "format" && inner.params !== undefined) {
    const params = toJsonValue(inner.params, state);
    if (state.unsupported || params === null || Array.isArray(params) || typeof params !== "object") {
      return poisonCheck(state);
    }
    return { ...inner, params };
  }
  return inner;
}

function emitChecks(checks: readonly RuntimeCheck[], state: EmitState): Check[] {
  return checks.map((check) => emitCheck(check, state));
}

/** Returns true when the record key node denotes a finite set of keys (exhaustive record). */
function isFiniteKeySet(node: SchemaNode): boolean {
  switch (node.kind) {
    case "enum":
    case "literal":
      return true;
    case "pipe":
      return isFiniteKeySet(node.a);
    case "union":
      return node.options.every(isFiniteKeySet);
    default:
      return false;
  }
}

function serialize(schema: SchemaNode, state: EmitState): PlanNode {
  if (schema.error != null) return poisonNode(state);

  switch (schema.kind) {
    case "string": {
      const checks = emitChecks(schema.checks, state);
      if (state.unsupported) return poisonNode(state);
      const base: { k: "string"; checks: Check[] } = { k: "string", checks };
      return schema.coerce ? { ...base, coerce: true } : base;
    }
    case "number": {
      const checks = emitChecks(schema.checks, state);
      if (state.unsupported) return poisonNode(state);
      const base: { k: "number"; checks: Check[] } = { k: "number", checks };
      return schema.coerce ? { ...base, coerce: true } : base;
    }
    case "bigint": {
      state.bigint = true;
      const checks = emitChecks(schema.checks, state);
      if (state.unsupported) return poisonNode(state);
      const base: { k: "bigint"; checks: Check[] } = { k: "bigint", checks };
      return schema.coerce ? { ...base, coerce: true } : base;
    }
    case "boolean": {
      if (schema.checks.length > 0) return poisonNode(state);
      return schema.coerce ? { k: "boolean", coerce: true } : { k: "boolean" };
    }
    case "null":
    case "undefined":
    case "any":
    case "unknown":
    case "never":
    case "void": {
      if (schema.checks.length > 0) return poisonNode(state);
      return { k: schema.kind };
    }
    case "date":
    case "file":
    case "symbol":
    case "nan":
    case "function":
    case "map":
    case "set":
    case "intersection":
    case "readonly":
    case "promise":
    case "pipe":
    case "host":
      return poisonNode(state);
    case "literal": {
      if (schema.checks.length > 0) return poisonNode(state);
      const values = schema.values.map((value) => toJsonLiteral(value, state));
      if (state.unsupported) return poisonNode(state);
      return { k: "literal", values };
    }
    case "enum": {
      if (schema.checks.length > 0) return poisonNode(state);
      const values = schema.values.map((value) => toJsonLiteral(value, state));
      if (state.unsupported) return poisonNode(state);
      if (values.some((v) => typeof v !== "string" && typeof v !== "number")) {
        state.unsupported = true;
        return poisonNode(state);
      }
      return { k: "enum", values: values as (string | number)[] };
    }
    case "object": {
      if (schema.checks.length > 0) return poisonNode(state);
      const keys = Object.keys(schema.shape);
      const values: NodeId[] = [];
      const optional: boolean[] = [];
      for (const key of keys) {
        state.objectShapeKeys.add(key);
        // A shape key that names an `Object.prototype` member resolves
        // through the prototype when absent from the input, so the TS walk
        // sees `Object.prototype.constructor` where the byte scanner sees
        // only a missing key. `__proto__` is already handled everywhere.
        if (Object.hasOwn(Object.prototype as object, key)) state.protoKey = true;
        const child = schema.shape[key];
        if (!child) continue;
        values.push(emit(child, state));
        if (state.unsupported) return poisonNode(state);
        optional.push(optinOf(child) === "optional");
      }
      const catchall = schema.catchall ? emit(schema.catchall, state) : null;
      if (state.unsupported) return poisonNode(state);
      return {
        k: "object",
        keys,
        values,
        optional,
        mode: schema.mode,
        catchall,
      };
    }
    case "array": {
      const checks = emitChecks(schema.checks, state);
      if (state.unsupported) return poisonNode(state);
      const element = emit(schema.element, state);
      if (state.unsupported) return poisonNode(state);
      return { k: "array", element, checks };
    }
    case "tuple": {
      if (schema.checks.length > 0) return poisonNode(state);
      const items = schema.items.map((item) => emit(item, state));
      if (state.unsupported) return poisonNode(state);
      const rest = schema.rest ? emit(schema.rest, state) : null;
      if (state.unsupported) return poisonNode(state);
      return { k: "tuple", items, rest };
    }
    case "union": {
      if (schema.checks.length > 0) return poisonNode(state);
      if (schema.inclusive === false) return poisonNode(state);
      const options = schema.options.map((option) => emit(option, state));
      if (state.unsupported) return poisonNode(state);
      return { k: "union", options };
    }
    case "discunion": {
      if (schema.checks.length > 0) return poisonNode(state);
      if (schema.unionFallback) return poisonNode(state);
      if (schema.invalidOptionIndex !== undefined) return poisonNode(state);
      const map: [string | number | boolean | null, NodeId][] = [];
      for (const [value, target] of schema.map.entries()) {
        const key = toJsonLiteral(value, state);
        if (state.unsupported) return poisonNode(state);
        const node = emit(target, state);
        if (state.unsupported) return poisonNode(state);
        map.push([key, node]);
      }
      return { k: "discunion", key: schema.key, map };
    }
    case "record": {
      if (schema.checks.length > 0) return poisonNode(state);
      if (schema.mode === "loose") return poisonNode(state);
      if (!schema.partial && isFiniteKeySet(schema.key)) return poisonNode(state);
      const key = emit(schema.key, state);
      if (state.unsupported) return poisonNode(state);
      const value = emit(schema.value, state);
      if (state.unsupported) return poisonNode(state);
      return { k: "record", key, value };
    }
    case "optional":
    case "exactOptional":
    case "nullable":
    case "nonoptional": {
      if (schema.checks.length > 0) return poisonNode(state);
      const inner = emit(schema.inner, state);
      if (state.unsupported) return poisonNode(state);
      return { k: schema.kind === "exactOptional" ? "exact_optional" : schema.kind, inner };
    }
    case "lazy": {
      if (schema.checks.length > 0) return poisonNode(state);
      const inner = emit(schema.getter(), state);
      if (state.unsupported) return poisonNode(state);
      return { k: "lazy", inner };
    }
    case "default":
    case "prefault":
    case "catch": {
      if (schema.checks.length > 0) return poisonNode(state);
      if (schema.dynamic) return poisonNode(state);
      // Compiled plans snapshot objects, but the TS schema keeps the caller's live reference.
      if (schema.value !== null && typeof schema.value === "object") return poisonNode(state);
      const inner = emit(schema.inner, state);
      if (state.unsupported) return poisonNode(state);
      const staticValue = toJsonValue(schema.value, state, new Set<unknown>());
      if (state.unsupported) return poisonNode(state);
      return { k: schema.kind, inner, value: staticValue, dynamic: false };
    }
    case "templateLiteral": {
      if (schema.checks.length > 0) return poisonNode(state);
      return { k: "templateLiteral", pattern: schema.pattern.source };
    }
  }
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
  const state: EmitState = { nodes: [], ids: new Map(), hostFns: [], bigint: false, protoKey: false, unsupported: false, objectShapeKeys: new Set<string>() };
  emit(root, state);
  return {
    json: JSON.stringify(state.nodes),
    hostFns: state.hostFns,
    // Three shapes disqualify the byte path outright. A bigint node parses to a
    // JS `BigInt`, which has no JSON encoding, so the Rust walk can neither
    // return the right value nor compare against bounds the plan carries as
    // decimal strings. A shape key naming an `Object.prototype` member reads
    // through the prototype when absent, which the scanner cannot see. Any
    // unsupported node/check/value means the wire plan cannot be trusted. The TS
    // path owns all three.
    jsonEligible: !state.unsupported && state.hostFns.length === 0 && !state.bigint && !state.protoKey,
    objectShapeKeys: [...state.objectShapeKeys],
  };
}

/** Live check for prototype pollution after `_zod.plan` was cached — checks only the keys that were actually emitted. */
export function isProtoPolluted(plan: CompiledPlan): boolean {
  for (const key of plan.objectShapeKeys) {
    if (Object.hasOwn(Object.prototype as object, key)) return true;
  }
  return false;
}
