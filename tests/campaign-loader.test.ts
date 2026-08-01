// Campaign file validation.
//
// The shipped src/data/campaign.json must load, and every hand-authorable
// mistake must be rejected with a message naming the JSON path — the same
// contract the engine's data loaders keep.

import { describe, expect, it } from 'vitest';
import campaignJson from '../src/data/campaign.json';
import { loadCampaign } from '../src/campaign/loader';
import { ALL_MAP_NAMES, CAMPAIGN_MAP_NAMES } from '../src/renderer/maps';
import { PERSONA_NAMES } from '../src/engine/ai/personas';

/** Deep clone of the shipped file so each negative case can mutate freely. */
function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(campaignJson)) as Record<string, unknown>;
}

/** Reach into missions[i] of a cloned campaign. */
function mission(c: Record<string, unknown>, i = 0): Record<string, unknown> {
  const missions = c.missions as Record<string, unknown>[];
  return missions[i]!;
}

describe('campaign loader — shipped file', () => {
  it('loads the shipped campaign', () => {
    const missions = loadCampaign(campaignJson);
    expect(missions).toHaveLength(5);
    expect(missions.map((m) => m.n)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(missions.map((m) => m.id)).size).toBe(5);
  });

  it('every mission names a registered map and a real persona', () => {
    for (const m of loadCampaign(campaignJson)) {
      expect(ALL_MAP_NAMES).toContain(m.map);
      expect(CAMPAIGN_MAP_NAMES).toContain(m.map);
      expect(PERSONA_NAMES).toContain(m.opponent.persona);
    }
  });

  it('mission 1 teaches the select → stage → commit grammar', () => {
    const m1 = loadCampaign(campaignJson)[0]!;
    expect(m1.hints.length).toBeGreaterThanOrEqual(4);
    expect(m1.hints[0]!.show).toEqual({ on: 'immediate' });
    const triggers = m1.hints.map((h) => JSON.stringify(h.clear));
    expect(triggers).toContain(JSON.stringify({ on: 'input', kind: 'unit-selected' }));
    expect(triggers).toContain(JSON.stringify({ on: 'action', type: 'MOVE' }));
    expect(triggers).toContain(JSON.stringify({ on: 'action', type: 'ATTACK' }));
  });

  it('exactly one mission runs under fog, and it is the last', () => {
    const missions = loadCampaign(campaignJson);
    const foggy = missions.filter((m) => m.fog);
    expect(foggy).toHaveLength(1);
    expect(foggy[0]!.n).toBe(missions.length);
  });

  it('every mission leaves room between the speed star and the day limit', () => {
    for (const m of loadCampaign(campaignJson)) {
      expect(m.defeat.dayLimit).toBeGreaterThan(m.stars.winByDay);
    }
  });
});

describe('campaign loader — rejections', () => {
  it('rejects a wrong version', () => {
    const c = clone();
    c.version = 2;
    expect(() => loadCampaign(c)).toThrow(/campaign\.version: expected version 1, got 2/);
  });

  it('rejects a missing version', () => {
    const c = clone();
    delete c.version;
    expect(() => loadCampaign(c)).toThrow(/campaign\.version/);
  });

  it('rejects a non-object payload', () => {
    expect(() => loadCampaign(null)).toThrow(/campaign: expected object, got null/);
    expect(() => loadCampaign([])).toThrow(/campaign: expected object, got array/);
  });

  it('rejects an unknown persona, naming the path', () => {
    const c = clone();
    (mission(c).opponent as Record<string, unknown>).persona = 'nihilist';
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.opponent\.persona: unknown persona "nihilist"/,
    );
  });

  it('rejects an unregistered map, naming the path', () => {
    const c = clone();
    mission(c, 2).map = 'atlantis';
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[2\]\.map: map "atlantis" is not registered/,
    );
  });

  it('rejects a day limit that does not exceed the speed star', () => {
    const c = clone();
    (mission(c).stars as Record<string, unknown>).winByDay = 9;
    (mission(c).defeat as Record<string, unknown>).dayLimit = 9;
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.defeat\.dayLimit: dayLimit \(9\) must be greater than stars\.winByDay \(9\)/,
    );
  });

  it('rejects a hint keyed to an unknown input state', () => {
    const c = clone();
    const hints = mission(c).hints as Record<string, unknown>[];
    hints[0]!.clear = { on: 'input', kind: 'unit-selected-ish' };
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.hints\[0\]\.clear\.kind: expected one of/,
    );
  });

  it('rejects a hint keyed to an unknown action type', () => {
    const c = clone();
    const hints = mission(c).hints as Record<string, unknown>[];
    hints[1]!.show = { on: 'action', type: 'RETREAT' };
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.hints\[1\]\.show\.type: expected one of/,
    );
  });

  it('rejects an immediate clear trigger', () => {
    const c = clone();
    const hints = mission(c).hints as Record<string, unknown>[];
    hints[0]!.clear = { on: 'immediate' };
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.hints\[0\]\.clear\.on: a "clear" trigger cannot be "immediate"/,
    );
  });

  it('rejects duplicate hint ids', () => {
    const c = clone();
    const hints = mission(c).hints as Record<string, unknown>[];
    hints[1]!.id = hints[0]!.id;
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.hints\[1\]\.id: duplicate hint id/,
    );
  });

  it('rejects empty copy', () => {
    const c = clone();
    mission(c, 1).objective = '   ';
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[1\]\.objective: expected non-empty string/,
    );
  });

  it('rejects an empty intro', () => {
    const c = clone();
    mission(c).intro = [];
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.intro: expected at least one line/,
    );
  });

  it('rejects a non-boolean fog flag', () => {
    const c = clone();
    mission(c).fog = 'yes';
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[0\]\.fog: expected boolean, got string/,
    );
  });

  it('rejects duplicate mission ids', () => {
    const c = clone();
    mission(c, 1).id = mission(c, 0).id;
    expect(() => loadCampaign(c)).toThrow(
      /campaign\.missions\[1\]\.id: duplicate mission id/,
    );
  });

  it('rejects a gap in the mission numbering', () => {
    const c = clone();
    mission(c, 4).n = 9;
    expect(() => loadCampaign(c)).toThrow(/campaign\.missions: mission numbers must run 1\.\.5/);
  });

  it('rejects an empty mission list', () => {
    expect(() => loadCampaign({ version: 1, missions: [] })).toThrow(
      /campaign\.missions: expected at least one mission/,
    );
  });
});

describe('campaign loader — injectable registries', () => {
  it('accepts names from the injected registries', () => {
    const c = clone();
    mission(c).map = 'sandbox';
    (mission(c).opponent as Record<string, unknown>).persona = 'stub';
    const missions = loadCampaign(c, {
      mapNames: ['sandbox', ...CAMPAIGN_MAP_NAMES],
      personaNames: ['stub', ...PERSONA_NAMES],
    });
    expect(missions[0]!.map).toBe('sandbox');
    expect(missions[0]!.opponent.persona).toBe('stub');
  });

  it('an injected registry that omits a shipped map rejects it', () => {
    expect(() => loadCampaign(campaignJson, { mapNames: ['duel'] })).toThrow(
      /campaign\.missions\[0\]\.map/,
    );
  });
});
