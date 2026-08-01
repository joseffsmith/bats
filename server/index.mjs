// Production server: static dist/ + replay ingest.
//
// Deliberately zero-dependency (node:http only) — the app itself has no
// runtime deps and the server shouldn't be the thing that changes that.
//
// Routes:
//   GET  /api/health            → { ok, replays }
//   POST /api/replays           → store body as one replay file (JSONL from
//                                 renderer/replay-capture.ts), 204 on success
//   GET  /api/replays           → JSON listing [{ name, size, mtime }]
//   GET  /api/replays/<name>    → raw replay file
//   GET  /*                     → dist/ static, SPA-fallback to index.html
//
// Replays land in REPLAY_DIR (default /data/replays — a persistent volume in
// prod, so they survive redeploys). Ingest is public, so it is bounded: body
// capped at MAX_BODY bytes, per-IP hourly rate limit, and the first line must
// parse as a JSON replay-log header. Disk is bounded too: only the newest
// REPLAY_MAX replays are kept (see "Retention" below).

import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8000);
const DIST = path.resolve(process.env.DIST_DIR ?? 'dist');
const REPLAY_DIR = path.resolve(process.env.REPLAY_DIR ?? '/data/replays');
const MAX_BODY = 2 * 1024 * 1024; // 2 MiB — a long match is ~100 KiB
const RATE_LIMIT = 60; // POSTs per IP per hour
const REPLAY_MAX = Number(process.env.REPLAY_MAX ?? 500); // newest N kept on disk
const LIST_LIMIT = 200; // newest N returned by GET /api/replays

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
};

// ── Rate limiting ────────────────────────────────────────────────────────────
// Sliding one-hour window. Timestamps are pruned on each hit, but that only
// ever touches the IP in front of us — so entries for IPs that have gone quiet
// are swept every RATE_SWEEP_MS. Without the sweep the Map would retain one
// entry per IP ever seen, for the life of the process.
const RATE_SWEEP_MS = 5 * 60_000;
const hits = new Map(); // ip → number[] (timestamps, ms, ascending)
let lastRateSweep = Date.now();

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 3600_000;
  if (now - lastRateSweep >= RATE_SWEEP_MS) {
    lastRateSweep = now;
    for (const [seen, times] of hits) {
      // Ascending, so the last entry is the newest hit from that IP.
      if (times.length === 0 || times[times.length - 1] <= windowStart) hits.delete(seen);
    }
  }
  const list = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (list.length >= RATE_LIMIT) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function clientIp(req) {
  // Single trusted hop: host nginx sets X-Real-IP.
  const real = req.headers['x-real-ip'];
  return typeof real === 'string' && real.length > 0 ? real : req.socket.remoteAddress ?? '?';
}

// ── Retention ────────────────────────────────────────────────────────────────
// Every finished browser game POSTs a replay, so the directory only ever grows.
// Keep the newest REPLAY_MAX by mtime, deleting the overage; the sweep runs at
// boot and after each successful ingest, and readdirs only when the live count
// says we are over the cap. That count is also what /api/health reports, so the
// happy path never touches the filesystem.
let replayCount = 0;
let sweeping = false;

async function replayNames() {
  return (await fs.readdir(REPLAY_DIR)).filter((n) => n.endsWith('.jsonl'));
}

async function pruneReplays() {
  if (sweeping || replayCount <= REPLAY_MAX) return;
  sweeping = true;
  try {
    const names = await replayNames();
    replayCount = names.length; // the directory is the truth; resync
    if (names.length <= REPLAY_MAX) return;
    const stated = await Promise.all(
      names.map(async (n) => ({
        name: n,
        mtime: (await fs.stat(path.join(REPLAY_DIR, n))).mtimeMs,
      })),
    );
    stated.sort((a, b) => b.mtime - a.mtime); // newest first
    let pruned = 0;
    for (const { name } of stated.slice(REPLAY_MAX)) {
      try {
        await fs.unlink(path.join(REPLAY_DIR, name));
        replayCount--;
        pruned++;
        console.log(`[retention] deleted ${name}`);
      } catch (err) {
        console.error(`[retention] could not delete ${name}`, err);
      }
    }
    if (pruned > 0) {
      console.log(`[retention] pruned ${pruned}, kept ${replayCount} (cap ${REPLAY_MAX})`);
    }
  } finally {
    sweeping = false;
  }
}

