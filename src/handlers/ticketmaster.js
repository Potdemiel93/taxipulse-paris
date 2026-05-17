// =============================================================================
// TaxiPulse — Handler Ticketmaster (events Paris cache 6h)
// Extrait de worker.js (lignes 443-451 + 907-1113 + 1332-1349)
// Converti pour utiliser env passé en paramètre
// =============================================================================

import { CORS_HEADERS, DUREE_CONCERT_TM } from '../lib/constants.js';
import { addMinutesTM } from '../lib/helpers.js';
import { hasKV } from './basetaxi.js';

// ─── hasTicketmaster : test de configuration ───
export function hasTicketmaster(env) {
  try {
    return env && typeof env.TICKETMASTER_KEY !== 'undefined' && env.TICKETMASTER_KEY && env.TICKETMASTER_KEY.length > 10;
  } catch (e) {
    return false;
  }
}

export function mapVenueCodeTM(venue) {
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

export function mapTmEvent(e) {
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

export async function fetchTicketmasterEvents(startDate, endDate, bypassCache, env) {
  const cacheKey = 'tm:events:' + startDate + ':' + endDate;

  // 1) Cache KV
  if (!bypassCache && hasKV(env)) {
    try {
      const cached = await TAXI_KV.get(cacheKey, { type: 'json' });
      if (cached) {
        return Object.assign({ source: 'cache' }, cached);
      }
    } catch (e) {}
  }

  if (!hasTicketmaster(env)) {
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
  if (hasKV(env)) {
    try {
      await TAXI_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
    } catch (e) {}
  }

  return Object.assign({ source: 'fresh' }, result);
}


// ─── Handler HTTP : GET /events/ticketmaster ───
export async function handleTicketmaster(url, env) {
  const today = new Date();
  const startDate = url.searchParams.get('start') || today.toISOString().split('T')[0];
  const defaultEnd = new Date(today.getTime() + 365 * 86400000);
  const endDate = url.searchParams.get('end') || defaultEnd.toISOString().split('T')[0];
  const bypassCache = url.searchParams.get('fresh') === '1';

  const result = await fetchTicketmasterEvents(startDate, endDate, bypassCache, env);
  return new Response(JSON.stringify(result), {
    status: result.ok === false ? 500 : 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300'
    })
  });
}

// ─── Handler HTTP : GET /events/ticketmaster ───
export async function handleTicketmaster(url, env) {
  const today = new Date();
  const startDate = url.searchParams.get('start') || today.toISOString().split('T')[0];
  const defaultEnd = new Date(today.getTime() + 365 * 86400000);
  const endDate = url.searchParams.get('end') || defaultEnd.toISOString().split('T')[0];
  const bypassCache = url.searchParams.get('fresh') === '1';

  const result = await fetchTicketmasterEvents(startDate, endDate, bypassCache, env);
  return new Response(JSON.stringify(result), {
    status: result.ok === false ? 500 : 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300'
    })
  });
}
