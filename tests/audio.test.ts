// @vitest-environment jsdom
//
// Phase 6 audio module smoke test.
//
// Under JSDOM there is no AudioContext. The audio module must:
//   - construct without throwing
//   - expose the four-effect API (move/attack/capture/win + build)
//   - record the last requested effect even when audio is unavailable
//   - respect setMuted toggle

import { describe, expect, it } from 'vitest';
import { createAudio } from '../src/renderer/audio';

describe('audio module', () => {
  it('constructs muted by default and exposes the public API', () => {
    const a = createAudio();
    expect(a.isMuted()).toBe(true);
    expect(typeof a.play).toBe('function');
    expect(typeof a.onAction).toBe('function');
    expect(typeof a.setMuted).toBe('function');
    expect(typeof a.unlock).toBe('function');
  });

  it('respects initiallyMuted=false', () => {
    const a = createAudio({ initiallyMuted: false });
    expect(a.isMuted()).toBe(false);
  });

  it('records the last requested effect even when JSDOM has no AudioContext', () => {
    const a = createAudio({ initiallyMuted: false });
    a.unlock();
    a.play('move');
    expect(a.__lastEffect).toBe('move');
    a.play('attack');
    expect(a.__lastEffect).toBe('attack');
  });

  it('does not throw if play is called before unlock', () => {
    const a = createAudio({ initiallyMuted: false });
    expect(() => a.play('move')).not.toThrow();
  });

  it('setMuted toggles state cleanly', () => {
    const a = createAudio();
    expect(a.isMuted()).toBe(true);
    a.setMuted(false);
    expect(a.isMuted()).toBe(false);
    a.setMuted(true);
    expect(a.isMuted()).toBe(true);
  });

  it('onAction maps engine actions to the right sound', () => {
    const a = createAudio({ initiallyMuted: false });
    a.unlock();
    a.onAction(
      { type: 'MOVE', unitId: 'u1', path: [{ x: 1, y: 0 }] },
      // The "after" state is unused by the audio module except for the winner
      // check; pass any state-shaped object.
      { winner: null } as never,
    );
    expect(a.__lastEffect).toBe('move');
    a.onAction({ type: 'ATTACK', attackerId: 'u1', targetId: 'u2' }, { winner: null } as never);
    expect(a.__lastEffect).toBe('attack');
    a.onAction({ type: 'CAPTURE', unitId: 'u1' }, { winner: null } as never);
    expect(a.__lastEffect).toBe('capture');
    a.onAction(
      { type: 'BUILD', at: { x: 0, y: 0 }, unitType: 'tank', owner: 0 },
      { winner: null } as never,
    );
    expect(a.__lastEffect).toBe('build');
    // Winner set should trigger the win fanfare regardless of action type.
    a.onAction({ type: 'END_TURN' }, { winner: 0 } as never);
    expect(a.__lastEffect).toBe('win');
  });
});
