// =============================================================================
// TaxiPulse — Constantes globales
// Extrait de worker.js (refactor monolithe → modules)
// Vérifié contre l'original ligne par ligne (commit refactor-monolith)
// =============================================================================

// ─── CORS ───
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// ─── SNCF / TomTom (clés API) ───
export const SNCF_TOKEN = 'e10f1175-be33-45fa-b1da-85d5885ebd37';
export const TOMTOM_KEY = 'PNM2Trk4t7GececTxPv5e1xnGzQVbPQs';

// ─── User-Agent commun pour scrapes ───
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// ─── EUROSTAR ───
export const EUROSTAR_CACHE_TTL = 120 * 1000;
export const EUROSTAR_URLS = [
  { src: 'Londres St Pancras',  url: 'https://www.eurostar.com/fr-fr/voyage/horaires/7015400/8727100/londres-st-pancras-intl/paris-gare-du-nord' },
  { src: 'Bruxelles-Midi',      url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8814001/8727100/bruxelles-midi/paris-gare-du-nord' },
  { src: 'Amsterdam Centraal',  url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8400058/8727100/amsterdam-centraal/paris-gare-du-nord' },
  { src: 'Cologne Hbf',         url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8015458/8727100/cologne-hbf/paris-gare-du-nord' }
];

export const ORIGIN_NORMALIZE = {
  'londres':       'Londres St Pancras',
  'london':        'Londres St Pancras',
  'st pancras':    'Londres St Pancras',
  'bruxelles':     'Bruxelles-Midi',
  'brussels':      'Bruxelles-Midi',
  'midi':          'Bruxelles-Midi',
  'amsterdam':     'Amsterdam Centraal',
  'centraal':      'Amsterdam Centraal',
  'cologne':       'Cologne Hbf',
  'koln':          'Cologne Hbf',
  'köln':          'Cologne Hbf',
  'rotterdam':     'Rotterdam Centraal',
  'lille':         'Lille Europe',
  'antwerp':       'Anvers-Central',
  'anvers':        'Anvers-Central',
  'liege':         'Liege-Guillemins',
  'aachen':        'Aix-la-Chapelle',
  'dusseldorf':    'Dusseldorf Hbf',
  'düsseldorf':    'Dusseldorf Hbf',
  'essen':         'Essen Hbf',
  'duisburg':      'Duisburg Hbf',
  'dortmund':      'Dortmund Hbf'
};

// ─── BASETAXI (URLs aéroports) ───
export const BASETAXI_URLS = {
  cdg:  'https://infotaxi.parisaeroport.fr/cdg',
  orly: 'https://infotaxi.parisaeroport.fr/orly'
};

export const BASETAXI_CACHE_TTL_SEC    = 90;
export const REPORT_DEDUP_WINDOW_SEC   = 25 * 60;
export const REPORTS_KEEP_WINDOW_SEC   = 30 * 60;
export const CROWD_VALIDITY_WINDOW_SEC = 25 * 60;

// ─── EVENT CONFIRM (votes chauffeurs) ───
export const EVENT_CONFIRM_TTL_SEC = 90 * 60;     // 90 min
export const VOTE_DEDUP_SEC = 5 * 60;             // 5 min
export const QUORUM_FINISHED = 2;                 // 2 votes pour confirmer fin
export const QUORUM_VETO = 2;                     // 2 votes pour véto
export const MAX_VENUE_DIST_M = 800;              // géofence
export const MAX_DRIVERS_PER_IP = 3;              // anti-spam
export const VOTE_WINDOW_BEFORE_MIN = 30;
export const VOTE_WINDOW_AFTER_MIN = 90;

// ─── TICKETMASTER (durées concert) ───
export const DUREE_CONCERT_TM = {
  bercy_arena:    150,
  defense_arena:  150,
  adidas_arena:   150,
  stade_france:   180,
  parc_princes:   180,
  zenith:         150,
  olympia:        120,
  bataclan:       120,
  seine_musicale: 120,
  philharmonie:   120,
  cigale:         120,
  trianon:        120,
  salle_pleyel:   120,
  grand_rex:      150,
  casino_paris:   120,
  elysee_montmartre: 120
};

