// Builds a full per-match dossier: team form, home/away splits, injuries,
// recent results, head-to-head, fixture congestion, standings, and
// API-Football's own prediction. Powers the "nothing left to chance" view.
//
// Every endpoint is cached on disk by apifootball.js, so calling this
// repeatedly within the cache TTL is free.

const fs = require('fs');
const path = require('path');
const af = require('./apifootball');
const { LEAGUES, seasonFor, findLeagueByLabel } = require('../engine/leagues');

const ALIASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'team-aliases.json'), 'utf8'));

// ---------- Name resolution --------------------------------------------------

function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function aliasFor(name) {
  if (!name) return name;
  if (ALIASES[name]) return ALIASES[name];
  // Case-insensitive lookup
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(ALIASES)) {
    if (k === '_comment') continue;
    if (k.toLowerCase() === lower) return v;
  }
  return name;
}

async function resolveTeamId(rawName, apiLeagueId, season) {
  const candidates = [aliasFor(rawName), rawName, stripDiacritics(aliasFor(rawName))]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  for (const q of candidates) {
    const r = await af.get(`/teams?search=${encodeURIComponent(q)}&league=${apiLeagueId}&season=${season}`);
    const t = r?.response?.[0]?.team;
    if (t?.id) return { id: t.id, name: t.name, logo: t.logo, queryUsed: q };
  }
  // Last-ditch global search without league filter
  const r = await af.get(`/teams?search=${encodeURIComponent(candidates[0])}`);
  const t = r?.response?.[0]?.team;
  if (t?.id) return { id: t.id, name: t.name, logo: t.logo, queryUsed: candidates[0], unranked: true };
  return null;
}

// ---------- Per-team data fetchers ------------------------------------------

async function fetchTeamStatistics(teamId, leagueId, season) {
  const d = await af.get(`/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`);
  if (!d?.response) return null;
  const s = d.response;
  return {
    homeAvgScored:    parseFloat(s.goals?.for?.average?.home)    || null,
    homeAvgConceded:  parseFloat(s.goals?.against?.average?.home) || null,
    awayAvgScored:    parseFloat(s.goals?.for?.average?.away)    || null,
    awayAvgConceded:  parseFloat(s.goals?.against?.average?.away) || null,
    totalAvgScored:   parseFloat(s.goals?.for?.average?.total)   || null,
    totalAvgConceded: parseFloat(s.goals?.against?.average?.total) || null,
    cleanSheets:      s.clean_sheet?.total || 0,
    failedToScore:    s.failed_to_score?.total || 0,
    form:             s.form || '',
    nGames:           s.fixtures?.played?.total || 0,
    nHome:            s.fixtures?.played?.home  || 0,
    nAway:            s.fixtures?.played?.away  || 0,
    winsHome:         s.fixtures?.wins?.home   || 0,
    drawsHome:        s.fixtures?.draws?.home  || 0,
    lossesHome:       s.fixtures?.loses?.home  || 0,
    winsAway:         s.fixtures?.wins?.away   || 0,
    drawsAway:        s.fixtures?.draws?.away  || 0,
    lossesAway:       s.fixtures?.loses?.away  || 0,
    biggestStreakWins: s.biggest?.streak?.wins || 0,
    biggestStreakLoses: s.biggest?.streak?.loses || 0
  };
}

async function fetchInjuries(teamId, season) {
  const d = await af.get(`/injuries?team=${teamId}&season=${season}`);
  if (!d?.response) return [];
  return d.response.map(i => ({
    player:   i.player?.name,
    position: i.player?.position,
    type:     i.player?.type || i.player?.reason,
    expectedReturn: i.player?.reason
  })).filter(x => x.player);
}

async function fetchRecentFixtures(teamId, last = 10) {
  const d = await af.get(`/fixtures?team=${teamId}&last=${last}`);
  if (!d?.response) return [];
  return d.response.map(f => {
    const home = f.teams.home, away = f.teams.away;
    const isHome = home.id === teamId;
    const opp = isHome ? away : home;
    const my = isHome ? f.goals.home : f.goals.away;
    const their = isHome ? f.goals.away : f.goals.home;
    const result = my == null ? null : my > their ? 'W' : my < their ? 'L' : 'D';
    return {
      date: f.fixture?.date,
      league: f.league?.name,
      hOrA: isHome ? 'H' : 'A',
      opp: opp?.name,
      oppId: opp?.id,
      score: (my == null) ? null : `${my}-${their}`,
      result
    };
  });
}

async function fetchStandings(leagueId, season) {
  const d = await af.get(`/standings?league=${leagueId}&season=${season}`);
  const groups = d?.response?.[0]?.league?.standings;
  if (!groups?.length) return null;
  // Flatten — most leagues have a single table; some (Bundesliga, Eredivisie) split by group.
  const flat = groups.flat();
  const rank = {};
  for (const row of flat) rank[row.team.id] = { rank: row.rank, points: row.points, played: row.all?.played };
  return rank;
}

