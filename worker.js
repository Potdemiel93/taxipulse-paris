/**
 * TaxiPulse Cloudflare Worker — V5 FINAL (FUSIONNE)
 *
 * Endpoints :
 *   GET  /eurostar              -> scrape Eurostar (cache 120s)
 *   GET  /eurostar/debug        -> diagnostic scrape
 *   GET  /route?from=LAT,LNG&to=LAT,LNG -> TomTom trafic live + fallback OSRM
 *   GET  /basetaxi?aero=cdg|orly        -> attente taxi LIVE (Browserless, cache 90s)
 *   POST /basetaxi/report               -> observation chauffeur (KV, dedup 25 min)
 *   GET  /basetaxi/crowd?aero=cdg|orly  -> mediane observations recentes
 *   GET  /?url=...              -> proxy SNCF (fallback, catch-all)
 *
 * Bindings requis dans wrangler.toml :
 *   - kv_namespaces : TAXI_KV (pour basetaxi)
 *   - secrets       : BROWSERLESS_TOKEN (pour /basetaxi LIVE)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const SNCF_TOKEN = 'e10f1175-be33-45fa-b1da-85d5885ebd37';

// ═══ TomTom API Key (trafic live) ═══
// Remplacer par ta clé obtenue sur developer.tomtom.com (gratuit 2500 req/jour)
const TOMTOM_KEY = 'PNM2Trk4t7GececTxPv5e1xnGzQVbPQs';

let eurostarCache = { data: null, ts: 0 };
const EUROSTAR_CACHE_TTL = 120 * 1000;

const EUROSTAR_URLS = [
  { src: 'Londres St Pancras',  url: 'https://www.eurostar.com/fr-fr/voyage/horaires/7015400/8727100/londres-st-pancras-intl/paris-gare-du-nord' },
  { src: 'Bruxelles-Midi',      url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8814001/8727100/bruxelles-midi/paris-gare-du-nord' },
  { src: 'Amsterdam Centraal',  url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8400058/8727100/amsterdam-centraal/paris-gare-du-nord' }
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// ═══ BASETAXI : attente taxi aux aeroports ═══

const BASETAXI_URLS = {
  cdg:  'https://infotaxi.parisaeroport.fr/cdg',
  orly: 'https://infotaxi.parisaeroport.fr/orly'
};

const BASETAXI_CACHE_TTL_SEC      = 90;       // cache LIVE 90s
const REPORT_DEDUP_WINDOW_SEC     = 25 * 60;  // dedup IP : 25 min
const REPORTS_KEEP_WINDOW_SEC     = 30 * 60;  // garde reports : 30 min
const CROWD_VALIDITY_WINDOW_SEC   = 25 * 60;  // mediane : observations < 25 min

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&eacute;/g, 'e')
    .replace(/&egrave;/g, 'e')
    .replace(/&agrave;/g, 'a')
    .replace(/&ecirc;/g, 'e')
    .replace(/&#233;/g, 'e')
    .replace(/&#232;/g, 'e');
}

function stripHTML(html) {
  return decodeEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function parseHTML(html, src) {
  const trains = {};

  // Strip HTML pour avoir du texte pur
  const text = stripHTML(html);

  // Normalise accents -> ASCII pour robustesse max (evite probleme V8 sur [ée])
  const textNorm = text
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .replace(/[ùûü]/g, 'u')
    .replace(/[ç]/g, 'c');

  // Regex riche: numero + statut INLINE optionnel + origine + destination + heure depart + heure arrivee
  // Format Eurostar: "train ... ER 9304 Bruxelles-Midi Paris Gare du Nord 07:00 08:38"
  //                  "train ... ES 9422 - Retarde Bruxelles-Midi Paris Gare du Nord 10:13 11:42"
  const richRegex = /train[\s:.\-]*(ES|ER)\s*(\d{4})\s*([-\-]\s*(Retarde|Train\s+annule|Cancelled|Delayed|Annule))?\s+[A-Z][A-Za-z\-\s']+?\s+Paris\s+Gare\s+du\s+Nord\s+(\d{2}):(\d{2})\s+(\d{2}):(\d{2})/gi;

  let m;
  while ((m = richRegex.exec(textNorm)) !== null) {
    const num = m[1].toUpperCase() + m[2];
    const statusTxt = (m[4] || '').toLowerCase();
    const departH = m[5] + ':' + m[6];  // heure depart (Bruxelles/Londres/Amsterdam)
    const arriveeH = m[7] + ':' + m[8]; // heure arrivee Paris Nord theorique

    let status = 'ok';
    if (statusTxt.indexOf('annul') >= 0 || statusTxt.indexOf('cancel') >= 0) {
      status = 'cancelled';
    } else if (statusTxt.indexOf('retard') >= 0 || statusTxt.indexOf('delay') >= 0) {
      status = 'delayed';
    }

    // Pour retards: chercher "Env. HH:MM" dans 1500 chars apres (heure reelle arrivee)
    let newTime = null;
    if (status === 'delayed') {
      const snippet = textNorm.substring(m.index, m.index + 1500);
      const envRegex = /Env\.\s*(\d{2}):(\d{2})/g;
      let em, last = null;
      while ((em = envRegex.exec(snippet)) !== null) last = em;
      if (last) newTime = last[1] + ':' + last[2];
    }

    const existing = trains[num];
    // Priorise le statut le plus grave trouve
    if (!existing ||
        (existing.status === 'ok' && status !== 'ok') ||
        (existing.status === 'delayed' && status === 'cancelled')) {
      trains[num] = {
        status: status,
        newTime: newTime,
        arriveeParis: arriveeH,  // heure arrivee theorique Paris Nord
        departOrigine: departH,  // heure depart origine
        origine: src
      };
    }
  }

  return trains;
}

async function fetchOne(url, src) {
  const diag = { url: url, src: src };
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      },
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    const html = await resp.text();
    const trains = parseHTML(html, src);
    diag.status = resp.status;
    diag.htmlLen = html.length;
    diag.trainsFound = Object.keys(trains).length;
    return { trains: trains, diag: diag };
  } catch (e) {
    diag.error = e.message;
    return { trains: {}, diag: diag };
  }
}

async function scrapeEurostar(debug) {
  if (!debug && eurostarCache.data && (Date.now() - eurostarCache.ts) < EUROSTAR_CACHE_TTL) {
    return Object.assign({ cached: true }, eurostarCache.data);
  }

  const result = {
    ts: new Date().toISOString(),
    trains: {},
    errors: [],
    diag: debug ? [] : undefined
  };

  const promises = EUROSTAR_URLS.map(async function(item) {
    const r = await fetchOne(item.url, item.src);
    for (const k in r.trains) result.trains[k] = r.trains[k];
    if (debug) result.diag.push(r.diag);
  });

  await Promise.all(promises);

  if (!debug) {
    eurostarCache = { data: { ts: result.ts, trains: result.trains, errors: result.errors }, ts: Date.now() };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
//  BASETAXI : 3 NIVEAUX LIVE / CROWD / ESTIM
// ═══════════════════════════════════════════════════════════════════

// Helpers KV avec fallback gracieux si TAXI_KV pas configure
function hasKV() {
  try {
    return typeof TAXI_KV !== 'undefined' && TAXI_KV !== null;
  } catch (e) {
    return false;
  }
}

function hasBrowserless() {
  try {
    return typeof BROWSERLESS_TOKEN !== 'undefined' && BROWSERLESS_TOKEN && BROWSERLESS_TOKEN.length > 10;
  } catch (e) {
    return false;
  }
}

// Parse le HTML rendu par Browserless pour extraire le temps d'attente
// Strategie : on cherche un nombre suivi de "min" ou "minute" dans un contexte plausible
// Le site infotaxi affiche en gros des cartes par terminal. On prend la valeur max
// (le pire des terminaux) pour etre conservateur cote chauffeur.
function parseBaseTaxiHTML(html) {
  if (!html || html.length < 100) {
    return { wait_min: null, error: 'html_too_short', candidates: [] };
  }

  const text = stripHTML(html);
  const textNorm = text
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .toLowerCase();

  const candidates = [];

  // Pattern 1 : "XX min" ou "XX minutes"
  const re1 = /(\d{1,3})\s*(?:min(?:utes?)?)\b/g;
  let m;
  while ((m = re1.exec(textNorm)) !== null) {
    const n = parseInt(m[1], 10);
    // Filtre valeurs absurdes : attente taxi entre 0 et 240 min raisonnable
    if (n >= 0 && n <= 240) {
      candidates.push({ value: n, idx: m.index, ctx: textNorm.substr(Math.max(0, m.index - 30), 60) });
    }
  }

  // Pattern 2 : "attente : XX" ou "temps : XX"
  const re2 = /(?:attente|temps|wait)[\s:]*(\d{1,3})/g;
  while ((m = re2.exec(textNorm)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 240) {
      candidates.push({ value: n, idx: m.index, ctx: textNorm.substr(Math.max(0, m.index - 30), 60), strong: true });
    }
  }

  if (!candidates.length) {
    return { wait_min: null, error: 'no_match', candidates: [] };
  }

  // Si on a des "strong" matches (avec mot-cle attente/temps), on les privilegie
  const strong = candidates.filter(c => c.strong);
  const pool = strong.length ? strong : candidates;

  // Prend le max (conservateur : pire terminal)
  const max = pool.reduce((a, b) => b.value > a.value ? b : a, pool[0]);

  return {
    wait_min: max.value,
    candidates: candidates.slice(0, 10)  // garde 10 max pour debug
  };
}

async function fetchBaseTaxiLive(aero) {
  const cacheKey = 'basetaxi_live_' + aero;

  // Lecture cache KV
  if (hasKV()) {
    try {
      const cached = await TAXI_KV.get(cacheKey, { type: 'json' });
      if (cached && cached.ts && (Date.now() - cached.ts) < BASETAXI_CACHE_TTL_SEC * 1000) {
        return Object.assign({ cached: true }, cached);
      }
    } catch (e) { /* fallthrough */ }
  }

  if (!hasBrowserless()) {
    return {
      ok: false,
      reason: 'browserless_not_configured',
      message: 'BROWSERLESS_TOKEN secret missing. Run: npx wrangler secret put BROWSERLESS_TOKEN'
    };
  }

  const targetUrl = BASETAXI_URLS[aero];
  if (!targetUrl) {
    return { ok: false, reason: 'invalid_aero', message: 'aero must be cdg or orly' };
  }

  // Appel Browserless.io /content (renvoie HTML rendu apres JS)
  let html = '';
  try {
    const resp = await fetch('https://chrome.browserless.io/content?token=' + BROWSERLESS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 25000 },
        waitFor: 2500  // attendre 2.5s pour rendu JS
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, reason: 'browserless_error', status: resp.status, message: errText.substr(0, 300) };
    }
    html = await resp.text();
  } catch (e) {
    return { ok: false, reason: 'fetch_exception', message: e.message };
  }

  const parsed = parseBaseTaxiHTML(html);
  if (parsed.wait_min == null) {
    return {
      ok: false,
      reason: 'parse_failed',
      parse_error: parsed.error,
      htmlLen: html.length,
      candidates: parsed.candidates
    };
  }

  const result = {
    ok: true,
    aero: aero,
    wait_min: parsed.wait_min,
    ts: Date.now(),
    source: 'browserless+infotaxi'
  };

  // Stocke dans KV
  if (hasKV()) {
    try {
      await TAXI_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: BASETAXI_CACHE_TTL_SEC + 30 });
    } catch (e) { /* ignore */ }
  }

  return result;
}

