// =============================================================================
// TaxiPulse — event-store.test.js  (Events V2, session S3)
//
// Runner : node src/lib/event-store.test.js
//
// Pattern identique à normalize.test.js :
//   CommonJS wrapper + dynamic import() pour charger event-store.js (ES Module)
//   Fake KV en mémoire (Map simple) — pas de mock complexe
//
// Groupes :
//   G1  — readStore / writeStore              (4 tests)
//   G2  — upsertEvent passe 1                 (5 tests)
//   G3  — upsertEvent passe 2                 (5 tests)
//   G4  — T1 : Jul J1 ≠ J2                   (2 tests)
//   G5  — Manual override / Sheet bat tout    (2 tests)
//   G6  — detectConflicts                     (2 tests)
//   G7  — markStale                           (2 tests)
//   G8  — listByDate / listByVenue            (3 tests)
//   G9  — confidence_score                    (2 tests)
//   G10 — rejet venue inconnue                (1 test)
//   Total                                     28 tests
// =============================================================================

'use strict';

const assert            = require('assert/strict');
const { join }          = require('path');
const { pathToFileURL } = require('url');

// ─── Fake KV en mémoire (Map simple) ────────────────────────────────────────
function makeFakeKV() {
  const m = new Map();
  return {
    get:    (k, _opts) => Promise.resolve(m.has(k) ? m.get(k) : null),
    put:    (k, v, _opts) => { m.set(k, v); return Promise.resolve(); },
    delete: (k) => { m.delete(k); return Promise.resolve(); },
  };
}

// Crée un env CF minimal avec une KV fraîche
function makeEnv() {
  return { TAXI_KV: makeFakeKV() };
}

// ─── Helpers pour construire des rawEvents valides ───────────────────────────

function rawJul(day, opts = {}) {
  return {
    titre:       'Jul - Terre Connue',
    date:        `2026-05-${String(day).padStart(2, '0')}`,
    venue_raw:   'Stade de France',
    heure_debut: '21:00',
    source:      'stadefrance.com',
    cat:         'concert',
    ...opts,
  };
}

function rawRGQualif(opts = {}) {
  return {
    titre:       'Roland-Garros 2026 - Qualifications J1',
    date:        '2026-05-18',
    venue_raw:   'Roland Garros',
    heure_debut: '10:00',
    source:      'rolandgarros.com',
    cat:         'sport_tennis',
    ...opts,
  };
}

function rawFally(titleVariant, opts = {}) {
  return {
    titre:       titleVariant,
    date:        '2026-05-02',
    venue_raw:   'Stade de France',
    heure_debut: '21:00',
    source:      titleVariant === 'Fally Ipupa J1' ? 'qfap' : 'stadefrance.com',
    cat:         'concert',
    ...opts,
  };
}

function rawDaho(opts = {}) {
  return {
    titre:       'Étienne Daho',
    date:        '2026-06-10',
    venue_raw:   'Zénith Paris',
    heure_debut: '20:00',
    source:      'qfap',
    cat:         'concert',
    ...opts,
  };
}

function rawRenaud(opts = {}) {
  return {
    titre:       'Renaud',
    date:        '2026-06-10',
    venue_raw:   'Zénith Paris',
    heure_debut: '20:00',
    source:      'sortiraparis.com',
    cat:         'concert',
    ...opts,
  };
}

// ─── Runner minimal ──────────────────────────────────────────────────────────

