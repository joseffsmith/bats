// Campaign screens — the DOM the campaign shows around a mission.
//
// Strictly presentational: every function here takes a plain view object and a
// bag of callbacks and hands back elements. Nothing in this module reads the
// engine, the emitter, the progress store, or the URL — what a star *means*,
// which mission is unlocked, and where CONTINUE goes are all decided in
// campaign/controller.ts (and main.ts for the menu). That split is what lets
// the screens be unit-tested with hand-written views and no game running.
//
// ── The four screens ────────────────────────────────────────────────────────
//   mission select   five rows: number, title, commander, earned stars, lock
//   intro            briefing card — commander, objective, intro copy, BEGIN
//   complete         stars earned vs possible + the criteria recap, CONTINUE
//   defeat           why it ended (routed / day limit), RETRY + MENU
//
// ── The two presenters ──────────────────────────────────────────────────────
// The same four screens have to land in two very different shells, so the
// controller never builds DOM itself — it calls a `CampaignPresenter`:
//
//   mobile   cards are handed to `tray.presentPanel`, which (by design, see
//            tray.ts `render`) beats the tray's own state rendering including
//            its match-over takeover. The board behind stays visible but inert:
//            the presenter drops its own scrim between the HUD strip (z 12) and
//            the tray (z 15).
//   desktop  cards mount in a fullscreen overlay at z-index 97 — above chrome's
//            winner overlay (90) and the fog handoff scrim (95) — with a
//            near-opaque backdrop, so a campaign win covers chrome's "Vermilion
//            victorious" dialog completely instead of stacking on top of it.
//            chrome.ts is not touched or imported; the overlay simply out-ranks
//            and out-paints it.
//
// Styling copies the established idioms (winner overlay, handoff dialog, tray
// cards) rather than importing them: this module injects its own `camp-*`
// stylesheet behind the usual `ensureStyle()` guard.

/** Which shell a screen is being rendered into. Only affects sizing. */
export type Mode = 'mobile' | 'desktop';

/** One row of the mission-select list. Everything is pre-computed — the list
 *  never asks why a row is locked or where its stars came from. */
export type MissionRow = {
  n: number;
  title: string;
  /** Opposing commander's display name. */
  commander: string;
  stars: number;
  /** Stars this mission can award (2 when it has no no-losses bonus). */
  maxStars: number;
  locked: boolean;
  completed: boolean;
};

export type SelectView = {
  rows: ReadonlyArray<MissionRow>;
  /** True when progress is memory-only, so the player can be warned. */
  ephemeral?: boolean;
};

export type IntroView = {
  n: number;
  total: number;
  title: string;
  commander: { name: string; flavor: string };
  objective: string;
  /** Briefing paragraphs. */
  lines: ReadonlyArray<string>;
};

/** One line of the star recap: what was asked, and whether it was earned. */
export type StarCriterion = { label: string; earned: boolean };

export type CompleteView = {
  n: number;
  total: number;
  title: string;
  stars: number;
  maxStars: number;
  criteria: ReadonlyArray<StarCriterion>;
  day: number;
  unitsLost: number;
  /** True after the last mission — CONTINUE goes back to the menu. */
  final: boolean;
};

export type DefeatView = {
  n: number;
  title: string;
  /** `routed` — the opponent won outright. `dayLimit` — the clock ran out. */
  reason: 'routed' | 'dayLimit';
  day: number;
  dayLimit: number;
  /** Opposing commander, for the defeat copy. */
  commander: string;
};

/** The slice of the mobile tray the presenter drives. Structural on purpose —
 *  campaign code never imports the renderer's tray module. */
export type TrayLike = {
  setObjective(text: string | null): void;
  setHint(text: string | null): void;
  presentPanel(el: HTMLElement | null): void;
};

/**
 * What campaign/controller.ts talks to. Two implementations (mobile tray,
 * desktop overlay); the controller cannot tell them apart.
 */
