// Backtests prediction strategies against historical Stryktipset draws.
//
// Fetches past draws from Svenska Spel's API, extracts streck %, odds, and
// the settled result for every match, then runs each strategy against the
// actual outcome. Reports Brier score, log-loss, and hit-rate per strategy
// so we have actual evidence that our model is (or isn't) better than the
// dumb baselines.
//
// Usage:
//   node cli.js backtest --count 30
//   node cli.js backtest --count 50 --game europatipset
//
// Without --count it defaults to 20 draws.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STR = require('../engine/strategies');

const CACHE_DIR = path.join(__dirname, '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'SmartBettingEngine/0.1 (+https://github.com/tryfffel/smart-betting-engine)';
const SVS_BASE = process.env.SBE_SVS_BASE || 'https://api.spela.svenskaspel.se/draw';

// ---------- HTTP with disk cache --------------------------------------------

function cachePath(url, ttlTag) {
  const h = crypto.createHash('sha1').update(url + '|' + ttlTag).digest('hex');
  return path.join(CACHE_DIR, 'bt-' + h + '.json');
}

async function fetchJson(url, { ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
  // Past draws are immutable once settled — long TTL is fine.
  const cf = cachePath(url, ttlMs);
  if (fs.existsSync(cf)) {
    try {
      const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (Date.now() - c.t < ttlMs) return c.body;
    } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const body = await r.json();
    try { fs.writeFileSync(cf, JSON.stringify({ t: Date.now(), body })); } catch {}
    return body;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// ---------- Draw / event normalization --------------------------------------

function getCurrentDrawNumber(d) {
  if (!d) return null;
  const arr = d.draws || d.draw || [];
  if (!arr.length) return null;
  const open = arr.find(x => (x.drawState || '').toLowerCase() === 'open') || arr[0];
  return open?.drawNumber || open?.number || null;
}

function extractEvents(draw) {
  return draw.drawEvents || draw.events || draw.matches || [];
}

// Try the various places Svenska Spel might park the settled outcome.
function getOutcome(ev) {
  const cands = [
    ev.outcome, ev.result,
    ev.match?.result, ev.match?.outcome,
    ev.eventResult?.outcome, ev.eventResult?.result
  ].filter(Boolean);
  for (const c of cands) {
    const s = String(c).toUpperCase().trim();
    if (s === '1' || s === 'X' || s === '2') return s;
  }
  // Sometimes outcomes are in a "score" form — derive from goals
  const home = ev.match?.score?.home ?? ev.match?.fullTime?.home;
  const away = ev.match?.score?.away ?? ev.match?.fullTime?.away;
  if (Number.isFinite(home) && Number.isFinite(away)) {
    if (home > away) return '1';
    if (home < away) return '2';
    return 'X';
  }
  return null;
}

function extractMatch(ev, idx) {
  const parts = ev.participants || ev.match?.participants || [];
  const home = parts.find(p => /home/i.test(p.type))?.name ?? '';
  const away = parts.find(p => /away/i.test(p.type))?.name ?? '';
  const dist = ev.distribution || ev.streck || {};
  const streck = {
    '1': Number(dist.ones ?? dist['1'] ?? dist.one  ?? 0),
    'X': Number(dist.x    ?? dist['X'] ?? dist.draw ?? 0),
    '2': Number(dist.twos ?? dist['2'] ?? dist.two  ?? 0)
  };
  const odds = ev.odds || ev.svenskaFolket || {};
  const sportsbookOdds = {
    '1': Number(odds.one ?? odds['1'] ?? 0) || null,
    'X': Number(odds.x   ?? odds['X'] ?? 0) || null,
    '2': Number(odds.two ?? odds['2'] ?? 0) || null
  };
  return {
    idx: idx + 1,
    home, away,
    league: ev.match?.leagueName || '',
    streck,
    sportsbookOdds,
    outcome: getOutcome(ev)
  };
}

async function fetchDraw(game, drawNumber) {
  return fetchJson(`${SVS_BASE}/${game}/draws/${drawNumber}`);
}

async function fetchHistorical(game, count) {
  // Find current draw, then walk backwards drawNumber-by-drawNumber.
  const list = await fetchJson(`${SVS_BASE}/${game}/draws`, { ttlMs: 60 * 1000 });
  let cur = getCurrentDrawNumber(list);
  if (!cur) throw new Error('Could not determine current draw number');
  const draws = [];
  let dn = cur - 1;
  let attempts = 0;
  while (draws.length < count && attempts < count * 3) {
    attempts++;
    const d = await fetchDraw(game, dn);
    dn--;
    if (!d) continue;
    const drawObj = (d.draws && d.draws[0]) || d.draw || d;
    const events = extractEvents(drawObj);
    if (!events.length) continue;
    const matches = events.map((e, i) => extractMatch(e, i));
    const settled = matches.filter(m => m.outcome);
    // Only include draws where all events have outcomes
    if (settled.length !== matches.length) continue;
    draws.push({
      drawNumber: drawObj.drawNumber || drawObj.number,
      regCloseTime: drawObj.regCloseTime || drawObj.closeTime,
      matches
    });
  }
  return draws;
}

// ---------- Scoring ---------------------------------------------------------

// Brier score for a 3-way prediction: sum of squared errors.
// Range [0, 2] where 0 = perfect.
function brier(pred, actual) {
  const a = { pH: actual === '1' ? 1 : 0, pX: actual === 'X' ? 1 : 0, pA: actual === '2' ? 1 : 0 };
  return Math.pow(pred.pH - a.pH, 2) + Math.pow(pred.pX - a.pX, 2) + Math.pow(pred.pA - a.pA, 2);
}

// Log-loss (cross-entropy). Lower = better. -log(0) is clamped.
function logLoss(pred, actual) {
  const p = actual === '1' ? pred.pH : actual === 'X' ? pred.pX : pred.pA;
  return -Math.log(Math.max(p, 1e-6));
}

// Hit-rate: did the strategy's top pick match the actual outcome?
function topPickHit(pred, actual) {
  const arr = [['1', pred.pH], ['X', pred.pX], ['2', pred.pA]].sort((a, b) => b[1] - a[1]);
  return arr[0][0] === actual ? 1 : 0;
}

// ---------- Strategy registry ----------------------------------------------

const STRATEGIES = {
  'streck-leader':       STR.streckLeader,
  'streck-raw':          STR.streckRaw,
  'streck-shrunk':       (m) => STR.streckShrunk(m, 0.08),
  'streck-bias-corr':    STR.streckBiasCorrected,
  'odds-leader':         STR.oddsLeader,
  'odds-implied':        STR.oddsImplied,
  'odds+streck-70/30':   (m) => STR.oddsStreckBlend(m, 0.70),
  'odds+streck-50/50':   (m) => STR.oddsStreckBlend(m, 0.50)
};

function evaluate(draws) {
  const perStrategy = {};
  for (const name of Object.keys(STRATEGIES)) {
    perStrategy[name] = { brier: 0, logLoss: 0, hits: 0, n: 0, used: 0 };
  }

  for (const draw of draws) {
    for (const m of draw.matches) {
      if (!m.outcome) continue;
      for (const [name, fn] of Object.entries(STRATEGIES)) {
        const pred = fn(m);
        if (!pred) continue;
        const s = perStrategy[name];
        s.n++;
        s.brier += brier(pred, m.outcome);
        s.logLoss += logLoss(pred, m.outcome);
        s.hits += topPickHit(pred, m.outcome);
        s.used++;
      }
    }
  }

  return Object.entries(perStrategy).map(([name, s]) => ({
    strategy: name,
    matches: s.n,
    brier: s.n ? +(s.brier / s.n).toFixed(4) : null,
    logLoss: s.n ? +(s.logLoss / s.n).toFixed(4) : null,
    hitRate: s.n ? +(s.hits / s.n).toFixed(4) : null
  }));
}

// ---------- Main entry ------------------------------------------------------

async function runBacktest({ game = 'stryktipset', count = 20, log = () => {} } = {}) {
  log(`→ Fetching ${count} historical ${game} draws…`);
  const draws = await fetchHistorical(game, count);
  log(`  ${draws.length} settled draws · ${draws.reduce((a, d) => a + d.matches.length, 0)} matcher`);
  if (!draws.length) throw new Error('No settled historical draws found');

  const summary = evaluate(draws);
  // Sort by log-loss (lower = better)
  summary.sort((a, b) => (a.logLoss ?? 9) - (b.logLoss ?? 9));

  return {
    game,
    drawsBacktested: draws.length,
    matchesScored: draws.reduce((a, d) => a + d.matches.length, 0),
    drawRange: { from: draws[draws.length-1]?.drawNumber, to: draws[0]?.drawNumber },
    backtestedAt: new Date().toISOString(),
    results: summary,
    detailsByDraw: draws.map(d => ({
      drawNumber: d.drawNumber,
      outcomes: d.matches.map(m => m.outcome).join(',')
    }))
  };
}

module.exports = { runBacktest, evaluate, STRATEGIES, brier, logLoss, topPickHit };
