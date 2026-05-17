// =============================================================================
// TaxiPulse — Handler Events Health (analyse fraîcheur Sheet + recap email)
// Extrait de worker.js (lignes 1816-2175 + endpoints 1350-1378)
// Converti pour utiliser env passé en paramètre
// =============================================================================

import { CORS_HEADERS } from '../lib/constants.js';
import { escapeHtml } from '../lib/helpers.js';
import { fetchTicketmasterEvents } from './ticketmaster.js';

export const SHEET_EVENTS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTlb4vVopavpQHDKFkY4Su4HDtUo70FV7vEr7zllndq6-6duSSjDhkuBt9XP51PA3zn4nS9C8RFR8sb/pub?gid=0&single=true&output=csv';

export const MONITORED_VENUES = [
  { id: 'stade_france',     name: 'Stade de France',           url: 'https://www.stadefrance.com/fr/billetteries' },
  { id: 'bercy_arena',      name: 'Accor Arena (Bercy)',       url: 'https://www.accorarena.com/fr/agenda' },
  { id: 'defense_arena',    name: 'Paris La Défense Arena',    url: 'https://www.parisladefense-arena.com/billetterie/' },
  { id: 'adidas_arena',     name: 'Adidas Arena',              url: 'https://www.adidasarena.com/programmation' },
  { id: 'olympia',          name: 'L\'Olympia',                 url: 'https://www.olympiahall.com/agenda/' },
  { id: 'zenith',           name: 'Zénith Paris',              url: 'https://le-zenith.com/program' },
  { id: 'seine_musicale',   name: 'La Seine Musicale',         url: 'https://www.laseinemusicale.com/programmation/' },
  { id: 'philharmonie',     name: 'Philharmonie de Paris',     url: 'https://philharmoniedeparis.fr/fr/agenda' },
  { id: 'bataclan',         name: 'Bataclan',                  url: 'https://www.bataclan.fr/' },
  { id: 'cigale',           name: 'La Cigale',                 url: 'https://www.lacigale.fr/' },
  { id: 'trianon',          name: 'Le Trianon',                url: 'https://www.letrianon.fr/' },
  { id: 'porte_versailles', name: 'Porte de Versailles',       url: 'https://www.viparis.com/nos-lieux/paris-expo-porte-de-versailles/agenda' },
  { id: 'villepinte',       name: 'Paris Nord Villepinte',     url: 'https://www.viparis.com/nos-lieux/paris-nord-villepinte/agenda' },
  { id: 'bourget',          name: 'Paris Le Bourget',          url: 'https://www.viparis.com/nos-lieux/paris-le-bourget/agenda' },
  { id: 'roland_garros',    name: 'Roland-Garros',             url: 'https://www.rolandgarros.com/' },
  { id: 'parc_princes',     name: 'Parc des Princes',          url: 'https://www.psg.fr/billetterie' }
];

