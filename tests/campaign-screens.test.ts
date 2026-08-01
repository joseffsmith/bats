// @vitest-environment jsdom
//
// Campaign screens (src/campaign/screens.ts).
//
// The module is deliberately dumb — view in, elements out — so the suite is
// shaped the same way: hand it a view, read the DOM, click a button, assert the
// callback fired. The things a regression would actually break:
//
//   1. the mission list renders progress correctly and locked rows are INERT,
//      not merely dimmed (a locked <button> must refuse the click);
//   2. every card carries the data-* hooks main.ts / e2e depend on
//      (data-campaign-mission / -begin / -continue / -retry / -menu);
//   3. the two presenters route the same cards to the two shells — the tray on
//      mobile (plus the board-blocking scrim), a z-97 overlay on desktop — and
//      restore the shell on clear().

import { beforeEach, describe, expect, it } from 'vitest';
import { createProgressStore } from '../src/campaign/progress';
import type { StorageLike } from '../src/campaign/progress';
import { buildSelectRows, maxStarsFor, starCriteria } from '../src/campaign/controller';
import { loadCampaign } from '../src/campaign/loader';
import campaignJson from '../src/data/campaign.json';
import type { Mission } from '../src/campaign/types';
import {
  buildCompleteCard,
  buildDefeatCard,
  buildIntroCard,
  buildMissionSelect,
  createDesktopPresenter,
  createMobilePresenter,
  mountMissionSelect,
} from '../src/campaign/screens';
import type {
  CompleteView,
  DefeatView,
  IntroView,
  SelectView,
  TrayLike,
} from '../src/campaign/screens';

const MISSIONS: Mission[] = loadCampaign(campaignJson);

