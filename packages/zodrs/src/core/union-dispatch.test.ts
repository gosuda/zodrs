import { describe, expect, it } from "vitest";
import * as z from "../classic/index.js";

describe("tag-only union dispatch", () => {
  const tagged = z.union([
    z.object({ type: z.literal("a") }),
    z.object({ type: z.literal("b") }),
    z.object({ type: z.literal("c") }),
  ]);

  it("preserves ordered property reads", () => {
    let reads = 0;
    const values = ["x", "b"] as const;
    const input = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        const value = values[reads];
        reads += 1;
        return value;
      },
    });

    const output = tagged.parse(input);
    const fresh = output !== input;
    expect(reads).toBe(2);
    expect(output).toEqual({ type: "b" });
    expect(fresh).toBe(true);
  });

  it("reads inherited tags before testing ownership", () => {
    expect(tagged.parse(Object.create({ type: "a" }))).toEqual({ type: "a" });

    const events: string[] = [];
    const input = new Proxy(
      { type: "a" },
      {
        get(target, key, receiver) {
          events.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          events.push(`own:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(tagged.parse(input)).toEqual({ type: "a" });
    expect(events).toEqual(["get:type"]);
  });

  it("keeps every failed branch error", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        reads += 1;
        return "x";
      },
    });

    const result = tagged.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(reads).toBe(3);
    expect(result.error.issues).toEqual([
      {
        code: "invalid_union",
        errors: ["a", "b", "c"].map((value) => [
          {
            code: "invalid_value",
            values: [value],
            path: ["type"],
            message: `Invalid input: expected ${JSON.stringify(value)}`,
          },
        ]),
        path: [],
        message: "Invalid input",
      },
    ]);
  });

  it("does not skip recoverable wrapper branches", () => {
    let catches = 0;
    const schema = z.union([
      z.object({
        type: z.literal("a").catch(() => {
          catches += 1;
          return "b";
        }),
      }),
      z.object({ type: z.literal("b") }),
    ]);

    expect(schema.parse({ type: "b" })).toEqual({ type: "b" });
    expect(catches).toBe(1);
  });

  it("does not skip work in multi-field branches", () => {
    let reads = 0;
    const schema = z.union([
      z.object({ type: z.literal("a"), payload: z.string() }),
      z.object({ type: z.literal("b"), payload: z.string() }),
    ]);
    const input = { type: "b" } as { type: string; payload: string };
    Object.defineProperty(input, "payload", {
      enumerable: true,
      get() {
        reads += 1;
        return "ok";
      },
    });

    expect(schema.parse(input)).toEqual({ type: "b", payload: "ok" });
    expect(reads).toBe(2);
  });

  it("re-reads the discriminator during selected object validation", () => {
    let reads = 0;
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), s: z.string(), n: z.number() }),
      z.object({ type: z.literal("c"), s: z.string(), n: z.number(), b: z.boolean() }),
    ]);
    const input = Object.defineProperty(
      { s: "ok", n: 1, b: true },
      "type",
      {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return reads === 1 ? "a" : "b";
        },
      },
    );

    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(reads).toBe(2);
    expect(result.error.issues).toEqual([
      {
        code: "invalid_value",
        values: ["a"],
        path: ["type"],
        message: 'Invalid input: expected "a"',
      },
    ]);
  });

  it("dispatches via the accepted set and spreads all values in the failure issue", () => {
    const schema = z.union([
      z.object({ type: z.literal(["a", "b"]) }),
      z.object({ type: z.literal("c") }),
    ]);

    // Each accepted value hits the Set-based dispatch.
    expect(schema.parse({ type: "a" })).toEqual({ type: "a" });
    expect(schema.parse({ type: "b" })).toEqual({ type: "b" });
    expect(schema.parse({ type: "c" })).toEqual({ type: "c" });

    // A value matching no branch spreads every literal value into the issue.
    const result = schema.safeParse({ type: "d" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue?.code).toBe("invalid_union");
    if (issue?.code !== "invalid_union") return;
    expect(issue.errors[0]).toEqual([
      {
        code: "invalid_value",
        values: ["a", "b"],
        path: ["type"],
        message: 'Invalid option: expected one of "a"|"b"',
      },
    ]);
    expect(issue.errors[1]).toEqual([
      {
        code: "invalid_value",
        values: ["c"],
        path: ["type"],
        message: 'Invalid input: expected "c"',
      },
    ]);
  });
});
