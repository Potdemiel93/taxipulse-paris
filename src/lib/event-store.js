// =============================================================================
// TaxiPulse — event-store.js  (Events V2, session S3)
//
// Fonctions exportées :
//   readStore(env)                    — lit events:store:v2 depuis KV
//   writeStore(env, store)            — écrit events:store:v2 + index date + conflicts
//   upsertEvent(store, rawEvent)      — passe 1 (exact) → passe 2 (fuzzy) → insert
//   detectConflicts(store)            — post-scan §3.5, lève EventConflicts
//   markStale(store, now)             — status stale_warning au-delà de 8j
//   listByDate(store, dateStr)        — events pour une date donnée
//   listByVenue(store, venueId)       — events pour une venue donnée
//
// Spec de référence :
//   docs/ARCHITECTURE_EVENTS.md §3.1–§3.5, §4
//   docs/EVENT_SCHEMA.md §1–§6
//
// Dépendances : normalize.js (même répertoire), aucune autre
// =============================================================================

import {
  titleSlug, venueId as rawVenueId, eventKey, sourceScore, fuzzyCanMerge
} from './normalize.js';

// ─── Constantes privées ──────────────────────────────────────────────────────

const _STORE_KEY      = 'events:store:v2';
const _CONFLICTS_KEY  = 'events:conflicts';
const _STORE_TTL_S    = 120;
const _CONFLICT_TTL_S = 604_800; // 7 jours en secondes
const _STALE_DAYS     = 8;
const _DEFAULT_HEURE  = '20:00'; // heure par défaut injectée = heure non certifiée

// Sources considérées manuelles/Sheet — § ARCHITECTURE §3.4
const _MANUAL_SOURCES = ['', 'manuel', 'sofiane', 'sheet'];

// Normalise un identifiant de source pour le suivi dans sources_list.
// '' est converti en 'manuel' pour ne pas polluer le split('+').
const _srcId = s => (s ?? '').trim() || 'manuel';

// =============================================================================
//  VENUE_MAPPING — § ARCHITECTURE §4 "défini en S3"
//  rawVenueId(venue_raw) → lookup → canonical venue_id
//  Stub S3 : ~20 venues principales + cas de test. À compléter en S11+.
// =============================================================================
const VENUE_MAPPING = {
  // Stades
  'stade_de_france':                    'stade_france',
  'stade_france':                       'stade_france',
  // Arènes / grandes salles
  'accor_arena':                        'bercy_arena',
  'bercy_arena':                        'bercy_arena',
  'zenith_paris':                       'zenith',
  'zenith':                             'zenith',
  'paris_la_defense_arena':             'defense_arena',
  'defense_arena':                      'defense_arena',
  'adidas_arena':                       'adidas_arena',
  'olympia':                            'olympia',
  'grand_rex':                          'grand_rex',
  'salle_pleyel':                       'salle_pleyel',
  'casino_de_paris':                    'casino_paris',
  'casino_paris':                       'casino_paris',
  // Hippodromes
  'hippodrome_de_longchamp':            'longchamp',
  'hippodrome_longchamp':               'longchamp',
  'longchamp':                          'longchamp',
  'hippodrome_d_auteuil':               'auteuil',
  'auteuil':                            'auteuil',
  'hippodrome_de_vincennes':            'vincennes',
  'vincennes':                          'vincennes',
  // Sport
  'parc_des_princes':                   'parc_princes',
  'parc_princes':                       'parc_princes',
  'roland_garros':                      'roland_garros',
  // Culture / Expositions
  'grand_palais':                       'grand_palais',
  'philharmonie_de_paris':              'philharmonie',
  'philharmonie':                       'philharmonie',
  // Salons
  'porte_de_versailles':                'porte_versailles',
  'porte_versailles':                   'porte_versailles',
  'parc_des_expositions_de_villepinte': 'villepinte',
  'villepinte':                         'villepinte',
  // TODO S11+ : compléter depuis events_master_2026_v3_final.csv
};

// =============================================================================
//  Helpers privés
// =============================================================================

