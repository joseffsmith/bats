// Mission runtime — the piece that turns a `Mission` plus a live emitter into
// a played mission.
//
// It owns the mission's whole arc and nothing else:
//
//   briefing → BEGIN → hints + scorekeeping → debrief → navigation
//
// Everything it needs already exists: `createHintRunner` walks the coaching
// script, `createMissionTracker` counts losses and calls the mission at the
// day limit, `progressStore` remembers stars. This module is the wiring —
// which is precisely why it holds no DOM. Screens are reached through a
// `CampaignPresenter` (campaign/screens.ts) so the same runtime drives the
// mobile tray and the desktop overlay without knowing which it has, and tests
// drive it with a stub.
//
// Navigation is URL-param reload, the idiom the map picker already uses
// (chrome.ts): CONTINUE sets `?campaign=N+1`, RETRY reloads the current params
// untouched, MENU goes to `?campaign=menu`. Reloading rather than hot-swapping
// the board means every mission starts from main.ts's one boot path — no second
// way to build a match, and no state left over from the last one.

import type { PlayerId } from '../engine/core/types';
import type { Emitter } from '../renderer/emitter';
import { createHintRunner } from './hints';
import type { HintRunner } from './hints';
import { progressStore } from './progress';
import type { ProgressStore } from './progress';
import { computeStars, createMissionTracker } from './tracker';
import type { MissionTracker } from './tracker';
import type { Mission, MissionResult } from './types';
import type {
  CampaignPresenter,
  MissionRow,
  SelectView,
  StarCriterion,
} from './screens';

/** URL parameter that selects the campaign entry point. */
export const CAMPAIGN_PARAM = 'campaign';

/**
 * Read `?campaign=`: `menu` for the mission list, a 1-based mission number, or
 * null when the parameter is absent or malformed (main.ts then boots a normal
 * skirmish). Range is not checked here — that needs the mission list.
 */
export function parseCampaignParam(raw: string | null | undefined): number | 'menu' | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw === 'menu') return 'menu';
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// ─────────────────────────── Stars + unlocks ─────────────────────────────────

/** Stars this mission can award: the win, the speed bonus, and — only when the
 *  mission asks for it — the no-losses bonus. Mirrors `computeStars`. */
export function maxStarsFor(mission: Mission): number {
  return mission.stars.noUnitLost ? 3 : 2;
}

/** The debrief's "what you were graded on" list, in star order. */
export function starCriteria(
  mission: Mission,
  outcome: { day: number; unitsLost: number },
): StarCriterion[] {
  const out: StarCriterion[] = [
    { label: 'Win the mission', earned: true },
    {
      label: `Win by day ${mission.stars.winByDay}`,
      earned: outcome.day <= mission.stars.winByDay,
    },
  ];
  if (mission.stars.noUnitLost) {
    out.push({
      label: 'Finish without losing a unit',
      earned: outcome.unitsLost === 0,
    });
  }
  return out;
}

/**
 * Mission-select rows. Mission 1 is always open; mission N+1 unlocks the moment
 * N is completed, so a player can never be stranded behind a mission they have
 * already beaten (and re-playing an earlier one for stars never re-locks
 * anything).
 */
export function buildSelectRows(
  missions: ReadonlyArray<Mission>,
  progress: ProgressStore,
): MissionRow[] {
  const ordered = [...missions].sort((a, b) => a.n - b.n);
  let prevCompleted = true; // mission 1 has no predecessor to clear
  return ordered.map((m) => {
    const completed = progress.isCompleted(m.id);
    const row: MissionRow = {
      n: m.n,
      title: m.title,
      commander: m.opponent.name,
      stars: progress.starsFor(m.id),
      maxStars: maxStarsFor(m),
      locked: !prevCompleted,
      completed,
    };
    prevCompleted = completed;
    return row;
  });
}

/** Full mission-select view, progress warning included. */
export function buildSelectView(
  missions: ReadonlyArray<Mission>,
  progress: ProgressStore,
): SelectView {
  // Touch the store once so `isEphemeral` reflects a real read attempt.
  progress.load();
  return { rows: buildSelectRows(missions, progress), ephemeral: progress.isEphemeral() };
}

// ─────────────────────────── Navigation ──────────────────────────────────────

export type CampaignNav = {
  /** Load a mission number, or the mission list. */
  goTo(target: number | 'menu'): void;
  /** Replay the current mission — same URL, same params. */
  retry(): void;
};

