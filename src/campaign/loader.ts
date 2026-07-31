// Validating loader for src/data/campaign.json.
//
// Same contract as the engine's data loaders (see engine/data/loader.ts):
// take `unknown`, return a strongly typed structure, or throw an Error whose
// message names the offending JSON path. No dependencies, no Zod — the schema
// is small and stable, and a hand-rolled validator gives better messages.
//
// Cross-checks that a plain shape validator cannot do on its own:
//   - `opponent.persona` must name a persona in src/data/ai-personas.json;
//   - `map` must be a board registered in renderer/maps.ts;
//   - `defeat.dayLimit` must leave room above `stars.winByDay`;
//   - hint triggers must reference real input-state kinds / action types.
// Both registries are injectable so tests can exercise the rejection paths
// without inventing fake JSON files.

import { PERSONA_NAMES } from '../engine/ai/personas';
import { ALL_MAP_NAMES } from '../renderer/maps';
import { ACTION_TYPES, INPUT_KINDS } from './types';
import type { HintSpec, Mission, Trigger } from './types';

/** Schema version this loader understands. Bump on any breaking shape change. */
export const CAMPAIGN_VERSION = 1;

export type LoadCampaignOptions = {
  /** Board names treated as registered. Defaults to the renderer registry. */
  mapNames?: ReadonlyArray<string>;
  /** AI persona names treated as known. Defaults to ai-personas.json. */
  personaNames?: ReadonlyArray<string>;
};

// ─────────────────────────── Validation primitives ────────────────────────────

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, `expected object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected array, got ${describe(value)}`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `expected string, got ${describe(value)}`);
  return value;
}

/** A string with visible content — empty copy is always an authoring bug. */
function asText(value: unknown, path: string): string {
  const s = asString(value, path);
  if (s.trim().length === 0) fail(path, 'expected non-empty string');
  return s;
}

function asPositiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected finite number, got ${describe(value)}`);
  }
  if (!Number.isInteger(value)) fail(path, `expected integer, got ${value}`);
  if (value <= 0) fail(path, `expected positive integer, got ${value}`);
  return value;
}

function asBool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, `expected boolean, got ${describe(value)}`);
  return value;
}

function asEnum(
  value: unknown,
  allowed: ReadonlyArray<string>,
  path: string,
): string {
  const s = asString(value, path);
  if (!allowed.includes(s)) {
    fail(path, `expected one of [${allowed.join(', ')}], got "${s}"`);
  }
  return s;
}

// ─────────────────────────── Triggers ─────────────────────────────────────────

const TRIGGER_KINDS: ReadonlyArray<string> = ['immediate', 'input', 'action', 'turn'];

function loadTrigger(
  json: unknown,
  path: string,
  opts: { allowImmediate: boolean },
): Trigger {
  const o = asObject(json, path);
  const on = asEnum(o.on, TRIGGER_KINDS, `${path}.on`);
  if (on === 'immediate') {
    if (!opts.allowImmediate) {
      fail(
        `${path}.on`,
        'a "clear" trigger cannot be "immediate" — the hint would vanish before it could be read',
      );
    }
    return { on: 'immediate' };
  }
  if (on === 'input') {
    return { on: 'input', kind: asEnum(o.kind, INPUT_KINDS, `${path}.kind`) };
  }
  if (on === 'action') {
    return { on: 'action', type: asEnum(o.type, ACTION_TYPES, `${path}.type`) };
  }
  return { on: 'turn', day: asPositiveInt(o.day, `${path}.day`) };
}

function loadHints(json: unknown, path: string): HintSpec[] {
  const arr = asArray(json, path);
  const out: HintSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const p = `${path}[${i}]`;
    const o = asObject(arr[i], p);
    const id = asText(o.id, `${p}.id`);
    if (seen.has(id)) fail(`${p}.id`, `duplicate hint id "${id}"`);
    seen.add(id);
    out.push({
      id,
      show: loadTrigger(o.show, `${p}.show`, { allowImmediate: true }),
      clear: loadTrigger(o.clear, `${p}.clear`, { allowImmediate: false }),
      text: asText(o.text, `${p}.text`),
    });
  }
  return out;
}

// ─────────────────────────── Mission + campaign ───────────────────────────────

function loadMission(
  json: unknown,
  path: string,
  known: { maps: ReadonlyArray<string>; personas: ReadonlyArray<string> },
): Mission {
  const o = asObject(json, path);
  const id = asText(o.id, `${path}.id`);
  const n = asPositiveInt(o.n, `${path}.n`);
  const title = asText(o.title, `${path}.title`);

  const map = asString(o.map, `${path}.map`);
  if (!known.maps.includes(map)) {
    fail(`${path}.map`, `map "${map}" is not registered in renderer/maps.ts`);
  }

  const opponentPath = `${path}.opponent`;
  const opp = asObject(o.opponent, opponentPath);
  const persona = asString(opp.persona, `${opponentPath}.persona`);
  if (!known.personas.includes(persona)) {
    fail(
      `${opponentPath}.persona`,
      `unknown persona "${persona}" — expected one of [${known.personas.join(', ')}]`,
    );
  }

  const introRaw = asArray(o.intro, `${path}.intro`);
  if (introRaw.length === 0) fail(`${path}.intro`, 'expected at least one line');
  const intro = introRaw.map((line, i) => asText(line, `${path}.intro[${i}]`));

  const starsPath = `${path}.stars`;
  const starsJson = asObject(o.stars, starsPath);
  const winByDay = asPositiveInt(starsJson.winByDay, `${starsPath}.winByDay`);
  const noUnitLost = asBool(starsJson.noUnitLost, `${starsPath}.noUnitLost`);

  const defeatPath = `${path}.defeat`;
  const defeatJson = asObject(o.defeat, defeatPath);
  const dayLimit = asPositiveInt(defeatJson.dayLimit, `${defeatPath}.dayLimit`);
  if (dayLimit <= winByDay) {
    fail(
      `${defeatPath}.dayLimit`,
      `dayLimit (${dayLimit}) must be greater than stars.winByDay (${winByDay}) — ` +
        'otherwise the speed star is unreachable',
    );
  }

  return {
    id,
    n,
    title,
    map,
    opponent: {
      persona,
      name: asText(opp.name, `${opponentPath}.name`),
      flavor: asText(opp.flavor, `${opponentPath}.flavor`),
    },
    objective: asText(o.objective, `${path}.objective`),
    intro,
    fog: asBool(o.fog, `${path}.fog`),
    hints: loadHints(o.hints, `${path}.hints`),
    stars: { winByDay, noUnitLost },
    defeat: { dayLimit },
  };
}

/**
 * Parse + validate a campaign file. Returns the missions in `n` order.
 * Throws an Error naming the JSON path of the first problem found.
 */
export function loadCampaign(
  json: unknown,
  opts: LoadCampaignOptions = {},
): Mission[] {
  const known = {
    maps: opts.mapNames ?? (ALL_MAP_NAMES as ReadonlyArray<string>),
    personas: opts.personaNames ?? PERSONA_NAMES,
  };

  const o = asObject(json, 'campaign');
  if (o.version !== CAMPAIGN_VERSION) {
    const got = typeof o.version === 'number' ? String(o.version) : describe(o.version);
    fail('campaign.version', `expected version ${CAMPAIGN_VERSION}, got ${got}`);
  }

  const arr = asArray(o.missions, 'campaign.missions');
  if (arr.length === 0) fail('campaign.missions', 'expected at least one mission');

  const missions: Mission[] = [];
  const seenIds = new Set<string>();
  const seenNs = new Set<number>();
  for (let i = 0; i < arr.length; i++) {
    const path = `campaign.missions[${i}]`;
    const m = loadMission(arr[i], path, known);
    if (seenIds.has(m.id)) fail(`${path}.id`, `duplicate mission id "${m.id}"`);
    seenIds.add(m.id);
    if (seenNs.has(m.n)) fail(`${path}.n`, `duplicate mission number ${m.n}`);
    seenNs.add(m.n);
    missions.push(m);
  }

  // Mission numbers must be a dense 1..N run so "Mission 3 of 5" is honest and
  // the unlock chain has no holes.
  missions.sort((a, b) => a.n - b.n);
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i]!;
    if (m.n !== i + 1) {
      fail(
        'campaign.missions',
        `mission numbers must run 1..${missions.length} with no gaps; got ${m.n} at position ${i + 1}`,
      );
    }
  }
  return missions;
}
