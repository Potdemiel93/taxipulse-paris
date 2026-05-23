# CLAUDE.md — Instructions pour Claude Code sur TaxiPulse

## 🧑‍💼 Qui je suis (toi qui lis, Claude Code)
Tu travailles pour Sofiane, chauffeur de taxi parisien et founder solo de TaxiPulse.
Il est **non-technique** : il ne lit pas le code en détail, il copie-colle des prompts préparés par un autre Claude (claude.ai web) qui pilote la stratégie.

**Conséquence directe** : tu dois TOUJOURS expliquer en français simple ce que tu fais, sans jargon. Si tu dois utiliser un mot technique (ex. "diff", "commit", "branch"), explique-le en une demi-phrase la première fois.

## 🚖 Le projet TaxiPulse
App heatmap pour chauffeurs taxi parisiens. Anti-G7, post-JO 2024.
Stack : **Cloudflare Workers + KV + Google Sheet + front HTML/JS vanilla single-file**.
Repo privé GitHub : `Potdemiel93/taxipulse-paris` (clone local : `~/Desktop/taxi2/`).
URL prod : `https://taxipulse-proxy.boughida-sofiane.workers.dev`.

## 📁 Architecture actuelle (mai 2026)

```
taxi2/
├── worker.js              # Routeur Cloudflare (169 lignes, ES Module)
├── events-aggregator.js   # Aggregator V2 (483 lignes) — fake-detector
├── index.html             # SPA front-end — 12 106 lignes, CSS+JS inliné
├── sw.js                  # Service Worker (137 lignes)
├── src/
│   ├── lib/              # constants.js, helpers.js
│   ├── handlers/         # eurostar, route, basetaxi, event-confirm,
│   │                     # ticketmaster, events-health, events-aggregate
│   └── scheduled.js      # Cron handlers
├── assets/taxipulse-logo.svg
├── *.csv, *.tsv          # Data events 2026
└── wrangler.toml         # Config Cloudflare
```

## 🎨 L'app front (les 7 onglets actuels)
| data-tab     | Label affiché          | Rôle                                    |
|--------------|------------------------|-----------------------------------------|
| tab-now      | Gares (par défaut)     | Trafic gares Paris temps réel           |
| tab-stats    | Rush                   | (À SUPPRIMER prochainement)             |
| tab-theatres | Théâtres               | Fins de spectacle                       |
| tab-events   | Events                 | Concerts/sport (aggregator V2)          |
| tab-aero     | Aéro                   | Aéroports (à perfectionner)             |
| tab-trajet   | Trajet                 | Estimation tarif course (à refondre)    |
| tab-ca       | CA                     | Chiffre d'affaires perso chauffeur      |

## 🚨 RÈGLES D'OR — non négociables

### Règle 1 : PROPOSE, attends "go", PUIS exécute
Tu présentes toujours les commandes/édits que tu veux faire AVANT de les exécuter.
Tu termines ton message par : `Dis "go" pour exécuter.`
Tu n'enchaînes JAMAIS plusieurs étapes sans validation explicite — même si une étape de vérification est passée OK.
Exception : les lectures (cat, ls, grep, git status, git log, diff) — celles-là tu peux les enchaîner librement.

### Règle 2 : Vérifie AVANT de modifier
Avant tout `rm`, `mv`, ou édition de fichier critique :
- Cherche les références (`grep`) → si quelque chose dépend du fichier, STOP
- Pour les suppressions, confirme que le contenu est récupérable ailleurs (git, _archive/)
- Scan rapide des fichiers contenant potentiellement des secrets avant suppression

### Règle 3 : Jamais de secrets en clair
Aucun token, API key, mot de passe ne doit JAMAIS être écrit dans le code, les commits, les commentaires, ou les fichiers de scratch.
Les secrets sont dans **Cloudflare Secrets** (configurés : BROWSERLESS_TOKEN, RESEND_API_KEY, ADMIN_EMAIL, TICKETMASTER_KEY).
Si tu vois un secret en clair quelque part, ALERTE Sofiane immédiatement.

### Règle 4 : Données chauffeurs = sacré
Sofiane construit un produit qui collectera à terme :
- Cartes professionnelles (photos recto/verso)
- Géolocalisation chauffeurs
- Historique de courses
- Données d'identité