export type CampaignPresenter = {
  /** Persistent "what you must do" line. `null` clears it. */
  setObjective(text: string | null): void;
  /** Current coaching hint. `null` hides it. */
  setHint(text: string | null): void;
  showIntro(view: IntroView, handlers: IntroHandlers): void;
  showComplete(view: CompleteView, handlers: CompleteHandlers): void;
  showDefeat(view: DefeatView, handlers: DefeatHandlers): void;
  /** Dismiss whatever card is up and restore the shell underneath. */
  clear(): void;
  destroy(): void;
};

export type IntroHandlers = { onBegin: () => void };
export type CompleteHandlers = { onContinue: () => void };
export type DefeatHandlers = { onRetry: () => void; onMenu: () => void };
export type SelectHandlers = {
  onSelect: (n: number) => void;
  /** Optional way out of the menu (back to skirmish). */
  onExit?: () => void;
};

// ─────────────────────────── Small DOM builders ──────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, variant: 'gold' | 'ghost'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `camp-btn camp-btn-${variant}`;
  b.textContent = label;
  return b;
}

/** A filled/empty star strip. `data-campaign-stars` carries the earned count so
 *  tests and e2e can read the score without parsing glyphs. */
function starStrip(stars: number, maxStars: number, size: 'lg' | 'sm'): HTMLElement {
  const wrap = el('div', `camp-stars camp-stars-${size}`);
  wrap.dataset.campaignStars = String(stars);
  wrap.dataset.campaignStarsMax = String(maxStars);
  for (let i = 0; i < maxStars; i++) {
    const s = el('span', 'camp-star', '★');
    s.dataset.filled = String(i < stars);
    wrap.appendChild(s);
  }
  return wrap;
}

function card(screen: string, mode: Mode): HTMLElement {
  const root = el('div', 'camp-card');
  root.dataset.campaignScreen = screen;
  root.dataset.campMode = mode;
  return root;
}

function buttonsRow(...btns: HTMLElement[]): HTMLElement {
  const row = el('div', 'camp-buttons');
  row.append(...btns);
  return row;
}

// ─────────────────────────── Mission select ──────────────────────────────────

/**
 * The five-row mission list. Locked rows are rendered as disabled buttons —
 * inert to clicks and to the keyboard, not merely dimmed.
 */
export function buildMissionSelect(
  view: SelectView,
  handlers: SelectHandlers,
  mode: Mode = 'desktop',
): HTMLElement {
  ensureStyle();
  const root = card('select', mode);

  root.appendChild(el('div', 'camp-eyebrow', 'Teaching Campaign'));
  root.appendChild(el('h2', 'camp-title', 'Choose a mission'));

  const list = el('div', 'camp-list');
  for (const row of view.rows) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'camp-row';
    entry.dataset.campaignMission = String(row.n);
    entry.dataset.locked = String(row.locked);
    entry.dataset.completed = String(row.completed);
    entry.disabled = row.locked;

    const num = el('span', 'camp-row-n', String(row.n).padStart(2, '0'));
    const mid = el('span', 'camp-row-mid');
    mid.appendChild(el('span', 'camp-row-title', row.title));
    mid.appendChild(
      el('span', 'camp-row-commander', row.locked ? 'Locked' : `vs ${row.commander}`),
    );

    const right = el('span', 'camp-row-right');
    if (row.locked) right.appendChild(el('span', 'camp-lock', '🔒'));
    else right.appendChild(starStrip(row.stars, row.maxStars, 'sm'));

    entry.append(num, mid, right);
    if (!row.locked) {
      entry.addEventListener('click', () => handlers.onSelect(row.n));
    }
    list.appendChild(entry);
  }
  root.appendChild(list);

  const foot = el('div', 'camp-foot');
  foot.appendChild(
    el(
      'span',
      'camp-note',
      view.ephemeral === true
        ? "This browser can't save progress — stars last for this session only."
        : 'Finish a mission to unlock the next one.',
    ),
  );
  if (handlers.onExit) {
    const exit = button('Skirmish', 'ghost');
    exit.dataset.campaignExit = '';
    exit.addEventListener('click', () => handlers.onExit?.());
    foot.appendChild(exit);
  }
  root.appendChild(foot);
  return root;
}

