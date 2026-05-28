# EVENT_SCHEMA.md — Schéma de l'objet Event canonique V2

> Complément de `docs/ARCHITECTURE_EVENTS.md §6`.
> Toute modification de ce schéma nécessite une validation Sofiane
> + mise à jour de ARCHITECTURE_EVENTS.md.

---

## 1. Type Event (objet canonique)

```typescript
// Statut de confiance d'un event
type EventStatus =
  | 'confirmed'      // Source canonical ou ticketing, confidence_score >= 60
  | 'approx'         // Heure non certifiée (source aggregator/scraper uniquement)
  | 'stale_warning'  // Plus vu depuis > 8 jours, en attente de reconfirmation
  | 'conflict'       // Contredit par une autre source, arbitrage admin en attente

type SourceLevel = 'canonical' | 'ticketing' | 'aggregator' | 'scraper'

interface Event {
  // ── IDENTIFIANT ──────────────────────────────────────────────────────
  id: string              // "{date}|{venue_id}|{title_slug}" — clé de dédup

  // ── DATE ET HEURE ────────────────────────────────────────────────────
  date: string            // "YYYY-MM-DD" (fuseau Europe/Paris — pas UTC)
  date_end: string        // "YYYY-MM-DD" (peut différer pour events multi-jours)
  heure_debut: string     // "HH:MM" heure locale Paris
  heure_fin: string       // "HH:MM" — fourni par source ou calculé par moteur duration

  // ── LIEU ─────────────────────────────────────────────────────────────
  venue: string           // venue_id normalisé ex: "stade_france", "zenith"
  venue_raw?: string      // libellé brut de la source (débogage uniquement)

  // ── TITRE ────────────────────────────────────────────────────────────
  titre: string           // titre pour affichage (trim, max 120 chars)
  titre_slug: string      // résultat de normalize.titleSlug() — sert à construire id

  // ── CATÉGORIE ────────────────────────────────────────────────────────
  cat: EventCategory      // voir §2

  // ── SOURCE PRINCIPALE ────────────────────────────────────────────────
  source: string          // ex: "stadefrance.com", "qfap", "ticketmaster.fr"
  source_level: SourceLevel
  source_score: number    // 100 | 70 | 40 | 20 (voir ARCHITECTURE_EVENTS §3.4)
  source_url?: string     // URL d'origine (vérification admin)
  source_id?: string      // ID interne de la source (pour rétrotracer)

  // ── MULTI-SOURCES (après crossValidate) ──────────────────────────────
  sources_count: number   // nombre de sources qui ont rapporté cet event
  sources_list: string    // ex: "stadefrance.com+qfap+openagenda_idf"
  merged_from?: string[]  // IDs des events fusionnés (fuzzy dedup passe 2)

  // ── CONFIANCE ────────────────────────────────────────────────────────
  status: EventStatus
  confidence_score: number // 0–100, voir §3
  confirme: 'OUI' | 'APPROX' // rétrocompatibilité front actuel (= status simplifié)

  // ── METADATA ─────────────────────────────────────────────────────────
  notes: string           // info libre, conservée depuis la source
  created_at: string      // ISO 8601 — première fois vu dans une source
  updated_at: string      // ISO 8601 — dernière mise à jour du record
  last_seen_at: string    // ISO 8601 — dernier run qui l'a trouvé dans une source active
}
```

---

## 2. Catégories (EventCategory)

```typescript
type EventCategory =
  | 'concert'           | 'concert_classique'  | 'concert_metal'
  | 'sport_foot'        | 'sport_rugby'        | 'sport_tennis'
  | 'sport_basket'      | 'sport_hand'         | 'sport'
  | 'spectacle_humour'  | 'theatre'            | 'danse'
  | 'exposition'        | 'salon'              | 'conference'
  | 'course'            | 'autre'
```

