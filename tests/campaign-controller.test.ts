// Mission runtime (src/campaign/controller.ts).
//
// The runtime is pure wiring — briefing → BEGIN → hints + scorekeeping →
// debrief → navigation — so every test here drives it through the real emitter
// (real reducer, real hint runner, real tracker) with two things stubbed: the
// presenter, so we can read what the player would have been shown, and the
// navigator, so CONTINUE / RETRY / MENU record a target instead of reloading
// the page. No DOM is needed for any of it.

import { beforeEach, describe, expect, it } from 'vitest';
import campaignJson from '../src/data/campaign.json';
import c1Map from '../src/data/maps/c1_first_strike.json';
import { loadMap } from '../src/engine/data/loader';
import { setLogEnabled } from '../src/engine/core/logger';
import type { GameState } from '../src/engine/core/types';
import { createEmitter } from '../src/renderer/emitter';
import type { Emitter } from '../src/renderer/emitter';
import { loadCampaign } from '../src/campaign/loader';
import { createProgressStore } from '../src/campaign/progress';
import type { ProgressStore, StorageLike } from '../src/campaign/progress';
import {
  buildSelectRows,
  buildSelectView,
  createCampaignRuntime,
  maxStarsFor,
  parseCampaignParam,
  starCriteria,
} from '../src/campaign/controller';
import type { CampaignNav } from '../src/campaign/controller';
import type {
  CampaignPresenter,
  CompleteView,
  DefeatView,
  IntroView,
} from '../src/campaign/screens';
import type { Mission } from '../src/campaign/types';

setLogEnabled('engine', false);

const MISSIONS: Mission[] = loadCampaign(campaignJson);
const M1 = MISSIONS[0]!;

// ─────────────────────────── Stubs ───────────────────────────────────────────

type StubUI = CampaignPresenter & {
  objective: (string | null)[];
  hints: (string | null)[];
  intro: IntroView | null;
  complete: CompleteView | null;
  defeat: DefeatView | null;
  clears: number;
  begin(): void;
  continue(): void;
  retry(): void;
  menu(): void;
};

function stubUI(): StubUI {
  let onBegin: (() => void) | null = null;
  let onContinue: (() => void) | null = null;
  let onRetry: (() => void) | null = null;
  let onMenu: (() => void) | null = null;
  const ui: StubUI = {
    objective: [],
    hints: [],
    intro: null,
    complete: null,
    defeat: null,
    clears: 0,
    setObjective(text): void {
      ui.objective.push(text);
    },
    setHint(text): void {
      ui.hints.push(text);
    },
    showIntro(view, handlers): void {
      ui.intro = view;
      onBegin = handlers.onBegin;
    },
    showComplete(view, handlers): void {
      ui.complete = view;
      onContinue = handlers.onContinue;
    },
    showDefeat(view, handlers): void {
      ui.defeat = view;
      onRetry = handlers.onRetry;
      onMenu = handlers.onMenu;
    },
    clear(): void {
      ui.clears += 1;
    },
    destroy(): void {},
    begin: () => onBegin?.(),
    continue: () => onContinue?.(),
    retry: () => onRetry?.(),
    menu: () => onMenu?.(),
  };
  return ui;
}

type StubNav = CampaignNav & { targets: (number | 'menu' | 'retry')[] };

function stubNav(): StubNav {
  const targets: (number | 'menu' | 'retry')[] = [];
  return {
    targets,
    goTo: (t) => targets.push(t),
    retry: () => targets.push('retry'),
  };
}

function memoryStore(): ProgressStore {
  const map = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return createProgressStore({ storage });
}

/** Force the match to a finished / advanced position. `setState` emits with a
 *  null action, which the tracker treats as a scenario swap — exactly how a
 *  load or replay scrub reaches it. */
function force(emitter: Emitter, over: Partial<GameState>): void {
  emitter.setState({ ...emitter.getState(), ...over });
}

type Harness = {
  emitter: Emitter;
  ui: StubUI;
  nav: StubNav;
  progress: ProgressStore;
  runtime: ReturnType<typeof createCampaignRuntime>;
};

