# ARCHITECTURE_EVENTS.md — Système Events TaxiPulse V2

> **Source de vérité pour les sessions S1–S11.**
> Toute déviation de design nécessite une mise à jour de ce document + validation Sofiane.
> Toute session doit lire ce fichier avant d'écrire la moindre ligne de code.

---

## 1. DIAGNOSTIC DE L'EXISTANT (pourquoi on refactorise)

### 1.1 Les 5 failles actuelles

| Faille | Symptôme concret |
|--------|-----------------|
| **Double pipeline non coordonné** | `ticketmaster.js` déduplique avec clé `date:venue:titre` (brut, séparateur `:`). `events-aggregator.js` déduplique avec `date|venue|normalizeTitle(titre)` (Unicode + strip). Un même event peut passer les deux sans jamais être fusionné. |
| **Trois dedup incohérents** | Aggregator: `date\|venue\|normalizeTitle`. TM: `date:venue:titre` (sans normalisation). Front: `venue\|date\|heure_fin` (sans titre du tout). |
| **`events_master_csv` KV orpheline** | Lue par `compareWithMaster()` pour générer les emails de diff. Jamais écrite par aucun handler. En pratique vide → l'email dit "X nouveaux events" à chaque cron, même si rien n'a changé. |
| **Sheet jamais écrit par le code** | La vérité métier est dans un Google Sheet édité manuellement par Sofiane. Aucun handler ne l'écrit. Le front le lit directement (bypass total du Worker). |
| **Doublons dans le Sheet lui-même** | Confirmés dans `events_master_2026_v3_final.csv` : Fally (4 lignes pour 2 jours), Roland-Garros (2 lignes par jour avec titres légèrement différents), Daho (3 lignes avec accents inconsistants entre sources). |

### 1.2 Flux actuel (ce qui se passe vraiment)

```
QFAP + OpenAgenda IDF + OpenAgenda FR
        ↓
  events-aggregator.js
    → crossValidate() (dedup clé "|")
    → email diff via Resend
    → ⚠️ résultat validé PERDU (rien écrit en KV pour le front)

Ticketmaster API
        ↓
  ticketmaster.js
    → dedup propre (clé ":")
    → KV "tm:events:{start}:{end}" (cache 6h)
    → ⚠️ jamais lu par le front (seulement par events-health.js)

Google Sheet (édité manuellement par Sofiane)
        ↓
  Front index.html
    → fetch direct CSV (no-store, bypass Worker)
    → loadSheetEvents() → EVENTS[] → affichage
    → ⚠️ dedup front = venue|date|heure_fin uniquement (sans titre)
```

**Conséquence directe** : le front n'a jamais bénéficié du fake-detector V2 ni de la hiérarchie
des sources. Il affiche ce que le Sheet contient, doublons inclus.

---

## 2. ARCHITECTURE CIBLE

### 2.1 Vision

