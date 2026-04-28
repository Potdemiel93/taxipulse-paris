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
//  EVENT CONFIRM : crowdsourcing fin reelle event (sport, concert)
//  Storage KV : key = "evconfirm:" + eventId
//  Validite : 90 min apres ts (apres on considere obsolete)
// ═══════════════════════════════════════════════════════════════════

const EVENT_CONFIRM_TTL_SEC = 90 * 60;  // 90 min
const EVENT_CONFIRM_DEDUP_SEC = 10 * 60; // meme IP : 10 min entre deux confirms

async function storeEventConfirm(body, request) {
  if (!hasKV()) return { ok: false, reason: 'kv_not_configured' };
  if (!body || !body.eventId) return { ok: false, reason: 'missing_eventId' };
  if (!body.finReelle || !/^\d{2}:\d{2}$/.test(body.finReelle)) {
    return { ok: false, reason: 'invalid_finReelle', expected: 'HH:MM' };
  }
  const status = body.status === 'finished' ? 'finished' : 'eta';

  const ip = getClientIP(request);
  const ipHash = await hashIP(ip);
  const key = 'evconfirm:' + body.eventId;

  // Lit existant
  let existing = null;
  try { existing = await TAXI_KV.get(key, { type: 'json' }); } catch (e) { existing = null; }

  const now = Date.now();

  // Dedup : si meme IP a confirme < 10 min, on rejette
  if (existing && existing.ipHash === ipHash && (now - existing.ts) < EVENT_CONFIRM_DEDUP_SEC * 1000) {
    return { ok: true, deduped: true, message: 'already confirmed recently' };
  }

  // Strategie : si event a > 1 confirmation, on garde la mediane des derniers temps
  // Pour simplicite v1 : on garde la plus RECENTE (last-write-wins). 
  // Optimisation future possible : agreger plusieurs confirms dans un array.
  const record = {
    eventId: body.eventId,
    finReelle: body.finReelle,
    status: status,
    ts: now,
    ipHash: ipHash
  };
  try {
    await TAXI_KV.put(key, JSON.stringify(record), { expirationTtl: EVENT_CONFIRM_TTL_SEC });
  } catch (e) {
    return { ok: false, reason: 'kv_put_failed', message: e.message };
  }

  return { ok: true, eventId: body.eventId, finReelle: body.finReelle, status: status };
}

async function getEventConfirmFromKV(eventId) {
  if (!hasKV()) return { ok: false, reason: 'kv_not_configured' };
  const key = 'evconfirm:' + eventId;
  try {
    const rec = await TAXI_KV.get(key, { type: 'json' });
    if (!rec) return { ok: true, found: false };
    const ageMs = Date.now() - rec.ts;
    if (ageMs > EVENT_CONFIRM_TTL_SEC * 1000) return { ok: true, found: false, expired: true };
    return {
      ok: true,
      found: true,
      eventId: rec.eventId,
      finReelle: rec.finReelle,
      status: rec.status,
      ts: rec.ts,
      ageSec: Math.round(ageMs / 1000)
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
      const result = await getEventConfirmFromKV(eid);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30'
        })
      });
    }
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

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});
