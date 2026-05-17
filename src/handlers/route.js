// =============================================================================
// TaxiPulse — Handler Route (TomTom Traffic Live + fallback OSRM)
// Extrait de worker.js (lignes 1161-1242) — transformé en fonction handleRoute()
// =============================================================================

import { CORS_HEADERS, TOMTOM_KEY } from '../lib/constants.js';

// ─── handleRoute : GET /route?from=LAT,LNG&to=LAT,LNG ───
export async function handleRoute(url) {
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

  // ─── TENTATIVE 1 : TomTom Traffic Live ───
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

  // ─── FALLBACK : OSRM (pas de trafic live mais gratuit et fiable) ───
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