Si tu manipules quoi que ce soit qui touche aux données chauffeurs (même dans des mocks ou des tests) :
- Stoppe et demande confirmation à Sofiane
- Rappelle la contrainte RGPD (UE-only, pas de transfer hors UE)
- N'écris JAMAIS de vraies données chauffeurs dans un fichier de test

### Règle 5 : Le déploiement prod est une cérémonie
Avant tout `wrangler deploy`, `git push`, ou `gh pr merge` :
- Vérifie qu'on est sur la bonne branche
- Affiche les modifs avec `git status` + `git diff`
- Liste les endpoints à tester après deploy
- Termine par : `Confirme "deploy production" pour pousser en prod.` (pas juste "go")

## 🔧 Conventions techniques

- **ES Module syntax** uniquement pour worker.js (`export default { fetch, scheduled }`)
- **env passé partout** — chaque handler reçoit `env` en paramètre (pas de globales)
- **Pas de console.log laissé en prod** — utilise-le en debug, retire-le avant commit
- **Commits** : convention `type: description courte` (feat:, fix:, refactor:, chore:, docs:)
- **Branches** : une branche par feature (`feat/auth-chauffeur`, `fix/estimation-bug`, etc.)
- **Tests locaux d'abord** : `wrangler dev` AVANT `wrangler deploy`

## 📚 Commandes de récupération utiles (git)
- Récupérer worker.js d'avant le refactor V7 : `git show afde280:worker.js`
- Récupérer aggregator V1 (avant fake-detector) : `git show ea9d126:events-aggregator.js`
- Voir tous les commits sur un fichier : `git log --oneline --all -- <fichier>`

## 🚧 Chantiers prioritaires à venir (par ordre)
1. **Refonte tab-trajet** : estimation avec adresses libres (pas seulement CDG/Gare du Nord hardcodés)
2. **Heatmap en accueil** + suppression tab-stats (Rush)
3. **Améliorer tab-aero** (à préciser avec Sofiane)
4. **Nouvel onglet Chat** (à préciser : entre chauffeurs ou avec IA)
5. **Auth + validation carte pro** (gros chantier, 3-4 semaines)
6. **AIPD RGPD** (livrable légal, pas de code)

## 📐 Chantier Events V2 (session active)

**Avant tout code sur les events : lire `docs/ARCHITECTURE_EVENTS.md`.**

### Sessions
S1 (cadrage docs) → S2 (normalize.js) → S3 (event-store.js) → S4 (ingest.js) →
S5 (sync Sheet) → S6 (refacto aggregator/TM) → S7 (API /events/list) →
S8 (bascule front) → S9 (théâtres récurrents) → S10 (alertes) → S11+ (sources canonical)

### Règles spécifiques à ce chantier
- Toute déviation d'architecture → STOP + demander à Sofiane
- Chaque session finit par un **commit propre + test vert + livrable vérifiable**
- Test rouge = session pas finie
- Toujours annoncer le diff prévisualisé avant de modifier

### Cas de test non-régression (9 cas — voir ARCHITECTURE_EVENTS.md §5)
Jul SdF · Daho vs Renaud · Roland-Garros day/night · RG Qualifs dedup ·
Fally (2 jours, pas 4) · Céline 16 dates · Pagny 16 dates · Sheet bat canonical · stale_warning

## 🎁 Backups locaux automatiques
Pas besoin de créer des fichiers .bak ou un dossier backups/.
**Git suffit comme archive.** Tout est récupérable via `git show <commit>:<fichier>`.

## ⚠️ À ne JAMAIS faire
- Commiter dans `main` directement — toujours par PR depuis une branche feature
- `git push --force` sur `main`
- Toucher à `wrangler.toml` (crons, KV namespace) sans confirmation explicite
- Modifier `events_master_2026_v3_final.csv` (data de prod sensible)
- Supprimer un fichier sans avoir vérifié qu'il est dans git history
- Promettre à Sofiane qu'une feature marche sans l'avoir testée en local

## ✨ État d'esprit
On builde un produit B2B qui va toucher la vie pro de chauffeurs taxi. C'est leur outil de travail, pas un side-project jouet. Précision, prudence, et clarté avant rapidité.
