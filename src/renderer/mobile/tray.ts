// Mobile command tray — the bottom half of the mobile-first UI.
//
// On desktop the player's options are scattered across the frame: a toolshelf
// bottom-left, an end-turn cluster bottom-right, tile-anchored popover menus,
// a floating cancel chip. That works with a mouse and 1280px of width. On a
// phone it does not, so mobile replaces all of it with ONE surface: a tray
// pinned to the bottom of the screen that always answers "what did I just tap,
// and what can I do about it".
//
// ── The contract ────────────────────────────────────────────────────────────
// The tray owns no game state and no input state. It is a pure projection of
//
//     input.getState()  ×  emitter.getState()
//
// re-rendered from scratch on every `stateChanged` / `inputStateChanged`. Every
// button dispatches back through the input controller (`confirmStaged`,
// `cancel`, `stageBuild`, `chooseAction`, `toggleThreat`) or the emitter
// (END_TURN) — nothing here reaches into the engine.
//
// Because it is a projection, there is exactly one place that decides what a
// given input node looks like (`renderInput`), and the mobile grammar's
// select → stage → commit loop gets a matching visual grammar for free:
//   tap 1 → a card describing what you touched
//   tap 2 → a card describing what will happen, plus CANCEL / CONFIRM
//   tap 3 (or CONFIRM) → it happens, and the tray falls back to idle.
//
// ── Structural conventions (shared with chrome.ts / menus.ts) ───────────────
//   - `ensureStyle()` injects the stylesheet exactly once;
//   - the root is `pointer-events: none`, the tray panel opts back in, so the
//     void beside a short tray still passes taps through to the board;
//   - the end-turn button keeps chrome's `data-action="end-turn"` hook and its
//     disable predicate (match over, or the AI holds the turn);
//   - action entries keep menus.ts's `data-menu-entry="<label>"` and build rows
//     its `data-build-entry="<unitType>"`, so e2e/helpers.ts is unchanged;
//   - the measured height is reported through `onInsetsChange`, which main.ts
//     forwards to `renderer.setBoardInsets` → `camera.setBand`.
//
// ── Campaign extension points ───────────────────────────────────────────────
// Declared here, wired by a later phase (src/campaign/* is untouched):
//   setObjective(text | null)  a persistent objective line above the state body
//   setHint(text | null)       overrides the state's own hint while set
//   presentPanel(el | null)    replaces the whole tray body while set
// All three are idempotent and restore the state-driven rendering on `null`.

import type {
  GameState,
  PlayerId,
  Tile,
  Unit,
  UnitType,
} from '../../engine/core/types';
import { isCapturable, tileAt } from '../../engine/core/types';
import { INCOME_PER_PROPERTY, TERRAIN, UNITS } from '../../engine/data';
import { previewAttack } from '../../engine/systems/combat';
import { deserialize, downloadSave } from '../../engine/save';
import { log } from '../../engine/core/logger';
import type { Emitter } from '../emitter';
import type { InputController, InputState } from '../input';
import type { AIDriver } from '../ai-driver';
import type { AnimationQueue } from '../animations';
import type { AudioModule } from '../audio';
import type { SpriteCache } from '../sprites';
import { UNIT_LETTER, unitLabel } from '../hud';

const PLAYER_NAMES: Record<PlayerId, string> = { 0: 'Vermilion', 1: 'Cobalt' };

const TERRAIN_LABEL: Record<Tile['terrain'], string> = {
  plain: 'Plain',
  road: 'Road',
  forest: 'Forest',
  mountain: 'Mountain',
  sea: 'Sea',
  city: 'City',
  hq: 'HQ',
  factory: 'Factory',
};

