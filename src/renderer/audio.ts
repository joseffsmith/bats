// Procedural sound effects.
//
// Tiny WebAudio module. No external files: every effect is a few oscillator
// nodes routed through a gain envelope. Total cost ≈ a couple of kilobytes
// and zero asset bandwidth.
//
// Browser autoplay rules: AudioContext cannot start until the user has
// interacted with the page. Call `audio.unlock()` from a click handler before
// any audio playback. We additionally swallow any "context not allowed"
// errors so the renderer never crashes on a fresh page load.
//
// Tests: under JSDOM there is no `AudioContext` constructor. The module
// detects this and degrades to a no-op stub that still records calls in an
// internal `__lastEffect` field for assertion.

import type { Action, GameState } from '../engine/core/types';
import { log } from '../engine/core/logger';

export type SoundEffect = 'move' | 'attack' | 'capture' | 'win' | 'build';

export type AudioOptions = {
  /** Start muted. Default true. The HUD has a mute toggle that flips this. */
  initiallyMuted?: boolean;
  /** Master gain (0..1). Default 0.25 — kept quiet for hot-seat play. */
  volume?: number;
};

export type AudioModule = {
  /** Unlock the underlying AudioContext (must be called from a user gesture). */
  unlock(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Map an action to a sound effect and play it. */
  onAction(action: Action, state: GameState): void;
  /** Play a named effect directly. */
  play(effect: SoundEffect): void;
  /** Test helper: last requested effect (undefined if none played yet). */
  readonly __lastEffect: SoundEffect | undefined;
};

type AudioCtxLike = AudioContext;

declare global {
  // Some browsers ship the prefixed version; keep the union narrow.
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function getAudioCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.AudioContext === 'function') return window.AudioContext;
  if (typeof window.webkitAudioContext === 'function') return window.webkitAudioContext;
  return null;
}

export function createAudio(opts: AudioOptions = {}): AudioModule {
  let muted = opts.initiallyMuted ?? true;
  const volume = opts.volume ?? 0.25;

  const Ctor = getAudioCtor();
  let ctx: AudioCtxLike | null = null;
  let unlocked = false;
  const state = { lastEffect: undefined as SoundEffect | undefined };

  function ensureCtx(): AudioCtxLike | null {
    if (!Ctor) return null;
    if (!ctx) {
      try {
        ctx = new Ctor();
      } catch (err) {
        log('render', 'audio init failed', { err: String(err) });
        ctx = null;
      }
    }
    return ctx;
  }

  function tone(opts2: {
    freq: number;
    durationMs: number;
    type: OscillatorType;
    startOffsetMs?: number;
    peakGain?: number;
  }): void {
    const c = ensureCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = opts2.type;
    osc.frequency.value = opts2.freq;
    const now = c.currentTime + (opts2.startOffsetMs ?? 0) / 1000;
    const dur = opts2.durationMs / 1000;
    const peak = (opts2.peakGain ?? 0.4) * volume;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  function moveSound(): void {
    tone({ freq: 100, durationMs: 80, type: 'sine', peakGain: 0.3 });
  }

  function attackSound(): void {
    // Square-wave burst with a short pitch drop.
    const c = ensureCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'square';
    const now = c.currentTime;
    osc.frequency.setValueAtTime(250, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.1);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.35 * volume, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  function captureSound(): void {
    tone({ freq: 440, durationMs: 80, type: 'triangle', peakGain: 0.35 });
    tone({ freq: 880, durationMs: 120, type: 'triangle', startOffsetMs: 80, peakGain: 0.35 });
  }

  function buildSound(): void {
    tone({ freq: 220, durationMs: 70, type: 'sawtooth', peakGain: 0.25 });
    tone({ freq: 330, durationMs: 90, type: 'sawtooth', startOffsetMs: 70, peakGain: 0.25 });
  }

  function winSound(): void {
    tone({ freq: 523.25, durationMs: 140, type: 'triangle' }); // C5
    tone({ freq: 659.26, durationMs: 140, type: 'triangle', startOffsetMs: 140 }); // E5
    tone({ freq: 783.99, durationMs: 260, type: 'triangle', startOffsetMs: 280 }); // G5
  }

  function play(effect: SoundEffect): void {
    state.lastEffect = effect;
    if (muted) return;
    if (!unlocked) return; // pre-gesture: silently no-op
    log('render', 'audio play', { effect });
    try {
      switch (effect) {
        case 'move':
          moveSound();
          break;
        case 'attack':
          attackSound();
          break;
        case 'capture':
          captureSound();
          break;
        case 'build':
          buildSound();
          break;
        case 'win':
          winSound();
          break;
      }
    } catch (err) {
      log('render', 'audio play failed', { err: String(err) });
    }
  }

  function onAction(action: Action, after: GameState): void {
    switch (action.type) {
      case 'MOVE':
        play('move');
        break;
      case 'ATTACK':
        play('attack');
        break;
      case 'CAPTURE':
        play('capture');
        break;
      case 'BUILD':
        play('build');
        break;
      default:
        break;
    }
    if (after.winner !== null) play('win');
  }

  const api: AudioModule = {
    unlock(): void {
      const c = ensureCtx();
      if (!c) return;
      if (c.state === 'suspended') {
        c.resume().catch(() => {
          /* swallow; browser may still reject */
        });
      }
      unlocked = true;
      log('render', 'audio unlocked');
    },
    setMuted(value: boolean): void {
      muted = value;
      log('render', 'audio mute toggled', { muted });
    },
    isMuted(): boolean {
      return muted;
    },
    onAction,
    play,
    get __lastEffect(): SoundEffect | undefined {
      return state.lastEffect;
    },
  };
  return api;
}