/**
 * Mount the mission list as a standalone fullscreen screen — the `?campaign=menu`
 * entry point, which short-circuits before any game boots and so has neither a
 * tray nor chrome to live in.
 */
export function mountMissionSelect(deps: {
  parent: HTMLElement;
  view: SelectView;
  handlers: SelectHandlers;
  mode: Mode;
}): { root: HTMLElement; destroy(): void } {
  ensureStyle();
  const screen = el('div', 'camp-screen');
  screen.dataset.campaignScreenRoot = 'select';
  screen.dataset.campMode = deps.mode;
  screen.appendChild(buildMissionSelect(deps.view, deps.handlers, deps.mode));
  deps.parent.appendChild(screen);
  return {
    root: screen,
    destroy(): void {
      screen.remove();
    },
  };
}

// ─────────────────────────── Mission cards ───────────────────────────────────

export function buildIntroCard(
  view: IntroView,
  handlers: IntroHandlers,
  mode: Mode = 'desktop',
): HTMLElement {
  ensureStyle();
  const root = card('intro', mode);
  root.appendChild(
    el('div', 'camp-eyebrow', `Mission ${view.n} of ${view.total}`),
  );
  root.appendChild(el('h2', 'camp-title', view.title));

  const commander = el('div', 'camp-commander');
  commander.appendChild(el('span', 'camp-vs', 'vs'));
  commander.appendChild(el('span', 'camp-commander-name', view.commander.name));
  commander.appendChild(el('span', 'camp-commander-flavor', view.commander.flavor));
  root.appendChild(commander);

  const objective = el('div', 'camp-objective');
  objective.dataset.campaignObjective = '';
  objective.appendChild(el('span', 'camp-obj-label', 'Objective'));
  objective.appendChild(el('span', 'camp-obj-text', view.objective));
  root.appendChild(objective);

  const lines = el('div', 'camp-lines');
  for (const line of view.lines) lines.appendChild(el('p', 'camp-line', line));
  root.appendChild(lines);

  const begin = button('Begin', 'gold');
  begin.dataset.campaignBegin = '';
  begin.addEventListener('click', () => handlers.onBegin());
  root.appendChild(buttonsRow(begin));
  return root;
}

export function buildCompleteCard(
  view: CompleteView,
  handlers: CompleteHandlers,
  mode: Mode = 'desktop',
): HTMLElement {
  ensureStyle();
  const root = card('complete', mode);
  root.dataset.final = String(view.final);

  root.appendChild(
    el('div', 'camp-eyebrow', `Mission ${view.n} complete`),
  );
  const title = el('h2', 'camp-title camp-title-italic', view.title);
  root.appendChild(title);
  root.appendChild(starStrip(view.stars, view.maxStars, 'lg'));

  const summary = el(
    'div',
    'camp-summary',
    view.unitsLost === 0
      ? `Won on day ${view.day} · no units lost`
      : `Won on day ${view.day} · ${view.unitsLost} unit${view.unitsLost === 1 ? '' : 's'} lost`,
  );
  root.appendChild(summary);

  const recap = el('ul', 'camp-criteria');
  for (const c of view.criteria) {
    const li = document.createElement('li');
    li.className = 'camp-criterion';
    li.dataset.earned = String(c.earned);
    li.appendChild(el('span', 'camp-crit-mark', c.earned ? '★' : '☆'));
    li.appendChild(el('span', 'camp-crit-label', c.label));
    recap.appendChild(li);
  }
  root.appendChild(recap);

  if (view.final) {
    root.appendChild(
      el('div', 'camp-note', 'That was the last mission — the campaign is yours.'),
    );
  }

  const cont = button(view.final ? 'Back to missions' : 'Continue', 'gold');
  cont.dataset.campaignContinue = '';
  cont.addEventListener('click', () => handlers.onContinue());
  root.appendChild(buttonsRow(cont));
  return root;
}