/** Conversion "HH:MM" → minutes depuis minuit (dupliqué de normalize.js — non exporté là-bas). */
function _toMin(heure) {
  const parts = (heure || '00:00').split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

/** rawVenueId(venue_raw) → lookup VENUE_MAPPING → canonical venue_id | null. */
function _resolveVenue(venueRaw) {
  if (!venueRaw) return null;
  const slug = rawVenueId(venueRaw);
  return VENUE_MAPPING[slug] || null;
}

/** score → source_level label. § ARCHITECTURE §3.4 */
function _sourceLevel(score) {
  if (score >= 100) return 'canonical';
  if (score >= 70)  return 'ticketing';
  if (score >= 40)  return 'aggregator';
  return 'scraper';
}

/** source string → true si source manuelle/Sheet. § ARCHITECTURE §3.4 */
function _isManualSource(source) {
  return _MANUAL_SOURCES.includes((source ?? '').toLowerCase().trim());
}

/**
 * Calcule confidence_score selon EVENT_SCHEMA §3.
 * Attend l'event tel qu'il sera stocké (sources_count, source_level, heure_debut à jour).
 */
function _computeConfidence(event) {
  let score = 0;

  if (event.source_level === 'canonical')      score += 50;
  else if (event.source_level === 'ticketing') score += 20;
  // aggregator/scraper → base 0

  // Aggregators supplémentaires : +10 par source aggregator dans sources_list (hors source principale)
  // § EVENT_SCHEMA §3 "par source aggregator supplémentaire → +10 (plafonné à +30)"
  const mainSrcId = _srcId(event.source);
  const allSrcs   = (event.sources_list || '').split('+').filter(Boolean);
  let aggExtra = 0;
  for (const s of allSrcs) {
    if (s === mainSrcId) continue;
    if (_sourceLevel(sourceScore(s)) === 'aggregator') {
      aggExtra = Math.min(aggExtra + 10, 30);
    }
  }
  score += aggExtra;

  if (event.heure_debut && event.heure_debut !== _DEFAULT_HEURE) score += 10;
  if ((event.sources_count || 1) >= 3) score += 5;

  return Math.min(score, 100);
}

/**
 * Dérive status + confirme depuis confidence_score.
 * Note : stale_warning est géré par markStale() séparément.
 * § EVENT_SCHEMA §3 règles de statut (priorité décroissante)
 */
function _computeStatus(event) {
  // conflict a priorité absolue (géré par appelant via event.status = 'conflict')
  if (event.status === 'conflict') return { status: 'conflict', confirme: 'APPROX' };
  const confidence = _computeConfidence(event);
  if (confidence >= 60) return { status: 'confirmed', confirme: 'OUI' };
  return { status: 'approx', confirme: 'APPROX' };
}

/**
 * Fusionne loser dans winner (mutation de winner).
 * Mise à jour : sources_count, sources_list, merged_from, last_seen_at, updated_at.
 * Ne touche PAS au titre, heure, source principale de winner.
 */
function _mergeInto(winner, loser) {
  const now = new Date().toISOString();
  winner.updated_at   = now;
  winner.last_seen_at = now;

  // Union sources (sans doublon)
  const srcSet = new Set(
    (winner.sources_list || '').split('+').filter(Boolean)
  );
  srcSet.add(_srcId(winner.source)); // garantit que la source principale est dans la liste
  srcSet.add(_srcId(loser.source));
  for (const s of (loser.sources_list || '').split('+').filter(Boolean)) srcSet.add(s);

  winner.sources_list  = [...srcSet].join('+');
  winner.sources_count = srcSet.size;

  // merged_from : union des ids sources fusionnées
  const mf = new Set(winner.merged_from || []);
  if (loser.id && loser.id !== winner.id) mf.add(loser.id);
  for (const id of (loser.merged_from || [])) mf.add(id);
  winner.merged_from = [...mf];
}

/**
 * Construit un EventConflict. § EVENT_SCHEMA §5
 * conflict_type : 'same_slot' | 'time_mismatch' | 'title_mismatch'
 */
function _buildConflict(eventA, eventB, conflictType) {
  const pick = e => ({
    id:           e.id,
    titre:        e.titre,
    heure_debut:  e.heure_debut,
    source:       e.source,
    source_level: e.source_level,
  });
  return {
    id:            `${eventA.venue}|${eventA.date}|${Date.now()}`,
    date:          eventA.date,
    venue:         eventA.venue,
    event_a:       pick(eventA),
    event_b:       pick(eventB),
    conflict_type: conflictType,
    resolved:      false,
  };
}

/** Vérifie si un conflit entre idA et idB existe déjà dans store.conflicts. */
function _conflictExists(store, idA, idB) {
  return store.conflicts.some(c =>
    (c.event_a.id === idA && c.event_b.id === idB) ||
    (c.event_a.id === idB && c.event_b.id === idA)
  );
}

/** Construit un EventStore vide valide. § EVENT_SCHEMA §6 */
function _buildEmptyStore() {
  const now = new Date().toISOString();
  return {
    version:      'v2',
    generated_at: now,
    expires_at:   new Date(Date.now() + _STORE_TTL_S * 1000).toISOString(),
    horizon_days: 90,
    events:    [],
    conflicts: [],
    stats: {
      total:            0,
      by_status:        { confirmed: 0, approx: 0, stale_warning: 0, conflict: 0 },
      by_source_level:  { canonical: 0, ticketing: 0, aggregator: 0, scraper: 0 },
      last_sync_at:     now,
      sync_duration_ms: 0,
      rejects_count:    0,
    },
  };
}

/** Recompute stats depuis store.events. Appelé dans writeStore avant persistance. */
function _recomputeStats(store) {
  const s = store.stats;
  s.total = store.events.length;
  s.by_status       = { confirmed: 0, approx: 0, stale_warning: 0, conflict: 0 };
  s.by_source_level = { canonical: 0, ticketing: 0, aggregator: 0, scraper: 0 };
  for (const e of store.events) {
    if (s.by_status[e.status] !== undefined)             s.by_status[e.status]++;
    if (s.by_source_level[e.source_level] !== undefined) s.by_source_level[e.source_level]++;
  }
}

// =============================================================================
//  readStore(env) — § ARCHITECTURE §4
// =============================================================================
export async function readStore(env) {
  try {
    const raw = await env.TAXI_KV.get(_STORE_KEY);
    if (!raw) return _buildEmptyStore();
    return JSON.parse(raw);
  } catch {
    return _buildEmptyStore();
  }
}

// =============================================================================
//  writeStore(env, store) — § ARCHITECTURE §4
//  Écrit :
//    events:store:v2               (TTL 120s)
//    events:index:date:{YYYY-MM-DD} par date présente (TTL 120s)
//    events:conflicts              (TTL 7 jours)
// =============================================================================
export async function writeStore(env, store) {
  const now = new Date().toISOString();
  store.generated_at = now;
  store.expires_at   = new Date(Date.now() + _STORE_TTL_S * 1000).toISOString();

  _recomputeStats(store);

  // Écriture principale
  await env.TAXI_KV.put(_STORE_KEY, JSON.stringify(store), { expirationTtl: _STORE_TTL_S });

  // Index par date — § ARCHITECTURE §4 "events:index:date:{YYYY-MM-DD}"
  const byDate = new Map();
  for (const e of store.events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e.id);
  }
  await Promise.all(
    [...byDate.entries()].map(([date, ids]) =>
      env.TAXI_KV.put(`events:index:date:${date}`, JSON.stringify(ids), { expirationTtl: _STORE_TTL_S })
    )
  );

  // Conflits — § ARCHITECTURE §4 "events:conflicts" TTL 7j
  await env.TAXI_KV.put(_CONFLICTS_KEY, JSON.stringify(store.conflicts), { expirationTtl: _CONFLICT_TTL_S });
}