// ── Replay ingest ────────────────────────────────────────────────────────────

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleIngest(req, res) {
  if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'rate limited' });
  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch {
    return sendJson(res, 413, { error: 'body too large' });
  }
  const text = body.toString('utf8');
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  try {
    const header = JSON.parse(firstLine);
    if (header?.type !== 'header' || typeof header?.map !== 'string') {
      throw new Error('not a replay header');
    }
  } catch {
    return sendJson(res, 400, { error: 'first line must be a replay-log header' });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${crypto.randomBytes(4).toString('hex')}.jsonl`;
  await fs.writeFile(path.join(REPLAY_DIR, name), text, 'utf8');
  replayCount++;
  console.log(`[ingest] stored ${name} (${body.length} bytes)`);
  await pruneReplays().catch((err) => console.error('[retention] sweep failed', err));
  res.writeHead(204).end();
}

// File names we mint are the only ones we serve back — reject anything else.
const REPLAY_NAME = /^[0-9TZ-]+-[0-9a-f]{8}\.jsonl$/;

async function handleReplayGet(res, name) {
  if (name === '') {
    // The listing is the one endpoint that genuinely needs the directory, but
    // it hands back only the newest LIST_LIMIT.
    const listing = await Promise.all(
      (await replayNames()).map(async (n) => {
        const st = await fs.stat(path.join(REPLAY_DIR, n));
        return { name: n, size: st.size, mtime: st.mtime.toISOString() };
      }),
    );
    listing.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return sendJson(res, 200, listing.slice(0, LIST_LIMIT));
  }
  if (!REPLAY_NAME.test(name)) return sendJson(res, 404, { error: 'not found' });
  return streamFile(res, path.join(REPLAY_DIR, name), '.jsonl', 'no-store');
}

// ── Static ───────────────────────────────────────────────────────────────────

function streamFile(res, filePath, ext, cacheControl) {
  return fs
    .stat(filePath)
    .then((st) => {
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': st.size,
        'cache-control': cacheControl,
      });
      createReadStream(filePath).pipe(res);
    })
    .catch(() => sendJson(res, 404, { error: 'not found' }));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleStatic(res, urlPath) {
  const rel = path.posix.normalize(urlPath).replace(/^(\.\.\/?)+/, '');
  let filePath = path.join(DIST, rel);
  if (!filePath.startsWith(DIST)) return sendJson(res, 404, { error: 'not found' });
  let ext = path.extname(filePath);
  // SPA fallback: anything without an extension gets index.html.
  if (ext === '') {
    filePath = path.join(DIST, 'index.html');
    ext = '.html';
  }
  // Vite content-hashes /assets/* — cache those forever; everything else
  // (notably index.html, which carries the hashes) revalidates on deploy.
  const cache = rel.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  return streamFile(res, filePath, ext, cache);
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const route = (async () => {
    if (p === '/api/health' && req.method === 'GET') {
      // replayCount is maintained by ingest/retention — no per-request readdir.
      return sendJson(res, 200, {
        ok: true,
        replays: replayCount,
        sha: process.env.BUILD_SHA ?? null,
      });
    }
    if (p === '/api/replays' && req.method === 'POST') return handleIngest(req, res);
    if ((p === '/api/replays' || p.startsWith('/api/replays/')) && req.method === 'GET') {
      return handleReplayGet(res, p.replace(/^\/api\/replays\/?/, ''));
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return handleStatic(res, p);
  })();
  route.catch((err) => {
    console.error('[server] handler error', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    else res.end();
  });
});

await fs.mkdir(REPLAY_DIR, { recursive: true });
replayCount = (await replayNames()).length;
await pruneReplays();
server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}, dist=${DIST}, replays=${REPLAY_DIR}`);
  console.log(`[server] ${replayCount} replays on disk (cap ${REPLAY_MAX})`);
});