export function buildDefeatCard(
  view: DefeatView,
  handlers: DefeatHandlers,
  mode: Mode = 'desktop',
): HTMLElement {
  ensureStyle();
  const root = card('defeat', mode);
  root.dataset.reason = view.reason;

  root.appendChild(el('div', 'camp-eyebrow', 'Mission failed'));
  root.appendChild(el('h2', 'camp-title camp-title-italic', view.title));

  const reason = el(
    'div',
    'camp-reason',
    view.reason === 'routed'
      ? `${view.commander} broke your force on day ${view.day}.`
      : `The clock ran out — ${view.commander} held for ${view.dayLimit} days.`,
  );
  reason.dataset.campaignReason = view.reason;
  root.appendChild(reason);

  root.appendChild(
    el(
      'div',
      'camp-note',
      view.reason === 'routed'
        ? 'Nothing is lost but the day. Read the ground again and go back in.'
        : 'Speed is a weapon too. Take the initiative earlier this time.',
    ),
  );

  const retry = button('Retry', 'gold');
  retry.dataset.campaignRetry = '';
  retry.addEventListener('click', () => handlers.onRetry());
  const menu = button('Missions', 'ghost');
  menu.dataset.campaignMenu = '';
  menu.addEventListener('click', () => handlers.onMenu());
  root.appendChild(buttonsRow(retry, menu));
  return root;
}

// ─────────────────────────── Mobile presenter ────────────────────────────────

/**
 * Cards go through `tray.presentPanel`, which replaces the tray body and (by
 * tray.ts's own ordering) suppresses its match-over takeover — so a campaign
 * win reports as a mission debrief, never as "Vermilion victorious".
 *
 * The board itself is left visible but inert while a card is up: a scrim at
 * z-index 13 sits above the HUD strip (12) and below the tray (15), so taps hit
 * the scrim instead of the canvas and the card's own buttons still work.
 */
export function createMobilePresenter(deps: {
  tray: TrayLike;
  /** Where the input-blocking scrim mounts. Defaults to `document.body`. */
  parent?: HTMLElement;
}): CampaignPresenter {
  ensureStyle();
  const parent = deps.parent ?? document.body;
  const scrim = el('div', 'camp-scrim');
  scrim.dataset.campaignScrim = '';
  scrim.hidden = true;
  parent.appendChild(scrim);

  /**
   * `phase` only sets how hard the scrim bites. A briefing wants the board
   * legible underneath (that's what is being briefed); a debrief does not — and
   * the renderer paints its own in-canvas "Player N wins!" banner there, which
   * would otherwise argue with the mission card.
   */
  function present(node: HTMLElement | null, phase?: 'intro' | 'debrief'): void {
    deps.tray.presentPanel(node);
    scrim.hidden = node === null;
    if (phase !== undefined) scrim.dataset.campaignPhase = phase;
  }

  return {
    setObjective(text: string | null): void {
      deps.tray.setObjective(text);
    },
    setHint(text: string | null): void {
      deps.tray.setHint(text);
    },
    showIntro(view, handlers): void {
      present(buildIntroCard(view, handlers, 'mobile'), 'intro');
    },
    showComplete(view, handlers): void {
      present(buildCompleteCard(view, handlers, 'mobile'), 'debrief');
    },
    showDefeat(view, handlers): void {
      present(buildDefeatCard(view, handlers, 'mobile'), 'debrief');
    },
    clear(): void {
      present(null);
    },
    destroy(): void {
      present(null);
      deps.tray.setHint(null);
      deps.tray.setObjective(null);
      scrim.remove();
    },
  };
}

// ─────────────────────────── Desktop presenter ───────────────────────────────

