// =============================================================================
// TaxiPulse — normalize.js  (Events V2, session S2)
//
// Fonctions exportées :
//   titleSlug(titre)                              §3.2 — pipeline 8 étapes
//   venueId(raw)                                  §3.1 — normalise pour VENUE_MAPPING (S3)
//   eventKey(date, vid, slug)                     §3.1 — clé canonique
//   sourceScore(source)                           §3.4 — score 100/70/40/20
//   commonPrefixLen(a, b)                         helper fuzzy
//   fuzzyCanMerge(slugA, slugB, heureA, heureB)   §3.3 — passe 2
//
// Spec de référence : docs/ARCHITECTURE_EVENTS.md §3.1–§3.4
// Dépendances : aucune (pur ES Module)
// =============================================================================

// ─── Constantes privées ──────────────────────────────────────────────────────

const _SOURCE_SCORES = {
  // canonical (100)
  'stadefrance.com':    100,
  'le-zenith.com':      100,
  'rolandgarros.com':   100,
  // ticketing (70)
  'ticketmaster.fr':     70,
  'ticketmaster.com':    70,
  'fnacspectacles.com':  70,
  'digitick.com':        70,
  'openagenda_idf':      70,
  // aggregator (40)
  'qfap':                40,
  'openagenda_fr':       40,
  // scraper (20)
  'sortiraparis.com':    20,
  'offi.fr':             20,
};

const _MANUAL_SOURCES     = ['', 'manuel', 'sofiane', 'sheet'];
const _BLACKLIST_PREFIXES = ['concert', 'spectacle', 'soiree', 'event', 'show'];

// =============================================================================
//  titleSlug(titre) — pipeline §3.2
// =============================================================================
export function titleSlug(titre) {
  if (!titre || typeof titre !== 'string') return '';

  // 1. Lowercase
  let s = titre.toLowerCase();

  // 1.5. Ligatures latines (avant NFD) : Æ/æ → ae, Œ/œ → oe, ß → ss
  s = s.replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss');

  // 2. NFD + suppression diacritiques
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // 2.5. Liaisons : & → et, " + " (avec espaces) → et
  s = s.replace(/&/g, 'et').replace(/ \+ /g, 'et');

  // 3. Marqueurs de journée
  s = s
    .replace(/\bj\d+\b/g, '')
    .replace(/\bjour\s+\d+\b/g, '')
    .replace(/\bjournee\s+\d+\b/g, '')
    .replace(/\bday\s+\d+\b/g, '');

  // 4. Années 4 chiffres
  s = s.replace(/\b\d{4}\b/g, '');

  // 5A. Phase A — strip depuis le séparateur (" - ", " – ", " — ")
  //     Garde-fou : left après strip non-alnum < 4 chars → ne pas appliquer
  //     Alternance : long avant court pour consommer "world tour" comme unité
  const sepIdx = s.search(/\s+[-–—]\s+/);
  if (sepIdx !== -1) {
    const leftRaw   = s.slice(0, sepIdx);
    const rightPart = s.slice(sepIdx);
    const leftClean = leftRaw.replace(/[^a-z0-9]/g, '');
    if (
      leftClean.length >= 4 &&
      /\b(world\s+tour|live\s+tour|the\s+tour|tournee|tour|residence)\b/.test(rightPart)
    ) {
      s = leftRaw;
    }
  }

  // 5B. Phase B — strip mots-outils standalone restants
  //     (long avant court = ordre identique à 5A)
  s = s.replace(/\b(world\s+tour|live\s+tour|the\s+tour|tournee|tour|residence)\b\s*/g, '');

  // 6. Abréviations sportives
  s = s
    .replace(/\bqualifications\b/g, 'qualif')
    .replace(/\bqualifs\b/g, 'qualif');

  // 7. Strip tout sauf [a-z0-9]
  s = s.replace(/[^a-z0-9]/g, '');

  // 8. (Trim — déjà sans whitespace après step 7)
  return s;
}

// =============================================================================
//  venueId(raw) — normalisation brute pour lookup VENUE_MAPPING (défini en S3)
// =============================================================================
export function venueId(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// =============================================================================
//  eventKey(date, vid, slug) — clé canonique §3.1
// =============================================================================
export function eventKey(date, vid, slug) {
  return `${date}|${vid}|${slug}`;
}

// =============================================================================
//  sourceScore(source) — §3.4
// =============================================================================
export function sourceScore(source) {
  const s = (source ?? '').toLowerCase().trim();
  if (_MANUAL_SOURCES.includes(s)) return 100;
  const known = _SOURCE_SCORES[s];
  if (known !== undefined) return known;
  return 40; // domaine inconnu → aggregator
}

// =============================================================================
//  commonPrefixLen(a, b) — longueur du préfixe commun
// =============================================================================
export function commonPrefixLen(a, b) {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

// =============================================================================
//  fuzzyCanMerge(slugA, slugB, heureA, heureB) — §3.3 passe 2
//
//  Retourne true  → fusion autorisée
//  Retourne false → fusion interdite (heure hors plage, blacklist, similarité)
//
//  ⚠️  Si la cause du false est la blacklist (3a), l'appelant DOIT lever
//      un EventConflict — ce contexte est géré dans ingest.js (S4).
// =============================================================================
export function fuzzyCanMerge(slugA, slugB, heureA, heureB) {
  // Condition 2 — écart horaire ≤ 90 min
  if (Math.abs(_toMin(heureA) - _toMin(heureB)) > 90) return false;

  // Slug court / long
  const shortSlug = slugA.length <= slugB.length ? slugA : slugB;
  const longSlug  = slugA.length <= slugB.length ? slugB : slugA;

  // Condition 3a — blacklist anti-générique
  if (_BLACKLIST_PREFIXES.some(p => shortSlug.startsWith(p))) return false;

  // Condition 3b — similarité (l'une OU l'autre)
  const prefLen = commonPrefixLen(shortSlug, longSlug);
  const ratio   = shortSlug.length > 0 ? prefLen / shortSlug.length : 0;

  const standardOK  = shortSlug.length >= 6 && ratio >= 0.85;
  const shortSlugOK = shortSlug.length >= 3 && longSlug.startsWith(shortSlug);

  return standardOK || shortSlugOK;
}

// ─── Helper privé ────────────────────────────────────────────────────────────

function _toMin(heure) {
  const parts = (heure || '00:00').split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}
