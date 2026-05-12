// Capture progress + ownership transfer.
//
// Only infantry can capture. The unit must be standing on a capturable tile
// (city, hq, factory) that isn't already owned by its player.
//
// Progress accumulates by floor(hp/10) per CAPTURE. At >= CAPTURE_THRESHOLD
// the tile flips owner and progress resets to 0. Moving off (or being
// destroyed) resets progress — those resets are handled in reducer/MOVE and
// when a unit is removed.

import type { GameState, Unit } from '../core/types';
import { isCapturable, tileAt } from '../core/types';
import { CAPTURE_THRESHOLD } from '../data';
import { log } from '../core/logger';

export type CaptureResult = {
  added: number;
  newProgress: number;
  flipped: boolean;
};

/**
 * Apply a single CAPTURE action against the unit's current tile. Mutates
 * `unit` and (if flipped) `state.map` in place. Caller passes deep-cloned
 * state.
 */
export function resolveCapture(state: GameState, unit: Unit): CaptureResult {
  const tile = tileAt(state.map, unit.pos);
  if (!isCapturable(tile.terrain)) {
    throw new Error('resolveCapture: tile not capturable');
  }
  if (tile.owner === unit.owner) {
    throw new Error('resolveCapture: tile already owned by capturer');
  }
  const add = Math.floor(unit.hp / 10);
  unit.captureProgress += add;
  let flipped = false;
  if (unit.captureProgress >= CAPTURE_THRESHOLD) {
    tile.owner = unit.owner;
    unit.captureProgress = 0;
    flipped = true;
    log('engine', 'ownership flipped', {
      pos: unit.pos,
      terrain: tile.terrain,
      newOwner: unit.owner,
    });
  } else {
    log('engine', 'capture progress changed', {
      unit: unit.id,
      pos: unit.pos,
      progress: unit.captureProgress,
      added: add,
    });
  }
  return { added: add, newProgress: unit.captureProgress, flipped };
}

/** Reset capture progress on a unit. Called when the unit moves or dies. */
export function resetCapture(unit: Unit): void {
  if (unit.captureProgress !== 0) {
    log('engine', 'capture progress reset', { unit: unit.id });
    unit.captureProgress = 0;
  }
}