function dayOf(turn: number): number {
  return Math.ceil(turn / 2);
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

// ─────────────────────────── Public API ──────────────────────────────────────

export type Tray = {
  destroy(): void;
  /**
   * Persistent objective line rendered above the state body (campaign missions:
   * "Capture the Cobalt HQ"). `null` removes it.
   */
  setObjective(text: string | null): void;
  /**
   * Override the hint text for every state until cleared. `null` restores the
   * state-derived hint. The hint element itself (`[data-tray-hint]`) is present
   * in every state either way.
   */
  setHint(text: string | null): void;
  /**
   * Replace the tray body with a caller-owned element (mission briefing /
   * debrief cards). `null` restores the state-driven body. While a panel is
   * presented the tray reports `data-tray-state="panel"`.
   */
  presentPanel(el: HTMLElement | null): void;
};

export type TrayDeps = {
  parent: HTMLElement;
  emitter: Emitter;
  input: InputController;
  aiDriver: AIDriver;
  animQueue: AnimationQueue;
  audio: AudioModule;
  /** Baked unit sprites for the unit / forecast / build cards. */
  sprites: SpriteCache;
  /** Reports the measured tray height (CSS px) whenever it changes. */
  onInsetsChange?: (bottom: number) => void;
};

export function createTray(deps: TrayDeps): Tray {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'tray-root';

  const panel = document.createElement('div');
  panel.className = 'tray';

  const objective = document.createElement('div');
  objective.className = 'tray-objective';
  objective.dataset.trayObjective = '';
  objective.hidden = true;

  const body = document.createElement('div');
  body.className = 'tray-body';

  const actions = document.createElement('div');
  actions.className = 'tray-actions';

  panel.append(objective, body, actions);
  root.appendChild(panel);
  deps.parent.appendChild(root);

  // ── Tray-owned view flags ──────────────────────────────────────────────────
  let objectiveText: string | null = null;
  let hintOverride: string | null = null;
  let presented: HTMLElement | null = null;
  let toolsOpen = false;
  /** Last input node seen, so a real transition can close the tools sheet. */
  let lastKind = '';

  // Hidden file picker for Load — created once, reused (chrome.ts pattern).
  const loadFile = document.createElement('input');
  loadFile.type = 'file';
  loadFile.accept = 'application/json,.json';
  loadFile.style.display = 'none';
  loadFile.addEventListener('change', () => {
    const file = loadFile.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      try {
        deps.emitter.setState(deserialize(String(reader.result ?? '')));
        toolsOpen = false;
        render();
        log('engine', 'save loaded');
      } catch (err) {
        console.error(err);
      }
    };
    reader.readAsText(file);
  });
  root.appendChild(loadFile);

  // ─────────────────────── Small DOM builders ──────────────────────────────

  function makeHint(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tray-hint';
    el.dataset.trayHint = '';
    return el;
  }

  function makeChip(label: string, value?: string): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'tray-chip';
    chip.textContent = label;
    if (value !== undefined) {
      const b = document.createElement('b');
      b.textContent = value;
      chip.append(' ', b);
    }
    return chip;
  }

  type BtnVariant = 'red' | 'gold' | 'ghost' | 'dark' | 'blue';

  function makeBtn(text: string, variant: BtnVariant): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tray-btn tray-btn-${variant}`;
    b.textContent = text;
    return b;
  }

  function makeSquareBtn(glyph: string, label: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tray-btn tray-btn-dark tray-btn-square';
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    return b;
  }

  function makeSprite(type: UnitType, owner: PlayerId, size: 'lg' | 'sm'): HTMLElement {
    const url = deps.sprites.toDataURL(type, owner);
    if (url !== null) {
      const img = document.createElement('img');
      img.className = `tray-sprite tray-sprite-${size}`;
      img.src = url;
      img.alt = unitLabel(type);
      return img;
    }
    // Stub-mode (jsdom, no canvas backend) fallback: the letter chip menus.ts
    // uses, so the card keeps its shape and the tests keep a stable target.
    const span = document.createElement('span');
    span.className = `tray-sprite tray-sprite-${size} tray-sprite-letter`;
    span.textContent = UNIT_LETTER[type];
    return span;
  }

  /** Card shell: coloured spine + optional sprite + a meta column. */
  function makeCard(accent: 'own' | 'enemy' | 'terrain'): {
    card: HTMLElement;
    meta: HTMLElement;
  } {
    const card = document.createElement('div');
    card.className = `tray-card tray-card-${accent}`;
    const meta = document.createElement('div');
    meta.className = 'tray-meta';
    card.appendChild(meta);
    return { card, meta };
  }

  function makeName(main: string, sub?: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tray-name';
    el.textContent = main;
    if (sub !== undefined) {
      const small = document.createElement('small');
      small.textContent = ` · ${sub}`;
      el.appendChild(small);
    }
    return el;
  }

  function makeChips(...chips: HTMLElement[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tray-chips';
    row.append(...chips);
    return row;
  }

  /** MOVE / RNG / HP chips for a unit. The engine has no scalar "attack" stat —
   *  damage is a full attacker×defender table — so range stands in for it. */
  function unitChips(unit: Unit): HTMLElement[] {
    const stats = UNITS[unit.type];
    const chips = [makeChip('MOVE', String(stats.move))];
    if (stats.maxRange > 0) {
      chips.push(
        makeChip(
          'RNG',
          stats.minRange === stats.maxRange
            ? String(stats.maxRange)
            : `${stats.minRange}–${stats.maxRange}`,
        ),
      );
    }
    chips.push(makeChip('HP', String(unit.hp)));
    return chips;
  }

  /** Four-slot defense rating, filled to the terrain's star count. */
  function starsFor(terrain: Tile['terrain']): HTMLElement {
    const n = TERRAIN[terrain].defenseStars;
    const el = document.createElement('span');
    el.className = 'tray-stars';
    el.dataset.trayStars = String(n);
    el.textContent = '★'.repeat(n) + '☆'.repeat(Math.max(0, 4 - n));
    return el;
  }

  function ownerLabel(tile: Tile): string {
    return tile.owner === null ? 'Neutral' : PLAYER_NAMES[tile.owner];
  }

  /** Chips describing a tile: defense stars, and property ownership + income. */
  function tileChips(tile: Tile, extra?: HTMLElement[]): HTMLElement {
    const def = makeChip('DEF');
    def.append(' ', starsFor(tile.terrain));
    const chips = [def, ...(extra ?? [])];
    if (isCapturable(tile.terrain)) {
      chips.push(makeChip(ownerLabel(tile).toUpperCase()));
      chips.push(makeChip('+', money(INCOME_PER_PROPERTY)));
    }
    return makeChips(...chips);
  }

  function makeHpBar(hp: number, loss: number): HTMLElement {
    const keep = Math.max(0, Math.min(100, hp - Math.max(0, loss)));
    const lose = Math.max(0, Math.min(hp, loss));
    const bar = document.createElement('div');
    bar.className = 'tray-hpbar';
    const k = document.createElement('span');
    k.className = 'tray-hp-keep';
    k.style.width = `${keep}%`;
    const l = document.createElement('span');
    l.className = 'tray-hp-lose';
    l.style.width = `${lose}%`;
    bar.append(k, l);
    return bar;
  }

  /** One side of the attack forecast: sprite, name, HP bar. */
  function makeFighter(unit: Unit, loss: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tray-fighter';
    const name = document.createElement('div');
    name.className = 'tray-fighter-name';
    name.textContent = unitLabel(unit.type).toUpperCase();
    el.append(makeSprite(unit.type, unit.owner, 'lg'), name, makeHpBar(unit.hp, loss));
    return el;
  }

  // ─────────────────────── Shared action rows ──────────────────────────────

  function endTurnButton(state: GameState): HTMLButtonElement {
    const btn = makeBtn('END TURN', 'red');
    btn.dataset.action = 'end-turn';
    const chev = document.createElement('span');
    chev.className = 'tray-chev';
    chev.textContent = '▸▸';
    btn.appendChild(chev);
    // Same predicate as chrome.ts: dead while the match is over or the AI holds
    // the turn, because the click handler is inert in both windows.
    const disabled = state.winner !== null || deps.aiDriver.inputLocked(state);
    btn.disabled = disabled;
    btn.classList.toggle('disabled', disabled);
    btn.addEventListener('click', () => {
      const s = deps.emitter.getState();
      if (s.winner !== null) return;
      if (deps.aiDriver.inputLocked(s) || deps.animQueue.busy()) return;
      // Drop any selection first so the next player doesn't inherit a staged
      // action pointing at a unit that is no longer theirs to command.
      deps.input.cancel();
      deps.emitter.dispatch({ type: 'END_TURN' });
    });
    return btn;
  }

  function toolsButton(): HTMLButtonElement {
    const btn = makeSquareBtn('☰', 'Tools');
    btn.dataset.trayTools = '';
    btn.addEventListener('click', () => {
      toolsOpen = true;
      render();
    });
    return btn;
  }

  /** The idle-ish action row: tools + end turn. */
  function idleActions(state: GameState): HTMLElement[] {
    return [toolsButton(), endTurnButton(state)];
  }

  function cancelButton(text = 'CANCEL'): HTMLButtonElement {
    const btn = makeBtn(text, 'ghost');
    btn.dataset.trayCancel = '';
    btn.addEventListener('click', () => deps.input.cancel());
    return btn;
  }

  function confirmButton(text: string, variant: BtnVariant): HTMLButtonElement {
    const btn = makeBtn(text, variant);
    btn.dataset.trayConfirm = '';
    btn.addEventListener('click', () => deps.input.confirmStaged());
    return btn;
  }

  // ─────────────────────── Per-state rendering ─────────────────────────────

  /**
   * Render the body + actions for the current input node. `hint` is the shared
   * hint element: each branch places it where it belongs (inside a card's meta
   * column, or as a standalone row) and `render` guarantees it lands somewhere.
   * Returns the hint TEXT so the override in `render` can replace it.
   */
  function renderInput(state: GameState, s: InputState, hint: HTMLElement): string {
    switch (s.kind) {
      case 'idle': {
        const ph = document.createElement('div');
        ph.className = 'tray-placeholder';
        ph.appendChild(hint);
        body.appendChild(ph);
        actions.append(...idleActions(state));
        return 'Tap a unit to command';
      }

      case 'unit-selected': {
        const { card, meta } = makeCard('own');
        card.prepend(makeSprite(s.unit.type, s.unit.owner, 'lg'));
        meta.append(
          makeName(unitLabel(s.unit.type).toUpperCase()),
          makeChips(...unitChips(s.unit)),
          hint,
        );
        body.appendChild(card);
        actions.append(...idleActions(state));
        return s.unit.hasMoved
          ? 'Tap this unit again for orders'
          : 'Tap a highlighted tile to move · tap an enemy to attack';
      }

      case 'move-previewed': {
        const tile = tileAt(state.map, s.destination);
        const { card, meta } = makeCard('terrain');
        card.prepend(makeSprite(s.unit.type, s.unit.owner, 'lg'));
        meta.append(
          makeName(TERRAIN_LABEL[tile.terrain].toUpperCase(), 'destination'),
          tileChips(tile, [makeChip(`${s.path.length} TILES`)]),
          hint,
        );
        body.appendChild(card);
        actions.append(cancelButton(), confirmButton('CONFIRM MOVE', 'gold'));
        return 'Tap the tile again to confirm the move';
      }

      case 'capture-staged': {
        const tile = tileAt(state.map, s.destination);
        const { card, meta } = makeCard('terrain');
        card.prepend(makeSprite(s.unit.type, s.unit.owner, 'lg'));
        meta.append(
          makeName(TERRAIN_LABEL[tile.terrain].toUpperCase(), 'capture'),
          tileChips(tile, [makeChip(`${s.path.length} TILES`)]),
          hint,
        );
        body.appendChild(card);
        actions.append(cancelButton(), confirmButton('CONFIRM CAPTURE', 'gold'));
        return `Tap again to claim this ${TERRAIN_LABEL[tile.terrain].toLowerCase()}`;
      }

      case 'attack-staged': {
        const dmg = previewAttack(state, s.unit.id, s.target.id);
        const versus = document.createElement('div');
        versus.className = 'tray-versus';

        const forecast = document.createElement('div');
        forecast.className = 'tray-forecast';
        const big = document.createElement('div');
        big.className = 'tray-dmg';
        big.dataset.trayDamage = String(dmg.dealt);
        big.textContent = String(dmg.dealt);
        const unit = document.createElement('small');
        unit.textContent = 'DMG';
        big.appendChild(unit);
        const counter = document.createElement('div');
        counter.className = 'tray-counter';
        counter.dataset.trayCounter = String(dmg.counterReceived);
        counter.textContent = `counter −${dmg.counterReceived}`;
        forecast.append(big, counter);

        versus.append(
          makeFighter(s.unit, dmg.counterReceived),
          forecast,
          makeFighter(s.target, dmg.dealt),
        );
        body.append(versus, hint);
        actions.append(cancelButton(), confirmButton('CONFIRM ATTACK', 'red'));
        return s.path.length > 0
          ? 'Moves into position, then fires · tap the target again to confirm'
          : 'Fires from where it stands · tap the target again to confirm';
      }

      case 'action-menu': {
        const tag = document.createElement('div');
        tag.className = 'tray-tag';
        tag.textContent = `${unitLabel(s.unit.type).toUpperCase()} · choose orders`;

        const orders = document.createElement('div');
        orders.className = 'tray-orders';
        for (const entry of s.entries) {
          const btn = document.createElement('button');
          btn.type = 'button';
          // menus.ts's hook, kept verbatim so e2e/helpers.clickMenuEntry works.
          btn.dataset.menuEntry = entry.label;
          btn.className = `tray-order tray-order-${entry.label.toLowerCase()}`;
          btn.disabled = !entry.enabled;
          const glyph = document.createElement('span');
          glyph.className = 'tray-order-glyph';
          glyph.textContent = ORDER_GLYPH[entry.label] ?? '◼';
          const label = document.createElement('span');
          label.textContent = entry.label.toUpperCase();
          btn.append(glyph, label);
          btn.addEventListener('click', () => deps.input.chooseAction(entry.label));
          orders.appendChild(btn);
        }
        body.append(tag, orders, hint);
        return 'Choose what this unit does where it stands';
      }

      case 'attack-targeting': {
        const tag = document.createElement('div');
        tag.className = 'tray-tag';
        tag.textContent = `${unitLabel(s.unit.type).toUpperCase()} · pick a target`;
        body.append(tag, hint);
        actions.append(cancelButton());
        return s.hover
          ? `Tap ${unitLabel(s.hover.type).toLowerCase()} again to attack`
          : 'Tap a highlighted enemy to attack it';
      }

      case 'unload-targeting': {
        const tag = document.createElement('div');
        tag.className = 'tray-tag';
        tag.textContent = `${unitLabel(s.cargo.type).toUpperCase()} · pick a landing tile`;
        body.append(tag, hint);
        actions.append(cancelButton());
        return 'Tap a highlighted tile to unload';
      }

      case 'build-menu-open': {
        const tile = tileAt(state.map, s.tile);
        const head = document.createElement('div');
        head.className = 'tray-build-head';
        const title = document.createElement('div');
        title.className = 'tray-build-title';
        title.textContent = TERRAIN_LABEL[tile.terrain].toUpperCase();
        const funds = document.createElement('div');
        funds.className = 'tray-build-funds';
        funds.textContent = `◈ ${money(state.players[state.currentPlayer].funds)}`;
        head.append(title, funds);

        const list = document.createElement('div');
        list.className = 'tray-build-list';
        for (const entry of s.entries) {
          const staged = s.staged === entry.unitType;
          const row = document.createElement('button');
          row.type = 'button';
          // menus.ts's hook, kept verbatim.
          row.dataset.buildEntry = entry.unitType;
          row.className = 'tray-brow';
          row.disabled = !entry.affordable;
          row.classList.toggle('staged', staged);
          row.setAttribute('aria-pressed', String(staged));
          const name = document.createElement('span');
          name.className = 'tray-bname';
          name.textContent = entry.label.toUpperCase();
          const price = document.createElement('span');
          price.className = 'tray-bprice';
          price.textContent = money(entry.cost);
          row.append(
            makeSprite(entry.unitType, state.currentPlayer, 'sm'),
            name,
            price,
          );
          row.addEventListener('click', () => {
            // Tap once to stage, tap the same row again to build. Mirrors the
            // board's stage → confirm rhythm so the sheet needs no new grammar.
            if (staged) deps.input.confirmStaged();
            else deps.input.stageBuild(entry.unitType);
          });
          list.appendChild(row);
        }

        body.append(head, list, hint);
        actions.append(cancelButton('CLOSE'));
        if (s.staged !== undefined) {
          actions.appendChild(confirmButton('BUILD', 'gold'));
        }
        return s.staged === undefined
          ? 'Tap a unit to stage it'
          : `Tap ${unitLabel(s.staged).toLowerCase()} again — or BUILD — to deploy`;
      }

      case 'enemy-inspect': {
        const { card, meta } = makeCard('enemy');
        card.prepend(makeSprite(s.unit.type, s.unit.owner, 'lg'));
        meta.append(
          makeName(
            `${PLAYER_NAMES[s.unit.owner]} ${unitLabel(s.unit.type)}`.toUpperCase(),
            'enemy',
          ),
          makeChips(...unitChips(s.unit)),
          hint,
        );
        body.appendChild(card);

        const threat = makeBtn(
          s.showThreat ? 'HIDE THREAT RANGE' : 'SHOW THREAT RANGE',
          'blue',
        );
        threat.dataset.trayThreat = '';
        threat.addEventListener('click', () => deps.input.toggleThreat());
        const dismiss = makeSquareBtn('✕', 'Dismiss');
        dismiss.dataset.trayCancel = '';
        dismiss.addEventListener('click', () => deps.input.cancel());
        actions.append(threat, dismiss);
        return s.showThreat
          ? 'Every tile this unit could reach and hit is marked'
          : 'See everywhere this unit could strike next turn';
      }

      case 'tile-inspect': {
        const tile = tileAt(state.map, s.tile);
        const { card, meta } = makeCard('terrain');
        meta.append(
          makeName(TERRAIN_LABEL[tile.terrain].toUpperCase()),
          tileChips(tile),
          hint,
        );
        body.appendChild(card);
        actions.append(...idleActions(state));
        if (isCapturable(tile.terrain)) {
          return tile.owner === null
            ? 'Unclaimed · infantry can capture it'
            : `Held by ${ownerLabel(tile)} · infantry can capture it`;
        }
        return `${TERRAIN_LABEL[tile.terrain]} gives ${TERRAIN[tile.terrain].defenseStars} defense`;
      }
    }
  }

  // ─────────────────────── Takeovers ───────────────────────────────────────

  /**
   * Match over. Mobile deliberately does NOT mount chrome's modal winner scrim:
   * on a phone the board IS the app, and blacking it out to announce a result
   * the board already shows costs more than it buys. The tray takes over
   * instead — the same surface every other outcome is reported on — and the
   * final position stays readable behind it.
   */
  function renderWinner(state: GameState, hint: HTMLElement): string {
    const winner = state.winner as PlayerId;
    const wrap = document.createElement('div');
    wrap.className = 'tray-complete';
    wrap.dataset.player = String(winner);

    const eyebrow = document.createElement('div');
    eyebrow.className = 'tray-comp-eyebrow';
    eyebrow.textContent = 'Match concluded';

    const title = document.createElement('div');
    title.className = 'tray-comp-title';
    title.textContent = `${PLAYER_NAMES[winner]} victorious`;

    wrap.append(eyebrow, title, hint);
    body.appendChild(wrap);

    const again = makeBtn('PLAY AGAIN', 'gold');
    again.dataset.action = 'play-again';
    again.addEventListener('click', () => window.location.reload());
    actions.appendChild(again);
    return `Player ${winner + 1} took the field on day ${dayOf(state.turn)}`;
  }

  /** In-tray tools sheet: Save / Load / Sound / Restart. Deliberately a strict
   *  subset of the desktop toolshelf — replay, map picker and fog toggle are
   *  desk-work, not phone-work. */
  function renderTools(hint: HTMLElement): string {
    const grid = document.createElement('div');
    grid.className = 'tray-tools';

    const save = makeBtn('SAVE', 'dark');
    save.dataset.trayTool = 'save';
    save.addEventListener('click', () => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        downloadSave(deps.emitter.getState(), `bats-save-${ts}.json`);
        log('engine', 'save downloaded');
      } catch (err) {
        console.error(err);
      }
    });

    const load = makeBtn('LOAD', 'dark');
    load.dataset.trayTool = 'load';
    load.addEventListener('click', () => {
      loadFile.value = '';
      loadFile.click();
    });

    const muted = deps.audio.isMuted();
    const sound = makeBtn(muted ? 'SOUND OFF' : 'SOUND ON', 'dark');
    sound.dataset.trayTool = 'sound';
    sound.classList.toggle('off', muted);
    sound.addEventListener('click', () => {
      deps.audio.unlock();
      deps.audio.setMuted(!deps.audio.isMuted());
      render();
    });

    const restart = makeBtn('RESTART', 'dark');
    restart.dataset.trayTool = 'restart';
    restart.addEventListener('click', () => {
      // Reload preserves `?map=` and every other param, so we get a fresh state
      // through main.ts without inventing a reducer reset path (chrome.ts's
      // Play Again does the same). Destructive → always confirm.
      if (!window.confirm('Restart the match?')) return;
      window.location.reload();
    });

    grid.append(save, load, sound, restart);
    body.append(grid, hint);

    const close = makeBtn('CLOSE', 'ghost');
    close.dataset.trayTool = 'close';
    close.addEventListener('click', () => {
      toolsOpen = false;
      render();
    });
    actions.appendChild(close);
    return 'Save, load, mute or restart the match';
  }

  // ─────────────────────── Measured board inset ────────────────────────────
  // Declared ahead of `render` (which calls it on every pass) so the binding is
  // initialised before the first synchronous render below.
  let lastBottom = -1;
  function reportInset(): void {
    if (!deps.onInsetsChange) return;
    const b = Math.round(panel.offsetHeight);
    if (b === lastBottom) return;
    lastBottom = b;
    deps.onInsetsChange(b);
  }
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => reportInset());
    observer.observe(panel);
  }

  // ─────────────────────── Render ──────────────────────────────────────────

  function render(): void {
    const state = deps.emitter.getState();
    const s = deps.input.getState();

    // A genuine input transition closes the tools sheet — the player moved on.
    if (s.kind !== lastKind) {
      lastKind = s.kind;
      toolsOpen = false;
    }

    // The build roster can overflow its capped list; a re-render triggered by
    // staging a row must not throw the player back to the top of the sheet.
    const prevScroll =
      body.querySelector<HTMLElement>('.tray-build-list')?.scrollTop ?? null;

    body.replaceChildren();
    actions.replaceChildren();

    objective.hidden = objectiveText === null;
    objective.textContent = objectiveText ?? '';

    const hint = makeHint();
    let text: string;
    if (presented !== null) {
      panel.dataset.trayState = 'panel';
      body.appendChild(presented);
      text = '';
    } else if (toolsOpen) {
      panel.dataset.trayState = s.kind;
      text = renderTools(hint);
    } else if (state.winner !== null) {
      panel.dataset.trayState = 'winner';
      text = renderWinner(state, hint);
    } else {
      panel.dataset.trayState = s.kind;
      text = renderInput(state, s, hint);
    }
    if (toolsOpen) panel.dataset.traySheet = 'tools';
    else delete panel.dataset.traySheet;

    // Invariant: `[data-tray-hint]` exists in every state, presented panels
    // included (a campaign panel can still be narrated through setHint).
    if (!panel.contains(hint)) body.appendChild(hint);
    hint.textContent = hintOverride ?? text;
    hint.hidden = hint.textContent === '';

    if (prevScroll !== null) {
      const list = body.querySelector<HTMLElement>('.tray-build-list');
      if (list) list.scrollTop = prevScroll;
    }

    reportInset();
  }

  const unsub = deps.emitter.on((ev) => {
    if (ev.type === 'stateChanged' || ev.type === 'inputStateChanged') render();
  });
  render();
  reportInset();

  return {
    destroy(): void {
      unsub();
      observer?.disconnect();
      root.remove();
    },
    setObjective(text: string | null): void {
      objectiveText = text;
      render();
    },
    setHint(text: string | null): void {
      hintOverride = text;
      render();
    },
    presentPanel(el: HTMLElement | null): void {
      presented = el;
      render();
    },
  };
}

/** Glyphs for the orders row. Unlisted labels fall back to the Wait square. */
const ORDER_GLYPH: Record<string, string> = {
  Attack: '⚔',
  Capture: '⚑',
  Unload: '⇩',
  Dive: '≈',
  Surface: '⇧',
  Wait: '◼',
};

// ─────────────────────────── Styles ──────────────────────────────────────────

let stylesInjected = false;

function ensureStyle(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.tray-root {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  pointer-events: none;
  z-index: 15;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  /* Local palette: the three semantic accents the theme has no var for. */
  --tray-green: #6a9b52;
  --tray-cyan: #8cd2d8;
  --tray-hp: #7fb069;
}

.tray {
  pointer-events: auto;
  background:
    repeating-linear-gradient(-55deg, rgba(255,235,200,0.016) 0 10px, transparent 10px 20px),
    var(--bg-2);
  border-top: 2px solid var(--rule);
  padding: 12px 14px calc(14px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 -18px 40px -22px rgba(0,0,0,0.9);
}

.tray-body { display: flex; flex-direction: column; gap: 10px; }
.tray-actions { display: flex; gap: 10px; align-items: stretch; }
.tray-actions:empty { display: none; }

.tray-objective {
  font-family: 'Fraunces', serif;
  font-size: 17px;
  line-height: 1.3;
  color: var(--ink);
}
.tray-objective[hidden] { display: none; }

.tray-tag {
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--gold-dim);
}

.tray-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-dim);
}
.tray-hint[hidden] { display: none; }

.tray-placeholder {
  border: 1px dashed var(--rule);
  border-radius: 8px;
  padding: 18px 14px;
  text-align: center;
}
.tray-placeholder .tray-hint {
  color: var(--ink-faint);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

/* ── Cards ── */
.tray-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-left: 4px solid var(--rule-strong);
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 8px 24px -12px rgba(0,0,0,0.8);
}
.tray-card-own { border-left-color: var(--p1); }
.tray-card-enemy { border-left-color: var(--p2); }
.tray-card-terrain { border-left-color: var(--tray-green); }

.tray-meta { display: flex; flex-direction: column; gap: 7px; min-width: 0; flex: 1; }
.tray-name {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--ink);
}
.tray-name small {
  color: var(--ink-faint);
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: none;
}

.tray-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.tray-chip {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--ink-dim);
  background: var(--panel-2);
  border: 1px solid var(--rule);
  border-radius: 20px;
  padding: 3px 9px;
  white-space: nowrap;
}
.tray-chip b { color: var(--ink); }
.tray-stars { color: var(--gold); letter-spacing: 0.04em; }

/* ── Sprites ── */
.tray-sprite {
  flex: none;
  border-radius: 8px;
  border: 1px solid var(--rule);
  background: var(--panel-2);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  object-fit: contain;
}
.tray-sprite-lg { width: 60px; height: 60px; }
.tray-sprite-sm { width: 38px; height: 38px; border-radius: 6px; }
.tray-sprite-letter {
  display: grid;
  place-items: center;
  color: var(--ink);
  font-weight: 700;
  font-size: 16px;
}

/* ── Buttons ── */
.tray-btn {
  appearance: none;
  flex: 1;
  min-height: 52px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.13em;
  cursor: pointer;
  border: 1px solid var(--rule);
  background: var(--panel-2);
  color: var(--ink-dim);
  transition: filter 0.12s ease, border-color 0.12s ease;
}
.tray-btn:active { filter: brightness(0.92); }
.tray-btn-square { flex: none; width: 52px; font-size: 19px; font-weight: 400; }
.tray-btn-dark { background: var(--panel-2); border-color: var(--rule); color: var(--ink-dim); }
.tray-btn-ghost { background: transparent; border-color: var(--rule); color: var(--ink-dim); }
.tray-btn-blue { background: transparent; border-color: var(--p2); color: #9cc4e0; }
.tray-btn-red {
  background: linear-gradient(100deg, var(--p1), #b03d3c);
  border-color: #e2726d;
  color: #fff7ec;
  box-shadow: 0 6px 18px -6px var(--p1-glow);
}
.tray-btn-gold {
  background: linear-gradient(100deg, var(--gold), #c39a44);
  border-color: #f0cd85;
  color: #2a2008;
  box-shadow: 0 6px 18px -6px rgba(212,168,87,0.5);
}
.tray-btn:disabled, .tray-btn.disabled {
  background: var(--panel);
  border-color: var(--rule);
  color: var(--ink-faint);
  box-shadow: none;
  opacity: 0.55;
  cursor: default;
  filter: none;
}
.tray-chev { opacity: 0.75; font-size: 12px; letter-spacing: -0.18em; }

/* ── Orders row ── */
.tray-orders { display: flex; gap: 8px; }
.tray-order {
  appearance: none;
  flex: 1;
  min-height: 64px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  cursor: pointer;
  background: var(--panel-2);
  border: 1px solid var(--rule);
  color: var(--ink-dim);
}
.tray-order-glyph { font-size: 18px; font-weight: 400; line-height: 1; }
.tray-order-attack {
  background: linear-gradient(100deg, var(--p1), #b03d3c);
  border-color: #e2726d;
  color: #fff7ec;
}
.tray-order-capture {
  background: linear-gradient(100deg, var(--gold), #c39a44);
  border-color: #f0cd85;
  color: #2a2008;
}
.tray-order:disabled { opacity: 0.45; cursor: default; }

/* ── Attack forecast ── */
.tray-versus {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 12px 10px;
}
.tray-fighter {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 88px;
  flex: none;
}
.tray-fighter-name {
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--ink-dim);
  text-align: center;
}
.tray-hpbar {
  width: 72px;
  height: 5px;
  border-radius: 3px;
  background: #171310;
  overflow: hidden;
  display: flex;
}
.tray-hp-keep { background: var(--tray-hp); height: 100%; }
.tray-hp-lose { background: var(--p1); height: 100%; }
.tray-forecast {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.tray-dmg {
  font-family: 'Fraunces', serif;
  font-feature-settings: 'lnum' 'tnum';
  font-size: 24px;
  font-weight: 600;
  color: #ffd9d0;
  text-shadow: 0 0 12px var(--p1-glow);
}
.tray-dmg small { font-size: 11px; color: #c98a80; font-weight: 400; margin-left: 4px; }
.tray-counter { font-size: 11px; color: var(--ink-dim); }

/* ── Build sheet ── */
.tray-build-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.tray-build-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--ink);
}
.tray-build-funds {
  font-size: 13px;
  font-feature-settings: 'lnum' 'tnum';
  color: var(--gold);
}
.tray-build-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* The 14-entry coastal roster scrolls inside the tray rather than pushing the
     board off the screen — same containment the desktop sheet uses. */
  max-height: min(38vh, 300px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.tray-brow {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 7px 12px;
  min-height: 52px;
  cursor: pointer;
  text-align: left;
  font-family: 'IBM Plex Mono', monospace;
}
.tray-brow.staged {
  border-color: var(--gold);
  background: var(--panel-2);
  box-shadow: 0 0 0 1px var(--gold-dim), 0 6px 18px -8px rgba(212,168,87,0.45);
}
.tray-brow:disabled { opacity: 0.45; cursor: default; }
.tray-bname {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--ink);
  min-width: 0;
}
.tray-bprice {
  font-size: 13px;
  font-feature-settings: 'lnum' 'tnum';
  color: var(--gold);
}
.tray-brow:disabled .tray-bprice { color: var(--ink-faint); }

/* ── Tools sheet ── */
.tray-tools {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.tray-tools .tray-btn { min-height: 48px; }
.tray-tools .tray-btn.off { color: var(--ink-faint); }

/* ── Match concluded takeover ── */
.tray-complete {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 0 2px;
}
.tray-comp-eyebrow {
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--gold-dim);
}
.tray-comp-title {
  font-family: 'Fraunces', serif;
  font-style: italic;
  font-size: 26px;
  color: var(--ink);
}
.tray-complete[data-player="0"] .tray-comp-title { color: var(--p1); }
.tray-complete[data-player="1"] .tray-comp-title { color: var(--p2); }
.tray-complete .tray-hint { text-align: center; }
`;
  const style = document.createElement('style');
  style.dataset.bats = 'tray';
  style.textContent = css;
  document.head.appendChild(style);
}