// =============================================================================
//  upsertEvent(store, rawEvent)
//  Pipeline : normalize → passe 1 (exact) → passe 2 (fuzzy) → insert
//  § ARCHITECTURE §3.1–§3.4
//
//  rawEvent attendu :
//    { titre, date, venue_raw, heure_debut, source, cat,
//      notes?, source_url?, source_id?, heure_fin?, date_end? }
//
//  Retourne :
//    { action: 'inserted'|'merged_p1'|'merged_p2'|'rejected', id, reason?, conflict? }
// =============================================================================
export function upsertEvent(store, rawEvent) {

  // ── STEP 1 : NORMALIZE ────────────────────────────────────────────────────

  const venue_id = _resolveVenue(rawEvent.venue_raw);
  if (!venue_id) {
    return { action: 'rejected', id: '', reason: 'unknown_venue' };
  }

  const titre_slug = titleSlug(rawEvent.titre);
  if (!titre_slug) {
    return { action: 'rejected', id: '', reason: 'empty_slug' };
  }

  const score    = sourceScore(rawEvent.source);
  const level    = _sourceLevel(score);
  const isManual = _isManualSource(rawEvent.source);
  const id       = eventKey(rawEvent.date, venue_id, titre_slug);
  const now      = new Date().toISOString();
  const heure    = rawEvent.heure_debut || _DEFAULT_HEURE;

  const candidate = {
    id,
    date:          rawEvent.date,
    date_end:      rawEvent.date_end || rawEvent.date,
    heure_debut:   heure,
    heure_fin:     rawEvent.heure_fin  || '',
    venue:         venue_id,
    venue_raw:     rawEvent.venue_raw,
    titre:         (rawEvent.titre || '').trim().slice(0, 120),
    titre_slug,
    cat:           rawEvent.cat || 'autre',
    source:        rawEvent.source || '',
    source_level:  level,
    source_score:  score,
    source_url:    rawEvent.source_url  || null,
    source_id:     rawEvent.source_id   || null,
    sources_count: 1,
    sources_list:  _srcId(rawEvent.source),
    merged_from:   [],
    status:        'approx',
    confidence_score: 0,
    confirme:      'APPROX',
    notes:         rawEvent.notes || '',
    created_at:    now,
    updated_at:    now,
    last_seen_at:  now,
  };
  candidate.confidence_score = _computeConfidence(candidate);
  const initStatus = _computeStatus(candidate);
  candidate.status   = initStatus.status;
  candidate.confirme = initStatus.confirme;

  // ── STEP 2 : PASSE 1 — exact match sur id ────────────────────────────────

  const existing = store.events.find(e => e.id === id);

  if (existing) {

    // Sous-cas A — Manual override "Sheet bat tout" (ZG1 : passe 1 UNIQUEMENT)
    // § ARCHITECTURE §3.4 "Sheet bat tout"
    if (
      isManual &&
      existing.source_level === 'canonical' &&
      (heure !== existing.heure_debut || rawEvent.titre !== existing.titre)
    ) {
      const conflictType = heure !== existing.heure_debut ? 'time_mismatch' : 'title_mismatch';
      // Capture des données pre-override pour le conflict
      const snapshot = { ...existing };
      // Sheet gagne
      existing.heure_debut = heure;
      if (rawEvent.titre !== existing.titre) existing.titre = rawEvent.titre;
      _mergeInto(existing, candidate);
      existing.confidence_score = _computeConfidence(existing);
      const s = _computeStatus(existing);
      existing.status   = s.status;
      existing.confirme = s.confirme;
      const conflict = _buildConflict(candidate, snapshot, conflictType);
      store.conflicts.push(conflict);
      return { action: 'merged_p1', id, conflict };
    }

    // Sous-cas B — Ré-upsert même source (idempotent)
    const srcSet = new Set((existing.sources_list || '').split('+').filter(Boolean));
    if (srcSet.has(_srcId(rawEvent.source))) {
      existing.last_seen_at = now;
      existing.updated_at   = now;
      return { action: 'merged_p1', id };
    }

    // Sous-cas C — Source différente, score comparison
    if (score > existing.source_score) {
      // Entrant gagne : remplace les champs principaux
      const oldWinner = { ...existing, merged_from: [...existing.merged_from] };
      Object.assign(existing, {
        titre:        candidate.titre,
        titre_slug:   candidate.titre_slug,
        heure_debut:  candidate.heure_debut,
        heure_fin:    candidate.heure_fin,
        source:       candidate.source,
        source_level: candidate.source_level,
        source_score: candidate.source_score,
        source_url:   candidate.source_url,
        source_id:    candidate.source_id,
      });
      _mergeInto(existing, oldWinner);
    } else {
      // Existant gagne ou égalité : on enrichit seulement les sources
      _mergeInto(existing, candidate);
    }
    existing.confidence_score = _computeConfidence(existing);
    const s = _computeStatus(existing);
    existing.status   = s.status;
    existing.confirme = s.confirme;
    return { action: 'merged_p1', id };
  }

  // ── STEP 3 : PASSE 2 — fuzzy (même venue + même date) ───────────────────
  // § ARCHITECTURE §3.3

  const sameDayVenue = store.events.filter(
    e => e.venue === venue_id && e.date === rawEvent.date
  );

  for (const cand of sameDayVenue) {
    if (!fuzzyCanMerge(cand.titre_slug, titre_slug, cand.heure_debut, heure)) continue;

    // Match fuzzy trouvé
    if (score >= cand.source_score) {
      // Entrant gagne : met à jour les champs principaux du candidat existant
      const oldCand = { ...cand, merged_from: [...(cand.merged_from || [])] };
      Object.assign(cand, {
        id:           candidate.id,      // ← id du winner (entrant)
        titre:        candidate.titre,
        titre_slug:   candidate.titre_slug,
        source:       candidate.source,
        source_level: candidate.source_level,
        source_score: candidate.source_score,
        source_url:   candidate.source_url,
        source_id:    candidate.source_id,
        heure_debut:  candidate.heure_debut,
        heure_fin:    candidate.heure_fin,
      });
      _mergeInto(cand, oldCand);
    } else {
      // Existant gagne : on enrichit seulement les sources
      _mergeInto(cand, candidate);
    }
    cand.confidence_score = _computeConfidence(cand);
    const s = _computeStatus(cand);
    cand.status   = s.status;
    cand.confirme = s.confirme;
    return { action: 'merged_p2', id: cand.id };
  }

  // ── STEP 4 : INSERT ───────────────────────────────────────────────────────

  store.events.push(candidate);
  return { action: 'inserted', id };
}

