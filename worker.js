// =============================================================================
// TaxiPulse Cloudflare Worker — V7 (Modulaire ES6)
//
// REFACTOR : monolithe 2226 lignes → routeur 150 lignes + 10 modules
// Backup : backups/worker.js.before-refactor-*
//
// Endpoints :
//   GET  /                      -> "TaxiPulse Proxy OK"
//   GET  /eurostar              -> scrape trafic Eurostar (cache 60s)
//   GET  /eurostar/debug        -> diagnostic scrape Eurostar
//   GET  /route?from=...&to=... -> TomTom Traffic Live + fallback OSRM
//   GET  /basetaxi?aero=cdg|orly -> attente taxi LIVE (Browserless, cache 90s)
//   POST /basetaxi/report       -> observation chauffeur (KV, dedup 25 min)
//   GET  /basetaxi/crowd?aero=  -> médiane observations récentes
//   POST /event/confirm         -> vote chauffeur fin réelle d'event
//   GET  /event/confirm?eventId= -> consolidated votes
//   GET  /events/ticketmaster   -> events Ticketmaster Paris (cache 6h)
//   GET  /events/health         -> stats fraîcheur Sheet
//   GET  /events/checklist      -> liste liens à vérifier (= /events/health)
//   POST /events/test-email     -> envoie email de test
//   POST /events/run-recap      -> force envoi récap hebdo
//   GET  /events/aggregate      -> aggregator V2 multi-sources
//   GET  /?url=...              -> proxy SNCF (catch-all)
//
// Crons :
//   "0 5 * * *"  -> aggregator V2 quotidien
//   "0 6 * * 1"  -> récap hebdo fraîcheur Sheet (lundi)
//
// Bindings wrangler.toml :
//   - kv_namespaces : TAXI_KV
//   - secrets       : BROWSERLESS_TOKEN, RESEND_API_KEY, ADMIN_EMAIL, TICKETMASTER_KEY
// =============================================================================

import { CORS_HEADERS, SNCF_TOKEN, BASETAXI_URLS } from './src/lib/constants.js';

// Handlers
import { scrapeEurostar } from './src/handlers/eurostar.js';
import { handleRoute } from './src/handlers/route.js';
import {
  fetchBaseTaxiLive, reportTaxiWait, getCrowdWait
} from './src/handlers/basetaxi.js';
import { handleEventConfirm } from './src/handlers/event-confirm.js';
import { handleTicketmaster } from './src/handlers/ticketmaster.js';
import { handleEventsHealth } from './src/handlers/events-health.js';
import { handleEventsAggregate } from './src/handlers/events-aggregate.js';
import { handleScheduled } from './src/scheduled.js';
import { handleHeatmapState } from './src/handlers/heatmap.js';

// =============================================================================
//  ROUTEUR PRINCIPAL
// =============================================================================
async function handleRequest(request, env) {
  // OPTIONS (CORS preflight)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const j = (data, status = 200, extraHeaders = {}) => new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }, extraHeaders)
    }
  );

  // ─── EUROSTAR ───
  if (path === '/eurostar' || path === '/eurostar/') {
    try {
      const data = await scrapeEurostar(false);
      return j(data, 200, { 'Cache-Control': 'public, max-age=60' });
    } catch (err) {
      return j({ error: err.message, trains: {} }, 500);
    }
  }
  if (path === '/eurostar/debug') {
    try {
      return j(await scrapeEurostar(true));
    } catch (err) {
      return j({ error: err.message }, 500);
    }
  }

  // ─── ROUTE (TomTom + OSRM) ───
  if (path === '/route' || path === '/route/') {
    return handleRoute(url);
  }

  // ─── BASETAXI ───
  if (path === '/basetaxi/report' && request.method === 'POST') {
    try {
      const body = await request.json();
      const aero = (body.aero || '').toLowerCase();
      const mins = body.mins;
      const result = await reportTaxiWait(aero, mins, request, env);
      return j(result, result.ok ? 200 : 400);
    } catch (err) {
      return j({ ok: false, error: err.message }, 400);
    }
  }
  if (path === '/basetaxi/crowd') {
    const aero = (url.searchParams.get('aero') || '').toLowerCase();
    const result = await getCrowdWait(aero, env);
    return j(result, result.ok ? 200 : 400, { 'Cache-Control': 'public, max-age=30' });
  }
  if (path === '/basetaxi' || path === '/basetaxi/') {
    const aero = (url.searchParams.get('aero') || '').toLowerCase();
    if (!BASETAXI_URLS[aero]) {
      return j({ ok: false, reason: 'invalid_aero', allowed: ['cdg', 'orly'] }, 400);
    }
    const result = await fetchBaseTaxiLive(aero, env);
    return j(result, result.ok ? 200 : 503, { 'Cache-Control': 'public, max-age=60' });
  }

  // ─── EVENT CONFIRM ───
  if (path === '/event/confirm' || path === '/event/confirm/') {
    return handleEventConfirm(request, url, env);
  }

  // ─── TICKETMASTER ───
  if (path === '/events/ticketmaster' || path === '/events/ticketmaster/') {
    return handleTicketmaster(url, env);
  }

  // ─── EVENTS HEALTH / CHECKLIST / TEST-EMAIL / RUN-RECAP ───
  if (path.startsWith('/events/health') ||
      path.startsWith('/events/checklist') ||
      path === '/events/test-email' ||
      path === '/events/run-recap') {
    const result = await handleEventsHealth(path, request, env);
    if (result) return result;
  }

  // ─── EVENTS AGGREGATE V2 ───
  if (path === '/events/aggregate' || path === '/events/aggregate/') {
    return handleEventsAggregate(request, env);
  }

  // ─── HEATMAP STATE ───
  if (path === '/heatmap/state' || path === '/heatmap/state/') {
    return handleHeatmapState(request, env);
  }

  // ─── PROXY SNCF (catch-all) ───
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('TaxiPulse Proxy OK v7-modular', { status: 200, headers: CORS_HEADERS });
  }
  try {
    const response = await fetch(target, {
      headers: { 'Authorization': SNCF_TOKEN, 'Accept': 'application/json' }
    });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  } catch (err) {
    return j({ error: err.message }, 502);
  }
}

// =============================================================================
//  EXPORT DEFAULT — Cloudflare Workers ES Module syntax
// =============================================================================
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};
