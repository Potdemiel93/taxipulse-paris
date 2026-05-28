// =============================================================================
// TaxiPulse — sheet-sync.test.js  (Events V2, session S5)
//
// Runner : node src/handlers/sheet-sync.test.js
//
// Pattern identique à ingest.test.js / event-store.test.js :
//   CommonJS wrapper + dynamic import() pour les ES Modules
//   Fake KV en mémoire (Map) + compteur d'écritures par clé (_putCount)
//   fetch mocké par injection (fetchImpl) — pas de réseau
//
// Groupes :
//   G1 — parseSheetCSV : parsing            (T5.1, T5.2, T5.3, T5.8)  4 tests
//   G2 — fetchSheetCSV : erreurs            (T5.6, T5.7)              2 tests
//   G3 — syncSheet : garde-fou store vide   (T5.4)                    1 test
//   G4 — syncSheet : écriture conditionnelle(T5.5a, T5.5b, T5.5c)     3 tests
//   G5 — parseSheetCSV : cat hors enum      (T5.9)                    1 test
//   Total                                                            11 tests
// =============================================================================

'use strict';

const assert            = require('assert/strict');
const { join }          = require('path');
const { pathToFileURL } = require('url');

// ─── Fake KV (Map + compteur d'écritures par clé) ────────────────────────────
function makeFakeKV() {
  const m = new Map();
  const writes = []; // log ordonné des clés put — pour _putCount
  return {
    get:    (k, _opts)    => Promise.resolve(m.has(k) ? m.get(k) : null),
    put:    (k, v, _opts) => { writes.push(k); m.set(k, v); return Promise.resolve(); },
    delete: (k)           => { m.delete(k); return Promise.resolve(); },
    _map:      m,
    _writes:   writes,
    _putCount: (k) => writes.filter(x => x === k).length,
  };
}

function makeEnv(extra = {}) {
  return { TAXI_KV: makeFakeKV(), SHEET_CSV_URL: 'https://sheet.example/export?csv', ...extra };
}

// ─── fetch mocké (Response-like) ─────────────────────────────────────────────
function makeResponse(body, { status = 200, contentType = 'text/csv; charset=utf-8' } = {}) {
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    text:    () => Promise.resolve(body),
  };
}
const csvResponder    = (body) => () => Promise.resolve(makeResponse(body));
const htmlResponder   = ()     => () => Promise.resolve(makeResponse('<html><body>error 500</body></html>', { contentType: 'text/html' }));
const status500Resp   = ()     => () => Promise.resolve(makeResponse('upstream error', { status: 500 }));

// ─── Fixtures CSV ────────────────────────────────────────────────────────────
const HEADER = 'date,heure_debut,heure_fin,venue,titre,cat,source,confirme,notes';

const CSV_NOMINAL =
  HEADER + '\n' +
  '2026-05-15,21:00,23:30,stade_france,Jul - Terre Connue,concert,sofiane,OUI,\n' +
  '2026-05-16,21:00,23:30,stade_france,Jul - Terre Connue,concert,sofiane,OUI,\n';

// BOM UTF-8 (﻿) en tête + fins de ligne Windows CRLF
const CSV_BOM_CRLF =
  '﻿' + HEADER + '\r\n' +
  '2026-05-15,21:00,23:30,stade_france,Jul - Terre Connue,concert,sofiane,OUI,\r\n';

// Titre + notes quotés contenant des virgules
const CSV_QUOTED =
  HEADER + '\n' +
  '2026-06-10,20:00,22:00,zenith,"Daho, en concert",concert,sofiane,OUI,"note, avec virgule"\n';

// 3 lignes invalides (date / venue / titre manquant) + 1 valide
const CSV_MISSING =
  HEADER + '\n' +
  ',20:00,22:00,zenith,Sans date,concert,sofiane,OUI,\n' +
  '2026-06-10,20:00,22:00,,Sans venue,concert,sofiane,OUI,\n' +
  '2026-06-10,20:00,22:00,zenith,,concert,sofiane,OUI,\n' +
  '2026-06-10,20:00,22:00,zenith,Bon event,concert,sofiane,OUI,\n';

