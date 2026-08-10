import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "../classic/index.js";
import { config } from "./config.js";

describe("property check", () => {
  let wasJitless: boolean | undefined;
  beforeAll(() => {
    wasJitless = config().jitless;
    config({ jitless: true });
  });
  afterAll(() => {
    config({ jitless: wasJitless });
  });

  it("passes and fails a primitive string length property", () => {
    const S = z.string().check(z.property("length", z.number().min(5)));
    expect(S.parse("hello")).toBe("hello");
    expect(S.safeParse("hi").success).toBe(false);
  });

  it("reads an object property and preserves the parent value", () => {
    const S = z.any().check(z.property("a", z.string()));
    const input = { a: "x" };
    expect(S.parse(input)).toBe(input);
  });

  it("awaits an async child schema with parseAsync", async () => {
    const S = z.any().check(
      z.property("a", z.string().refine(async (s) => s === "ok")),
    );
    const result = await S.parseAsync({ a: "ok" });
    expect(result).toEqual({ a: "ok" });
    const bad = await S.safeParseAsync({ a: "bad" });
    expect(bad.success).toBe(false);
  });

  it("throws on null and undefined like direct property access", () => {
    const S = z.any().check(z.property("a", z.string()));
    expect(() => S.parse(null)).toThrow();
    expect(() => S.parse(undefined)).toThrow();
  });

  it("reads a getter exactly once", () => {
    const S = z.any().check(z.property("a", z.string()));
    let calls = 0;
    const input = Object.defineProperty({}, "a", {
      get: () => {
        calls++;
        return "x";
      },
      enumerable: true,
      configurable: true,
    });
    expect(S.parse(input)).toBe(input);
    expect(calls).toBe(1);
  });

  it("rethrows a throwing getter", () => {
    const S = z.any().check(z.property("a", z.string()));
    const input = Object.defineProperty({}, "a", {
      get: () => {
        throw new Error("getter boom");
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => S.parse(input)).toThrow("getter boom");
  });
});
