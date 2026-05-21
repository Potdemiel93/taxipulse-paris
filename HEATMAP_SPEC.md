# HEATMAP_SPEC — TaxiPulse Live Map

> Doc de référence figée. Toute session Claude Code travaillant sur la heatmap DOIT lire ce fichier avant tout code.

## 1. VISION

TaxiPulse Live Map = "le pulse de Paris pour le taxi parisien".

Carte temps réel partagée par tous les abonnés (PAS de personnalisation par chauffeur). Montre où ça chauffe, où ça refroidit, où c'est saturé. L'app ne décide jamais. Elle montre. Le chauffeur décide.

Promesse : "La heatmap qui ne ment pas." Transparence totale sur le pourquoi (Eurostar 384 pax 21:47), le combien (€ estimé), le quand (pic réel).

## 2. PRINCIPES NON-NÉGOCIABLES

1. **Vérité partagée** : tous les abonnés voient la même carte. Pas de reco perso.
2. **Transparence > opacité** : chaque zone chaude est justifiée par une source data nommée.
3. **Confiance affichée** : chaque bulle a un niveau de confiance (⭐⭐⭐⭐).
4. **Honnêteté > hype** : disclaimer permanent, jamais de fausse promesse.
5. **Pas de driver score sanctionnant** : que des carottes, jamais de bâton.
6. **Lecture < 1 seconde** : conçu pour être lu en conduite.
7. **Co-création** : bouton feedback toujours visible, comme Wolt.

## 3. ARCHITECTURE EN COUCHES

### Couche 1 — DEMANDE (data externe vérifiée)
Sources : SNCF Navitia, vols CDG/Orly/Beauvais, Eurostar, events théâtres/salles/stades, salons (Porte de Versailles, Villepinte, Bourget, Palais des Congrès), rocs parisiens (palaces, étoilés), météo, calendrier.

### Couche 2 — SATURATION abonnés (V1.5, pas V1)
Densité abonnés à vide par zone. Couleur bleue overlay. Permet auto-régulation.

### Couche 3 — MODULATEURS
Multiplicateurs combinatoires (pluie ×1.3, grève RATP ×2, nuit ×1.5, vacances ×0.7, etc.).

### Couche 4 — TIMING MÉTIER
Pic réel ≠ horaire arrivée :
- Eurostar : arrivée + 8 min, pic 25 min
- TGV : arrivée + 4 min, pic 15 min
- Vol Schengen : arrivée + 20 min, pic 30 min
- Vol international : arrivée + 40 min, pic 45 min
- Fin concert Bercy : fin + 5 min, pic 60 min étalé
- Fin théâtre : fin + 2 min, pic 20 min

## 4. RENDU VISUEL

### Code couleur (5 niveaux)
- 🟥 Rouge foncé : Score 85-100 (très chaud, course estimée >€25)
- 🟧 Orange : 65-85 (chaud, €15-25)
- 🟨 Jaune : 40-65 (tiède, €10-15)
- 🟩 Vert : 20-40 (calme)
- ⚪ Gris : <20 (mort)
- Pointillés/translucide : prédiction +15/+30 min (pas encore actif)

### Format zones
Polygones par sortie taxi précise (PAS par gare globale) :
- Gare du Nord = 3 polygones distincts (sortie principale, Eurostar Maubeuge, sortie banlieue)
- CDG = 8 polygones (T1, T2A, T2B, T2C, T2D, T2E, T2F, T3)
- Gare de Lyon = 3 (Hall 1, Hall 2, Diderot)

### Refresh
60-120 secondes (aligné Uber/Bolt/Wolt). PAS 30s (coût + batterie).

## 5. UX

### Layout écran
- Top bar minimal (statut + 🔔 + ⚙️ + heure)
- Carte 60-70% écran
- Bottom sheet draggable (résumé top zones)
- FAB "Recentrer ma position"
- Bouton "GO au spot chaud le plus proche" géant
- Bouton feedback flottant (💬)

### Tap sur une bulle
Bottom sheet glisse (50% écran), carte reste visible en haut. Affiche :
- Nom zone exact + sortie précise
- Source data nommée (ex: "Eurostar 9382 Bruxelles, arrivée 21:47, 384 pax")
- Pic prévu (ex: "21:55-22:15")
- Course estimée en € (ex: "22-30€")
- Confiance ⭐⭐⭐⭐
- Bouton "🧭 Y ALLER" → lance navigation externe

### Navigation externe
L'abonné choisit dans Settings : Waze / Plans / Google Maps (par défaut Waze). Tap "Y ALLER" → ouvre l'app de nav avec destination pré-remplie.

### Dark mode
Automatique entre 20h-7h (réduit fatigue oculaire + adapté conduite nuit).

### Disclaimer permanent
En bas de carte : "Les estimations ne sont pas des garanties de course ni de revenus."

