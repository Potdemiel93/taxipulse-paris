// =============================================================================
// TaxiPulse — Handler Scheduled (crons quotidien + hebdo)
// Extrait de worker.js (lignes 2191-2218)
// Converti pour utiliser env (les anciennes versions passaient null = bug silencieux)
// =============================================================================

import { handleAggregate } from '../events-aggregator.js';
import { analyzeEventsFreshness, sendFreshnessRecapEmail } from './handlers/events-health.js';
import { syncSheet } from './handlers/sheet-sync.js';

export async function handleScheduled(event, env) {
  const cron = event && event.cron ? event.cron : '';
  console.log('[CRON] Triggered:', cron);

  // Cron quotidien (0 5 * * *) -> aggregator V2 (QFAP + OpenAgenda IDF + OpenAgenda FR)
  if (cron === '0 5 * * *') {
    console.log('[CRON daily] Aggregator V2...');
    try {
      // On appelle handleAggregate avec une "fake request" en GET sans dry-run
      const fakeReq = new Request('https://x/events/aggregate');
      const response = await handleAggregate(fakeReq, env);
      const result = await response.json();
      console.log('[CRON daily] Aggregator result:', JSON.stringify(result).substring(0, 400));
      return { type: 'aggregator', result: result };
    } catch (err) {
      console.error('[CRON daily] Error:', err.message);
      return { type: 'aggregator', error: err.message };
    }
  }

  // Cron horaire (0 * * * *) -> sync Sheet → store KV V2 (S5)
  if (cron === '0 * * * *') {
    console.log('[CRON hourly] Sheet sync...');
    try {
      const result = await syncSheet(env);
      console.log('[CRON hourly] Sheet sync result:', JSON.stringify(result).substring(0, 400));
      return { type: 'sheet_sync', result: result };
    } catch (err) {
      console.error('[CRON hourly] Error:', err.message);
      return { type: 'sheet_sync', error: err.message };
    }
  }

  // Cron hebdo (lundi 0 6 * * 1) -> récap fraîcheur Sheet
  console.log('[CRON weekly] Récap hebdo : analyse Sheet...');
  const analysis = await analyzeEventsFreshness(env);
  console.log('[CRON weekly] Analyse :', JSON.stringify(analysis).substring(0, 500));

  const emailResult = await sendFreshnessRecapEmail(analysis, env);
  console.log('[CRON weekly] Email :', JSON.stringify(emailResult).substring(0, 300));

  return { type: 'weekly', analysis: analysis, emailResult: emailResult };
}
