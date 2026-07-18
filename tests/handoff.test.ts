// @vitest-environment jsdom
//
// Hot-seat fog handoff interstitial (src/renderer/handoff.ts). The pass-the-device
// scrim drops on each END_TURN when fog is on and BOTH controllers are human, and
// lifts only on the "Begin turn" tap. It must NOT show for fog-off or AI-involved
// games. `bothHuman` is read live at each END_TURN (controllers can switch).

import { describe, expect, it, beforeEach } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import { createHandoff } from '../src/renderer/handoff';
import type { Emitter } from '../src/renderer/emitter';

function fresh(): Emitter {
  document.body.innerHTML = '';
  return createEmitter(loadMap(duelMap));
}

function scrim(): HTMLElement | null {
  return document.querySelector('.handoff-scrim');
}

describe('fog handoff interstitial', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is inactive at mount (boot is P0\'s own turn — nothing to hand over)', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => true,
    });
    expect(handoff.isActive()).toBe(false);
    expect(scrim()!.hidden).toBe(true);
  });

  it('shows on END_TURN naming the incoming player, hides on Begin turn', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => true,
    });

    emitter.dispatch({ type: 'END_TURN' }); // P0 → P1
    expect(handoff.isActive()).toBe(true);
    expect(scrim()!.hidden).toBe(false);
    expect(scrim()!.dataset.player).toBe('1');
    expect(document.querySelector('.handoff-title')!.textContent).toBe('Pass to Cobalt');

    const begin = document.querySelector<HTMLButtonElement>('[data-action="begin-turn"]')!;
    begin.click();
    expect(handoff.isActive()).toBe(false);
    expect(scrim()!.hidden).toBe(true);
  });

  it('names Vermilion when control returns to P0', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => true,
    });
    emitter.dispatch({ type: 'END_TURN' }); // → P1
    document.querySelector<HTMLButtonElement>('[data-action="begin-turn"]')!.click();
    emitter.dispatch({ type: 'END_TURN' }); // → P0
    expect(handoff.isActive()).toBe(true);
    expect(document.querySelector('.handoff-title')!.textContent).toBe('Pass to Vermilion');
  });

  it('never shows when fog is off', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: false,
      bothHuman: () => true,
    });
    emitter.dispatch({ type: 'END_TURN' });
    expect(handoff.isActive()).toBe(false);
    expect(scrim()!.hidden).toBe(true);
  });

  it('never shows when a controller is AI (bothHuman() false)', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => false,
    });
    emitter.dispatch({ type: 'END_TURN' });
    expect(handoff.isActive()).toBe(false);
    expect(scrim()!.hidden).toBe(true);
  });

  it('reads bothHuman live — suppressed once a controller flips to AI mid-game', () => {
    const emitter = fresh();
    let both = true;
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => both,
    });
    emitter.dispatch({ type: 'END_TURN' }); // → P1, both human → shows
    expect(handoff.isActive()).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-action="begin-turn"]')!.click();

    both = false; // a dropdown switched a controller to AI
    emitter.dispatch({ type: 'END_TURN' }); // → P0, now AI-involved → no scrim
    expect(handoff.isActive()).toBe(false);
  });

  it('ignores non-END_TURN state changes and setState refreshes', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => true,
    });
    // A setState (load/replay scrub) emits stateChanged with action=null.
    emitter.setState({ ...structuredClone(emitter.getState()), currentPlayer: 1 });
    expect(handoff.isActive()).toBe(false);
  });

  it('destroy() unsubscribes and removes the scrim', () => {
    const emitter = fresh();
    const handoff = createHandoff({
      parent: document.body,
      emitter,
      fogOn: true,
      bothHuman: () => true,
    });
    handoff.destroy();
    expect(scrim()).toBeNull();
    // A later END_TURN must not resurrect anything.
    emitter.dispatch({ type: 'END_TURN' });
    expect(handoff.isActive()).toBe(false);
    expect(scrim()).toBeNull();
  });
});
