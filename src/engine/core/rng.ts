// Seeded RNG (mulberry32). The engine itself is deterministic — no current
// engine action uses randomness, but combat, AI and any future systems thread
// an RNG through so behaviour is reproducible from a seed.
//
// Usage:
//   const rng = createRng(0xdeadbeef);
//   const r = rng();        // [0, 1)
//   const n = rngInt(rng, 6); // 0..5

export type Rng = () => number;

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return function rng(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, max). */
export function rngInt(rng: Rng, max: number): number {
  return Math.floor(rng() * max);
}

/** Pick one element of an array uniformly. */
export function rngPick<T>(rng: Rng, arr: ReadonlyArray<T>): T {
  if (arr.length === 0) throw new Error('rngPick: empty array');
  const v = arr[rngInt(rng, arr.length)];
  // arr.length > 0 guarantees v is defined, but TS doesn't know that.
  return v as T;
}
