// =============================================================================
// TaxiPulse — Events Aggregator (multi-source)
// À coller dans worker.js — cron quotidien 06:00 Paris
// 3 sources gratuites sans clé : QFAP, OpenAgenda IDF, OpenAgenda France
// =============================================================================

// ---------- 1. MAPPING VENUES ----------
// Permet de matcher les noms longs des APIs vers les codes venues du master CSV
const VENUE_MAPPING = {
  // Sport
  "stade jean bouin": "jean_bouin",
  "stade jean-bouin": "jean_bouin",
  "jean bouin": "jean_bouin",
  "stade charlety": "charlety",
  "stade charléty": "charlety",
  "parc des princes": "parc_princes",
  "stade de france": "stade_france",
  "roland-garros": "roland_garros",
  "roland garros": "roland_garros",
  "hippodrome de vincennes": "vincennes",
  "hippodrome paris-longchamp": "longchamp",
  "hippodrome d'auteuil": "auteuil",
  // Concerts
  "le bataclan": "bataclan",
  "bataclan": "bataclan",
  "olympia": "olympia",
  "l'olympia": "olympia",
  "zenith de paris": "zenith",
  "zénith de paris": "zenith",
  "le zénith": "zenith",
  "accor arena": "bercy_arena",
  "accor arena bercy": "bercy_arena",
  "bercy arena": "bercy_arena",
  "adidas arena": "adidas_arena",
  "paris la défense arena": "defense_arena",
  "la défense arena": "defense_arena",
  "la seine musicale": "seine_musicale",
  "salle pleyel": "salle_pleyel",
  "philharmonie de paris": "philharmonie",
  "le trianon": "trianon",
  "la cigale": "cigale",
  "le cabaret sauvage": "cabaret_sauvage",
  "le bataclan": "bataclan",
  "le grand rex": "grand_rex",
  // Théâtres / Opéras
  "opéra bastille": "opera_bastille",
  "opera bastille": "opera_bastille",
  "opéra garnier": "opera_garnier",
  "palais garnier": "opera_garnier",
  "comédie-française": "comedie_francaise",
  "théâtre du châtelet": "chatelet",
  "théâtre des champs-élysées": "champs_elysees",
  "théâtre mogador": "mogador",
  "théâtre marigny": "marigny",
  // Salons / Expos
  "grand palais": "grand_palais",
  "petit palais": "petit_palais",
  "paris expo porte de versailles": "porte_versailles",
  "porte de versailles": "porte_versailles",
  "parc des expositions de villepinte": "villepinte",
  "paris-le bourget": "le_bourget",
  // Plein air
  "hippodrome de paris-longchamp": "longchamp",
  "domaine national de saint-cloud": "saint_cloud",
  "bois de boulogne": "boulogne",
  "bois de vincennes": "vincennes_bois",
};

// Détection libre (fallback si pas dans mapping strict)
function detectVenue(rawVenue) {
  if (!rawVenue) return null;
  const v = rawVenue.toLowerCase().trim();
  // 1. Match exact
  if (VENUE_MAPPING[v]) return VENUE_MAPPING[v];
  // 2. Match partiel (le nom long contient un nom court)
  for (const [key, value] of Object.entries(VENUE_MAPPING)) {
    if (v.includes(key)) return value;
  }
  return null; // venue inconnue → on ignore
}

// ---------- 2. CATÉGORIES ----------
function detectCategory(title, venue, rawTags = []) {
  const t = (title || "").toLowerCase();
  const tags = rawTags.map(x => (x || "").toLowerCase()).join(" ");
  const all = `${t} ${tags} ${venue || ""}`;
  
  if (/match|ligue 1|ligue 2|champion|coupe|psg|paris fc|stade français|top 14|rugby|hand|basket/.test(all)) return "sport";
  if (/concert|tour|tournée|live|festival/.test(all)) return "concert";
  if (/expo|exposition|vernissage|musée/.test(all)) return "exposition";
  if (/salon|foire|congrès/.test(all)) return "salon";
  if (/théâtre|opéra|ballet|danse|comédie/.test(all)) return "theatre";
  if (/course|hippodrome|prix|trot|galop/.test(all)) return "course";
  if (/conférence|colloque|talk/.test(all)) return "conference";
  return "autre";
}

// ---------- 3. FETCHERS PAR SOURCE ----------

