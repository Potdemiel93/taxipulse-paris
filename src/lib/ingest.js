// =============================================================================
// TaxiPulse — ingest.js  (Events V2, session S4)
//
// Fonctions exportées :
//   ingestFromSource(store, sourceName, rawEvents[])  — boucle sur upsertEvent
//   ingestFromSources(env, store, fetchers[])          — orchestre N sources
//
// Responsabilité : orchestration pure.
//   - Appelle les fetchers (fournis par l'appelant)
//   - Normalise via upsertEvent (event-store.js → normalize.js)
//   - Détecte les conflits post-ingest via detectConflicts
//   - Persiste via writeStore + écrit events:sync:last + events:rejects:last
//
// Hors-scope S4 :
//   - Fake-detector (Sheet → S5, sources API → S6)
//   - Adaptation des fetchers existants (events-aggregator.js, ticketmaster.js → S6)
//   - Aucun fetch() direct ici
//
// Spec de référence :
//   docs/ARCHITECTURE_EVENTS.md §2.3 (flux cible), §2.4 (rôle S4), §4 (clés KV)
// =============================================================================

import { upsertEvent, detectConflicts, writeStore } from './event-store.js';

// ─── Constantes privées ──────────────────────────────────────────────────────

const _REJECTS_KEY   = 'events:rejects:last';
const _SYNC_LAST_KEY = 'events:sync:last';
const _REJECTS_TTL_S = 86_400; // 24 heures

// =============================================================================
//  ingestFromSource(store, sourceName, rawEvents[])
//
//  Synchrone — aucun accès KV, logique purement en mémoire.
//  Boucle sur upsertEvent et accumule les stats.
//
//  rawEvent shape attendue (cf. event-store.js upsertEvent) :
//    { titre, date, venue_raw, heure_debut, source, cat,
//      notes?, source_url?, source_id?, heure_fin?, date_end? }
//
//  Retourne un SourceReport :
//    { source, total, inserted, merged_p1, merged_p2, rejected, rejects[] }
// =============================================================================
export function ingestFromSource(store, sourceName, rawEvents) {
  const report = {
    source:    sourceName,
    total:     rawEvents.length,
    inserted:  0,
    merged_p1: 0,
    merged_p2: 0,
    rejected:  0,
    rejects:   [],
  };

  for (const rawEvent of rawEvents) {
    const result = upsertEvent(store, rawEvent);

    switch (result.action) {
      case 'inserted':   report.inserted++;   break;
      case 'merged_p1':  report.merged_p1++;  break;
      case 'merged_p2':  report.merged_p2++;  break;
      case 'rejected':
        report.rejected++;
        report.rejects.push({
          reason:    result.reason,
          titre:     rawEvent.titre    || '',
          date:      rawEvent.date     || '',
          venue_raw: rawEvent.venue_raw || '',
          source:    rawEvent.source   || sourceName,
        });
        break;
    }
    // Note : si result.conflict est défini (manual override Sheet bat tout),
    // le conflict est déjà dans store.conflicts — pas d'action supplémentaire ici.
  }

  return report;
}

// =============================================================================
//  ingestFromSources(env, store, fetchers[])
//
//  Orchestration async complète :
//    1. Lance tous les fetchers en parallel (Promise.allSettled)
//    2. ingestFromSource pour chaque source réussie
//    3. detectConflicts() une fois après toutes les sources
//    4. writeStore() + events:rejects:last + events:sync:last
//
//  Un fetcher est : { name: string, fetch: () => Promise<rawEvent[]> }
//  Le fetch() est un thunk — ses paramètres (env, daysAhead…) sont baked-in
//  par l'appelant (scheduled.js ou le handler HTTP).
//
//  Retourne un IngestReport :
//    { ts, duration_ms, sources[], total_fetched, total_inserted,
//      total_merged, total_rejected, conflicts_new, store_size }
// =============================================================================
export async function ingestFromSources(env, store, fetchers) {
  const startTs = Date.now();

  // ── ÉTAPE 1 : fetchers en parallel ──────────────────────────────────────
  // Promise.allSettled : un crash n'interrompt pas les autres.
  // § spec : "Crash d'un fetcher → autres fetchers continuent"
  const settled = await Promise.allSettled(fetchers.map(f => f.fetch()));

  // ── ÉTAPE 2 : ingestFromSource pour chaque fetcher ──────────────────────
  const sourceReports = [];

  for (let i = 0; i < fetchers.length; i++) {
    const fetcher = fetchers[i];
    const result  = settled[i];

    if (result.status === 'fulfilled') {
      const report = ingestFromSource(store, fetcher.name, result.value);
      sourceReports.push(report);
    } else {
      // Fetcher en erreur : rapport avec error + zéros
      sourceReports.push({
        source:    fetcher.name,
        total:     0,
        inserted:  0,
        merged_p1: 0,
        merged_p2: 0,
        rejected:  0,
        rejects:   [],
        error:     result.reason?.message || String(result.reason) || 'unknown error',
      });
    }
  }

  // ── ÉTAPE 3 : detectConflicts post-ingest ────────────────────────────────
  // Une seule passe après toutes les sources = détecte les conflits cross-source.
  // § ARCHITECTURE §3.5
  const newConflicts = detectConflicts(store);

  // ── ÉTAPE 4 : stats ──────────────────────────────────────────────────────
  const total_fetched  = sourceReports.reduce((s, r) => s + (r.total     || 0), 0);
  const total_inserted = sourceReports.reduce((s, r) => s + (r.inserted  || 0), 0);
  const total_merged   = sourceReports.reduce((s, r) => s + (r.merged_p1 || 0) + (r.merged_p2 || 0), 0);
  const total_rejected = sourceReports.reduce((s, r) => s + (r.rejected  || 0), 0);
  const allRejects     = sourceReports.flatMap(r => r.rejects || []);

  // ── ÉTAPE 5 : persistance KV ─────────────────────────────────────────────
  // writeStore : events:store:v2 + events:index:date:* + events:conflicts
  // § ARCHITECTURE §4 — flux cible "event-store.js (write KV)"
  await writeStore(env, store);

  // events:rejects:last — audit des events rejetés, TTL 24h
  await env.TAXI_KV.put(
    _REJECTS_KEY,
    JSON.stringify(allRejects),
    { expirationTtl: _REJECTS_TTL_S }
  );

  // events:sync:last — métadonnées du run, sans TTL (historique permanent)
  const ts = new Date().toISOString();
  const duration_ms = Date.now() - startTs;

  await env.TAXI_KV.put(
    _SYNC_LAST_KEY,
    JSON.stringify({
      ts,
      count:       store.events.length,
      sources:     fetchers.map(f => f.name),
      duration_ms,
      rejects:     allRejects.length,
    })
  );

  // ── ÉTAPE 6 : retour ─────────────────────────────────────────────────────
  return {
    ts,
    duration_ms,
    sources:        sourceReports,
    total_fetched,
    total_inserted,
    total_merged,
    total_rejected,
    conflicts_new:  newConflicts.length,
    store_size:     store.events.length,
  };
}