/** In-memory storage so the injected progress store never touches the real one. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
});

// ─────────────────────────── Mission select ──────────────────────────────────

describe('mission select', () => {
  it('renders one row per mission with stars and commanders from the store', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    store.record(MISSIONS[0]!.id, 2);

    const view: SelectView = { rows: buildSelectRows(MISSIONS, store) };
    const el = buildMissionSelect(view, { onSelect: () => {} });

    const rows = el.querySelectorAll<HTMLButtonElement>('[data-campaign-mission]');
    expect(rows).toHaveLength(5);
    expect(Array.from(rows).map((r) => r.dataset.campaignMission)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    // Row 1: played, two stars, its commander named.
    const first = rows[0]!;
    expect(first.textContent).toContain('First Strike');
    expect(first.textContent).toContain('Warden Kessel');
    expect(
      first.querySelector<HTMLElement>('[data-campaign-stars]')?.dataset.campaignStars,
    ).toBe('2');
    // Mission 1 awards a no-losses star, so three slots are drawn.
    expect(first.querySelectorAll('.camp-star')).toHaveLength(3);
    // Mission 3 has no no-losses bonus → two slots.
    expect(maxStarsFor(MISSIONS[2]!)).toBe(2);
  });

  it('locks every mission after the first unplayed one, and locked rows are inert', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    store.record(MISSIONS[0]!.id, 3); // only mission 1 completed

    const picked: number[] = [];
    const el = buildMissionSelect(
      { rows: buildSelectRows(MISSIONS, store) },
      { onSelect: (n) => picked.push(n) },
    );
    const rows = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[data-campaign-mission]'),
    );
    expect(rows.map((r) => r.dataset.locked)).toEqual([
      'false', // 1 — always open
      'false', // 2 — unlocked by finishing 1
      'true',
      'true',
      'true',
    ]);
    expect(rows[2]!.disabled).toBe(true);
    expect(rows[2]!.textContent).toContain('Locked');

    rows[2]!.click();
    expect(picked).toEqual([]); // inert
    rows[1]!.click();
    expect(picked).toEqual([2]);
  });

  it('with no progress, only mission 1 is open', () => {
    const store = createProgressStore({ storage: memoryStorage() });
    const rows = buildSelectRows(MISSIONS, store);
    expect(rows.map((r) => r.locked)).toEqual([false, true, true, true, true]);
    expect(rows.every((r) => r.stars === 0)).toBe(true);
  });

  it('warns when progress is memory-only', () => {
    const el = buildMissionSelect(
      { rows: [], ephemeral: true },
      { onSelect: () => {} },
    );
    expect(el.textContent).toContain("can't save progress");
  });

  it('mounts standalone as a fullscreen screen and tears down cleanly', () => {
    const parent = host();
    const store = createProgressStore({ storage: memoryStorage() });
    const screen = mountMissionSelect({
      parent,
      view: { rows: buildSelectRows(MISSIONS, store) },
      handlers: { onSelect: () => {} },
      mode: 'mobile',
    });
    const root = parent.querySelector<HTMLElement>('[data-campaign-screen-root]');
    expect(root?.dataset.campaignScreenRoot).toBe('select');
    expect(root?.dataset.campMode).toBe('mobile');
    expect(parent.querySelectorAll('[data-campaign-mission]')).toHaveLength(5);
    screen.destroy();
    expect(parent.querySelector('[data-campaign-screen-root]')).toBeNull();
  });
});

// ─────────────────────────── Intro card ──────────────────────────────────────

const INTRO: IntroView = {
  n: 2,
  total: 5,
  title: 'Flag Country',
  commander: { name: 'Captain Vayle', flavor: 'Plays the percentages.' },
  objective: 'Take the three cities on the road.',
  lines: ['One road, three towns.', 'Take the flags first.'],
};

describe('intro card', () => {
  it('renders the briefing and fires BEGIN once clicked', () => {
    let began = 0;
    const el = buildIntroCard(INTRO, { onBegin: () => (began += 1) }, 'mobile');

    expect(el.dataset.campaignScreen).toBe('intro');
    expect(el.dataset.campMode).toBe('mobile');
    expect(el.textContent).toContain('Mission 2 of 5');
    expect(el.textContent).toContain('Flag Country');
    expect(el.textContent).toContain('Captain Vayle');
    expect(el.textContent).toContain('Plays the percentages.');
    expect(
      el.querySelector<HTMLElement>('[data-campaign-objective]')?.textContent,
    ).toContain('Take the three cities on the road.');
    expect(el.querySelectorAll('.camp-line')).toHaveLength(2);

    const begin = el.querySelector<HTMLButtonElement>('[data-campaign-begin]');
    expect(begin).not.toBeNull();
    begin!.click();
    expect(began).toBe(1);
  });
});

// ─────────────────────────── Complete card ───────────────────────────────────

function completeView(over: Partial<CompleteView> = {}): CompleteView {
  const mission = MISSIONS[0]!;
  return {
    n: mission.n,
    total: 5,
    title: mission.title,
    stars: 2,
    maxStars: maxStarsFor(mission),
    criteria: starCriteria(mission, { day: 3, unitsLost: 1 }),
    day: 3,
    unitsLost: 1,
    final: false,
    ...over,
  };
}

describe('mission complete card', () => {
  it('renders stars earned against stars possible, plus the criteria recap', () => {
    const el = buildCompleteCard(completeView(), { onContinue: () => {} });

    expect(el.dataset.campaignScreen).toBe('complete');
    expect(el.textContent).toContain('Mission 1 complete');
    expect(el.textContent).toContain('First Strike');

    const strip = el.querySelector<HTMLElement>('[data-campaign-stars]')!;
    expect(strip.dataset.campaignStars).toBe('2');
    expect(strip.dataset.campaignStarsMax).toBe('3');
    const filled = Array.from(strip.querySelectorAll('.camp-star')).map(
      (s) => (s as HTMLElement).dataset.filled,
    );
    expect(filled).toEqual(['true', 'true', 'false']);

    // Won on day 3 (≤ winByDay 3) but lost a unit → third criterion unearned.
    const crits = Array.from(el.querySelectorAll<HTMLElement>('.camp-criterion'));
    expect(crits).toHaveLength(3);
    expect(crits.map((c) => c.dataset.earned)).toEqual(['true', 'true', 'false']);
    expect(crits[1]!.textContent).toContain('Win by day 3');
    expect(el.textContent).toContain('Won on day 3 · 1 unit lost');
  });

  it('says "no units lost" when the run was flawless', () => {
    const el = buildCompleteCard(
      completeView({
        stars: 3,
        unitsLost: 0,
        criteria: starCriteria(MISSIONS[0]!, { day: 3, unitsLost: 0 }),
      }),
      { onContinue: () => {} },
    );
    expect(el.textContent).toContain('no units lost');
    expect(
      el.querySelector<HTMLElement>('[data-campaign-stars]')?.dataset.campaignStars,
    ).toBe('3');
  });

  it('fires CONTINUE, and relabels it after the final mission', () => {
    let hits = 0;
    const el = buildCompleteCard(completeView(), { onContinue: () => (hits += 1) });
    const cont = el.querySelector<HTMLButtonElement>('[data-campaign-continue]')!;
    expect(cont.textContent).toBe('Continue');
    cont.click();
    expect(hits).toBe(1);

    const last = buildCompleteCard(completeView({ n: 5, final: true }), {
      onContinue: () => {},
    });
    expect(last.dataset.final).toBe('true');
    expect(
      last.querySelector<HTMLButtonElement>('[data-campaign-continue]')?.textContent,
    ).toBe('Back to missions');
    expect(last.textContent).toContain('last mission');
  });
});

// ─────────────────────────── Defeat card ─────────────────────────────────────

const DEFEAT: DefeatView = {
  n: 1,
  title: 'First Strike',
  reason: 'routed',
  day: 4,
  dayLimit: 8,
  commander: 'Warden Kessel',
};

describe('defeat card', () => {
  it('names the rout and wires RETRY / MENU', () => {
    const calls: string[] = [];
    const el = buildDefeatCard(DEFEAT, {
      onRetry: () => calls.push('retry'),
      onMenu: () => calls.push('menu'),
    });

    expect(el.dataset.campaignScreen).toBe('defeat');
    expect(el.dataset.reason).toBe('routed');
    expect(
      el.querySelector<HTMLElement>('[data-campaign-reason]')?.textContent,
    ).toContain('Warden Kessel broke your force on day 4');

    el.querySelector<HTMLButtonElement>('[data-campaign-retry]')!.click();
    el.querySelector<HTMLButtonElement>('[data-campaign-menu]')!.click();
    expect(calls).toEqual(['retry', 'menu']);
  });

  it('explains a day-limit loss differently', () => {
    const el = buildDefeatCard({ ...DEFEAT, reason: 'dayLimit', day: 9 }, {
      onRetry: () => {},
      onMenu: () => {},
    });
    expect(el.dataset.reason).toBe('dayLimit');
    const text = el.querySelector<HTMLElement>('[data-campaign-reason]')!.textContent;
    expect(text).toContain('clock ran out');
    expect(text).toContain('8 days');
  });
});

// ─────────────────────────── Presenters ──────────────────────────────────────

function fakeTray(): TrayLike & {
  objective: (string | null)[];
  hint: (string | null)[];
  panels: (HTMLElement | null)[];
} {
  const objective: (string | null)[] = [];
  const hint: (string | null)[] = [];
  const panels: (HTMLElement | null)[] = [];
  return {
    objective,
    hint,
    panels,
    setObjective: (t) => objective.push(t),
    setHint: (t) => hint.push(t),
    presentPanel: (el) => panels.push(el),
  };
}

describe('mobile presenter', () => {
  it('routes cards through the tray panel and blocks the board while one is up', () => {
    const parent = host();
    const tray = fakeTray();
    const ui = createMobilePresenter({ tray, parent });

    const scrim = parent.querySelector<HTMLElement>('[data-campaign-scrim]')!;
    expect(scrim.hidden).toBe(true);

    ui.showIntro(INTRO, { onBegin: () => {} });
    const panel = tray.panels.at(-1)!;
    expect(panel?.dataset.campaignScreen).toBe('intro');
    expect(panel?.dataset.campMode).toBe('mobile');
    expect(scrim.hidden).toBe(false);

    ui.setObjective('Take the cities.');
    ui.setHint('Tap a soldier.');
    expect(tray.objective.at(-1)).toBe('Take the cities.');
    expect(tray.hint.at(-1)).toBe('Tap a soldier.');

    ui.clear();
    expect(tray.panels.at(-1)).toBeNull();
    expect(scrim.hidden).toBe(true);

    ui.showComplete(completeView(), { onContinue: () => {} });
    expect(tray.panels.at(-1)?.dataset.campaignScreen).toBe('complete');

    ui.destroy();
    expect(tray.panels.at(-1)).toBeNull();
    expect(tray.hint.at(-1)).toBeNull();
    expect(tray.objective.at(-1)).toBeNull();
    expect(parent.querySelector('[data-campaign-scrim]')).toBeNull();
  });
});

describe('desktop presenter', () => {
  it('mounts a hidden overlay that shows a card and restores on clear', () => {
    const parent = host();
    const ui = createDesktopPresenter({ parent });

    const overlay = parent.querySelector<HTMLElement>('[data-campaign-overlay]')!;
    expect(overlay.hidden).toBe(true);

    ui.showDefeat(DEFEAT, { onRetry: () => {}, onMenu: () => {} });
    expect(overlay.hidden).toBe(false);
    const card = overlay.querySelector<HTMLElement>('[data-campaign-screen]')!;
    expect(card.dataset.campaignScreen).toBe('defeat');
    expect(card.dataset.campMode).toBe('desktop');

    ui.clear();
    expect(overlay.hidden).toBe(true);
    expect(overlay.querySelector('[data-campaign-screen]')).toBeNull();
  });

  it('drives the objective and hint pills, and cleans up on destroy', () => {
    const parent = host();
    const ui = createDesktopPresenter({ parent });
    const objective = parent.querySelector<HTMLElement>('[data-campaign-objective-pill]')!;
    const hint = parent.querySelector<HTMLElement>('[data-campaign-hint]')!;
    expect(objective.hidden).toBe(true);
    expect(hint.hidden).toBe(true);

    ui.setObjective('Destroy both soldiers.');
    ui.setHint('Tap one of your tanks.');
    expect(objective.hidden).toBe(false);
    expect(objective.textContent).toBe('Destroy both soldiers.');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('Tap one of your tanks.');

    ui.setHint(null);
    expect(hint.hidden).toBe(true);

    ui.destroy();
    expect(parent.querySelector('[data-campaign-overlay]')).toBeNull();
    expect(parent.querySelector('[data-campaign-hint]')).toBeNull();
    expect(parent.querySelector('[data-campaign-objective-pill]')).toBeNull();
  });

  it('layers above chrome’s winner overlay (z 90) and the handoff scrim (z 95)', () => {
    createDesktopPresenter({ parent: host() });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    // The overlay must out-rank chrome without chrome knowing anything about it.
    expect(css).toMatch(/\.camp-overlay\s*\{[^}]*z-index:\s*97/);
  });
});
