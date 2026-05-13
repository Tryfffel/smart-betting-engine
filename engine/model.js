// Smart Betting Engine — shared math module.
// UMD: usable both as <script> in browser (sets window.SBE) and via require() in Node.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBE = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const P = {
    pmf(k, l) {
      let fact = 1;
      for (let i = 2; i <= k; i++) fact *= i;
      return Math.exp(-l) * Math.pow(l, k) / fact;
    },
    val(odds, prob) { return Math.round((odds * prob - 1) * 1000) / 10; },
    kelly(odds, prob) {
      const b = odds - 1, q = 1 - prob, f = (b * prob - q) / b;
      return Math.max(0, Math.round(f * 1000) / 10);
    }
  };

  const DixonColes = {
    rho: 0.13,
    tau(i, j, lH, lA, r) {
      if (i === 0 && j === 0) return 1 - lH * lA * r;
      if (i === 1 && j === 0) return 1 + lA * r;
      if (i === 0 && j === 1) return 1 + lH * r;
      if (i === 1 && j === 1) return 1 - r;
      return 1;
    },
    probs(lH, lA, max = 9) {
      let pH = 0, pX = 0, pA = 0;
      for (let h = 0; h <= max; h++)
        for (let a = 0; a <= max; a++) {
          const p = P.pmf(h, lH) * P.pmf(a, lA) * this.tau(h, a, lH, lA, this.rho);
          if (h > a) pH += p;
          else if (h === a) pX += p;
          else pA += p;
        }
      return { pH, pX, pA };
    }
  };

  function isPinnacle(name) { return String(name).toLowerCase().includes('pinnacle'); }
  function bkWeight(name) { return isPinnacle(name) ? 3 : 1; }

  function consensus(raw1x2) {
    const entries = Object.entries(raw1x2);
    if (!entries.length) return null;
    let sH = 0, sX = 0, sA = 0, totalW = 0;
    for (const [bkName, r] of entries) {
      const w = bkWeight(bkName);
      const p1 = 1 / r.home, pX = 1 / r.draw, p2 = 1 / r.away, t = p1 + pX + p2;
      sH += p1 / t * w; sX += pX / t * w; sA += p2 / t * w; totalW += w;
    }
    return { pH: sH / totalW, pX: sX / totalW, pA: sA / totalW };
  }

  function computeLambdas(homeStats, awayStats, ligaAvg) {
    const half = ligaAvg / 2;
    const homeAtk = ((homeStats?.homeAvgScored   ?? homeStats?.totalAvgScored   ?? half)) / half;
    const homeDef = ((homeStats?.homeAvgConceded ?? homeStats?.totalAvgConceded ?? half)) / half;
    const awayAtk = ((awayStats?.awayAvgScored   ?? awayStats?.totalAvgScored   ?? half)) / half;
    const awayDef = ((awayStats?.awayAvgConceded ?? awayStats?.totalAvgConceded ?? half)) / half;
    const lH = Math.max(0.3, homeAtk * awayDef * half);
    const lA = Math.max(0.3, awayAtk * homeDef * half);
    return { lH, lA };
  }

  function estimateLambdasFromMarket(cons, ligaAvg) {
    const lH = Math.max(0.3, (cons.pH + 0.42 * cons.pX) * ligaAvg * 0.88);
    const lA = Math.max(0.3, (cons.pA + 0.42 * cons.pX) * ligaAvg * 0.88);
    return { lH, lA };
  }

  function formFactor(formStr) {
    if (!formStr) return 1.0;
    const last5 = formStr.slice(-5);
    let pts = 0;
    for (const c of last5) pts += c === 'W' ? 3 : c === 'D' ? 1 : 0;
    return 0.9 + (pts / 15) * 0.2;
  }

  // Estimate probabilities from Stryktipset streck % (% of bettors on each outcome).
  // The crowd is sharp on average but biased toward favorites; we deflate the favorite
  // slightly and inflate the underdog to undo a small portion of the favorite-longshot bias.
  function probsFromStreck(streck) {
    if (!streck) return null;
    const s1 = Number(streck['1']) || 0;
    const sX = Number(streck['X']) || 0;
    const s2 = Number(streck['2']) || 0;
    const total = s1 + sX + s2;
    if (total <= 0) return null;
    let p1 = s1 / total, pX = sX / total, p2 = s2 / total;
    // Mild bias correction: shrink toward uniform by 5%.
    const k = 0.05;
    p1 = p1 * (1 - k) + (1 / 3) * k;
    pX = pX * (1 - k) + (1 / 3) * k;
    p2 = p2 * (1 - k) + (1 / 3) * k;
    return { pH: p1, pX, pA: p2 };
  }

  return {
    P, DixonColes,
    isPinnacle, bkWeight, consensus,
    computeLambdas, estimateLambdasFromMarket, formFactor,
    probsFromStreck
  };
}));
