# 🚖 TaxiPulse — Prompt de reprise

Je continue le développement de **TaxiPulse**, mon app de heatmap prédictive pour chauffeurs taxi parisiens. Je suis chauffeur taxi moi-même, solo founder, je code en parallèle. Lis ce mémo en entier avant de me répondre.

---

## 🎯 LE PROJET

**Vision** : "Sache où charger. Avant les autres." — Heatmap prédictive multi-sources pour taxis parisiens. Positionnement anti-G7, post-JO 2024, par un chauffeur pour les chauffeurs.

**Stack** : Cloudflare Workers + D1 (SQLite) + R2 (objets) + KV (cache). Frontend : à définir (Leaflet probable). Tout en jurisdiction UE post-Schrems II.

**Périmètre V1** : Paris + petite couronne (92, 93, 94). MAJ data temps réel (horaire minimum).

---

## ✅ DÉCISIONS ACTÉES (ne pas remettre en question sauf si je te demande)

### Inscription / Auth
- Vérification carte pro taxi par **photo recto + verso**, validation manuelle par moi via admin panel
- Pendant la vérif : **accès immédiat + badge orange** (deadline 30 jours)
- Auth quotidienne : **email + mot de passe + OTP 6 chiffres**
- **Trusted device 30-60 jours** coché par défaut (atténuation friction)
- **Onboarding en 2 phases séparées** : inscription rapide 3 min puis vérif carte plus tard

### Heatmap
- **Visuelle riche dès V1** (carte colorée, pas Top 3 textuel)
- **PAS de crowdsourcing chauffeur en V1** (open data uniquement)
- **PAS de géoloc chauffeurs en V1** (pas de valeur retournée = violation RGPD)
- Crowdsourcing géoloc = V2 avec opt-in + features premium en échange
- **H3 d'Uber** pour grille spatiale (résolution 9 = 175m d'arête)
- Anonymat : k=15 chauffeurs distincts, agrégation 48h, hashing salé quotidien

### Approche
- Pas de big-bang 16 semaines → **4 phases avec gates de validation**
- 10 interviews chauffeurs SKIPPÉS (je suis chauffeur, validé en interne avec collègues)
- AIPD obligatoire avant bêta (brouillon avec toi + validation DPO 2-3K€)

---

## 📊 ÉTAT DU CODE EXISTANT

### Ce qui tourne
- Workers Cloudflare de scraping events (sites concerts, salons, sport)
- Table `events` en D1 (mais sale, à refactor)
- App avec onglets : Events, Transports, Météo, etc.

### Problèmes identifiés (à corriger)
- **Doublons massifs** : Jul Stade de France avec horaires 23h ET 23h30, Roland-Garros chaque jour dupliqué, Fally Ipupa dupliqué, etc.
- **Bug Daho/Renaud au Zénith** : data périmée, source pas re-scrapée
- **Sources non hiérarchisées** : sortiraparis traité comme source officielle
- **Fake events** : "Concert rock", "Concert TBA", "Programmation à vérifier"
- **MAJ hebdo seulement** → data périmée 6j/7
- **Lieux mal géolocalisés** : Chantilly tagué Longchamp

### Plan de fiabilisation data (10-12h dev, 2-3 jours)
Détaillé étape par étape — voir document `PLAN-FIABILISATION-DATA.md` si je l'ai partagé. Résumé :
1. Audit Workers existants
2. Backup D1
3. Création table `events_v2` avec `event_hash`, `confidence_score`, `source_type`
4. Seed table `venues` (~30 lieux référencés)
5. Lib `normalize.ts` (normalisation titres + hash SHA-256)
6. Lib `fake-detector.ts` (patterns rejet)
7. Fonction `upsertEvent()` — le cœur du système, dédup + hiérarchie sources
8. Migration Workers (Roland-Garros → Stade France → Viparis → Bercy → Zénith → autres)
9. API `getEventsForDate(date, minConfidence=60)`
10. Dashboard admin health (optionnel)
11. Bascule events_v2 → events

### Hiérarchie sources actée
- **Canonical (score 80)** : sites officiels lieux (le-zenith.com, accorarena.com, stadefrance.com, rolandgarros.com, viparis.com, etc.)
- **Fallback (60)** : fnacspectacles.com
- **Aggregator (40)** : sortiraparis.com, offi.fr, songkick.com → **JAMAIS source canonique**

---

## 🚧 ROADMAP GLOBALE

### Phase 0 — Fondations (Sem 1-2) — EN COURS
- ✅ Plan fiabilisation data prêt (à exécuter sur Mac)
- ⏳ Brouillon AIPD avec Claude
- ⏳ Vérification statut LOM (loi mobilité 2019) / notification Préfecture Police Paris
- ⏳ Cyber-assurance + RC Pro tech souscrites
- ⏳ Unit economics (LTV ≈84€ vs CAC target <30€)

### Phase 1 — Inscription/Auth (Sem 3-5)
- Schéma BDD : users, otp_codes, sessions, cards, blacklist, consents, audit_logs
- Auth backend : bcrypt cost 12, JWT HS256 24h, refresh 30j, OTP 10min/5 essais
- 5 écrans inscription rapide (landing → email/pwd → OTP → consentements → bienvenue)
- 5 écrans vérif carte (pourquoi → infos carte → photo recto → photo verso → confirmation)
- Upload R2 + chiffrement applicatif AES-256-GCM
- **Admin panel validation EN PREMIER** (2-3 jours, critique)
- OCR Tesseract.js + reverse image TinEye (signaux faibles, décision finale humaine)
- Stack email : Resend (UE)

