// Tests for the replay degeneracy miner (scripts/mine-replays.ts).
//
// Fixture strategy: **generated, not handcrafted**. Every fixture log is built
// here by folding a scripted action sequence through the real reducer and
// serializing the result in `runMatch`'s JSONL shape, then written to a temp
// dir that the miner scans like any other log directory. Handwritten JSONL
// would encode a guess at what the rules do — an illegal action is silently a
// no-op, so a typo'd fixture would produce states nobody asserted on. `play()`
// throws the moment an action fails to change the state, so a fixture that
// stops describing a legal game fails loudly instead of quietly testing
// nothing.
//
// The four scripted matches on `duel` are built so that each detector trips on
// exactly one of them, plus a clean match that trips nothing:
//
//   uncontested-capture  p1 walks onto p0's HQ and takes it while p0's
//                        infantry loiters two tiles away and never swings
//   stalled-unit         p1's infantry paces (9,2)<->(9,3) for 7 own-turns
//                        until a tank p0 built rolls over and kills it
//   turn-cap             both sides pass until the header's maxTurns
//   held-lead            p0 builds a tank, holds a 700% material lead for 24
//                        turns while patrolling, and loses its HQ anyway
//   clean                same race as uncontested-capture, but p0's infantry
//                        is out of striking distance when the HQ falls

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import duelMap from '../src/data/maps/duel.json';
import { setLogEnabled } from '../src/engine/core/logger';
import { reduce } from '../src/engine/core/reducer';
import type { Action, Coord, GameState, UnitId, UnitType } from '../src/engine/core/types';
import { loadMap } from '../src/engine/data/loader';
import {
  DEFAULT_OPTIONS,
  heldLeadNoWin,
  hpWeightedCost,
  leadPercent,
  loadMinedLog,
  mineDir,
  parseArgs,
  stalledUnit,
  strikingDistance,
  turnCapHit,
  turnRecords,
  uncontestedCapture,
  type MinedLog,
} from '../scripts/mine-replays';

setLogEnabled('engine', false);
setLogEnabled('replay', false);
setLogEnabled('match', false);

// ─────────────────────────── fixture construction ────────────────────────────

/** A match under construction: real states, real legality, JSONL out. */
class Match {
  state: GameState = loadMap(duelMap);
  private readonly lines: string[] = [];

