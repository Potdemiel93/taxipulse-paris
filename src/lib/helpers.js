// =============================================================================
// TaxiPulse — Fonctions utilitaires partagées
// Extrait de worker.js — fonctions copiées à l'identique avec export ajouté
// =============================================================================

import { ORIGIN_NORMALIZE } from './constants.js';

// ─── Normalisation origin Eurostar (worker.js:74-82) ───
export function normalizeOrigin(rawText) {
  if (!rawText) return null;
  const lower = rawText.toLowerCase().trim();
  for (const key in ORIGIN_NORMALIZE) {
    if (lower.indexOf(key) >= 0) return ORIGIN_NORMALIZE[key];
  }
  return null;
}

// ─── Décodage entités HTML (worker.js:97-113) ───
export function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&eacute;/g, 'e')
    .replace(/&egrave;/g, 'e')
    .replace(/&agrave;/g, 'a')
    .replace(/&ecirc;/g, 'e')
    .replace(/&#233;/g, 'e')
    .replace(/&#232;/g, 'e');
}

// ─── Strip HTML tags (worker.js:114-121) ───
export function stripHTML(html) {
  return decodeEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// ─── Parsing ISO datetime vers HH:MM (worker.js:127-131) ───
export function parseISODateTimeToHM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d{2}):(\d{2}):/);
  return m ? (m[1] + ':' + m[2]) : null;
}

// ─── Récupère IP client (worker.js:568-572) ───
export function getClientIP(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-forwarded-for') ||
         'unknown';
}

// ─── Hash SHA-256 d'une IP (worker.js:626-637) ───
export async function hashIP(ip) {
  try {
    const data = new TextEncoder().encode(ip + '_taxipulse_salt_v1');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (e) {
    return 'h_' + ip.split('.').join('_').substr(0, 16);
  }
}

// ─── Distance Haversine en mètres (worker.js:688-697) ───
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Parse timestamp fin d'event (worker.js:699-712) ───
export function parseFinTimestamp(dayStr, finStr) {
  try {
    if (!finStr || !/^\d{2}:\d{2}$/.test(finStr)) return null;
    const [h, m] = finStr.split(':').map(Number);
    let d;
    if (dayStr && /^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
      d = new Date(dayStr + 'T' + finStr + ':00');
    } else {
      d = new Date();
      d.setHours(h, m, 0, 0);
    }
    return d.getTime();
  } catch (e) { return null; }
}

// ─── Ajoute des minutes à HH:MM (worker.js:964-970) ───
export function addMinutesTM(hhmm, mins) {
  const parts = hhmm.split(':').map(Number);
  const total = parts[0] * 60 + parts[1] + mins;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return String(newH).padStart(2, '0') + ':' + String(newM).padStart(2, '0');
}

// ─── Escape HTML pour emails (worker.js:2176-2184) ───
export function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

