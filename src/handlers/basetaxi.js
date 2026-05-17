// =============================================================================
// TaxiPulse — Handler BaseTaxi (attente taxi aéroports CDG/Orly)
// Extrait de worker.js (lignes 423-678) — converti pour utiliser env passé en paramètre
// =============================================================================

import {
  UA,
  BASETAXI_URLS,
  BASETAXI_CACHE_TTL_SEC,
  REPORT_DEDUP_WINDOW_SEC,
  REPORTS_KEEP_WINDOW_SEC,
  CROWD_VALIDITY_WINDOW_SEC
} from '../lib/constants.js';
import { stripHTML, getClientIP, hashIP } from '../lib/helpers.js';

// ─── Helpers de configuration ───
export function hasKV(env) {
  try {
    return env && typeof env.TAXI_KV !== 'undefined' && env.TAXI_KV !== null;
  } catch (e) {
    return false;
  }
}

export function hasBrowserless(env) {
  try {
    return env && typeof env.BROWSERLESS_TOKEN !== 'undefined' && env.BROWSERLESS_TOKEN && env.BROWSERLESS_TOKEN.length > 10;
  } catch (e) {
    return false;
  }
}

// ─── Parsing HTML (pure, pas d'env) ───
export function parseBaseTaxiHTML(html) {
  if (!html || html.length < 100) {
    return { wait_min: null, error: 'html_too_short', candidates: [] };
  }

  const text = stripHTML(html);
  const textNorm = text
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .toLowerCase();

  const candidates = [];

  const re1 = /(\d{1,3})\s*(?:min(?:utes?)?)\b/g;
  let m;
  while ((m = re1.exec(textNorm)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 240) {
      candidates.push({ value: n, idx: m.index, ctx: textNorm.substr(Math.max(0, m.index - 30), 60) });
    }
  }

  const re2 = /(?:attente|temps|wait)[\s:]*(\d{1,3})/g;
  while ((m = re2.exec(textNorm)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 240) {
      candidates.push({ value: n, idx: m.index, ctx: textNorm.substr(Math.max(0, m.index - 30), 60), strong: true });
    }
  }

  if (!candidates.length) {
    return { wait_min: null, error: 'no_match', candidates: [] };
  }

  const strong = candidates.filter(c => c.strong);
  const pool = strong.length ? strong : candidates;
  const max = pool.reduce((a, b) => b.value > a.value ? b : a, pool[0]);

  return { wait_min: max.value, candidates: candidates.slice(0, 10) };
}

// ─── Fetch live depuis Browserless (avec cache KV) ───
export async function fetchBaseTaxiLive(aero, env) {
  const url = BASETAXI_URLS[aero];
  if (!url) {
    return { ok: false, reason: 'invalid_aero', message: 'aero must be cdg or orly' };
  }

  const cacheKey = 'basetaxi_live_' + aero;

  if (hasKV(env)) {
    try {
      const cached = await env.TAXI_KV.get(cacheKey, { type: 'json' });
      if (cached && cached.ts && (Date.now() - cached.ts) < BASETAXI_CACHE_TTL_SEC * 1000) {
        return { ...cached, cached: true };
      }
    } catch (e) {}
  }

  if (!hasBrowserless(env)) {
    return {
      ok: false,
      reason: 'no_browserless',
      message: 'BROWSERLESS_TOKEN secret missing. Run: npx wrangler secret put BROWSERLESS_TOKEN'
    };
  }

  try {
    const resp = await fetch('https://chrome.browserless.io/content?token=' + env.BROWSERLESS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        gotoOptions: { waitUntil: 'networkidle0', timeout: 25000 },
        userAgent: UA
      })
    });

    if (!resp.ok) {
      return { ok: false, reason: 'browserless_http_' + resp.status };
    }

    const html = await resp.text();
    const parsed = parseBaseTaxiHTML(html);

    const result = {
      ok: parsed.wait_min !== null,
      aero: aero,
      wait_min: parsed.wait_min,
      candidates: parsed.candidates,
      source: 'parisaeroport_live',
      ts: Date.now()
    };

    if (hasKV(env) && parsed.wait_min !== null) {
      await env.TAXI_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: BASETAXI_CACHE_TTL_SEC + 30 });
    }

    return result;
  } catch (err) {
    return { ok: false, reason: 'fetch_error', message: err.message };
  }
}

// ─── Report observation chauffeur (POST) ───
export async function reportTaxiWait(aero, mins, request, env) {
  if (!hasKV(env)) {
    return { ok: false, reason: 'kv_not_configured', message: 'TAXI_KV namespace missing' };
  }
  if (!['cdg', 'orly'].includes(aero)) {
    return { ok: false, reason: 'invalid_aero' };
  }
  if (typeof mins !== 'number' || mins < 0 || mins > 240) {
    return { ok: false, reason: 'invalid_mins' };
  }

  const ip = getClientIP(request);
  const ipHash = await hashIP(ip);
  const now = Date.now();
  const key = 'basetaxi_reports_' + aero;

  let reports = [];
  try {
    const stored = await env.TAXI_KV.get(key, { type: 'json' });
    if (Array.isArray(stored)) reports = stored;
  } catch (e) {}

  // Dedup : un même IP ne peut pas reporter 2x en moins de 25 min
  const dedupCutoff = now - REPORT_DEDUP_WINDOW_SEC * 1000;
  const existing = reports.find(r => r.ipHash === ipHash && r.ts > dedupCutoff);
  if (existing) {
    return { ok: false, reason: 'dedup', message: 'Tu as déjà reporté il y a moins de 25 min', last_report: existing };
  }

  // Garbage collect des vieux reports
  const keepCutoff = now - REPORTS_KEEP_WINDOW_SEC * 1000;
  reports = reports.filter(r => r.ts > keepCutoff);
  reports.push({ value: mins, ts: now, ipHash });

  try {
    await env.TAXI_KV.put(key, JSON.stringify(reports), { expirationTtl: REPORTS_KEEP_WINDOW_SEC + 60 });
  } catch (e) {
    return { ok: false, reason: 'kv_write_failed', message: e.message };
  }

  return { ok: true, aero, value: mins, total_reports_window: reports.length, ts: now };
}

// ─── Médiane des observations chauffeurs (crowd) ───
export async function getCrowdWait(aero, env) {
  if (!hasKV(env)) {
    return { ok: false, reason: 'kv_not_configured' };
  }
  if (!['cdg', 'orly'].includes(aero)) {
    return { ok: false, reason: 'invalid_aero' };
  }

  const key = 'basetaxi_reports_' + aero;
  let reports = [];
  try {
    const stored = await env.TAXI_KV.get(key, { type: 'json' });
    if (Array.isArray(stored)) reports = stored;
  } catch (e) {}

  const now = Date.now();
  const cutoff = now - CROWD_VALIDITY_WINDOW_SEC * 1000;
  const fresh = reports.filter(r => r.ts > cutoff);

  if (!fresh.length) {
    return { ok: false, aero, reason: 'no_recent_reports', window_min: CROWD_VALIDITY_WINDOW_SEC / 60 };
  }

  const sorted = fresh.map(r => r.value).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const oldest = Math.min(...fresh.map(r => r.ts));
  const newest = Math.max(...fresh.map(r => r.ts));

  return {
    ok: true,
    aero,
    wait_min: Math.round(median),
    n_reports: fresh.length,
    oldest_age_sec: Math.round((now - oldest) / 1000),
    newest_age_sec: Math.round((now - newest) / 1000),
    ts: now
  };
}

