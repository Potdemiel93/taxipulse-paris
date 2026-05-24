// =============================================================================
// TaxiPulse — normalize.test.js  (Events V2, session S2)
//
// Runner : node src/lib/normalize.test.js
//
// Pas de package.json → CommonJS wrapper + dynamic import() pour charger
// normalize.js (ES Module). Utilise uniquement des builtins Node.js.
//
// Couverture :
//   Groupe 1 — titleSlug()      : 17 vecteurs §3.2 (13 originaux + 4 nouveaux)
//   Groupe 2 — sourceScore()    :  7 cas §3.4
//   Groupe 3 — fuzzyCanMerge()  :  8 cas §3.3 passe 2
//   Groupe 4 — eventKey/venueId :  5 cas §3.1
//   Groupe 5 — commonPrefixLen  :  4 cas
//   Total                       : 41 tests
// =============================================================================

'use strict';

const assert           = require('assert/strict');
const { join }         = require('path');
const { pathToFileURL } = require('url');

(async () => {
  // Chargement du module ES depuis le même répertoire que ce fichier
  const MODULE_URL = pathToFileURL(join(__dirname, 'normalize.js')).href;
  const {
    titleSlug, venueId, eventKey, sourceScore, commonPrefixLen, fuzzyCanMerge
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
      console.error(`    → attendu : ${err.expected}  reçu : ${err.actual}`);
      failed++;
    }
  }

  // ===========================================================================
  //  Groupe 1 — titleSlug() — 17 vecteurs §3.2
  // ===========================================================================
  console.log('\n── Groupe 1 : titleSlug() — 17 vecteurs §3.2 ──');

  test('Jul - Terre Connue → julterreconnue', () =>
    assert.equal(titleSlug('Jul - Terre Connue'), 'julterreconnue'));

  test('Étienne Daho J2 → etiennedaho (accent + Jn)', () =>
    assert.equal(titleSlug('Étienne Daho J2'), 'etiennedaho'));

  test('Etienne Daho → etiennedaho (sans accent = même slug)', () =>
    assert.equal(titleSlug('Etienne Daho'), 'etiennedaho'));

  test('Roland-Garros 2026 - Qualifications J1 → rolandgarrosqualif', () =>
    assert.equal(titleSlug('Roland-Garros 2026 - Qualifications J1'), 'rolandgarrosqualif'));

  test('Roland-Garros 2026 Qualifs J1 → rolandgarrosqualif (idem → passe 1)', () =>
    assert.equal(titleSlug('Roland-Garros 2026 Qualifs J1'), 'rolandgarrosqualif'));

  test('Fally Ipupa J1 → fallyipupa (Jn strippé)', () =>
    assert.equal(titleSlug('Fally Ipupa J1'), 'fallyipupa'));

  test('Fally Ipupa - 20 ans de carriere → fallyipupa20ansdecarriere', () =>
    assert.equal(titleSlug('Fally Ipupa - 20 ans de carriere'), 'fallyipupa20ansdecarriere'));

  test('Céline Dion - Courage World Tour → celinedion (phase A)', () =>
    assert.equal(titleSlug('Céline Dion - Courage World Tour'), 'celinedion'));

  test('Florent Pagny – L\'Adieu Tour → florentpagny (phase A, en dash)', () =>
    assert.equal(titleSlug('Florent Pagny – L\'Adieu Tour'), 'florentpagny'));

  test('Bigflo & Oli → bigfloetoli (step 2.5 : & → et)', () =>
    assert.equal(titleSlug('Bigflo & Oli'), 'bigfloetoli'));

  test('Bigflo et Oli → bigfloetoli (idem → passe 1)', () =>
    assert.equal(titleSlug('Bigflo et Oli'), 'bigfloetoli'));

  test('Anyma - ÆDEN → anymaaeden (step 1.5 : Æ → ae, 10 chars)', () =>
    assert.equal(titleSlug('Anyma - ÆDEN'), 'anymaaeden'));

  test('Anyma → anyma (slug court → exception fuzzy passe 2)', () =>
    assert.equal(titleSlug('Anyma'), 'anyma'));

  // Vecteurs ajoutés (Ajustement 2) —————————————————————————————————————————

  test('Bruno Mars - The Romantic Tour → brunomars (phase A : \\btour\\b en fin)', () =>
    assert.equal(titleSlug('Bruno Mars - The Romantic Tour'), 'brunomars'));

  test('Iron Maiden - Run For Your Lives World Tour → ironmaiden (phase A : world tour)', () =>
    assert.equal(titleSlug('Iron Maiden - Run For Your Lives World Tour'), 'ironmaiden'));

  test('Hockey France - Canada → hockeyfrancecanada (phase A non déclenchée)', () =>
    assert.equal(titleSlug('Hockey France - Canada'), 'hockeyfrancecanada'));

  test('Concert TBA → concerttba (pas de séparateur, pas de mot-outil)', () =>
    assert.equal(titleSlug('Concert TBA'), 'concerttba'));

  // ===========================================================================
  //  Groupe 2 — sourceScore() — 7 cas §3.4
  // ===========================================================================
  console.log('\n── Groupe 2 : sourceScore() — 7 cas §3.4 ──');

  test('"stadefrance.com" → 100 (canonical)', () =>
    assert.equal(sourceScore('stadefrance.com'), 100));

  test('"ticketmaster.fr" → 70 (ticketing)', () =>
    assert.equal(sourceScore('ticketmaster.fr'), 70));

  test('"qfap" → 40 (aggregator)', () =>
    assert.equal(sourceScore('qfap'), 40));

  test('"sortiraparis.com" → 20 (scraper)', () =>
    assert.equal(sourceScore('sortiraparis.com'), 20));

  test('"" (vide) → 100 (manuel/Sheet)', () =>
    assert.equal(sourceScore(''), 100));

  test('"sofiane" → 100 (manuel)', () =>
    assert.equal(sourceScore('sofiane'), 100));

  test('"inconnudomain.com" → 40 (domaine inconnu → aggregator)', () =>
    assert.equal(sourceScore('inconnudomain.com'), 40));

  // ===========================================================================
  //  Groupe 3 — fuzzyCanMerge() — 8 cas §3.3 passe 2
  // ===========================================================================
  console.log('\n── Groupe 3 : fuzzyCanMerge() — 8 cas §3.3 passe 2 ──');

  test('T5-fuzzy : Fally J1 vs "20 ans" (même heure) → true [ratio=1.0 ≥ 0.85, len=10 ≥ 6]', () =>
    assert.equal(fuzzyCanMerge('fallyipupa', 'fallyipupa20ansdecarriere', '21:00', '21:00'), true));

  test('Anyma vs anymaaeden (même heure) → true [exception slug court len=5 ≥ 3]', () =>
    assert.equal(fuzzyCanMerge('anyma', 'anymaaeden', '22:00', '22:00'), true));

  test('BTS vs btsworld (même heure) → true [exception slug court len=3 = seuil min]', () =>
    assert.equal(fuzzyCanMerge('bts', 'btsworld', '20:00', '20:00'), true));

  test('Blacklist : "concertrock" commence par "concert" → false', () =>
    assert.equal(fuzzyCanMerge('concertrock', 'concertrockalt', '20:00', '20:00'), false));

  test('Blacklist : "spectaclehumour" commence par "spectacle" → false', () =>
    assert.equal(fuzzyCanMerge('spectaclehumour', 'spectaclehumourgrand', '21:00', '21:00'), false));

  test('T2-fuzzy : Daho vs Renaud (ratio~0) → false [titres sans rapport]', () =>
    assert.equal(fuzzyCanMerge('etiennedaho', 'renaud', '20:00', '20:00'), false));

  test('T3 : RG session 10h vs 19h → false [540 min > 90 min]', () =>
    assert.equal(fuzzyCanMerge('rolandgarrosqualif', 'rolandgarrosqualif', '10:00', '19:00'), false));

  test('julterreconnue vs julterreconnuebis (même heure) → true [ratio=1.0 ≥ 0.85]', () =>
    assert.equal(fuzzyCanMerge('julterreconnue', 'julterreconnuebis', '20:00', '20:00'), true));

  // ===========================================================================
  //  Groupe 4 — eventKey() + venueId() — 5 cas §3.1
  // ===========================================================================
  console.log('\n── Groupe 4 : eventKey() + venueId() — 5 cas §3.1 ──');

  test('eventKey : format exact "date|venue|slug"', () =>
    assert.equal(
      eventKey('2026-05-15', 'stade_france', 'julterreconnue'),
      '2026-05-15|stade_france|julterreconnue'
    ));

  test('venueId : "Stade de France" → "stade_de_france"', () =>
    assert.equal(venueId('Stade de France'), 'stade_de_france'));

  test('T1 : Jul J1 et J2 ont des clés distinctes (date différente)', () => {
    const slug  = titleSlug('Jul - Terre Connue');
    const keyJ1 = eventKey('2026-05-15', 'stade_france', slug);
    const keyJ2 = eventKey('2026-05-16', 'stade_france', slug);
    assert.notEqual(keyJ1, keyJ2);
  });

  test('T4 : RG Qualifs J1 et Qualifications J1 → même clé (passe 1)', () => {
    const slug1 = titleSlug('Roland-Garros 2026 - Qualifications J1');
    const slug2 = titleSlug('Roland-Garros 2026 Qualifs J1');
    assert.equal(slug1, slug2);
    assert.equal(
      eventKey('2026-05-26', 'roland_garros', slug1),
      eventKey('2026-05-26', 'roland_garros', slug2)
    );
  });

  test('T6 : Céline Dion résidence — 16 dates → 16 clés distinctes', () => {
    const slug = titleSlug('Céline Dion - Courage World Tour');
    const keys = Array.from({ length: 16 }, (_, i) =>
      eventKey(`2026-06-${String(i + 1).padStart(2, '0')}`, 'accor_arena', slug)
    );
    assert.equal(new Set(keys).size, 16);
  });

  // ===========================================================================
  //  Groupe 5 — commonPrefixLen() — 4 cas
  // ===========================================================================
  console.log('\n── Groupe 5 : commonPrefixLen() — 4 cas ──');

  test('("fallyipupa", "fallyipupa20ansdecarriere") → 10', () =>
    assert.equal(commonPrefixLen('fallyipupa', 'fallyipupa20ansdecarriere'), 10));

  test('("abc", "xyz") → 0 (aucun préfixe commun)', () =>
    assert.equal(commonPrefixLen('abc', 'xyz'), 0));

  test('("", "abc") → 0 (chaîne vide)', () =>
    assert.equal(commonPrefixLen('', 'abc'), 0));

  test('("abc", "abc") → 3 (préfixe = chaîne entière)', () =>
    assert.equal(commonPrefixLen('abc', 'abc'), 3));

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
  process.exit(1);
});