// Source A — Que Faire à Paris (Mairie de Paris)
// Doc: https://opendata.paris.fr/explore/dataset/que-faire-a-paris-/api/
async function fetchQueFaireAParis(daysAhead = 60) {
  const today = new Date().toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];
  
  // Pagination max 5 pages = 500 events
  for (let page = 0; page < 5; page++) {
    const url = `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?limit=${limit}&offset=${offset}&where=date_start%20%3E%3D%20%22${today}%22&order_by=date_start%20ASC`;
    
    try {
      const r = await fetch(url, { 
        headers: { "User-Agent": "TaxiPulse/1.0" },
        cf: { cacheTtl: 1800 } // cache 30 min CF
      });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results || data.results.length === 0) break;
      
      for (const e of data.results) {
        const venue = detectVenue(e.address_name);
        if (!venue) continue; // on ignore les venues non trackées
        
        const dateStart = (e.date_start || "").split("T")[0];
        const dateEnd = (e.date_end || "").split("T")[0];
        const timeStart = (e.date_start || "").split("T")[1]?.slice(0, 5) || "20:00";
        const timeEnd = (e.date_end || "").split("T")[1]?.slice(0, 5) || "";
        
        all.push({
          source: "qfap",
          source_id: e.id,
          source_url: e.url,
          date: dateStart,
          date_end: dateEnd,
          heure_debut: timeStart,
          heure_fin: timeEnd,
          venue: venue,
          venue_raw: e.address_name,
          titre: (e.title || "").trim().slice(0, 120),
          cat: detectCategory(e.title, venue, e.tags || []),
          confirme: "OUI",
          notes: `QFAP officiel`,
        });
      }
      
      if (data.results.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error("QFAP fetch error:", err.message);
      break;
    }
  }
  
  return all;
}

// Source B — OpenAgenda Île-de-France
// Doc: https://data.iledefrance.fr/explore/dataset/evenements-publics-cibul/api/
async function fetchOpenAgendaIDF(daysAhead = 60) {
  const today = new Date().toISOString().split("T")[0];
  const future = new Date(Date.now() + daysAhead * 86400000).toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];
  
  for (let page = 0; page < 5; page++) {
    const url = `https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets/evenements-publics-cibul/records?limit=${limit}&offset=${offset}&where=firstdate_begin%20%3E%3D%20%22${today}%22%20AND%20firstdate_begin%20%3C%3D%20%22${future}%22&order_by=firstdate_begin%20ASC`;
    
    try {
      const r = await fetch(url, { 
        headers: { "User-Agent": "TaxiPulse/1.0" },
        cf: { cacheTtl: 1800 }
      });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results || data.results.length === 0) break;
      
      for (const e of data.results) {
        const venue = detectVenue(e.placename || e.location_name);
        if (!venue) continue;
        
        const dateStart = (e.firstdate_begin || "").split("T")[0];
        const dateEnd = (e.lastdate_end || "").split("T")[0];
        const timeStart = (e.firstdate_begin || "").split("T")[1]?.slice(0, 5) || "20:00";
        const timeEnd = (e.lastdate_end || "").split("T")[1]?.slice(0, 5) || "";
        
        all.push({
          source: "openagenda_idf",
          source_id: e.uid,
          source_url: e.canonicalurl,
          date: dateStart,
          date_end: dateEnd,
          heure_debut: timeStart,
          heure_fin: timeEnd,
          venue: venue,
          venue_raw: e.placename || e.location_name,
          titre: (e.title_fr || e.title || "").trim().slice(0, 120),
          cat: detectCategory(e.title_fr || e.title, venue, e.keywords_fr || []),
          confirme: "OUI",
          notes: `OpenAgenda IDF`,
        });
      }
      
      if (data.results.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error("OpenAgenda IDF fetch error:", err.message);
      break;
    }
  }
  
  return all;
}

