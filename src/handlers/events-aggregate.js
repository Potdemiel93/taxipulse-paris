// =============================================================================
// TaxiPulse — Handler Events Aggregate (wrapper vers la V2)
// L'ancien code QFAP (worker.js:1425-1815, 390 lignes) est remplacé par
// l'appel direct à la V2 du fichier events-aggregator.js à la racine.
// =============================================================================

import { handleAggregate } from '../../events-aggregator.js';
import { CORS_HEADERS } from '../lib/constants.js';

export async function handleEventsAggregate(request, env) {
  try {
    // handleAggregate de la V2 retourne déjà une Response complète
    return await handleAggregate(request, env);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }, null, 2), {
      status: 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
  }
}
