// League definitions shared between browser app and Node agent.
// Adds the most common Stryktipset/Europatipset leagues beyond the original 5.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBE_LEAGUES = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // apiId = API-Football league id.
  // scandinavian = calendar-year season (April–November) instead of European cross-year.
  const LEAGUES = {
    eredivisie:    { key: 'soccer_netherlands_eredivisie',  apiId: 88,  name: '🇳🇱 Eredivisie',     color: '#f97316', scandinavian: false },
    championship:  { key: 'soccer_england_championship',    apiId: 40,  name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Championship',  color: '#388bfd', scandinavian: false },
    allsvenskan:   { key: 'soccer_sweden_allsvenskan',      apiId: 113, name: '🇸🇪 Allsvenskan',    color: '#e3b341', scandinavian: true  },
    bundesliga:    { key: 'soccer_germany_bundesliga',      apiId: 78,  name: '🇩🇪 Bundesliga',     color: '#dd0000', scandinavian: false },
    superliga:     { key: 'soccer_denmark_superliga',       apiId: 119, name: '🇩🇰 Superliga',      color: '#c8102e', scandinavian: true  },
    premierleague: { key: 'soccer_epl',                     apiId: 39,  name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League', color: '#3d195b', scandinavian: false },
    seriea:        { key: 'soccer_italy_serie_a',           apiId: 135, name: '🇮🇹 Serie A',        color: '#0a5fb8', scandinavian: false },
    laliga:        { key: 'soccer_spain_la_liga',           apiId: 140, name: '🇪🇸 La Liga',        color: '#ee8707', scandinavian: false },
    ligue1:        { key: 'soccer_france_ligue_one',        apiId: 61,  name: '🇫🇷 Ligue 1',        color: '#091c3e', scandinavian: false },
    superettan:    { key: 'soccer_sweden_superettan',       apiId: 114, name: '🇸🇪 Superettan',     color: '#9ca3af', scandinavian: true  },
    eliteserien:   { key: 'soccer_norway_eliteserien',      apiId: 103, name: '🇳🇴 Eliteserien',    color: '#ef4444', scandinavian: true  },
    veikkausliiga: { key: 'soccer_finland_veikkausliiga',   apiId: 244, name: '🇫🇮 Veikkausliiga',  color: '#0033a0', scandinavian: true  },
    primeiraliga:  { key: 'soccer_portugal_primeira_liga',  apiId: 94,  name: '🇵🇹 Primeira Liga',  color: '#046a38', scandinavian: false },
    bundesliga2:   { key: 'soccer_germany_bundesliga2',     apiId: 79,  name: '🇩🇪 2. Bundesliga',  color: '#cd0a0a', scandinavian: false },
    leagueone:     { key: 'soccer_england_league_one',      apiId: 41,  name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 League One',     color: '#1f6feb', scandinavian: false }
  };

  const LEAGUE_AVG = {
    soccer_netherlands_eredivisie: 3.1,
    soccer_england_championship:   2.5,
    soccer_sweden_allsvenskan:     2.8,
    soccer_germany_bundesliga:     3.1,
    soccer_denmark_superliga:      2.8,
    soccer_epl:                    2.8,
    soccer_italy_serie_a:          2.7,
    soccer_spain_la_liga:          2.5,
    soccer_france_ligue_one:       2.7,
    soccer_sweden_superettan:      2.6,
    soccer_norway_eliteserien:     2.9,
    soccer_finland_veikkausliiga:  2.7,
    soccer_portugal_primeira_liga: 2.6,
    soccer_germany_bundesliga2:    2.9,
    soccer_england_league_one:     2.6
  };

  function seasonFor(lgId, now = new Date()) {
    const lg = LEAGUES[lgId];
    const yr = now.getFullYear();
    if (lg?.scandinavian) return yr;
    return now.getMonth() >= 7 ? yr : yr - 1;
  }

  // Map a free-text Swedish/English league label (from reducering.se) to one of our LEAGUE keys.
  // Falls back to null when unknown — caller can still proceed with streck-only fallback.
  function findLeagueByLabel(label) {
    if (!label) return null;
    const n = String(label).toLowerCase().replace(/[^a-zåäö0-9]/g, '');
    const map = [
      ['eredivisie', /eredivisie|holland|nederl/],
      ['championship', /championship|engelska2|engtwo/],
      ['allsvenskan', /allsvensk/],
      ['bundesliga2', /2bundesliga|bundesliga2|zweite/],
      ['bundesliga', /bundesliga/],
      ['superliga', /superliga|danmark|danska|denmark/],
      ['premierleague', /premierleague|premier|england1|epl/],
      ['seriea', /seriea|italien/],
      ['laliga', /laliga|spanien|spanska/],
      ['ligue1', /ligue1|frankrike|franska/],
      ['superettan', /superetta/],
      ['eliteserien', /eliteserien|norge|norska/],
      ['veikkausliiga', /veikkau|finland|finska/],
      ['primeiraliga', /primeira|portugal|portug/],
      ['leagueone', /leagueone|engelska3|engthree/]
    ];
    for (const [id, re] of map) if (re.test(n)) return id;
    return null;
  }

  return { LEAGUES, LEAGUE_AVG, seasonFor, findLeagueByLabel };
}));