function harness(mission: Mission = M1, total = MISSIONS.length): Harness {
  const emitter = createEmitter(loadMap(c1Map));
  const ui = stubUI();
  const nav = stubNav();
  const progress = memoryStore();
  const runtime = createCampaignRuntime({ mission, emitter, ui, nav, progress, total });
  return { emitter, ui, nav, progress, runtime };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

// ─────────────────────────── Briefing ────────────────────────────────────────

describe('briefing', () => {
  it('shows the intro on creation, before anything is running', () => {
    expect(h.ui.intro).not.toBeNull();
    expect(h.ui.intro).toMatchObject({
      n: 1,
      total: 5,
      title: M1.title,
      objective: M1.objective,
      commander: { name: M1.opponent.name, flavor: M1.opponent.flavor },
    });
    expect(h.ui.intro?.lines).toEqual(M1.intro);
    expect(h.runtime.started()).toBe(false);
    // Nothing is coached or tracked until BEGIN.
    expect(h.ui.objective).toEqual([]);
    expect(h.ui.hints).toEqual([]);
  });

  it('BEGIN dismisses the card, posts the objective and starts the hint script', () => {
    h.ui.begin();
    expect(h.runtime.started()).toBe(true);
    expect(h.ui.clears).toBe(1);
    expect(h.ui.objective).toEqual([M1.objective]);
    // Mission 1's first hint shows immediately.
    expect(h.ui.hints).toEqual([M1.hints[0]!.text]);
  });

  it('is idempotent — a second BEGIN does not restart anything', () => {
    h.ui.begin();
    h.ui.begin();
    expect(h.ui.objective).toEqual([M1.objective]);
    expect(h.ui.hints).toEqual([M1.hints[0]!.text]);
  });

  it('runs the hint script forward off the emitter', () => {
    h.ui.begin();
    // h1 clears on `unit-selected`, which is also h2's show trigger.
    h.emitter.emit({ type: 'inputStateChanged', kind: 'unit-selected' });
    expect(h.ui.hints).toEqual([M1.hints[0]!.text, null, M1.hints[1]!.text]);

    // h2 clears on MOVE; h3 shows on the same event.
    h.emitter.dispatch({
      type: 'MOVE',
      unitId: 'u1',
      path: [
        { x: 2, y: 6 },
        { x: 2, y: 5 },
      ],
    });
    expect(h.ui.hints.at(-1)).toBe(M1.hints[2]!.text);
  });
});

// ─────────────────────────── Victory ─────────────────────────────────────────

describe('victory', () => {
  it('scores the mission, records the stars and shows the debrief', () => {
    h.ui.begin();
    // Day 3 (turn 5) with no losses: win + speed + flawless = 3 stars.
    force(h.emitter, { winner: 0, turn: 5 });

    expect(h.runtime.result()).toMatchObject({
      missionId: M1.id,
      outcome: 'victory',
      reason: 'winner',
      day: 3,
      unitsLost: 0,
      stars: 3,
    });
    expect(h.progress.starsFor(M1.id)).toBe(3);
    expect(h.progress.isCompleted(M1.id)).toBe(true);

    expect(h.ui.complete).toMatchObject({
      n: 1,
      total: 5,
      title: M1.title,
      stars: 3,
      maxStars: maxStarsFor(M1),
      day: 3,
      unitsLost: 0,
      final: false,
    });
    expect(h.ui.complete?.criteria.map((c) => c.earned)).toEqual([true, true, true]);
    // The script stops and the objective line comes down with it.
    expect(h.ui.hints.at(-1)).toBeNull();
    expect(h.ui.objective.at(-1)).toBeNull();
    expect(h.ui.defeat).toBeNull();
  });

  it('drops the speed star when the win comes late', () => {
    h.ui.begin();
    force(h.emitter, { winner: 0, turn: 13 }); // day 7 > winByDay 3
    expect(h.ui.complete?.stars).toBe(2);
    expect(h.ui.complete?.criteria.map((c) => c.earned)).toEqual([true, false, true]);
    expect(h.progress.starsFor(M1.id)).toBe(2);
  });

  it('counts the player’s losses against the flawless star', () => {
    h.ui.begin();
    const start = h.emitter.getState();
    const survivors = Object.fromEntries(
      Object.entries(start.units).filter(([, u]) => u.id !== 'u1'),
    );
    // A real action-bearing event: the tracker only diffs across those.
    h.emitter.emit({
      type: 'stateChanged',
      state: { ...start, units: survivors },
      action: { type: 'END_TURN' },
    });
    force(h.emitter, { winner: 0, turn: 5 });

    expect(h.ui.complete?.unitsLost).toBe(1);
    expect(h.ui.complete?.stars).toBe(2);
    expect(h.ui.complete?.criteria.at(-1)).toEqual({
      label: 'Finish without losing a unit',
      earned: false,
    });
  });

  it('CONTINUE goes to the next mission', () => {
    h.ui.begin();
    force(h.emitter, { winner: 0, turn: 5 });
    h.ui.continue();
    expect(h.nav.targets).toEqual([2]);
  });

  it('CONTINUE after the last mission goes back to the menu', () => {
    const last = MISSIONS[4]!;
    const g = harness(last, MISSIONS.length);
    g.ui.begin();
    force(g.emitter, { winner: 0, turn: 5 });
    expect(g.ui.complete?.final).toBe(true);
    g.ui.continue();
    expect(g.nav.targets).toEqual(['menu']);
  });
});

// ─────────────────────────── Defeat ──────────────────────────────────────────

describe('defeat', () => {
  it('reports a rout, records nothing, and offers RETRY / MENU', () => {
    h.ui.begin();
    force(h.emitter, { winner: 1, turn: 7 });

    expect(h.ui.complete).toBeNull();
    expect(h.ui.defeat).toMatchObject({
      n: 1,
      title: M1.title,
      reason: 'routed',
      day: 4,
      dayLimit: M1.defeat.dayLimit,
      commander: M1.opponent.name,
    });
    expect(h.progress.isCompleted(M1.id)).toBe(false);
    expect(h.progress.starsFor(M1.id)).toBe(0);
    expect(h.ui.hints.at(-1)).toBeNull();

    h.ui.retry();
    h.ui.menu();
    expect(h.nav.targets).toEqual(['retry', 'menu']);
  });

  it('reports the campaign-layer day limit', () => {
    h.ui.begin();
    force(h.emitter, { turn: M1.defeat.dayLimit * 2 + 1 }); // one day past the limit
    expect(h.ui.defeat?.reason).toBe('dayLimit');
    expect(h.ui.defeat?.day).toBe(M1.defeat.dayLimit + 1);
    expect(h.runtime.result()?.outcome).toBe('defeat');
  });
});

// ─────────────────────────── Teardown ────────────────────────────────────────

describe('destroy', () => {
  it('stops coaching and scoring, and clears the campaign UI', () => {
    h.ui.begin();
    const seen = h.ui.hints.length;
    h.runtime.destroy();
    expect(h.ui.objective.at(-1)).toBeNull();
    expect(h.ui.hints.at(-1)).toBeNull();

    const after = h.ui.hints.length;
    h.emitter.emit({ type: 'inputStateChanged', kind: 'unit-selected' });
    force(h.emitter, { winner: 0, turn: 5 });
    expect(h.ui.hints).toHaveLength(after);
    expect(after).toBeGreaterThan(seen);
    expect(h.ui.complete).toBeNull();
    expect(h.runtime.result()).toBeNull();
  });

  it('ignores a BEGIN after destroy', () => {
    h.runtime.destroy();
    h.ui.begin();
    expect(h.runtime.started()).toBe(false);
  });
});

// ─────────────────────────── Pure helpers ────────────────────────────────────

describe('campaign param', () => {
  it('accepts menu and mission numbers, rejects everything else', () => {
    expect(parseCampaignParam('menu')).toBe('menu');
    expect(parseCampaignParam('1')).toBe(1);
    expect(parseCampaignParam('5')).toBe(5);
    expect(parseCampaignParam(null)).toBeNull();
    expect(parseCampaignParam('')).toBeNull();
    expect(parseCampaignParam('0')).toBeNull();
    expect(parseCampaignParam('-2')).toBeNull();
    expect(parseCampaignParam('2.5')).toBeNull();
    expect(parseCampaignParam('menu2')).toBeNull();
    expect(parseCampaignParam('../etc')).toBeNull();
  });
});

describe('star bookkeeping', () => {
  it('caps a mission without a flawless bonus at two stars', () => {
    const m3 = MISSIONS[2]!;
    expect(m3.stars.noUnitLost).toBe(false);
    expect(maxStarsFor(m3)).toBe(2);
    expect(starCriteria(m3, { day: 1, unitsLost: 4 })).toHaveLength(2);
  });

  it('unlocks the next mission only once its predecessor is completed', () => {
    const progress = memoryStore();
    expect(buildSelectRows(MISSIONS, progress).map((r) => r.locked)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
    progress.record(MISSIONS[0]!.id, 1);
    progress.record(MISSIONS[1]!.id, 3);
    expect(buildSelectRows(MISSIONS, progress).map((r) => r.locked)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    const view = buildSelectView(MISSIONS, progress);
    expect(view.rows[1]).toMatchObject({ stars: 3, completed: true, maxStars: 3 });
    expect(view.ephemeral).toBe(false);
  });
});
