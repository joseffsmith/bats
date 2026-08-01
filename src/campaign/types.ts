// Campaign layer — shared types.
//
// The campaign is a thin teaching wrapper *around* the engine: it never
// changes rules. A mission is a board + an opponent persona + copy + a hint
// script + the star/defeat bookkeeping that decides what the after-action
// screen says. Everything here is plain data so `src/data/campaign.json` can
// be authored (and validated) without touching code.
//
// Layering: this module imports nothing from the renderer or the engine, so
// the campaign types can be consumed by screens, tests, and tooling alike.

/**
 * When a hint appears or disappears.
 *
 * - `immediate` — the moment the hint becomes the current one (mission start
 *   for the first hint, or right after its predecessor is cleared). Only valid
 *   as a `show` trigger: an immediate `clear` would erase the hint before it
 *   could be read, and the loader rejects it.
 * - `input`     — the input state machine entered node `kind`
 *                 (see `INPUT_KINDS`, mirrored from renderer/input.ts).
 * - `action`    — the reducer accepted an action of type `type`
 *                 (see `ACTION_TYPES`, mirrored from engine/core/types.ts).
 * - `turn`      — the game reached day `day` or later (day = ceil(turn / 2)).
 */
export type Trigger =
  | { on: 'immediate' }
  | { on: 'input'; kind: string }
  | { on: 'action'; type: string }
  | { on: 'turn'; day: number };

/** One line of coaching, shown when `show` fires and hidden when `clear` does.
 *  Hints run strictly in list order — see campaign/hints.ts. */
export type HintSpec = {
  /** Unique within the mission. Used for debugging + test assertions. */
  id: string;
  show: Trigger;
  clear: Trigger;
  text: string;
};

/** Bonus-star conditions. A win is always worth one star; these add up to two
 *  more. */
export type StarSpec = {
  /** Win on this day or earlier for the speed star. */
  winByDay: number;
  /** When true, finishing without losing a unit earns the third star. */
  noUnitLost: boolean;
};

/** Campaign-layer loss condition. The engine has no turn limit; the mission
 *  tracker enforces this one on top of it. */
export type DefeatSpec = {
  /** Once the day counter passes this, the mission is lost. */
  dayLimit: number;
};

/** The opposing commander: an AI persona plus the fiction wrapped around it. */
export type Opponent = {
  /** Must name a persona in src/data/ai-personas.json. */
  persona: string;
  /** Display name, e.g. "Warden Kroft". */
  name: string;
  /** One-line characterisation shown on the briefing screen. */
  flavor: string;
};

export type Mission = {
  /** Stable id — the progress store's key. Never renumber these. */
  id: string;
  /** 1-based mission number, used for ordering and "Mission 3 of 5". */
  n: number;
  title: string;
  /** A board registered in renderer/maps.ts. */
  map: string;
  opponent: Opponent;
  /** One-line "what you must do" shown above the board. */
  objective: string;
  /** Briefing paragraphs, one string per line. */
  intro: ReadonlyArray<string>;
  /** Play this mission under fog of war. (The map format has no fog flag —
   *  fog is a mission-level decision so the same board can be reused.) */
  fog: boolean;
  hints: ReadonlyArray<HintSpec>;
  stars: StarSpec;
  defeat: DefeatSpec;
};

/** How a mission ended. Produced by campaign/tracker.ts, consumed by the
 *  after-action screen and the progress store. */
export type MissionResult = {
  missionId: string;
  outcome: 'victory' | 'defeat';
  /** `winner` — the engine declared a winner (HQ capture or rout).
   *  `dayLimit` — the campaign-layer day limit expired with no winner. */
  reason: 'winner' | 'dayLimit';
  /** Day the mission ended, `ceil(turn / 2)`. */
  day: number;
  /** Units the player lost across the whole mission, built units included. */
  unitsLost: number;
  /** 0 on defeat; 1–3 on victory. */
  stars: number;
};

/** Input-state-machine nodes a hint can key off. Mirrors the `kind` field of
 *  `InputState` in renderer/input.ts — kept as a local constant so the campaign
 *  layer (and its node-only tests) never import the DOM-bound input module. */
export const INPUT_KINDS: ReadonlyArray<string> = [
  'idle',
  'unit-selected',
  'move-previewed',
  'action-menu',
  'attack-targeting',
  'unload-targeting',
  'build-menu-open',
];

/** Action types a hint can key off. Mirrors the `Action` union in
 *  engine/core/types.ts (read-only dependency, mirrored to keep this module
 *  data-only). */
export const ACTION_TYPES: ReadonlyArray<string> = [
  'MOVE',
  'ATTACK',
  'CAPTURE',
  'BUILD',
  'WAIT',
  'LOAD',
  'UNLOAD',
  'DIVE',
  'SURFACE',
  'END_TURN',
];

/** Day number for an engine turn counter. Two plies (P0 then P1) make a day —
 *  the same convention the HUD uses. */
export function dayOf(turn: number): number {
  return Math.ceil(turn / 2);
}