  constructor(maxTurns: number) {
    this.lines.push(
      JSON.stringify({
        type: 'header',
        map: 'duel',
        seed: 1,
        maxTurns,
        p0: 'fixture',
        p1: 'fixture',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }

  /** Apply one action; a no-op (illegal) action is a fixture bug, so throw. */
  act(action: Action): this {
    const before = this.state;
    const next = reduce(before, action);
    if (next === before) {
      throw new Error(
        `fixture action was illegal at turn ${before.turn} (p${before.currentPlayer}): ${JSON.stringify(action)}`,
      );
    }
    this.lines.push(
      JSON.stringify({
        type: 'action',
        turn: before.turn,
        player: before.currentPlayer,
        action,
      }),
    );
    this.state = next;
    return this;
  }

  unit(id: UnitId) {
    const u = this.state.units[id];
    if (!u) throw new Error(`fixture: no unit ${id}`);
    return u;
  }

  /** MOVE along the given steps. `path` excludes the start tile (see validatePath). */
  move(unitId: UnitId, ...steps: Coord[]): this {
    return this.act({ type: 'MOVE', unitId, path: steps });
  }

  /** Advance one tile around a closed patrol route. */
  patrol(unitId: UnitId, cycle: readonly Coord[]): this {
    const pos = this.unit(unitId).pos;
    const at = cycle.findIndex((c) => c.x === pos.x && c.y === pos.y);
    if (at < 0) throw new Error(`fixture: ${unitId} at (${pos.x},${pos.y}) is off its patrol route`);
    return this.move(unitId, cycle[(at + 1) % cycle.length]!);
  }

  capture(unitId: UnitId): this {
    return this.act({ type: 'CAPTURE', unitId });
  }

  attack(attackerId: UnitId, targetId: UnitId): this {
    return this.act({ type: 'ATTACK', attackerId, targetId });
  }

  build(at: Coord, unitType: UnitType): this {
    return this.act({ type: 'BUILD', at, unitType, owner: this.state.currentPlayer });
  }

  end(): this {
    return this.act({ type: 'END_TURN' });
  }

  /** Serialize header + actions + summary, exactly as runMatch writes them. */
  finish(): string {
    const lines = [...this.lines];
    lines.push(
      JSON.stringify({
        type: 'summary',
        turns: this.state.turn,
        winner: this.state.winner,
      }),
    );
    return lines.join('\n') + '\n';
  }
}

const at = (x: number, y: number): Coord => ({ x, y });

// u1 = p0 infantry (2,2); u2 = p1 infantry (9,2) — see src/data/maps/duel.json.
const P0_INF = 'u1';
const P1_INF = 'u2';
const P0_HQ = at(1, 2);
const P0_FACTORY = at(1, 3);

/**
 * p1's infantry walks the north road to p0's HQ and takes it, while p0's lone
 * infantry shuffles around one tile away and never attacks.
 */
function fixtureUncontestedCapture(): string {
  const m = new Match(120);
  // p0 loiters on a 3-tile beat (never 2 tiles for 6 turns → no stall flag),
  // always inside infantry striking distance of its own HQ.
  const loiter = [at(2, 3), at(2, 4), at(2, 3), at(2, 2), at(2, 3)];
  const march: Coord[][] = [
    [at(9, 1), at(8, 1), at(7, 1)],
    [at(6, 1), at(5, 1), at(4, 1)],
    [at(3, 1), at(2, 1), at(1, 1)],
  ];
  for (let i = 0; i < 3; i++) {
    m.move(P0_INF, loiter[i]!).end();
    m.move(P1_INF, ...march[i]!).end();
  }
  m.move(P0_INF, loiter[3]!).end();
  m.move(P1_INF, P0_HQ).capture(P1_INF).end(); // progress 10/20
  m.move(P0_INF, loiter[4]!).end();
  m.capture(P1_INF); // 20/20 → HQ flips → p1 wins
  return m.finish();
}

/** Same race, but p0's infantry runs east and is out of reach when the HQ falls. */
function fixtureClean(): string {
  const m = new Match(120);
  const flee: Coord[][] = [
    [at(3, 2), at(4, 2), at(5, 2)],
    [at(6, 2), at(7, 2), at(8, 2)],
    [at(8, 3), at(8, 4), at(8, 5)],
    [at(9, 5), at(9, 6), at(9, 7)],
  ];
  const march: Coord[][] = [
    [at(9, 1), at(8, 1), at(7, 1)],
    [at(6, 1), at(5, 1), at(4, 1)],
    [at(3, 1), at(2, 1), at(1, 1)],
  ];
  for (let i = 0; i < 3; i++) {
    m.move(P0_INF, ...flee[i]!).end();
    m.move(P1_INF, ...march[i]!).end();
  }
  m.move(P0_INF, ...flee[3]!).end();
  m.move(P1_INF, P0_HQ).capture(P1_INF).end();
  m.move(P0_INF, at(8, 7)).end();
  m.capture(P1_INF);
  return m.finish();
}

/**
 * p1's infantry paces between two tiles for seven straight turns while p0
 * banks income, builds a tank, drives it over and routs it.
 */
function fixtureStalledUnit(): string {
  const m = new Match(120);
  const pace = [at(9, 3), at(9, 2)];
  m.move(P0_INF, P0_HQ).end(); // garrison: HQ sitters are exempt from the stall flag
  m.patrol(P1_INF, pace).end();
  for (let i = 0; i < 3; i++) {
    m.end(); // p0 banks 2000/turn
    m.patrol(P1_INF, pace).end();
  }
  m.build(P0_FACTORY, 'tank').end(); // u3
  m.patrol(P1_INF, pace).end();
  m.move('u3', at(2, 3), at(2, 2), at(2, 1), at(3, 1), at(4, 1), at(5, 1)).end();
  m.patrol(P1_INF, pace).end(); // 6th own-turn on two tiles
  m.move('u3', at(6, 1), at(7, 1), at(8, 1), at(9, 1)).attack('u3', P1_INF).end();
  m.patrol(P1_INF, pace).end(); // 7th
  m.move('u3', at(9, 2)).attack('u3', P1_INF); // rout → p0 wins
  return m.finish();
}

/** Nobody does anything until the header's turn cap. */
function fixtureTurnCap(): string {
  const m = new Match(8);
  while (m.state.turn < 8) m.end();
  return m.finish();
}

/**
 * p0 builds a tank on turn 9 and then patrols with it for the rest of the
 * match — a 700% material lead held for 26 turns while p1's lone infantry
 * strolls across the board and takes p0's HQ unopposed. Both p0 units stay
 * well outside striking distance of their own HQ, so the losing capture is
 * *not* an uncontested-capture hit: nobody could have contested it.
 */
function fixtureHeldLead(): string {
  const m = new Match(120);
  const footBeat = [at(6, 7), at(6, 6), at(7, 6), at(7, 7)];
  const tankBeat = [at(8, 4), at(9, 4), at(9, 5), at(8, 5)];

  m.move(P0_INF, at(2, 3), at(2, 4), at(2, 5)).end();
  m.move(P1_INF, at(10, 2)).end(); // garrison p1's HQ

  m.move(P0_INF, at(2, 6), at(2, 7), at(3, 7)).end();
  m.end();
  m.move(P0_INF, at(4, 7), at(5, 7), at(6, 7)).end(); // on the beat from turn 5
  m.end();
  m.patrol(P0_INF, footBeat).end();
  m.end();
  m.build(P0_FACTORY, 'tank').patrol(P0_INF, footBeat).end(); // turn 9: lead starts
  m.end();
  m.move('u3', at(1, 4), at(2, 4), at(3, 4), at(4, 4), at(5, 4)).patrol(P0_INF, footBeat).end();
  m.end();
  m.move('u3', at(6, 4), at(7, 4), at(8, 4)).patrol(P0_INF, footBeat).end();
  m.end();
  // Turns 15–25: p0 patrols with everything, p1 sits on its HQ.
  for (let t = 0; t < 6; t++) {
    m.patrol('u3', tankBeat).patrol(P0_INF, footBeat).end();
    m.end();
  }
  // Turn 27 onward: p1 finally walks at p0's HQ.
  m.patrol('u3', tankBeat).patrol(P0_INF, footBeat).end();
  m.move(P1_INF, at(9, 2), at(8, 2), at(7, 2)).end();
  m.patrol('u3', tankBeat).patrol(P0_INF, footBeat).end();
  m.move(P1_INF, at(6, 2), at(5, 2), at(4, 2)).end();
  m.patrol('u3', tankBeat).patrol(P0_INF, footBeat).end();
  m.move(P1_INF, at(3, 2), at(2, 2), P0_HQ).capture(P1_INF).end();
  m.patrol('u3', tankBeat).patrol(P0_INF, footBeat).end();
  m.capture(P1_INF); // p1 wins on turn 34
  return m.finish();
}

const FIXTURES: Record<string, () => string> = {
  'uncontested-capture.jsonl': fixtureUncontestedCapture,
  'stalled-unit.jsonl': fixtureStalledUnit,
  'turn-cap.jsonl': fixtureTurnCap,
  'held-lead.jsonl': fixtureHeldLead,
  'clean.jsonl': fixtureClean,
};

let dir = '';
const logs = new Map<string, MinedLog>();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mine-replays-'));
  await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
  for (const [name, build] of Object.entries(FIXTURES)) {
    const text = build();
    // One fixture lives a directory down to exercise the recursive walk.
    const file = name === 'clean.jsonl' ? path.join(dir, 'nested', name) : path.join(dir, name);
    await fs.writeFile(file, text, 'utf8');
    logs.set(name, await loadMinedLog(name, text));
  }
});

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const log = (name: string): MinedLog => {
  const l = logs.get(name);
  if (!l) throw new Error(`fixture ${name} not built`);
  return l;
};

// ───────────────────────────────── tests ─────────────────────────────────────

describe('mine-replays fixtures', () => {
  it('every fixture replays cleanly to the recorded summary', () => {
    for (const [name, l] of logs) {
      const final = l.states[l.states.length - 1]!;
      expect(final.winner, name).toBe(l.parsed.summary?.winner ?? null);
      expect(final.turn, name).toBe(l.parsed.summary?.turns);
    }
  });

  it('states line up with actions (states[i+1] is the state after actions[i])', () => {
    const l = log('uncontested-capture.jsonl');
    expect(l.states.length).toBe(l.parsed.actions.length + 1);
    expect(l.states[0]!.turn).toBe(1);
  });
});

describe('uncontestedCapture', () => {
  it('flags the HQ taken while an in-reach defender never swings', () => {
    const hits = uncontestedCapture(log('uncontested-capture.jsonl'));
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.tile).toEqual(P0_HQ);
    expect(hit.terrain).toBe('hq');
    expect(hit.victim).toBe(0);
    expect(hit.capturerId).toBe(P1_INF);
    expect(hit.idleDefenderIds).toEqual([P0_INF]);
    // Window spans the two turns of capture progress.
    expect(hit.toTurn - hit.fromTurn).toBeGreaterThanOrEqual(1);
  });

  it('does not flag a capture nobody was in range to contest', () => {
    expect(uncontestedCapture(log('clean.jsonl'))).toEqual([]);
  });

  it('is silent on the other fixtures', () => {
    expect(uncontestedCapture(log('stalled-unit.jsonl'))).toEqual([]);
    expect(uncontestedCapture(log('turn-cap.jsonl'))).toEqual([]);
    expect(uncontestedCapture(log('held-lead.jsonl'))).toEqual([]);
  });
});

