# CHANTIER_EVENTS_STATE.md — État du chantier Events V2

> **Objectif de ce document** : mémo de continuité pour que la prochaine session
> (Claude Code) reprenne exactement là où on s'est arrêtés, sans réinventer les décisions.
>
> **Branche active** : `cleanup-frontend-refactor`
> **Dernière mise à jour** : 2026-05-26 (fin session S4 + S4.5 en cours)

---

## 1. Où on en est

### Sessions terminées (commits propres, tests verts)

| Session | Commit | Livrable | Tests |
|---------|--------|----------|-------|
| S1 | `3c08900`, `c8ee8b9` | `docs/ARCHITECTURE_EVENTS.md` + `docs/EVENT_SCHEMA.md` | — |
| S2 | `0986a2b` | `src/lib/normalize.js` + `normalize.test.js` | 41/41 ✅ |
| S2.5 | `054beb2` | `docs/COVERAGE_EVENTS.md` (cahier couverture + spec check) | — |
| S3 | `19c4c19` | `src/lib/event-store.js` + `event-store.test.js` | 28/28 ✅ |
| S4 | `35b2acf` | `src/lib/ingest.js` + `ingest.test.js` | 11/11 ✅ |

### Session en cours : S4.5 — VENUE_MAPPING complet

**Action** : compléter `VENUE_MAPPING` dans `event-store.js` avec les 11 venues du
Sheet absentes du mapping actuel. **Commit séparé** :
`feat(events): S4.5 — VENUE_MAPPING complété depuis Sheet 2026`

11 venues à ajouter (ID canonique → identité, + variantes textuelles) :
`bataclan`, `bois_vincennes`, `cigale`, `fondation_lv`, `louvre`,
`mam_paris`, `musee_orsay`, `paris`, `saint_cloud`, `seine_musicale`, `trianon`

### Sessions à venir

| Session | Module | Périmètre |
|---------|--------|-----------|
| **S5** | `src/handlers/sheet-sync.js` | Lecture CSV Sheet, parse, ingestFromSource, cron 15min dans scheduled.js |
| **S6** | Refacto `events-aggregator.js` + `ticketmaster.js` | Brancher sur ingest.js, adapter les fetchers |
| **S7** | `GET /events/list` + `events-health.js` update | Endpoint lecture front + dashboard admin |
| **S8** | Front feature flag | Front lit `/events/list` au lieu du Sheet direct |
| **S9** | Théâtres récurrents | Expansion règles récurrentes |
| **S10** | Alertes + monitoring | stale_warning, conflicts email, recap hebdo |
| **S11+** | Sources canonical | Par lot : stadefrance.com, le-zenith.com, etc. |

---

## 2. Architecture des modules créés

```
src/lib/
├── normalize.js       — titleSlug, venueId, eventKey, sourceScore,
│                        commonPrefixLen, fuzzyCanMerge
├── event-store.js     — readStore, writeStore, upsertEvent, detectConflicts,
│                        markStale, listByDate, listByVenue + VENUE_MAPPING
└── ingest.js          — ingestFromSource, ingestFromSources
```

**Pipeline complet** :
```
Fetchers (thunks)
     ↓
ingest.js (ingestFromSources)
     ↓ appelle
event-store.js (upsertEvent × N)
     ↓ utilise
normalize.js (titleSlug, sourceScore, fuzzyCanMerge…)
     ↓ puis
event-store.js (detectConflicts → writeStore)
     ↓ KV
events:store:v2 + events:index:date:* + events:conflicts
+ events:rejects:last (TTL 24h) + events:sync:last (pas de TTL)
```

---

## 3. Décisions de spec figées (ne pas réinventer)

### 3.1 titleSlug — pipeline 8 étapes

```
1.   Lowercase
1.5. Ligatures : Æ/æ→ae, Œ/œ→oe, ß→ss (avant NFD — NFD ne décompose pas Æ)
2.   NFD + strip [̀-ͯ]
2.5. & → et, " + " → et
3.   Strip \bj\d+\b, \bjour\s+\d+\b, \bjournee\s+\d+\b, \bday\s+\d+\b
4.   Strip \b\d{4}\b
5A.  Phase A — separator ( - / – / — entouré d'espaces) + keyword tour/tournée/world
     tour/live tour/the tour/résidence en suffixe → strip depuis le sep
     Garde-fou : si leftClean.length < 4 → ne pas appliquer (protège Jul, U2, BTS)
5B.  Phase B — strip standalone des mêmes keywords
6.   qualifications → qualif, qualifs → qualif
7.   /[^a-z0-9]/ → ''
8.   (déjà vide après 7)
```

**Vecteurs garantis** (ne pas casser) :
- `"Jul - Terre Connue"` → `"julterreconnue"`
- `"Anyma - ÆDEN"` → `"anymaaeden"` (10 chars, pas 9 — Æ→ae avant NFD)
- `"Roland-Garros 2026 - Qualifications J1"` → `"rolandgarrosqualif"`
- `"Fally Ipupa J1"` → `"fallyipupa"` (différent de `"fallyipupa20ansdecarriere"`)
- `"Céline Dion - Courage World Tour"` → `"celinedion"`
- `"Hockey France - Canada"` → `"hockeyfrancecanada"` (phase A non déclenchée)

### 3.2 Dédup deux passes

**Passe 1 — exact match** : même `event_id = date|venue|slug`
→ garder le score le plus élevé, merger l'autre dans `merged_from` + `sources_list`
→ Exception : "Sheet bat tout" (source manuelle vs canonical, heure/titre divergents)
  → Sheet gagne + `EventConflict(time_mismatch | title_mismatch)` généré