Un pipeline unique : **Ingest → Normalize → Store → Serve**.
Le Sheet reste la source canonique humaine (Sofiane continue d'éditer). Le code construit un
store KV normalisé au-dessus, que le front consomme via l'API au lieu du Sheet direct.

### 2.2 Modules à créer

```
src/lib/
├── normalize.js      # S2 — normalisation titre, dedup key, hiérarchie sources
├── event-store.js    # S3 — lecture/écriture KV store events V2
└── ingest.js         # S4 — orchestration QFAP + OA IDF + OA FR + TM + Sheet

src/handlers/
├── events-list.js    # S7 — GET /events/list (remplace /events/aggregate côté lecture)
└── events-health.js  # S7 (mise à jour) — stats + alertes conflicts
```

### 2.3 Flux cible

```
[Sources externes]         [Source canonique humaine]
QFAP / OpenAgenda                Google Sheet
Ticketmaster                  (édité par Sofiane)
       \                              /
        ↓                            ↓
           ── ingest.js ─────────────
                   ↓
          normalize.js
          (dedup 2 passes, hiérarchie, conflict detection)
                   ↓
          event-store.js
          (write KV "events:store:v2")
                   ↓
     GET /events/list  ←── Front index.html
                            (feature flag S8 : remplace fetch Sheet direct)
```

### 2.4 Responsabilité par session

| Session | Module | Périmètre |
|---------|--------|-----------|
| **S1** | docs/ | ARCHITECTURE_EVENTS.md + EVENT_SCHEMA.md ← **ici** |
| **S2** | normalize.js | Clé canonique, normalisation titre, hiérarchie sources |
| **S3** | event-store.js | KV read/write, schema, index par date/venue |
| **S4** | ingest.js | Orchestration multi-sources, appels normalize + store |
| **S5** | Sync Sheet→Store | Cron qui lit le Sheet, normalise, stocke en KV |
| **S6** | Refacto aggregator + TM | Brancher sur ingest.js, supprimer pipelines parallèles |
| **S7** | /events/list + health | Endpoint lecture front + dashboard admin |
| **S8** | Front bascule | Feature flag : front lit /events/list au lieu du Sheet |
| **S9** | Théâtres récurrents | Expansion règles récurrentes dans le store |
| **S10** | Alertes + monitoring | stale_warning, conflicts email, recap hebdo |
| **S11+** | Sources canonical | Par lot : stadefrance.com, le-zenith.com, etc. |

---

## 3. RÈGLES DE DÉDUPLICATION

### 3.1 Clé canonique

```
event_id = "{date}|{venue_id}|{title_slug}"
```

- `date` : YYYY-MM-DD, **fuseau Europe/Paris** (pas UTC)
- `venue_id` : identifiant normalisé (`stade_france`, `zenith`, `roland_garros`…)
- `title_slug` : résultat de `normalize.titleSlug(titre)` — voir §3.2

### 3.2 Contrat de `normalize.titleSlug(titre)`

Transformations dans l'ordre :

1. Lowercase
1.5. Remplacement explicite des ligatures latines (avant NFD) :
   Æ/æ → ae, Œ/œ → oe, ß → ss
2. NFD + suppression diacritiques (`é→e`, `à→a`, `ç→c`…)
2.5. Normalisation des liaisons : `&` → `et`, ` + ` (entouré d'espaces) → `et`
3. Suppression marqueurs de journée : `j1`, `j2`, `j16`, `jour 1`, `journée 2`, `day 3`
4. Suppression années 4 chiffres (`2026`, `2025`)
5. Suppression mots-outils — en deux phases :

   **Phase A — strip depuis le séparateur :**
   Si la chaîne contient un séparateur (` - `, ` – `, ` — `) suivi d'un suffixe
   contenant l'un de : `tour`, `tournée`, `world tour`, `live tour`, `the tour`, `résidence`
   → strip depuis le séparateur jusqu'à la fin.
   **Garde-fou :** si la partie à gauche du séparateur, après lowercase + strip non-alnum,
   fait moins de 4 caractères — ne PAS appliquer la phase A.
   (Exemples protégés : "Jul" → 3 chars, "U2" → 2 chars, "BTS" → 3 chars.)

   **Phase B — strip standalone :**
   Strip des mots-outils restants (sans séparateur, ou après phase A) :
   `tour`, `tournée`, `world tour`, `live tour`, `the tour`, `résidence`

6. Normalisation abréviations sportives : `qualifs` → `qualif`, `qualifications` → `qualif`
7. Suppression de tout ce qui n'est pas `[a-z0-9]`
8. Trim

**Vecteurs de test garantis (entrée → slug attendu) :**

| Input | Slug attendu | Note |
|-------|-------------|------|
| `"Jul - Terre Connue"` | `"julterreconnue"` | |
| `"Étienne Daho J2"` | `"etiennedaho"` | accent + Jn |
| `"Etienne Daho"` | `"etiennedaho"` | sans accent → même slug |
| `"Roland-Garros 2026 - Qualifications J1"` | `"rolandgarrosqualif"` | abrév. sportive |
| `"Roland-Garros 2026 Qualifs J1"` | `"rolandgarrosqualif"` | idem → passe 1 |
| `"Fally Ipupa J1"` | `"fallyipupa"` | Jn strippé |
| `"Fally Ipupa - 20 ans de carriere"` | `"fallyipupa20ansdecarriere"` | fuzzy passe 2 |
| `"Céline Dion - Courage World Tour"` | `"celinedion"` | mot-outil strippé |
| `"Florent Pagny – L'Adieu Tour"` | `"florentpagny"` | mot-outil strippé |
| `"Bigflo & Oli"` | `"bigfloetoli"` | step 2.5 : & → et |
| `"Bigflo et Oli"` | `"bigfloetoli"` | idem → passe 1 |
| `"Anyma - ÆDEN"` | `"anymaaeden"` | step 1.5 : Æ → ae avant NFD → "anymaaeden" (10 chars) |
| `"Anyma"` | `"anyma"` | slug court → exception fuzzy passe 2 |

⚠️ `"Fally Ipupa J1"` et `"Fally Ipupa - 20 ans de carriere"` produisent des slugs **différents**
après passe 1. Leur fusion passe par la règle fuzzy (§3.3, passe 2).

### 3.3 Déduplication en deux passes

#### Passe 1 — Exact match

Même `event_id` → garder l'event de la source au **score le plus élevé** (§3.4).
Logger les autres comme `merged_from`.

#### Passe 2 — Fuzzy dedup (même venue + même date uniquement)

Conditions cumulatives pour fusionner A et B :

1. Même `venue_id` et même `date`
2. `|heure_debut_A − heure_debut_B| ≤ 90 min`
3. La fusion passe les deux sous-règles suivantes :

   **3a — Critère anti-générique (blacklist)**
   Le `title_slug` le plus court ne commence **pas** par l'un de ces mots :
   `concert`, `spectacle`, `soiree`, `event`, `show`
   → Si blacklist atteinte : fusion **interdite**, lever un `EventConflict` à la place.

   **3b — Critère de similarité** (l'une OU l'autre des deux conditions) :
   - *[cas standard]*  : `len(slug_court) ≥ 6`  ET  `ratio ≥ 0.85`
     où `ratio = len(préfixe_commun) / len(slug_court)`
   - *[exception slug court]* : `slug_court` est le **préfixe entier** de `slug_long`
     ET `len(slug_court) ≥ 3`
     → Couvre les artistes à nom très court : Anyma (5), BTS (3), Korn (4)…

→ Conserver l'event de score source le plus élevé, ajouter l'autre dans `merged_from`.

**Vérification sur les cas de test :**

- **Fally J1** (`"fallyipupa"`, 10) + **Fally "20 ans"** (`"fallyipupa20ansdecarriere"`, 25) →
  ratio = 10/10 = 1.0 ≥ 0.85, pas blacklist → **fusion passe 2** ✓
- **Anyma** (`"anyma"`, 5) + **Anyma ÆDEN** (`"anymaaeden"`, 10) →
  exception slug court : "anyma" préfixe entier de "anymaaeden", len ≥ 3 → **fusion** ✓
- **RG "Qualifs J1"** + **"Qualifications J1"** → même slug `"rolandgarrosqualif"` →
  **fusion passe 1** (pas besoin de passe 2) ✓
- **RG session jour** (10h) + **session nuit** (19h) →
  `|10h − 19h| = 540 min > 90 min` → **PAS de fusion** ✓
- **Concert rock** + **Concert rock alternative** → slug_court `"concertrock"` commence par
  `"concert"` → blacklist → **PAS de fusion, EventConflict** ✓

**Limitation connue — inversion de mots (EC3) :**
`"Grand Prix de Paris CYGAMES"` vs `"CYGAMES Grand Prix de Paris"` (même venue+date) →
aucun préfixe commun → pas de fuzzy → `EventConflict` levé → arbitrage Sofiane.
La déduplication par inversion d'ordre est hors-scope V2.

### 3.4 Hiérarchie des sources

| Level | Score | Exemples |
|-------|-------|---------|
| `canonical` | 100 | stadefrance.com, le-zenith.com, rolandgarros.com |
| `ticketing` | 70 | ticketmaster.fr, fnacspectacles.com, openagenda_idf |
| `aggregator` | 40 | qfap, openagenda_fr |
| `scraper` | 20 | sortiraparis.com, offi.fr |

**Score des lignes Sheet selon leur colonne `source` :**

| Valeur de la colonne `source` dans le Sheet | Score appliqué |
|---------------------------------------------|----------------|
| Domaine connu (ex : `"stadefrance.com"`) | Score de la table ci-dessus |
| Vide, `"manuel"`, `"sofiane"`, `"sheet"` | `canonical` — 100 |
| Domaine inconnu | `aggregator` — 40 |

**Règle spéciale — Sheet bat tout (inchangée) :**
Si le Sheet et une source `canonical` divergent sur le même event (heure ou titre différents),
le Sheet gagne + un `EventConflict` est généré + alerte email envoyée.
Cette règle est indépendante du score : elle s'applique même si les deux côtés ont score 100.

**Fake-detector sur lignes Sheet :**
`ingest.js` applique le fake-detector aux lignes Sheet **uniquement si** leur colonne `source`
est non-vide et non-manuelle (c'est-à-dire : pas `""`, `"manuel"`, `"sofiane"`, `"sheet"`).
Si Sofiane a saisi intentionnellement une ligne vide ou manuelle, elle n'est pas filtrée.

### 3.5 Détection de conflits

Un conflit est créé quand, après les deux passes de dedup, deux events subsistent sur la même
`venue+date` avec `|heure_debut_A − heure_debut_B| ≤ 30 min` et des slugs différents
(non fusionnables par passe 2).

**Exemple** : Daho au Zénith 20h + Renaud au Zénith 20h même soir → conflit → les deux events
sont conservés → alerte.

Conflicts stockés dans `events:conflicts` (TTL 7 jours).

---

## 4. SCHÉMA KV (V2)

| Clé KV | Contenu | TTL |
|--------|---------|-----|
| `events:store:v2` | JSON : tous les events normalisés + conflicts + stats | 120s |
| `events:index:date:{YYYY-MM-DD}` | JSON array d'IDs pour lookup rapide par date | 120s |
| `events:conflicts` | JSON array des EventConflict non résolus | 7 jours |
| `events:sync:last` | `{ ts, count, sources, duration_ms, rejects }` | pas de TTL |
| `events:rejects:last` | JSON array des events rejetés au dernier run | 24h |

**Clés obsolètes à supprimer en S6 :**

- `events_master_csv` — orpheline, jamais écrite
- `events_aggregator_last_run` → remplacé par `events:sync:last`
- `aggregator_rejects:{date}` → remplacé par `events:rejects:last`
- `tm:events:{start}:{end}` → cache TM géré par ingest.js à partir de S6

**Venue inconnue → jamais silencieuse :**
Si un event a une venue absente de `VENUE_MAPPING`, il est rejeté et ajouté dans
`events:rejects:last` avec le payload :
`{ reason: "unknown_venue", venue_raw: "<valeur brute>", titre, date, source }`
Sofiane peut auditer la liste complète via GET /events/health (disponible en S7).

---

## 5. CAS DE TEST OBLIGATOIRES

Tout changement du moteur de dedup DOIT satisfaire ces 9 cas avant merge.

### T1 — Jul Stade de France 15-16 mai
- **Input** : 2 events, même titre `"Jul - Terre Connue"`, même venue `stade_france`, dates différentes
- **Expected** : 2 events distincts (clé 15 mai ≠ clé 16 mai)

### T2 — Daho Zénith vs Renaud (même slot)
- **Input** : Daho 20h-22h30 Zénith + Renaud 20h-22h Zénith, même date
- **Expected** : conflit détecté, 2 events conservés, 1 `EventConflict` généré

### T3 — Roland-Garros day session vs night session
- **Input** : session jour 10h-18h + session nuit 19h-23h, même venue, même date
- **Expected** : 2 events distincts (`|10h − 19h| = 540 min > 90 min` → pas de fusion)

### T4 — Roland-Garros "Qualifs J1" vs "Qualifications J1" même jour
- **Input** : 2 titres, mêmes venue+date+créneau horaire similaire
- **Expected** : 1 seul event (slug identique `"rolandgarrosqualif"` → passe 1)

### T5 — Fally Ipupa Stade France 2-3 mai
- **Input** : 4 lignes CSV (`"Fally Ipupa J1"` + `"Fally Ipupa - 20 ans de carriere"` × 2 jours)
- **Expected** : 2 events (1 par jour) — fuzzy dedup passe 2 fusionne les 2 lignes de chaque jour

### T6 — Céline Dion résidence 16 dates
- **Input** : 16 events, même venue, titre similaire, 16 dates différentes
- **Expected** : 16 events distincts (date différente → clé différente)

### T7 — Pagny Olympia 16 dates
- **Input** : structure identique à T6
- **Expected** : 16 events distincts

### T8 — Sheet contredit canonical
- **Input** : Sheet dit 20h30 / stadefrance.com dit 20h00, même event par ailleurs
- **Expected** : heure_debut = 20h30 (Sheet gagne), 1 `EventConflict` généré

### T9 — Event sans confirmation depuis 8 jours
- **Input** : event confirme=APPROX, `last_seen_at` > 8 jours avant aujourd'hui
- **Expected** : `status = 'stale_warning'`

---

## 6. HORS-SCOPE DE CE CHANTIER

- Refonte UI de l'onglet Events (visuel reste tel quel sauf indicateurs ≈ et badges status)
- Migration vers une autre base que Cloudflare KV
- Ajout de nouvelles sources scrapées avant la fin de S10
- Toute optimisation perf prématurée

---

*Créé en S1. Dernière mise à jour : 2026-05-24.*