// Extrait IP client (pour dedup reports)
function getClientIP(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-forwarded-for') ||
         'unknown';
}

async function reportTaxiWait(aero, mins, request) {
  if (!hasKV()) {
    return { ok: false, reason: 'kv_not_configured', message: 'TAXI_KV namespace missing' };
  }

  if (!BASETAXI_URLS[aero]) {
    return { ok: false, reason: 'invalid_aero' };
  }
  const m = parseInt(mins, 10);
  if (isNaN(m) || m < 0 || m > 240) {
    return { ok: false, reason: 'invalid_mins' };
  }

  const ip = getClientIP(request);
  const ipHash = await hashIP(ip);  // pour pas stocker IP en clair
  const key = 'basetaxi_reports_' + aero;

  let reports = [];
  try {
    const stored = await TAXI_KV.get(key, { type: 'json' });
    if (Array.isArray(stored)) reports = stored;
  } catch (e) { /* fresh list */ }

  const now = Date.now();

  // Prune older than REPORTS_KEEP_WINDOW
  reports = reports.filter(r => (now - r.ts) < REPORTS_KEEP_WINDOW_SEC * 1000);

  // Dedup: si meme IP < 25 min, on update au lieu d'ajouter
  const existingIdx = reports.findIndex(r =>
    r.ipHash === ipHash && (now - r.ts) < REPORT_DEDUP_WINDOW_SEC * 1000
  );

  if (existingIdx >= 0) {
    reports[existingIdx].mins = m;
    reports[existingIdx].ts = now;
  } else {
    reports.push({ mins: m, ts: now, ipHash: ipHash });
  }

  try {
    await TAXI_KV.put(key, JSON.stringify(reports), { expirationTtl: REPORTS_KEEP_WINDOW_SEC + 60 });
  } catch (e) {
    return { ok: false, reason: 'kv_put_failed', message: e.message };
  }

  return {
    ok: true,
    aero: aero,
    mins: m,
    total_reports: reports.length,
    deduped: existingIdx >= 0
  };
}