/** Location-based navigation. Injectable so tests never touch `window`. */
export function createCampaignNav(): CampaignNav {
  return {
    goTo(target: number | 'menu'): void {
      const url = new URL(window.location.href);
      url.searchParams.set(CAMPAIGN_PARAM, target === 'menu' ? 'menu' : String(target));
      window.location.assign(url.toString());
    },
    retry(): void {
      window.location.reload();
    },
  };
}

// ─────────────────────────── Mission runtime ─────────────────────────────────

export type CampaignRuntimeDeps = {
  mission: Mission;
  emitter: Emitter;
  /** Mobile tray or desktop overlay — the runtime cannot tell. */
  ui: CampaignPresenter;
  /** Missions in the campaign, for "Mission 2 of 5" and the final-mission
   *  CONTINUE target. Defaults to the shipped campaign's five. */
  total?: number;
  /** Defaults to the app-wide store. */
  progress?: ProgressStore;
  /** Defaults to URL-param reload navigation. */
  nav?: CampaignNav;
  /** Seat the human plays. The campaign always seats them at 0. */
  player?: PlayerId;
};

export type CampaignRuntime = {
  /** Dismiss the briefing and start the mission — what BEGIN calls. Idempotent. */
  begin(): void;
  /** True once BEGIN has been taken. */
  started(): boolean;
  /** The mission result, once it has one. */
  result(): MissionResult | null;
  /** Unsubscribe everything and clear the campaign's own UI. The presenter
   *  itself belongs to whoever mounted it (main.ts) and is left alive. */
  destroy(): void;
};

const DEFAULT_TOTAL = 5;

export function createCampaignRuntime(deps: CampaignRuntimeDeps): CampaignRuntime {
  const { mission, emitter, ui } = deps;
  const total = deps.total ?? DEFAULT_TOTAL;
  const progress = deps.progress ?? progressStore();
  const nav = deps.nav ?? createCampaignNav();
  const player: PlayerId = deps.player ?? 0;

  let hints: HintRunner | null = null;
  let tracker: MissionTracker | null = null;
  let running = false;
  let finished: MissionResult | null = null;
  let destroyed = false;

  function finish(result: MissionResult): void {
    if (destroyed) return;
    finished = result;
    // The script is over — stop it before the debrief so a late trigger can't
    // paint a hint over the card.
    hints?.destroy();
    hints = null;
    ui.setHint(null);
    ui.setObjective(null);

    if (result.outcome === 'victory') {
      // The tracker already scored this; recomputing keeps the screen honest if
      // a caller ever hands us a result from elsewhere (replay, debug hook).
      const stars = computeStars(mission, result.outcome, result.day, result.unitsLost);
      progress.record(mission.id, stars);
      const final = mission.n >= total;
      ui.showComplete(
        {
          n: mission.n,
          total,
          title: mission.title,
          stars,
          maxStars: maxStarsFor(mission),
          criteria: starCriteria(mission, result),
          day: result.day,
          unitsLost: result.unitsLost,
          final,
        },
        { onContinue: () => nav.goTo(final ? 'menu' : mission.n + 1) },
      );
      return;
    }

    ui.showDefeat(
      {
        n: mission.n,
        title: mission.title,
        reason: result.reason === 'dayLimit' ? 'dayLimit' : 'routed',
        day: result.day,
        dayLimit: mission.defeat.dayLimit,
        commander: mission.opponent.name,
      },
      {
        onRetry: () => nav.retry(),
        onMenu: () => nav.goTo('menu'),
      },
    );
  }

  function begin(): void {
    if (destroyed || running || finished !== null) return;
    running = true;
    // The briefing card is also what makes the board inert (desktop overlay /
    // mobile scrim), so dropping it is what hands control to the player.
    ui.clear();
    ui.setObjective(mission.objective);
    hints = createHintRunner({
      emitter,
      hints: mission.hints,
      present: (text) => ui.setHint(text),
      player,
    });
    tracker = createMissionTracker({
      emitter,
      mission,
      onResult: finish,
      player,
    });
  }

  ui.showIntro(
    {
      n: mission.n,
      total,
      title: mission.title,
      commander: { name: mission.opponent.name, flavor: mission.opponent.flavor },
      objective: mission.objective,
      lines: mission.intro,
    },
    { onBegin: begin },
  );

  return {
    begin,
    started(): boolean {
      return running;
    },
    result(): MissionResult | null {
      return finished;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      hints?.destroy();
      hints = null;
      tracker?.destroy();
      tracker = null;
      ui.clear();
      ui.setHint(null);
      ui.setObjective(null);
    },
  };
}
