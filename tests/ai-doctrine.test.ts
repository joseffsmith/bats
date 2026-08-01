// Doctrine tests: behavioural micro-positions that assert the AI's INTENT.
//
// Why this file exists: the "cowardly defender" bug (a unit parked in a corner
// while its factory was captured) survived 1400+ tournament matches, because
// self-play win rates are blind to any flaw every persona shares — all four
// personas fled, so all four kept winning half their games. Aggregate scores
// measure relative strength; they cannot measure whether the AI plays the game
// correctly. These tests can.
//
// Each test poses one question a competent player answers the same way every
// time — "an enemy is capturing your city, do you contest it?", "you are three
// tanks up, do you attack?", "you are alone and dying, do you run?" — and
// asserts only the SHAPE of the answer: which action types appear, what they
// target, whether a distance grew or shrank. Never an exact tile. A retuned
// persona may reach the same intent by a different route and must stay green.
//
// tests/ai-defense.test.ts is the seed of this pattern (and the iteration-8
// record); this file extends it rather than touching it.
//
// KNOWN-RED: scenarios today's AI fails are committed as `it.fails` with a
// `FLIP: WP<n>` tag naming the package that owes the fix. They are executable
// specifications of debt, not aspirations. `it.fails` is two-sided — an
// expected failure that starts passing also breaks the build, which is the
// point: the tuning package that fixes it has to come here and say so.

import { describe, expect, it } from 'vitest';
import './test-helpers';
import { personaAI } from '../src/engine/ai/personas';
import { createRng } from '../src/engine/core/rng';
import { manhattan } from '../src/engine/core/types';
import type { GameState, Unit } from '../src/engine/core/types';
import {
  PERSONA_LIST,
  arena,
  attacksIn,
  capturesAt,
  distToHq,
  distToMass,
  finalDestination,
  hasMoveCandidates,
  hqOf,
  neverLeftStart,
  oscillates,
  passiveAI,
  pathOf,
  persistentIds,
  playTurns,
  positionTrack,
  turnsOf,
  unitPositions,
} from './doctrine-helpers';

// ─────────────────────────── Known-red bookkeeping ───────────────────────────

/**
 * persona → work package that owes the fix. A persona listed in a scenario's
 * map runs under `it.fails`: the scenario is right, today's AI is not.
 *
 * Tag meanings (from the WP1 brief):
 *   WP5 — anti-stall, and the only Layer-B package that edits shared scoring
 *         in `utility.ts`; owns oscillation, unfinished endgames, and any
 *         failure uniform across all four personas (a shared-scoring bug by
 *         definition — persona weights cannot be the cause).
 *   WP6 — turtle-wall / balanced-passivity, fixed in `ai-personas.json`.
 *   WP7 — aggressor-specific.
 */
type RedMap = Record<string, string>;

/** Declare one persona's copy of a scenario — red or green. */
function doctrine(
  scenario: string,
  persona: string,
  red: RedMap,
  fn: () => void,
): void {
  const wp = red[persona];
  if (wp) it.fails(`${persona} — ${scenario} [FLIP: ${wp}]`, fn);
  else it(`${persona} — ${scenario}`, fn);
}

function soleUnitOf(state: GameState, owner: 0 | 1): Unit {
  const own = Object.values(state.units).filter((u) => u.owner === owner);
  if (own.length !== 1) throw new Error(`doctrine: expected exactly one p${owner} unit`);
  return own[0]!;
}

// ─────────────────────── 1. Contest capturers ────────────────────────────────
//
// Extends ai-defense.test.ts past its original repro. The defender's job is not
// to survive, it is to stop the capture: a factory or city lost is permanent, a
// damaged tank is not. Both variants make contesting *look* worse to a naive
// scorer than doing something else, which is the pressure the live bug failed
// under.

/** Enemy infantry mid-capture on one of p1's properties, p1 to move. */
function capturerUnderway(opts: {
  terrain: 'factory' | 'city';
  /** Extra p0 (attacker-side) units, e.g. covering artillery. */
  support?: Parameters<typeof arena>[0]['units'];
  /** Extra terrain, e.g. a sea channel. */
  tiles?: Parameters<typeof arena>[0]['tiles'];
  defenders: NonNullable<Parameters<typeof arena>[0]['units']>;
}): GameState {
  return arena({
    width: 10,
    height: 5,
    hq0: { x: 0, y: 2 },
    hq1: { x: 9, y: 2 },
    tiles: [
      { pos: { x: 7, y: 2 }, terrain: opts.terrain, owner: 1 },
      ...(opts.tiles ?? []),
    ],
    units: [
      // u1: the capturer, halfway through taking the tile.
      { type: 'infantry', owner: 0, pos: { x: 7, y: 2 }, hp: 100 },
      ...(opts.support ?? []),
      ...opts.defenders,
    ],
    capturing: { u1: 10 },
    currentPlayer: 1,
  });
}

