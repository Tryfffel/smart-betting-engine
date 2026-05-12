// Tiny API-Football client with on-disk cache. Reads key from process.env
// or agent/.env. Returns parsed JSON or null on failure. Tracks call count
// per process so the CLI can show how close we are to the daily quota.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, '.cache');
const ENV_FILE = path.join(ROOT, '.env');
const BASE = 'https://v3.football.api-sports.io';

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Minimal .env loader — no dep needed.
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const txt = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadEnv();

const KEY = process.env.API_FOOTBALL_KEY || process.env.APIFOOTBALL_KEY || '';

// Per-endpoint TTL in ms — falls back to 24h.
const TTL = {
  '/teams/statistics':         24 * 3600 * 1000,
  '/teams':                    30 * 24 * 3600 * 1000,
  '/fixtures':                 6  * 3600 * 1000,
  '/fixtures/headtohead':      24 * 3600 * 1000,
  '/injuries':                 6  * 3600 * 1000,
  '/standings':                12 * 3600 * 1000,
  '/predictions':              3  * 3600 * 1000,
  '/players/squads':           24 * 3600 * 1000,
  default:                     24 * 3600 * 1000
};

function ttlFor(pathOnly) {
  for (const k of Object.keys(TTL)) {
    if (k !== 'default' && pathOnly.startsWith(k)) return TTL[k];
  }
  return TTL.default;
}

function cachePath(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(CACHE_DIR, h + '.json');
}

const stats = { calls: 0, cacheHits: 0 };

async function get(endpointWithQuery) {
  if (!KEY) {
    console.warn('[apifootball] No API_FOOTBALL_KEY set — returning null.');
    return null;
  }
  const url = BASE + endpointWithQuery;
  const cf = cachePath(url);
  const pathOnly = endpointWithQuery.split('?')[0];
  const ttl = ttlFor(pathOnly);

  if (fs.existsSync(cf)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (Date.now() - cached.t < ttl) {
        stats.cacheHits++;
        return cached.body;
      }
    } catch {}
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    stats.calls++;
    const r = await fetch(url, {
      headers: { 'x-apisports-key': KEY, 'accept': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[apifootball] HTTP ${r.status} on ${endpointWithQuery}`);
      return null;
    }
    const body = await r.json();
    if (body?.errors && Object.keys(body.errors).length) {
      // API-Football returns 200 + errors object for misconfigured queries.
      console.warn(`[apifootball] API errors on ${endpointWithQuery}:`, body.errors);
      return null;
    }
    try { fs.writeFileSync(cf, JSON.stringify({ t: Date.now(), body })); } catch {}
    return body;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[apifootball] fetch failed ${endpointWithQuery}: ${e.message}`);
    return null;
  }
}

function statsSnapshot() { return { ...stats }; }
function hasKey() { return !!KEY; }

module.exports = { get, statsSnapshot, hasKey };
