// =============================================================================
// TaxiPulse — sheet-sync.js  (Events V2, session S5)
//
// Fonctions exportées :
//   parseSheetCSV(text)            — CSV → { rawEvents[], rejects[], cat_normalized }
//   fetchSheetCSV(env, fetchImpl?) — GET env.SHEET_CSV_URL, check status + Content-Type
//   syncSheet(env, { fetchImpl }?) — orchestration : fetch → parse → ingest → write KV
//
// Responsabilité : lire le Google Sheet (export CSV), normaliser les lignes,
//   les passer dans le pipeline ingest (event-store.js), persister le store KV.
//   Option (b) S5 : c'est ICI qu'on décide d'écrire le store, pas dans ingest.js.
//
// Garde-fous S5 :
//   [AJUST 1] CSV parsé mais 0 row valide → on N'écrit PAS le store (warning sync_empty_csv).
//   [AJUST 2] Aucune mutation (inserted=0 && merged_p1+merged_p2=0 && conflicts_new=0)
//             → on N'écrit PAS le store. Seules les méta (sync:last + rejects:last) le sont.
//   [AJUST 3] Content-Type ≠ text/csv (Google renvoie parfois du HTML en 200) → erreur.
//
// events:store:v2 est conditionnel ; events:sync:last et events:rejects:last sont
//   TOUJOURS écrits (diagnostic opérationnel — § CHANTIER_EVENTS_STATE Micro 2).
//
// Spec de référence :
//   docs/ARCHITECTURE_EVENTS.md §2.3, §3.3–§3.4, §4
//   docs/EVENT_SCHEMA.md §2 (enum cat)
//   docs/CHANTIER_EVENTS_STATE.md §5 (colonnes CSV, zones grises)
// =============================================================================

import { ingestFromSource }                      from '../lib/ingest.js';
import { readStore, writeStore, detectConflicts } from '../lib/event-store.js';

// ─── Constantes privées ──────────────────────────────────────────────────────

const _SYNC_LAST_KEY = 'events:sync:last';
const _REJECTS_KEY    = 'events:rejects:last';
const _REJECTS_TTL_S  = 86_400; // 24 heures
const _SOURCE_NAME    = 'sheet';

// Colonnes attendues du CSV Sheet — § CHANTIER_EVENTS_STATE §5
const _COLS = ['date', 'heure_debut', 'heure_fin', 'venue', 'titre', 'cat', 'source', 'confirme', 'notes'];

// Catégories valides — § EVENT_SCHEMA.md §2. Hors enum → 'autre' (ZG6).
const _VALID_CATS = new Set([
  'concert', 'concert_classique', 'concert_metal',
  'sport_foot', 'sport_rugby', 'sport_tennis', 'sport_basket', 'sport_hand', 'sport',
  'spectacle_humour', 'theatre', 'danse',
  'exposition', 'salon', 'conference', 'course', 'autre',
]);

// =============================================================================
//  Parseur CSV (machine à états) — gère guillemets, virgules et sauts de ligne
//  à l'intérieur des champs quotés, ainsi que les "" échappés.
//  Le texte est supposé déjà débarrassé du BOM et normalisé en LF.
// =============================================================================
function _parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // guillemet échappé
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"')      inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
    else                field += c;
  }
  // Dernier champ / dernière ligne sans saut final
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// =============================================================================
//  parseSheetCSV(text)
//  → { rawEvents, rejects, cat_normalized }
//
//  rawEvents : lignes valides au format upsertEvent (colonne `venue` → `venue_raw`).
//  rejects   : lignes perdues (date/venue/titre manquant) — reason 'missing_required'.
//  cat_normalized : nb de lignes dont la cat (non vide) hors enum a été ramenée à 'autre'.
//
//  Règles : strip BOM, CRLF→LF, skip lignes totalement vides, mapping par nom de colonne.
// =============================================================================
export function parseSheetCSV(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // BOM UTF-8
  s = s.replace(/\r\n?/g, '\n');                  // CRLF / CR → LF

  const rows = _parseCSV(s);
  const rawEvents = [];
  const rejects   = [];
  let cat_normalized = 0;

  if (rows.length === 0) return { rawEvents, rejects, cat_normalized };

  // Index colonne par nom (robuste à un éventuel ré-ordonnancement)
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = {};
  for (const col of _COLS) idx[col] = header.indexOf(col);

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if (cols.every(c => (c == null || String(c).trim() === ''))) continue; // ligne vide → skip

    const get = (name) => {
      const j = idx[name];
      return (j >= 0 && j < cols.length) ? String(cols[j] ?? '').trim() : '';
    };

    const date  = get('date');
    const venue = get('venue');
    const titre = get('titre');

    if (!date || !venue || !titre) {
      rejects.push({
        reason:    'missing_required',
        date,
        venue_raw: venue,
        titre,
        source:    get('source') || _SOURCE_NAME,
      });
      continue;
    }

    let cat = get('cat');
    if (!cat) {
      cat = 'autre'; // vide → défaut silencieux (pas de warning)
    } else if (!_VALID_CATS.has(cat)) {
      cat = 'autre'; // hors enum → défaut + warning (ZG6)
      cat_normalized++;
    }

    rawEvents.push({
      date,
      heure_debut: get('heure_debut'),
      heure_fin:   get('heure_fin'),
      venue_raw:   venue,        // colonne `venue` → venue_raw (VENUE_MAPPING l'attend brute)
      titre,
      cat,
      source:      get('source'), // '' → traité comme manuel/canonical par upsertEvent
      notes:       get('notes'),
    });
  }

  return { rawEvents, rejects, cat_normalized };
}