async function fetchUpcomingCount(teamId, fromDate, toDate) {
  const from = fromDate.toISOString().slice(0, 10);
  const to = toDate.toISOString().slice(0, 10);
  const d = await af.get(`/fixtures?team=${teamId}&from=${from}&to=${to}`);
  return d?.response?.length || 0;
}

// ---------- Per-match fetchers ----------------------------------------------

async function fetchH2H(homeId, awayId, last = 10) {
  const d = await af.get(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${last}`);
  if (!d?.response) return null;
  const fixtures = d.response.map(f => ({
    date: f.fixture?.date,
    league: f.league?.name,
    home: f.teams.home?.name,
    away: f.teams.away?.name,
    homeId: f.teams.home?.id,
    awayId: f.teams.away?.id,
    score: (f.goals.home == null) ? null : `${f.goals.home}-${f.goals.away}`,
    goalsHome: f.goals.home,
    goalsAway: f.goals.away
  }));
  let homeWins = 0, draws = 0, awayWins = 0, btts = 0, totalGoals = 0;
  for (const f of fixtures) {
    if (f.goalsHome == null) continue;
    const isHomeTeamAtHome = f.homeId === homeId;
    const myGoals    = isHomeTeamAtHome ? f.goalsHome : f.goalsAway;
    const theirGoals = isHomeTeamAtHome ? f.goalsAway : f.goalsHome;
    if (myGoals > theirGoals) homeWins++;
    else if (myGoals < theirGoals) awayWins++;
    else draws++;
    if (f.goalsHome > 0 && f.goalsAway > 0) btts++;
    totalGoals += f.goalsHome + f.goalsAway;
  }
  const settled = homeWins + draws + awayWins;
  return {
    last10: fixtures,
    homeWins, draws, awayWins,
    avgGoals: settled ? totalGoals / settled : null,
    bttsPct:  settled ? Math.round(btts / settled * 100) : null
  };
}

async function fetchPredictions(fixtureId) {
  const d = await af.get(`/predictions?fixture=${fixtureId}`);
  const r = d?.response?.[0];
  if (!r) return null;
  return {
    advice: r.predictions?.advice,
    percent: r.predictions?.percent,
    winner: r.predictions?.winner?.name,
    underOver: r.predictions?.under_over,
    goals: r.predictions?.goals
  };
}

// Look up the fixture id on API-Football for a given (home, away, date).
async function findFixtureId(homeId, awayId, kickoffISO, leagueId, season) {
  if (!homeId || !awayId || !kickoffISO) return null;
  const date = new Date(kickoffISO).toISOString().slice(0, 10);
  const d = await af.get(`/fixtures?date=${date}&league=${leagueId}&season=${season}`);
  const found = d?.response?.find(f =>
    f.teams.home?.id === homeId && f.teams.away?.id === awayId
  );
  return found?.fixture?.id || null;
}

// ---------- Flag heuristics --------------------------------------------------

function computeFlags(dossier) {
  const flags = { red: [], green: [] };
  const { homeTeam, awayTeam, h2h } = dossier;

  for (const side of ['homeTeam', 'awayTeam']) {
    const t = dossier[side];
    if (!t) continue;
    const tag = side === 'homeTeam' ? '(H)' : '(A)';

    if (t.injuries?.length >= 3) flags.red.push(`🚨 ${t.injuries.length} skadade ${tag} ${t.name}`);

    if (t.form && t.form.length >= 5) {
      const last5 = t.form.slice(-5);
      const wins = (last5.match(/W/g) || []).length;
      const losses = (last5.match(/L/g) || []).length;
      if (wins >= 4) flags.green.push(`🔥 ${wins}/5 vinster senast ${tag} ${t.name}`);
      if (losses >= 4) flags.red.push(`❄️ ${losses}/5 förluster senast ${tag} ${t.name}`);
      if (last5.split('').every(c => c !== 'W')) flags.red.push(`❄️ 5 raka utan vinst ${tag} ${t.name}`);
    }

    if (t.fixtureCongestion?.next14d >= 4) flags.red.push(`⚡ ${t.fixtureCongestion.next14d} matcher kommande 14d ${tag} ${t.name}`);
    if (t.fixtureCongestion?.last14d >= 4) flags.red.push(`😮‍💨 ${t.fixtureCongestion.last14d} matcher senaste 14d ${tag} ${t.name}`);

    if (t.standings?.rank != null) {
      if (t.standings.rank <= 3) flags.green.push(`🏆 Topp-3 i ligan ${tag} ${t.name}`);
      else if (t.standings.rank >= 15) flags.red.push(`⬇️ Bottenstrid (#${t.standings.rank}) ${tag} ${t.name}`);
    }

    if (side === 'homeTeam' && t.homeAwaySplit?.homePPG >= 2.2)
      flags.green.push(`🏠 Stark hemma (${t.homeAwaySplit.homePPG.toFixed(2)} PPG)`);
    if (side === 'awayTeam' && t.homeAwaySplit?.awayPPG >= 1.8)
      flags.green.push(`✈️ Stark borta (${t.homeAwaySplit.awayPPG.toFixed(2)} PPG)`);
  }

  if (h2h && (homeTeam || awayTeam)) {
    const settled = h2h.homeWins + h2h.draws + h2h.awayWins;
    if (settled >= 6) {
      if (h2h.homeWins / settled >= 0.7)
        flags.green.push(`🐺 Dominerar inbördes möten (${h2h.homeWins}/${settled})`);
      else if (h2h.awayWins / settled >= 0.7)
        flags.red.push(`🐺 Bortalaget dominerar inbördes (${h2h.awayWins}/${settled})`);
    }
  }

  return flags;
}