**Catégorie hors enum (ZG6, décidée en S5)** :
Si la colonne `cat` d'une ligne Sheet contient une valeur **non vide** absente de cet enum
(ex : `"musee"`, `"festival"`), `sheet-sync.js` la **ramène à `'autre'`** plutôt que de
rejeter la ligne — une saisie manuelle ne doit pas être perdue pour une typo. Chaque
normalisation incrémente le compteur `cat_normalized`, reporté dans `events:sync:last`.
Une colonne `cat` **vide** est ramenée à `'autre'` silencieusement (pas de comptage —
c'est le défaut attendu, pas une erreur).

---

## 3. Calcul du confidence_score

```
confidence_score = 0

Si source_level === 'canonical'          → +50
Si source_level === 'ticketing'          → +20
Par source 'aggregator' supplémentaire   → +10 (plafonné à +30)

Si heure_debut certifiée (≠ "20:00" défaut injecté)  → +10
Si sources_count >= 3                                  → +5

confidence_score = min(confidence_score, 100)
```

**Règle de statut (par ordre de priorité décroissante) :**

| Condition | status | confirme |
|-----------|--------|----------|
| Conflict non résolu | `conflict` | `APPROX` |
| `last_seen_at` > 8 jours | `stale_warning` | `APPROX` |
| `confidence_score >= 60` | `confirmed` | `OUI` |
| `confidence_score < 60` | `approx` | `APPROX` |

---

## 4. Format de la clé id (exemples concrets)

```
"2026-05-15|stade_france|julterreconnue"           ← Jul J1
"2026-05-16|stade_france|julterreconnue"           ← Jul J2 (event distinct, date ≠)
"2026-05-18|roland_garros|rolandgarrosqualif"      ← fusion "Qualifs J1" + "Qualifications J1"
"2026-05-02|stade_france|fallyipupa"               ← Fally J1 (après fusion fuzzy passe 2)
"2026-05-03|stade_france|fallyipupa"               ← Fally J2 (distinct car date ≠)
"2026-05-14|zenith|etiennedaho"                    ← Daho J1
"2026-05-15|zenith|etiennedaho"                    ← Daho J2 (distinct car date ≠)
```

---

## 5. Objet EventConflict

```typescript
interface EventConflict {
  id: string          // "{venue_id}|{date}|{timestamp_ms}"
  date: string        // YYYY-MM-DD
  venue: string       // venue_id

  event_a: {
    id: string
    titre: string
    heure_debut: string
    source: string
    source_level: SourceLevel
  }
  event_b: {
    id: string
    titre: string
    heure_debut: string
    source: string
    source_level: SourceLevel
  }

  conflict_type:
    | 'same_slot'       // même horaire, titres non fusionnables (ex: Daho vs Renaud)
    | 'time_mismatch'   // même event, heures contradictoires selon les sources
    | 'title_mismatch'  // même event présumé, titres trop différents pour fuzzy dedup

  resolved: boolean
  resolved_at?: string   // ISO 8601
  resolution?:
    | 'keep_a'           // event A l'emporte
    | 'keep_b'           // event B l'emporte
    | 'merge'            // fusionnés manuellement par Sofiane
    | 'both_valid'       // deux events réellement distincts (ex: day + night session)
}
```

---

## 6. Structure du payload KV `events:store:v2`

```typescript
interface EventStore {
  version: 'v2'
  generated_at: string        // ISO 8601
  expires_at: string          // ISO 8601 (generated_at + 120s)
  horizon_days: number        // nombre de jours couverts en avant (défaut: 90)

  events: Event[]             // tous les events à venir dans l'horizon, triés par date

  conflicts: EventConflict[]  // conflits non résolus

  stats: {
    total: number
    by_status: Record<EventStatus, number>
    by_source_level: Record<SourceLevel, number>
    last_sync_at: string       // ISO 8601
    sync_duration_ms: number
    rejects_count: number
  }
}
```

---

*Créé en S1. Dernière mise à jour : 2026-05-28 (S5 — ZG6 cat hors enum → 'autre').*