/**
 * Fullscreen dialog overlay in the winner-overlay idiom, plus two floating
 * pills: the objective under the top chrome and the hint bottom-centre (the
 * cancel chip's look, lifted clear of the chip itself so the two never collide).
 *
 * The overlay's backdrop is near-opaque and its z-index (97) beats chrome's
 * winner overlay (90) and the handoff scrim (95): when a mission ends, chrome
 * still mounts its own dialog underneath, but nothing of it shows through.
 */
export function createDesktopPresenter(deps: { parent: HTMLElement }): CampaignPresenter {
  ensureStyle();

  const overlay = el('div', 'camp-overlay');
  overlay.dataset.campaignOverlay = '';
  overlay.hidden = true;
  const dialog = el('div', 'camp-dialog');
  overlay.appendChild(dialog);

  const objective = el('div', 'camp-objective-pill');
  objective.dataset.campaignObjectivePill = '';
  objective.hidden = true;

  const hint = el('div', 'camp-hint-chip');
  hint.dataset.campaignHint = '';
  hint.hidden = true;

  deps.parent.append(objective, hint, overlay);

  function present(node: HTMLElement | null): void {
    dialog.replaceChildren();
    if (node === null) {
      overlay.hidden = true;
      return;
    }
    dialog.appendChild(node);
    overlay.hidden = false;
  }

  return {
    setObjective(text: string | null): void {
      objective.textContent = text ?? '';
      objective.hidden = text === null;
    },
    setHint(text: string | null): void {
      hint.textContent = text ?? '';
      hint.hidden = text === null;
    },
    showIntro(view, handlers): void {
      present(buildIntroCard(view, handlers, 'desktop'));
    },
    showComplete(view, handlers): void {
      present(buildCompleteCard(view, handlers, 'desktop'));
    },
    showDefeat(view, handlers): void {
      present(buildDefeatCard(view, handlers, 'desktop'));
    },
    clear(): void {
      present(null);
    },
    destroy(): void {
      present(null);
      overlay.remove();
      objective.remove();
      hint.remove();
    },
  };
}

// ─────────────────────────── Styles ──────────────────────────────────────────

let stylesInjected = false;

function ensureStyle(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
/* ── Shells ──────────────────────────────────────────────────────────────────
   .camp-screen  standalone fullscreen (mission select, no game running)
   .camp-overlay desktop dialog over a live match — z 97 beats chrome's winner
                 overlay (90) and the handoff scrim (95), and paints over them
   .camp-scrim   mobile input blocker between the HUD strip (12) and tray (15) */
.camp-screen,
.camp-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: auto;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  overflow-y: auto;
}
.camp-screen {
  z-index: 60;
  background:
    radial-gradient(ellipse 90% 70% at 50% 40%, rgba(212,168,87,0.05) 0%, transparent 62%),
    var(--bg);
}
.camp-overlay {
  z-index: 97;
  background: radial-gradient(ellipse at center, rgba(12,9,5,0.97), rgba(0,0,0,0.985));
  animation: camp-fade 0.35s ease both;
}
.camp-overlay[hidden] { display: none; }
@keyframes camp-fade { from { opacity: 0; } to { opacity: 1; } }

.camp-dialog { display: contents; }

.camp-scrim {
  position: fixed;
  inset: 0;
  z-index: 13;
  pointer-events: auto;
  background: rgba(8,6,4,0.45);
  transition: background 0.3s ease;
}
.camp-scrim[data-campaign-phase="debrief"] { background: rgba(8,6,4,0.76); }
.camp-scrim[hidden] { display: none; }

/* ── Card ── */
/* Local border-box reset: the app sets no global one, and every campaign box
   here is sized as "the full width of its shell, padding included". */
.camp-card, .camp-card *, .camp-objective-pill, .camp-hint-chip {
  box-sizing: border-box;
}
.camp-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: center;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: var(--ink);
}
.camp-card[data-camp-mode="desktop"] {
  background: var(--panel);
  border: 1px solid var(--rule-strong);
  border-top: 3px solid var(--gold-dim);
  padding: 32px 44px 28px;
  min-width: 380px;
  max-width: 560px;
  margin: 24px;
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85), 0 0 60px -14px rgba(212,168,87,0.25);
}
.camp-card[data-camp-mode="mobile"] {
  padding: 4px 0 0;
  gap: 10px;
}

