// Walks a round-robin log directory and computes per-persona BUILD
// composition statistics. Outputs:
//   - total BUILD count per (persona, unit type)
//   - average BUILD count per match per (persona, unit type)
//   - per-(map, persona) breakdown
//   - stalemate count (matches reaching maxTurns with no winner)
//
//   tsx scripts/analyze-builds.ts <logDir>
//
// Reads `summary.tsv` for the match list + outcome, then re-parses each
// JSONL match log to count BUILD actions per player. Header line tells us
// which persona was on which side.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type Counts = Map<string, number>;

type PerPersonaStats = {
  matches: number;
  totalBuilds: number;
  byUnit: Counts;
  byMap: Map<string, { matches: number; totalBuilds: number; byUnit: Counts }>;
};

function addCount(c: Counts, key: string, n = 1): void {
  c.set(key, (c.get(key) ?? 0) + n);
}

function avg(total: number, n: number): number {
  return n > 0 ? total / n : 0;
}

async function readJsonl(file: string): Promise<unknown[]> {
  const text = await fs.readFile(file, 'utf8');
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function main(): Promise<void> {
  const logDir = process.argv[2];
  if (!logDir) {
    console.error('usage: tsx scripts/analyze-builds.ts <logDir>');
    process.exit(1);
  }
  const summaryPath = path.join(logDir, 'summary.tsv');
  const tsv = await fs.readFile(summaryPath, 'utf8');
  const lines = tsv.trim().split('\n');
  const header = lines[0]!.split('\t');
  const idx = (k: string): number => header.indexOf(k);

  type Row = {
    personaA: string;
    personaB: string;
    map: string;
    seed: string;
    sideA: number;
    outcome: string;
    turns: number;
    rawWinner: string;
  };

  const rows: Row[] = lines.slice(1).map((l) => {
    const c = l.split('\t');
    return {
      personaA: c[idx('personaA')]!,
      personaB: c[idx('personaB')]!,
      map: c[idx('map')]!,
      seed: c[idx('seed')]!,
      sideA: Number(c[idx('sideA')]!),
      outcome: c[idx('outcome')]!,
      turns: Number(c[idx('turns')]!),
      rawWinner: c[idx('rawWinner')]!,
    };
  });

  // Map of persona name -> aggregated stats.
  const stats = new Map<string, PerPersonaStats>();
  const getStats = (name: string): PerPersonaStats => {
    let s = stats.get(name);
    if (!s) {
      s = {
        matches: 0,
        totalBuilds: 0,
        byUnit: new Map(),
        byMap: new Map(),
      };
      stats.set(name, s);
    }
    return s;
  };

  // Stalemate counters (matches hitting maxTurns with no rawWinner) per pair+map.
  let stalemates = 0;
  let totalMatches = 0;
  const stalematesByPairMap = new Map<string, number>();
  const matchesByPairMap = new Map<string, number>();
  const drawsByOutcome = { A: 0, B: 0, draw: 0 };

  // Walk all match logs.
  const allFiles = await fs.readdir(logDir);
  const jsonlFiles = allFiles.filter((f) => f.endsWith('.jsonl'));

  // Index by seed and matchup so we can join with summary rows.
  const filesBySeed = new Map<string, string>();
  for (const f of jsonlFiles) {
    // Names: <a>-vs-<b>-<map>-<idx>-s<seed>.jsonl
    const m = f.match(/-s(\d+)\.jsonl$/);
    if (!m) continue;
    filesBySeed.set(m[1]!, f);
  }

  for (const r of rows) {
    totalMatches += 1;
    const pairMapKey = `${r.personaA} vs ${r.personaB}|${r.map}`;
    matchesByPairMap.set(pairMapKey, (matchesByPairMap.get(pairMapKey) ?? 0) + 1);
    if (r.rawWinner === '-') {
      stalemates += 1;
      stalematesByPairMap.set(pairMapKey, (stalematesByPairMap.get(pairMapKey) ?? 0) + 1);
    }
    drawsByOutcome[r.outcome as 'A' | 'B' | 'draw'] += 1;

    const file = filesBySeed.get(r.seed);
    if (!file) continue;
    const events = await readJsonl(path.join(logDir, file));
    // Walk actions, count BUILDs per player.
    const p0Persona = r.sideA === 0 ? r.personaA : r.personaB;
    const p1Persona = r.sideA === 0 ? r.personaB : r.personaA;
    const sA = getStats(r.personaA);
    const sB = getStats(r.personaB);
    sA.matches += 1;
    sB.matches += 1;
    // Per-map sub-stats.
    const subA = sA.byMap.get(r.map) ?? { matches: 0, totalBuilds: 0, byUnit: new Map() };
    const subB = sB.byMap.get(r.map) ?? { matches: 0, totalBuilds: 0, byUnit: new Map() };
    subA.matches += 1;
    subB.matches += 1;
    sA.byMap.set(r.map, subA);
    sB.byMap.set(r.map, subB);

    for (const e of events) {
      const ev = e as Record<string, unknown>;
      if (ev.type !== 'action') continue;
      const act = ev.action as { type?: string; unitType?: string } | undefined;
      if (!act || act.type !== 'BUILD' || typeof act.unitType !== 'string') continue;
      const player = ev.player as number;
      const persona = player === 0 ? p0Persona : p1Persona;
      const s = getStats(persona);
      s.totalBuilds += 1;
      addCount(s.byUnit, act.unitType);
      const sub = s.byMap.get(r.map)!;
      sub.totalBuilds += 1;
      addCount(sub.byUnit, act.unitType);
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const personaNames = [...stats.keys()].sort();
  const allUnitTypes = new Set<string>();
  for (const s of stats.values()) for (const k of s.byUnit.keys()) allUnitTypes.add(k);
  const unitTypes = [...allUnitTypes].sort();

  console.log(`── Build composition (logDir: ${logDir}) ──\n`);
  console.log(`Total matches: ${totalMatches}`);
  console.log(`Stalemates (rawWinner=none): ${stalemates} (${((stalemates / totalMatches) * 100).toFixed(1)}%)`);
  console.log(`Outcomes: A=${drawsByOutcome.A} B=${drawsByOutcome.B} draw=${drawsByOutcome.draw}`);
  console.log('');

  console.log('── stalemates by pair+map (rawWinner=none) ──');
  const stalemateEntries = [...stalematesByPairMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of stalemateEntries) {
    const total = matchesByPairMap.get(k) ?? 0;
    console.log(`  ${k.padEnd(45)} ${String(n).padStart(3)}/${String(total).padStart(3)}`);
  }
  console.log('');

  // Per-persona aggregate avg builds per match by unit type.
  console.log('── Avg BUILDs per match, by persona × unit type ──');
  console.log(`  persona       matches  total  ` + unitTypes.map((u) => u.slice(0, 5).padStart(6)).join(' '));
  for (const p of personaNames) {
    const s = stats.get(p)!;
    const cells = unitTypes
      .map((u) => avg(s.byUnit.get(u) ?? 0, s.matches).toFixed(1).padStart(6))
      .join(' ');
    console.log(
      `  ${p.padEnd(13)} ${String(s.matches).padStart(7)}  ${String(s.totalBuilds).padStart(5)}  ${cells}`,
    );
  }
  console.log('');

  // Per-map per-persona (avg builds per match).
  console.log('── Avg BUILDs per match, per (map, persona, unit type) ──');
  // Pull a map list:
  const allMaps = new Set<string>();
  for (const s of stats.values()) for (const m of s.byMap.keys()) allMaps.add(m);
  const maps = [...allMaps].sort();
  for (const m of maps) {
    console.log(`\n  ${m}`);
    console.log(`    persona       matches  ` + unitTypes.map((u) => u.slice(0, 5).padStart(6)).join(' '));
    for (const p of personaNames) {
      const s = stats.get(p)!;
      const sub = s.byMap.get(m);
      if (!sub) continue;
      const cells = unitTypes
        .map((u) => avg(sub.byUnit.get(u) ?? 0, sub.matches).toFixed(1).padStart(6))
        .join(' ');
      console.log(`    ${p.padEnd(13)} ${String(sub.matches).padStart(7)}  ${cells}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
