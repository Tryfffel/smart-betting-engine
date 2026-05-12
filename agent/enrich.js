// Runs the shared Dixon-Coles model on each dossier and applies adjustments
// derived from injuries, form, congestion, and head-to-head.

const SBE = require('../engine/model');
const STR = require('../engine/strategies');
const { LEAGUE_AVG } = require('../engine/leagues');

const LIGA_AVG_FALLBACK = 2.6;

function enrichMatch(dossier) {
  const adjustments = [];
  const { match, lgKey, homeTeam, awayTeam, h2h } = dossier;

  const leagueKey = lgKey ? (require('../engine/leagues').LEAGUES[lgKey].key) : null;
  const ligaAvg = leagueKey ? (LEAGUE_AVG[leagueKey] || LIGA_AVG_FALLBACK) : LIGA_AVG_FALLBACK;

  let lH, lA, source;

  if (homeTeam?.stats && awayTeam?.stats) {
    // Real lambdas from team-specific home/away averages
    const base = SBE.computeLambdas(homeTeam.stats, awayTeam.stats, ligaAvg);
    lH = base.lH; lA = base.lA;
    source = 'api-football';

    // Form factor (uses last 5 results)
    const ffH = SBE.formFactor(homeTeam.stats.form);
    const ffA = SBE.formFactor(awayTeam.stats.form);
    if (Math.abs(ffH - 1) > 0.02 || Math.abs(ffA - 1) > 0.02) {
      adjustments.push(`Form: hemma ×${ffH.toFixed(2)}, borta ×${ffA.toFixed(2)}`);
    }
    lH *= ffH; lA *= ffA;

    // Injuries: each key injury knocks 0.06 off scoring output, capped at -0.3
    const homeInj = countKeyInjuries(homeTeam.injuries);
    const awayInj = countKeyInjuries(awayTeam.injuries);
    if (homeInj > 0) {
      const cut = Math.min(0.06 * homeInj, 0.30);
      lH = Math.max(0.3, lH - cut);
      adjustments.push(`Skador hemma: ${homeInj} nyckelspelare → −${cut.toFixed(2)} lH`);
    }
    if (awayInj > 0) {
      const cut = Math.min(0.06 * awayInj, 0.30);
      lA = Math.max(0.3, lA - cut);
      adjustments.push(`Skador borta: ${awayInj} nyckelspelare → −${cut.toFixed(2)} lA`);
    }

    // Congestion: extra matches in last 14 days cost a bit of output
    const hLast = homeTeam.fixtureCongestion?.last14d || 0;
    const aLast = awayTeam.fixtureCongestion?.last14d || 0;
    if (hLast >= 4) { lH = Math.max(0.3, lH - 0.07); adjustments.push(`Hemma trött (${hLast} på 14d)`); }
    if (aLast >= 4) { lA = Math.max(0.3, lA - 0.07); adjustments.push(`Borta trött (${aLast} på 14d)`); }
  } else {
    // Fallback: derive lambdas from streck %
    const cons = SBE.probsFromStreck(match.streck);
    if (!cons) {
      // No streck either — punt to uniform-ish prior
      lH = ligaAvg * 0.55; lA = ligaAvg * 0.45; source = 'uniform-prior';
    } else {
      const est = SBE.estimateLambdasFromMarket(cons, ligaAvg);
      lH = est.lH; lA = est.lA; source = 'streck-estimate';
    }
    adjustments.push(`Saknade lagdata — lambdor från ${source}`);
  }

  // Dixon-Coles probabilities
  let { pH, pX, pA } = SBE.DixonColes.probs(lH, lA);

  // Head-to-head tilt (max ±3 percentage points): if H2H is heavily skewed across
  // a meaningful sample, nudge toward the historic dominator.
  if (h2h && (h2h.homeWins + h2h.draws + h2h.awayWins) >= 6) {
    const settled = h2h.homeWins + h2h.draws + h2h.awayWins;
    const histH = h2h.homeWins / settled;
    const histA = h2h.awayWins / settled;
    const tilt = Math.max(-0.03, Math.min(0.03, (histH - histA) * 0.10));
    if (Math.abs(tilt) >= 0.01) {
      pH = clamp01(pH + tilt);
      pA = clamp01(pA - tilt);
      const ren = pH + pX + pA;
      pH /= ren; pX /= ren; pA /= ren;
      adjustments.push(`H2H-bias: ${tilt > 0 ? '+' : ''}${(tilt * 100).toFixed(1)}pp hemma (${h2h.homeWins}-${h2h.draws}-${h2h.awayWins})`);
    }
  }

  // Ensemble with Svenska Spel's bundled odds + bias-corrected streck.
  // Weights: model (Dixon-Coles or fallback) 50%, odds 35%, streck 15%.
  // When DC is unavailable, the ensemble leans harder on odds.
  const modelOnly = { pH, pX, pA };
  const ensembled = STR.ensemble(
    { ...match, model: modelOnly },
    source === 'api-football' ? { wModel: 0.55, wOdds: 0.30, wStreck: 0.15 }
                              : { wModel: 0.20, wOdds: 0.55, wStreck: 0.25 }
  );
  const oddsImpliedProbs = STR.oddsImplied(match);
  if (oddsImpliedProbs) adjustments.push(
    `Ensemble: DC ${pH.toFixed(2)}/${pX.toFixed(2)}/${pA.toFixed(2)} blend med odds ${oddsImpliedProbs.pH.toFixed(2)}/${oddsImpliedProbs.pX.toFixed(2)}/${oddsImpliedProbs.pA.toFixed(2)}`
  );

  const finalP = ensembled;

  // Edge versus the crowd (streck)
  const streckP = SBE.probsFromStreck(match.streck);
  const edge = streckP ? {
    '1': +(finalP.pH - streckP.pH).toFixed(3),
    'X': +(finalP.pX - streckP.pX).toFixed(3),
    '2': +(finalP.pA - streckP.pA).toFixed(3)
  } : null;

  // Pick the favored outcome
  const pickedOutcome =
    finalP.pH >= finalP.pX && finalP.pH >= finalP.pA ? '1' :
    finalP.pX >= finalP.pA                            ? 'X' : '2';

  return {
    ...dossier,
    model: {
      source,
      lH: +lH.toFixed(3),
      lA: +lA.toFixed(3),
      // Final blended probabilities (used for system building)
      pH: +finalP.pH.toFixed(4),
      pX: +finalP.pX.toFixed(4),
      pA: +finalP.pA.toFixed(4),
      // Raw Dixon-Coles output before ensembling
      dcOnly: { pH: +pH.toFixed(4), pX: +pX.toFixed(4), pA: +pA.toFixed(4) },
      oddsImplied: oddsImpliedProbs ? {
        pH: +oddsImpliedProbs.pH.toFixed(4),
        pX: +oddsImpliedProbs.pX.toFixed(4),
        pA: +oddsImpliedProbs.pA.toFixed(4)
      } : null,
      adjustments,
      streckP,
      edge,
      pickedOutcome
    }
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function countKeyInjuries(injuries) {
  if (!injuries?.length) return 0;
  // API-Football reports any unavailable player. We can't easily judge who is
  // a starter; treat the first ~3 reported as "key" since the response tends
  // to list more impactful injuries first.
  return Math.min(injuries.length, 5);
}

function enrichAll(round, dossiers) {
  const enrichedMatches = dossiers.map(enrichMatch);
  return {
    ...round,
    matches: enrichedMatches.map(d => ({
      idx: d.match.idx,
      home: d.match.home,
      away: d.match.away,
      league: d.match.league,
      kickoff: d.match.kickoff,
      streck: d.match.streck,
      analys: d.match.analys,
      reduceringsTip: d.match.reduceringsTip,
      sportsbookOdds: d.match.sportsbookOdds,
      lgKey: d.lgKey,
      lgName: d.lgName,
      fixtureId: d.fixtureId,
      homeTeam: d.homeTeam,
      awayTeam: d.awayTeam,
      h2h: d.h2h,
      predictions: d.predictions,
      completeness: d.completeness,
      flags: d.flags,
      model: d.model
    }))
  };
}

module.exports = { enrichMatch, enrichAll };
