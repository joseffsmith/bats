// Shared registry of the built-in map JSONs used by both the renderer chrome
// (replay loader, map picker) and `main.ts` (initial map load).
//
// Keeping this here — under /renderer — rather than under /engine because the
// engine layer never reaches into the renderer; the renderer is allowed to
// import data files directly via Vite's JSON loader.

import duelMap from '../data/maps/duel.json';
import crossroadsMap from '../data/maps/crossroads.json';
import islandHopMap from '../data/maps/island_hop.json';
import canyonMap from '../data/maps/canyon.json';
import highlandsMap from '../data/maps/highlands.json';
import armadaMap from '../data/maps/armada.json';
import c1FirstStrikeMap from '../data/maps/c1_first_strike.json';
import c2FlagCountryMap from '../data/maps/c2_flag_country.json';
import c3WarEconomyMap from '../data/maps/c3_war_economy.json';
import c4HighGroundMap from '../data/maps/c4_high_ground.json';
import c5BlackPinesMap from '../data/maps/c5_black_pines.json';

export type MapName =
  | 'duel'
  | 'crossroads'
  | 'island_hop'
  | 'canyon'
  | 'highlands'
  | 'armada';

/** Teaching-campaign boards. Deliberately NOT part of `MapName` / `MAP_NAMES`:
 *  they are portrait, scripted, and balanced around a specific lesson, so they
 *  must never appear in the skirmish map picker (which iterates `MAP_NAMES`)
 *  nor in the per-map skirmish e2e boot sweep. They ARE registered in `MAPS`
 *  so replay logs and campaign screens can resolve them by name. */
export type CampaignMapName =
  | 'c1_first_strike'
  | 'c2_flag_country'
  | 'c3_war_economy'
  | 'c4_high_ground'
  | 'c5_black_pines';

/** Any board the registry can hand back JSON for — skirmish or campaign. */
export type AnyMapName = MapName | CampaignMapName;

/** Skirmish boards, in map-picker order. Campaign boards are excluded here on
 *  purpose — see `CAMPAIGN_MAP_NAMES`. */
export const MAP_NAMES: ReadonlyArray<MapName> = [
  'duel',
  'crossroads',
  'island_hop',
  'canyon',
  'highlands',
  'armada',
];

/** Campaign boards, in mission order (c1 … c5). */
export const CAMPAIGN_MAP_NAMES: ReadonlyArray<CampaignMapName> = [
  'c1_first_strike',
  'c2_flag_country',
  'c3_war_economy',
  'c4_high_ground',
  'c5_black_pines',
];

/** Every registered board. Use for name resolution (replays, saves), never for
 *  the skirmish picker. */
export const ALL_MAP_NAMES: ReadonlyArray<AnyMapName> = [
  ...MAP_NAMES,
  ...CAMPAIGN_MAP_NAMES,
];

export const DEFAULT_MAP: MapName = 'duel';

export const MAPS: Record<AnyMapName, unknown> = {
  duel: duelMap,
  crossroads: crossroadsMap,
  island_hop: islandHopMap,
  canyon: canyonMap,
  highlands: highlandsMap,
  armada: armadaMap,
  c1_first_strike: c1FirstStrikeMap,
  c2_flag_country: c2FlagCountryMap,
  c3_war_economy: c3WarEconomyMap,
  c4_high_ground: c4HighGroundMap,
  c5_black_pines: c5BlackPinesMap,
};

/** Validate a raw string against the SKIRMISH map names; returns DEFAULT_MAP on
 *  unknown / missing input. Campaign boards deliberately do not resolve here —
 *  `?map=c1_first_strike` falls back to duel so the campaign can't be entered
 *  sideways through the skirmish URL. Use `resolveAnyMapName` for campaign /
 *  replay lookups. */
export function resolveMapName(raw: string | null | undefined): MapName {
  if (raw && (MAP_NAMES as ReadonlyArray<string>).includes(raw)) {
    return raw as MapName;
  }
  return DEFAULT_MAP;
}

/** True when `raw` names any registered board, campaign boards included. */
export function isAnyMapName(raw: string | null | undefined): raw is AnyMapName {
  return !!raw && (ALL_MAP_NAMES as ReadonlyArray<string>).includes(raw);
}

/** Resolve any registered board name (skirmish or campaign). Returns null for
 *  unknown input — callers decide the fallback. */
export function resolveAnyMapName(
  raw: string | null | undefined,
): AnyMapName | null {
  return isAnyMapName(raw) ? raw : null;
}

/** Raw JSON for a registered board. Returns null when the name is unknown, so
 *  callers can distinguish "not a map" from a map that happens to be falsy. */
export function mapJson(raw: string | null | undefined): unknown {
  const name = resolveAnyMapName(raw);
  return name === null ? null : MAPS[name];
}

/** Display label for a map: "Island Hop", "Duel", etc. */
export function mapLabel(name: AnyMapName): string {
  return name
    .split('_')
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');
}