### Phase 2 — Bêta privée 10 chauffeurs (Sem 6-8)
- V0 heatmap avec data fiabilisée
- Critère go/no-go : ≥7/10 disent "j'ai gagné plus" + NPS>+20

### Phase 3 — Heatmap complète (Sem 9-12)
- H3 + scoring 3 couches additives :
  ```
  Score = Baseline(50%) + LiveBoost(30%) + EventBoost(20%)
        × WeatherModifier × TrafficModifier 
        × ExceptionModifier × SelfFulfillingDamper
  ```
- Anti-self-fulfilling : décrément selon consultations 5min
- Affichage incertitude (opacité = score, contour = confiance)
- Calendrier d'exceptions manuel (Ramadan, Fashion Week, RG, Tour de France, etc.)

### Phase 4 — Détection auto + apprentissage (Sem 13+)
- Détection charge hybride 3 états (confirmed/probable/ignored)
- Multi-armed bandit cold-start
- Régression linéaire sur résidus (hebdo manuel d'abord)
- Scaling 200+ chauffeurs

---

## ⚠️ POINTS CRITIQUES À NE PAS OUBLIER

1. **AIPD obligatoire avant bêta** — 2-3K€ DPO mutualisé (Dipeeo, Dastra). On rédige le brouillon ensemble pour faire baisser le coût.

2. **Expiration carte pro** — rappels J-60/J-30/J-7 + suspension auto à expiration (oublié initialement par tous les experts)

3. **Récupération compte si perte tel + email** — procédure manuelle exceptionnelle (photo carte + selfie + validation manuelle)

4. **Comptes fantômes mode découverte** — suppression auto J+30 si carte non envoyée

5. **Article 22 RGPD** — OCR/reverse search = signaux faibles, décision finale humaine obligatoire

6. **Localisation données UE** — Cloudflare config jurisdiction EU

7. **Pen-test auth obligatoire avant prod** — 2-3K€

8. **DPA à signer** : Cloudflare, Resend, TinEye

9. **Statut LOM 2019** : TaxiPulse pourrait être requalifié "plateforme d'intermédiation" → obligations supplémentaires possibles

10. **Self-fulfilling prophecy** heatmap : si "Bercy chaud" affiché, tous y vont, devient froid → décrément selon consultations 5min

11. **Coût asymétrique erreurs** : heatmap 75% précision ressentie = 80% inutile, mieux afficher "incertain" que "chaud risqué"

12. **Saisonnalité** : calendrier d'exceptions manuel (jamais ML)

13. **Vraie menace sécurité = fuite base entière** (pas re-identification mathématique) → pen-test offensif > k-anonymity ε=0.5

---

## 📁 DOCUMENTS DE RÉFÉRENCE EXISTANTS

Si je les uploade ou les mentionne :
- `HEATMAP-TAXIPULSE.md` — 830 lignes, doc complet heatmap (vision, archi, scoring, sources, plan, angles morts)
- `council-report-heatmap-20260503.html` — Council Vol. II (5 experts sur l'architecture heatmap)
- `council-report-inscription-20260504.html` — Council Vol. III (4 experts sur inscription/auth)
- `taxipulse-heatmap.html` — Prototype interactif visuel de la heatmap
- Google Sheets sources data events : `1UhomQI98RswTgtlLZlwQ7MBRRCy3ygmInZG7f-C_nxk` (accessible via connecteur Google Drive)

---

## 🎯 OÙ ON EN ÉTAIT

J'ai récupéré mon Mac. **Je travaille en parallèle sur 2 conversations** :
- **Conversation 1 (heatmap)** : refactor data events + architecture heatmap, je code
- **Conversation 2 (cette discussion)** : tout le reste — inscription, auth, AIPD, légal, admin panel

### Sujets ouverts dans cette conversation
- A) Spec détaillée admin panel validation cartes pro (priorité 1)
- B) Wireframes inscription Phase 1 + Phase 2 (priorité 2)
- C) Vérifications légales LOM + Préfecture (priorité 3)
- D) Brouillon AIPD (priorité 4, plus long)
- E) Unit economics (calcul tableur)
- F) Cyber-assurance + RC Pro tech (recherche providers)

---

## 🗣️ COMMENT ME PARLER

- Je suis chauffeur taxi, pas développeur pro mais je code avec Cursor/VSCode
- Pas besoin de vouvoyer, tutoie-moi
- J'écris parfois avec des fautes/style oral, traite-le comme du français correct
- Si tu détectes une mauvaise décision stratégique de ma part, **pousse-moi** plutôt que céder
- Privilégie la vérité honnête à la flatterie complaisante
- Quand je te demande "fais-le toi-même" sur un sujet qui requiert un pro (juriste, etc.), pousse-moi à prendre un pro
- Pour les sujets stratégiques importants, propose-moi des councils multi-experts (méthode Karpathy LLM Council)
- Pour les sujets opérationnels, donne-moi du concret directement actionnable

---

## ⏭️ MA PREMIÈRE QUESTION DANS CETTE CONVERSATION

[REMPLACE PAR CE QUE TU VEUX ATTAQUER]

Exemples :
- "Confirme que tu as tout en tête, puis attaque la spec admin panel"
- "Confirme que tu as tout en tête, puis fais-moi le brouillon AIPD"
- "Confirme que tu as tout en tête, puis recherche les obligations LOM 2019 pour TaxiPulse"
