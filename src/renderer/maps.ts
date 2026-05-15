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

export type MapName =
  | 'duel'
  | 'crossroads'
  | 'island_hop'
  | 'canyon'
  | 'highlands'
  | 'armada';

export const MAP_NAMES: ReadonlyArray<MapName> = [
  'duel',
  'crossroads',
  'island_hop',
  'canyon',
  'highlands',
  'armada',
];

export const DEFAULT_MAP: MapName = 'duel';

export const MAPS: Record<MapName, unknown> = {
  duel: duelMap,
  crossroads: crossroadsMap,
  island_hop: islandHopMap,
  canyon: canyonMap,
  highlands: highlandsMap,
  armada: armadaMap,
};

/** Validate a raw string against the known map names; returns DEFAULT_MAP on
 *  unknown / missing input. */
export function resolveMapName(raw: string | null | undefined): MapName {
  if (raw && (MAP_NAMES as ReadonlyArray<string>).includes(raw)) {
    return raw as MapName;
  }
  return DEFAULT_MAP;
}

/** Display label for a map: "Island Hop", "Duel", etc. */
export function mapLabel(name: MapName): string {
  return name
    .split('_')
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');
}