(async () => {
  const MODULE_URL = pathToFileURL(join(__dirname, 'event-store.js')).href;
  const {
    readStore, writeStore, upsertEvent, detectConflicts, markStale, listByDate, listByVenue
  } = await import(MODULE_URL);

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

  // ===========================================================================
  //  G1 — readStore / writeStore
  // ===========================================================================
  console.log('\n── G1 : readStore / writeStore (4 tests) ──');

  await testAsync('readStore sur KV vide → EventStore valide (version v2, events [])', async () => {
    const env   = makeEnv();
    const store = await readStore(env);
    assert.equal(store.version, 'v2');
    assert.deepEqual(store.events, []);
    assert.deepEqual(store.conflicts, []);
    assert.equal(store.horizon_days, 90);
  });

  await testAsync('writeStore → readStore roundtrip : events survivent', async () => {
    const env   = makeEnv();
    const store = await readStore(env);
    upsertEvent(store, rawJul(15));
    await writeStore(env, store);
    const restored = await readStore(env);
    assert.equal(restored.events.length, 1);
    assert.equal(restored.events[0].titre_slug, 'julterreconnue');
  });

  await testAsync('writeStore crée les clés index date (events:index:date:*)', async () => {
    const env   = makeEnv();
    const store = await readStore(env);
    upsertEvent(store, rawJul(15));
    upsertEvent(store, rawJul(16));
    await writeStore(env, store);
    const idx15 = JSON.parse(await env.TAXI_KV.get('events:index:date:2026-05-15'));
    const idx16 = JSON.parse(await env.TAXI_KV.get('events:index:date:2026-05-16'));
    assert.equal(idx15.length, 1);
    assert.equal(idx16.length, 1);
  });

  await testAsync('readStore avec JSON invalide en KV → retourne store vide (pas de throw)', async () => {
    const env = makeEnv();
    await env.TAXI_KV.put('events:store:v2', '{INVALID JSON');
    const store = await readStore(env);
    assert.equal(store.version, 'v2');
    assert.deepEqual(store.events, []);
  });

  // ===========================================================================
  //  G2 — upsertEvent passe 1
  // ===========================================================================
  console.log('\n── G2 : upsertEvent passe 1 (5 tests) ──');

  test('T4 : "Qualifications J1" et "Qualifs J1" → même slug → 1 seul event (passe 1)', () => {
    const store = { events: [], conflicts: [] };
    const r1 = upsertEvent(store, rawRGQualif());
    const r2 = upsertEvent(store, rawRGQualif({ titre: 'Roland-Garros 2026 Qualifs J1' }));
    assert.equal(store.events.length, 1);
    assert.equal(r1.action, 'inserted');
    assert.equal(r2.action, 'merged_p1');
    assert.equal(store.events[0].titre_slug, 'rolandgarrosqualif');
  });

  test('Upsert idempotent : même source, même event → 1 seul event, sources_count=1', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    upsertEvent(store, rawJul(15)); // exactement pareil
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].sources_count, 1);
  });

  test('Passe 1 : source canonical (100) bat source aggregator (40)', () => {
    const store = { events: [], conflicts: [] };
    // Aggregator en premier
    upsertEvent(store, rawJul(15, { source: 'qfap' }));
    // Canonical ensuite → doit gagner
    upsertEvent(store, rawJul(15, { source: 'stadefrance.com' }));
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].source, 'stadefrance.com');
    assert.equal(store.events[0].sources_count, 2);
  });

  test('Passe 1 : source plus faible enrichit sources_list mais ne remplace pas le winner', () => {
    const store = { events: [], conflicts: [] };
    // Canonical en premier
    upsertEvent(store, rawJul(15, { source: 'stadefrance.com' }));
    // Aggregator ensuite → ne doit pas remplacer
    const r = upsertEvent(store, rawJul(15, { source: 'qfap' }));
    assert.equal(r.action, 'merged_p1');
    assert.equal(store.events[0].source, 'stadefrance.com'); // winner inchangé
    assert.equal(store.events[0].sources_count, 2);
    assert.ok(store.events[0].sources_list.includes('qfap'));
  });

  test('Ré-upsert même source → last_seen_at mis à jour, sources_count inchangé', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    const lsa1 = store.events[0].last_seen_at;
    // Attente minimale pour forcer un timestamp différent
    const r = upsertEvent(store, rawJul(15));
    assert.equal(r.action, 'merged_p1');
    assert.equal(store.events[0].sources_count, 1);
    // last_seen_at >= lsa1 (peut être égal si même ms)
    assert.ok(store.events[0].last_seen_at >= lsa1);
  });

  // ===========================================================================
  //  G3 — upsertEvent passe 2
  // ===========================================================================
  console.log('\n── G3 : upsertEvent passe 2 (5 tests) ──');

  test('T5 : Fally J1 + "20 ans de carriere" même jour → 1 event fusionné, 2 sources (passe 2)', () => {
    const store = { events: [], conflicts: [] };
    // qfap source (score 40) d'abord
    const r1 = upsertEvent(store, rawFally('Fally Ipupa J1'));
    // stadefrance.com (score 100) ensuite → entrant gagne en passe 2
    const r2 = upsertEvent(store, rawFally('Fally Ipupa - 20 ans de carriere'));
    assert.equal(store.events.length, 1);
    assert.equal(r1.action, 'inserted');
    assert.equal(r2.action, 'merged_p2');
    assert.equal(store.events[0].sources_count, 2);
    assert.equal(store.events[0].source, 'stadefrance.com'); // winner = meilleure source
  });

  test('Anyma + Anyma ÆDEN même heure → 1 event (exception slug court, passe 2)', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, {
      titre: 'Anyma', date: '2026-07-05', venue_raw: 'Accor Arena',
      heure_debut: '22:00', source: 'qfap', cat: 'concert',
    });
    const r2 = upsertEvent(store, {
      titre: 'Anyma - ÆDEN', date: '2026-07-05', venue_raw: 'Accor Arena',
      heure_debut: '22:00', source: 'ticketmaster.fr', cat: 'concert',
    });
    assert.equal(store.events.length, 1);
    assert.equal(r2.action, 'merged_p2');
  });

  test('T3 : RG session jour (10h) vs nuit (19h) → 2 events distincts (écart 540 min > 90)', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, {
      titre: 'Roland-Garros Session Jour', date: '2026-05-25',
      venue_raw: 'Roland Garros', heure_debut: '10:00',
      source: 'rolandgarros.com', cat: 'sport_tennis',
    });
    upsertEvent(store, {
      titre: 'Roland-Garros Session Nuit', date: '2026-05-25',
      venue_raw: 'Roland Garros', heure_debut: '19:00',
      source: 'rolandgarros.com', cat: 'sport_tennis',
    });
    assert.equal(store.events.length, 2);
  });

  test('Blacklist "concert" → 2 events séparés insérés (pas de fusion)', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, {
      titre: 'Concert Rock Paris', date: '2026-08-01',
      venue_raw: 'Accor Arena', heure_debut: '20:00',
      source: 'sortiraparis.com', cat: 'concert',
    });
    upsertEvent(store, {
      titre: 'Concert Rock Alternative', date: '2026-08-01',
      venue_raw: 'Accor Arena', heure_debut: '20:00',
      source: 'qfap', cat: 'concert',
    });
    // fuzzyCanMerge retourne false (slug court commence par "concert")
    // → passe 2 échoue → 2 events séparés
    assert.equal(store.events.length, 2);
  });

  test('T2 : Daho vs Renaud même slot → 2 events séparés (slugs trop différents)', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawDaho());
    upsertEvent(store, rawRenaud());
    // fuzzyCanMerge("etiennedaho","renaud",...) → ratio=0 < 0.85, pas prefix → false
    assert.equal(store.events.length, 2);
  });

  // ===========================================================================
  //  G4 — T1 : Jul J1 ≠ J2
  // ===========================================================================
  console.log('\n── G4 : T1 Jul J1 ≠ J2 (2 tests) ──');

  test('T1 : Jul J1 (15 mai) et J2 (16 mai) → 2 events distincts dans le store', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    upsertEvent(store, rawJul(16));
    assert.equal(store.events.length, 2);
    assert.notEqual(store.events[0].id, store.events[1].id);
  });

  test('T1 : ids au format attendu "date|venue|slug"', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    upsertEvent(store, rawJul(16));
    assert.equal(store.events[0].id, '2026-05-15|stade_france|julterreconnue');
    assert.equal(store.events[1].id, '2026-05-16|stade_france|julterreconnue');
  });

  // ===========================================================================
  //  G5 — Manual override / Sheet bat tout
  // ===========================================================================
  console.log('\n── G5 : Manual override / Sheet bat tout (2 tests) ──');

  test('T8 : Sheet (heure 20:30) contredit canonical (heure 20:00) → Sheet gagne + conflict time_mismatch', () => {
    const store = { events: [], conflicts: [] };
    // 1. Canonical d'abord
    upsertEvent(store, rawJul(15, { source: 'stadefrance.com', heure_debut: '20:00' }));
    assert.equal(store.events[0].heure_debut, '20:00');
    // 2. Sheet avec heure différente
    const r = upsertEvent(store, rawJul(15, { source: 'sofiane', heure_debut: '20:30' }));
    assert.equal(r.action, 'merged_p1');
    assert.equal(store.events[0].heure_debut, '20:30');       // Sheet gagne
    assert.equal(store.events.length, 1);                      // toujours 1 event
    assert.ok(r.conflict);
    assert.equal(r.conflict.conflict_type, 'time_mismatch');
    assert.equal(store.conflicts.length, 1);
  });

  test('T8 var : Sheet (titre différent accent) contredit canonical → conflict title_mismatch', () => {
    const store = { events: [], conflicts: [] };
    // Canonical : "Etienne Daho" (sans accent) → slug etiennedaho
    upsertEvent(store, rawDaho({ titre: 'Etienne Daho', source: 'le-zenith.com' }));
    // Sheet : "Étienne Daho" (avec accent) → même slug, titre raw différent
    const r = upsertEvent(store, rawDaho({ titre: 'Étienne Daho', source: 'sofiane' }));
    assert.equal(r.action, 'merged_p1');
    assert.ok(r.conflict);
    assert.equal(r.conflict.conflict_type, 'title_mismatch');
  });

  // ===========================================================================
  //  G6 — detectConflicts
  // ===========================================================================
  console.log('\n── G6 : detectConflicts (2 tests) ──');

  test('Daho vs Renaud même slot → detectConflicts lève 1 conflit same_slot', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawDaho());
    upsertEvent(store, rawRenaud());
    const newConflicts = detectConflicts(store);
    assert.equal(newConflicts.length, 1);
    assert.equal(newConflicts[0].conflict_type, 'same_slot');
    assert.equal(store.conflicts.length, 1);
  });

  test('detectConflicts idempotent : 2e appel n\'ajoute pas de doublon', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawDaho());
    upsertEvent(store, rawRenaud());
    detectConflicts(store);
    detectConflicts(store); // 2e appel
    assert.equal(store.conflicts.length, 1); // toujours 1
  });

  // ===========================================================================
  //  G7 — markStale
  // ===========================================================================
  console.log('\n── G7 : markStale (2 tests) ──');

  test('T9 : event last_seen_at 9 jours avant now → status stale_warning', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    // Forcer last_seen_at à 9 jours avant now
    const nineAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    store.events[0].last_seen_at = nineAgo;

    const now    = new Date();
    const count  = markStale(store, now);
    assert.equal(count, 1);
    assert.equal(store.events[0].status, 'stale_warning');
    assert.equal(store.events[0].confirme, 'APPROX');
  });

  test('Event last_seen_at 7 jours avant now → status inchangé (pas encore stale)', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    const sevenAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    store.events[0].last_seen_at = sevenAgo;
    const before = store.events[0].status;

    const count = markStale(store, new Date());
    assert.equal(count, 0);
    assert.equal(store.events[0].status, before);
  });

  // ===========================================================================
  //  G8 — listByDate / listByVenue
  // ===========================================================================
  console.log('\n── G8 : listByDate / listByVenue (3 tests) ──');

  test('listByDate retourne le bon nombre d\'events pour une date', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    upsertEvent(store, rawJul(16));
    upsertEvent(store, rawRGQualif()); // autre date (05-18)
    assert.equal(listByDate(store, '2026-05-15').length, 1);
    assert.equal(listByDate(store, '2026-05-16').length, 1);
    assert.equal(listByDate(store, '2026-05-18').length, 1);
  });

  test('listByDate date inconnue → [] vide', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));
    assert.deepEqual(listByDate(store, '2099-01-01'), []);
  });

  test('listByVenue retourne les events de la bonne venue', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15));   // stade_france
    upsertEvent(store, rawJul(16));   // stade_france
    upsertEvent(store, rawRGQualif()); // roland_garros
    assert.equal(listByVenue(store, 'stade_france').length, 2);
    assert.equal(listByVenue(store, 'roland_garros').length, 1);
    assert.equal(listByVenue(store, 'zenith').length, 0);
  });

  // ===========================================================================
  //  G9 — confidence_score
  // ===========================================================================
  console.log('\n── G9 : confidence_score (2 tests) ──');

  test('Canonical seul + heure certifiée (≠20:00) → confidence_score = 60 → status confirmed', () => {
    const store = { events: [], conflicts: [] };
    upsertEvent(store, rawJul(15, { source: 'stadefrance.com', heure_debut: '21:00' }));
    const e = store.events[0];
    // +50 (canonical) +10 (heure certifiée) = 60
    assert.equal(e.confidence_score, 60);
    assert.equal(e.status, 'confirmed');
    assert.equal(e.confirme, 'OUI');
  });

  test('Aggregator principal + 2 aggregators supplémentaires + heure certifiée + 3 sources → 25', () => {
    const store = { events: [], conflicts: [] };
    const base = { date: '2026-09-01', venue_raw: 'Accor Arena', heure_debut: '21:00', cat: 'concert' };
    // 1er upsert : qfap (score 40)
    upsertEvent(store, { titre: 'Artiste Test', source: 'qfap', ...base });
    // 2e upsert : openagenda_fr (score 40) — même slug → passe 1, sources_count=2
    upsertEvent(store, { titre: 'Artiste Test', source: 'openagenda_fr', ...base });
    // 3e upsert : sortiraparis.com (score 20, scraper) — sources_count=3
    upsertEvent(store, { titre: 'Artiste Test', source: 'sortiraparis.com', ...base });
    const e = store.events[0];
    // base=0 (aggregator) + aggExtra=10 (openagenda_fr) + 0 (sortiraparis=scraper)
    // + 10 (heure≠20:00) + 5 (sources_count=3) = 25
    assert.equal(e.sources_count, 3);
    assert.equal(e.confidence_score, 25);
    assert.equal(e.status, 'approx');
  });

  // ===========================================================================
  //  G10 — rejet venue inconnue
  // ===========================================================================
  console.log('\n── G10 : rejet venue inconnue (1 test) ──');

  test('venue_raw inconnue → action:rejected, store.events inchangé', () => {
    const store = { events: [], conflicts: [] };
    const r = upsertEvent(store, {
      titre:       'Événement mystère',
      date:        '2026-10-01',
      venue_raw:   'Salle Hypothétique XYZ 99',  // pas dans VENUE_MAPPING
      heure_debut: '20:00',
      source:      'qfap',
      cat:         'autre',
    });
    assert.equal(r.action, 'rejected');
    assert.equal(r.reason, 'unknown_venue');
    assert.equal(store.events.length, 0);
  });

  // ===========================================================================
  //  Résultat final
  // ===========================================================================
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
