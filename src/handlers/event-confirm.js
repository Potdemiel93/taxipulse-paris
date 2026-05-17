// =============================================================================
// TaxiPulse — Handler Event Confirm (votes chauffeurs fin de spectacle)
// Extrait de worker.js (lignes 714-906 + endpoint 1294-1331)
// Converti pour utiliser env passé en paramètre
// =============================================================================

import {
  CORS_HEADERS,
  EVENT_CONFIRM_TTL_SEC,
  VOTE_DEDUP_SEC,
  QUORUM_FINISHED,
  QUORUM_VETO,
  MAX_VENUE_DIST_M,
  MAX_DRIVERS_PER_IP,
  VOTE_WINDOW_BEFORE_MIN,
  VOTE_WINDOW_AFTER_MIN
} from '../lib/constants.js';
import { getClientIP, hashIP, haversineM } from '../lib/helpers.js';
import { hasKV } from './basetaxi.js';

// ─── Consolidation des votes (calcul médiane + quorum + véto) ───
export function consolidateVotes(votes, finTs) {
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

// ─── Enregistrer un vote (POST /event/confirm) ───
export async function storeEventConfirm(body, request, env) {
  if (!hasKV(env)) return { ok: false, reason: 'kv_not_configured' };
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
  try { record = await env.TAXI_KV.get(key, { type: 'json' }); } catch (e) { record = null; }
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

  // Anti-spam : flag si trop de drivers depuis la même IP
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
    await env.TAXI_KV.put(key, JSON.stringify(record), { expirationTtl: EVENT_CONFIRM_TTL_SEC });
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

// ─── Lecture consolidée (GET /event/confirm?eventId=...) ───
export async function getEventConfirmFromKV(eventId, finTs, env) {
  if (!hasKV(env)) return { ok: false, reason: 'kv_not_configured' };
  const key = 'evconfirm:' + eventId;
  try {
    const rec = await env.TAXI_KV.get(key, { type: 'json' });
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

// ─── Handler HTTP : POST + GET /event/confirm ───
export async function handleEventConfirm(request, url, env) {
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const result = await storeEventConfirm(body, request, env);
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

  // GET
  const eid = url.searchParams.get('eventId');
  if (!eid) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing_eventId' }), {
      status: 400,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }
  const finTsParam = url.searchParams.get('finTs');
  const finTs = finTsParam ? parseInt(finTsParam, 10) : null;
  const result = await getEventConfirmFromKV(eid, finTs, env);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=15'
    })
  });
}