describe('stalledUnit', () => {
  it('flags a unit pacing between two tiles for >= stall-turns own turns', () => {
    const hits = stalledUnit(log('stalled-unit.jsonl'), DEFAULT_OPTIONS);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.unitId).toBe(P1_INF);
    expect(hit.owner).toBe(1);
    expect(hit.unitType).toBe('infantry');
    expect(hit.ownTurns).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.stallTurns);
    expect(hit.tiles.map((t) => `${t.x},${t.y}`).sort()).toEqual(['9,2', '9,3']);
  });

  it('respects the --stall-turns threshold', () => {
    expect(stalledUnit(log('stalled-unit.jsonl'), { stallTurns: 20 })).toEqual([]);
    expect(stalledUnit(log('stalled-unit.jsonl'), { stallTurns: 3 }).length).toBeGreaterThan(0);
  });

  it('exempts HQ garrisons, patrols and capturers', () => {
    // p0's infantry sits on its own HQ for the whole stalled-unit fixture.
    expect(stalledUnit(log('stalled-unit.jsonl'), DEFAULT_OPTIONS).map((h) => h.unitId)).not.toContain(
      P0_INF,
    );
    expect(stalledUnit(log('held-lead.jsonl'), DEFAULT_OPTIONS)).toEqual([]);
    expect(stalledUnit(log('turn-cap.jsonl'), DEFAULT_OPTIONS)).toEqual([]);
    expect(stalledUnit(log('uncontested-capture.jsonl'), DEFAULT_OPTIONS)).toEqual([]);
    expect(stalledUnit(log('clean.jsonl'), DEFAULT_OPTIONS)).toEqual([]);
  });
});

