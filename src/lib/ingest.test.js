// =============================================================================
// TaxiPulse — ingest.test.js  (Events V2, session S4)
//
// Runner : node src/lib/ingest.test.js
//
// Pattern identique à normalize.test.js et event-store.test.js :
//   CommonJS wrapper + dynamic import() pour les ES Modules
//   Fake KV en mémoire (Map simple)
//   Fetchers mockés (thunks () => Promise<rawEvent[]>)
//
// Groupes :
//   G1 — ingestFromSource basique               (3 tests)
//   G2 — cross-source passe 1                   (1 test)
//   G3 — Sheet override dans ingest              (1 test)
//   G4 — ingestFromSources : crash fetcher       (2 tests)
//   G5 — detectConflicts intégré                 (1 test)
//   G6 — writeStore + sync:last appelés          (2 tests)
//   G7 — stats finales multi-source              (1 test)
//   Total                                        11 tests
// =============================================================================

'use strict';

const assert            = require('assert/strict');
const { join }          = require('path');
const { pathToFileURL } = require('url');

// ─── Fake KV (Map simple) ────────────────────────────────────────────────────
function makeFakeKV() {
  const m = new Map();
  return {
    get:    (k, _opts) => Promise.resolve(m.has(k) ? m.get(k) : null),
    put:    (k, v, _opts) => { m.set(k, v); return Promise.resolve(); },
    delete: (k) => { m.delete(k); return Promise.resolve(); },
    _map:   m, // accès direct pour assertions
  };
}

function makeEnv() {
  return { TAXI_KV: makeFakeKV() };
}

// ─── rawEvent factories ──────────────────────────────────────────────────────

function rawJul(day, overrides = {}) {
  return {
    titre:       'Jul - Terre Connue',
    date:        `2026-05-${String(day).padStart(2, '0')}`,
    venue_raw:   'Stade de France',
    heure_debut: '21:00',
    source:      'stadefrance.com',
    cat:         'concert',
    ...overrides,
  };
}

function rawDaho(overrides = {}) {
  return {
    titre:       'Étienne Daho',
    date:        '2026-06-10',
    venue_raw:   'Zénith Paris',
    heure_debut: '20:00',
    source:      'qfap',
    cat:         'concert',
    ...overrides,
  };
}

function rawRenaud(overrides = {}) {
  return {
    titre:       'Renaud',
    date:        '2026-06-10',
    venue_raw:   'Zénith Paris',
    heure_debut: '20:00',
    source:      'sortiraparis.com',
    cat:         'concert',
    ...overrides,
  };
}

// ─── Fetcher helpers ─────────────────────────────────────────────────────────

/** Fetcher synchrone réussi — retourne des rawEvents immédiats */
function okFetcher(name, rawEvents) {
  return { name, fetch: () => Promise.resolve(rawEvents) };
}

