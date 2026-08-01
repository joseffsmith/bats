// Skirmish stalemate rule — a UI-level day cap.
//
// ── Why it lives here and not in the engine ────────────────────────────────
// The engine deliberately has no turn cap: `src/engine/systems/win.ts` ends a
// match on HQ capture or rout and nothing else, and that stays true — the
// campaign layer is built on stable engine rules and carries its own clock
// (`defeat.dayLimit`, enforced by src/campaign/tracker.ts). The CLI harnesses
// pass `--max-turns`. AI-vs-AI self-terminates via the anti-stall work.
//
// That left exactly one hole: a LIVE match — hot-seat, or human-vs-AI — where
// both sides camp can run forever. This module closes it in the shell.
//
// ── The rule ──────────────────────────────────────────────────────────────
// At the start of any turn past day 60, the board is adjudicated with the same
// ladder the tournaments use (`engine/queries/adjudicate`) and both shells
// present the verdict: desktop through chrome.ts's winner overlay, mobile
// through the tray takeover.
//
// `state.winner` is NOT forged. It is engine truth — no player captured an HQ
// and nobody was routed — so the presentation says "Adjudicated" rather than
// "victorious", and the board is locked instead through the input controller's
// `matchConcluded` predicate (wired in main.ts) plus each shell's own
// match-over affordances. Nothing downstream of the reducer (replay, save,
// campaign scoring) sees a match it did not actually witness.
//
// Skirmish only: main.ts passes `adjudicateStalemate: false` when a mission is
// booted, so a campaign mission is scored by its own dayLimit and never by
// this one.

import type { GameState, PlayerId } from '../engine/core/types';
import { adjudicate } from '../engine/queries/adjudicate';
import type { Verdict } from '../engine/queries/adjudicate';

export { adjudicate };
export type { Verdict };

/**
 * Player-facing Day past which a live skirmish is adjudicated. Sixty days is
 * roughly three times the longest decisive match the AI harnesses produce, so
 * it only ever fires on a genuine stand-off — a real game never feels it.
 */
export const STALEMATE_DAY_CAP = 60;

/** Eyebrow both shells stamp above an adjudicated result, where a real win
 *  reads "Match Concluded". */
export const ADJUDICATED_EYEBROW = 'Adjudicated';

/**
 * Has the live match run past the cap? False once the engine has produced a
 * real winner — that outcome outranks the clock and each shell already has a
 * richer presentation for it.
 *
 * Day is `ceil(turn / 2)`, the same conversion the shells' `dayOf` helpers use
 * (chrome.ts, mobile/tray.ts, mobile/hud-strip.ts, campaign/types.ts): the
 * engine counts plies, the player counts days.
 */
export function stalemateReached(state: GameState): boolean {
  if (state.winner !== null) return false;
  return Math.ceil(state.turn / 2) > STALEMATE_DAY_CAP;
}

/** Headline for a verdict. Takes the shell's own player-name map so this
 *  module doesn't become a second home for the faction names. */
export function adjudicationTitle(
  verdict: Verdict,
  playerNames: Record<PlayerId, string>,
): string {
  return verdict === 'draw' ? 'Draw' : `${playerNames[verdict]} prevails`;
}

/** The line under the headline: why the match stopped, and what decided it. */
export function adjudicationDetail(verdict: Verdict): string {
  return verdict === 'draw'
    ? `Neither side could force a result by day ${STALEMATE_DAY_CAP} — HQs and forces are even.`
    : `Player ${verdict + 1} held the stronger field at the day-${STALEMATE_DAY_CAP} cap.`;
}
