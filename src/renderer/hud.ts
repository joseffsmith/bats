// Build-menu data helpers.
//
// The action/build menus themselves are DOM now (see menus.ts); this module is
// left holding only the pure data the DOM layer renders from: the buildable
// roster (filtered for coastal factories) and the per-unit icon letters. All
// canvas drawing + hit-testing that used to live here was deleted when the
// menus moved to DOM in Phase 2.3.

import type { GameState, PlayerId, UnitType } from '../engine/core/types';
import { UNITS } from '../engine/data';
import type { BuildMenuEntry } from './canvas';

// Build-menu icon letters. Each unit type gets a unique letter; the existing
// roster keeps its letters. Tier-3 stealth additions: submarine = M
// (sub**M**arine — "S" is taken by battleship and "U" by cruiser) and
// carrier = V (Vessel; clearer than C which already means copter). See
// README/PLAN for the full mapping. The renderer's tile-letter fallback in
// canvas.ts keeps its own copy of the same table; menus.ts imports this one for
// the build-entry letter chip.
export const UNIT_LETTER: Record<UnitType, string> = {
  infantry: 'I',
  recon: 'R',
  tank: 'T',
  artillery: 'A',
  copter: 'C',
  transport: 'X',
  fighter: 'F',
  bomber: 'B',
  battleship: 'S',
  cruiser: 'U',
  aatank: 'K',
  lander: 'L',
  submarine: 'M',
  carrier: 'V',
};

// Sea-class units (transport, battleship, cruiser, lander) can only launch
// from a factory adjacent to a sea tile — otherwise they'd spawn stranded on
// land they can't traverse. The validator at checkBuild enforces this; the
// build menu filters them out so the option isn't even offered.
const BUILDABLE: ReadonlyArray<UnitType> = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'aatank',
  'copter',
  'fighter',
  'bomber',
  'transport',
  'lander',
  'cruiser',
  'battleship',
  'submarine',
  'carrier',
];

function isCoastalFactory(state: GameState, at: { x: number; y: number }): boolean {
  const neighbours = [
    { x: at.x - 1, y: at.y },
    { x: at.x + 1, y: at.y },
    { x: at.x, y: at.y - 1 },
    { x: at.x, y: at.y + 1 },
  ];
  for (const n of neighbours) {
    const row = state.map[n.y];
    if (!row) continue;
    const tile = row[n.x];
    if (tile && tile.terrain === 'sea') return true;
  }
  return false;
}

// ─────────────────────────── Build menu factory ──────────────────────────────

export function buildMenuEntries(
  state: GameState,
  owner: PlayerId,
  at: { x: number; y: number },
): BuildMenuEntry[] {
  const funds = state.players[owner].funds;
  const coastal = isCoastalFactory(state, at);
  const entries: BuildMenuEntry[] = [];
  for (const type of BUILDABLE) {
    // Sea-class units (transport, lander, cruiser, battleship) need a sea
    // tile adjacent to the factory to launch. The engine's BUILD validator
    // also enforces this — filtering here just keeps the menu honest.
    if (UNITS[type].movementClass === 'sea' && !coastal) continue;
    const cost = UNITS[type].cost;
    entries.push({
      unitType: type,
      label: unitLabel(type),
      cost,
      affordable: funds >= cost,
    });
  }
  return entries;
}

/**
 * Player-facing name for a unit type. The single source of truth for unit
 * naming across the UI: build entries here, and the mobile tray's unit /
 * forecast cards (mobile/tray.ts). Renaming a unit is a one-line change here
 * rather than a hunt through two DOM modules.
 */
export function unitLabel(type: UnitType): string {
  // `aatank` reads better as "AA Tank" in the build menu UI.
  if (type === 'aatank') return 'AA Tank';
  return capitalise(type);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
