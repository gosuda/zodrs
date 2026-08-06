/**
 * Deterministic PRNG for the differential fuzz harness.
 *
 * Every case derives its own sub-seed from (FUZZ_SEED, caseIndex), so a
 * single failing case reproduces in isolation with the same seed regardless
 * of how many other cases ran before it.
 */

/** Splitmix-style bit mixer used to derive independent sub-seeds. */
export function deriveSeed(seed: number, index: number, salt: number): number {
  let x = (seed + Math.imul(index + 1, 0x9e3779b9) + salt) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return x >>> 0;
}

export class Rng {
  #state: number;

  constructor(seed: number) {
    // mulberry32; a zero state is degenerate, so fold in a constant.
    this.#state = (seed ^ 0x6d2b79f5) >>> 0;
  }

  /** Uniform uint32. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 0x100000000;
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    if (hi < lo) [lo, hi] = [hi, lo];
    return lo + (this.next() % (hi - lo + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.next() % items.length];
  }
}