## 6. ANTI-DÉFIANCE (le piège Grab/Jakarta)

Construction active de la confiance :
- **Onboarding success demo** : à la 1ère ouverture, montrer un cas réel récent ("Hier 18h47 : Eurostar Gare du Nord → 6 abonnés ont chargé en 12 min")
- **Communication updates modèle** : "Modèle v2.1 — précision +12% sur les vols CDG"
- **Sondage hebdomadaire** : 1 question, 4 options (style Wolt)
- **Dashboard transparent public** : visible par tous, "87% des spots Eurostar étaient justes cette semaine"
- **Bouton 'cette reco était utile ?' 👍/👎** sur chaque détail zone

## 7. ENDPOINTS WORKER

### GET /heatmap/state
Retourne l'état global Paris. Cache KV 60s.

Réponse JSON :
```json
{
  "version": "v1",
  "generated_at": "2026-05-21T14:32:00Z",
  "expires_at": "2026-05-21T14:33:00Z",
  "zones": [
    {
      "id": "gdn-eurostar",
      "name": "Gare du Nord - Sortie Eurostar",
      "polygon": [[lat, lng], "..."],
      "score": 92,
      "color": "red",
      "estimated_fare_min": 22,
      "estimated_fare_max": 30,
      "confidence": 4,
      "reason": "Eurostar 9382 Bruxelles, 384 pax",
      "peak_start": "2026-05-21T21:55:00Z",
      "peak_end": "2026-05-21T22:15:00Z",
      "source_type": "eurostar"
    }
  ],
  "global_status": "chaud",
  "modulators_active": ["pluie"]
}
```

### POST /heatmap/feedback (V1)
Body : { zone_id, useful: bool, comment?: string }
Stocke en KV pour analyse hebdomadaire.

### GET /heatmap/health (V1.5)
Stats publiques de précision du modèle.

## 8. STACK TECHNIQUE

- **Carte** : Leaflet 1.9+ (lib gratuite, légère, mobile-friendly)
- **Fond de carte** : OpenStreetMap (gratuit, pas Google)
- **Polygones colorés** : Leaflet natif (L.polygon)
- **Animations pulse** : CSS keyframes
- **Géoloc** : API native HTML5 déjà en place
- **Service Worker** : sw.js existant gère le cache (URLs externes bypass déjà actif)
- **Communication** : fetch() vers Worker, polling 60-120s, refresh paused si screen off

## 9. INTÉGRATION DANS L'APP

- Nouvel onglet "Map" dans bottom-nav (8e onglet, OU remplace tab-stats après suppression future)
- Icône : 🗺️ ou pictogramme custom
- Position dans la nav : entre tab-now et tab-aero (à valider visuellement)
- Tab-stats reste pour l'instant (suppression hors scope V1 Heatmap)

## 10. DATA SOURCES EXISTANTES À RÉUTILISER (index.html)

- GARES (~ligne 5980) : coordonnées + métadonnées 6 grandes gares + Saint-Lazare + CDG TGV
- AEROPORTS (~ligne 6790) : CDG, Orly
- VENUES (~ligne 9700+) : salles, théâtres
- EVENTS (~ligne 9900+) : agendas
- TRAJET_COORDS (10967-11008) : points hardcodés

Le Worker doit pouvoir lire ces sources OU les data externes (SNCF API, etc.) — à arbitrer en T2 selon ce qui est déjà côté Worker vs côté front.

## 11. CE QUI N'EST PAS DANS V1 (V1.5 / V2)

V1.5 (mois 2) :
- Couche saturation abonnés (nécessite géoloc partagée + opt-in RGPD)
- Mode vocal hands-free
- Push notifications personnalisables
- Stats perso coaching
- Live feed communautaire
- Arrêts taxi officiels Paris

V2 (mois 3-6) :
- Destination Mode (route retour avec course en chemin)
- Tiers abonnement (Blue/Gold/Platinum)
- Planner réservation zones
- Wrapper natif Capacitor (CarPlay/Android Auto)
- ML léger Random Forest

## 12. SÉCURITÉ & RGPD

- Aucune position individuelle d'abonné visible par d'autres abonnés (V1 ne collecte rien de plus que déjà existant)
- Disclaimer permanent
- Opt-in explicite pour toute future feature géoloc partagée (V1.5)

## 13. RÈGLES DE DÉVELOPPEMENT

- Aucune modif des sections existantes d'index.html sans validation explicite Sofiane
- Nouveau code Heatmap = sections clairement délimitées avec commentaires `/* === HEATMAP V1 START === */` et `/* === HEATMAP V1 END === */`
- Pas de refacto opportuniste pendant l'ajout Heatmap
- Commits atomiques : 1 commit = 1 sous-étape (carte rendue / data branchée / tap modal / etc.)
- Convention commits : `feat(heatmap): ...` / `fix(heatmap): ...`