.camp-eyebrow {
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--gold-dim);
}
.camp-title {
  margin: 0;
  font-family: 'Fraunces', serif;
  font-weight: 500;
  line-height: 1.08;
  color: var(--ink);
  font-variation-settings: 'opsz' 144, 'SOFT' 30;
}
.camp-title-italic { font-style: italic; }
.camp-card[data-camp-mode="desktop"] .camp-title { font-size: 34px; }
.camp-card[data-camp-mode="mobile"] .camp-title { font-size: 25px; }

/* ── Commander line (intro) ── */
.camp-commander {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.camp-vs {
  font-size: 9px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.camp-commander-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--p2);
}
.camp-commander-flavor {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-dim);
  font-style: italic;
}

/* ── Objective block (intro) ── */
.camp-objective {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px solid var(--rule);
  border-left: 3px solid var(--gold-dim);
  background: var(--panel-2);
  padding: 10px 14px;
  text-align: left;
}
.camp-obj-label {
  font-size: 9px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--gold-dim);
}
.camp-obj-text {
  font-family: 'Fraunces', serif;
  font-size: 15px;
  line-height: 1.35;
  color: var(--ink);
}

/* ── Briefing copy ── */
.camp-lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}
.camp-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-dim);
}
.camp-card[data-camp-mode="mobile"] .camp-line { font-size: 11.5px; line-height: 1.55; }
/* On a phone the briefing must never push BEGIN off the screen. */
.camp-card[data-camp-mode="mobile"] .camp-lines {
  max-height: min(34vh, 260px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* ── Stars ── */
.camp-stars { display: flex; justify-content: center; gap: 10px; }
.camp-star { color: var(--ink-faint); line-height: 1; }
.camp-star[data-filled="true"] {
  color: var(--gold);
  text-shadow: 0 0 14px rgba(212,168,87,0.55);
}
.camp-stars-lg .camp-star { font-size: 30px; }
.camp-stars-sm { gap: 4px; }
.camp-stars-sm .camp-star { font-size: 13px; }

.camp-summary {
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--ink-dim);
}
.camp-reason {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink);
}
.camp-note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-faint);
}

/* ── Star criteria recap ── */
.camp-criteria {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
}
.camp-criterion {
  display: flex;
  align-items: baseline;
  gap: 9px;
  font-size: 11.5px;
  color: var(--ink-faint);
  border-bottom: 1px solid rgba(58,48,36,0.5);
  padding-bottom: 5px;
}
.camp-criterion:last-child { border-bottom: none; }
.camp-criterion[data-earned="true"] { color: var(--ink); }
.camp-crit-mark { color: var(--ink-faint); }
.camp-criterion[data-earned="true"] .camp-crit-mark { color: var(--gold); }

