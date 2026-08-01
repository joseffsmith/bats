// Campaign progress store.
//
// The store's job is to never lose a star and never throw, no matter what the
// browser hands back: a wiped profile, a half-written blob, a record from a
// future version, or a localStorage that refuses to co-operate at all.

import { describe, expect, it } from 'vitest';
import {
  PROGRESS_KEY,
  PROGRESS_VERSION,
  createProgressStore,
} from '../src/campaign/progress';
import type { StorageLike } from '../src/campaign/progress';

/** In-memory Storage double. */
function memoryStorage(seed?: string): StorageLike & { raw(): string | null } {
  let value: string | null = seed ?? null;
  return {
    getItem: (k) => (k === PROGRESS_KEY ? value : null),
    setItem: (k, v) => {
      if (k === PROGRESS_KEY) value = v;
    },
    removeItem: (k) => {
      if (k === PROGRESS_KEY) value = null;
    },
    raw: () => value,
  };
}

/** A storage that throws on the chosen operations — private-mode Safari, a
 *  cookies-blocked webview, a quota-exceeded profile. */
function hostileStorage(opts: {
  onGet?: boolean;
  onSet?: boolean;
  seed?: string;
}): StorageLike {
  let value: string | null = opts.seed ?? null;
  return {
    getItem: (k) => {
      if (opts.onGet) throw new Error('SecurityError: storage disabled');
      return k === PROGRESS_KEY ? value : null;
    },
    setItem: (k, v) => {
      if (opts.onSet) throw new Error('QuotaExceededError');
      if (k === PROGRESS_KEY) value = v;
    },
    removeItem: () => {
      value = null;
    },
  };
}

describe('campaign progress — happy path', () => {
  it('starts empty and records a result', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    expect(store.load()).toEqual({ version: PROGRESS_VERSION, missions: {} });
    expect(store.starsFor('m1_first_strike')).toBe(0);
    expect(store.isCompleted('m1_first_strike')).toBe(false);

    store.record('m1_first_strike', 2);
    expect(store.starsFor('m1_first_strike')).toBe(2);
    expect(store.isCompleted('m1_first_strike')).toBe(true);
    expect(store.isEphemeral()).toBe(false);
  });

  it('persists through the injected storage under the versioned key', () => {
    const storage = memoryStorage();
    createProgressStore({ storage }).record('m2_flag_country', 3);
    const raw = storage.raw();
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      missions: { m2_flag_country: { stars: 3, completed: true } },
    });
    // A second store instance sees the same progress.
    expect(createProgressStore({ storage }).starsFor('m2_flag_country')).toBe(3);
  });

  it('reset wipes the record', () => {
    const storage = memoryStorage();
    const store = createProgressStore({ storage });
    store.record('m1_first_strike', 3);
    expect(store.reset()).toEqual({ version: PROGRESS_VERSION, missions: {} });
    expect(store.starsFor('m1_first_strike')).toBe(0);
    expect(storage.raw()).toBeNull();
  });
});

describe('campaign progress — star merging', () => {
  it('keeps the best star count across replays', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    store.record('m1_first_strike', 3);
    store.record('m1_first_strike', 1);
    expect(store.starsFor('m1_first_strike')).toBe(3);
    store.record('m1_first_strike', 2);
    expect(store.starsFor('m1_first_strike')).toBe(3);
  });

  it('a zero-star result does not mark a mission completed, but does not undo one', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    store.record('m4_high_ground', 0);
    expect(store.isCompleted('m4_high_ground')).toBe(false);
    store.record('m4_high_ground', 1);
    store.record('m4_high_ground', 0);
    expect(store.isCompleted('m4_high_ground')).toBe(true);
    expect(store.starsFor('m4_high_ground')).toBe(1);
  });

  it('clamps out-of-range star counts', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    store.record('m3_war_economy', 99);
    expect(store.starsFor('m3_war_economy')).toBe(3);
    store.record('m5_black_pines', -4);
    expect(store.starsFor('m5_black_pines')).toBe(0);
    store.record('m5_black_pines', Number.NaN);
    expect(store.starsFor('m5_black_pines')).toBe(0);
  });

  it('records missions independently', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    store.record('m1_first_strike', 3);
    store.record('m2_flag_country', 1);
    expect(store.load().missions).toEqual({
      m1_first_strike: { stars: 3, completed: true },
      m2_flag_country: { stars: 1, completed: true },
    });
  });
});