// Source C — OpenAgenda France entier (filtré Paris/IDF)
async function fetchOpenAgendaFrance(daysAhead = 60) {
  const today = new Date().toISOString().split("T")[0];
  const future = new Date(Date.now() + daysAhead * 86400000).toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];
  
  for (let page = 0; page < 3; page++) {
    // filtre département 75 + 92/93/94 (petite couronne)
    const url = `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/records?limit=${limit}&offset=${offset}&where=firstdate_begin%20%3E%3D%20%22${today}%22%20AND%20firstdate_begin%20%3C%3D%20%22${future}%22%20AND%20(department%3D%22Paris%22%20OR%20department%3D%22Hauts-de-Seine%22%20OR%20department%3D%22Seine-Saint-Denis%22%20OR%20department%3D%22Val-de-Marne%22)&order_by=firstdate_begin%20ASC`;
    
    try {
      const r = await fetch(url, { 
        headers: { "User-Agent": "TaxiPulse/1.0" },
        cf: { cacheTtl: 1800 }
      });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results || data.results.length === 0) break;
      
      for (const e of data.results) {
        const venue = detectVenue(e.placename || e.location_name);
        if (!venue) continue;
        
        const dateStart = (e.firstdate_begin || "").split("T")[0];
        const dateEnd = (e.lastdate_end || "").split("T")[0];
        const timeStart = (e.firstdate_begin || "").split("T")[1]?.slice(0, 5) || "20:00";
        const timeEnd = (e.lastdate_end || "").split("T")[1]?.slice(0, 5) || "";
        
        all.push({
          source: "openagenda_fr",
          source_id: e.uid,
          source_url: e.canonicalurl,
          date: dateStart,
          date_end: dateEnd,
          heure_debut: timeStart,
          heure_fin: timeEnd,
          venue: venue,
          venue_raw: e.placename || e.location_name,
          titre: (e.title_fr || e.title || "").trim().slice(0, 120),
          cat: detectCategory(e.title_fr || e.title, venue, e.keywords_fr || []),
          confirme: "OUI",
          notes: `OpenAgenda FR`,
        });
      }
      
      if (data.results.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error("OpenAgenda FR fetch error:", err.message);
      break;
    }
  }
  
  return all;
}