async function hashIP(ip) {
  try {
    const data = new TextEncoder().encode(ip + '_taxipulse_salt_v1');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (e) {
    return 'h_' + ip.split('.').join('_').substr(0, 16);
  }
}

async function getCrowdWait(aero) {
  if (!hasKV()) {
    return { ok: false, reason: 'kv_not_configured' };
  }
  if (!BASETAXI_URLS[aero]) {
    return { ok: false, reason: 'invalid_aero' };
  }

  const key = 'basetaxi_reports_' + aero;
  let reports = [];
  try {
    const stored = await TAXI_KV.get(key, { type: 'json' });
    if (Array.isArray(stored)) reports = stored;
  } catch (e) { /* empty */ }

  const now = Date.now();
  const valid = reports.filter(r => (now - r.ts) < CROWD_VALIDITY_WINDOW_SEC * 1000);

  if (!valid.length) {
    return { ok: true, aero: aero, wait_min: null, count: 0 };
  }

  // Mediane
  const sorted = valid.map(r => r.mins).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

  const oldest = Math.min(...valid.map(r => r.ts));
  const newest = Math.max(...valid.map(r => r.ts));

  return {
    ok: true,
    aero: aero,
    wait_min: median,
    count: valid.length,
    oldest_age_sec: Math.round((now - oldest) / 1000),
    newest_age_sec: Math.round((now - newest) / 1000),
    ts: now
  };
}

// ═══════════════════════════════════════════════════════════════════
//  EVENT CONFIRM v2 : multi-vote + geoloc + quorum + anti-fraud
//  Storage KV : key = "evconfirm:" + eventId
//  Format : { eventId, votes:[{driverId, ipHash, ts, finReelle, status, lat, lng, distM}], finalized:{...} }
//  Validite : 90 min
// ═══════════════════════════════════════════════════════════════════

const EVENT_CONFIRM_TTL_SEC = 90 * 60;          // 90 min
const VOTE_DEDUP_SEC = 5 * 60;                  // 1 vote / 5 min par driverId
const QUORUM_FINISHED = 2;                      // votes 'finished' requis
const QUORUM_VETO = 2;                          // votes 'not_finished' qui bloquent
const MAX_VENUE_DIST_M = 800;                   // 800m du venue max
const MAX_DRIVERS_PER_IP = 3;                   // soft flag si 1 IP a >3 driverIds
const VOTE_WINDOW_BEFORE_MIN = 30;              // vote possible 30min avant fin theorique
const VOTE_WINDOW_AFTER_MIN = 90;               // vote possible 90min apres fin theorique

// Calcul distance Haversine (en metres)
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Parse "HH:MM" + jour ISO -> timestamp ms (Europe/Paris assume UTC+1/+2 par defaut local Cloudflare)
// On utilise une heuristique : si dayStr fourni, on le combine, sinon on prend aujourd'hui.
function parseFinTimestamp(dayStr, finStr) {
  try {
    if (!finStr || !/^\d{2}:\d{2}$/.test(finStr)) return null;
    const [h, m] = finStr.split(':').map(Number);
    let d;
    if (dayStr && /^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
      d = new Date(dayStr + 'T' + finStr + ':00');
    } else {
      d = new Date();
      d.setHours(h, m, 0, 0);
    }
    return d.getTime();
  } catch (e) { return null; }
}

// Calcule le statut consolide a partir des votes
function consolidateVotes(votes, finTs) {
  const now = Date.now();
  // Garde uniquement votes <90min
  const valid = votes.filter(v => (now - v.ts) < EVENT_CONFIRM_TTL_SEC * 1000);

  const finishedVotes = valid.filter(v => v.status === 'finished');
  const notFinishedVotes = valid.filter(v => v.status === 'not_finished');
  const etaVotes = valid.filter(v => v.status === 'eta');

  // Veto : si on a >=2 'not_finished' recents (<15min), on rejette les 'finished'
  const recentVeto = notFinishedVotes.filter(v => (now - v.ts) < 15 * 60 * 1000);
  const vetoActive = recentVeto.length >= QUORUM_VETO;

  // Confirmation : >=2 votes 'finished' uniques (par driverId) + pas de veto
  const uniqueDrivers = new Set(finishedVotes.map(v => v.driverId));
  const confirmed = uniqueDrivers.size >= QUORUM_FINISHED && !vetoActive;

  // Auto-fallback : si finTs connu et now > finTs + 15min, on considere fini
  const autoFinished = finTs && (now > finTs + 15 * 60 * 1000);

  // Calcule finReelle consolide : mediane des finReelle des votes 'finished'
  let finReelle = null;
  if (finishedVotes.length) {
    const times = finishedVotes
      .map(v => {
        const [h, m] = v.finReelle.split(':').map(Number);
        return h * 60 + m;
      })
      .sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    const medMin = times.length % 2
      ? times[mid]
      : Math.round((times[mid - 1] + times[mid]) / 2);
    finReelle = String(Math.floor(medMin / 60)).padStart(2, '0') + ':' +
                String(medMin % 60).padStart(2, '0');
  }

  // ETA mediane des votes 'eta' recents
  let etaReelle = null;
  if (etaVotes.length && !confirmed) {
    const times = etaVotes
      .filter(v => (now - v.ts) < 30 * 60 * 1000)
      .map(v => {
        const [h, m] = v.finReelle.split(':').map(Number);
        return h * 60 + m;
      })
      .sort((a, b) => a - b);
    if (times.length) {
      const mid = Math.floor(times.length / 2);
      const medMin = times.length % 2 ? times[mid] : Math.round((times[mid-1] + times[mid]) / 2);
      etaReelle = String(Math.floor(medMin / 60)).padStart(2, '0') + ':' +
                  String(medMin % 60).padStart(2, '0');
    }
  }

  return {
    confirmed,
    autoFinished,
    vetoActive,
    finReelle,
    etaReelle,
    counts: {
      finished: uniqueDrivers.size,
      not_finished: new Set(notFinishedVotes.map(v => v.driverId)).size,
      eta: new Set(etaVotes.map(v => v.driverId)).size,
      total: valid.length
    },
    quorum: QUORUM_FINISHED
  };
}

async function storeEventConfirm(body, request) {
  if (!hasKV()) return { ok: false, reason: 'kv_not_configured' };
  if (!body || !body.eventId) return { ok: false, reason: 'missing_eventId' };

  const status = ['finished', 'eta', 'not_finished'].indexOf(body.status) >= 0
    ? body.status : 'finished';

  // finReelle requis sauf pour not_finished
  if (status !== 'not_finished') {
    if (!body.finReelle || !/^\d{2}:\d{2}$/.test(body.finReelle)) {
      return { ok: false, reason: 'invalid_finReelle', expected: 'HH:MM' };
    }
  }

  // driverId requis (cote frontend on en genere un en localStorage)
  if (!body.driverId || typeof body.driverId !== 'string' || body.driverId.length < 8) {
    return { ok: false, reason: 'missing_driverId' };
  }

  const ip = getClientIP(request);
  const ipHash = await hashIP(ip);
  const key = 'evconfirm:' + body.eventId;
  const now = Date.now();

  // Lit existant
  let record = null;
  try { record = await TAXI_KV.get(key, { type: 'json' }); } catch (e) { record = null; }
  if (!record || !Array.isArray(record.votes)) {
    record = { eventId: body.eventId, votes: [] };
  }

  // Prune votes >90min
  record.votes = record.votes.filter(v => (now - v.ts) < EVENT_CONFIRM_TTL_SEC * 1000);

  // Anti-spam : meme driverId < 5min ?
  const recentSame = record.votes.find(v =>
    v.driverId === body.driverId && (now - v.ts) < VOTE_DEDUP_SEC * 1000
  );
  if (recentSame) {
    // Update plutot que rejeter (chauffeur veut corriger son vote)
    recentSame.status = status;
    recentSame.finReelle = body.finReelle || recentSame.finReelle;
    recentSame.ts = now;
  } else {
    // Geoloc : verifie distance si fournie
    let distM = null;
    if (typeof body.lat === 'number' && typeof body.lng === 'number' &&
        typeof body.venueLat === 'number' && typeof body.venueLng === 'number') {
      distM = Math.round(haversineM(body.lat, body.lng, body.venueLat, body.venueLng));
      if (distM > MAX_VENUE_DIST_M) {
        return {
          ok: false,
          reason: 'too_far_from_venue',
          distM: distM,
          maxM: MAX_VENUE_DIST_M,
          message: 'Tu dois etre a moins de ' + MAX_VENUE_DIST_M + 'm du venue'
        };
      }
    }

    // Fenetre temporelle : si finTs connu, verifie qu'on est dans [-30min, +90min]
    if (typeof body.finTs === 'number' && body.finTs > 0) {
      const minWindow = body.finTs - VOTE_WINDOW_BEFORE_MIN * 60 * 1000;
      const maxWindow = body.finTs + VOTE_WINDOW_AFTER_MIN * 60 * 1000;
      if (now < minWindow || now > maxWindow) {
        return {
          ok: false,
          reason: 'out_of_window',
          message: 'Vote hors fenetre temporelle (-30min / +90min de la fin theorique)'
        };
      }
    }

    record.votes.push({
      driverId: body.driverId,
      ipHash: ipHash,
      ts: now,
      finReelle: body.finReelle || null,
      status: status,
      lat: typeof body.lat === 'number' ? body.lat : null,
      lng: typeof body.lng === 'number' ? body.lng : null,
      distM: distM
    });
  }

  // Detection abuse : meme IP avec >MAX_DRIVERS_PER_IP driverIds differents
  const driversByIp = {};
  for (const v of record.votes) {
    if (!driversByIp[v.ipHash]) driversByIp[v.ipHash] = new Set();
    driversByIp[v.ipHash].add(v.driverId);
  }
  const flaggedIps = Object.keys(driversByIp).filter(h => driversByIp[h].size > MAX_DRIVERS_PER_IP);
  if (flaggedIps.length) {
    record.flagged = true;
    record.flaggedIps = flaggedIps;
  }

  // Sauvegarde
  try {
    await TAXI_KV.put(key, JSON.stringify(record), { expirationTtl: EVENT_CONFIRM_TTL_SEC });
  } catch (e) {
    return { ok: false, reason: 'kv_put_failed', message: e.message };
  }

  // Consolide et retourne
  const consolidated = consolidateVotes(record.votes, body.finTs || null);
  return {
    ok: true,
    eventId: body.eventId,
    yourVote: { status: status, finReelle: body.finReelle || null },
    consolidated: consolidated,
    flagged: record.flagged || false
  };
}

async function getEventConfirmFromKV(eventId, finTs) {
  if (!hasKV()) return { ok: false, reason: 'kv_not_configured' };
  const key = 'evconfirm:' + eventId;
  try {
    const rec = await TAXI_KV.get(key, { type: 'json' });
    if (!rec || !Array.isArray(rec.votes)) {
      return { ok: true, found: false, consolidated: { confirmed: false, autoFinished: false, counts: { finished: 0, not_finished: 0, eta: 0, total: 0 }, quorum: QUORUM_FINISHED } };
    }
    const consolidated = consolidateVotes(rec.votes, finTs || null);
    return {
      ok: true,
      found: true,
      eventId: rec.eventId,
      consolidated: consolidated,
      flagged: rec.flagged || false,
      // Pour backward compat avec ancien frontend
      finReelle: consolidated.finReelle || consolidated.etaReelle,
      status: consolidated.confirmed ? 'finished' : (consolidated.etaReelle ? 'eta' : null),
      ts: rec.votes.length ? Math.max(...rec.votes.map(v => v.ts)) : 0
    };
  } catch (e) {
    return { ok: false, reason: 'kv_read_failed', message: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ROUTING PRINCIPAL
// ═══════════════════════════════════════════════════════════════════

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // ─── EUROSTAR ───
  if (path === '/eurostar' || path === '/eurostar/') {
    try {
      const data = await scrapeEurostar(false);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60'
        })
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, trains: {} }), {
        status: 500,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
  }

  if (path === '/eurostar/debug') {
    try {
      const data = await scrapeEurostar(true);
      return new Response(JSON.stringify(data, null, 2), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
  }

  // ─── ROUTE (TomTom + OSRM) ───
  // Usage: /route?from=LAT,LNG&to=LAT,LNG
  if (path === '/route' || path === '/route/') {
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    if (!from || !to) {
      return new Response(JSON.stringify({ error: 'missing from/to params (format: LAT,LNG)' }), {
        status: 400,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }

    const [fLat, fLng] = from.split(',').map(Number);
    const [tLat, tLng] = to.split(',').map(Number);
    if (isNaN(fLat) || isNaN(fLng) || isNaN(tLat) || isNaN(tLng)) {
      return new Response(JSON.stringify({ error: 'invalid coordinates' }), {
        status: 400,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }

    // TomTom d'abord (trafic live)
    if (TOMTOM_KEY && TOMTOM_KEY !== 'YOUR_TOMTOM_KEY_HERE') {
      try {
        const ttUrl = `https://api.tomtom.com/routing/1/calculateRoute/${fLat},${fLng}:${tLat},${tLng}/json`
          + `?traffic=true&travelMode=car&computeTravelTimeFor=all&routeType=fastest`
          + `&key=${TOMTOM_KEY}`;
        const resp = await fetch(ttUrl);
        if (resp.ok) {
          const data = await resp.json();
          if (data.routes && data.routes[0] && data.routes[0].summary) {
            const s = data.routes[0].summary;
            const result = {
              distance_km: Math.round(s.lengthInMeters / 100) / 10,
              duration_live_min: Math.round(s.travelTimeInSeconds / 60),
              duration_free_flow_min: Math.round(s.noTrafficTravelTimeInSeconds / 60),
              traffic_delay_min: Math.round(s.trafficDelayInSeconds / 60),
              historical_delay_min: Math.round((s.historicTrafficTravelTimeInSeconds - s.noTrafficTravelTimeInSeconds) / 60),
              departure_time: s.departureTime,
              arrival_time: s.arrivalTime,
              source: 'TomTom Traffic Live'
            };
            return new Response(JSON.stringify(result), {
              status: 200,
              headers: Object.assign({}, CORS_HEADERS, {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=300'
              })
            });
          }
        }
      } catch (err) { /* fallback OSRM */ }
    }

    // Fallback OSRM
    try {
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${fLng},${fLat};${tLng},${tLat}?overview=false&steps=false`;
      const resp = await fetch(osrmUrl);
      const data = await resp.json();
      if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
        throw new Error('no route found');
      }
      const r = data.routes[0];
      const result = {
        distance_km: Math.round(r.distance / 100) / 10,
        duration_live_min: Math.round(r.duration / 60),
        duration_free_flow_min: Math.round(r.duration / 60),
        traffic_delay_min: 0,
        source: 'OSRM (pas de trafic live)'
      };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        })
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
  }

  // ─── BASETAXI : REPORT (POST) ───
  if (path === '/basetaxi/report' && request.method === 'POST') {
    try {
      const body = await request.json();
      const aero = (body.aero || '').toLowerCase();
      const mins = body.mins;
      const result = await reportTaxiWait(aero, mins, request);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 400,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
  }

  // ─── BASETAXI : CROWD (mediane observations) ───
  if (path === '/basetaxi/crowd') {
    const aero = (url.searchParams.get('aero') || '').toLowerCase();
    const result = await getCrowdWait(aero);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: Object.assign({}, CORS_HEADERS, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30'
      })
    });
  }

  // ─── BASETAXI : LIVE (Browserless scrape) ───
  if (path === '/basetaxi' || path === '/basetaxi/') {
    const aero = (url.searchParams.get('aero') || '').toLowerCase();
    if (!BASETAXI_URLS[aero]) {
      return new Response(JSON.stringify({ ok: false, reason: 'invalid_aero', allowed: ['cdg', 'orly'] }), {
        status: 400,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
    const result = await fetchBaseTaxiLive(aero);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 503,
      headers: Object.assign({}, CORS_HEADERS, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60'
      })
    });
  }

  // ─── EVENT CONFIRM : crowdsourcing fin reelle event ───
  // POST /event/confirm  body { eventId, finReelle, status, ts }
  // GET  /event/confirm?eventId=<id>
  if (path === '/event/confirm' || path === '/event/confirm/') {
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const result = await storeEventConfirm(body, request);
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 400,
          headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
        });
      }
    } else {
      const eid = url.searchParams.get('eventId');
      if (!eid) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_eventId' }), {
          status: 400,
          headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
        });
      }
      const finTsParam = url.searchParams.get('finTs');
      const finTs = finTsParam ? parseInt(finTsParam, 10) : null;
      const result = await getEventConfirmFromKV(eid, finTs);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=15'
        })
      });
    }
  }

  // ─── SCRAPE HEBDO : routes admin pour le scraper ───
  // GET /scrape/run             -> Lance le scrape manuellement
  // GET /scrape/news            -> Liste des nouveautés détectées
  // GET /scrape/news?weeks=4    -> Nouveautés des N dernières semaines
  // GET /scrape/health          -> État de santé du scraper
  // POST /scrape/test-email     -> Envoie un email de test
  if (path === '/scrape/run') {
    const result = await runScrapeAll(null);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/scrape/news') {
    if (!hasKV()) {
      return new Response(JSON.stringify({ ok: false, reason: 'kv_not_configured' }), {
        status: 500,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
    const weeks = parseInt(url.searchParams.get('weeks') || '1', 10);
    const since = Date.now() - weeks * 7 * 24 * 3600 * 1000;

    // Liste les clés scrape:news:* récentes
    const allNews = [];
    try {
      const list = await TAXI_KV.list({ prefix: 'scrape:news:' });
      for (const k of list.keys) {
        const rec = await TAXI_KV.get(k.name, { type: 'json' });
        if (!rec) continue;
        if (rec.ts && rec.ts >= since) {
          allNews.push(rec);
        }
      }
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }

    return new Response(JSON.stringify({ ok: true, weeks, since: new Date(since).toISOString(), records: allNews }, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/scrape/health') {
    if (!hasKV()) {
      return new Response(JSON.stringify({ ok: false, reason: 'kv_not_configured' }), {
        status: 500,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    }
    let health = null;
    try {
      health = await TAXI_KV.get('scrape:health', { type: 'json' });
    } catch (e) { health = null; }
    return new Response(JSON.stringify({ ok: true, health: health || { last_run: null, message: 'never_run' } }, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/scrape/test-email' && request.method === 'POST') {
    const fakeResult = {
      duration_ms: 5234,
      news_count: 3,
      removed_count: 1,
      venues_ok: ['stade_france', 'bercy_arena', 'olympia'],
      venues_ko: [{ venue: 'porte_versailles', error: 'HTTP 403 - Cloudflare bot block' }],
      news_sample: [
        { titre: 'TEST Concert nouveau', date: '2026-12-01', venue: 'olympia', venue_name: 'L\'Olympia' },
        { titre: 'TEST Salon nouveau', date: '2026-11-15', venue: 'porte_versailles', venue_name: 'Porte de Versailles' }
      ]
    };
    const r = await sendScrapeRecapEmail(null, fakeResult);
    return new Response(JSON.stringify(r, null, 2), {
      status: r.ok ? 200 : 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  // ─── PROXY SNCF (catch-all) ───
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('TaxiPulse Proxy OK', {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  try {
    const response = await fetch(target, {
      headers: {
        'Authorization': SNCF_TOKEN,
        'Accept': 'application/json'
      }
    });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PHASE B : SCRAPER HEBDO + EMAIL ALERT (Resend API)
// ═══════════════════════════════════════════════════════════════════
//
//  Routes :
//    GET  /scrape/run            -> Lance le scrape de tous les lieux (manuel)
//    GET  /scrape/news           -> Voir les nouveautés détectées cette semaine
//    GET  /scrape/news?weeks=4   -> Voir les nouveautés des 4 dernières semaines
//    POST /scrape/test-email     -> Test l'envoi d'email (debug)
//
//  Cron Trigger Cloudflare (à configurer dans wrangler.toml) :
//    [triggers]
//    crons = ["0 6 * * 1"]   # tous les lundis à 6h UTC
//
//  Storage KV :
//    scrape:state:<venue>      -> snapshot derniers events scrapés (pour détecter nouveautés)
//    scrape:news:<YYYY-MM-DD>  -> liste des nouveautés détectées ce lundi-là
//    scrape:health             -> état de santé du scraper (date dernier run, sites KO)
//    scrape:lastrun            -> timestamp dernier run
//
//  Secrets requis (à configurer avec `wrangler secret put`) :
//    RESEND_API_KEY            -> token Resend pour envoi email
//    ADMIN_EMAIL               -> ton email perso pour recevoir les récaps

const SCRAPE_VENUES = [
  {
    id: 'stade_france',
    name: 'Stade de France',
    url: 'https://www.stadefrance.com/fr/billetteries',
    selector_keywords: ['concert', 'match', '2026'],
    venue_lat: 48.9244,
    venue_lng: 2.3601
  },
  {
    id: 'bercy_arena',
    name: 'Accor Arena (Bercy)',
    url: 'https://www.accorarena.com/fr/agenda',
    selector_keywords: ['concert', '2026'],
    venue_lat: 48.8386,
    venue_lng: 2.3786
  },
  {
    id: 'defense_arena',
    name: 'Paris La Défense Arena',
    url: 'https://www.parisladefense-arena.com/billetterie/',
    selector_keywords: ['concert', '2026'],
    venue_lat: 48.8957,
    venue_lng: 2.2294
  },
  {
    id: 'adidas_arena',
    name: 'Adidas Arena',
    url: 'https://www.adidasarena.com/programmation',
    selector_keywords: ['concert', '2026'],
    venue_lat: 48.8979,
    venue_lng: 2.3617
  },
  {
    id: 'olympia',
    name: 'L\'Olympia',
    url: 'https://www.olympiahall.com/agenda/',
    selector_keywords: ['concert', '2026'],
    venue_lat: 48.8703,
    venue_lng: 2.3290
  },
  {
    id: 'zenith',
    name: 'Zénith Paris',
    url: 'https://le-zenith.com/program',
    selector_keywords: ['concert', '2026'],
    venue_lat: 48.8911,
    venue_lng: 2.3934
  },
  {
    id: 'seine_musicale',
    name: 'La Seine Musicale',
    url: 'https://www.laseinemusicale.com/programmation/',
    selector_keywords: ['concert', '2026'],
    venue_lat: 48.8264,
    venue_lng: 2.2298
  },
  {
    id: 'porte_versailles',
    name: 'Paris Expo Porte de Versailles',
    url: 'https://www.viparis.com/nos-lieux/paris-expo-porte-de-versailles/agenda',
    selector_keywords: ['salon', 'expo', '2026'],
    venue_lat: 48.8316,
    venue_lng: 2.2879
  },
  {
    id: 'villepinte',
    name: 'Paris Nord Villepinte',
    url: 'https://www.viparis.com/nos-lieux/paris-nord-villepinte/agenda',
    selector_keywords: ['salon', 'expo', '2026'],
    venue_lat: 48.9750,
    venue_lng: 2.5167
  }
];

const SCRAPE_HISTORY_TTL_SEC = 90 * 24 * 3600;  // garde 90 jours d'historique news

// Hash simple pour identifier un event (titre + date)
function hashEvent(ev) {
  const str = (ev.titre || '') + '|' + (ev.date || '') + '|' + (ev.venue || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// Parse les dates en français : "12 juin 2026", "samedi 18 juillet", etc.
const FR_MONTHS = {
  janvier: '01', janv: '01', février: '02', fevrier: '02', févr: '02', fevr: '02',
  mars: '03', avril: '04', avr: '04', mai: '05', juin: '06', juillet: '07', juil: '07',
  août: '08', aout: '08', septembre: '09', sept: '09', octobre: '10', oct: '10',
  novembre: '11', nov: '11', décembre: '12', decembre: '12', déc: '12', dec: '12'
};

function parseFrenchDate(text, defaultYear = 2026) {
  if (!text) return null;
  // Match patterns : "12 juin 2026", "12 juin", "12/06/2026", "12-06-2026", "2026-06-12"
  const cleaned = text.toLowerCase().replace(/[\s,]+/g, ' ').trim();

  // ISO format
  let m = cleaned.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD/MM/YYYY ou DD-MM-YYYY
  m = cleaned.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  // "12 juin 2026" ou "12 juin"
  m = cleaned.match(/(\d{1,2})\s+([a-zéûôçèà]+)\.?\s*(\d{4})?/i);
  if (m) {
    const day = m[1].padStart(2, '0');
    const monthName = m[2].replace('.', '');
    const month = FR_MONTHS[monthName];
    const year = m[3] || String(defaultYear);
    if (month) return `${year}-${month}-${day}`;
  }

  return null;
}

// Parse une heure : "20h00", "20:00", "21h"
function parseFrenchHour(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s*[h:](\d{0,2})/);
  if (m) {
    const h = m[1].padStart(2, '0');
    const min = (m[2] || '00').padStart(2, '0');
    return `${h}:${min}`;
  }
  return null;
}

// Scrape un site via Browserless (si disponible) ou direct fetch
async function scrapeVenue(venue, env) {
  try {
    // Tentative directe d'abord (plus rapide)
    const r = await fetch(venue.url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' },
      cf: { cacheTtl: 0 }
    });

    if (!r.ok) {
      return { venue: venue.id, ok: false, error: `HTTP ${r.status}`, events: [] };
    }

    const html = await r.text();
    const text = stripHTML(html);

    // Extraction basique : on cherche des patterns "JJ mois AAAA" suivis (ou précédés) d'un titre
    const events = extractEventsFromHTML(html, venue);

    return {
      venue: venue.id,
      venue_name: venue.name,
      ok: true,
      events: events,
      htmlLength: html.length,
      textLength: text.length
    };
  } catch (e) {
    return { venue: venue.id, ok: false, error: e.message, events: [] };
  }
}

// Extraction heuristique d'events depuis HTML (regex multi-pattern)
function extractEventsFromHTML(html, venue) {
  const events = [];
  const text = stripHTML(html);

  // Pattern 1 : "Vendredi 12 juin 2026" ou "12 juin 2026" suivi d'un titre court
  const pat1 = /([a-zéè]+\s+)?(\d{1,2})\s+(janvier|janv|février|fevrier|févr|fevr|mars|avril|avr|mai|juin|juillet|juil|août|aout|septembre|sept|octobre|oct|novembre|nov|décembre|decembre|déc|dec)\s*\.?\s*(\d{4})?/gi;

  let match;
  let lastEnd = 0;
  const seen = new Set();

  while ((match = pat1.exec(text)) !== null) {
    const day = match[2].padStart(2, '0');
    const monthName = match[3].toLowerCase().replace('.', '');
    const month = FR_MONTHS[monthName];
    const year = match[4] || '2026';

    if (!month) continue;
    const dateStr = `${year}-${month}-${day}`;

    // Skip dates dans le passé (avant aujourd'hui)
    const evDate = new Date(dateStr);
    const now = new Date();
    if (isNaN(evDate.getTime()) || evDate < new Date(now.getTime() - 24*3600*1000)) continue;

    // Récupère un peu de contexte avant et après pour deviner le titre
    const ctx = text.substring(Math.max(0, match.index - 100), Math.min(text.length, match.index + 200));
    const title = guessTitle(ctx, match.index - Math.max(0, match.index - 100));

    if (!title || title.length < 3) continue;

    const evHash = hashEvent({ titre: title, date: dateStr, venue: venue.id });
    if (seen.has(evHash)) continue;
    seen.add(evHash);

    events.push({
      date: dateStr,
      titre: title.substring(0, 100),
      venue: venue.id,
      venue_name: venue.name,
      source: new URL(venue.url).hostname
    });

    // Limite à 50 events par venue (pour éviter explosion)
    if (events.length >= 50) break;
  }

  return events;
}

function guessTitle(ctx, datePos) {
  // Essaie d'extraire un titre court avant ou après la date
  const before = ctx.substring(0, datePos).split(/[.!?·•|]/).pop().trim();
  const after = ctx.substring(datePos).replace(/^[^a-zA-Z]+/, '').split(/[.!?·•|]/)[0].trim();

  // Préfère après si plus court et a l'air d'un titre
  if (after.length > 5 && after.length < 80 && /[A-Z]/.test(after)) return after;
  if (before.length > 5 && before.length < 80) return before;
  return after.substring(0, 80) || before.substring(0, 80);
}

// Compare ancien snapshot avec nouveaux events scrapés -> détecte nouveautés
function diffEvents(oldEvents, newEvents) {
  const oldHashes = new Set((oldEvents || []).map(e => hashEvent(e)));
  const news = [];
  const removed = [];

  for (const ne of newEvents) {
    if (!oldHashes.has(hashEvent(ne))) {
      news.push(ne);
    }
  }

  const newHashes = new Set(newEvents.map(e => hashEvent(e)));
  for (const oe of (oldEvents || [])) {
    if (!newHashes.has(hashEvent(oe))) {
      removed.push(oe);
    }
  }

  return { news, removed };
}

// Run le scrape complet (tous les lieux)
async function runScrapeAll(env) {
  if (!hasKV()) return { ok: false, reason: 'kv_not_configured' };

  const startTs = Date.now();
  const results = [];
  const allNews = [];
  const allRemoved = [];

  for (const venue of SCRAPE_VENUES) {
    const scraped = await scrapeVenue(venue, env);
    results.push(scraped);

    if (!scraped.ok) continue;

    // Lit ancien snapshot
    let oldSnap = null;
    try {
      oldSnap = await TAXI_KV.get('scrape:state:' + venue.id, { type: 'json' });
    } catch (e) { oldSnap = null; }

    // Diff
    const oldEvents = (oldSnap && Array.isArray(oldSnap.events)) ? oldSnap.events : [];
    const { news, removed } = diffEvents(oldEvents, scraped.events);

    // Écrit nouveau snapshot
    await TAXI_KV.put('scrape:state:' + venue.id, JSON.stringify({
      venue: venue.id,
      events: scraped.events,
      ts: Date.now()
    }), { expirationTtl: SCRAPE_HISTORY_TTL_SEC });

    allNews.push(...news);
    allRemoved.push(...removed);
  }

  // Stocke le delta sous une clé datée
  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const newsRecord = {
    date: today,
    ts: Date.now(),
    news: allNews,
    removed: allRemoved,
    venues_ok: results.filter(r => r.ok).map(r => r.venue),
    venues_ko: results.filter(r => !r.ok).map(r => ({ venue: r.venue, error: r.error }))
  };
  await TAXI_KV.put('scrape:news:' + today, JSON.stringify(newsRecord), {
    expirationTtl: SCRAPE_HISTORY_TTL_SEC
  });

  // Met à jour la santé
  const health = {
    last_run: Date.now(),
    last_run_iso: new Date().toISOString(),
    duration_ms: Date.now() - startTs,
    venues_ok: newsRecord.venues_ok,
    venues_ko: newsRecord.venues_ko,
    news_count: allNews.length,
    removed_count: allRemoved.length
  };
  await TAXI_KV.put('scrape:health', JSON.stringify(health));
  await TAXI_KV.put('scrape:lastrun', String(Date.now()));

  return { ok: true, ...health, news_sample: allNews.slice(0, 5) };
}

// Envoie l'email récap via Resend API
async function sendScrapeRecapEmail(env, scrapeResult) {
  const apiKey = (typeof env !== 'undefined' && env.RESEND_API_KEY) || (typeof RESEND_API_KEY !== 'undefined' ? RESEND_API_KEY : null);
  const adminEmail = (typeof env !== 'undefined' && env.ADMIN_EMAIL) || (typeof ADMIN_EMAIL !== 'undefined' ? ADMIN_EMAIL : null);

  if (!apiKey || !adminEmail) {
    return { ok: false, reason: 'missing_resend_config', missing: !apiKey ? 'RESEND_API_KEY' : 'ADMIN_EMAIL' };
  }

  const status = scrapeResult.venues_ko.length > 0 ? '⚠️ Avec problèmes' : '✅ OK';
  const subject = `[TaxiPulse] Scrape hebdo ${status} — ${scrapeResult.news_count} nouveautés`;

  // Construction HTML email
  let newsSection = '';
  if (scrapeResult.news_count > 0) {
    newsSection = '<h2>🆕 Nouveaux events détectés (' + scrapeResult.news_count + ')</h2><ul>';
    for (const n of (scrapeResult.news_sample || []).slice(0, 20)) {
      newsSection += `<li><strong>${escapeHtml(n.titre)}</strong> — ${n.date} @ ${escapeHtml(n.venue_name || n.venue)}</li>`;
    }
    newsSection += '</ul>';
    if (scrapeResult.news_count > 20) {
      newsSection += `<p>...et ${scrapeResult.news_count - 20} autres. Voir <a href="https://taxipulse-proxy.boughida-sofiane.workers.dev/scrape/news">/scrape/news</a></p>`;
    }
  } else {
    newsSection = '<p>Aucune nouveauté cette semaine.</p>';
  }

  let kosSection = '';
  if (scrapeResult.venues_ko && scrapeResult.venues_ko.length > 0) {
    kosSection = '<h2>⚠️ Sites en erreur</h2><ul>';
    for (const k of scrapeResult.venues_ko) {
      kosSection += `<li><strong>${escapeHtml(k.venue)}</strong> : ${escapeHtml(k.error || 'erreur inconnue')}</li>`;
    }
    kosSection += '</ul><p>Si un site est en erreur 3 semaines de suite, son scraper est probablement à mettre à jour.</p>';
  }

  const html = `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
    <h1 style="color: #ea580c;">🚖 TaxiPulse — Scrape hebdo</h1>
    <p style="color: #6b7280;">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
    <div style="background: #f9fafb; padding: 16px; border-radius: 8px;">
      <p><strong>Sites OK :</strong> ${scrapeResult.venues_ok.length}/${SCRAPE_VENUES.length}</p>
      <p><strong>Nouveautés détectées :</strong> ${scrapeResult.news_count}</p>
      <p><strong>Durée :</strong> ${Math.round(scrapeResult.duration_ms / 1000)}s</p>
    </div>
    ${newsSection}
    ${kosSection}
    <hr style="margin: 24px 0;">
    <p style="color: #6b7280; font-size: 12px;">Email auto envoyé par le worker Cloudflare TaxiPulse. Pour valider/rejeter les nouveautés, ouvre le Sheet Google "events".</p>
  </body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'TaxiPulse <onboarding@resend.dev>',
        to: [adminEmail],
        subject: subject,
        html: html
      })
    });
    const data = await r.json();
    return { ok: r.ok, status: r.status, response: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════
//  CRON HANDLER : exécuté automatiquement par Cloudflare le lundi 6h UTC
// ═══════════════════════════════════════════════════════════════════
async function handleScheduled(event, env) {
  console.log('[CRON] Lancement scrape hebdo...');
  const result = await runScrapeAll(env);
  console.log('[CRON] Scrape terminé :', JSON.stringify(result).substring(0, 500));

  // Envoie email récap
  const emailResult = await sendScrapeRecapEmail(env, result);
  console.log('[CRON] Email :', JSON.stringify(emailResult).substring(0, 300));

  return result;
}



addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', function(event) {
  event.waitUntil(handleScheduled(event, null));
});