/** Did the defender hit the capturer at all? */
function contested(state: GameState, persona: string): boolean {
  const actions = personaAI(persona).takeTurn({ state, player: 1, rng: createRng(1) });
  return actions.some((a) => a.type === 'ATTACK' && a.targetId === 'u1');
}

describe('doctrine: contest capturers', () => {
  // Variant (a1) — the control. An enemy artillery sits behind an impassable
  // sea channel, its [2,3] range band covering the direct lane to the
  // capturer. The defender must accept the counter-fire (or work around it) to
  // save the factory. Nothing about the artillery is reachable, so the ONLY
  // variable is whether the defender is willing to fight under fire.
  const COVERED_RED: RedMap = {};
  for (const persona of PERSONA_LIST) {
    doctrine('contests a capturer under covering artillery fire', persona, COVERED_RED, () => {
      const state = capturerUnderway({
        terrain: 'factory',
        tiles: [0, 1, 2, 3, 4].map((y) => ({ pos: { x: 4, y }, terrain: 'sea' as const })),
        support: [{ type: 'artillery', owner: 0, pos: { x: 3, y: 2 }, hp: 100 }],
        defenders: [{ type: 'tank', owner: 1, pos: { x: 5, y: 2 }, hp: 100 }],
      });
      expect(
        contested(state, persona),
        `${persona} should contest the capturer despite covering artillery`,
      ).toBe(true);
    });
  }

  // Variant (a2) — the same artillery, now on the defender's side of the map
  // and reachable: a soft, undefended, 6000-funds target five tiles away. The
  // scoring must not let a fat kill outbid the factory that falls next turn.
  // Trading a property for a frag is how you win the battle and lose the game.
  //
  // Red for ALL FOUR personas → not a weight problem, a shared-scoring one:
  // `nearestHomeIntruder`'s home-defence bonus is outweighed by raw
  // damageDealt on a squishier target. Fix belongs in `utility.ts`, whose
  // Layer-B owner is WP5.
  const DISTRACTION_RED: RedMap = {
    aggressor: 'WP5', // FLIP: WP5
    turtle: 'WP5', // FLIP: WP5
    economist: 'WP5', // FLIP: WP5
    balanced: 'WP5', // FLIP: WP5
  };
  for (const persona of PERSONA_LIST) {
    doctrine('contests the capturer rather than hunting a soft target', persona, DISTRACTION_RED, () => {
      const state = capturerUnderway({
        terrain: 'factory',
        support: [{ type: 'artillery', owner: 0, pos: { x: 3, y: 2 }, hp: 100 }],
        defenders: [{ type: 'tank', owner: 1, pos: { x: 5, y: 2 }, hp: 100 }],
      });
      expect(
        contested(state, persona),
        `${persona} went hunting the artillery and let the factory fall`,
      ).toBe(true);
    });
  }

  // Variant (b) — the contested property is a city, not a factory. Worth less,
  // but still permanent territory and income. "Only a city" is not a reason to
  // let it go.
  const CITY_RED: RedMap = {};
  for (const persona of PERSONA_LIST) {
    doctrine('contests a capturer standing on an owned city', persona, CITY_RED, () => {
      const state = capturerUnderway({
        terrain: 'city',
        defenders: [{ type: 'tank', owner: 1, pos: { x: 5, y: 2 }, hp: 100 }],
      });
      expect(
        contested(state, persona),
        `${persona} should contest a capturer on an owned city`,
      ).toBe(true);
    });
  }
});

// ─────────────────────── 2. Convert material leads ───────────────────────────

