// Prediction strategies for Stryktipset/Europatipset matches.
//
// Each strategy is a pure function: (match) → { pH, pX, pA } where the
// three probabilities sum to 1. Matches must contain `streck: {1, X, 2}`
// and may contain `sportsbookOdds: {1, X, 2}` (decimal).
//
// The strategies are evaluated against actual outcomes in agent/backtest.js
// so we can answer the "are we actually better than just following streck?"
// question with numbers instead of vibes.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model'));
  else root.SBE_STRATEGIES = factory(root.SBE);
}(typeof self !== 'undefined' ? self : this, function (SBE) {

  const UNIFORM = { pH: 1/3, pX: 1/3, pA: 1/3 };

  function normalize(p) {
    const t = p.pH + p.pX + p.pA;
    return t > 0 ? { pH: p.pH/t, pX: p.pX/t, pA: p.pA/t } : UNIFORM;
  }

  // ---------- Streck-based --------------------------------------------------

  // Always pick the streck leader with 100% conviction. Hopeless distribution
  // (puts 0 on two outcomes) but useful as the dumbest baseline.
  function streckLeader(m) {
    const s = m.streck || {};
    const arr = [['1', s['1']||0], ['X', s['X']||0], ['2', s['2']||0]];
    const max = Math.max(...arr.map(x => x[1]));
    return {
      pH: arr[0][1] === max ? 1 : 0,
      pX: arr[1][1] === max ? 1 : 0,
      pA: arr[2][1] === max ? 1 : 0
    };
  }

  // Use raw streck % as probabilities (no correction).
  function streckRaw(m) {
    return SBE.probsFromStreck(m.streck) || UNIFORM;
  }

  // Shrink streck toward uniform by k% to dampen favorite-longshot bias.
  // Bigger shrink for higher-confidence streck (the crowd is most biased
  // when it's most certain).
  function streckShrunk(m, k = 0.08) {
    const raw = SBE.probsFromStreck(m.streck);
    if (!raw) return UNIFORM;
    return {
      pH: raw.pH * (1 - k) + (1/3) * k,
      pX: raw.pX * (1 - k) + (1/3) * k,
      pA: raw.pA * (1 - k) + (1/3) * k
    };
  }

  // Pull the favorite down, push the underdog up. Crowd's favorite-longshot
  // bias is asymmetric: they OVER-pick favorites and UNDER-pick draws/dogs.
  function streckBiasCorrected(m) {
    const raw = SBE.probsFromStreck(m.streck);
    if (!raw) return UNIFORM;
    // Identify favorite vs underdog
    const arr = [['pH', raw.pH], ['pX', raw.pX], ['pA', raw.pA]].sort((a,b) => b[1]-a[1]);
    const fav = arr[0], mid = arr[1], und = arr[2];
    const adjusted = { pH: raw.pH, pX: raw.pX, pA: raw.pA };
    // Move 4% of probability from favorite to underdog, 2% to middle
    const cutFav = Math.min(0.06, fav[1] * 0.10);
    adjusted[fav[0]] -= cutFav;
    adjusted[mid[0]] += cutFav * 0.4;
    adjusted[und[0]] += cutFav * 0.6;
    return normalize(adjusted);
  }

  // ---------- Odds-based ----------------------------------------------------

  // Implied probabilities from bookmaker odds, margin-adjusted.
  function oddsImplied(m) {
    const o = m.sportsbookOdds || {};
    if (!o['1'] || !o.X || !o['2']) return null;
    const p1 = 1/o['1'], pX = 1/o.X, p2 = 1/o['2'];
    const t = p1 + pX + p2;
    return { pH: p1/t, pX: pX/t, pA: p2/t };
  }

  // Pick the odds favorite with 100% conviction.
  function oddsLeader(m) {
    const o = m.sportsbookOdds || {};
    const arr = [['1', o['1']||999], ['X', o.X||999], ['2', o['2']||999]];
    const min = Math.min(...arr.map(x => x[1]));
    return {
      pH: arr[0][1] === min ? 1 : 0,
      pX: arr[1][1] === min ? 1 : 0,
      pA: arr[2][1] === min ? 1 : 0
    };
  }

  // ---------- Blends --------------------------------------------------------

  // Blend bookmaker odds and streck. Bookmakers are sharp on most leagues;
  // streck adds Swedish-specific info (folkpsykologi for Allsvenskan etc).
  function oddsStreckBlend(m, oddsWeight = 0.7) {
    const odds = oddsImplied(m);
    const streck = streckBiasCorrected(m);
    if (!odds) return streck;
    return normalize({
      pH: odds.pH * oddsWeight + streck.pH * (1 - oddsWeight),
      pX: odds.pX * oddsWeight + streck.pX * (1 - oddsWeight),
      pA: odds.pA * oddsWeight + streck.pA * (1 - oddsWeight)
    });
  }

  // Three-way ensemble (model + odds + streck). Falls back gracefully when
  // any of the inputs are missing.
  function ensemble(m, { wModel = 0.5, wOdds = 0.35, wStreck = 0.15 } = {}) {
    const sources = [];
    if (m.model && Number.isFinite(m.model.pH)) {
      sources.push({ w: wModel, p: { pH: m.model.pH, pX: m.model.pX, pA: m.model.pA } });
    }
    const odds = oddsImplied(m);
    if (odds) sources.push({ w: wOdds, p: odds });
    const streck = streckBiasCorrected(m);
    if (streck) sources.push({ w: wStreck, p: streck });
    if (!sources.length) return UNIFORM;
    const totalW = sources.reduce((a, s) => a + s.w, 0);
    return normalize({
      pH: sources.reduce((a, s) => a + s.w * s.p.pH, 0) / totalW,
      pX: sources.reduce((a, s) => a + s.w * s.p.pX, 0) / totalW,
      pA: sources.reduce((a, s) => a + s.w * s.p.pA, 0) / totalW
    });
  }

  return {
    streckLeader, streckRaw, streckShrunk, streckBiasCorrected,
    oddsImplied, oddsLeader,
    oddsStreckBlend, ensemble,
    normalize, UNIFORM
  };
}));