// ---------- Main entry -------------------------------------------------------

async function buildDossier(match, opts = {}) {
  const log = opts.log || (() => {});
  const lgKey = findLeagueByLabel(match.league);
  if (!lgKey) {
    log(`  ⚠️ liga okänd ("${match.league}") — fortsätter utan API-Football-data`);
    return { lgKey: null, match, homeTeam: null, awayTeam: null, h2h: null, predictions: null, flags: { red: [], green: [] } };
  }
  const lg = LEAGUES[lgKey];
  const season = seasonFor(lgKey);

  // 1. resolve team ids
  const home = await resolveTeamId(match.home, lg.apiId, season);
  const away = await resolveTeamId(match.away, lg.apiId, season);
  if (!home) log(`  ⚠️ kunde inte hitta hemmalag "${match.home}"`);
  if (!away) log(`  ⚠️ kunde inte hitta bortalag "${match.away}"`);

  // 2. shared per-league data (standings)
  const standings = await fetchStandings(lg.apiId, season);

  // 3. per-team data
  async function teamDossier(t) {
    if (!t) return null;
    const [stats, injuries, recent] = await Promise.all([
      fetchTeamStatistics(t.id, lg.apiId, season),
      fetchInjuries(t.id, season),
      fetchRecentFixtures(t.id, 10)
    ]);
    const now = new Date();
    const next14d = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    const last14d = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
    const [nextCount, lastCount] = await Promise.all([
      fetchUpcomingCount(t.id, now, next14d),
      fetchUpcomingCount(t.id, last14d, now)
    ]);
    // Enrich recent results with opponent league rank
    const recentWithRank = recent.map(r => ({
      ...r,
      oppRank: r.oppId && standings?.[r.oppId]?.rank || null
    }));
    const homeAwaySplit = stats ? {
      homePPG: stats.nHome ? ((stats.winsHome * 3 + stats.drawsHome) / stats.nHome) : null,
      awayPPG: stats.nAway ? ((stats.winsAway * 3 + stats.drawsAway) / stats.nAway) : null
    } : null;
    return {
      id: t.id, name: t.name, logo: t.logo, queryUsed: t.queryUsed,
      stats, injuries, recentResults: recentWithRank,
      form: stats?.form || '',
      standings: standings?.[t.id] || null,
      homeAwaySplit,
      fixtureCongestion: { next14d: Math.max(0, nextCount - 1), last14d: lastCount }
    };
  }

  const [homeTeam, awayTeam] = await Promise.all([teamDossier(home), teamDossier(away)]);

  // 4. H2H + API-Football predictions
  let h2h = null, predictions = null, fixtureId = null;
  if (home && away) {
    h2h = await fetchH2H(home.id, away.id, 10);
    fixtureId = await findFixtureId(home.id, away.id, match.kickoff, lg.apiId, season);
    if (fixtureId) predictions = await fetchPredictions(fixtureId);
  }

  const dossier = {
    lgKey,
    lgName: lg.name,
    apiLeagueId: lg.apiId,
    season,
    match,
    fixtureId,
    homeTeam,
    awayTeam,
    h2h,
    predictions,
    completeness: completenessScore(homeTeam, awayTeam, h2h)
  };
  dossier.flags = computeFlags(dossier);
  return dossier;
}

function completenessScore(home, away, h2h) {
  let score = 0, max = 0;
  for (const t of [home, away]) {
    max += 4;
    if (t?.stats) score++;
    if (t?.injuries) score++;          // empty array still counts (we successfully queried)
    if (t?.recentResults?.length) score++;
    if (t?.standings) score++;
  }
  max += 1; if (h2h) score++;
  return { score, max, pct: Math.round(score / max * 100) };
}

async function buildDossiers(round, opts = {}) {
  const out = [];
  const apiStartCalls = af.statsSnapshot().calls;
  for (let i = 0; i < round.matches.length; i++) {
    const m = round.matches[i];
    const before = af.statsSnapshot().calls;
    opts.log?.(`[${i + 1}/${round.matches.length}] ${m.home} vs ${m.away} (${m.league})`);
    const d = await buildDossier(m, { log: opts.log });
    const calls = af.statsSnapshot().calls - before;
    opts.log?.(`  → dossier ${d.completeness?.pct ?? 0}% komplett (${calls} API-anrop)`);
    out.push(d);
  }
  const totalCalls = af.statsSnapshot().calls - apiStartCalls;
  return { dossiers: out, apiCallsUsed: totalCalls };
}

module.exports = { buildDossier, buildDossiers, aliasFor };