describe('turnCapHit', () => {
  it('flags a match that ran out the header cap with no winner', () => {
    const hits = turnCapHit(log('turn-cap.jsonl'), DEFAULT_OPTIONS);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.turns).toBe(8);
    expect(hits[0]!.maxTurns).toBe(8);
    expect(hits[0]!.reasons).toEqual(['no-winner', 'turn-cap']);
  });

  it('is silent on matches that ended in a win under the cap', () => {
    for (const name of ['uncontested-capture.jsonl', 'stalled-unit.jsonl', 'held-lead.jsonl', 'clean.jsonl']) {
      expect(turnCapHit(log(name), DEFAULT_OPTIONS), name).toEqual([]);
    }
  });

  it('flags a log with no summary line at all', async () => {
    const text = fixtureUncontestedCapture()
      .split('\n')
      .filter((l) => !l.includes('"summary"'))
      .join('\n');
    const truncated = await loadMinedLog('abandoned.jsonl', text);
    expect(turnCapHit(truncated, DEFAULT_OPTIONS)[0]!.reasons).toEqual(['no-summary']);
  });
});

describe('heldLeadNoWin', () => {
  it('flags a big material lead held for >= lead-turns without converting', () => {
    const hits = heldLeadNoWin(log('held-lead.jsonl'), DEFAULT_OPTIONS);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.player).toBe(0);
    expect(hit.winner).toBe(1);
    expect(hit.turns).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.leadTurns);
    expect(hit.minLeadPct).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.leadPct);
    expect(hit.fromTurn).toBe(9); // the turn the tank rolled off the line
    expect([hit.turns, hit.toTurn]).toEqual([26, 34]); // pinned: lead ran to the final turn
  });

  it('respects the --lead-pct / --lead-turns thresholds', () => {
    expect(heldLeadNoWin(log('held-lead.jsonl'), { leadPct: 40, leadTurns: 100 })).toEqual([]);
    expect(heldLeadNoWin(log('held-lead.jsonl'), { leadPct: 1000, leadTurns: 20 })).toEqual([]);
  });

  it('does not flag a lead that was converted into the win', () => {
    // p0 builds a tank in the stalled-unit fixture too — and then wins with it.
    expect(heldLeadNoWin(log('stalled-unit.jsonl'), { leadPct: 40, leadTurns: 1 })).toEqual([]);
  });

  it('is silent on the even-material fixtures', () => {
    for (const name of ['uncontested-capture.jsonl', 'turn-cap.jsonl', 'clean.jsonl']) {
      expect(heldLeadNoWin(log(name), DEFAULT_OPTIONS), name).toEqual([]);
    }
  });
});

