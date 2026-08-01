// Campaign progress store — "which missions are done, and how many stars".
//
// Storage rules, in order of importance:
//   1. Never throw. Private-mode Safari throws on `localStorage.setItem`, some
//      embedded webviews throw on *reading* `window.localStorage` at all, and a
//      user with a wiped profile is indistinguishable from a corrupt one. In
//      every case the campaign must still be playable, so all storage access is
//      wrapped and falls back to an in-memory record for the session.
//   2. Never lose stars. `record` merges: a replay that earns fewer stars than
//      a previous run keeps the better result.
//   3. Never trust what comes back. The blob is parsed defensively — bad JSON,
//      wrong version, or a mangled shape all yield a fresh empty record rather
//      than a crash mid-menu.
//
// The store is a factory with an injectable `storage` so tests can drive the
// throwing / corrupt paths without touching a real localStorage.

import { MAX_STARS } from './types';

export const PROGRESS_KEY = 'bats.campaign.v1';
export const PROGRESS_VERSION = 1;

export type MissionProgress = {
  /** Best star count earned, 0–3. */
  stars: number;
  /** True once the mission has been won at least once. */
  completed: boolean;
};

export type CampaignProgress = {
  version: number;
  missions: Record<string, MissionProgress>;
};

/** The slice of the Web Storage API this module uses. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type ProgressStore = {
  /** Current progress. Always returns a valid record, never throws. */
  load(): CampaignProgress;
  /** Merge a mission result in (keeping the best stars) and persist. Returns
   *  the updated record. */
  record(missionId: string, stars: number): CampaignProgress;
  /** Stars earned for one mission (0 when never played). */
  starsFor(missionId: string): number;
  /** True once the mission has been won. */
  isCompleted(missionId: string): boolean;
  /** Wipe all campaign progress. Used by the "reset progress" affordance. */
  reset(): CampaignProgress;
  /** True when writes are going to memory only (storage unavailable / broken).
   *  Screens can use this to warn that progress won't survive a reload. */
  isEphemeral(): boolean;
};

function freshRecord(): CampaignProgress {
  return { version: PROGRESS_VERSION, missions: {} };
}

function clampStars(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  return i > MAX_STARS ? MAX_STARS : i;
}

/** Shape + version check on a parsed blob. Returns null when it is anything
 *  other than a record this version wrote. */
function validate(parsed: unknown): CampaignProgress | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== PROGRESS_VERSION) return null;
  const missionsRaw = o.missions;
  if (
    missionsRaw === null ||
    typeof missionsRaw !== 'object' ||
    Array.isArray(missionsRaw)
  ) {
    return null;
  }
  const missions: Record<string, MissionProgress> = {};
  for (const [id, value] of Object.entries(missionsRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // Drop the unreadable entry rather than the whole file — one bad mission
      // shouldn't cost the player the other four.
      continue;
    }
    const entry = value as Record<string, unknown>;
    const stars = typeof entry.stars === 'number' ? clampStars(entry.stars) : 0;
    const completed = entry.completed === true;
    missions[id] = { stars, completed };
  }
  return { version: PROGRESS_VERSION, missions };
}

/** Best-effort default storage. Reading `window.localStorage` can itself throw
 *  (sandboxed iframes, cookies-blocked webviews), hence the try/catch. */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage as StorageLike;
  } catch {
    return null;
  }
}

export type ProgressStoreOptions = {
  /** Inject a storage (tests, or a non-DOM host). `null` forces memory-only. */
  storage?: StorageLike | null;
};

export function createProgressStore(opts: ProgressStoreOptions = {}): ProgressStore {
  const storage: StorageLike | null =
    opts.storage === undefined ? defaultStorage() : opts.storage;

  // In-memory mirror. Also the sole source of truth once storage has proven
  // unusable, so a session that starts in private mode still tracks stars.
  let memory: CampaignProgress | null = null;
  let ephemeral = storage === null;

  function readThrough(): CampaignProgress {
    // Once storage has proven unusable, memory is the truth for this session:
    // re-reading could hand back a stale blob and silently undo stars earned
    // after the first failed write.
    if (storage === null || ephemeral) return memory ?? freshRecord();
    let raw: string | null;
    try {
      raw = storage.getItem(PROGRESS_KEY);
    } catch {
      ephemeral = true;
      return memory ?? freshRecord();
    }
    if (raw === null) {
      // Nothing persisted yet — an in-session record (written while storage was
      // throwing) still wins over an empty one.
      return memory ?? freshRecord();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return memory ?? freshRecord();
    }
    const valid = validate(parsed);
    return valid ?? memory ?? freshRecord();
  }

  function write(next: CampaignProgress): CampaignProgress {
    memory = next;
    if (storage === null) return next;
    try {
      storage.setItem(PROGRESS_KEY, JSON.stringify(next));
    } catch {
      ephemeral = true;
    }
    return next;
  }

  return {
    load(): CampaignProgress {
      const rec = readThrough();
      memory = rec;
      return rec;
    },
    record(missionId: string, stars: number): CampaignProgress {
      const current = readThrough();
      const earned = clampStars(stars);
      const prev = current.missions[missionId];
      const merged: MissionProgress = {
        stars: Math.max(prev?.stars ?? 0, earned),
        completed: (prev?.completed ?? false) || earned > 0,
      };
      return write({
        version: PROGRESS_VERSION,
        missions: { ...current.missions, [missionId]: merged },
      });
    },
    starsFor(missionId: string): number {
      return readThrough().missions[missionId]?.stars ?? 0;
    },
    isCompleted(missionId: string): boolean {
      return readThrough().missions[missionId]?.completed ?? false;
    },
    reset(): CampaignProgress {
      const fresh = freshRecord();
      memory = fresh;
      if (storage !== null) {
        try {
          storage.removeItem(PROGRESS_KEY);
        } catch {
          ephemeral = true;
        }
      }
      return fresh;
    },
    isEphemeral(): boolean {
      return ephemeral;
    },
  };
}

// Lazily-created shared store for the app. Created on first use so that merely
// importing this module never touches storage (which matters in node tests and
// during SSR-ish tooling runs).
let shared: ProgressStore | null = null;

/** The app-wide progress store (localStorage-backed when available). */
export function progressStore(): ProgressStore {
  shared ??= createProgressStore();
  return shared;
}