/* ── Buttons ── */
.camp-buttons { display: flex; gap: 10px; justify-content: center; margin-top: 2px; }
.camp-btn {
  appearance: none;
  flex: 1;
  min-height: 52px;
  padding: 0 22px;
  border-radius: 10px;
  cursor: pointer;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  border: 1px solid var(--rule);
  background: var(--panel-2);
  color: var(--ink-dim);
  transition: filter 0.12s ease, border-color 0.15s ease, background 0.15s ease;
}
.camp-btn-gold {
  background: linear-gradient(100deg, var(--gold), #c39a44);
  border-color: #f0cd85;
  color: #2a2008;
  box-shadow: 0 6px 18px -6px rgba(212,168,87,0.5);
}
.camp-btn-ghost { background: transparent; border-color: var(--rule); color: var(--ink-dim); }
.camp-btn-ghost:hover { border-color: var(--gold-dim); color: var(--ink); }
.camp-btn:active { filter: brightness(0.93); }
.camp-card[data-camp-mode="desktop"] .camp-buttons { margin-top: 10px; }
.camp-card[data-camp-mode="desktop"] .camp-btn { flex: 0 1 auto; min-width: 170px; }

/* ── Mission select ── */
.camp-list { display: flex; flex-direction: column; gap: 8px; }
.camp-row {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 60px;
  padding: 10px 14px;
  text-align: left;
  cursor: pointer;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--gold-dim);
  border-radius: 10px;
  font-family: 'IBM Plex Mono', monospace;
  color: var(--ink);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.camp-row:hover:not(:disabled) { border-color: var(--gold); background: var(--panel-2); }
.camp-row[data-locked="true"] {
  cursor: default;
  opacity: 0.5;
  border-left-color: var(--rule);
  background: transparent;
}
.camp-row[data-completed="true"] { border-left-color: var(--gold); }
.camp-row-n {
  font-family: 'Fraunces', serif;
  font-size: 22px;
  font-feature-settings: 'lnum' 'tnum';
  color: var(--gold-dim);
  flex: none;
  width: 34px;
}
.camp-row[data-completed="true"] .camp-row-n { color: var(--gold); }
.camp-row-mid { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.camp-row-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.camp-row-commander { font-size: 10.5px; color: var(--ink-dim); }
.camp-row-right { flex: none; display: flex; align-items: center; }
.camp-lock { font-size: 13px; filter: grayscale(1); opacity: 0.75; }

.camp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-top: 4px;
  text-align: left;
}
.camp-foot .camp-btn { min-height: 40px; font-size: 11px; flex: none; min-width: 0; }

/* Fullscreen select: give the card room on a phone. */
.camp-screen[data-camp-mode="mobile"] .camp-card {
  width: min(100vw, 460px);
  padding: 20px 16px calc(20px + env(safe-area-inset-bottom));
}
/* Note above, button under it — side by side the note orphans a word at 390px. */
.camp-screen[data-camp-mode="mobile"] .camp-foot {
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  margin-top: 8px;
}
.camp-screen[data-camp-mode="desktop"] .camp-card { min-width: 460px; }
.camp-card[data-camp-mode="desktop"] .camp-stars-lg .camp-star { font-size: 38px; }

/* ── Desktop floating pills ──────────────────────────────────────────────────
   Objective under the top chrome; hint bottom-centre in the cancel chip's
   idiom, lifted above the chip's own 96px so the two never overlap. */
.camp-objective-pill,
.camp-hint-chip {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  pointer-events: none;
  max-width: min(560px, calc(100vw - 48px));
  text-align: center;
  background: var(--panel);
  border: 1px solid var(--gold-dim);
  color: var(--ink);
  padding: 9px 18px;
  box-shadow: 0 12px 30px -12px rgba(0,0,0,0.75);
  font-family: 'IBM Plex Mono', monospace;
}
.camp-objective-pill {
  /* Clears the desktop chrome's top band (player panels + turn indicator). */
  top: 118px;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
  border-color: var(--rule-strong);
}
.camp-hint-chip {
  bottom: calc(152px + env(safe-area-inset-bottom));
  font-size: 11.5px;
  line-height: 1.5;
  letter-spacing: 0.04em;
  animation: camp-hint-in 0.3s ease both;
}
@keyframes camp-hint-in {
  from { opacity: 0; transform: translate(-50%, 6px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}
.camp-objective-pill[hidden], .camp-hint-chip[hidden] { display: none; }

@media (max-width: 720px) {
  .camp-card[data-camp-mode="desktop"] {
    min-width: 0;
    width: min(100%, 460px);
    padding: 24px 20px 20px;
    margin: 16px;
  }
  .camp-card[data-camp-mode="desktop"] .camp-title { font-size: 26px; }
  .camp-objective-pill { top: 92px; font-size: 10px; }
}
`;
  const style = document.createElement('style');
  style.dataset.bats = 'campaign-screens';
  style.textContent = css;
  document.head.appendChild(style);
}
