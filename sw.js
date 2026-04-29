/**
 * TaxiPulse Service Worker
 * Strategy: NETWORK-FIRST avec fallback cache offline.
 *
 * Objectif : les chauffeurs reçoivent automatiquement les nouvelles versions
 * sans avoir à vider leur cache. Si offline, l'app marche quand même grâce au cache.
 *
 * VERSION : changer SW_VERSION à chaque déploiement majeur (ou laisser auto via timestamp).
 * Au moindre changement, l'ancien cache est purgé et le SW se réinstalle.
 */

const SW_VERSION = 'taxipulse-v' + Date.now(); // change à chaque deploy
const CACHE_NAME = SW_VERSION;

// Ressources à pré-cacher pour offline (le minimum pour que l'app charge)
const PRECACHE_URLS = [
  './',
  './index.html'
];

// ════════════════════════════════════════════════════════════
//  INSTALL : pré-cache du minimum vital
// ════════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
  // skipWaiting() = ne pas attendre que les anciens onglets ferment
  // → le nouveau SW prend le relais immédiatement après install
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(() => {}))
      .catch(() => {})
  );
});

// ════════════════════════════════════════════════════════════
//  ACTIVATE : suppression des anciens caches
// ════════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim()) // contrôle immédiat des onglets ouverts
  );
});

// ════════════════════════════════════════════════════════════
//  FETCH : stratégie selon le type de ressource
// ════════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Ignorer les méthodes non-GET (POST, PUT, etc.)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ═══ Ne JAMAIS toucher aux requêtes externes (worker Cloudflare, Google Sheets, APIs) ═══
  // On passe le réseau direct, pas de cache. Évite tout problème de CORS et de fraîcheur.
  if (url.origin !== self.location.origin) {
    return; // pas event.respondWith() → comportement par défaut du navigateur
  }

  // ═══ Stratégie NETWORK-FIRST pour HTML, JS, CSS ═══
  // → Le navigateur essaie le réseau, fallback cache si offline
  // → Met à jour le cache en silence avec la version fraîche
  const isAppShell = req.destination === 'document'
                  || req.destination === 'script'
                  || req.destination === 'style'
                  || url.pathname.endsWith('.html')
                  || url.pathname.endsWith('.js')
                  || url.pathname.endsWith('.css')
                  || url.pathname === '/'
                  || url.pathname.endsWith('/');

  if (isAppShell) {
    event.respondWith(networkFirst(req));
    return;
  }

  // ═══ Stratégie CACHE-FIRST pour images, icônes, polices ═══
  // → Sert vite, peu de raisons de changer
  event.respondWith(cacheFirst(req));
});

// Network-first : essaie réseau, fallback cache
async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      // Met à jour le cache en silence (on attend pas)
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    // Offline → cache fallback
    const cached = await caches.match(req);
    if (cached) return cached;
    // Vraiment rien → renvoie une 504
    return new Response('Offline', { status: 504, statusText: 'Offline' });
  }
}

// Cache-first : sert vite, met à jour en arrière-plan
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Background update (stale-while-revalidate light)
    fetch(req).then(fresh => {
      if (fresh && fresh.ok) {
        caches.open(CACHE_NAME).then(c => c.put(req, fresh.clone())).catch(() => {});
      }
    }).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    return new Response('Offline', { status: 504 });
  }
}

// ════════════════════════════════════════════════════════════
//  MESSAGE : permet à la page d'envoyer "skipWaiting" pour forcer update
// ════════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
