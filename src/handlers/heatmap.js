/* === HEATMAP V1 START === */
// TaxiPulse — Handler Heatmap State (GET /heatmap/state)
// V1 : scores pseudo-aléatoires déterministes (changent chaque 60s, identiques pour tous les abonnés)
// T5 : brancher vraies APIs SNCF/vols en remplacement de ZONES_V1

import { CORS_HEADERS } from '../lib/constants.js';

const KV_KEY = 'heatmap:state:current';
const KV_TTL = 60; // secondes

// ─── Handler principal ───
export async function handleHeatmapState(request, env) {
  // Tentative lecture cache KV
  try {
    const cached = await env.TAXI_KV.get(KV_KEY, { type: 'json' });
    if (cached) {
      return new Response(JSON.stringify(cached, null, 2), {
        status: 200,
        headers: Object.assign({}, CORS_HEADERS, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Cache': 'HIT'
        })
      });
    }
  } catch (_) {}

  // Cache miss → génère + stocke en KV
  const state = generateState();
  try {
    await env.TAXI_KV.put(KV_KEY, JSON.stringify(state), { expirationTtl: KV_TTL });
  } catch (_) {}

  return new Response(JSON.stringify(state, null, 2), {
    status: 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'X-Cache': 'MISS'
    })
  });
}

// ─── Génération de l'état complet ───
function generateState() {
  const now = new Date();
  const minuteBucket = Math.floor(now.getTime() / 60000);

  const zones = ZONES_V1.map(z => {
    const score = scoreFor(z.id, minuteBucket);
    const { peakStart, peakEnd } = peakWindow(z.source_type, now);
    return {
      id:                 z.id,
      name:               z.name,
      polygon:            z.polygon,
      score,
      color:              colorFor(score),
      estimated_fare_min: z.fare_min,
      estimated_fare_max: z.fare_max,
      confidence:         z.confidence,
      reason:             z.reason,
      peak_start:         peakStart,
      peak_end:           peakEnd,
      source_type:        z.source_type
    };
  });

  return {
    version:           'v1',
    generated_at:      now.toISOString(),
    expires_at:        new Date(now.getTime() + 60000).toISOString(),
    zones,
    global_status:     globalStatus(Math.max(...zones.map(z => z.score))),
    modulators_active: []
  };
}

// ─── Score déterministe 20–95 (identique pour tous les abonnés la même minute) ───
function scoreFor(zoneId, minuteBucket) {
  let h = (minuteBucket * 2654435761) >>> 0;
  for (let i = 0; i < zoneId.length; i++) {
    h = (Math.imul(h ^ zoneId.charCodeAt(i), 2246822519)) >>> 0;
    h ^= h >>> 13;
  }
  return 20 + (h % 76); // range 20–95
}

function colorFor(score) {
  if (score >= 85) return 'red';
  if (score >= 65) return 'orange';
  if (score >= 40) return 'yellow';
  if (score >= 20) return 'green';
  return 'gray';
}

function globalStatus(maxScore) {
  if (maxScore >= 85) return 'très chaud';
  if (maxScore >= 65) return 'chaud';
  if (maxScore >= 40) return 'tiède';
  return 'calme';
}

// ─── Fenêtres de pic — timing métier (HEATMAP_SPEC §3 couche 4) ───
const PEAK_OFFSETS = {
  eurostar:          { offset: 8,  duration: 25 },
  tgv:               { offset: 4,  duration: 15 },
  vol_international: { offset: 40, duration: 45 },
  vol_schengen:      { offset: 20, duration: 30 },
  concert:           { offset: 5,  duration: 60 },
  transilien:        { offset: 2,  duration: 20 }
};

function peakWindow(sourceType, now) {
  const cfg = PEAK_OFFSETS[sourceType] || { offset: 5, duration: 20 };
  const peakStart = new Date(now.getTime() + cfg.offset * 60000);
  const peakEnd   = new Date(peakStart.getTime() + cfg.duration * 60000);
  return { peakStart: peakStart.toISOString(), peakEnd: peakEnd.toISOString() };
}