/** Fetcher qui crash avec un message d'erreur */
function crashFetcher(name, message = 'Network error') {
  return { name, fetch: () => Promise.reject(new Error(message)) };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  const INGEST_URL     = pathToFileURL(join(__dirname, 'ingest.js')).href;
  const STORE_URL      = pathToFileURL(join(__dirname, 'event-store.js')).href;

  const { ingestFromSource, ingestFromSources } = await import(INGEST_URL);
  const { readStore }                           = await import(STORE_URL);

  let passed = 0, failed = 0, total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      if (err.expected !== undefined) {
        console.error(`    → attendu : ${JSON.stringify(err.expected)}  reçu : ${JSON.stringify(err.actual)}`);
      } else {
        console.error(`    → ${err.message}`);
      }
      failed++;
    }
  }

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      if (err.expected !== undefined) {
        console.error(`    → attendu : ${JSON.stringify(err.expected)}  reçu : ${JSON.stringify(err.actual)}`);
      } else {
        console.error(`    → ${err.message}`);
      }
      failed++;
    }
  }

  // =========================================================================
  //  G1 — ingestFromSource basique
  // =========================================================================
  console.log('\n── G1 : ingestFromSource basique (3 tests) ──');

  test('3 events propres → inserted=3, total=3, rejected=0', () => {
    const store = { events: [], conflicts: [] };
    const report = ingestFromSource(store, 'stadefrance.com', [
      rawJul(15), rawJul(16), rawJul(17),
    ]);
    assert.equal(report.source,   'stadefrance.com');
    assert.equal(report.total,    3);
    assert.equal(report.inserted, 3);
    assert.equal(report.rejected, 0);
    assert.equal(store.events.length, 3);
  });

  test('2 events identiques → inserted=1, merged_p1=1', () => {
    const store = { events: [], conflicts: [] };
    const report = ingestFromSource(store, 'stadefrance.com', [
      rawJul(15),
      rawJul(15), // doublon exact
    ]);
    assert.equal(report.inserted,  1);
    assert.equal(report.merged_p1, 1);
    assert.equal(store.events.length, 1);
  });

  test('Event venue inconnue → rejected=1, rejects[0].reason="unknown_venue"', () => {
    const store = { events: [], conflicts: [] };
    const report = ingestFromSource(store, 'qfap', [
      {
        titre: 'Concert Mystère', date: '2026-09-01',
        venue_raw: 'Salle Hypothétique XYZ', // hors VENUE_MAPPING
        heure_debut: '20:00', source: 'qfap', cat: 'concert',
      },
    ]);
    assert.equal(report.rejected, 1);
    assert.equal(report.rejects.length, 1);
    assert.equal(report.rejects[0].reason, 'unknown_venue');
    assert.equal(store.events.length, 0);
  });

  // =========================================================================
  //  G2 — cross-source passe 1
  // =========================================================================
  console.log('\n── G2 : cross-source passe 1 (1 test) ──');

  test('2 sources séquentielles, même event → 1 event, sources_count=2', () => {
    const store = { events: [], conflicts: [] };
    // Source 1 : aggregator (score 40)
    ingestFromSource(store, 'qfap', [rawJul(15, { source: 'qfap' })]);
    // Source 2 : canonical (score 100) — même event
    ingestFromSource(store, 'stadefrance.com', [rawJul(15, { source: 'stadefrance.com' })]);
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].sources_count, 2);
    assert.equal(store.events[0].source, 'stadefrance.com'); // winner = meilleure source
    assert.ok(store.events[0].sources_list.includes('qfap'));
    assert.ok(store.events[0].sources_list.includes('stadefrance.com'));
  });

  // =========================================================================
  //  G3 — Sheet override dans ingest
  // =========================================================================
  console.log('\n── G3 : Sheet override (1 test) ──');

  test('Canonical 20h00 puis Sheet 20h30 → Sheet gagne, 1 conflict dans store', () => {
    const store = { events: [], conflicts: [] };
    // 1. Canonical
    ingestFromSource(store, 'stadefrance.com', [
      rawJul(15, { source: 'stadefrance.com', heure_debut: '20:00' }),
    ]);
    assert.equal(store.events[0].heure_debut, '20:00');
    // 2. Sheet override (source='sofiane' = manual)
    ingestFromSource(store, 'sheet', [
      rawJul(15, { source: 'sofiane', heure_debut: '20:30' }),
    ]);
    assert.equal(store.events[0].heure_debut, '20:30'); // Sheet gagne
    assert.equal(store.events.length, 1);
    assert.equal(store.conflicts.length, 1);
    assert.equal(store.conflicts[0].conflict_type, 'time_mismatch');
  });

  // =========================================================================
  //  G4 — ingestFromSources : crash d'un fetcher
  // =========================================================================
  console.log('\n── G4 : ingestFromSources crash fetcher (2 tests) ──');

  await testAsync('Fetcher qui crash → rapport error défini, autres sources traitées', async () => {
    const env   = makeEnv();
    const store = await readStore(env);

    const report = await ingestFromSources(env, store, [
      okFetcher('stadefrance.com', [rawJul(15, { source: 'stadefrance.com' })]),
      crashFetcher('qfap', 'API timeout'),
      okFetcher('sortiraparis.com', [rawJul(16, { source: 'sortiraparis.com' })]),
    ]);

    // Sources[1] (qfap) a crashé
    assert.equal(report.sources[1].source, 'qfap');
    assert.ok(report.sources[1].error, 'error field devrait être défini');
    assert.equal(report.sources[1].total, 0);

    // Mais les 2 autres sources ont fonctionné
    assert.equal(report.total_inserted, 2);
    assert.equal(store.events.length, 2);
  });

  await testAsync('Fetcher crash → total_fetched ne compte pas les events du fetcher crashé', async () => {
    const env   = makeEnv();
    const store = await readStore(env);

    const report = await ingestFromSources(env, store, [
      okFetcher('stadefrance.com', [rawJul(15), rawJul(16), rawJul(17)]),
      crashFetcher('openagenda_fr', 'timeout'),
    ]);

    // total_fetched = events des fetchers réussis seulement
    assert.equal(report.total_fetched, 3);
    assert.equal(report.sources.length, 2);
    assert.ok(report.sources[1].error);
  });

  // =========================================================================
  //  G5 — detectConflicts intégré
  // =========================================================================
  console.log('\n── G5 : detectConflicts intégré (1 test) ──');

  await testAsync('Daho + Renaud même slot via ingestFromSources → conflicts_new=1', async () => {
    const env   = makeEnv();
    const store = await readStore(env);

    const report = await ingestFromSources(env, store, [
      okFetcher('qfap',             [rawDaho()]),
      okFetcher('sortiraparis.com', [rawRenaud()]),
    ]);

    // Deux events distincts + 1 conflit détecté post-ingest
    assert.equal(store.events.length, 2);
    assert.equal(report.conflicts_new, 1);
    assert.equal(store.conflicts.length, 1);
    assert.equal(store.conflicts[0].conflict_type, 'same_slot');
  });

  // =========================================================================
  //  G6 — writeStore + events:sync:last appelés
  // =========================================================================
  console.log('\n── G6 : writeStore + sync:last (2 tests) ──');

  await testAsync('Après ingestFromSources, events:store:v2 présent en KV', async () => {
    const env   = makeEnv();
    const store = await readStore(env);

    await ingestFromSources(env, store, [
      okFetcher('stadefrance.com', [rawJul(15), rawJul(16)]),
    ]);

    const raw = await env.TAXI_KV.get('events:store:v2');
    assert.ok(raw, 'events:store:v2 devrait être présent');
    const restored = JSON.parse(raw);
    assert.equal(restored.version, 'v2');
    assert.equal(restored.events.length, 2);
  });

  await testAsync('Après ingestFromSources, events:sync:last présent et cohérent', async () => {
    const env   = makeEnv();
    const store = await readStore(env);

    await ingestFromSources(env, store, [
      okFetcher('stadefrance.com', [rawJul(15)]),
      okFetcher('qfap',            [rawJul(16)]),
    ]);

    const raw = await env.TAXI_KV.get('events:sync:last');
    assert.ok(raw, 'events:sync:last devrait être présent');
    const meta = JSON.parse(raw);
    assert.equal(meta.count, 2);
    assert.deepEqual(meta.sources, ['stadefrance.com', 'qfap']);
    assert.equal(typeof meta.duration_ms, 'number');
    assert.ok(meta.ts);
  });

  // =========================================================================
  //  G7 — stats finales multi-source
  // =========================================================================
  console.log('\n── G7 : stats finales multi-source (1 test) ──');

  await testAsync('Stats IngestReport correctes après multi-source', async () => {
    const env   = makeEnv();
    const store = await readStore(env);

    // Source A : 3 events
    // Source B : 1 event qui fusionne avec un de la source A (passe 1)
    //            + 1 event nouveau
    const report = await ingestFromSources(env, store, [
      okFetcher('stadefrance.com', [
        rawJul(15, { source: 'stadefrance.com' }),
        rawJul(16, { source: 'stadefrance.com' }),
        rawJul(17, { source: 'stadefrance.com' }),
      ]),
      okFetcher('qfap', [
        rawJul(15, { source: 'qfap' }),        // même event que A → merged_p1
        rawDaho({ source: 'qfap' }),            // event nouveau → inserted
      ]),
    ]);

    // source A = 3 events, source B = 2 events → total_fetched = 5
    assert.equal(report.total_fetched,  5);
    assert.equal(report.total_inserted, 4); // 3 de A + 1 nouveau de B
    assert.equal(report.total_merged,   1); // 1 merged_p1 (Jul 15 déjà dans store)
    assert.equal(report.total_rejected, 0);
    assert.equal(report.store_size,     4); // Jul15 + Jul16 + Jul17 + Daho
    assert.equal(report.sources.length, 2);
  });

  // =========================================================================
  //  Résultat final
  // =========================================================================
  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`✅  ${passed}/${total} tests passés\n`);
  } else {
    console.log(`❌  ${passed}/${total} tests passés — ${failed} ÉCHEC(S)\n`);
    process.exit(1);
  }

})().catch(err => {
  console.error('\nErreur fatale lors du chargement du module :', err.message);
  console.error(err.stack);
  process.exit(1);
});
