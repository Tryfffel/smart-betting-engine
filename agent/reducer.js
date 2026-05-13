// Builds a reduction system from enriched matches.
//
// Two modes:
//   buildByTargetRows(matches, maxRows)       — greedy under a row budget
//   buildByManualMix(matches, { hel, halv })  — user picks how many garderings
//
// Every match starts as a single pick (1 row total). An upgrade is either:
//   halv → cover the 2 most-likely outcomes (×2 rows, gain P(2nd))
//   hel  → cover all 3 outcomes              (×3 rows, gain P(2nd)+P(3rd))
//
// The greedy choice maximizes "probability gained per extra row".

function sortedOutcomes(model) {
  return [
    { o: '1', p: model.pH },
    { o: 'X', p: model.pX },
    { o: '2', p: model.pA }
  ].sort((a, b) => b.p - a.p);
}

function startingPicks(matches) {
  return matches.map(m => {
    const sorted = sortedOutcomes(m.model);
    return {
      idx: m.idx,
      home: m.home,
      away: m.away,
      league: m.lgName || m.league,
      sorted,                              // [{o:'1',p:0.45}, {o:'X',p:0.28}, ...]
      outcomes: [sorted[0].o],             // current pick(s)
      level: 'enkel',                      // enkel | halv | hel
      coveredP: sorted[0].p,               // model P that current pick set contains the correct outcome
      reasonNotes: []
    };
  });
}

function totalRows(picks) {
  return picks.reduce((acc, p) => acc * p.outcomes.length, 1);
}

function expectedP13(picks) {
  // Probability that *every* match's covered set contains the true result.
  return picks.reduce((acc, p) => acc * p.coveredP, 1);
}

function upgradeBenefit(pick, toLevel) {
  if (toLevel === 'halv' && pick.level === 'enkel') {
    return { newCoveredP: pick.sorted[0].p + pick.sorted[1].p, factor: 2 };
  }
  if (toLevel === 'hel' && pick.level === 'enkel') {
    return { newCoveredP: 1.0, factor: 3 };
  }
  if (toLevel === 'hel' && pick.level === 'halv') {
    return { newCoveredP: 1.0, factor: 1.5 };
  }
  return null;
}

function applyUpgrade(pick, toLevel) {
  const reason = reasonForUpgrade(pick);
  if (toLevel === 'halv') {
    pick.outcomes = [pick.sorted[0].o, pick.sorted[1].o];
    pick.coveredP = pick.sorted[0].p + pick.sorted[1].p;
    pick.level = 'halv';
  } else if (toLevel === 'hel') {
    pick.outcomes = ['1', 'X', '2'];
    pick.coveredP = 1.0;
    pick.level = 'hel';
  }
  pick.reasonNotes.push(reason);
}

function reasonForUpgrade(pick) {
  const top = pick.sorted[0].p, second = pick.sorted[1].p;
  if (top - second < 0.10) return `Jämn match (topp ${(top*100).toFixed(0)}% vs 2:a ${(second*100).toFixed(0)}%)`;
  if (top < 0.50)            return `Inget tydligt favoritutfall (topp ${(top*100).toFixed(0)}%)`;
  return `Försäkring (täcker 2:a-utfallet ${(second*100).toFixed(0)}%)`;
}

// ---------- Target-rows mode (greedy) ---------------------------------------

function buildByTargetRows(matches, maxRows) {
  const picks = startingPicks(matches);
  if (totalRows(picks) > maxRows) {
    throw new Error('maxRows must be at least 1');
  }
  // Each iteration picks the upgrade with the best benefit/cost ratio that
  // still fits inside maxRows.
  while (true) {
    let best = null;
    const currentRows = totalRows(picks);
    for (const p of picks) {
      for (const lvl of ['halv', 'hel']) {
        const ub = upgradeBenefit(p, lvl);
        if (!ub) continue;
        const newRows = Math.round(currentRows * ub.factor);
        if (newRows > maxRows) continue;
        const probGain = ub.newCoveredP - p.coveredP;
        if (probGain <= 0) continue;
        const score = probGain / (newRows - currentRows);
        if (!best || score > best.score) best = { p, lvl, score, newRows };
      }
    }
    if (!best) break;
    applyUpgrade(best.p, best.lvl);
  }
  return finalizeSystem(picks, 'target-rows', { maxRows });
}

// ---------- Manual-mix mode --------------------------------------------------

function buildByManualMix(matches, { hel = 0, halv = 0 } = {}) {
  const picks = startingPicks(matches);
  // Sort by how close the top outcome is to 33% — those are the matches where
  // garderings buy the most insurance per row.
  const orderedIdx = [...picks.keys()].sort((aIdx, bIdx) => {
    const a = picks[aIdx].sorted[0].p, b = picks[bIdx].sorted[0].p;
    return a - b; // ascending: hardest matches first
  });
  let helLeft = hel, halvLeft = halv;
  for (const i of orderedIdx) {
    if (helLeft > 0) { applyUpgrade(picks[i], 'hel'); helLeft--; continue; }
    if (halvLeft > 0) { applyUpgrade(picks[i], 'halv'); halvLeft--; continue; }
    if (helLeft <= 0 && halvLeft <= 0) break;
  }
  return finalizeSystem(picks, 'manual-mix', { hel, halv });
}

// ---------- Finalization -----------------------------------------------------

function finalizeSystem(picks, mode, params) {
  const rows = totalRows(picks);
  const p13 = expectedP13(picks);
  // Counts
  const counts = { enkel: 0, halv: 0, hel: 0 };
  for (const p of picks) counts[p.level]++;

  return {
    mode,
    params,
    totalRows: rows,
    cost1kr: rows,             // 1 kr per row on Stryktipset
    cost2kr: rows * 2,         // 2 kr per row on Europatipset
    expectedP13: +p13.toFixed(6),
    counts,
    picks: picks.map(p => ({
      idx: p.idx, home: p.home, away: p.away, league: p.league,
      level: p.level,
      outcomes: p.outcomes,
      coveredP: +p.coveredP.toFixed(4),
      modelProbs: { '1': +p.sorted.find(s => s.o === '1').p.toFixed(4),
                    'X': +p.sorted.find(s => s.o === 'X').p.toFixed(4),
                    '2': +p.sorted.find(s => s.o === '2').p.toFixed(4) },
      reasonNotes: p.reasonNotes
    }))
  };
}

module.exports = { buildByTargetRows, buildByManualMix, totalRows, expectedP13 };