export function parseCSV(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

export function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// Compare events Ticketmaster avec le Sheet existant.
// Retourne uniquement les events Ticketmaster qui ne sont PAS deja dans le Sheet.
// Match par (date + venue + titre normalise) car les tm_id ne sont pas dans le Sheet.
export async function findNewTicketmasterEvents(env) {
  const today = new Date();
  const start = today.toISOString().split('T')[0];
  const end = new Date(today.getTime() + 365 * 86400000).toISOString().split('T')[0];
  const tmResult = await fetchTicketmasterEvents(start, end, false);

  if (!tmResult.events || !tmResult.events.length) {
    return { ok: true, new_events: [], total_tm: 0, message: tmResult.error || 'No events from TM' };
  }

  let csvText = '';
  try {
    const r = await fetch(SHEET_EVENTS_CSV_URL, { cf: { cacheTtl: 0 } });
    if (!r.ok) return { ok: false, error: 'Sheet HTTP ' + r.status };
    csvText = await r.text();
  } catch (e) {
    return { ok: false, error: 'Sheet fetch failed: ' + e.message };
  }

  const sheetRows = parseCSV(csvText);

  function normTitle(t) {
    return (t || '').toLowerCase()
      .replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
      .replace(/[^a-z0-9]/g, '');
  }

  const sheetKeys = new Set();
  for (const row of sheetRows) {
    if (!row.date || !row.venue || !row.titre) continue;
    const key = row.date + '|' + row.venue.toLowerCase().trim() + '|' + normTitle(row.titre);
    sheetKeys.add(key);
  }

  const newEvents = [];
  for (const ev of tmResult.events) {
    const key = ev.date + '|' + ev.venue + '|' + normTitle(ev.titre);
    if (!sheetKeys.has(key)) {
      newEvents.push(ev);
    }
  }

  return {
    ok: true,
    total_tm: tmResult.events.length,
    total_sheet_rows: sheetRows.length,
    new_events: newEvents,
    new_count: newEvents.length
  };
}


export async function analyzeEventsFreshness(env) {
  let csvText = '';
  try {
    const r = await fetch(SHEET_EVENTS_CSV_URL, { cf: { cacheTtl: 0 } });
    if (!r.ok) {
      return { ok: false, error: 'Sheet HTTP ' + r.status };
    }
    csvText = await r.text();
  } catch (e) {
    return { ok: false, error: 'Sheet fetch failed: ' + e.message };
  }

  const rows = parseCSV(csvText);
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);

  const upcoming = rows.filter(r => {
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return false;
    if (r.date < todayStr) return false;
    const conf = (r.confirme || '').trim().toUpperCase();
    return conf === 'OUI' || conf === 'YES' || conf === 'TRUE' || conf === '1';
  });

  const stats = {};
  for (const venue of MONITORED_VENUES) {
    stats[venue.id] = {
      venue_name: venue.name,
      url: venue.url,
      total: 0,
      next_30d: 0,
      next_60d: 0,
      next_90d: 0,
      beyond_90d: 0,
      latest_date: null,
      first_date: null
    };
  }
  stats['_other'] = { venue_name: 'Autres venues', url: null, total: 0, next_30d: 0, next_60d: 0, next_90d: 0, beyond_90d: 0, latest_date: null, first_date: null };

  for (const row of upcoming) {
    const venueId = (row.venue || '').trim().toLowerCase();
    const bucket = stats[venueId] || stats['_other'];

    bucket.total++;
    const evDate = new Date(row.date);
    const daysAhead = Math.floor((evDate.getTime() - now) / (24 * 3600 * 1000));
    if (daysAhead <= 30) bucket.next_30d++;
    else if (daysAhead <= 60) bucket.next_60d++;
    else if (daysAhead <= 90) bucket.next_90d++;
    else bucket.beyond_90d++;

    if (!bucket.first_date || row.date < bucket.first_date) bucket.first_date = row.date;
    if (!bucket.latest_date || row.date > bucket.latest_date) bucket.latest_date = row.date;
  }

  const alerts = [];
  for (const venue of MONITORED_VENUES) {
    const s = stats[venue.id];
    if (s.total === 0) {
      alerts.push({ level: 'critical', venue: venue.id, venue_name: venue.name, url: venue.url, message: 'Aucun event à venir dans le Sheet' });
    } else if (s.next_30d === 0 && s.next_60d === 0) {
      alerts.push({ level: 'warning', venue: venue.id, venue_name: venue.name, url: venue.url, message: 'Aucun event dans les 60 prochains jours' });
    } else if (s.next_30d === 0) {
      alerts.push({ level: 'info', venue: venue.id, venue_name: venue.name, url: venue.url, message: 'Aucun event dans les 30 prochains jours' });
    }
  }

  const totalUpcoming = upcoming.length;
  const upcomingNext30 = upcoming.filter(r => {
    const d = new Date(r.date);
    return (d.getTime() - now) <= 30 * 24 * 3600 * 1000;
  }).length;

  return {
    ok: true,
    timestamp: now,
    timestamp_iso: new Date(now).toISOString(),
    sheet_total_rows: rows.length,
    upcoming_total: totalUpcoming,
    upcoming_next_30d: upcomingNext30,
    venues: stats,
    alerts: alerts,
    alert_levels: {
      critical: alerts.filter(a => a.level === 'critical').length,
      warning: alerts.filter(a => a.level === 'warning').length,
      info: alerts.filter(a => a.level === 'info').length
    }
  };
}