// =============================================================================
//  fetchSheetCSV(env, fetchImpl?)
//  GET env.SHEET_CSV_URL → texte CSV.
//  Throw Error avec `.code` : 'no_url' | 'http_<status>' | 'invalid_content_type'.
//  [AJUST 3] Content-Type doit commencer par "text/csv" (insensible à la casse) —
//  Google peut renvoyer une page HTML d'erreur avec un statut 200.
// =============================================================================
export async function fetchSheetCSV(env, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url = env.SHEET_CSV_URL;
  if (!url) {
    const e = new Error('SHEET_CSV_URL non configurée'); e.code = 'no_url'; throw e;
  }

  const resp = await doFetch(url, {
    headers: { 'cache-control': 'no-store' },
    cf: { cacheTtl: 0 },
  });

  if (!resp.ok) {
    const e = new Error(`HTTP ${resp.status}`); e.code = `http_${resp.status}`; throw e;
  }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('text/csv')) {
    const e = new Error(`Content-Type inattendu : ${ct || '(absent)'}`);
    e.code = 'invalid_content_type';
    throw e;
  }

  return await resp.text();
}

// ─── Helpers d'écriture KV (méta toujours persistées) ────────────────────────

function _writeSyncLast(env, meta) {
  // events:sync:last — pas de TTL (historique permanent) — § ARCHITECTURE §4
  return env.TAXI_KV.put(_SYNC_LAST_KEY, JSON.stringify(meta));
}

function _writeRejects(env, rejects) {
  // events:rejects:last — TTL 24h — § ARCHITECTURE §4
  return env.TAXI_KV.put(_REJECTS_KEY, JSON.stringify(rejects), { expirationTtl: _REJECTS_TTL_S });
}

// =============================================================================
//  syncSheet(env, { fetchImpl }?)
//  Orchestration complète du sync Sheet → KV.
//  fetchImpl est injectable pour les tests ; en prod = globalThis.fetch.
//
//  Retourne :
//    { ok:false, error }                          (échec fetch/Content-Type)
//    { ok:true, warning:'sync_empty_csv', ... }   (0 row → store intact)
//    { ok:true, changed, report, conflicts_new, cat_normalized, rejects, count }
// =============================================================================
export async function syncSheet(env, { fetchImpl } = {}) {
  const startTs = Date.now();
  const nowIso  = () => new Date().toISOString();

  // ── 1. FETCH ───────────────────────────────────────────────────────────────
  let text;
  try {
    text = await fetchSheetCSV(env, fetchImpl);
  } catch (err) {
    const code = err.code || err.message || 'fetch_error';
    await _writeRejects(env, []);
    await _writeSyncLast(env, {
      ts:          nowIso(),
      error:       code,
      count:       0,
      sources:     [_SOURCE_NAME],
      duration_ms: Date.now() - startTs,
      rejects:     0,
    });
    return { ok: false, error: code };
  }

  // ── 2. PARSE ─────────────────────────────────────────────────────────────--
  const { rawEvents, rejects: parseRejects, cat_normalized } = parseSheetCSV(text);

  // ── 3. GARDE-FOU ANTI-STORE-VIDE [AJUST 1] ──────────────────────────────────
  if (rawEvents.length === 0) {
    await _writeRejects(env, parseRejects); // systématique, même []
    await _writeSyncLast(env, {
      ts:          nowIso(),
      warning:     'sync_empty_csv',
      count:       0,
      sources:     [_SOURCE_NAME],
      duration_ms: Date.now() - startTs,
      rejects:     parseRejects.length,
      cat_normalized,
    });
    return { ok: true, warning: 'sync_empty_csv', cat_normalized, rejects: parseRejects.length };
  }

  // ── 4. INGEST (en mémoire — ingestFromSource ne touche pas KV) ───────────────
  const store        = await readStore(env);
  const report       = ingestFromSource(store, _SOURCE_NAME, rawEvents);
  const newConflicts = detectConflicts(store); // post-ingest — § ARCHITECTURE §3.5

  // ── 5. ÉCRITURE CONDITIONNELLE DU STORE [AJUST 2] ───────────────────────────
  // merged = somme des deux passes : oublier merged_p2 ferait sauter un store muté.
  const changed =
    report.inserted > 0 ||
    (report.merged_p1 + report.merged_p2) > 0 ||
    newConflicts.length > 0;

  if (changed) {
    await writeStore(env, store);
  }

  // ── 6. MÉTA TOUJOURS ÉCRITES (sync:last + rejects:last) ─────────────────────
  const allRejects = [...parseRejects, ...report.rejects];
  await _writeRejects(env, allRejects);
  await _writeSyncLast(env, {
    ts:            nowIso(),
    count:         store.events.length,
    sources:       [_SOURCE_NAME],
    duration_ms:   Date.now() - startTs,
    rejects:       allRejects.length,
    cat_normalized,
    no_change:     !changed,
    inserted:      report.inserted,
    merged:        report.merged_p1 + report.merged_p2,
    conflicts_new: newConflicts.length,
  });

  return {
    ok:            true,
    changed,
    report,
    conflicts_new: newConflicts.length,
    cat_normalized,
    rejects:       allRejects.length,
    count:         store.events.length,
  };
}