// =============================================================================
//  detectConflicts(store) — § ARCHITECTURE §3.5
//  Post-scan : même venue+date, |heure| ≤ 30 min, slugs distincts et non-fusionnables.
//  Ajoute les nouveaux conflits à store.conflicts (mutation). Retourne les nouveaux seulement.
// =============================================================================
export function detectConflicts(store) {
  const newConflicts = [];
  const events = store.events;

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];

      if (a.venue !== b.venue || a.date !== b.date) continue;
      if (a.titre_slug === b.titre_slug) continue;
      if (Math.abs(_toMin(a.heure_debut) - _toMin(b.heure_debut)) > 30) continue;
      if (_conflictExists(store, a.id, b.id)) continue;

      const conflict = _buildConflict(a, b, 'same_slot');
      store.conflicts.push(conflict);
      newConflicts.push(conflict);
    }
  }
  return newConflicts;
}

// =============================================================================
//  markStale(store, now) — § EVENT_SCHEMA §3 règle stale_warning
//  Marque les events dont last_seen_at > now − 8j.
//  @param now {Date|string} — date de référence (paramètre pour testabilité)
//  @returns {number} — nombre d'events passés à stale_warning ce run
// =============================================================================
export function markStale(store, now) {
  const refMs       = (now instanceof Date ? now : new Date(now)).getTime();
  const thresholdMs = _STALE_DAYS * 24 * 60 * 60 * 1000;
  let count = 0;

  for (const e of store.events) {
    if (e.status === 'conflict') continue; // conflict a priorité — § EVENT_SCHEMA §3
    const lastSeen = new Date(e.last_seen_at).getTime();
    if (refMs - lastSeen > thresholdMs) {
      e.status   = 'stale_warning';
      e.confirme = 'APPROX';
      count++;
    }
  }
  return count;
}

// =============================================================================
//  listByDate / listByVenue — pures, sans mutation
// =============================================================================

/** @returns {Event[]} events dont e.date === dateStr */
export function listByDate(store, dateStr) {
  return store.events.filter(e => e.date === dateStr);
}

/** @returns {Event[]} events dont e.venue === venueId */
export function listByVenue(store, venueId) {
  return store.events.filter(e => e.venue === venueId);
}