export async function sendFreshnessRecapEmail(analysis, env) {
  let apiKey = null;
  let adminEmail = null;
  try {
    apiKey = (typeof RESEND_API_KEY !== 'undefined') ? RESEND_API_KEY : null;
    adminEmail = (typeof ADMIN_EMAIL !== 'undefined') ? ADMIN_EMAIL : null;
  } catch (e) {
    apiKey = null;
    adminEmail = null;
  }

  if (!apiKey) {
    return { ok: false, reason: 'missing_resend_key', message: 'RESEND_API_KEY not configured. Run: npx wrangler secret put RESEND_API_KEY' };
  }
  if (!adminEmail) {
    return { ok: false, reason: 'missing_admin_email', message: 'ADMIN_EMAIL not configured. Run: npx wrangler secret put ADMIN_EMAIL' };
  }

  if (!analysis || !analysis.ok) {
    return { ok: false, reason: 'no_analysis', message: 'analyzeEventsFreshness failed: ' + (analysis ? analysis.error : 'unknown') };
  }

  // Fetch nouveaux events Ticketmaster (silencieux si erreur)
  let tmDiff = null;
  try {
    tmDiff = await findNewTicketmasterEvents();
  } catch (e) {
    tmDiff = { ok: false, error: e.message };
  }

  const dateStr = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const status = analysis.alert_levels.critical > 0 ? '🔴 ALERTE'
               : analysis.alert_levels.warning > 0 ? '🟡 ATTENTION'
               : '✅ OK';
  const tmNew = (tmDiff && tmDiff.ok) ? tmDiff.new_count : 0;
  const tmSuffix = tmNew > 0 ? `, ${tmNew} new TM` : '';
  const subject = `[TaxiPulse] ${status} — ${analysis.upcoming_total} events, ${analysis.alerts.length} alertes${tmSuffix}`;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1f2937;background:#f9fafb;">
    <div style="background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <h1 style="color:#ea580c;margin-top:0;font-size:24px;">🚖 TaxiPulse — Récap hebdo</h1>
      <p style="color:#6b7280;font-size:14px;text-transform:capitalize;">${dateStr}</p>

      <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div><strong style="font-size:24px;color:#1f2937;">${analysis.upcoming_total}</strong><br><span style="color:#6b7280;font-size:13px;">events à venir</span></div>
          <div><strong style="font-size:24px;color:#16a34a;">${analysis.upcoming_next_30d}</strong><br><span style="color:#6b7280;font-size:13px;">dans les 30 jours</span></div>
          <div><strong style="font-size:24px;color:${analysis.alert_levels.critical > 0 ? '#dc2626' : analysis.alert_levels.warning > 0 ? '#d97706' : '#16a34a'};">${analysis.alerts.length}</strong><br><span style="color:#6b7280;font-size:13px;">alertes</span></div>
        </div>
      </div>`;

  if (analysis.alerts.length > 0) {
    html += `<h2 style="color:#dc2626;font-size:18px;margin-top:24px;">⚠️ Lieux à checker en priorité</h2>
      <p style="color:#6b7280;font-size:14px;">Clique sur les liens ci-dessous, scrolle leur page programmation, et ajoute les nouveaux events dans ton Google Sheet.</p>
      <ul style="list-style:none;padding:0;">`;
    for (const alert of analysis.alerts) {
      const color = alert.level === 'critical' ? '#dc2626' : alert.level === 'warning' ? '#d97706' : '#3b82f6';
      const icon = alert.level === 'critical' ? '🔴' : alert.level === 'warning' ? '🟡' : '🔵';
      html += `<li style="background:#fff;border-left:4px solid ${color};padding:12px 16px;margin-bottom:8px;border-radius:6px;">
        <div style="font-weight:600;">${icon} ${escapeHtml(alert.venue_name)}</div>
        <div style="color:#6b7280;font-size:13px;margin:4px 0;">${escapeHtml(alert.message)}</div>
        ${alert.url ? `<a href="${escapeHtml(alert.url)}" style="color:#ea580c;text-decoration:none;font-size:13px;">→ Ouvrir le site officiel</a>` : ''}
      </li>`;
    }
    html += '</ul>';
  }

  // Section Ticketmaster : nouveaux events a ajouter au Sheet
  if (tmDiff && tmDiff.ok && tmDiff.new_count > 0) {
    html += `<h2 style="color:#7c3aed;font-size:18px;margin-top:24px;">🎫 ${tmDiff.new_count} nouveau${tmDiff.new_count > 1 ? 'x' : ''} event${tmDiff.new_count > 1 ? 's' : ''} Ticketmaster a ajouter au Sheet</h2>
      <p style="color:#6b7280;font-size:14px;">Detectes via l'API Ticketmaster, pas encore dans ton Google Sheet. Verifie les heures sur le site officiel puis copie-colle dans ton Sheet.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead><tr style="background:#f3f4f6;text-align:left;">
          <th style="padding:8px;">Date</th>
          <th style="padding:8px;">Heure</th>
          <th style="padding:8px;">Venue</th>
          <th style="padding:8px;">Titre</th>
          <th style="padding:8px;">Source</th>
        </tr></thead><tbody>`;
    for (const ev of tmDiff.new_events) {
      html += `<tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:8px;">${escapeHtml(ev.date)}</td>
        <td style="padding:8px;">${escapeHtml(ev.heure_debut)} - ${escapeHtml(ev.heure_fin)}</td>
        <td style="padding:8px;"><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(ev.venue)}</code></td>
        <td style="padding:8px;font-weight:500;">${escapeHtml(ev.titre)}</td>
        <td style="padding:8px;"><a href="${escapeHtml(ev.url || '#')}" style="color:#7c3aed;font-size:12px;">→ TM</a></td>
      </tr>`;
    }
    html += '</tbody></table>';
    html += `<p style="color:#9ca3af;font-size:12px;margin-top:8px;font-style:italic;">⚠️ Heures marquees APPROX : Ticketmaster ne fournit pas toujours l'heure officielle. Verifie sur le site venue.</p>`;
  }

  html += `<h2 style="font-size:18px;margin-top:24px;">📊 État de fraîcheur par venue</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f3f4f6;text-align:left;">
        <th style="padding:8px;">Venue</th>
        <th style="padding:8px;text-align:center;">Total</th>
        <th style="padding:8px;text-align:center;">30j</th>
        <th style="padding:8px;text-align:center;">60j</th>
        <th style="padding:8px;text-align:center;">90j+</th>
      </tr></thead><tbody>`;

  for (const venue of MONITORED_VENUES) {
    const s = analysis.venues[venue.id];
    const status30 = s.next_30d === 0 ? '#dc2626' : s.next_30d < 3 ? '#d97706' : '#16a34a';
    html += `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px;"><a href="${escapeHtml(venue.url)}" style="color:#ea580c;text-decoration:none;">${escapeHtml(venue.name)}</a></td>
      <td style="padding:8px;text-align:center;">${s.total}</td>
      <td style="padding:8px;text-align:center;color:${status30};font-weight:${s.next_30d === 0 ? '600' : '400'};">${s.next_30d}</td>
      <td style="padding:8px;text-align:center;">${s.next_60d}</td>
      <td style="padding:8px;text-align:center;">${s.next_90d + s.beyond_90d}</td>
    </tr>`;
  }
  html += '</tbody></table>';

  html += `<hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;">
    <p style="color:#6b7280;font-size:12px;line-height:1.5;">
      Email auto envoyé chaque lundi par le worker Cloudflare TaxiPulse.<br>
      Pour ajouter de nouveaux events, ouvre ton <a href="https://docs.google.com/spreadsheets/d/e/2PACX-1vTlb4vVopavpQHDKFkY4Su4HDtUo70FV7vEr7zllndq6-6duSSjDhkuBt9XP51PA3zn4nS9C8RFR8sb/pub?gid=0&single=true&output=csv" style="color:#ea580c;">Google Sheet</a>.<br>
      Pour désactiver ces emails : retire le cron dans wrangler.toml.
    </p>
    </div></body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'TaxiPulse <onboarding@resend.dev>',
        to: [adminEmail],
        subject: subject,
        html: html
      })
    });
    const respText = await r.text();
    let data = null;
    try { data = JSON.parse(respText); } catch (e) { data = { raw: respText }; }
    return {
      ok: r.ok,
      status: r.status,
      response: data,
      sent_to: adminEmail.replace(/(.{2}).+(@.+)/, '$1***$2'),
      subject: subject
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


// ─── Handler HTTP : /events/health, /events/checklist, /events/test-email, /events/run-recap ───
export async function handleEventsHealth(path, request, env) {
  if (path === '/events/health' || path === '/events/checklist') {
    const result = await analyzeEventsFreshness(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/events/test-email' && request.method === 'POST') {
    const result = await analyzeEventsFreshness(env);
    const r = await sendFreshnessRecapEmail(result, env);
    return new Response(JSON.stringify(r, null, 2), {
      status: r.ok ? 200 : 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  if (path === '/events/run-recap' && request.method === 'POST') {
    const result = await analyzeEventsFreshness(env);
    const emailResult = await sendFreshnessRecapEmail(result, env);
    return new Response(JSON.stringify({ analysis: result, email: emailResult }, null, 2), {
      status: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }

  return null; // pas de match
}
