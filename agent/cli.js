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
const { runBacktest } = require('./backtest');
const af = require('./apifootball');

const OUT = path.join(__dirname, 'output');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const ROUND_FILE    = path.join(OUT, 'round.json');
const DOSSIER_FILE  = path.join(OUT, 'round-dossier.json');
const ENRICHED_FILE = path.join(OUT, 'round-enriched.json');
const SYSTEM_FILE   = path.join(OUT, 'system.json');
const BACKTEST_FILE = path.join(OUT, 'backtest.json');

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

async function cmdBacktest(args) {
  const game = args.game || 'stryktipset';
  const count = parseInt(args.count || '20', 10);
  log(`→ Backtestar ${count} omgångar av ${game}…`);
  const result = await runBacktest({ game, count, log });
  log(`\n  Resultat (sorterat efter log-loss, lägre = bättre):`);
  log(`  ${'Strategi'.padEnd(22)} ${'matcher'.padStart(7)}  ${'brier'.padStart(7)}  ${'logloss'.padStart(8)}  ${'träff%'.padStart(7)}`);
  for (const r of result.results) {
    log(`  ${r.strategy.padEnd(22)} ${String(r.matches).padStart(7)}  ${String(r.brier).padStart(7)}  ${String(r.logLoss).padStart(8)}  ${(r.hitRate*100).toFixed(1).padStart(6)}%`);
  }
  writeJson(BACKTEST_FILE, result);
  return result;
}

async function cmdDemo(args) {
  log('→ Genererar demo-data (ingen extern API behövs)…');
  const round = {
    game: 'stryktipset', roundNo: 9999, deadline: '2026-05-17T15:59:00+02:00',
    productName: 'Stryktipset (DEMO)', fetchedAt: new Date().toISOString(),
    isDemo: true, analysesAttached: 6,
    matches: [
      { idx:1, home:'AIK', away:'Djurgården', league:'Allsvenskan', kickoff:'2026-05-17T16:00:00+02:00', streck:{'1':35,'X':30,'2':35}, sportsbookOdds:{'1':2.5,'X':3.2,'2':2.7}, analys:'Stockholm-derbyt — alltid en mardröm att tippa. Båda lagen har vunnit två av senaste fyra inbördes mötena. AIK saknar två backar pga skador.', reduceringsTip:'1X' },
      { idx:2, home:'IFK Göteborg', away:'Malmö FF', league:'Allsvenskan', kickoff:'2026-05-17T18:00:00+02:00', streck:{'1':40,'X':25,'2':35}, sportsbookOdds:{'1':2.3,'X':3.4,'2':2.9}, analys:'Klassiker. Malmö har vunnit fyra av senaste fem inbördes på Gamla Ullevi.', reduceringsTip:'X2' },
      { idx:3, home:'Hammarby', away:'BK Häcken', league:'Allsvenskan', kickoff:'2026-05-17T16:00:00+02:00', streck:{'1':50,'X':25,'2':25}, sportsbookOdds:{'1':1.9,'X':3.5,'2':3.8}, analys:'Hammarby starka hemma — 2.4 PPG. Häcken inkonsekventa på resa.', reduceringsTip:'1' },
      { idx:4, home:'Elfsborg', away:'Mjällby', league:'Allsvenskan', kickoff:'2026-05-17T16:00:00+02:00', streck:{'1':60,'X':22,'2':18}, sportsbookOdds:{'1':1.6,'X':3.8,'2':5.0}, analys:'', reduceringsTip:'' },
      { idx:5, home:'Manchester United', away:'Liverpool', league:'Premier League', kickoff:'2026-05-17T17:30:00+02:00', streck:{'1':28,'X':28,'2':44}, sportsbookOdds:{'1':3.4,'X':3.5,'2':2.0}, analys:'Liverpool i grymform — 5 raka vinster. United har två mittfältare avstängda.', reduceringsTip:'2' },
      { idx:6, home:'Arsenal', away:'Tottenham', league:'Premier League', kickoff:'2026-05-17T13:30:00+02:00', streck:{'1':52,'X':25,'2':23}, sportsbookOdds:{'1':1.85,'X':3.6,'2':4.0}, analys:'North London-derby. Arsenal favoriter men Spurs har slagit dem två gånger på rad.', reduceringsTip:'1X' },
      { idx:7, home:'Bayern München', away:'Dortmund', league:'Bundesliga', kickoff:'2026-05-17T18:30:00+02:00', streck:{'1':55,'X':22,'2':23}, sportsbookOdds:{'1':1.75,'X':3.9,'2':4.2}, analys:'Der Klassiker. Bayern dominerar hemma — 9 raka vinster på Allianz mot BVB.', reduceringsTip:'1' },
      { idx:8, home:'Real Madrid', away:'Barcelona', league:'La Liga', kickoff:'2026-05-17T21:00:00+02:00', streck:{'1':45,'X':25,'2':30}, sportsbookOdds:{'1':2.1,'X':3.5,'2':3.2}, analys:'El Clásico. Båda har Champions League nästa vecka — risk för rotation.', reduceringsTip:'X' },
      { idx:9, home:'PSG', away:'Marseille', league:'Ligue 1', kickoff:'2026-05-17T21:00:00+02:00', streck:{'1':70,'X':18,'2':12}, sportsbookOdds:{'1':1.4,'X':4.5,'2':7.0}, analys:'Le Classique. PSG storfavoriter men Marseille brukar leverera överraskningar.', reduceringsTip:'' },
      { idx:10, home:'Juventus', away:'Inter', league:'Serie A', kickoff:'2026-05-17T20:45:00+02:00', streck:{'1':30,'X':35,'2':35}, sportsbookOdds:{'1':3.0,'X':3.0,'2':2.5}, analys:'Derby d\'Italia — historiskt målsnålt. 0-0 och 1-1 vanligaste resultaten.', reduceringsTip:'X2' },
      { idx:11, home:'Norwich', away:'Leeds', league:'Championship', kickoff:'2026-05-17T16:00:00+02:00', streck:{'1':38,'X':30,'2':32}, sportsbookOdds:{'1':2.5,'X':3.2,'2':2.7}, analys:'', reduceringsTip:'' },
      { idx:12, home:'Ajax', away:'PSV', league:'Eredivisie', kickoff:'2026-05-17T14:30:00+02:00', streck:{'1':42,'X':27,'2':31}, sportsbookOdds:{'1':2.2,'X':3.4,'2':2.9}, analys:'De Klassieker. PSV med 8 raka vinster i ligan.', reduceringsTip:'2' },
      { idx:13, home:'Köpenhamn', away:'Midtjylland', league:'Superliga', kickoff:'2026-05-17T16:00:00+02:00', streck:{'1':48,'X':27,'2':25}, sportsbookOdds:{'1':2.0,'X':3.3,'2':3.5}, analys:'Köpenhamn vann förra mötet 3-1.', reduceringsTip:'1' }
    ]
  };

  // Build empty dossiers + run enrich on them
  const dossiers = round.matches.map(m => ({
    lgKey: null, lgName: m.league, apiLeagueId: null, season: null,
    match: m, fixtureId: null,
    homeTeam: null, awayTeam: null, h2h: null, predictions: null,
    completeness: { score: 0, max: 9, pct: 0 },
    flags: { red: [], green: [] }
  }));

  writeJson(ROUND_FILE, round);
  writeJson(DOSSIER_FILE, { ...round, apiCallsUsed: 0, dossiers });

  const { enrichAll } = require('./enrich');
  const enriched = enrichAll(round, dossiers);
  writeJson(ENRICHED_FILE, enriched);

  const rows = parseInt(args.rows || '100', 10);
  const system = buildByTargetRows(enriched.matches, rows);
  system.roundNo = round.roundNo;
  system.game = round.game;
  system.builtAt = new Date().toISOString();
  writeJson(SYSTEM_FILE, system);

  log(`\nDemo klar. Öppna index.html i browsern och klicka 🎟️ Reducering.`);
  log(`Filerna i output/ är märkta isDemo:true så du vet att det inte är riktiga data.`);
}

