// AI personas — tunable variants of the tier3 utility AI.
//
// A persona is a layered config on top of utility-tier3's base machinery:
//   - `weights`: full AIWeights replacement (no role multipliers applied yet)
//   - `roleOverrides`: per-role multiplier overrides; merged onto the
//     defaults in `roles.ts/ROLE_MULTIPLIERS` so a persona only has to
//     mention the keys it wants to change.
//   - `buildPolicy`: hint to the AI's BUILD phase. `preferred` is a priority
//     list of unit types; `avoid` is a blacklist (the AI will only build them
//     if nothing else is affordable). `infantryFloor` is the number of own
//     infantry below which BUILD prefers infantry over the priority list.
//
// We deliberately keep persona logic OUT of `utility.ts`'s hot path: the
// scoring loop still reads a flat AIWeights / RoleMultipliers; the persona
// machinery does the merging once at AI construction time.
//
// Personas are loaded from `src/data/ai-personas.json` at module init. Tests
// can also call `loadPersonas` against an in-memory JSON object to exercise
// the schema validator.

import personasJson from '../../data/ai-personas.json';

import type { UnitType } from '../core/types';
import type { AIWeights } from '../data/loader';
import { ROLE_MULTIPLIERS } from './roles';
import type { Role, RoleMultipliers } from './roles';
import { utilityAI } from './utility';
import type { AI } from './types';

// ─────────────────────────── Public types ────────────────────────────────────

export type BuildPolicy = {
  /** Ordered priority list of unit types to prefer at BUILD time. */
  preferred?: ReadonlyArray<UnitType>;
  /** Unit types the AI will only build as a last resort. */
  avoid?: ReadonlyArray<UnitType>;
  /** Below this many own infantry, prefer infantry over the priority list. */
  infantryFloor?: number;
};

export type PersonaConfig = {
  readonly name: string;
  readonly description: string;
  readonly weights: AIWeights;
  /** Per-role overrides merged onto ROLE_MULTIPLIERS at AI construction. */
  readonly roleMultipliers: Record<Role, RoleMultipliers>;
  readonly buildPolicy: BuildPolicy;
};

// ─────────────────────────── Schema validation ───────────────────────────────

const WEIGHT_KEYS: ReadonlyArray<keyof AIWeights> = [
  'damageDealt',
  'capture',
  'counterRisk',
  'futureThreat',
  'positional',
  'objective',
];

const ROLES: ReadonlyArray<Role> = ['capturer', 'frontline', 'support', 'defender', 'pusher'];

const UNIT_TYPES_ALL: ReadonlyArray<UnitType> = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'copter',
  'transport',
  'fighter',
  'bomber',
  'battleship',
  'cruiser',
  'aatank',
  'lander',
];

