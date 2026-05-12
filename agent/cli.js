#!/usr/bin/env node
// Single CLI entrypoint for the reducering agent.
//
//   node cli.js scrape   [--game stryktipset|europatipset|topptipset]
//   node cli.js dossier
//   node cli.js enrich
//   node cli.js build    --rows <N>   |   --hel <N> --halv <N>
//   node cli.js all      [build args]

const fs = require('fs');
const path = require('path');

const { scrapeCurrentRound } = require('./scrape');
const { buildDossiers } = require('./dossier');
const { enrichAll } = require('./enrich');
const { buildByTargetRows, buildByManualMix } = require('./reducer');
const af = require('./apifootball');

const OUT = path.join(__dirname, 'output');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const ROUND_FILE    = path.join(OUT, 'round.json');
const DOSSIER_FILE  = path.join(OUT, 'round-dossier.json');
const ENRICHED_FILE = path.join(OUT, 'round-enriched.json');
const SYSTEM_FILE   = path.join(OUT, 'system.json');

// ---------- arg parsing ------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(process.cwd(), file)} — run the previous step first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`✔ wrote ${path.relative(process.cwd(), file)}`);
}

const log = (msg) => console.log(msg);

// ---------- commands ---------------------------------------------------------

async function cmdScrape(args) {
  const game = args.game || 'stryktipset';
  log(`→ Scraping ${game}…`);
  const round = await scrapeCurrentRound(game);
  log(`  ${round.matches.length} matcher hittade, omg ${round.roundNo}, deadline ${round.deadline}`);
  log(`  Analyser kopplade till ${round.analysesAttached}/${round.matches.length} matcher`);
  writeJson(ROUND_FILE, round);
  return round;
}

async function cmdDossier() {
  const round = readJson(ROUND_FILE);
  if (!af.hasKey()) {
    console.warn('⚠ Ingen API_FOOTBALL_KEY satt — dossierna blir tomma. Lägg in nyckel i agent/.env');
  }
  log(`→ Bygger dossier för ${round.matches.length} matcher…`);
  const { dossiers, apiCallsUsed } = await buildDossiers(round, { log });
  log(`  Totalt ${apiCallsUsed} API-anrop (cache-hits räknas inte)`);
  writeJson(DOSSIER_FILE, { ...round, apiCallsUsed, dossiers });
  return { round, dossiers, apiCallsUsed };
}

async function cmdEnrich() {
  const file = readJson(DOSSIER_FILE);
  log(`→ Kör Dixon-Coles + justeringar på ${file.dossiers.length} matcher…`);
  const enriched = enrichAll(file, file.dossiers);
  for (const m of enriched.matches) {
    const pp = (n) => (n * 100).toFixed(0);
    log(`  [${m.idx}/${enriched.matches.length}] ${m.home}–${m.away}: ` +
        `pH=${pp(m.model.pH)}% pX=${pp(m.model.pX)}% pA=${pp(m.model.pA)}% ` +
        `(källa: ${m.model.source}) tips=${m.model.pickedOutcome}` +
        (m.model.adjustments.length ? ` · ${m.model.adjustments.length} just.` : ''));
  }
  writeJson(ENRICHED_FILE, enriched);
  return enriched;
}

function cmdBuild(args) {
  const enriched = readJson(ENRICHED_FILE);
  const matches = enriched.matches;
  let system;
  if (args.rows) {
    const rows = parseInt(args.rows, 10);
    log(`→ Bygger system med max ${rows} rader…`);
    system = buildByTargetRows(matches, rows);
  } else if (args.hel != null || args.halv != null) {
    const hel  = parseInt(args.hel  || '0', 10);
    const halv = parseInt(args.halv || '0', 10);
    log(`→ Bygger system med ${hel} hel + ${halv} halv…`);
    system = buildByManualMix(matches, { hel, halv });
  } else {
    throw new Error('Ange antingen --rows <N> eller --hel <N> --halv <N>');
  }
  system.roundNo = enriched.roundNo;
  system.game    = enriched.game;
  system.builtAt = new Date().toISOString();
  log(`  ${system.totalRows} rader · P(13 rätt) ≈ ${(system.expectedP13*100).toFixed(3)}% · ${system.counts.hel} hel / ${system.counts.halv} halv / ${system.counts.enkel} enkel`);
  for (const p of system.picks) {
    const tag = p.level === 'hel' ? '🟧 HEL' : p.level === 'halv' ? '🟨 HALV' : '⬜ enkel';
    log(`    ${tag} #${p.idx} ${p.home}–${p.away}: ${p.outcomes.join('')}  (${(p.coveredP*100).toFixed(0)}% täckt)${p.reasonNotes[0] ? ' — ' + p.reasonNotes[0] : ''}`);
  }
  writeJson(SYSTEM_FILE, system);
  return system;
}

async function cmdAll(args) {
  await cmdScrape(args);
  await cmdDossier();
  await cmdEnrich();
  cmdBuild(args);
  const apiStats = af.statsSnapshot();
  log(`\nDone. API-Football: ${apiStats.calls} live anrop, ${apiStats.cacheHits} cache-hits.`);
}

// ---------- main -------------------------------------------------------------

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  if (!cmd) {
    console.log('Usage: node cli.js <scrape|dossier|enrich|build|all> [args]');
    process.exit(1);
  }
  try {
    if (cmd === 'scrape')  await cmdScrape(args);
    else if (cmd === 'dossier') await cmdDossier();
    else if (cmd === 'enrich')  await cmdEnrich();
    else if (cmd === 'build')   cmdBuild(args);
    else if (cmd === 'all')     await cmdAll(args);
    else { console.error(`Unknown command: ${cmd}`); process.exit(1); }
  } catch (e) {
    console.error('✖ ' + e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