describe('doctrine: convert a material lead', () => {
  // Three tanks and an infantry against a lone infantry. There is no reading of
  // this position where sitting still is right: either engage, or march on the
  // HQ. Two own-turns is generous — one is enough for a human. The weak side is
  // passive so the measurement is purely "what does the strong side do with a
  // free hand".
  function crushingLead(): GameState {
    return arena({
      width: 12,
      height: 7,
      units: [
        { type: 'tank', owner: 0, pos: { x: 2, y: 2 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 2, y: 3 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 2, y: 4 }, hp: 100 },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 3 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 10, y: 3 }, hp: 100 },
      ],
      currentPlayer: 0,
    });
  }

  const LEAD_RED: RedMap = {};
  for (const persona of PERSONA_LIST) {
    doctrine('attacks or marches on the HQ within two turns', persona, LEAD_RED, () => {
      const state = crushingLead();
      const result = playTurns(state, { 0: personaAI(persona), 1: passiveAI() }, 2);

      const attacks = attacksIn(turnsOf(result, 0).flatMap((t) => t.actions));
      if (attacks.length > 0) return; // engaging is a complete answer

      // Otherwise the army must at least be walking at the enemy HQ.
      const enemyHq = hqOf(state, 1);
      const start = unitPositions(state, 0);
      const end = unitPositions(result.state, 0);
      let closer = 0;
      let counted = 0;
      for (const [id, from] of start) {
        const to = end.get(id);
        if (!to) continue; // died — not a passivity data point
        counted += 1;
        if (manhattan(to, enemyHq) < manhattan(from, enemyHq)) closer += 1;
      }
      expect(counted).toBeGreaterThan(0);
      expect(
        closer * 2 > counted,
        `${persona} neither attacked nor advanced a majority of its units ` +
          `(${closer}/${counted} closed on the enemy HQ)`,
      ).toBe(true);
    });
  }
});

// ─────────────────────── 3. No oscillation, no idling ────────────────────────

describe('doctrine: no oscillation or idling', () => {
  // Six own-turns against an opponent that only ends its turn. Two garrisoned
  // home cities, an enemy pair parked across the map: an ordinary quiet
  // mid-game, and exactly the shape of the tournament games that ran to the
  // 120-turn cap. With a free hand for six turns, no unit should be walking a
  // two-tile loop.
  function freeRein(): GameState {
    return arena({
      width: 12,
      height: 7,
      tiles: [
        { pos: { x: 2, y: 1 }, terrain: 'city', owner: 0 },
        { pos: { x: 2, y: 5 }, terrain: 'city', owner: 0 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 1 }, hp: 100 },
        { type: 'infantry', owner: 0, pos: { x: 2, y: 5 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 2, y: 3 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 10, y: 3 }, hp: 100 },
        { type: 'tank', owner: 1, pos: { x: 10, y: 4 }, hp: 100 },
      ],
      currentPlayer: 0,
    });
  }

  // Red for three of four: units shuttle between two tiles for the whole run
  // (turtle/economist bounce a tank home-city ↔ midfield; balanced walks an
  // infantry to its own HQ and back, repeatedly). Aggressor escapes only by
  // routing the enemy before the loop can establish itself. A tie-break drift
  // term for units whose candidates all score ≈0 is WP5's stated remedy.
  const OSC_RED: RedMap = {
    turtle: 'WP5', // FLIP: WP5
    economist: 'WP5', // FLIP: WP5
    balanced: 'WP5', // FLIP: WP5
  };
  for (const persona of PERSONA_LIST) {
    doctrine('no unit ping-pongs between two tiles', persona, OSC_RED, () => {
      const state = freeRein();
      const result = playTurns(state, { 0: personaAI(persona), 1: passiveAI() }, 6);
      const track = positionTrack(result, 0);
      const ids = persistentIds(track);
      expect(ids.length, 'no surviving units to measure').toBeGreaterThan(0);
      for (const id of ids) {
        const path = pathOf(track, id);
        expect(
          oscillates(path),
          `${persona}: ${id} shuttled A→B→A→B along ` +
            path.map((c) => `${c.x},${c.y}`).join(' > '),
        ).toBe(false);
      }
    });
  }

  // The stronger form of parking: a unit that never leaves its opening tile at
  // all, despite having legal moves available. Green today — the AI does get
  // everything moving at least once — so this is a guard against regressing to
  // the frozen-defender behaviour that started all of this.
  const IDLE_RED: RedMap = {};
  for (const persona of PERSONA_LIST) {
    doctrine('no mobile unit stands still for six turns', persona, IDLE_RED, () => {
      const state = freeRein();
      const result = playTurns(state, { 0: personaAI(persona), 1: passiveAI() }, 6);
      const track = positionTrack(result, 0);
      const ids = persistentIds(track);
      expect(ids.length, 'no surviving units to measure').toBeGreaterThan(0);
      let measured = 0;
      for (const id of ids) {
        const unit = state.units[id];
        if (!unit) continue;
        // Only units that COULD have gone somewhere count as idle.
        if (!hasMoveCandidates(state, unit)) continue;
        measured += 1;
        const path = pathOf(track, id);
        expect(
          neverLeftStart(path),
          `${persona}: ${id} (${unit.type}) never left ${path[0]!.x},${path[0]!.y} ` +
            `in six turns despite having legal moves`,
        ).toBe(false);
      }
      expect(measured, 'no mobile units to measure').toBeGreaterThan(0);
    });
  }
});

