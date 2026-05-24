# COVERAGE_EVENTS.md — Cahier de couverture des événements + Spec check automatisé

> **Périmètre** : événements parisiens (et grands événements régionaux à fort trafic taxi)
> ayant un impact direct sur les courses de taxi. Ce document liste les « incontournables »
> par catégorie, leur statut dans le Sheet 2026, et spécifie le mécanisme de vérification
> automatisé à coder en S10.
>
> **Référence** : `docs/ARCHITECTURE_EVENTS.md` §3–§5
> **Sheet de prod** : `events_master_2026_v3_final.csv` (lecture seule — ne jamais modifier)
> **Dernière mise à jour** : 2026-05-24 (S2.5)

---

## Légende

| Statut couverture | Signification |
|-------------------|---------------|
| ✅ Présent         | Au moins 1 ligne dans Sheet 2026 |
| ⚠️ Partiel        | Présent mais incomplet (dates manquantes, duplicate non résolu, nocturnes absent) |
| ❌ Absent          | 0 résultat dans Sheet 2026 |
| 🚨 Absent CRITIQUE | Absent + impact taxi majeur (50k+ personnes ou affluence structurelle) |

---

## §1. Festivals

> Période cible : **juin–août** (pic estival). Impact taxi : sorties de fin de concert,
> navettes Gare du Nord / CDG pour festivaliers étrangers.

| Nom canonical | Venue habituelle | Période | Source(s) officielle(s) | Cycle | Couverture 2026 |
|---|---|---|---|---|---|
| We Love Green | Bois de Vincennes | Fin mai – début juin | welovegreen.fr | Annuel | ✅ Présent |
| Solidays | Hippodrome de Longchamp | Fin juin | solidays.org | Annuel | ✅ Présent |
| Rock en Seine | Domaine de Saint-Cloud | Fin août | rockenseine.com | Annuel | ✅ Présent |
| Festival Days Off | Philharmonie / Salle Pleyel | Fin juin – début juillet | festival-daysoff.com | Annuel | ✅ Présent |
| Yardland Festival | Hippodrome de Vincennes | Juillet | yardland.fr | Annuel | ✅ Présent |
| Peacock Society | Hippodrome de Vincennes | Juillet | peacock-society.com | Annuel | ✅ Présent |
| Fête de la Musique | Paris (partout) | 21 juin (fixe) | fetedelamusique.culture.fr | Annuel | ✅ Présent |
| **Lollapalooza Paris** | Hippodrome de Longchamp | Mi-juillet | lollapaloozafr.com | Annuel | ❌ Absent |
| **Paris Jazz Festival** | Parc Floral de Vincennes | Juin – juillet | parisjazzfestival.fr | Annuel | ❌ Absent |
| **Fnac Live Festival** | Place de l'Hôtel de Ville | Fin juillet | fnac.com/live | Annuel | ❌ Absent |
| Hellfest *(impact régional)* | Clisson (44) | Fin juin | hellfest.fr | Annuel | ❌ Absent |

**Note Hellfest** : hors Paris, mais génère des courses longue distance Montparnasse/TGV.
À inclure avec flag `impact_taxi: regional` et catégorie `festival_regional`.

---

## §2. Expositions longue durée