**Passe 2 — fuzzy** (même venue + même date uniquement) :
→ Condition 1 : `|heure_A − heure_B| ≤ 90 min`
→ Condition 2 : pas de blacklist (concert/spectacle/soiree/event/show en début de slug)
→ Condition 3 : (slug_court.len ≥ 6 ET ratio ≥ 0.85) OU (slug_court est préfixe entier ET len ≥ 3)
→ Gagant : score le plus élevé remplace les champs principaux (y compris l'id en passe 2)

**"Sheet bat tout" (ZG1 décision prise)** : s'applique UNIQUEMENT en passe 1 (exact match).
En passe 2 (fuzzy) → règle normale score.

### 3.3 Hiérarchie sources (sourceScore)

| Source | Score | Level |
|--------|-------|-------|
| stadefrance.com, rolandgarros.com… | 100 | canonical |
| Vide, 'manuel', 'sofiane', 'sheet' | 100 | canonical (manuel) |
| ticketmaster.fr, fnacspectacles.com, openagenda_idf | 70 | ticketing |
| qfap, openagenda_fr | 40 | aggregator |
| sortiraparis.com, offi.fr | 20 | scraper |
| Domaine inconnu | 40 | aggregator (défaut) |

### 3.4 VENUE_MAPPING (event-store.js)

- Input : `venue_raw` (string brute) → `rawVenueId(venue_raw)` → lookup → canonical `venue_id`
- Venue inconnue → `upsertEvent` retourne `{ action: 'rejected', reason: 'unknown_venue' }`
- Le CSV Sheet utilise déjà des IDs canoniques (ex: `stade_france`) — mappings identité nécessaires
- **ZG2 décision prise (S3)** : stub S3 (~30 entrées). Complété en S4.5 (27 venues du Sheet).

### 3.5 confidence_score (EVENT_SCHEMA §3)

```
+50  si source_level = canonical
+20  si source_level = ticketing
+10  par source aggregator supplémentaire dans sources_list (cap +30)
+10  si heure_debut ≠ '20:00' (heure certifiée)
+5   si sources_count ≥ 3
cap  100
```

**Status rules** (priorité décroissante) :
`conflict` > `stale_warning` (last_seen_at > 8j) > `confirmed` (≥60) > `approx` (<60)

### 3.6 Clés KV

| Clé | TTL | Contenu |
|-----|-----|---------|
| `events:store:v2` | 120s | EventStore complet (events + conflicts + stats) |
| `events:index:date:{YYYY-MM-DD}` | 120s | JSON array d'IDs |
| `events:conflicts` | 7j (604800s) | EventConflict[] non résolus |
| `events:sync:last` | — (permanent) | { ts, count, sources, duration_ms, rejects } |
| `events:rejects:last` | 24h (86400s) | RejectEntry[] du dernier run |

**Clés à supprimer en S6** : `events_master_csv`, `events_aggregator_last_run`,
`aggregator_rejects:{date}`, `tm:events:{start}:{end}`

---

## 4. Zones grises résolues (ne pas rouvrir)

| ZG | Question | Décision prise |
|----|----------|---------------|
| ZG1 | "Sheet bat tout" en passe 2 aussi ? | NON — passe 1 seulement |
| ZG2 | VENUE_MAPPING : stub S3 ou exhaustif ? | Stub S3, complété en S4.5 |
| ZG3 | `ingestFromSources` appelle `writeStore` ? | OUI — c'est son rôle |
| ZG4 | `ingestFromSources` appelle `detectConflicts` ? | OUI — post-ingest cross-source |

---

## 5. Points d'attention pour S5 (sheet-sync.js)

**Ce qui est décidé (doc existant)** :
- URL CSV : à mettre en `env.SHEET_CSV_URL` (secret CF, pas hardcodé)
- Fake-detector Sheet : appliquer sur les lignes où `source` est non-vide et non-manuel
  (§3.4 ARCHITECTURE_EVENTS.md) — mais en S5, simplifier : juste parser + ingestFromSource
- Le Sheet utilise déjà les IDs canoniques en colonne `venue` → passer comme `venue_raw`
  (upsertEvent → rawVenueId → VENUE_MAPPING → identité)

**Colonnes du CSV Sheet** :
```
date, heure_debut, heure_fin, venue, titre, cat, source, confirme, notes
```

**Zones grises S5 à éclaircir AVANT code** :
- Lignes vides → skip silencieux
- Titre entre guillemets avec virgule → parser CSV correct requis (pas de split(',') naïf)
- Colonne `cat` hors enum → défaut à 'autre' ou rejet ?
- Encodage : le Sheet Google exporte en UTF-8 avec possible BOM (0xEF 0xBB 0xBF)
- CR/LF Windows vs LF Unix dans le CSV

---

## 6. Problèmes connus / tech debt

1. **Duplicate Grand Prix de Paris CYGAMES** : 2 lignes conflictuelles dans le Sheet
   pour le 14 juillet (même venue, titre légèrement différent). `detectConflicts` les signalera.

2. **Fally Ipupa** : 4 lignes CSV pour 2 dates → après dédup passe 2, doit donner 2 events.
   Cas de test T5 couvert dans `event-store.test.js`.

3. **Fetchers existants** (`events-aggregator.js`, `ticketmaster.js`) retournent `venue`
   (canonical ID) pas `venue_raw`. Incompatible direct avec `upsertEvent`. Fix prévu en S6.

4. **`bataclan` + `elysee_montmartre`** : dans `ticketmaster.js` mais pas encore dans
   `VENUE_MAPPING` event-store.js. Réglé en S4.5 pour `bataclan`. `elysee_montmartre`
   absent du Sheet → à ajouter en S11+ quand on branche ticketmaster.js sur le nouveau pipeline.

---

*Créé en fin de session S4, avant auto-compact. Référence : `docs/ARCHITECTURE_EVENTS.md`.*