// ─────────────────────── 4. Retreat when dead-lost ───────────────────────────

describe('doctrine: retreat when the fight is lost', () => {
  // One 20hp tank against four healthy units. Every attack loses the trade and
  // the counter kills; the tank is also the player's last unit, so dying is
  // losing outright. Correct play is to disengage — toward home, away from the
  // mass, either reads as intent. Standing still is the one answer that cannot
  // be right.
  function doomedTank(): GameState {
    return arena({
      width: 12,
      height: 7,
      units: [
        { type: 'tank', owner: 0, pos: { x: 7, y: 3 }, hp: 20 },
        { type: 'tank', owner: 1, pos: { x: 9, y: 3 }, hp: 100 },
        { type: 'tank', owner: 1, pos: { x: 9, y: 2 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 9, y: 4 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 10, y: 3 }, hp: 100 },
      ],
      currentPlayer: 0,
    });
  }

  const RETREAT_RED: RedMap = {};
  for (const persona of PERSONA_LIST) {
    doctrine('disengages instead of trading into a lethal counter', persona, RETREAT_RED, () => {
      const state = doomedTank();
      const tank = soleUnitOf(state, 0);
      const actions = personaAI(persona).takeTurn({ state, player: 0, rng: createRng(1) });

      // (i) No suicide.
      expect(
        attacksIn(actions).some((a) => a.attackerId === tank.id),
        `${persona}: 20hp tank attacked into a lethal counter`,
      ).toBe(false);

      // (ii) It actually went somewhere.
      const dest = finalDestination(actions, tank.id);
      expect(dest, `${persona}: 20hp tank stayed put instead of retreating`).not.toBeNull();

      // (iii) The move reads as disengagement.
      const awayFromMass = distToMass(dest!, state, 1) > distToMass(tank.pos, state, 1);
      const towardHome = distToHq(dest!, state, 0) < distToHq(tank.pos, state, 0);
      expect(
        awayFromMass || towardHome,
        `${persona}: moved to ${dest!.x},${dest!.y} — neither away from the ` +
          `enemy mass nor toward its own HQ`,
      ).toBe(true);
    });
  }
});

// ─────────────────────── 5. Finish won endgames ──────────────────────────────

describe('doctrine: finish a won endgame', () => {
  // Two tanks in support, an infantry already standing next to an undefended
  // enemy HQ, and two stray enemy infantry marooned in the far corner (two, so
  // that a rout is out of reach in two turns and the ONLY way to finish is to
  // take the HQ). The game is won; the AI has to walk one tile and capture.
  //
  // Failing to close out a won position is the mechanism behind mirror matches
  // that ran past 700 turns and the crossroads pairings that always hit the
  // 120-turn cap.
  function wonEndgame(): GameState {
    return arena({
      width: 12,
      height: 7,
      units: [
        { type: 'infantry', owner: 0, pos: { x: 10, y: 3 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 9, y: 2 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 9, y: 4 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 6 }, hp: 100 },
      ],
      currentPlayer: 0,
    });
  }

  // Turtle alone fails, and it fails by walling: it drives its own TANK onto
  // the enemy HQ tile, which is worth zero (tanks cannot capture) and which
  // physically blocks the infantry standing beside it from ever getting there.
  // Tagged WP5 with the rest of the finish-endgame family, though the
  // mechanism is turtle's positional/defender overrides — if WP5's late-game
  // pressure ramp doesn't clear it, ownership moves to WP6.
  const FINISH_RED: RedMap = {
    turtle: 'WP5', // FLIP: WP5
  };
  for (const persona of PERSONA_LIST) {
    doctrine('captures the exposed enemy HQ within two turns', persona, FINISH_RED, () => {
      const state = wonEndgame();
      const enemyHq = hqOf(state, 1);
      const result = playTurns(state, { 0: personaAI(persona), 1: passiveAI() }, 2);
      const captures = turnsOf(result, 0).flatMap((t) => capturesAt(t, enemyHq));
      expect(
        captures.length,
        `${persona}: never issued a CAPTURE on the enemy HQ at ` +
          `${enemyHq.x},${enemyHq.y} in two turns`,
      ).toBeGreaterThan(0);
    });
  }
});
