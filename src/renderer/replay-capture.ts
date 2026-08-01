// Live-match replay capture.
//
// Subscribes to the emitter and accumulates every applied action as a JSONL
// line in the same format `runMatch` writes (header / action / summary — see
// parseLog in engine/replay.ts), so a captured browser game loads directly in
// the toolshelf Replay modal and in the CLI replay tooling.
//
// Shipping: when the match ends (winner set) the whole log is POSTed once to
// `/api/replays`; closing the tab mid-match flushes what we have via
// `navigator.sendBeacon` instead. Both are fire-and-forget — capture must
// never affect play, so network failures are swallowed (dev serves no
// endpoint and that's fine).
//
// A `setState` (save-load, or the Replay modal scrubbing frames) invalidates
// the action stream — the log's header can no longer rebuild the sequence —
// so the capture marks itself tainted and stops recording/sending for the
// rest of the page's life. Map/fog switches reload the page, which starts a
// fresh capture.

import type { Action } from '../engine/core/types';
import type { LogLine } from '../engine/replay';
import type { Emitter } from './emitter';

export type ReplayCaptureOptions = {
  map: string;
  /** AI driver seed (0 when the driver runs on its Date.now default). */
  seed: number;
  fog: boolean;
  p0: string;
  p1: string;
  /** POST target; default '/api/replays'. */
  endpoint?: string;
};

export type ReplayCapture = {
  /** The capture so far as JSONL (header + actions [+ summary once won]). */
  exportLog(): string;
  /** True once a setState invalidated the stream (log no longer replayable). */
  tainted(): boolean;
};

export function installReplayCapture(
  emitter: Emitter,
  opts: ReplayCaptureOptions,
): ReplayCapture {
  const endpoint = opts.endpoint ?? '/api/replays';
  const startedAt = new Date().toISOString();
  const header: LogLine = {
    type: 'header',
    map: opts.map,
    seed: opts.seed,
    p0: opts.p0,
    p1: opts.p1,
    startedAt,
    fog: opts.fog,
    sha: __BUILD_SHA__,
    client: 'browser',
  };
  const lines: LogLine[] = [header];
  let lastState = emitter.getState();
  let tainted = false;
  let sent = false;

  function exportLog(): string {
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  function send(viaBeacon: boolean): void {
    if (sent || tainted || lines.length < 2) return;
    sent = true;
    const body = exportLog();
    if (viaBeacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/x-ndjson' }));
      return;
    }
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
      keepalive: true,
    }).catch(() => {
      // Fire-and-forget: dev has no ingest endpoint and prod hiccups must
      // never surface in play.
    });
  }

  emitter.on((ev) => {
    if (ev.type !== 'stateChanged' || tainted) return;
    if (ev.action === null) {
      // No-op dispatch re-emits the same state object; a *different* object
      // with no action means setState (load / replay scrubbing) — the stream
      // is no longer the game that started at `header`.
      if (ev.state !== lastState) tainted = true;
      return;
    }
    lines.push({
      type: 'action',
      turn: lastState.turn,
      player: lastState.currentPlayer,
      action: ev.action as Action,
    });
    lastState = ev.state;
    if (ev.state.winner !== null) {
      lines.push({ type: 'summary', turns: ev.state.turn, winner: ev.state.winner });
      send(false);
    }
  });

  // Abandoned matches still matter for debugging: flush a partial log (no
  // summary line — parseLog treats it as optional) when the page goes away.
  window.addEventListener('pagehide', () => send(true));

  return {
    exportLog,
    tainted: () => tainted,
  };
}
