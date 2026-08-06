/**
 * Error-shaping helpers: convert a `$ZodError`'s flat issue list into the four
 * public representations (flattened, formatted, tree, pretty string).
 *
 * Behavior is pinned by Zod v4's test corpus: issue recursion for
 * `invalid_union` (nested `errors`), `invalid_key` and `invalid_element`
 * (nested `issues`) is part of the observable output.
 */
import type { $ZodError, $ZodIssue } from "./errors.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

type Primitive = string | number | bigint | boolean | symbol | null | undefined;

type Flatten<T> = {
  [K in keyof T]: T[K];
} & {};

export type $ZodFlattenedError<T, U = string> = {
  formErrors: U[];
  fieldErrors: {
    [P in keyof T]?: U[];
  };
};

export function flattenError<T>(error: $ZodError<T>): $ZodFlattenedError<T>;
export function flattenError<T, U>(error: $ZodError<T>, mapper?: (issue: $ZodIssue) => U): $ZodFlattenedError<T, U>;
export function flattenError<T, U>(error: $ZodError<T>, mapper = (issue: $ZodIssue) => issue.message as U) {
  const fieldErrors: Record<PropertyKey, U[]> = {};
  const formErrors: U[] = [];
  for (const issue of error.issues) {
    const [key] = issue.path;
    if (key === undefined) {
      formErrors.push(mapper(issue));
    } else {
      (fieldErrors[key] ??= []).push(mapper(issue));
    }
  }
  return { formErrors, fieldErrors } as $ZodFlattenedError<T, U>;
}

type FormattedFields<T, U> = T extends [unknown, ...unknown[]]
  ? { [K in keyof T]?: $ZodFormattedError<T[K], U> }
  : T extends unknown[]
    ? { [k: number]: $ZodFormattedError<T[number], U> }
    : T extends object
      ? Flatten<{ [K in keyof T]?: $ZodFormattedError<T[K], U> }>
      : unknown;

export type $ZodFormattedError<T, U = string> = {
  _errors: U[];
} & Flatten<FormattedFields<T, U>>;

/** Issues that merely wrap a nested issue list get unfolded in place. */
function* iterLeafIssues(issues: readonly $ZodIssue[], basePath: PropertyKey[]): Generator<{
  issue: $ZodIssue;
  path: PropertyKey[];
}> {
  for (const issue of issues) {
    if (issue.code === "invalid_union" && issue.errors.length) {
      for (const nested of issue.errors) {
        yield* iterLeafIssues(nested, [...basePath, ...issue.path]);
      }
    } else if (issue.code === "invalid_key" || issue.code === "invalid_element") {
      yield* iterLeafIssues(issue.issues, [...basePath, ...issue.path]);
    } else {
      yield { issue, path: [...basePath, ...issue.path] };
    }
  }
}

export function formatError<T>(error: $ZodError<T>): $ZodFormattedError<T>;
export function formatError<T, U>(error: $ZodError<T>, mapper?: (issue: $ZodIssue) => U): $ZodFormattedError<T, U>;
export function formatError<T, U>(error: $ZodError<T>, mapper = (issue: $ZodIssue) => issue.message as U) {
  const root: { _errors: U[] } & Record<PropertyKey, unknown> = { _errors: [] };
  for (const { issue, path } of iterLeafIssues(error.issues, [])) {
    if (path.length === 0) {
      root._errors.push(mapper(issue));
      continue;
    }
    let curr = root;
    for (const [i, seg] of path.entries()) {
      curr = (curr[seg] ??= { _errors: [] }) as typeof root;
      if (i === path.length - 1) {
        curr._errors.push(mapper(issue));
      }
    }
  }
  return root as $ZodFormattedError<T, U>;
}

export type $ZodErrorTree<T, U = string> = T extends Primitive
  ? { errors: U[] }
  : T extends [unknown, ...unknown[]]
    ? { errors: U[]; items?: { [K in keyof T]?: $ZodErrorTree<T[K], U> } }
    : T extends unknown[]
      ? { errors: U[]; items?: Array<$ZodErrorTree<T[number], U>> }
      : T extends object
        ? {
            errors: U[];
            properties?: { [K in keyof T]?: $ZodErrorTree<T[K], U> };
          }
        : { errors: U[] };

export function treeifyError<T>(error: $ZodError<T>): $ZodErrorTree<T>;
export function treeifyError<T, U>(error: $ZodError<T>, mapper?: (issue: $ZodIssue) => U): $ZodErrorTree<T, U>;
export function treeifyError<T, U>(error: $ZodError<T>, mapper = (issue: $ZodIssue) => issue.message as U) {
  type Node = {
    errors: U[];
    properties?: Record<string, Node>;
    items?: Node[];
  };
  const root: Node = { errors: [] };
  for (const { issue, path } of iterLeafIssues(error.issues, [])) {
    if (path.length === 0) {
      root.errors.push(mapper(issue));
      continue;
    }
    let curr = root;
    for (const [i, seg] of path.entries()) {
      if (typeof seg === "string") {
        curr = (curr.properties ??= {})[seg] ??= { errors: [] };
      } else {
        curr = (curr.items ??= [])[seg as number] ??= { errors: [] };
      }
      if (i === path.length - 1) {
        curr.errors.push(mapper(issue));
      }
    }
  }
  return root as $ZodErrorTree<T, U>;
}

/** Render a path as a dot/bracket access string: `a.b[0]["weird key"]`. */
export function toDotPath(path: readonly (string | number | symbol | StandardSchemaV1.PathSegment)[]): string {
  const segs: string[] = [];
  for (const raw of path) {
    const seg: PropertyKey = typeof raw === "object" ? raw.key : raw;
    if (typeof seg === "number") {
      segs.push(`[${seg}]`);
    } else if (typeof seg === "symbol") {
      segs.push(`[${JSON.stringify(String(seg))}]`);
    } else if (/[^\w$]/.test(seg)) {
      segs.push(`[${JSON.stringify(seg)}]`);
    } else {
      if (segs.length) segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}

/** Render a failure as one `✖ message` / `  → at path` stanza per issue, sorted by path depth. */
export function prettifyError(error: StandardSchemaV1.FailureResult): string {
  const issues = [...error.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  const lines: string[] = [];
  for (const issue of issues) {
    lines.push(`✖ ${issue.message}`);
    if (issue.path?.length) lines.push(`  → at ${toDotPath(issue.path)}`);
  }
  return lines.join("\n");
}