describe('helpers', () => {
  it('striking distance is move + attack range + 1', () => {
    expect(strikingDistance('infantry')).toBe(3 + 1 + 1);
    expect(strikingDistance('tank')).toBe(6 + 1 + 1);
    expect(strikingDistance('artillery')).toBe(5 + 3 + 1);
  });

  it('hp-weighted cost matches the round-robin adjudication model', () => {
    const l = log('held-lead.jsonl');
    const final = l.states[l.states.length - 1]!;
    expect(hpWeightedCost(final, 0)).toBe(1000 + 7000); // infantry + tank, both full hp
    expect(hpWeightedCost(final, 1)).toBe(1000);
    expect(leadPercent(8000, 1000)).toBe(700);
    expect(leadPercent(0, 0)).toBe(0);
  });

  it('turn records are one per completed turn, in order', () => {
    const l = log('turn-cap.jsonl');
    const records = turnRecords(l.states);
    expect(records.map((r) => r.turn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(records.map((r) => r.player)).toEqual([0, 1, 0, 1, 0, 1, 0]);
  });
});

describe('parseArgs', () => {
  it('defaults the thresholds and requires a source', () => {
    expect(parseArgs(['--dir', 'logs'])).toMatchObject({ dir: 'logs', remote: false, ...DEFAULT_OPTIONS });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--remote', '--stall-turns', 'six'])).toThrow(/expects a number/);
  });

  it('parses every knob', () => {
    const args = parseArgs([
      '--remote',
      '--base',
      'http://localhost:8080',
      '--stall-turns',
      '9',
      '--lead-pct',
      '25',
      '--lead-turns',
      '30',
      '--max-turns',
      '200',
      '--limit',
      '5',
      '--json',
    ]);
    expect(args).toEqual({
      dir: null,
      remote: true,
      base: 'http://localhost:8080',
      json: true,
      limit: 5,
      stallTurns: 9,
      leadPct: 25,
      leadTurns: 30,
      defaultMaxTurns: 200,
    });
  });
});

describe('mineDir', () => {
  it('walks a log tree, mines every file, and tallies one hit per flag', async () => {
    const result = await mineDir(dir, DEFAULT_OPTIONS);
    expect(result.scanned).toBe(5);
    expect(result.parseErrors).toEqual([]);
    expect(result.flags.uncontestedCapture).toHaveLength(1);
    expect(result.flags.stalledUnit).toHaveLength(1);
    expect(result.flags.turnCapHit).toHaveLength(1);
    expect(result.flags.heldLeadNoWin).toHaveLength(1);
    // Each hit names the file it came from (the nested one included).
    expect(path.basename(result.flags.uncontestedCapture[0]!.file)).toBe('uncontested-capture.jsonl');
    expect(path.basename(result.flags.stalledUnit[0]!.file)).toBe('stalled-unit.jsonl');
  });

  it('counts unparseable logs instead of dying on them', async () => {
    const bad = path.join(dir, 'nested', 'broken.jsonl');
    await fs.writeFile(bad, '{ not json at all\n', 'utf8');
    const empty = path.join(dir, 'nested', 'empty.jsonl');
    await fs.writeFile(empty, '', 'utf8');
    try {
      const result = await mineDir(dir, DEFAULT_OPTIONS);
      expect(result.scanned).toBe(5);
      expect(result.parseErrors.map((e) => path.basename(e.file)).sort()).toEqual([
        'broken.jsonl',
        'empty.jsonl',
      ]);
      expect(result.flags.turnCapHit).toHaveLength(1);
    } finally {
      await fs.rm(bad, { force: true });
      await fs.rm(empty, { force: true });
    }
  });

  it('honours --limit', async () => {
    const result = await mineDir(dir, DEFAULT_OPTIONS, 2);
    expect(result.scanned).toBe(2);
  });
});