// ---------- 4. CROSS-VALIDATION ----------
// Fusionne events de plusieurs sources, dédoublonne, calcule un score de confiance
function crossValidate(allEvents) {
  // Clé de fusion : date + venue + 5 premiers caractères du titre
  const buckets = new Map();
  
  for (const e of allEvents) {
    const key = `${e.date}|${e.venue}|${(e.titre || "").toLowerCase().slice(0, 10).replace(/\s/g, "")}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(e);
  }
  
  const merged = [];
  for (const [key, evs] of buckets) {
    if (evs.length === 0) continue;
    
    const primary = evs[0];
    const sources = [...new Set(evs.map(e => e.source))];
    const sourceCount = sources.length;
    
    // Score confiance : 1 source = APPROX, 2+ sources = OUI confirmé
    primary.confirme = sourceCount >= 2 ? "OUI" : "APPROX";
    primary.sources_count = sourceCount;
    primary.sources_list = sources.join(",");
    primary.notes = `${sourceCount} source(s) : ${sources.join("+")}`;
    
    merged.push(primary);
  }
  
  return merged;
}

// ---------- 5. COMPARAISON AVEC MASTER ----------
async function compareWithMaster(newEvents, env) {
  // Récupère le master actuel depuis KV (clé "events_master_csv")
  const masterRaw = await env.TAXI_KV.get("events_master_csv");
  if (!masterRaw) return { news: newEvents, changes: [], removed: [] };
  
  const lines = masterRaw.split("\n").slice(1); // skip header
  const masterKeys = new Set();
  const masterByKey = new Map();
  
  for (const line of lines) {
    const [date, h_deb, , venue, titre] = line.split(",");
    if (!date || !venue) continue;
    const key = `${date}|${venue}|${(titre || "").toLowerCase().slice(0, 10).replace(/\s/g, "")}`;
    masterKeys.add(key);
    masterByKey.set(key, { date, h_deb, venue, titre });
  }
  
  const news = [];
  const changes = [];
  
  for (const e of newEvents) {
    const key = `${e.date}|${e.venue}|${(e.titre || "").toLowerCase().slice(0, 10).replace(/\s/g, "")}`;
    if (!masterKeys.has(key)) {
      news.push(e);
    } else {
      const old = masterByKey.get(key);
      if (old.h_deb !== e.heure_debut && e.heure_debut !== "20:00") {
        changes.push({ event: e, old_time: old.h_deb, new_time: e.heure_debut });
      }
    }
  }
  
  return { news, changes };
}

// ---------- 6. ENVOI EMAIL RÉCAP ----------
async function sendDailyRecap(diff, env) {
  const { news, changes } = diff;
  
  if (news.length === 0 && changes.length === 0) {
    return { sent: false, reason: "rien à signaler" };
  }
  
  const html = `
    <h2>📋 TaxiPulse — Récap quotidien des events</h2>
    <p>Détection auto à ${new Date().toISOString().slice(0, 16)} UTC</p>
    
    <h3>🆕 ${news.length} nouveaux events détectés</h3>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">
      <tr style="background:#eee;"><th>Date</th><th>Heure</th><th>Venue</th><th>Titre</th><th>Conf</th><th>Sources</th></tr>
      ${news.slice(0, 50).map(e => `
        <tr style="border-top:1px solid #ddd;">
          <td>${e.date}</td>
          <td>${e.heure_debut}</td>
          <td>${e.venue}</td>
          <td>${e.titre}</td>
          <td>${e.confirme}</td>
          <td>${e.sources_count}</td>
        </tr>`).join("")}
    </table>
    
    ${changes.length > 0 ? `
    <h3>⚠️ ${changes.length} changements d'horaires détectés</h3>
    <ul>
      ${changes.map(c => `
        <li><b>${c.event.date} ${c.event.venue}</b> : ${c.old_time} → ${c.new_time} (${c.event.titre})</li>
      `).join("")}
    </ul>` : ""}
    
    <hr>
    <p style="font-size:11px;color:#666;">Action recommandée : valider/intégrer les events dans le master Sheet via le dashboard admin.</p>
  `;
  
  if (env.RESEND_API_KEY && env.ADMIN_EMAIL) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "TaxiPulse <noreply@taxipulse.fr>",
          to: env.ADMIN_EMAIL,
          subject: `📋 TaxiPulse récap : ${news.length} new + ${changes.length} changements`,
          html: html,
        }),
      });
      return { sent: true, count: news.length + changes.length };
    } catch (err) {
      return { sent: false, error: err.message };
    }
  }
  
  return { sent: false, reason: "config manquante" };
}

// ---------- 7. ENDPOINT PRINCIPAL ----------
// À ajouter dans le router du worker : /events/aggregate
async function handleAggregate(request, env) {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  
  // Fetch parallèle des 3 sources
  const [qfap, oaIDF, oaFR] = await Promise.allSettled([
    fetchQueFaireAParis(60),
    fetchOpenAgendaIDF(60),
    fetchOpenAgendaFrance(60),
  ]);
  
  const all = [
    ...(qfap.status === "fulfilled" ? qfap.value : []),
    ...(oaIDF.status === "fulfilled" ? oaIDF.value : []),
    ...(oaFR.status === "fulfilled" ? oaFR.value : []),
  ];
  
  const validated = crossValidate(all);
  const diff = await compareWithMaster(validated, env);
  
  // Stocke le résultat dans KV pour dashboard admin
  await env.TAXI_KV.put(
    "events_aggregator_last_run",
    JSON.stringify({
      ts: Date.now(),
      total_fetched: all.length,
      after_dedup: validated.length,
      news: diff.news.length,
      changes: diff.changes.length,
      sources: {
        qfap: qfap.status === "fulfilled" ? qfap.value.length : 0,
        openagenda_idf: oaIDF.status === "fulfilled" ? oaIDF.value.length : 0,
        openagenda_fr: oaFR.status === "fulfilled" ? oaFR.value.length : 0,
      },
    })
  );
  
  if (!dryRun) {
    await sendDailyRecap(diff, env);
  }
  
  return new Response(
    JSON.stringify({
      ok: true,
      total: all.length,
      validated: validated.length,
      news: diff.news.length,
      changes: diff.changes.length,
      preview_news: diff.news.slice(0, 10),
      sources: {
        qfap: qfap.status === "fulfilled" ? qfap.value.length : `error: ${qfap.reason?.message}`,
        openagenda_idf: oaIDF.status === "fulfilled" ? oaIDF.value.length : `error: ${oaIDF.reason?.message}`,
        openagenda_fr: oaFR.status === "fulfilled" ? oaFR.value.length : `error: ${oaFR.reason?.message}`,
      },
    }, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
}

// ---------- 8. CRON SCHEDULER ----------
// À ajouter dans wrangler.toml :
// [triggers]
// crons = ["0 5 * * *"]  # 6h Paris UTC+1 (5h UTC en hiver)
async function scheduledAggregate(event, env, ctx) {
  ctx.waitUntil(handleAggregate(new Request("https://x/events/aggregate"), env));
}

// Export pour utilisation dans worker.js
export { 
  handleAggregate, 
  scheduledAggregate, 
  fetchQueFaireAParis, 
  fetchOpenAgendaIDF, 
  fetchOpenAgendaFrance,
  crossValidate,
  detectVenue,
  detectCategory,
  VENUE_MAPPING 
};