// ─── Zones V1 — 12 zones, coordonnées réalistes Paris (polygones ~100m) ───
const ZONES_V1 = [
  {
    id: 'gdn-eurostar',
    name: 'Gare du Nord — Sortie Eurostar (rue de Maubeuge)',
    polygon: [[48.8824, 2.3555], [48.8824, 2.3579], [48.8806, 2.3579], [48.8806, 2.3555]],
    fare_min: 22, fare_max: 30, confidence: 4,
    reason: 'Eurostar 9382 Bruxelles-Midi, arrivée 21:47, 384 pax',
    source_type: 'eurostar'
  },
  {
    id: 'gdn-main',
    name: 'Gare du Nord — Sortie principale (rue de Dunkerque)',
    polygon: [[48.8818, 2.3541], [48.8818, 2.3565], [48.8800, 2.3565], [48.8800, 2.3541]],
    fare_min: 18, fare_max: 25, confidence: 3,
    reason: 'TGV INOUI 6232 Lyon-Part-Dieu, arrivée 19:52, 520 pax',
    source_type: 'tgv'
  },
  {
    id: 'gdn-banlieue',
    name: 'Gare du Nord — Sortie banlieue (côté est)',
    polygon: [[48.8812, 2.3570], [48.8812, 2.3594], [48.8794, 2.3594], [48.8794, 2.3570]],
    fare_min: 15, fare_max: 22, confidence: 2,
    reason: 'Transilien H/K/P, flux sortie 18h–20h',
    source_type: 'transilien'
  },
  {
    id: 'cdg-t1',
    name: 'CDG Terminal 1 — Zone taxi (niveau arrivées)',
    polygon: [[49.0099, 2.5462], [49.0099, 2.5486], [49.0081, 2.5486], [49.0081, 2.5462]],
    fare_min: 55, fare_max: 65, confidence: 4,
    reason: 'Vol AF1240 New York JFK, arrivée 07:20, 380 pax',
    source_type: 'vol_international'
  },
  {
    id: 'cdg-t2e',
    name: 'CDG Terminal 2E — Zone taxi',
    polygon: [[49.0063, 2.5616], [49.0063, 2.5640], [49.0045, 2.5640], [49.0045, 2.5616]],
    fare_min: 55, fare_max: 65, confidence: 4,
    reason: 'Vol DL408 Atlanta-Hartsfield, arrivée 09:15, 290 pax',
    source_type: 'vol_international'
  },
  {
    id: 'cdg-t2f',
    name: 'CDG Terminal 2F — Zone taxi',
    polygon: [[49.0053, 2.5700], [49.0053, 2.5724], [49.0035, 2.5724], [49.0035, 2.5700]],
    fare_min: 55, fare_max: 65, confidence: 3,
    reason: 'Vol LH1234 Francfort, arrivée 10:40, 180 pax',
    source_type: 'vol_schengen'
  },
  {
    id: 'cdg-t3',
    name: 'CDG Terminal 3 (low cost) — Zone taxi',
    polygon: [[49.0044, 2.5744], [49.0044, 2.5768], [49.0026, 2.5768], [49.0026, 2.5744]],
    fare_min: 50, fare_max: 60, confidence: 2,
    reason: 'Vol U2 9824 Londres Gatwick, arrivée 11:05, 186 pax',
    source_type: 'vol_schengen'
  },
  {
    id: 'orly-s3',
    name: 'Orly Terminal 3 — Zone taxi',
    polygon: [[48.7271, 2.3640], [48.7271, 2.3664], [48.7253, 2.3664], [48.7253, 2.3640]],
    fare_min: 38, fare_max: 45, confidence: 3,
    reason: 'Vol TO1234 Marrakech-Menara, arrivée 14:30, 210 pax',
    source_type: 'vol_schengen'
  },
  {
    id: 'gare-lyon-h1',
    name: 'Gare de Lyon — Hall 1 (sortie taxi)',
    polygon: [[48.8461, 2.3719], [48.8461, 2.3743], [48.8443, 2.3743], [48.8443, 2.3719]],
    fare_min: 15, fare_max: 22, confidence: 3,
    reason: 'TGV INOUI 6103 Marseille-Saint-Charles, arrivée 18:34, 480 pax',
    source_type: 'tgv'
  },
  {
    id: 'saint-lazare',
    name: 'Gare Saint-Lazare — Sortie Rome',
    polygon: [[48.8772, 2.3229], [48.8772, 2.3253], [48.8754, 2.3253], [48.8754, 2.3229]],
    fare_min: 12, fare_max: 18, confidence: 2,
    reason: 'Transilien L/J, flux sortie 18h–20h',
    source_type: 'transilien'
  },
  {
    id: 'bercy-arena',
    name: 'Accor Arena — Sortie taxi (rue de Bercy)',
    polygon: [[48.8395, 2.3774], [48.8395, 2.3798], [48.8377, 2.3798], [48.8377, 2.3774]],
    fare_min: 18, fare_max: 28, confidence: 4,
    reason: 'Concert Imagine Dragons – Accor Arena, fin 23:15, ~15 000 pax',
    source_type: 'concert'
  },
  {
    id: 'chatelet',
    name: 'Châtelet – Les Halles (sortie taxi rue Saint-Denis)',
    polygon: [[48.8603, 2.3457], [48.8603, 2.3481], [48.8585, 2.3481], [48.8585, 2.3457]],
    fare_min: 12, fare_max: 20, confidence: 2,
    reason: 'Flux correspondance RER A/B, soirée 19h–22h',
    source_type: 'transilien'
  }
];

/* === HEATMAP V1 END === */
