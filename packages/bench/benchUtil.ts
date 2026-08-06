/**
 * Shared benchmark utilities — data generation helpers used across suites.
 * Mirrors the shape of Zod's benchUtil.ts but adapted for the four comparators
 * (zodrs, zod4, arktype, valibot) instead of zod3/zod4.
 */

export function randomString(length: number): string {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

export function randomPick<T>(options: T[]): T {
  const picked = options[Math.floor(Math.random() * options.length)];
  if (picked === undefined) throw new Error("randomPick: empty options array");
  return picked;
}

export function makeData(count: number, factory: () => unknown): unknown[] {
  return Array.from({ length: count }, () => factory());
}