> Cible : **expositions ≥ 4 semaines** dans les grandes institutions parisiennes.
> Impact taxi : nocturnes (jeudi/vendredi soirs), vernissages, files de sortie.
> Attention : certaines expositions s'étalent sur 3–6 mois → 1 seule ligne Sheet suffit
> (pas besoin d'une ligne par jour).

| Nom canonical | Venue habituelle | Période | Source(s) officielle(s) | Cycle | Couverture 2026 |
|---|---|---|---|---|---|
| Matisse 1941–1954 | Grand Palais | Mars – juillet 2026 | grandpalais.fr | Ponctuel | ✅ Présent |
| Video Games & Music | Philharmonie de Paris | Avril 2026 | philharmoniedeparis.fr | Ponctuel | ✅ Présent |
| Lee Miller | MAM Paris (Paris 16e) | Avril 2026 | mam.paris.fr | Ponctuel | ✅ Présent |
| Michel-Ange / Rodin | Louvre | Avril 2026 | louvre.fr | Ponctuel | ⚠️ Partiel (1 ligne) |
| Calder — Rêver en équilibre | Fondation Louis Vuitton | Avril – juin 2026 | fondationlouisvuitton.fr | Ponctuel | ✅ Présent |
| Nuit des Musées | Paris (multiples) | 23 mai (1 nuit fixe) | nuitdesmusees.culture.fr | Annuel | ✅ Présent |
| Paris Photo | Grand Palais | 11–15 novembre | parisphoto.com | Annuel | ✅ Présent |
| Musée d'Orsay (expositions temp.) | Musée d'Orsay (Paris 7e) | Toute l'année | musee-orsay.fr | Annuel | ⚠️ Partiel (6 lignes, incomplet) |
| **Centre Pompidou (expositions)** | Beaubourg (Paris 4e) | Toute l'année | centrepompidou.fr | Annuel | 🚨 Absent CRITIQUE |
| **Palais de Tokyo (expositions)** | Paris 16e | Toute l'année | palaisdetokyo.com | Annuel | ❌ Absent |
| **Jeu de Paume (expositions)** | Jardin des Tuileries (Paris 1er) | Toute l'année | jeudepaume.org | Annuel | ❌ Absent |

**Note Centre Pompidou** : ~3,5 millions de visiteurs/an, nocturnes jeudi jusqu'à 23h.
L'absence totale du Sheet est un angle mort majeur pour les prises de nuit.

---

## §3. Courses hippiques

> Cible : grandes réunions à **Longchamp**, **Auteuil** et **Vincennes**.
> Impact taxi : arrivées gare Saint-Lazare / Madeleine → Longchamp (public aisé),
> nocturnes Vincennes (vendredi soir, récurrents).

| Nom canonical | Venue habituelle | Période | Source(s) officielle(s) | Cycle | Couverture 2026 |
|---|---|---|---|---|---|
| Grand Steeple-Chase de Paris | Hippodrome d'Auteuil | Mi-mai (16–17 mai 2026) | france-galop.com | Annuel | ✅ Présent |
| Prix d'Ispahan | Hippodrome de Longchamp | 21 mai | france-galop.com | Annuel | ✅ Présent |
| Prix du Jockey Club | Hippodrome de Chantilly *(navette Paris)* | Fin mai (31 mai) | france-galop.com | Annuel | ✅ Présent |
| Prix de Diane Longines | Hippodrome de Chantilly *(navette Paris)* | 14 juin | france-galop.com | Annuel | ✅ Présent |
| Grand Prix de Paris CYGAMES | Hippodrome de Longchamp | 14 juillet | france-galop.com | Annuel | ⚠️ Partiel (duplicate conflit) |
| Qatar Prix de l'Arc de Triomphe | Hippodrome de Longchamp | 1er dimanche d'octobre | france-galop.com | Annuel | ⚠️ Partiel (duplicate) |
| Prix Royallieu | Hippodrome de Longchamp | Octobre | france-galop.com | Annuel | ✅ Présent |
| 48 Heures de l'Obstacle | Hippodrome d'Auteuil | 14–15 novembre | france-galop.com | Annuel | ✅ Présent |
| Trot nocturnes Vincennes (Q1–Q5) | Hippodrome de Vincennes | Octobre – décembre | paris-vincennes.fr | Annuel | ✅ Présent |
| Journée Patrimoine Vincennes | Hippodrome de Vincennes | 13 septembre | paris-vincennes.fr | Annuel | ✅ Présent |
| **Grand Prix d'Amérique** | Hippodrome de Vincennes | Fin janvier | paris-vincennes.fr | Annuel | ❌ Absent (janvier hors CSV) |
| **Prix du Cadran** | Hippodrome de Longchamp | Octobre | france-galop.com | Annuel | ❌ Absent |
| **Prix de la Forêt** | Hippodrome de Longchamp | Octobre | france-galop.com | Annuel | ❌ Absent |

**Duplicate Grand Prix de Paris CYGAMES** : 2 lignes conflictuelles dans le Sheet pour le
14 juillet → à résoudre en priorité (dédup passe 1 échoue si dates identiques + titre voisin).

---

## §4. Salons B2B et grand public

> Cible : salons **Porte de Versailles** (principal générateur taxi IDF) et **Villepinte**.
> Impact taxi : flux aéroports CDG/Orly ↔ hotels ↔ salles d'exposition,
> particulièrement important pour les salons > 50 000 visiteurs.

| Nom canonical | Venue habituelle | Période | Source(s) officielle(s) | Cycle | Couverture 2026 |
|---|---|---|---|---|---|
| Industrie Paris / Midest | Villepinte | Mars | industrie-expo.com | Biennal | ✅ Présent |
| Art Paris | Grand Palais | Avril | artparis.com | Annuel | ✅ Présent |
| JEC World Composites | Villepinte | Avril | jeccomposites.com | Annuel | ✅ Présent |
| Foire de Paris | Porte de Versailles | 30 avr – 11 mai | foiredeparis.fr | Annuel | ✅ Présent |
| SantExpo | Porte de Versailles | Mai | santexpo.com | Annuel | ✅ Présent |
| Salon Alimentation Restauration | Porte de Versailles | Juin | sirha-omnivore.com | Annuel | ✅ Présent |
| VivaTech | Porte de Versailles | 11–14 juin | vivatechnology.com | Annuel | ✅ Présent |
| PRODAYS | Porte de Versailles | Juillet | prodays.fr | Annuel | ✅ Présent |
| Salon Mode Textile | Porte de Versailles | Juillet | premierevision.com | Annuel | ✅ Présent |
| Maison & Objet | Villepinte | Septembre (+ janvier) | maison-objet.com | 2×/an | ✅ Présent |
| Mondial de l'Auto | Porte de Versailles | 9–25 octobre | mondial-paris.com | Biennal | ✅ Présent |
| SIAL Paris | Villepinte | 17–21 octobre | sialparis.com | Biennal | ✅ Présent |
| Equip'Auto | Porte de Versailles | Octobre | equipauto.com | Annuel | ✅ Présent |
| Salon du Chocolat | Porte de Versailles | 28 oct – 1 nov | salonduchocolat.fr | Annuel | ✅ Présent |
| EquipHotel | Porte de Versailles | 2–5 novembre | equiphotel.com | Biennal | ✅ Présent |
| Salon de la Street Food | Villepinte | 7–8 novembre | salondelastreetfood.fr | Annuel | ✅ Présent |
| Paris Photo | Grand Palais | Novembre | parisphoto.com | Annuel | ✅ Présent |
| MIF Expo (Made in France) | Porte de Versailles | 11 novembre | mifexpo.fr | Annuel | ✅ Présent |
| All4Pack Emballage | Villepinte | 23–26 novembre | all4pack.fr | Biennal | ✅ Présent |
| Pollutec | Porte de Versailles | 1–2 décembre | pollutec.com | Biennal | ✅ Présent |
| Salon du Cheval Paris | Villepinte | 5–13 décembre | salon-cheval.com | Annuel | ✅ Présent |
| **Nautic (Salon Nautique)** | Porte de Versailles | Début décembre | salonnautique.com | Annuel | ❌ Absent |
| **Paris Retail Week** | Villepinte | Septembre | parisretailweek.com | Annuel | ❌ Absent |
| **Batimat** | Villepinte | Novembre (biennal) | batimat.com | Biennal | ❌ Absent (vérifier si 2026) |

---

## §5. Sports majeurs

> Cible : compétitions ≥ 10 000 spectateurs à Paris.
> Impact taxi : sorties tardives stade, navettes gare/aéroport jour de match,
> zones de dépôt autour des enceintes (SdF, Bercy, Parc des Princes, Adidas Arena).

| Nom canonical | Venue habituelle | Période | Source(s) officielle(s) | Cycle | Couverture 2026 |
|---|---|---|---|---|---|
| Six Nations France (matches à domicile) | Stade de France | Février – mars | ffr.fr | Annuel | ✅ Présent (France-Angleterre) |
| Roland-Garros | Roland-Garros | 18 mai – 7 juin | rolandgarros.com | Annuel | ✅ Présent (complet, ~30 lignes) |
| Coupe de France Foot (finale) | Stade de France | 22 mai | fff.fr | Annuel | ✅ Présent |
| Finale Coupe France Handball | Accor Arena | 23–24 mai | ffhandball.fr | Annuel | ✅ Présent |
| Finale Coupe France Volleyball | Adidas Arena | 28 mars | ffvolley.fr | Annuel | ✅ Présent |
| Finale Top 14 Rugby | Stade de France | 27 juin | lnr.fr | Annuel | ✅ Présent |
| Racing 92 (Top 14 — matchs à domicile) | Paris La Défense Arena | Saison sept – juin | racing92.fr | Annuel | ✅ Présent |
| PSG Ligue 1 (matchs à domicile) | Parc des Princes | Août – mai | psg.fr | Annuel | ✅ Présent |
| Hockey France – Canada | Accor Arena | 10 mai 2026 | ffhockey.com | Ponctuel | ✅ Présent |
| MMA ARES 40 | Adidas Arena | Avril 2026 | aresfc.com | Ponctuel | ✅ Présent |
| Kickboxing World Championship | Grand Palais | Avril 2026 | wako-sport.org | Ponctuel | ✅ Présent |
| Tony Yoka (boxe — gala) | Adidas Arena | Avril 2026 | — | Ponctuel | ✅ Présent |
| Rocket League Championship | Paris La Défense Arena | 22–24 mai 2026 | rocketleague.com | Annuel | ✅ Présent |
| **Marathon de Paris** | Champs-Élysées (départ/arrivée) | 1er dimanche d'avril (5 avr 2026) | schneiderelectricparismarathon.com | Annuel | 🚨 Absent CRITIQUE |
| **Rolex Paris Masters (ATP)** | Accor Arena (Bercy) | Fin oct – début nov | rolexparismasterstennis.com | Annuel | 🚨 Absent CRITIQUE |
| **NBA Paris Game** | Accor Arena | Janvier | nba.com/paris | Ponctuel (annuel si reconduit) | ❌ Absent (janvier hors CSV) |
| **PSG Ligue des Champions** | Parc des Princes | Sept – mai (selon tirage) | psg.fr/champions-league | Annuel (si qualifié) | ❌ Absent |
| **Semi-marathon de Paris** | Paris (itinéraire centre) | Mars | schneiderelectricparismarathon.com | Annuel | ❌ Absent |
| **France Basketball (matchs dom.)** | Accor Arena / Adidas Arena | Selon calendrier FIBA | ffbb.com | Ponctuel | ❌ Absent |

**Note Marathon de Paris** : ~57 000 coureurs, impact trafic majeur sur tout Paris (fermeture
ponts, rues) de 8h à 16h. Absent du Sheet alors que c'est un des 5 plus gros events de l'année.

**Note Rolex Paris Masters** : 8 jours consécutifs, ~100 000 spectateurs, l'un des plus
grands tournois ATP indoor. Venue = Bercy → flux taxi CDG direct très important.

---

## §6. Soirées exceptionnelles

> Cible : événements ponctuels à forte densité de personnes dans l'espace public parisien.
> Impact taxi : retours nocturnes en masse depuis points de rassemblement sans bus de nuit.

| Nom canonical | Venue habituelle | Période | Source(s) officielle(s) | Cycle | Couverture 2026 |
|---|---|---|---|---|---|
| Feux du 14 Juillet | Tour Eiffel / Champ-de-Mars | 14 juillet (fixe) | paris.fr | Annuel | ✅ Présent |
| Nuit des Musées | Paris (multiples) | 23 mai (3e samedi de mai) | nuitdesmusees.culture.fr | Annuel | ✅ Présent (aussi §2) |
| Halloween concert (Zénith) | Zénith Paris | 31 octobre | zenith-paris.com | Ponctuel | ✅ Présent |
| Journées du Patrimoine | Paris (partout) | 3e week-end septembre | journeesdupatrimoine.culture.fr | Annuel | ⚠️ Partiel (Vincennes seulement) |
| Grand Palais Été (spectacles) | Grand Palais | Juin – août | grandpalais.fr | Annuel | ✅ Présent |
| **Réveillon Saint-Sylvestre** | Champs-Élysées (principal) | 31 décembre (fixe) | paris.fr | Annuel | 🚨 Absent CRITIQUE |
| **Nuit Blanche Paris** | Paris (partout) | 1er samedi d'octobre (3 oct 2026) | paris.fr/nuitblanche | Annuel | 🚨 Absent CRITIQUE |
| **Marathon de Paris** | Champs-Élysées | 1er dimanche d'avril | schneiderelectricparismarathon.com | Annuel | ❌ Absent (aussi §5) |
| **Cérémonie du 11 novembre** | Arc de Triomphe | 11 novembre (fixe) | elysee.fr | Annuel | ❌ Absent |
| **Grand Prix de Nuit Longchamp** | Hippodrome de Longchamp | 31 décembre | france-galop.com | Annuel | ❌ Absent |

**Note Réveillon** : la nuit du 31 décembre génère des heures d'affluence exceptionnelle
de 22h à 4h du matin sur tout Paris. L'absence du Sheet est un trou critique pour l'outil.

**Note Nuit Blanche** : ~2 millions de participants, nuit entière (20h–7h), mobilisation
totale du réseau de nuit. La date 2026 = **samedi 3 octobre**.

---

## §7. Mécanisme de check automatisé

> **Objectif** : détecter automatiquement les angles morts de couverture, les sources
> défaillantes et les événements récurrents manquants.
> **À coder en** : S10 (alertes + monitoring). Dépend de S7 (`/events/list`).

### 7.1 Fréquence des checks

| Fréquence | Cron | Déclencheur | Résultat attendu |
|-----------|------|-------------|-----------------|
| **Quotidien** | `0 7 * * *` (UTC) | Tous les jours à 7h | Mail si ≥ 1 alerte, silence si RAS |
| **Hebdomadaire** | `0 6 * * 1` (UTC) | Lundi à 6h | Mail récap **toujours envoyé** (preuve que le système tourne) |

### 7.2 Types de check

#### Check a — Venues prioritaires vides
**Venues ciblées** : Stade de France, Accor Arena (Bercy), Zénith Paris,
Paris La Défense Arena, Olympia, Adidas Arena (anciennement AccorHotels)

**Seuil d'alerte** : < 1 event confirmé sur les **7 prochains jours** pour l'une de ces venues.

**Logique** :
```
venues_priority = [stade_france, bercy_arena, zenith, defense_arena, olympia, adidas_arena]
Pour chaque venue :
  count = events.filter(e => e.venue === venue && J+1 ≤ e.date ≤ J+7 && e.status !== 'stale_warning')
  SI count === 0 → ALERTE "Venue vide sur 7j : {venue}"
```

**Priorité** : 🔴 haute (les grandes venues sont rarement vides)

---

#### Check b — Catégories sous-représentées par saison
**Règle** : certaines catégories ont des pics saisonniers prévisibles.

| Catégorie | Saison haute | Seuil min attendu (sur 30j) |
|-----------|-------------|---------------------------|
| `salon` | Sept–nov, mars–avr | ≥ 5 salons |
| `festival` | Juin–août | ≥ 3 festivals |
| `course` (hippique) | Avr–oct | ≥ 2 réunions |
| `sport_tennis` | Mai–juin (RG), oct–nov (Masters) | ≥ 1 event |
| `concert` | Toute l'année | ≥ 10 events |

**Logique** :
```
Pendant la saison haute de chaque catégorie :
  count = events.filter(e => e.cat === cat && J+1 ≤ e.date ≤ J+30)
  SI count < seuil_min → ALERTE "Catégorie {cat} sous-représentée sur 30j : {count}/{seuil}"
```

**Priorité** : 🟡 moyenne

---

#### Check c — Events récurrents du COVERAGE_EVENTS.md absents à J−30
**Principe** : pour chaque événement annuel listé dans ce doc, vérifier qu'il apparaît
dans le Store à au moins 30 jours de sa date habituelle.

**Liste de référence** (date approximative connue, à maintenir dans le code) :

```javascript
const RECURRING_CHECKS = [
  { name: 'Marathon de Paris',     month: 4, day_approx: 5,  cat: 'course',        venue_hint: null },
  { name: 'Rolex Paris Masters',   month: 10, day_approx: 27, cat: 'sport_tennis', venue_hint: 'bercy_arena' },
  { name: 'Réveillon St-Sylvestre',month: 12, day_approx: 31, cat: 'soiree',       venue_hint: null },
  { name: 'Nuit Blanche Paris',    month: 10, day_approx: 3,  cat: 'soiree',       venue_hint: null },
  { name: 'We Love Green',         month: 6,  day_approx: 1,  cat: 'festival',     venue_hint: 'vincennes' },
  { name: 'Solidays',              month: 6,  day_approx: 20, cat: 'festival',     venue_hint: 'longchamp' },
  { name: 'Rock en Seine',         month: 8,  day_approx: 24, cat: 'festival',     venue_hint: 'saint_cloud' },
  { name: "Arc de Triomphe",       month: 10, day_approx: 4,  cat: 'course',       venue_hint: 'longchamp' },
  { name: 'Roland-Garros',         month: 5,  day_approx: 18, cat: 'sport_tennis', venue_hint: 'roland_garros' },
  { name: 'Fête de la Musique',    month: 6,  day_approx: 21, cat: 'concert',      venue_hint: null },
  { name: 'Feux 14 Juillet',       month: 7,  day_approx: 14, cat: 'soiree',       venue_hint: null },
];
```

**Logique** :
```
Pour chaque entry dans RECURRING_CHECKS :
  window_start = date_approx − 30 jours
  window_end   = date_approx + 30 jours
  found = events.some(e => e.cat === entry.cat &&
                           e.date est dans [window_start, window_end] &&
                           (entry.venue_hint === null || e.venue === entry.venue_hint))
  SI !found ET date_approx est dans [today, today+90] → ALERTE "Event récurrent absent : {name}"
```

**Priorité** : 🔴 haute pour les 🚨 Absent CRITIQUE du présent document

---

#### Check d — Théâtres récurrents : 0 occurrence sur 30 jours
**Principe** : identifier les venues à programme récurrent (Zénith, Olympia, Grand Rex,
Casino de Paris) qui n'auraient aucune ligne sur 30 jours.

**Venues récurrentes ciblées** : `zenith`, `olympia`, `grand_rex`, `casino_paris`, `salle_pleyel`

**Seuil** : < 1 event sur les 30 prochains jours pour ces venues.

**Logique** :
```
Pour chaque venue dans venues_recurrentes :
  count = events.filter(e => e.venue === venue && J+1 ≤ e.date ≤ J+30)
  SI count === 0 → ALERTE "Venue récurrente vide sur 30j : {venue} — source active ?"
```

**Priorité** : 🟠 haute (ces venues ont quasi toujours quelque chose)

---

#### Check e — Cross-source orphelin (Ticketmaster sans confirmation)
**Principe** : si un event est remonté par Ticketmaster mais n'est confirmé ni par QFAP
ni par Sheet, il est marqué `pending_review` et génère une alerte.

**Logique** :
```
Pour chaque event e avec source === 'ticketmaster.fr' (ou .com) :
  confirme_par_autre_source = events_list.some(other =>
    other.id !== e.id &&
    fuzzyCanMerge(e.titre_slug, other.titre_slug, e.heure_debut, other.heure_debut) &&
    other.source !== 'ticketmaster.fr' && other.source !== 'ticketmaster.com'
  )
  SI !confirme_par_autre_source → e.status = 'pending_review'; ALERTE "Orphelin TM : {e.titre}"
```

**Priorité** : 🟡 moyenne (bruit possible — à calibrer en S10)

---

#### Check f — Chute brutale du nombre d'events (source en panne)
**Principe** : comparer le nombre d'events par source cette semaine vs la semaine précédente.
Une chute ≥ 30% suggère une panne de scraping ou une désindexation.

**Logique** :
```
Pour chaque source dans [qfap, sortiraparis.com, openagenda_idf, ticketmaster.fr] :
  count_now  = events.filter(e => e.source === source && today ≤ e.date ≤ today+7).length
  count_prev = events.filter(e => e.source === source && today-7 ≤ e.date ≤ today).length
  SI count_prev > 0 ET count_now < count_prev × 0.70 →
    ALERTE "Source possiblement en panne : {source} ({count_now} vs {count_prev} la semaine dernière)"
```

**Priorité** : 🔴 haute (panne source = trou invisible dans la couverture)

---

### 7.3 Format des alertes

#### Mail quotidien (si ≥ 1 alerte)
```
Objet : [TaxiPulse] ⚠️ {N} alerte(s) couverture — {date}

Résumé :
  - Check a (venues vides)    : {N} alerte(s)
  - Check c (récurrents abs.) : {N} alerte(s)
  - Check f (source panne)    : {N} alerte(s)

Détail :
  [liste des alertes avec check type + nom event + action suggérée]

→ Dashboard : https://taxipulse-proxy.../admin/events/health
```

#### Mail hebdomadaire (lundi — TOUJOURS envoyé)
```
Objet : [TaxiPulse] 📊 Récap couverture semaine {N} — {date}

Bilan :
  - Events actifs dans le Store : {total}
  - Venues prioritaires couvertes à J+7 : {N}/6
  - Sources actives cette semaine : {liste}
  - Alertes déclenchées cette semaine : {N}

Trous identifiés cette semaine :
  [liste checks b/c/d si des catégories sont sous-représentées]

Système opérationnel depuis : {last_successful_run}
```

#### Dashboard `/admin/events/health` (à créer en S7)
- Vue temps réel du Store V2 (total events, par status, par source)
- État de chaque check a–f (vert/orange/rouge)
- Historique des 7 dernières alertes
- Lien vers les conflits non résolus

---

### 7.4 Limite explicite du système

> **Ce que le check automatisé ne fait PAS :**
>
> Le système détecte uniquement :
> (1) les trous sur les événements **déjà listés** dans ce document (`RECURRING_CHECKS`),
> (2) les anomalies de volume des sources automatiques.
>
> Il ne devine **pas** les événements totalement nouveaux, jamais annoncés dans nos sources
> ni dans ce document. Pour ceux-là, la couverture repose sur :
> - Multi-sources (si 2 sources le signalent, il remonte)
> - Retour chauffeur (vote via `/event/confirm`)
> - Veille manuelle Sofiane (ajout direct dans le Sheet)
>
> Ce document `COVERAGE_EVENTS.md` doit être **mis à jour manuellement** lorsqu'un
> événement récurrent est identifié comme important mais absent de la liste.

---

## §8. Trous identifiés à corriger d'urgence

> Classement par priorité (impact taxi estimé × facilité de scraping).
> Ces events devraient être ajoutés au Sheet 2026 avant la prochaine saison concernée.

### 🚨 Priorité 1 — Impact critique, à corriger immédiatement

| Event | Date 2026 | Pourquoi critique | Action |
|-------|-----------|-------------------|--------|
| **Marathon de Paris** | 5 avril 2026 | ~57 000 coureurs, fermeture de Paris, impacte TOUTES les courses de 7h à 16h | Ajouter 1 ligne dans Sheet + source `schneiderelectricparismarathon.com` |
| **Rolex Paris Masters (ATP)** | ~26 oct–1 nov 2026 | 8 jours, 100k spectateurs à Bercy, flux CDG massif | Scraper `rolexparismasterstennis.com` en S11 |
| **Réveillon Saint-Sylvestre** | 31 décembre 2026 | Nuit la plus chargée de l'année, retours 22h–4h | Ajouter 1 ligne dans Sheet (pas besoin de source externe) |
| **Nuit Blanche Paris** | 3 octobre 2026 | ~2M de participants, toute la nuit, pas de bus | Ajouter 1 ligne dans Sheet (paris.fr) |

### 🟠 Priorité 2 — Impact fort, à couvrir en S11+

| Event | Date 2026 | Pourquoi important | Source à scraper |
|-------|-----------|-------------------|-----------------|
| **Centre Pompidou (expos)** | Toute l'année | Nocturnes jeudi jusqu'à 23h, ~3,5M visiteurs/an | centrepompidou.fr/agenda |
| **Lollapalooza Paris** | Mi-juillet 2026 | Festival multi-jours à Longchamp, public international | lollapaloozafr.com |
| **PSG Champions League** | Sept 2026 – mai 2027 | Matchs à 21h, flux CDG/Orly J-1 et J+1 | psg.fr/calendrier |
| **Paris Jazz Festival** | Juin – juillet 2026 | Gratuit, très fréquenté, Parc Floral de Vincennes | parisjazzfestival.fr |
| **Semi-marathon de Paris** | Mars 2026 | ~30 000 participants, itinéraire centre Paris | schneiderelectricparismarathon.com |

### 🟡 Priorité 3 — À ajouter à la prochaine mise à jour annuelle du Sheet

| Event | Pourquoi | Cycle |
|-------|----------|-------|
| Nautic (Salon Nautique) | ~200k visiteurs, Porte de Versailles déc. | Annuel |
| Grand Prix d'Amérique | Plus grande course de trot au monde, Vincennes jan. | Annuel |
| Nuit Blanche 2027 (mémo) | Mettre dans le Sheet dès annonce (1er samedi oct.) | Annuel |
| NBA Paris Game 2027 | Si reconduit, Bercy, forte demande taxi nuit | Ponctuel |
| Paris Retail Week | ~30k visiteurs pro, Villepinte sept. | Annuel |

---

## Résumé statistique

| Section | Events listés | Présents Sheet 2026 | Partiels | Absents |
|---------|-------------|---------------------|----------|---------|
| §1 Festivals | 11 | 7 | 0 | 4 |
| §2 Expositions | 11 | 6 | 2 | 3 |
| §3 Courses hippiques | 12 | 8 | 2 | 3 (dont 1 janv.) |
| §4 Salons | 24 | 21 | 0 | 3 |
| §5 Sports majeurs | 18 | 13 | 0 | 5 |
| §6 Soirées | 10 | 5 | 1 | 4 |
| **Total** | **86** | **60** | **5** | **22** |

> **Sheet 2026 actuel** : 708 events (CSV `events_master_2026_v3_final.csv`).
> Sur les 86 incontournables recensés dans ce document :
> - **60 présents** (dont 5 partiels/incomplets) — soit **70 %**
> - **22 absents** — soit **25 %** (dont **4 critiques §8 priorité 1**)
> - **Note** : Janvier et février sont hors scope du CSV actuel (0 entries).
>   Grand Prix d'Amérique + NBA Paris Game sont donc structurellement absents de 2026.

---

*Créé en S2.5. Référence : `docs/ARCHITECTURE_EVENTS.md`. Prochaine mise à jour : S10 (alertes).*