function cmdDoctor() {
  const checks = [];
  const ok    = (name, msg) => { checks.push({ name, status: '✅', msg }); };
  const warn  = (name, msg) => { checks.push({ name, status: '⚠️', msg }); };
  const fail  = (name, msg) => { checks.push({ name, status: '❌', msg }); };

  // 1. Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  (major >= 18 ? ok : fail)('Node-version', `${process.version} (kräver >= 18)`);

  // 2. cheerio
  try { require('cheerio'); ok('cheerio', 'installerad'); }
  catch (e) { fail('cheerio', 'saknas — kör `npm install`'); }

  // 3. .env / API_FOOTBALL_KEY
  if (af.hasKey()) ok('API_FOOTBALL_KEY', 'finns');
  else warn('API_FOOTBALL_KEY', 'saknas — dossier blir tom, modellen faller tillbaka till streck-estimate');

  // 4. output dir writable
  try {
    const probe = path.join(OUT, '.write-test');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok('output/', 'skrivbar');
  } catch (e) {
    fail('output/', `kan ej skriva: ${e.message}`);
  }

  // 5. Reachability: Svenska Spel + API-Football
  async function probe(url, label) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) ok(label, `HTTP ${r.status}`);
      else if (r.status === 403) fail(label, `HTTP 403 — geo-blockerad eller blockerad av sandbox`);
      else warn(label, `HTTP ${r.status}`);
    } catch (e) {
      fail(label, `kan ej nå: ${e.message}`);
    }
  }

  return Promise.all([
    probe('https://api.spela.svenskaspel.se/draw/stryktipset/draws', 'Svenska Spel API'),
    probe('https://v3.football.api-sports.io/status', 'API-Football')
  ]).then(() => {
    log('\n🩺 Doctor — diagnos:');
    for (const c of checks) log(`  ${c.status} ${c.name.padEnd(22)} ${c.msg}`);
    const failed = checks.filter(c => c.status === '❌').length;
    if (failed) log(`\n${failed} problem hittade. Fixa dessa innan du kör pipelinen.`);
    else log('\nAllt klart. Kör `node cli.js all --rows 100`.');
  });
}

// ---------- main -------------------------------------------------------------

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  if (!cmd) {
    console.log('Usage: node cli.js <scrape|dossier|enrich|build|all|backtest|demo|doctor> [args]');
    console.log('');
    console.log('  demo     — generera syntetisk data utan externa API (för att se UI:t');
    console.log('             fungera när scrape/API-Football inte är åtkomliga)');
    console.log('  doctor   — diagnos: Node-version, deps, miljö, nätverk');
    process.exit(1);
  }
  try {
    if (cmd === 'scrape')        await cmdScrape(args);
    else if (cmd === 'dossier')  await cmdDossier();
    else if (cmd === 'enrich')   await cmdEnrich();
    else if (cmd === 'build')    cmdBuild(args);
    else if (cmd === 'all')      await cmdAll(args);
    else if (cmd === 'backtest') await cmdBacktest(args);
    else if (cmd === 'demo')     await cmdDemo(args);
    else if (cmd === 'doctor')   await cmdDoctor();
    else { console.error(`Unknown command: ${cmd}`); process.exit(1); }
  } catch (e) {
    console.error('✖ ' + e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
