/**
 * TaxiPulse Cloudflare Worker — V6 (V5 + Ticketmaster)
 *
 * Endpoints :
 *   GET  /eurostar              -> scrape Eurostar (cache 120s)
 *   GET  /eurostar/debug        -> diagnostic scrape
 *   GET  /route?from=LAT,LNG&to=LAT,LNG -> TomTom trafic live + fallback OSRM
 *   GET  /basetaxi?aero=cdg|orly        -> attente taxi LIVE (Browserless, cache 90s)
 *   POST /basetaxi/report               -> observation chauffeur (KV, dedup 25 min)
 *   GET  /basetaxi/crowd?aero=cdg|orly  -> mediane observations recentes
 *   POST /event/confirm                 -> vote fin reelle event (multi-vote + geoloc)
 *   GET  /event/confirm?eventId=...     -> consolidated votes
 *   GET  /events/health                 -> stats fraicheur Sheet
 *   GET  /events/checklist              -> liste liens a verifier
 *   POST /events/test-email             -> envoie email de test
 *   POST /events/run-recap              -> force envoi recap hebdo
 *   GET  /events/ticketmaster           -> events Ticketmaster Paris (cache 6h)  [NEW V6]
 *   GET  /?url=...              -> proxy SNCF (fallback, catch-all)
 *
 * Bindings requis dans wrangler.toml :
 *   - kv_namespaces : TAXI_KV (pour basetaxi)
 *   - secrets       : BROWSERLESS_TOKEN, RESEND_API_KEY, ADMIN_EMAIL, TICKETMASTER_KEY
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
  { src: 'Amsterdam Centraal',  url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8400058/8727100/amsterdam-centraal/paris-gare-du-nord' },
  { src: 'Cologne Hbf',         url: 'https://www.eurostar.com/fr-fr/voyage/horaires/8015458/8727100/cologne-hbf/paris-gare-du-nord' }
];

// Mapping origine textuelle (depuis le HTML Eurostar) -> nom canonique
const ORIGIN_NORMALIZE = {
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

function normalizeOrigin(rawText) {
  if (!rawText) return null;
  const lower = rawText.toLowerCase().trim();
  for (const key in ORIGIN_NORMALIZE) {
    if (lower.indexOf(key) >= 0) return ORIGIN_NORMALIZE[key];
  }
  return null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// ═══ BASETAXI : attente taxi aux aeroports ═══

const BASETAXI_URLS = {
  cdg:  'https://infotaxi.parisaeroport.fr/cdg',
  orly: 'https://infotaxi.parisaeroport.fr/orly'
};

const BASETAXI_CACHE_TTL_SEC      = 90;
const REPORT_DEDUP_WINDOW_SEC     = 25 * 60;
const REPORTS_KEEP_WINDOW_SEC     = 30 * 60;
const CROWD_VALIDITY_WINDOW_SEC   = 25 * 60;

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

// ═══════════════════════════════════════════════════════════════════
//  EUROSTAR : PARSING JSON-FIRST
// ═══════════════════════════════════════════════════════════════════

function parseISODateTimeToHM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d{2}):(\d{2}):/);
  return m ? (m[1] + ':' + m[2]) : null;
}

function extractServiceObjects(html) {
  const services = [];
  const trainNumberRegex = /"trainNumber":"(\d{4})"/g;
  let match;
  const seenStarts = new Set();

  while ((match = trainNumberRegex.exec(html)) !== null) {
    const anchorPos = match.index;
    let depth = 0;
    let serviceStart = -1;
    for (let i = anchorPos; i >= 0; i--) {
      const c = html[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          serviceStart = i;
          break;
        } else {
          depth--;
        }
      }
    }

    if (serviceStart < 0) continue;

    depth = 0;
    let parentStart = -1;
    for (let i = serviceStart - 1; i >= 0; i--) {
      const c = html[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          parentStart = i;
          break;
        } else {
          depth--;
        }
      }
    }

    if (parentStart < 0 || seenStarts.has(parentStart)) continue;
    seenStarts.add(parentStart);

    depth = 0;
    let parentEnd = -1;
    for (let i = parentStart; i < html.length; i++) {
      const c = html[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          parentEnd = i + 1;
          break;
        }
      }
    }

    if (parentEnd < 0) continue;

    const objStr = html.substring(parentStart, parentEnd);

    if (objStr.indexOf('"trainNumber":"' + match[1] + '"') < 0) continue;
    if (objStr.indexOf('"origin"') < 0 || objStr.indexOf('"destination"') < 0) continue;

    services.push({ json: objStr, trainNumber: match[1] });
  }

  return services;
}

function parseServiceJSON(serviceStr) {
  try {
    const obj = JSON.parse(serviceStr);

    const carrier = obj.model && obj.model.carrier ? obj.model.carrier : '';
    const trainNumber = obj.model && obj.model.trainNumber ? obj.model.trainNumber : '';
    if (!carrier || !trainNumber) return null;

    const num = carrier.toUpperCase() + trainNumber;

    const origin = obj.origin || {};
    const originStation = origin.station || {};
    const originName = (originStation.name && (originStation.name.fr || originStation.name.en)) || null;
    const originUic = originStation.uic || null;

    const dest = obj.destination || {};
    const destStation = dest.station || {};
    const destUic = destStation.uic || null;
    if (destUic !== '8727100') return null;

    const departTheo = parseISODateTimeToHM(origin.model && origin.model.scheduledDepartureDateTime);
    const arriveeTheo = parseISODateTimeToHM(dest.model && dest.model.scheduledArrivalDateTime);
    const arriveeReelle = parseISODateTimeToHM(dest.model && dest.model.expectedArrivalDateTime);

    const isCancelled = (obj.model && obj.model.isCancelled) ||
                        (origin.model && origin.model.isCancelled) ||
                        (dest.model && dest.model.isCancelled);
    const arrivalStatus = (dest.model && dest.model.arrivalStatus) || '';

    let status = 'ok';
    if (isCancelled || arrivalStatus === 'CANCELLED') {
      status = 'cancelled';
    } else if (arrivalStatus === 'DELAYED' || (arriveeReelle && arriveeReelle !== arriveeTheo)) {
      status = 'delayed';
    } else if (arrivalStatus === 'ARRIVED') {
      status = 'arrived';
    }

    const newTime = (status === 'delayed' && arriveeReelle) ? arriveeReelle : null;

    let delayMinutes = null;
    const destNews = dest.news;
    if (Array.isArray(destNews) && destNews.length > 0) {
      for (const n of destNews) {
        if (n && n.ssnRelation && typeof n.ssnRelation.arrivalDelay === 'number' && n.ssnRelation.arrivalDelay > 0) {
          delayMinutes = n.ssnRelation.arrivalDelay;
          break;
        }
      }
    }

    return {
      num: num,
      train: {
        status: status,
        newTime: newTime,
        arriveeParis: arriveeTheo,
        departOrigine: departTheo,
        origine: normalizeOrigin(originName) || originName || 'Inconnue',
        originUic: originUic,
        delayMinutes: delayMinutes
      }
    };
  } catch (e) {
    return null;
  }
}

function parseHTML(html, src) {
  const trains = {};

  try {
    const services = extractServiceObjects(html);
    for (const svc of services) {
      const parsed = parseServiceJSON(svc.json);
      if (!parsed) continue;
      const existing = trains[parsed.num];
      if (!existing ||
          (existing.status === 'ok' && parsed.train.status !== 'ok') ||
          (existing.status === 'delayed' && parsed.train.status === 'cancelled')) {
        trains[parsed.num] = parsed.train;
      }
    }
  } catch (e) { /* fallback */ }

  if (Object.keys(trains).length > 0) return trains;

  const text = stripHTML(html);
  const textNorm = text
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .replace(/[ùûü]/g, 'u')
    .replace(/[ç]/g, 'c');

  const richRegex = /train[\s:.\-]*(ES|ER)\s*(\d{4})\s*([-\-]\s*(Retarde|Train\s+annule|Cancelled|Delayed|Annule))?\s+([A-Z][A-Za-z\-\s']+?)\s+Paris\s+Gare\s+du\s+Nord\s+(\d{2}):(\d{2})\s+(\d{2}):(\d{2})/gi;

  let m;
  while ((m = richRegex.exec(textNorm)) !== null) {
    const num = m[1].toUpperCase() + m[2];
    const statusTxt = (m[4] || '').toLowerCase();
    const originRaw = m[5];
    const departH = m[6] + ':' + m[7];
    const arriveeH = m[8] + ':' + m[9];

    let status = 'ok';
    if (statusTxt.indexOf('annul') >= 0 || statusTxt.indexOf('cancel') >= 0) status = 'cancelled';
    else if (statusTxt.indexOf('retard') >= 0 || statusTxt.indexOf('delay') >= 0) status = 'delayed';

    let newTime = null;
    if (status === 'delayed') {
      const snippet = textNorm.substring(m.index, m.index + 1500);
      const envRegex = /Env\.\s*(\d{2}):(\d{2})/g;
      let em, last = null;
      while ((em = envRegex.exec(snippet)) !== null) last = em;
      if (last) newTime = last[1] + ':' + last[2];
    }

    const originNormalized = normalizeOrigin(originRaw) || src;
    const existing = trains[num];
    if (!existing ||
        (existing.status === 'ok' && status !== 'ok') ||
        (existing.status === 'delayed' && status === 'cancelled')) {
      trains[num] = {
        status: status,
        newTime: newTime,
        arriveeParis: arriveeH,
        departOrigine: departH,
        origine: originNormalized,
        originUic: null,
        delayMinutes: null
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

  const ORIGIN_PRIORITY = {
    'Cologne Hbf':         100,
    'Amsterdam Centraal':   90,
    'Rotterdam Centraal':   85,
    'Anvers-Central':       80,
    'Bruxelles-Midi':       50,
    'Liege-Guillemins':     45,
    'Lille Europe':         40,
    'Londres St Pancras':  100
  };
  function originScore(name) {
    return ORIGIN_PRIORITY[name] || 30;
  }

  const promises = EUROSTAR_URLS.map(async function(item) {
    const r = await fetchOne(item.url, item.src);
    for (const k in r.trains) {
      const incoming = r.trains[k];
      const existing = result.trains[k];
      if (!existing) {
        result.trains[k] = incoming;
      } else {
        const sIncoming = originScore(incoming.origine);
        const sExisting = originScore(existing.origine);
        if (sIncoming > sExisting) {
          result.trains[k] = incoming;
        } else if (sIncoming === sExisting) {
          const order = { ok: 0, arrived: 1, delayed: 2, cancelled: 3 };
          if ((order[incoming.status] || 0) > (order[existing.status] || 0)) {
            result.trains[k] = incoming;
          }
        }
      }
    }
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

// ═══ TICKETMASTER : check if key configured ═══
function hasTicketmaster() {
  try {
    return typeof TICKETMASTER_KEY !== 'undefined' && TICKETMASTER_KEY && TICKETMASTER_KEY.length > 10;
  } catch (e) {
    return false;
  }
}

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

  const re1 = /(\d{1,3})\s*(?:min(?:utes?)?)\b/g;
  let m;
  while ((m = re1.exec(textNorm)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 240) {
      candidates.push({ value: n, idx: m.index, ctx: textNorm.substr(Math.max(0, m.index - 30), 60) });
    }
  }

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

  const strong = candidates.filter(c => c.strong);
  const pool = strong.length ? strong : candidates;
  const max = pool.reduce((a, b) => b.value > a.value ? b : a, pool[0]);

  return { wait_min: max.value, candidates: candidates.slice(0, 10) };
}

async function fetchBaseTaxiLive(aero) {
  const cacheKey = 'basetaxi_live_' + aero;

  if (hasKV()) {
    try {
      const cached = await TAXI_KV.get(cacheKey, { type: 'json' });
      if (cached && cached.ts && (Date.now() - cached.ts) < BASETAXI_CACHE_TTL_SEC * 1000) {
        return Object.assign({ cached: true }, cached);
      }
    } catch (e) {}
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

  let html = '';
  try {
    const resp = await fetch('https://chrome.browserless.io/content?token=' + BROWSERLESS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 25000 },
        waitFor: 2500
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

  if (hasKV()) {
    try {
      await TAXI_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: BASETAXI_CACHE_TTL_SEC + 30 });
    } catch (e) {}
  }

  return result;
}

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
  const ipHash = await hashIP(ip);
  const key = 'basetaxi_reports_' + aero;

  let reports = [];
  try {
    const stored = await TAXI_KV.get(key, { type: 'json' });
    if (Array.isArray(stored)) reports = stored;
  } catch (e) {}

  const now = Date.now();
  reports = reports.filter(r => (now - r.ts) < REPORTS_KEEP_WINDOW_SEC * 1000);

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
  if (!hasKV()) return { ok: false, reason: 'kv_not_configured' };
  if (!BASETAXI_URLS[aero]) return { ok: false, reason: 'invalid_aero' };

  const key = 'basetaxi_reports_' + aero;
  let reports = [];
  try {
    const stored = await TAXI_KV.get(key, { type: 'json' });
    if (Array.isArray(stored)) reports = stored;
  } catch (e) {}

  const now = Date.now();
  const valid = reports.filter(r => (now - r.ts) < CROWD_VALIDITY_WINDOW_SEC * 1000);

  if (!valid.length) return { ok: true, aero: aero, wait_min: null, count: 0 };

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
//  EVENT CONFIRM v2
// ═══════════════════════════════════════════════════════════════════

const EVENT_CONFIRM_TTL_SEC = 90 * 60;
const VOTE_DEDUP_SEC = 5 * 60;
const QUORUM_FINISHED = 2;
const QUORUM_VETO = 2;
const MAX_VENUE_DIST_M = 800;
const MAX_DRIVERS_PER_IP = 3;
const VOTE_WINDOW_BEFORE_MIN = 30;
const VOTE_WINDOW_AFTER_MIN = 90;

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

function consolidateVotes(votes, finTs) {
  const now = Date.now();
  const valid = votes.filter(v => (now - v.ts) < EVENT_CONFIRM_TTL_SEC * 1000);

  const finishedVotes = valid.filter(v => v.status === 'finished');
  const notFinishedVotes = valid.filter(v => v.status === 'not_finished');
  const etaVotes = valid.filter(v => v.status === 'eta');

  const recentVeto = notFinishedVotes.filter(v => (now - v.ts) < 15 * 60 * 1000);
  const vetoActive = recentVeto.length >= QUORUM_VETO;

  const uniqueDrivers = new Set(finishedVotes.map(v => v.driverId));
  const confirmed = uniqueDrivers.size >= QUORUM_FINISHED && !vetoActive;

  const autoFinished = finTs && (now > finTs + 15 * 60 * 1000);

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

  if (status !== 'not_finished') {
    if (!body.finReelle || !/^\d{2}:\d{2}$/.test(body.finReelle)) {
      return { ok: false, reason: 'invalid_finReelle', expected: 'HH:MM' };
    }
  }

  if (!body.driverId || typeof body.driverId !== 'string' || body.driverId.length < 8) {
    return { ok: false, reason: 'missing_driverId' };
  }

  const ip = getClientIP(request);
  const ipHash = await hashIP(ip);
  const key = 'evconfirm:' + body.eventId;
  const now = Date.now();

  let record = null;
  try { record = await TAXI_KV.get(key, { type: 'json' }); } catch (e) { record = null; }
  if (!record || !Array.isArray(record.votes)) {
    record = { eventId: body.eventId, votes: [] };
  }

  record.votes = record.votes.filter(v => (now - v.ts) < EVENT_CONFIRM_TTL_SEC * 1000);

  const recentSame = record.votes.find(v =>
    v.driverId === body.driverId && (now - v.ts) < VOTE_DEDUP_SEC * 1000
  );
  if (recentSame) {
    recentSame.status = status;
    recentSame.finReelle = body.finReelle || recentSame.finReelle;
    recentSame.ts = now;
  } else {
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

  try {
    await TAXI_KV.put(key, JSON.stringify(record), { expirationTtl: EVENT_CONFIRM_TTL_SEC });
  } catch (e) {
    return { ok: false, reason: 'kv_put_failed', message: e.message };
  }

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
      finReelle: consolidated.finReelle || consolidated.etaReelle,
      status: consolidated.confirmed ? 'finished' : (consolidated.etaReelle ? 'eta' : null),
      ts: rec.votes.length ? Math.max(...rec.votes.map(v => v.ts)) : 0
    };
  } catch (e) {
    return { ok: false, reason: 'kv_read_failed', message: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TICKETMASTER : events Paris (cache 6h KV) — V6 NEW
// ═══════════════════════════════════════════════════════════════════

// Mapping venue Ticketmaster -> code venue TaxiPulse (matching par nom)
function mapVenueCodeTM(venue) {
  if (!venue) return null;
  // Normalise: minuscule + retire accents (gere 'Défense' / 'D??fense' / 'defense')
  const raw = (venue.name || '').toLowerCase();
  const name = raw
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .replace(/[ùûü]/g, 'u')
    .replace(/[ç]/g, 'c')
    .replace(/\?\?/g, 'e');  // encoding casse: D??fense -> Defense

  if (name.indexOf('accor arena') >= 0 || name.indexOf('bercy arena') >= 0 || name.indexOf('palais omnisports') >= 0) return 'bercy_arena';
  if (name.indexOf('defense arena') >= 0 || name.indexOf('paris la defense') >= 0) return 'defense_arena';
  if (name.indexOf('adidas arena') >= 0) return 'adidas_arena';
  if (name.indexOf('stade de france') >= 0) return 'stade_france';
  if (name.indexOf('parc des princes') >= 0) return 'parc_princes';
  if (name.indexOf('zenith') >= 0) return 'zenith';
  if (name.indexOf('olympia') >= 0) return 'olympia';
  if (name.indexOf('bataclan') >= 0) return 'bataclan';
  if (name.indexOf('seine musicale') >= 0) return 'seine_musicale';
  if (name.indexOf('philharmonie') >= 0) return 'philharmonie';
  if (name.indexOf('cigale') >= 0) return 'cigale';
  if (name.indexOf('trianon') >= 0) return 'trianon';
  if (name.indexOf('salle pleyel') >= 0) return 'salle_pleyel';
  if (name.indexOf('grand rex') >= 0) return 'grand_rex';
  if (name.indexOf('casino de paris') >= 0) return 'casino_paris';
  if (name.indexOf('elysee montmartre') >= 0) return 'elysee_montmartre';
  return null;
}

// Duree concert estimee selon venue (minutes)
const DUREE_CONCERT_TM = {
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

function addMinutesTM(hhmm, mins) {
  const parts = hhmm.split(':').map(Number);
  const total = parts[0] * 60 + parts[1] + mins;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return String(newH).padStart(2, '0') + ':' + String(newM).padStart(2, '0');
}

function mapTmEvent(e) {
  const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
  const venueCode = mapVenueCodeTM(venue);
  if (!venueCode) return null;

  const startDate = e.dates && e.dates.start && e.dates.start.localDate;
  if (!startDate) return null;

  const startTimeRaw = (e.dates && e.dates.start && e.dates.start.localTime) || '20:00:00';
  const heureDebut = startTimeRaw.substring(0, 5);

  const dureeMin = DUREE_CONCERT_TM[venueCode] || 150;
  const heureFin = addMinutesTM(heureDebut, dureeMin);

  const titre = (e.name || '').trim();
  const hasOfficialTime = !!(e.dates && e.dates.start && e.dates.start.localTime);

  return {
    date: startDate,
    heure_debut: heureDebut,
    heure_fin: heureFin,
    venue: venueCode,
    titre: titre,
    cat: 'concert',
    source: 'ticketmaster',
    confirme: hasOfficialTime ? 'OUI' : 'APPROX',
    notes: 'tm_id:' + e.id,
    url: e.url || null,
    venue_name: (venue && venue.name) || null,
    status: (e.dates && e.dates.status && e.dates.status.code) || null
  };
}

async function fetchTicketmasterEvents(startDate, endDate, bypassCache) {
  const cacheKey = 'tm:events:' + startDate + ':' + endDate;

  // 1) Cache KV
  if (!bypassCache && hasKV()) {
    try {
      const cached = await TAXI_KV.get(cacheKey, { type: 'json' });
      if (cached) {
        return Object.assign({ source: 'cache' }, cached);
      }
    } catch (e) {}
  }

  if (!hasTicketmaster()) {
    return {
      ok: false,
      error: 'TICKETMASTER_KEY not configured',
      message: 'Run: npx wrangler secret put TICKETMASTER_KEY'
    };
  }

  // 2) Pagination Ticketmaster (max 200/page, max 5 pages = 1000 events)
  const allEvents = [];
  let page = 0;
  let totalPages = 1;
  const MAX_PAGES = 5;

  try {
    while (page < totalPages && page < MAX_PAGES) {
      const params = new URLSearchParams();
      params.set('apikey', TICKETMASTER_KEY);
      params.set('countryCode', 'FR');
      // Pas de filtre city : Ticketmaster ne gere pas city multi-valeurs.
      // On filtre nous-meme via mapVenueCodeTM (renvoie null pour venues hors radar)
      params.set('classificationName', 'Music');
      params.set('startDateTime', startDate + 'T00:00:00Z');
      params.set('endDateTime', endDate + 'T23:59:59Z');
      params.set('size', '200');
      params.set('page', String(page));
      // Pas de locale : 'fr-fr' fait rejeter l'API (DIS1008).
      // Les events FR sont indexes en en-us par defaut.
      // sort=date,asc concatene a la main : URLSearchParams encode la virgule en %2C
      // ce que Ticketmaster rejette (DIS1016 BAD_REQUEST)
      const tmUrl = 'https://app.ticketmaster.com/discovery/v2/events.json?' + params.toString() + '&sort=date,asc';
      const resp = await fetch(tmUrl);

      if (!resp.ok) {
        const errBody = await resp.text();
        return {
          ok: false,
          error: 'Ticketmaster API failed',
          status: resp.status,
          body: errBody.substring(0, 500)
        };
      }

      const data = await resp.json();
      const pageEvents = (data._embedded && data._embedded.events) || [];
      allEvents.push(...pageEvents);

      totalPages = (data.page && data.page.totalPages) || 1;
      page++;

      // Rate limit : 5 req/sec, on attend 250ms entre pages
      if (page < totalPages && page < MAX_PAGES) {
        await new Promise(r => setTimeout(r, 250));
      }
    }
  } catch (err) {
    return { ok: false, error: 'Fetch failed', message: err.message };
  }

  // 3) Mapping + filtrage venues parisiennes connues
  const mapped = allEvents.map(mapTmEvent).filter(Boolean);

  // 4) Dedup par date+venue+titre
  const seen = new Set();
  const events = mapped.filter(e => {
    const key = e.date + ':' + e.venue + ':' + e.titre;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 5) Stats
  const byVenue = {};
  events.forEach(e => { byVenue[e.venue] = (byVenue[e.venue] || 0) + 1; });

  const result = {
    ok: true,
    events: events,
    count: events.length,
    raw_count: allEvents.length,
    pages_fetched: page,
    by_venue: byVenue,
    range: { start: startDate, end: endDate },
    fetched_at: new Date().toISOString()
  };

  // 6) Cache 6h
  if (hasKV()) {
    try {
      await TAXI_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
    } catch (e) {}
  }

  return Object.assign({ source: 'fresh' }, result);
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
      } catch (err) {}
    }

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

  // ─── BASETAXI : CROWD ───
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

  // ─── BASETAXI : LIVE ───
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

  // ─── EVENT CONFIRM ───
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

  // ─── TICKETMASTER : events Paris (V6 NEW) ───
  // GET /events/ticketmaster?start=2026-05-01&end=2026-12-31&fresh=1
  if (path === '/events/ticketmaster' || path === '/events/ticketmaster/') {
    const today = new Date();
    const startDate = url.searchParams.get('start') || today.toISOString().split('T')[0];
    const defaultEnd = new Date(today.getTime() + 365 * 86400000);
    const endDate = url.searchParams.get('end') || defaultEnd.toISOString().split('T')[0];
    const bypassCache = url.searchParams.get('fresh') === '1';

    const result = await fetchTicketmasterEvents(startDate, endDate, bypassCache);
    return new Response(JSON.stringify(result), {
      status: result.ok === false ? 500 : 200,
      headers: Object.assign({}, CORS_HEADERS, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      })
    });
  }

  // ─── EVENT FRESHNESS ───
  if (path === '/events/health' || path === '/events/checklist') {
    const result = await analyzeEventsFreshness();
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/events/test-email' && request.method === 'POST') {
    const result = await analyzeEventsFreshness();
    const r = await sendFreshnessRecapEmail(result);
    return new Response(JSON.stringify(r, null, 2), {
      status: r.ok ? 200 : 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/events/run-recap' && request.method === 'POST') {
    const result = await analyzeEventsFreshness();
    const emailResult = await sendFreshnessRecapEmail(result);
    return new Response(JSON.stringify({ analysis: result, email: emailResult }, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  // ─── EVENTS AGGREGATOR (V7 NEW) — multi-sources QFAP Mairie ───
  // GET /events/aggregate?dry=1  -> n'envoie pas d'email
  // GET /events/aggregate        -> envoie l'email récap
  if (path === '/events/aggregate' || path === '/events/aggregate/') {
    try {
      const dryRun = url.searchParams.get('dry') === '1';
      const result = await handleAggregateEvents(dryRun);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }, null, 2), {
        status: 500,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
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


// ═══════════════════════════════════════════════════════════════════
//  EVENTS AGGREGATOR V7 — Source QFAP Mairie de Paris (sans clé)
//  Cron quotidien -> détection nouveaux events + email récap
// ═══════════════════════════════════════════════════════════════════

const QFAP_VENUE_MAPPING = {
  // Sport
  "stade jean bouin": "jean_bouin",
  "stade jean-bouin": "jean_bouin",
  "jean bouin": "jean_bouin",
  "jean-bouin": "jean_bouin",
  "stade charlety": "charlety",
  "stade charléty": "charlety",
  "stade sébastien charléty": "charlety",
  "charléty": "charlety",
  "parc des princes": "parc_princes",
  "stade de france": "stade_france",
  "roland-garros": "roland_garros",
  "roland garros": "roland_garros",
  "stade roland-garros": "roland_garros",
  "hippodrome de vincennes": "vincennes",
  "hippodrome paris-longchamp": "longchamp",
  "hippodrome de longchamp": "longchamp",
  "hippodrome d'auteuil": "auteuil",
  // Concerts / salles
  "le bataclan": "bataclan",
  "bataclan": "bataclan",
  "olympia": "olympia",
  "l'olympia": "olympia",
  "zénith de paris": "zenith",
  "zenith de paris": "zenith",
  "le zénith": "zenith",
  "accor arena": "bercy_arena",
  "accor arena bercy": "bercy_arena",
  "bercy arena": "bercy_arena",
  "adidas arena": "adidas_arena",
  "paris la défense arena": "defense_arena",
  "la défense arena": "defense_arena",
  "la seine musicale": "seine_musicale",
  "salle pleyel": "salle_pleyel",
  "philharmonie de paris": "philharmonie",
  "le trianon": "trianon",
  "la cigale": "cigale",
  "le cabaret sauvage": "cabaret_sauvage",
  "le grand rex": "grand_rex",
  // Théâtres / Opéras
  "opéra bastille": "opera_bastille",
  "opera bastille": "opera_bastille",
  "opéra garnier": "opera_garnier",
  "palais garnier": "opera_garnier",
  "comédie-française": "comedie_francaise",
  "théâtre du châtelet": "chatelet",
  "théâtre des champs-élysées": "champs_elysees",
  "théâtre mogador": "mogador",
  "théâtre marigny": "marigny",
  // Salons / Expos
  "grand palais": "grand_palais",
  "petit palais": "petit_palais",
  "paris expo porte de versailles": "porte_versailles",
  "porte de versailles": "porte_versailles",
  "parc des expositions de villepinte": "villepinte",
  "paris-le bourget": "le_bourget",
  // Plein air
  "domaine national de saint-cloud": "saint_cloud"
};

function qfapDetectVenue(rawVenue) {
  if (!rawVenue) return null;
  const v = String(rawVenue).toLowerCase().trim();
  if (QFAP_VENUE_MAPPING[v]) return QFAP_VENUE_MAPPING[v];
  for (const key in QFAP_VENUE_MAPPING) {
    if (v.indexOf(key) !== -1) return QFAP_VENUE_MAPPING[key];
  }
  return null;
}

// Catégorie par défaut selon la venue (si rien détecté dans titre/tags)
const VENUE_DEFAULT_CAT = {
  // Sport
  "jean_bouin": "sport",
  "charlety": "sport",
  "parc_princes": "sport",
  "stade_france": "sport",
  "roland_garros": "sport",
  "vincennes": "course",
  "longchamp": "course",
  "auteuil": "course",
  // Musique classique / opéra
  "philharmonie": "concert",
  "salle_pleyel": "concert",
  "opera_bastille": "opera",
  "opera_garnier": "opera",
  "champs_elysees": "concert",
  "seine_musicale": "concert",
  // Salles concerts / spectacles
  "bataclan": "concert",
  "olympia": "concert",
  "zenith": "concert",
  "bercy_arena": "concert",
  "adidas_arena": "concert",
  "defense_arena": "concert",
  "trianon": "concert",
  "cigale": "concert",
  "cabaret_sauvage": "concert",
  "grand_rex": "spectacle",
  // Théâtres
  "comedie_francaise": "theatre",
  "chatelet": "theatre",
  "mogador": "spectacle",
  "marigny": "theatre",
  // Expos/Salons
  "grand_palais": "exposition",
  "petit_palais": "exposition",
  "porte_versailles": "salon",
  "villepinte": "salon",
  "le_bourget": "salon",
  // Plein air
  "saint_cloud": "festival"
};

function qfapDetectCategory(title, venue, rawTags) {
  const t = (title || "").toLowerCase();
  const tags = (Array.isArray(rawTags) ? rawTags : []).map(function(x) { return String(x || "").toLowerCase(); }).join(" ");
  const all = t + " " + tags + " " + (venue || "");

  // 1) Sport (très spécifique d'abord)
  if (/\b(match|ligue 1|ligue 2|champion|coupe de france|coupe d'europe|psg|paris fc|paris-fc|stade français|stade-francais|top 14|pro d2|champion's cup|rugby|handball|hand|basket|nba|euroleague|volleyball)\b/.test(all)) return "sport";
  if (/\b(course|grand prix|hippodrome|prix d'amérique|trot|galop|steeple|marathon|10 km|trail|ekiden|triathlon|cyclisme)\b/.test(all)) return "course";

  // 2) Musique - genres précis
  if (/\b(opéra|opera|récital|recital|cantate|symphonie|symphonique|orchestre|philharmonique|requiem|messe|oratorio)\b/.test(all)) return "opera";
  if (/\b(concert|live|tour|tournée|tourne|festival musical|musique|gig|showcase|fanfare|jazz|rock|pop|rap|hip-hop|électro|electro|techno|house|reggae|metal|punk|folk|blues|classique|baroque|chorale|chœur)\b/.test(all)) return "concert";

  // 3) Spectacle vivant
  if (/\b(ballet|chorégraphi|chorégraphe|danse|danseur|hip hop|krump|breaking|flamenco)\b/.test(all)) return "danse";
  if (/\b(théâtre|theatre|piece|comédie|tragédie|monologue|dramaturgi|mise en scène)\b/.test(all)) return "theatre";
  if (/\b(humour|stand[- ]?up|one[- ]?man[- ]?show|one[- ]?woman[- ]?show|sketch|impro|improvisation)\b/.test(all)) return "humour";
  if (/\b(cirque|magie|magicien|mentaliste|illusion|cabaret|burlesque)\b/.test(all)) return "spectacle";

  // 4) Cinéma
  if (/\b(film|cinéma|cinema|projection|avant[- ]première|festival cinéma|courts? métrages?)\b/.test(all)) return "cinema";

  // 5) Expos / culture
  if (/\b(exposition|expo|vernissage|rétrospective|musée|museum|galerie|installation|sculpture|peinture|photographie|nuit blanche)\b/.test(all)) return "exposition";

  // 6) Salons / Foires
  if (/\b(salon|foire|congrès|congres|convention|fipa|sial|maison & objet|expo internationale)\b/.test(all)) return "salon";

  // 7) Conférences
  if (/\b(conférence|conference|colloque|talk|table ronde|symposium|débat|masterclass|workshop|atelier)\b/.test(all)) return "conference";

  // 8) Vie publique
  if (/\b(manifestation|défilé|parade|hommage|cérémonie)\b/.test(all)) return "manifestation";

  // 9) Fallback : catégorie par défaut selon la venue
  if (venue && VENUE_DEFAULT_CAT[venue]) return VENUE_DEFAULT_CAT[venue];

  return "autre";
}

async function fetchQueFaireAParis(daysAhead) {
  daysAhead = daysAhead || 60;
  const today = new Date().toISOString().split("T")[0];
  const future = new Date(Date.now() + daysAhead * 86400000).toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];

  for (let page = 0; page < 5; page++) {
    const where = encodeURIComponent('date_start >= "' + today + '" AND date_start <= "' + future + '"');
    const orderBy = encodeURIComponent("date_start ASC");
    const apiUrl = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?limit=' + limit + '&offset=' + offset + '&where=' + where + '&order_by=' + orderBy;

    try {
      const r = await fetch(apiUrl, {
        headers: { "User-Agent": "TaxiPulse/1.0 (+https://taxipulse.fr)" },
        cf: { cacheTtl: 1800 }
      });
      if (!r.ok) {
        console.error('[QFAP] HTTP ' + r.status);
        break;
      }
      const data = await r.json();
      const results = data.results || [];
      if (results.length === 0) break;

      for (let i = 0; i < results.length; i++) {
        const e = results[i];
        const venue = qfapDetectVenue(e.address_name);
        if (!venue) continue;

        const dateStart = String(e.date_start || "").split("T")[0];
        const dateEnd = String(e.date_end || "").split("T")[0];
        const tStart = String(e.date_start || "").split("T")[1];
        const timeStart = tStart ? tStart.slice(0, 5) : "20:00";
        const tEnd = String(e.date_end || "").split("T")[1];
        const timeEnd = tEnd ? tEnd.slice(0, 5) : "";

        all.push({
          source: "qfap",
          source_id: e.id || "",
          source_url: e.url || "",
          date: dateStart,
          date_end: dateEnd,
          heure_debut: timeStart,
          heure_fin: timeEnd,
          venue: venue,
          venue_raw: e.address_name || "",
          titre: String(e.title || "").trim().slice(0, 120),
          cat: qfapDetectCategory(e.title, venue, e.tags || []),
          confirme: "OUI",
          notes: "QFAP Mairie auto"
        });
      }

      if (results.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error('[QFAP] error:', err.message);
      break;
    }
  }
  return all;
}

function dedupAggregatedEvents(events) {
  const seen = {};
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const key = e.date + "|" + e.venue + "|" + (e.titre || "").toLowerCase().slice(0, 15).replace(/\s/g, "");
    if (seen[key]) continue;
    seen[key] = true;
    out.push(e);
  }
  return out;
}

async function compareWithMasterSheet(newEvents) {
  // On compare avec le CSV publié (même source que analyzeEventsFreshness)
  let masterRaw = null;
  try {
    const r = await fetch(SHEET_EVENTS_CSV_URL, { cf: { cacheTtl: 60 } });
    if (r.ok) masterRaw = await r.text();
  } catch (e) {
    masterRaw = null;
  }

  if (!masterRaw) return { news: newEvents, changes: [], master_lines: 0 };

  const lines = masterRaw.split(/\r?\n/).slice(1);
  const masterKeys = {};
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const h_deb = parts[1];
    const venue = parts[3];
    const titre = parts[4];
    if (!date || !venue) continue;
    const key = date + "|" + venue + "|" + (titre || "").toLowerCase().slice(0, 15).replace(/\s/g, "");
    masterKeys[key] = { date: date, h_deb: h_deb, venue: venue, titre: titre };
  }

  const news = [];
  const changes = [];
  for (let i = 0; i < newEvents.length; i++) {
    const e = newEvents[i];
    const key = e.date + "|" + e.venue + "|" + (e.titre || "").toLowerCase().slice(0, 15).replace(/\s/g, "");
    if (!masterKeys[key]) {
      news.push(e);
    } else {
      const old = masterKeys[key];
      if (old.h_deb !== e.heure_debut && e.heure_debut !== "20:00") {
        changes.push({ event: e, old_time: old.h_deb, new_time: e.heure_debut });
      }
    }
  }
  return { news: news, changes: changes, master_lines: lines.length };
}

async function sendAggregatorRecap(diff, totalFetched) {
  const news = diff.news;
  const changes = diff.changes;
  if (news.length === 0 && changes.length === 0) {
    return { sent: false, reason: "rien à signaler" };
  }

  let apiKey = null;
  let adminEmail = null;
  try {
    apiKey = (typeof RESEND_API_KEY !== 'undefined') ? RESEND_API_KEY : null;
    adminEmail = (typeof ADMIN_EMAIL !== 'undefined') ? ADMIN_EMAIL : null;
  } catch (e) {
    apiKey = null;
    adminEmail = null;
  }

  if (!apiKey || !adminEmail) {
    return { sent: false, reason: "config manquante (RESEND_API_KEY ou ADMIN_EMAIL)" };
  }

  const newsRows = news.slice(0, 50).map(function(e) {
    return '<tr style="border-top:1px solid #ddd;">'
      + '<td style="padding:6px 8px;">' + escapeHtml(e.date) + '</td>'
      + '<td style="padding:6px 8px;">' + escapeHtml(e.heure_debut) + '</td>'
      + '<td style="padding:6px 8px;">' + escapeHtml(e.venue) + '</td>'
      + '<td style="padding:6px 8px;">' + escapeHtml(e.titre) + '</td>'
      + '<td style="padding:6px 8px;">' + escapeHtml(e.cat) + '</td>'
      + '</tr>';
  }).join("");

  const changesRows = changes.map(function(c) {
    return '<li><b>' + escapeHtml(c.event.date) + ' ' + escapeHtml(c.event.venue) + '</b> : ' + escapeHtml(c.old_time) + ' → ' + escapeHtml(c.new_time) + ' — ' + escapeHtml(c.event.titre) + '</li>';
  }).join("");

  const html = '<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:20px;">'
    + '<h2 style="color:#ea580c;">🤖 TaxiPulse — Aggregator quotidien</h2>'
    + '<p style="color:#6b7280;font-size:13px;">' + new Date().toISOString().slice(0, 16).replace("T", " ") + ' UTC<br>'
    + totalFetched + ' events QFAP scannés, ' + news.length + ' nouveaux, ' + changes.length + ' changements.</p>'
    + (news.length > 0 ? '<h3>🆕 Nouveaux events détectés (' + news.length + ')</h3>'
        + '<table style="border-collapse:collapse;font-size:13px;width:100%;">'
        + '<tr style="background:#f3f4f6;"><th style="padding:6px 8px;text-align:left;">Date</th><th style="padding:6px 8px;text-align:left;">Heure</th><th style="padding:6px 8px;text-align:left;">Venue</th><th style="padding:6px 8px;text-align:left;">Titre</th><th style="padding:6px 8px;text-align:left;">Cat</th></tr>'
        + newsRows
        + '</table>' : '')
    + (changes.length > 0 ? '<h3>⚠️ Changements horaires (' + changes.length + ')</h3><ul>' + changesRows + '</ul>' : '')
    + '<hr><p style="font-size:11px;color:#9ca3af;">Source : Que Faire à Paris (Mairie). Action : valider et coller dans le Sheet master.</p>'
    + '</body></html>';

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "TaxiPulse Aggregator <noreply@taxipulse.fr>",
        to: adminEmail,
        subject: "🤖 TaxiPulse Aggregator : " + news.length + " new + " + changes.length + " chgmts",
        html: html
      })
    });
    return { sent: r.ok, count: news.length + changes.length, status: r.status };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

async function handleAggregateEvents(dryRun) {
  const events = await fetchQueFaireAParis(60);
  const validated = dedupAggregatedEvents(events);
  const diff = await compareWithMasterSheet(validated);

  // Stocker dernier résultat dans KV (si dispo)
  try {
    if (typeof TAXI_KV !== 'undefined' && TAXI_KV !== null) {
      await TAXI_KV.put(
        'events_aggregator_last_run',
        JSON.stringify({
          ts: Date.now(),
          total_fetched: events.length,
          after_dedup: validated.length,
          news: diff.news.length,
          changes: diff.changes.length,
          master_lines: diff.master_lines
        }),
        { expirationTtl: 86400 * 7 }
      );
    }
  } catch (e) {}

  let mailResult = { sent: false, reason: "dry run" };
  if (!dryRun) {
    mailResult = await sendAggregatorRecap(diff, events.length);
  }

  return {
    ok: true,
    total_fetched: events.length,
    after_dedup: validated.length,
    news: diff.news.length,
    changes: diff.changes.length,
    master_lines: diff.master_lines,
    preview_news: diff.news.slice(0, 10),
    preview_changes: diff.changes.slice(0, 5),
    mail: mailResult
  };
}


// ═══════════════════════════════════════════════════════════════════
//  PHASE B v2 : ALERTE FRAÎCHEUR DU SHEET + RÉCAP HEBDO PAR EMAIL
// ═══════════════════════════════════════════════════════════════════

const SHEET_EVENTS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTlb4vVopavpQHDKFkY4Su4HDtUo70FV7vEr7zllndq6-6duSSjDhkuBt9XP51PA3zn4nS9C8RFR8sb/pub?gid=0&single=true&output=csv';

const MONITORED_VENUES = [
  { id: 'stade_france',     name: 'Stade de France',           url: 'https://www.stadefrance.com/fr/billetteries' },
  { id: 'bercy_arena',      name: 'Accor Arena (Bercy)',       url: 'https://www.accorarena.com/fr/agenda' },
  { id: 'defense_arena',    name: 'Paris La Défense Arena',    url: 'https://www.parisladefense-arena.com/billetterie/' },
  { id: 'adidas_arena',     name: 'Adidas Arena',              url: 'https://www.adidasarena.com/programmation' },
  { id: 'olympia',          name: 'L\'Olympia',                 url: 'https://www.olympiahall.com/agenda/' },
  { id: 'zenith',           name: 'Zénith Paris',              url: 'https://le-zenith.com/program' },
  { id: 'seine_musicale',   name: 'La Seine Musicale',         url: 'https://www.laseinemusicale.com/programmation/' },
  { id: 'philharmonie',     name: 'Philharmonie de Paris',     url: 'https://philharmoniedeparis.fr/fr/agenda' },
  { id: 'bataclan',         name: 'Bataclan',                  url: 'https://www.bataclan.fr/' },
  { id: 'cigale',           name: 'La Cigale',                 url: 'https://www.lacigale.fr/' },
  { id: 'trianon',          name: 'Le Trianon',                url: 'https://www.letrianon.fr/' },
  { id: 'porte_versailles', name: 'Porte de Versailles',       url: 'https://www.viparis.com/nos-lieux/paris-expo-porte-de-versailles/agenda' },
  { id: 'villepinte',       name: 'Paris Nord Villepinte',     url: 'https://www.viparis.com/nos-lieux/paris-nord-villepinte/agenda' },
  { id: 'bourget',          name: 'Paris Le Bourget',          url: 'https://www.viparis.com/nos-lieux/paris-le-bourget/agenda' },
  { id: 'roland_garros',    name: 'Roland-Garros',             url: 'https://www.rolandgarros.com/' },
  { id: 'parc_princes',     name: 'Parc des Princes',          url: 'https://www.psg.fr/billetterie' }
];

function parseCSV(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// Compare events Ticketmaster avec le Sheet existant.
// Retourne uniquement les events Ticketmaster qui ne sont PAS deja dans le Sheet.
// Match par (date + venue + titre normalise) car les tm_id ne sont pas dans le Sheet.
async function findNewTicketmasterEvents() {
  const today = new Date();
  const start = today.toISOString().split('T')[0];
  const end = new Date(today.getTime() + 365 * 86400000).toISOString().split('T')[0];
  const tmResult = await fetchTicketmasterEvents(start, end, false);

  if (!tmResult.events || !tmResult.events.length) {
    return { ok: true, new_events: [], total_tm: 0, message: tmResult.error || 'No events from TM' };
  }

  let csvText = '';
  try {
    const r = await fetch(SHEET_EVENTS_CSV_URL, { cf: { cacheTtl: 0 } });
    if (!r.ok) return { ok: false, error: 'Sheet HTTP ' + r.status };
    csvText = await r.text();
  } catch (e) {
    return { ok: false, error: 'Sheet fetch failed: ' + e.message };
  }

  const sheetRows = parseCSV(csvText);

  function normTitle(t) {
    return (t || '').toLowerCase()
      .replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
      .replace(/[^a-z0-9]/g, '');
  }

  const sheetKeys = new Set();
  for (const row of sheetRows) {
    if (!row.date || !row.venue || !row.titre) continue;
    const key = row.date + '|' + row.venue.toLowerCase().trim() + '|' + normTitle(row.titre);
    sheetKeys.add(key);
  }

  const newEvents = [];
  for (const ev of tmResult.events) {
    const key = ev.date + '|' + ev.venue + '|' + normTitle(ev.titre);
    if (!sheetKeys.has(key)) {
      newEvents.push(ev);
    }
  }

  return {
    ok: true,
    total_tm: tmResult.events.length,
    total_sheet_rows: sheetRows.length,
    new_events: newEvents,
    new_count: newEvents.length
  };
}


async function analyzeEventsFreshness() {
  let csvText = '';
  try {
    const r = await fetch(SHEET_EVENTS_CSV_URL, { cf: { cacheTtl: 0 } });
    if (!r.ok) {
      return { ok: false, error: 'Sheet HTTP ' + r.status };
    }
    csvText = await r.text();
  } catch (e) {
    return { ok: false, error: 'Sheet fetch failed: ' + e.message };
  }

  const rows = parseCSV(csvText);
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);

  const upcoming = rows.filter(r => {
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return false;
    if (r.date < todayStr) return false;
    const conf = (r.confirme || '').trim().toUpperCase();
    return conf === 'OUI' || conf === 'YES' || conf === 'TRUE' || conf === '1';
  });

  const stats = {};
  for (const venue of MONITORED_VENUES) {
    stats[venue.id] = {
      venue_name: venue.name,
      url: venue.url,
      total: 0,
      next_30d: 0,
      next_60d: 0,
      next_90d: 0,
      beyond_90d: 0,
      latest_date: null,
      first_date: null
    };
  }
  stats['_other'] = { venue_name: 'Autres venues', url: null, total: 0, next_30d: 0, next_60d: 0, next_90d: 0, beyond_90d: 0, latest_date: null, first_date: null };

  for (const row of upcoming) {
    const venueId = (row.venue || '').trim().toLowerCase();
    const bucket = stats[venueId] || stats['_other'];

    bucket.total++;
    const evDate = new Date(row.date);
    const daysAhead = Math.floor((evDate.getTime() - now) / (24 * 3600 * 1000));
    if (daysAhead <= 30) bucket.next_30d++;
    else if (daysAhead <= 60) bucket.next_60d++;
    else if (daysAhead <= 90) bucket.next_90d++;
    else bucket.beyond_90d++;

    if (!bucket.first_date || row.date < bucket.first_date) bucket.first_date = row.date;
    if (!bucket.latest_date || row.date > bucket.latest_date) bucket.latest_date = row.date;
  }

  const alerts = [];
  for (const venue of MONITORED_VENUES) {
    const s = stats[venue.id];
    if (s.total === 0) {
      alerts.push({ level: 'critical', venue: venue.id, venue_name: venue.name, url: venue.url, message: 'Aucun event à venir dans le Sheet' });
    } else if (s.next_30d === 0 && s.next_60d === 0) {
      alerts.push({ level: 'warning', venue: venue.id, venue_name: venue.name, url: venue.url, message: 'Aucun event dans les 60 prochains jours' });
    } else if (s.next_30d === 0) {
      alerts.push({ level: 'info', venue: venue.id, venue_name: venue.name, url: venue.url, message: 'Aucun event dans les 30 prochains jours' });
    }
  }

  const totalUpcoming = upcoming.length;
  const upcomingNext30 = upcoming.filter(r => {
    const d = new Date(r.date);
    return (d.getTime() - now) <= 30 * 24 * 3600 * 1000;
  }).length;

  return {
    ok: true,
    timestamp: now,
    timestamp_iso: new Date(now).toISOString(),
    sheet_total_rows: rows.length,
    upcoming_total: totalUpcoming,
    upcoming_next_30d: upcomingNext30,
    venues: stats,
    alerts: alerts,
    alert_levels: {
      critical: alerts.filter(a => a.level === 'critical').length,
      warning: alerts.filter(a => a.level === 'warning').length,
      info: alerts.filter(a => a.level === 'info').length
    }
  };
}

async function sendFreshnessRecapEmail(analysis) {
  let apiKey = null;
  let adminEmail = null;
  try {
    apiKey = (typeof RESEND_API_KEY !== 'undefined') ? RESEND_API_KEY : null;
    adminEmail = (typeof ADMIN_EMAIL !== 'undefined') ? ADMIN_EMAIL : null;
  } catch (e) {
    apiKey = null;
    adminEmail = null;
  }

  if (!apiKey) {
    return { ok: false, reason: 'missing_resend_key', message: 'RESEND_API_KEY not configured. Run: npx wrangler secret put RESEND_API_KEY' };
  }
  if (!adminEmail) {
    return { ok: false, reason: 'missing_admin_email', message: 'ADMIN_EMAIL not configured. Run: npx wrangler secret put ADMIN_EMAIL' };
  }

  if (!analysis || !analysis.ok) {
    return { ok: false, reason: 'no_analysis', message: 'analyzeEventsFreshness failed: ' + (analysis ? analysis.error : 'unknown') };
  }

  // Fetch nouveaux events Ticketmaster (silencieux si erreur)
  let tmDiff = null;
  try {
    tmDiff = await findNewTicketmasterEvents();
  } catch (e) {
    tmDiff = { ok: false, error: e.message };
  }

  const dateStr = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const status = analysis.alert_levels.critical > 0 ? '🔴 ALERTE'
               : analysis.alert_levels.warning > 0 ? '🟡 ATTENTION'
               : '✅ OK';
  const tmNew = (tmDiff && tmDiff.ok) ? tmDiff.new_count : 0;
  const tmSuffix = tmNew > 0 ? `, ${tmNew} new TM` : '';
  const subject = `[TaxiPulse] ${status} — ${analysis.upcoming_total} events, ${analysis.alerts.length} alertes${tmSuffix}`;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1f2937;background:#f9fafb;">
    <div style="background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <h1 style="color:#ea580c;margin-top:0;font-size:24px;">🚖 TaxiPulse — Récap hebdo</h1>
      <p style="color:#6b7280;font-size:14px;text-transform:capitalize;">${dateStr}</p>

      <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div><strong style="font-size:24px;color:#1f2937;">${analysis.upcoming_total}</strong><br><span style="color:#6b7280;font-size:13px;">events à venir</span></div>
          <div><strong style="font-size:24px;color:#16a34a;">${analysis.upcoming_next_30d}</strong><br><span style="color:#6b7280;font-size:13px;">dans les 30 jours</span></div>
          <div><strong style="font-size:24px;color:${analysis.alert_levels.critical > 0 ? '#dc2626' : analysis.alert_levels.warning > 0 ? '#d97706' : '#16a34a'};">${analysis.alerts.length}</strong><br><span style="color:#6b7280;font-size:13px;">alertes</span></div>
        </div>
      </div>`;

  if (analysis.alerts.length > 0) {
    html += `<h2 style="color:#dc2626;font-size:18px;margin-top:24px;">⚠️ Lieux à checker en priorité</h2>
      <p style="color:#6b7280;font-size:14px;">Clique sur les liens ci-dessous, scrolle leur page programmation, et ajoute les nouveaux events dans ton Google Sheet.</p>
      <ul style="list-style:none;padding:0;">`;
    for (const alert of analysis.alerts) {
      const color = alert.level === 'critical' ? '#dc2626' : alert.level === 'warning' ? '#d97706' : '#3b82f6';
      const icon = alert.level === 'critical' ? '🔴' : alert.level === 'warning' ? '🟡' : '🔵';
      html += `<li style="background:#fff;border-left:4px solid ${color};padding:12px 16px;margin-bottom:8px;border-radius:6px;">
        <div style="font-weight:600;">${icon} ${escapeHtml(alert.venue_name)}</div>
        <div style="color:#6b7280;font-size:13px;margin:4px 0;">${escapeHtml(alert.message)}</div>
        ${alert.url ? `<a href="${escapeHtml(alert.url)}" style="color:#ea580c;text-decoration:none;font-size:13px;">→ Ouvrir le site officiel</a>` : ''}
      </li>`;
    }
    html += '</ul>';
  }

  // Section Ticketmaster : nouveaux events a ajouter au Sheet
  if (tmDiff && tmDiff.ok && tmDiff.new_count > 0) {
    html += `<h2 style="color:#7c3aed;font-size:18px;margin-top:24px;">🎫 ${tmDiff.new_count} nouveau${tmDiff.new_count > 1 ? 'x' : ''} event${tmDiff.new_count > 1 ? 's' : ''} Ticketmaster a ajouter au Sheet</h2>
      <p style="color:#6b7280;font-size:14px;">Detectes via l'API Ticketmaster, pas encore dans ton Google Sheet. Verifie les heures sur le site officiel puis copie-colle dans ton Sheet.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead><tr style="background:#f3f4f6;text-align:left;">
          <th style="padding:8px;">Date</th>
          <th style="padding:8px;">Heure</th>
          <th style="padding:8px;">Venue</th>
          <th style="padding:8px;">Titre</th>
          <th style="padding:8px;">Source</th>
        </tr></thead><tbody>`;
    for (const ev of tmDiff.new_events) {
      html += `<tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:8px;">${escapeHtml(ev.date)}</td>
        <td style="padding:8px;">${escapeHtml(ev.heure_debut)} - ${escapeHtml(ev.heure_fin)}</td>
        <td style="padding:8px;"><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(ev.venue)}</code></td>
        <td style="padding:8px;font-weight:500;">${escapeHtml(ev.titre)}</td>
        <td style="padding:8px;"><a href="${escapeHtml(ev.url || '#')}" style="color:#7c3aed;font-size:12px;">→ TM</a></td>
      </tr>`;
    }
    html += '</tbody></table>';
    html += `<p style="color:#9ca3af;font-size:12px;margin-top:8px;font-style:italic;">⚠️ Heures marquees APPROX : Ticketmaster ne fournit pas toujours l'heure officielle. Verifie sur le site venue.</p>`;
  }

  html += `<h2 style="font-size:18px;margin-top:24px;">📊 État de fraîcheur par venue</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f3f4f6;text-align:left;">
        <th style="padding:8px;">Venue</th>
        <th style="padding:8px;text-align:center;">Total</th>
        <th style="padding:8px;text-align:center;">30j</th>
        <th style="padding:8px;text-align:center;">60j</th>
        <th style="padding:8px;text-align:center;">90j+</th>
      </tr></thead><tbody>`;

  for (const venue of MONITORED_VENUES) {
    const s = analysis.venues[venue.id];
    const status30 = s.next_30d === 0 ? '#dc2626' : s.next_30d < 3 ? '#d97706' : '#16a34a';
    html += `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px;"><a href="${escapeHtml(venue.url)}" style="color:#ea580c;text-decoration:none;">${escapeHtml(venue.name)}</a></td>
      <td style="padding:8px;text-align:center;">${s.total}</td>
      <td style="padding:8px;text-align:center;color:${status30};font-weight:${s.next_30d === 0 ? '600' : '400'};">${s.next_30d}</td>
      <td style="padding:8px;text-align:center;">${s.next_60d}</td>
      <td style="padding:8px;text-align:center;">${s.next_90d + s.beyond_90d}</td>
    </tr>`;
  }
  html += '</tbody></table>';

  html += `<hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;">
    <p style="color:#6b7280;font-size:12px;line-height:1.5;">
      Email auto envoyé chaque lundi par le worker Cloudflare TaxiPulse.<br>
      Pour ajouter de nouveaux events, ouvre ton <a href="https://docs.google.com/spreadsheets/d/e/2PACX-1vTlb4vVopavpQHDKFkY4Su4HDtUo70FV7vEr7zllndq6-6duSSjDhkuBt9XP51PA3zn4nS9C8RFR8sb/pub?gid=0&single=true&output=csv" style="color:#ea580c;">Google Sheet</a>.<br>
      Pour désactiver ces emails : retire le cron dans wrangler.toml.
    </p>
    </div></body></html>`;

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
    const respText = await r.text();
    let data = null;
    try { data = JSON.parse(respText); } catch (e) { data = { raw: respText }; }
    return {
      ok: r.ok,
      status: r.status,
      response: data,
      sent_to: adminEmail.replace(/(.{2}).+(@.+)/, '$1***$2'),
      subject: subject
    };
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
//  CRON HANDLER
//  - "0 5 * * *"  (daily 5h UTC = 6/7h Paris) -> aggregator QFAP
//  - "0 6 * * 1"  (lundi 6h UTC)               -> récap fraîcheur Sheet
// ═══════════════════════════════════════════════════════════════════
async function handleScheduled(event, env) {
  const cron = event && event.cron ? event.cron : '';
  console.log('[CRON] Triggered:', cron);

  // Cron quotidien -> aggregator events
  if (cron === '0 5 * * *') {
    console.log('[CRON daily] Aggregator QFAP...');
    try {
      const result = await handleAggregateEvents(false);
      console.log('[CRON daily] Aggregator result:', JSON.stringify(result).substring(0, 400));
      return { type: 'aggregator', result: result };
    } catch (err) {
      console.error('[CRON daily] Error:', err.message);
      return { type: 'aggregator', error: err.message };
    }
  }

  // Cron hebdo (lundi) -> récap fraîcheur Sheet existant
  console.log('[CRON weekly] Récap hebdo : analyse Sheet...');
  const analysis = await analyzeEventsFreshness();
  console.log('[CRON weekly] Analyse :', JSON.stringify(analysis).substring(0, 500));

  const emailResult = await sendFreshnessRecapEmail(analysis);
  console.log('[CRON weekly] Email :', JSON.stringify(emailResult).substring(0, 300));

  return { type: 'weekly', analysis: analysis, emailResult: emailResult };
}


addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', function(event) {
  event.waitUntil(handleScheduled(event, null));
});