describe('campaign progress — hostile storage', () => {
  it('treats corrupt JSON as a fresh record', () => {
    const store = createProgressStore({ storage: memoryStorage('{not json at all') });
    expect(store.load()).toEqual({ version: PROGRESS_VERSION, missions: {} });
    store.record('m1_first_strike', 1);
    expect(store.starsFor('m1_first_strike')).toBe(1);
  });

  it('treats a wrong-version record as a fresh record', () => {
    const blob = JSON.stringify({
      version: 99,
      missions: { m1_first_strike: { stars: 3, completed: true } },
    });
    const store = createProgressStore({ storage: memoryStorage(blob) });
    expect(store.load().missions).toEqual({});
    expect(store.starsFor('m1_first_strike')).toBe(0);
  });

  it('treats a mangled shape as a fresh record', () => {
    for (const blob of ['[]', '"nope"', '{"version":1}', '{"version":1,"missions":[]}']) {
      const store = createProgressStore({ storage: memoryStorage(blob) });
      expect(store.load()).toEqual({ version: PROGRESS_VERSION, missions: {} });
    }
  });

  it('drops individual unreadable mission entries but keeps the rest', () => {
    const blob = JSON.stringify({
      version: 1,
      missions: {
        m1_first_strike: { stars: 3, completed: true },
        m2_flag_country: 'garbage',
        m3_war_economy: { stars: 'two', completed: 'yes' },
      },
    });
    const store = createProgressStore({ storage: memoryStorage(blob) });
    const rec = store.load();
    expect(rec.missions.m1_first_strike).toEqual({ stars: 3, completed: true });
    expect(rec.missions.m2_flag_country).toBeUndefined();
    expect(rec.missions.m3_war_economy).toEqual({ stars: 0, completed: false });
  });

  it('falls back to memory when reads throw', () => {
    const store = createProgressStore({ storage: hostileStorage({ onGet: true }) });
    expect(() => store.load()).not.toThrow();
    store.record('m1_first_strike', 2);
    expect(store.starsFor('m1_first_strike')).toBe(2);
    expect(store.isEphemeral()).toBe(true);
  });

  it('falls back to memory when writes throw, and still merges stars', () => {
    const store = createProgressStore({ storage: hostileStorage({ onSet: true }) });
    store.record('m1_first_strike', 1);
    expect(store.isEphemeral()).toBe(true);
    expect(store.starsFor('m1_first_strike')).toBe(1);
    store.record('m1_first_strike', 3);
    store.record('m1_first_strike', 2);
    expect(store.starsFor('m1_first_strike')).toBe(3);
  });

  it('a failed write never resurrects the stale persisted blob', () => {
    const seed = JSON.stringify({
      version: 1,
      missions: { m1_first_strike: { stars: 1, completed: true } },
    });
    const store = createProgressStore({ storage: hostileStorage({ onSet: true, seed }) });
    expect(store.starsFor('m1_first_strike')).toBe(1);
    store.record('m1_first_strike', 3);
    expect(store.starsFor('m1_first_strike')).toBe(3);
  });

  it('works with no storage at all', () => {
    const store = createProgressStore({ storage: null });
    expect(store.isEphemeral()).toBe(true);
    expect(store.load()).toEqual({ version: PROGRESS_VERSION, missions: {} });
    store.record('m5_black_pines', 3);
    expect(store.starsFor('m5_black_pines')).toBe(3);
    expect(store.reset().missions).toEqual({});
  });
});