// Header seul → 0 data rows (+ une ligne totalement vide à ignorer)
const CSV_EMPTY = HEADER + '\n' + '\n';

// Venue inconnue → toutes lignes rejetées à l'ingest (inserted=0, merged=0)
const CSV_UNKNOWN_VENUE =
  HEADER + '\n' +
  '2026-09-01,20:00,22:00,salle_inconnue_xyz,Concert Mystere,concert,sofiane,OUI,\n';

// Jul 15 manuel (même event qu'un pré-existant qfap) → merged_p1
const CSV_SHEET_JUL15 =
  HEADER + '\n' +
  '2026-05-15,21:00,23:30,stade_france,Jul - Terre Connue,concert,sofiane,OUI,\n';

// Fally "20 ans" manuel (fuzzy avec un pré-existant "Fally Ipupa J1") → merged_p2
const CSV_SHEET_FALLY =
  HEADER + '\n' +
  '2026-05-02,20:00,23:00,stade_france,Fally Ipupa - 20 ans de carriere,concert,sofiane,OUI,\n';

// cat hors enum → normalisée en 'autre'
const CSV_BAD_CAT =
  HEADER + '\n' +
  '2026-07-01,20:00,22:00,louvre,Expo Mystere,musee,sofiane,OUI,\n';

// =============================================================================
(async () => {
  const SYNC_URL  = pathToFileURL(join(__dirname, 'sheet-sync.js')).href;
  const STORE_URL = pathToFileURL(join(__dirname, '..', 'lib', 'event-store.js')).href;
  const INGEST_URL= pathToFileURL(join(__dirname, '..', 'lib', 'ingest.js')).href;

  const { parseSheetCSV, fetchSheetCSV, syncSheet } = await import(SYNC_URL);
  const { readStore, writeStore }                   = await import(STORE_URL);
  const { ingestFromSource }                        = await import(INGEST_URL);

  let passed = 0, failed = 0, total = 0;

  function test(name, fn) {
    total++;
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error(`    → ${err.message}`); failed++; }
  }
  async function testAsync(name, fn) {
    total++;
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error(`    → ${err.message}`); failed++; }
  }

  // ===========================================================================
  //  G1 — parseSheetCSV : parsing
  // ===========================================================================
  console.log('\n── G1 : parseSheetCSV parsing (4 tests) ──');

  test('T5.1 — CSV nominal → 2 rawEvents, venue→venue_raw, champs corrects', () => {
    const { rawEvents, rejects, cat_normalized } = parseSheetCSV(CSV_NOMINAL);
    assert.equal(rawEvents.length, 2);
    assert.equal(rejects.length,   0);
    assert.equal(cat_normalized,   0);
    assert.equal(rawEvents[0].date,        '2026-05-15');
    assert.equal(rawEvents[0].heure_debut, '21:00');
    assert.equal(rawEvents[0].heure_fin,   '23:30');
    assert.equal(rawEvents[0].venue_raw,   'stade_france'); // colonne venue → venue_raw
    assert.equal(rawEvents[0].titre,       'Jul - Terre Connue');
    assert.equal(rawEvents[0].cat,         'concert');
    assert.equal(rawEvents[0].source,      'sofiane');
  });

  test('T5.2 — BOM UTF-8 + CRLF Windows → BOM strippé, parse OK', () => {
    const { rawEvents } = parseSheetCSV(CSV_BOM_CRLF);
    assert.equal(rawEvents.length, 1);
    // Si le BOM n'était pas strippé, la 1re colonne serait "﻿date" → date vide
    assert.equal(rawEvents[0].date,      '2026-05-15');
    assert.equal(rawEvents[0].venue_raw, 'stade_france');
    assert.equal(rawEvents[0].titre,     'Jul - Terre Connue');
  });

  test('T5.3 — titre + notes quotés avec virgule → champs intacts', () => {
    const { rawEvents } = parseSheetCSV(CSV_QUOTED);
    assert.equal(rawEvents.length, 1);
    assert.equal(rawEvents[0].titre, 'Daho, en concert');
    assert.equal(rawEvents[0].notes, 'note, avec virgule');
  });

  test('T5.8 — date/venue/titre manquant → 3 rejects missing_required, 1 valide', () => {
    const { rawEvents, rejects } = parseSheetCSV(CSV_MISSING);
    assert.equal(rawEvents.length, 1);
    assert.equal(rawEvents[0].titre, 'Bon event');
    assert.equal(rejects.length, 3);
    for (const r of rejects) assert.equal(r.reason, 'missing_required');
  });

  // ===========================================================================
  //  G2 — fetchSheetCSV : erreurs
  // ===========================================================================
  console.log('\n── G2 : fetchSheetCSV erreurs (2 tests) ──');

  await testAsync('T5.6 — 200 mais Content-Type text/html → throw invalid_content_type', async () => {
    const env = makeEnv();
    let thrown = null;
    try { await fetchSheetCSV(env, htmlResponder()); }
    catch (e) { thrown = e; }
    assert.ok(thrown, 'fetchSheetCSV devrait throw sur Content-Type non-csv');
    assert.equal(thrown.code, 'invalid_content_type');

    // Et via syncSheet : store jamais écrit, sync:last.error renseigné
    const env2 = makeEnv();
    const res  = await syncSheet(env2, { fetchImpl: htmlResponder() });
    assert.equal(res.ok, false);
    assert.equal(env2.TAXI_KV._putCount('events:store:v2'), 0);
    const meta = JSON.parse(await env2.TAXI_KV.get('events:sync:last'));
    assert.equal(meta.error, 'invalid_content_type');
  });

  await testAsync('T5.7 — fetch status 500 → throw, store inchangé, sync:last.error', async () => {
    const env = makeEnv();
    const res = await syncSheet(env, { fetchImpl: status500Resp() });
    assert.equal(res.ok, false);
    assert.equal(env.TAXI_KV._putCount('events:store:v2'), 0);
    const meta = JSON.parse(await env.TAXI_KV.get('events:sync:last'));
    assert.ok(meta.error, 'sync:last.error devrait être défini');
  });

  // ===========================================================================
  //  G3 — syncSheet : garde-fou anti-store-vide (T5.4)
  // ===========================================================================
  console.log('\n── G3 : garde-fou store vide (1 test) ──');

  await testAsync('T5.4 — CSV 0 row → writeStore PAS appelé, warning sync_empty_csv, store intact, rejects:last écrit', async () => {
    const env = makeEnv();
    // Pré-remplir un store existant qu'on ne doit pas écraser
    const store = await readStore(env);
    ingestFromSource(store, 'qfap', [{
      titre: 'Jul - Terre Connue', date: '2026-05-15', venue_raw: 'stade_france',
      heure_debut: '21:00', source: 'qfap', cat: 'concert',
    }]);
    await writeStore(env, store);
    const putsBefore = env.TAXI_KV._putCount('events:store:v2'); // 1
    const snapBefore = await env.TAXI_KV.get('events:store:v2');

    const res = await syncSheet(env, { fetchImpl: csvResponder(CSV_EMPTY) });

    assert.equal(res.ok, true);
    assert.equal(res.warning, 'sync_empty_csv');
    // writeStore PAS rappelé
    assert.equal(env.TAXI_KV._putCount('events:store:v2'), putsBefore);
    // store précédent intact
    assert.equal(await env.TAXI_KV.get('events:store:v2'), snapBefore);
    // sync:last écrit avec le warning
    const meta = JSON.parse(await env.TAXI_KV.get('events:sync:last'));
    assert.equal(meta.warning, 'sync_empty_csv');
    assert.equal(meta.count, 0);
    // rejects:last écrit (systématique) même vide
    assert.equal(env.TAXI_KV._putCount('events:rejects:last'), 1);
    const rj = JSON.parse(await env.TAXI_KV.get('events:rejects:last'));
    assert.ok(Array.isArray(rj));
    assert.equal(rj.length, 0);
  });

  // ===========================================================================
  //  G4 — syncSheet : écriture conditionnelle (T5.5a/b/c)
  //  Condition de skip = inserted===0 && (merged_p1+merged_p2)===0 && conflicts_new===0
  //  Les 3 sous-cas prouvent que la somme p1+p2 est testée (pas un seul terme).
  // ===========================================================================
  console.log('\n── G4 : écriture conditionnelle (3 tests) ──');

  await testAsync('T5.5a — inserted=0,p1=0,p2=0,conflicts=0 → writeStore SKIP, no_change=true, rejects:last écrit', async () => {
    const env = makeEnv();
    const res = await syncSheet(env, { fetchImpl: csvResponder(CSV_UNKNOWN_VENUE) });

    assert.equal(res.ok, true);
    assert.equal(res.changed, false);
    // store jamais écrit
    assert.equal(env.TAXI_KV._putCount('events:store:v2'), 0);
    // sync:last + rejects:last toujours écrits
    const meta = JSON.parse(await env.TAXI_KV.get('events:sync:last'));
    assert.equal(meta.no_change, true);
    assert.equal(env.TAXI_KV._putCount('events:rejects:last'), 1);
    const rj = JSON.parse(await env.TAXI_KV.get('events:rejects:last'));
    assert.equal(rj.length, 1);
    assert.equal(rj[0].reason, 'unknown_venue');
  });

  await testAsync('T5.5b — inserted=0,p1=1,p2=0,conflicts=0 → writeStore APPELÉ', async () => {
    const env = makeEnv();
    // Pré-existant qfap (aggregator, score 40) — même event que le CSV Sheet
    const store = await readStore(env);
    ingestFromSource(store, 'qfap', [{
      titre: 'Jul - Terre Connue', date: '2026-05-15', venue_raw: 'stade_france',
      heure_debut: '21:00', source: 'qfap', cat: 'concert',
    }]);
    await writeStore(env, store);
    const putsBefore = env.TAXI_KV._putCount('events:store:v2'); // 1

    // CSV Sheet : même event, source manuelle (score 100) → passe 1 sous-cas C → merged_p1=1
    const res = await syncSheet(env, { fetchImpl: csvResponder(CSV_SHEET_JUL15) });

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.report.merged_p1, 1);
    assert.equal(res.report.merged_p2, 0);
    assert.equal(res.report.inserted,  0);
    // writeStore rappelé (1 écriture de plus)
    assert.equal(env.TAXI_KV._putCount('events:store:v2'), putsBefore + 1);
  });

  await testAsync('T5.5c — inserted=0,p1=0,p2=1,conflicts=0 → writeStore APPELÉ (prouve p2 dans la somme)', async () => {
    const env = makeEnv();
    // Pré-existant "Fally Ipupa J1" qfap → slug "fallyipupa"
    const store = await readStore(env);
    ingestFromSource(store, 'qfap', [{
      titre: 'Fally Ipupa J1', date: '2026-05-02', venue_raw: 'stade_france',
      heure_debut: '20:00', source: 'qfap', cat: 'concert',
    }]);
    await writeStore(env, store);
    const putsBefore = env.TAXI_KV._putCount('events:store:v2'); // 1

    // CSV Sheet : "Fally Ipupa - 20 ans de carriere" → slug "fallyipupa20ansdecarriere"
    // même venue+date, heure 20:00 → fuzzy passe 2 (ratio 1.0) → merged_p2=1
    const res = await syncSheet(env, { fetchImpl: csvResponder(CSV_SHEET_FALLY) });

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.report.inserted,  0);
    assert.equal(res.report.merged_p1, 0);
    assert.equal(res.report.merged_p2, 1);
    // writeStore rappelé
    assert.equal(env.TAXI_KV._putCount('events:store:v2'), putsBefore + 1);
  });

  // ===========================================================================
  //  G5 — parseSheetCSV : cat hors enum (T5.9, ZG6)
  // ===========================================================================
  console.log('\n── G5 : cat hors enum (1 test) ──');

  test('T5.9 — cat hors enum → ligne conservée avec cat="autre", cat_normalized=1', () => {
    const { rawEvents, rejects, cat_normalized } = parseSheetCSV(CSV_BAD_CAT);
    assert.equal(rawEvents.length, 1);   // ligne PAS perdue
    assert.equal(rejects.length,   0);   // pas un reject
    assert.equal(rawEvents[0].cat, 'autre');
    assert.equal(cat_normalized,   1);
  });

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