function fail(path: string, msg: string): never {
  throw new Error(`personas: ${path}: ${msg}`);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, `expected object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected array');
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected string');
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'expected finite number');
  }
  return value;
}

function asNonNegNumber(value: unknown, path: string): number {
  const n = asNumber(value, path);
  if (n < 0) fail(path, `expected non-negative, got ${n}`);
  return n;
}

function asUnitType(value: unknown, path: string): UnitType {
  const s = asString(value, path);
  if (!UNIT_TYPES_ALL.includes(s as UnitType)) {
    fail(path, `unknown unit type "${s}"`);
  }
  return s as UnitType;
}

function loadWeights(raw: unknown, path: string): AIWeights {
  const o = asObject(raw, path);
  const out = {} as AIWeights;
  for (const k of WEIGHT_KEYS) {
    if (!(k in o)) fail(`${path}.${k}`, 'missing weight key');
    out[k] = asNonNegNumber(o[k], `${path}.${k}`);
  }
  for (const k of Object.keys(o)) {
    if (!(WEIGHT_KEYS as ReadonlyArray<string>).includes(k)) {
      fail(`${path}.${k}`, 'unknown weight key');
    }
  }
  return out;
}

function loadRoleOverrides(
  raw: unknown,
  path: string,
): Record<Role, RoleMultipliers> {
  // Start from a deep clone of the defaults so unmentioned roles & keys keep
  // their canonical multipliers.
  const out: Record<Role, RoleMultipliers> = {} as Record<Role, RoleMultipliers>;
  for (const r of ROLES) out[r] = { ...ROLE_MULTIPLIERS[r] };

  if (raw === undefined) return out;
  const o = asObject(raw, path);
  for (const role of Object.keys(o)) {
    if (!(ROLES as ReadonlyArray<string>).includes(role)) {
      fail(`${path}.${role}`, `unknown role`);
    }
    const overrides = asObject(o[role], `${path}.${role}`);
    for (const k of Object.keys(overrides)) {
      if (!(WEIGHT_KEYS as ReadonlyArray<string>).includes(k)) {
        fail(`${path}.${role}.${k}`, 'unknown role-multiplier key');
      }
      const v = asNonNegNumber(overrides[k], `${path}.${role}.${k}`);
      // RoleMultipliers shares the same keys as AIWeights, so we can cast.
      (out[role as Role] as unknown as Record<string, number>)[k] = v;
    }
  }
  return out;
}

function loadBuildPolicy(raw: unknown, path: string): BuildPolicy {
  if (raw === undefined) return {};
  const o = asObject(raw, path);
  const out: BuildPolicy = {};
  if (o.preferred !== undefined) {
    const arr = asArray(o.preferred, `${path}.preferred`);
    out.preferred = arr.map((v, i) =>
      asUnitType(v, `${path}.preferred[${i}]`),
    );
  }
  if (o.avoid !== undefined) {
    const arr = asArray(o.avoid, `${path}.avoid`);
    out.avoid = arr.map((v, i) => asUnitType(v, `${path}.avoid[${i}]`));
  }
  if (o.infantryFloor !== undefined) {
    const n = asNonNegNumber(o.infantryFloor, `${path}.infantryFloor`);
    if (!Number.isInteger(n)) fail(`${path}.infantryFloor`, 'expected integer');
    out.infantryFloor = n;
  }
  for (const k of Object.keys(o)) {
    if (k !== 'preferred' && k !== 'avoid' && k !== 'infantryFloor') {
      fail(`${path}.${k}`, 'unknown buildPolicy key');
    }
  }
  return out;
}

function loadOnePersona(raw: unknown, path: string): PersonaConfig {
  const o = asObject(raw, path);
  const name = asString(o.name, `${path}.name`);
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
    fail(`${path}.name`, `bad name "${name}" — lowercase letters/digits/_-`);
  }
  const description = asString(o.description, `${path}.description`);
  const weights = loadWeights(o.weights, `${path}.weights`);
  const roleMultipliers = loadRoleOverrides(o.roleOverrides, `${path}.roleOverrides`);
  const buildPolicy = loadBuildPolicy(o.buildPolicy, `${path}.buildPolicy`);
  return { name, description, weights, roleMultipliers, buildPolicy };
}

// ─────────────────────────── Loader ──────────────────────────────────────────

/**
 * Load and validate a personas JSON object. Returns a map of name → config.
 * Throws with a descriptive path on any schema violation.
 */
export function loadPersonas(json: unknown): Record<string, PersonaConfig> {
  const o = asObject(json, 'root');
  const arr = asArray(o.personas, 'root.personas');
  const out: Record<string, PersonaConfig> = {};
  for (let i = 0; i < arr.length; i++) {
    const p = loadOnePersona(arr[i], `personas[${i}]`);
    if (p.name in out) fail(`personas[${i}].name`, `duplicate name "${p.name}"`);
    out[p.name] = p;
  }
  if (Object.keys(out).length === 0) fail('root.personas', 'no personas defined');
  return out;
}

/** Eagerly loaded personas from `src/data/ai-personas.json`. */
export const PERSONAS: Record<string, PersonaConfig> = loadPersonas(personasJson);

/** Sorted persona names — stable order for CLI defaults and tests. */
export const PERSONA_NAMES: ReadonlyArray<string> = Object.keys(PERSONAS).sort();

// ─────────────────────────── AI factory ──────────────────────────────────────

/**
 * Build an AI driven by the named persona. The returned AI is a Tier 3
 * utility AI with the persona's base weights, role multipliers, and build
 * policy in effect.
 */
export function personaAI(name: string): AI {
  const cfg = PERSONAS[name];
  if (!cfg) {
    throw new Error(
      `unknown persona "${name}" — available: ${PERSONA_NAMES.join(', ')}`,
    );
  }
  return utilityAI({
    name: cfg.name,
    weights: cfg.weights,
    useThreatMap: true,
    useRoles: true,
    roleMultipliers: cfg.roleMultipliers,
    buildPolicy: cfg.buildPolicy,
  });
}
