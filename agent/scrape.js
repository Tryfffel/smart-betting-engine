// Fetches the current Stryktipset/Europatipset round.
//
// Primary source for matches + streck: Svenska Spel's public JSON API
//   https://api.spela.svenskaspel.se/draw/<game>/draws
// This is what the official site uses and is much more reliable than scraping
// reducering.se for the match list.
//
// Secondary source for analyser + tips: reducering.se's current-round page.
// The HTML structure changes occasionally; if selectors fail we keep going
// without the analysis text rather than aborting the whole pipeline.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const CACHE_DIR = path.join(__dirname, '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'SmartBettingEngine/0.1 (+https://github.com/tryfffel/smart-betting-engine)';

// Override via env: SBE_SVS_BASE, SBE_REDUCERING_BASE
const SVS_BASE = process.env.SBE_SVS_BASE || 'https://api.spela.svenskaspel.se/draw';
const REDUCERING_BASE = process.env.SBE_REDUCERING_BASE || 'https://reducering.se';

function cachePath(url, ttlTag) {
  const h = crypto.createHash('sha1').update(url + '|' + ttlTag).digest('hex');
  return path.join(CACHE_DIR, 'http-' + h + '.txt');
}

async function fetchText(url, { ttlMs = 30 * 60 * 1000, accept = 'text/html,*/*' } = {}) {
  const cf = cachePath(url, ttlMs);
  if (fs.existsSync(cf)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (Date.now() - cached.t < ttlMs) return cached.body;
    } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept, 'accept-language': 'sv,en;q=0.8' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
    const body = await r.text();
    try { fs.writeFileSync(cf, JSON.stringify({ t: Date.now(), body })); } catch {}
    return body;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ---------- Svenska Spel: matches + streck -----------------------------------

async function fetchSvSDraw(game) {
  const url = `${SVS_BASE}/${game}/draws`;
  const txt = await fetchText(url, { ttlMs: 5 * 60 * 1000, accept: 'application/json' });
  let data;
  try { data = JSON.parse(txt); } catch (e) {
    throw new Error(`Svenska Spel returned non-JSON on ${url}: ${txt.slice(0, 120)}`);
  }
  // Endpoint shape: { draws: [ { drawNumber, regCloseTime, drawEvents: [...] } ] }
  const draws = data.draws || data.draw || [];
  const open = draws.find(d => (d.drawState || '').toLowerCase() === 'open')
            || draws.find(d => new Date(d.regCloseTime || d.closeTime || 0) > new Date())
            || draws[0];
  if (!open) throw new Error('No open draw found in Svenska Spel response');
  return open;
}

function normalizeSvSMatch(ev, idx) {
  // Svenska Spel match shape (typical):
  //   { eventNumber, eventDescription, participants:[{type:'home', name}, {type:'away', name}],
  //     match:{ leagueName, kickOffTime }, odds:{1, X, 2}, distribution:{ ones, x, twos } }
  const parts = ev.participants || [];
  const home = parts.find(p => /home/i.test(p.type))?.name
            ?? ev.match?.participants?.find(p => /home/i.test(p.type))?.name
            ?? ev.eventDescription?.split(/\s*-\s*/)[0]
            ?? '';
  const away = parts.find(p => /away/i.test(p.type))?.name
            ?? ev.match?.participants?.find(p => /away/i.test(p.type))?.name
            ?? ev.eventDescription?.split(/\s*-\s*/)[1]
            ?? '';
  const dist = ev.distribution || ev.streck || {};
  const streck = {
    '1': Number(dist.ones ?? dist['1'] ?? dist.one  ?? 0),
    'X': Number(dist.x    ?? dist['X'] ?? dist.draw ?? 0),
    '2': Number(dist.twos ?? dist['2'] ?? dist.two  ?? 0)
  };
  const odds = ev.odds || ev.svenskaFolket || {};
  return {
    idx: idx + 1,
    home: String(home).trim(),
    away: String(away).trim(),
    league: ev.match?.leagueName || ev.leagueName || ev.competition || '',
    kickoff: ev.match?.kickOffTime || ev.kickOffTime || ev.startTime || '',
    streck,
    sportsbookOdds: {
      '1': Number(odds.one ?? odds['1'] ?? 0) || null,
      'X': Number(odds.x   ?? odds['X'] ?? 0) || null,
      '2': Number(odds.two ?? odds['2'] ?? 0) || null
    },
    analys: '',
    reduceringsTip: ''
  };
}

// ---------- reducering.se: analyser + tips (best-effort) ---------------------

async function fetchReduceringHtml(game) {
  // Two patterns we'll try, both common on the site.
  const candidates = [
    `${REDUCERING_BASE}/${game}/aktuell-omgang/`,
    `${REDUCERING_BASE}/${game}/`,
    `${REDUCERING_BASE}/`
  ];
  for (const url of candidates) {
    try {
      const html = await fetchText(url, { ttlMs: 30 * 60 * 1000 });
      if (html && html.length > 500) return { url, html };
    } catch (e) {
      // try next
    }
  }
  return null;
}

function extractAnalyses(html, matches) {
  const $ = cheerio.load(html);
  // Reducering.se groups analyses in cards/rows that contain the home/away
  // team name and an analys paragraph. We use the team names from the
  // Svenska Spel draw to find the matching block by text proximity.

  const teamKey = m => `${m.home}|${m.away}`.toLowerCase();
  const byKey = new Map(matches.map(m => [teamKey(m), m]));

  // Try common containers; the site has changed several times so we cast a wide net.
  const blocks = $('article, section.match, .match-row, .match, .analys, .match-card').toArray();
  let attached = 0;

  for (const el of blocks) {
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (!txt || txt.length < 40) continue;
    for (const [key, m] of byKey) {
      const h = m.home.toLowerCase();
      const a = m.away.toLowerCase();
      if (!h || !a) continue;
      if (txt.toLowerCase().includes(h) && txt.toLowerCase().includes(a)) {
        if (!m.analys) {
          m.analys = txt.slice(0, 1200);
          attached++;
        }
        // Look for a "Tips: 1X" or "Förslag: X2" pattern within the block.
        const tip = txt.match(/(?:tips|förslag|garder(?:ing)?|rad)\s*[:\-]\s*([12X]{1,3})/i);
        if (tip) m.reduceringsTip = tip[1].toUpperCase();
        break;
      }
    }
  }
  return attached;
}

// ---------- Public API -------------------------------------------------------

async function scrapeCurrentRound(game = 'stryktipset') {
  if (!['stryktipset', 'europatipset', 'topptipset'].includes(game)) {
    throw new Error(`Unsupported game: ${game}`);
  }

  const draw = await fetchSvSDraw(game);
  const events = draw.drawEvents || draw.events || draw.matches || [];
  if (!events.length) throw new Error('Svenska Spel draw had no events');

  const matches = events.map(normalizeSvSMatch);

  // Best-effort analysis attachment
  let attached = 0;
  try {
    const reducering = await fetchReduceringHtml(game);
    if (reducering) attached = extractAnalyses(reducering.html, matches);
    else console.warn('[scrape] Could not fetch reducering.se — analyses will be empty');
  } catch (e) {
    console.warn(`[scrape] reducering.se attach failed: ${e.message}`);
  }

  return {
    game,
    roundNo: draw.drawNumber || draw.number || null,
    deadline: draw.regCloseTime || draw.closeTime || null,
    productName: draw.productName || draw.productId || game,
    fetchedAt: new Date().toISOString(),
    analysesAttached: attached,
    matches
  };
}

module.exports = { scrapeCurrentRound };
