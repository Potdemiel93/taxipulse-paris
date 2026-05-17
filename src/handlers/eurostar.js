// =============================================================================
// TaxiPulse — Handler Eurostar (scrape trafic temps réel)
// Extrait de worker.js (lignes 133-422) — fonctions copiées à l'identique
// =============================================================================

import { UA, EUROSTAR_URLS, EUROSTAR_CACHE_TTL } from '../lib/constants.js';
import { stripHTML, parseISODateTimeToHM, normalizeOrigin } from '../lib/helpers.js';

export function extractServiceObjects(html) {
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

export function parseServiceJSON(serviceStr) {
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

export function parseHTML(html, src) {
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

export async function fetchOne(url, src) {
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

export async function scrapeEurostar(debug) {
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

