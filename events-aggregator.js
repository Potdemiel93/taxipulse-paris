// =============================================================================
// TaxiPulse — Events Aggregator V2 (multi-source + fake-detector + duration engine)
//
// CHANGEMENTS V2 vs V1 :
//   1. FAKE DETECTOR : rejet auto "Concert rock", "Spectacle humour", "Concert TBA"
//   2. NORMALISATION TITRE : suppression J1/J2, accents, tour, etc. avant dedup
//   3. HIÉRARCHIE SOURCES : canonical > ticketing > aggregator
//   4. MOTEUR HEURE_FIN : calcul intelligent basé sur (venue, catégorie, modifiers)
//   5. AUDIT DES REJETS : log des fakes dans KV
//
// 3 sources gratuites : QFAP, OpenAgenda IDF, OpenAgenda France
// =============================================================================

const VENUE_MAPPING = {
  "stade jean bouin": "jean_bouin", "stade jean-bouin": "jean_bouin", "jean bouin": "jean_bouin",
  "stade charlety": "charlety", "stade charléty": "charlety", "parc des princes": "parc_princes",
  "stade de france": "stade_france", "roland-garros": "roland_garros", "roland garros": "roland_garros",
  "hippodrome de vincennes": "vincennes", "hippodrome paris-longchamp": "longchamp", "hippodrome d'auteuil": "auteuil",
  "le bataclan": "bataclan", "bataclan": "bataclan", "olympia": "olympia", "l'olympia": "olympia",
  "zenith de paris": "zenith", "zénith de paris": "zenith", "le zénith": "zenith",
  "accor arena": "bercy_arena", "accor arena bercy": "bercy_arena", "bercy arena": "bercy_arena",
  "adidas arena": "adidas_arena", "paris la défense arena": "defense_arena", "la défense arena": "defense_arena",
  "la seine musicale": "seine_musicale", "salle pleyel": "salle_pleyel", "philharmonie de paris": "philharmonie",
  "le trianon": "trianon", "la cigale": "cigale", "le cabaret sauvage": "cabaret_sauvage", "le grand rex": "grand_rex",
  "opéra bastille": "opera_bastille", "opera bastille": "opera_bastille", "opéra garnier": "opera_garnier",
  "palais garnier": "opera_garnier", "comédie-française": "comedie_francaise", "théâtre du châtelet": "chatelet",
  "théâtre des champs-élysées": "champs_elysees", "théâtre mogador": "mogador", "théâtre marigny": "marigny",
  "grand palais": "grand_palais", "petit palais": "petit_palais", "paris expo porte de versailles": "porte_versailles",
  "porte de versailles": "porte_versailles", "parc des expositions de villepinte": "villepinte", "paris-le bourget": "le_bourget",
  "domaine national de saint-cloud": "saint_cloud", "bois de boulogne": "boulogne", "bois de vincennes": "vincennes_bois",
};

function detectVenue(rawVenue) {
  if (!rawVenue) return null;
  const v = rawVenue.toLowerCase().trim();
  if (VENUE_MAPPING[v]) return VENUE_MAPPING[v];
  for (const [key, value] of Object.entries(VENUE_MAPPING)) {
    if (v.includes(key)) return value;
  }
  return null;
}

function detectCategory(title, venue, rawTags = []) {
  const t = (title || "").toLowerCase();
  const tags = rawTags.map(x => (x || "").toLowerCase()).join(" ");
  const all = `${t} ${tags} ${venue || ""}`;
  if (/match|ligue 1|ligue 2|champion|coupe|psg|paris fc|top 14|rugby/.test(all)) {
    if (/rugby|top 14|six nations/.test(all)) return "sport_rugby";
    if (/foot|ligue|coupe.*france|psg|paris fc/.test(all)) return "sport_foot";
    return "sport";
  }
  if (/basket|nba|jeep elite|euroleague/.test(all)) return "sport_basket";
  if (/hand(ball)?|ehf/.test(all)) return "sport_hand";
  if (/tennis|roland|atp|wta/.test(all)) return "sport_tennis";
  if (/concert.*metal|metal.*concert|hardcore|punk/.test(all)) return "concert_metal";
  if (/symphoni|orchestre|philharmoni|opéra|opera|ballet/.test(all)) return "concert_classique";
  if (/concert|tour|tournée|live|festival/.test(all)) return "concert";
  if (/expo|exposition|vernissage|musée/.test(all)) return "exposition";
  if (/salon|foire|congrès/.test(all)) return "salon";
  if (/spectacle.*humour|one.man|stand.up/.test(all)) return "spectacle_humour";
  if (/théâtre|comédie/.test(all)) return "theatre";
  if (/danse|ballet/.test(all)) return "danse";
  if (/course|hippodrome|prix|trot|galop/.test(all)) return "course";
  if (/conférence|colloque|talk/.test(all)) return "conference";
  return "autre";
}

const FAKE_CONCERT_RE = /^Concert\s*(rock|rap|pop|metal|[ée]lectro|oriental|jazz|classique|jeux\s*vid[ée]o|hip\s*hop|r&b|reggae|punk|funk|soul|blues|country|folk|world|musiques?\s*du\s*monde)?\s*$/i;
const FAKE_SPECTACLE_RE = /^Spectacle\s*(humour|danse|musical|com[ée]die|th[ée][aâ]tre|jeunesse|enfants?|familial)?\s*$/i;
const TBA_RE = /\b(TBA|TBD|[ÀA]\s*confirmer|[àa]\s*venir|date\s*[àa]\s*confirmer|coming\s*soon|prochainement)\b/i;
const FILLER_RE = /^(N\/A|n\.a\.|null|undefined|test|TEST|xxx|XXX|tbd|TBD|\?+|-+|\.+)$/i;

function isFakeEvent(title, venueId) {
  const t = (title || "").trim();
  if (!t) return { fake: true, reason: "title_empty" };
  if (t.length < 4) return { fake: true, reason: "title_too_short" };
  if (FILLER_RE.test(t)) return { fake: true, reason: "fake_filler" };
  if (FAKE_CONCERT_RE.test(t)) return { fake: true, reason: "fake_generic_concert" };
  if (FAKE_SPECTACLE_RE.test(t)) return { fake: true, reason: "fake_generic_spectacle" };
  if (TBA_RE.test(t)) return { fake: true, reason: "fake_tba" };
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  if (norm(t) === norm(venueId)) return { fake: true, reason: "fake_title_eq_venue" };
  return { fake: false };
}

function normalizeTitle(title) {
  if (!title) return "";
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\bj[oô]ur(?:n[ée]e)?\s*\d+\b/g, "").replace(/\bj\d+\b/g, "")
    .replace(/\b(tour|tourn[ée]e|the\s*tour|world\s*tour|live\s*tour)\b/g, "")
    .replace(/\b\d{4}\b/g, "").replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, "")
    .replace(/[^a-z0-9]/g, "").trim();
}

function eventKey(date, venue, title) {
  return `${date}|${venue}|${normalizeTitle(title)}`;
}

const SOURCE_LEVELS = {
  "qfap": { level: "canonical", score: 100 }, "ticketmaster": { level: "ticketing", score: 70 },
  "openagenda_idf": { level: "ticketing", score: 60 }, "openagenda_fr": { level: "aggregator", score: 40 },
  "accorarena.com": { level: "canonical", score: 100 }, "parisladefense-arena.com": { level: "canonical", score: 100 },
  "stadefrance.com": { level: "canonical", score: 100 }, "rolandgarros.com": { level: "canonical", score: 100 },
  "le-zenith.com": { level: "canonical", score: 100 }, "zenith-paris.com": { level: "canonical", score: 100 },
  "olympiahall.com": { level: "canonical", score: 100 }, "bataclan.fr": { level: "canonical", score: 90 },
  "adidasarena.com": { level: "canonical", score: 100 }, "laseinemusicale.com": { level: "canonical", score: 100 },
  "sallepleyel.com": { level: "canonical", score: 100 }, "philharmoniedeparis.fr": { level: "canonical", score: 100 },
  "letrianon.fr": { level: "canonical", score: 100 }, "lacigale.fr": { level: "canonical", score: 100 },
  "operadeparis.fr": { level: "canonical", score: 100 }, "grandpalais.fr": { level: "canonical", score: 100 },
  "viparis.com": { level: "canonical", score: 100 }, "psg.fr": { level: "canonical", score: 100 },
  "fondationlouisvuitton.fr": { level: "canonical", score: 100 }, "fnacspectacles.com": { level: "ticketing", score: 70 },
  "ticketmaster.fr": { level: "ticketing", score: 70 }, "yoolabox.com": { level: "ticketing", score: 65 },
  "sortiraparis.com": { level: "aggregator", score: 30 }, "offi.fr": { level: "aggregator", score: 30 },
  "songkick.com": { level: "aggregator", score: 30 }, "tourisme93.com": { level: "aggregator", score: 30 },
  "parisbouge.com": { level: "aggregator", score: 30 }, "jds.fr": { level: "aggregator", score: 30 },
  "agendaculturel.fr": { level: "aggregator", score: 30 }, "infoconcert.com": { level: "ticketing", score: 50 },
  "otbb.org": { level: "aggregator", score: 30 }, "cci-paris-idf.fr": { level: "canonical", score: 80 },
  "louvre.fr": { level: "canonical", score: 100 }, "mam.paris.fr": { level: "canonical", score: 100 },
  "paris.fr": { level: "canonical", score: 100 }, "france-galop.com": { level: "canonical", score: 100 },
  "vincennes-hippodrome.com": { level: "canonical", score: 100 }, "solidays.org": { level: "canonical", score: 100 },
  "rockenseine.com": { level: "canonical", score: 100 }, "welovegreen.fr": { level: "canonical", score: 100 },
};

function getSourceInfo(source) {
  if (!source) return { level: "aggregator", score: 20 };
  const s = source.toLowerCase().trim();
  return SOURCE_LEVELS[s] || { level: "aggregator", score: 20 };
}

const DURATION_RULES = {
  "bercy_arena": { concert: 195, concert_classique: 150, concert_metal: 210, sport_basket: 165, sport_hand: 135, spectacle_humour: 135, spectacle_jeunesse: 120, default: 195 },
  "stade_france": { concert: 225, sport_foot: 180, sport_rugby: 180, default: 210 },
  "defense_arena": { concert: 210, sport_rugby: 165, sport_foot: 165, default: 195 },
  "parc_princes": { sport_foot: 165, sport_rugby: 165, default: 165 },
  "zenith": { concert: 180, concert_classique: 135, concert_metal: 210, spectacle_humour: 135, default: 180 },
  "adidas_arena": { concert: 180, sport_basket: 150, sport_hand: 135, default: 165 },
  "seine_musicale": { concert: 165, concert_classique: 135, default: 150 },
  "olympia": { concert: 165, spectacle_humour: 135, default: 150 },
  "bataclan": { concert: 165, concert_metal: 195, spectacle_humour: 135, default: 150 },
  "trianon": { concert: 150, default: 135 },
  "cigale": { concert: 150, default: 135 },
  "salle_pleyel": { concert_classique: 135, concert: 150, default: 135 },
  "philharmonie": { concert_classique: 135, concert: 135, default: 135 },
  "opera_bastille": { default: 195, danse: 165 },
  "opera_garnier": { default: 195, danse: 165 },
  "chatelet": { default: 165 },
  "mogador": { default: 165 },
  "marigny": { default: 150 },
  "comedie_francaise": { default: 165 },
  "champs_elysees": { default: 150 },
  "roland_garros": { sport_tennis: 240, default: 240 },
  "jean_bouin": { sport_rugby: 165, default: 150 },
  "charlety": { default: 150 },
  "grand_palais": { exposition: null, default: null },
  "porte_versailles": { salon: null, default: null },
  "villepinte": { salon: null, default: null },
  "le_bourget": { salon: null, default: null },
  "fondation_lv": { exposition: null, default: null },
};

const VENUE_CLOSING_TIMES = {
  "grand_palais": "20:00", "petit_palais": "18:00", "porte_versailles": "19:00",
  "villepinte": "19:00", "le_bourget": "19:00", "fondation_lv": "20:00",
};

function applyDurationModifiers(durationMin, title, dateStr, category) {
  let mod = 0;
  const t = (title || "").toLowerCase();
  if (/\+|feat\.?|featuring|avec|first part|1ère partie/.test(t)) mod += 30;
  if (/\b(50|40|30|25|20|15|10)\s*ans\b|anniversaire|jubil[ée]|farewell|adieu/.test(t)) mod += 30;
  if (/festival|nuit\s*de|nuit\s*des/.test(t)) mod += 60;
  if (dateStr) {
    const day = new Date(dateStr).getUTCDay();
    if (day === 5 || day === 6) mod += 15;
  }
  if (dateStr) {
    const month = parseInt(dateStr.slice(5, 7), 10);
    if (month === 11 || month === 12 || month === 1 || month === 2) mod -= 10;
  }
  return durationMin + mod;
}

function addMinutesToTime(timeStr, addMin) {
  if (!timeStr || !/^\d{2}:\d{2}$/.test(timeStr)) return null;
  const [h, m] = timeStr.split(":").map(Number);
  const totalMin = h * 60 + m + addMin;
  const finalMin = ((totalMin % 1440) + 1440) % 1440;
  const hh = String(Math.floor(finalMin / 60)).padStart(2, "0");
  const mm = String(finalMin % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function calculateEndTime(venue, category, heureDebut, titre, date) {
  if (VENUE_CLOSING_TIMES[venue]) return VENUE_CLOSING_TIMES[venue];
  const rules = DURATION_RULES[venue];
  if (!rules) return addMinutesToTime(heureDebut, 150);
  let durationMin = rules[category] !== undefined ? rules[category] : rules.default;
  if (durationMin === null || durationMin === undefined) return addMinutesToTime(heureDebut, 150);
  durationMin = applyDurationModifiers(durationMin, titre, date, category);
  return addMinutesToTime(heureDebut, durationMin);
}

function buildEvent(raw, source, rejects) {
  const venue = detectVenue(raw.venueRaw);
  if (!venue) return null;
  const titre = (raw.titre || "").trim().slice(0, 120);
  const fake = isFakeEvent(titre, venue);
  if (fake.fake) {
    rejects.push({ source: source, venue: venue, titre: titre, date: raw.date, reason: fake.reason });
    return null;
  }
  const cat = detectCategory(titre, venue, raw.tags || []);
  const heureDebut = raw.heureDebut || "20:00";
  const heureFin = calculateEndTime(venue, cat, heureDebut, titre, raw.date);
  const srcInfo = getSourceInfo(source);
  return {
    source: source, source_level: srcInfo.level, source_score: srcInfo.score,
    source_id: raw.sourceId, source_url: raw.sourceUrl,
    date: raw.date, date_end: raw.dateEnd || raw.date,
    heure_debut: heureDebut, heure_fin: heureFin,
    venue: venue, venue_raw: raw.venueRaw,
    titre: titre, titre_normalized: normalizeTitle(titre),
    cat: cat, confirme: "OUI", notes: raw.notes || "",
  };
}

async function fetchQueFaireAParis(daysAhead = 60, rejects = []) {
  const today = new Date().toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];
  for (let page = 0; page < 5; page++) {
    const url = `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?limit=${limit}&offset=${offset}&where=date_start%20%3E%3D%20%22${today}%22&order_by=date_start%20ASC`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TaxiPulse/1.0" }, cf: { cacheTtl: 1800 } });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results || data.results.length === 0) break;
      for (const e of data.results) {
        const ev = buildEvent({
          venueRaw: e.address_name, titre: e.title,
          date: (e.date_start || "").split("T")[0], dateEnd: (e.date_end || "").split("T")[0],
          heureDebut: (e.date_start || "").split("T")[1]?.slice(0, 5) || "20:00",
          tags: e.tags || [], sourceId: e.id, sourceUrl: e.url, notes: "QFAP officiel"
        }, "qfap", rejects);
        if (ev) all.push(ev);
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

async function fetchOpenAgendaIDF(daysAhead = 60, rejects = []) {
  const today = new Date().toISOString().split("T")[0];
  const future = new Date(Date.now() + daysAhead * 86400000).toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];
  for (let page = 0; page < 5; page++) {
    const url = `https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets/evenements-publics-cibul/records?limit=${limit}&offset=${offset}&where=firstdate_begin%20%3E%3D%20%22${today}%22%20AND%20firstdate_begin%20%3C%3D%20%22${future}%22&order_by=firstdate_begin%20ASC`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TaxiPulse/1.0" }, cf: { cacheTtl: 1800 } });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results || data.results.length === 0) break;
      for (const e of data.results) {
        const ev = buildEvent({
          venueRaw: e.placename || e.location_name, titre: e.title_fr || e.title,
          date: (e.firstdate_begin || "").split("T")[0], dateEnd: (e.lastdate_end || "").split("T")[0],
          heureDebut: (e.firstdate_begin || "").split("T")[1]?.slice(0, 5) || "20:00",
          tags: e.keywords_fr || [], sourceId: e.uid, sourceUrl: e.canonicalurl, notes: "OpenAgenda IDF"
        }, "openagenda_idf", rejects);
        if (ev) all.push(ev);
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

async function fetchOpenAgendaFrance(daysAhead = 60, rejects = []) {
  const today = new Date().toISOString().split("T")[0];
  const future = new Date(Date.now() + daysAhead * 86400000).toISOString().split("T")[0];
  const limit = 100;
  let offset = 0;
  let all = [];
  for (let page = 0; page < 3; page++) {
    const url = `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/records?limit=${limit}&offset=${offset}&where=firstdate_begin%20%3E%3D%20%22${today}%22%20AND%20firstdate_begin%20%3C%3D%20%22${future}%22%20AND%20(department%3D%22Paris%22%20OR%20department%3D%22Hauts-de-Seine%22%20OR%20department%3D%22Seine-Saint-Denis%22%20OR%20department%3D%22Val-de-Marne%22)&order_by=firstdate_begin%20ASC`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TaxiPulse/1.0" }, cf: { cacheTtl: 1800 } });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results || data.results.length === 0) break;
      for (const e of data.results) {
        const ev = buildEvent({
          venueRaw: e.placename || e.location_name, titre: e.title_fr || e.title,
          date: (e.firstdate_begin || "").split("T")[0], dateEnd: (e.lastdate_end || "").split("T")[0],
          heureDebut: (e.firstdate_begin || "").split("T")[1]?.slice(0, 5) || "20:00",
          tags: e.keywords_fr || [], sourceId: e.uid, sourceUrl: e.canonicalurl, notes: "OpenAgenda FR"
        }, "openagenda_fr", rejects);
        if (ev) all.push(ev);
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

function crossValidate(allEvents) {
  const buckets = new Map();
  for (const e of allEvents) {
    const key = eventKey(e.date, e.venue, e.titre);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const merged = [];
  for (const [key, evs] of buckets) {
    if (evs.length === 0) continue;
    evs.sort((a, b) => (b.source_score || 0) - (a.source_score || 0));
    const primary = evs[0];
    const sources = [...new Set(evs.map(e => e.source))];
    const levels = [...new Set(evs.map(e => e.source_level))];
    const hasCanonical = levels.includes("canonical");
    const hasTicketing = levels.includes("ticketing");
    const aggregatorCount = evs.filter(e => e.source_level === "aggregator").length;
    let confidence = 0;
    if (hasCanonical) confidence += 50;
    if (hasTicketing) confidence += 20;
    confidence += Math.min(aggregatorCount * 10, 30);
    confidence = Math.min(confidence, 100);
    primary.confirme = confidence >= 60 ? "OUI" : "APPROX";
    primary.confidence_score = confidence;
    primary.sources_count = sources.length;
    primary.sources_list = sources.join(",");
    primary.has_canonical = hasCanonical;
    primary.has_ticketing = hasTicketing;
    primary.aggregator_count = aggregatorCount;
    primary.notes = `${sources.length} source(s): ${sources.join("+")} | conf=${confidence}`;
    merged.push(primary);
  }
  return merged;
}

async function compareWithMaster(newEvents, env) {
  const masterRaw = await env.TAXI_KV.get("events_master_csv");
  if (!masterRaw) return { news: newEvents, changes: [], removed: [] };
  const lines = masterRaw.split("\n").slice(1);
  const masterKeys = new Set();
  const masterByKey = new Map();
  for (const line of lines) {
    const [date, h_deb, , venue, titre] = line.split(",");
    if (!date || !venue) continue;
    const key = eventKey(date, venue, titre);
    masterKeys.add(key);
    masterByKey.set(key, { date, h_deb, venue, titre });
  }
  const news = [];
  const changes = [];
  for (const e of newEvents) {
    const key = eventKey(e.date, e.venue, e.titre);
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

async function sendDailyRecap(diff, rejects, env) {
  const { news, changes } = diff;
  if (news.length === 0 && changes.length === 0 && rejects.length === 0) {
    return { sent: false, reason: "rien à signaler" };
  }
  const rejectsByReason = {};
  for (const r of rejects) {
    rejectsByReason[r.reason] = (rejectsByReason[r.reason] || 0) + 1;
  }
  const html = `<h2>📋 TaxiPulse — Récap quotidien des events V2</h2><p>Détection auto à ${new Date().toISOString().slice(0, 16)} UTC</p><h3>🆕 ${news.length} nouveaux events détectés</h3><table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;"><tr style="background:#eee;"><th>Date</th><th>Heure</th><th>Venue</th><th>Titre</th><th>Conf</th><th>Score</th></tr>${news.slice(0, 50).map(e => `<tr style="border-top:1px solid #ddd;"><td>${e.date}</td><td>${e.heure_debut}-${e.heure_fin}</td><td>${e.venue}</td><td>${e.titre}</td><td>${e.confirme}</td><td>${e.confidence_score || 0}</td></tr>`).join("")}</table>${changes.length > 0 ? `<h3>⚠️ ${changes.length} changements d'horaires détectés</h3><ul>${changes.map(c => `<li><b>${c.event.date} ${c.event.venue}</b> : ${c.old_time} → ${c.new_time} (${c.event.titre})</li>`).join("")}</ul>` : ""}${rejects.length > 0 ? `<h3>🚫 ${rejects.length} fakes events rejetés (audit)</h3><ul>${Object.entries(rejectsByReason).map(([r, n]) => `<li><b>${r}</b> : ${n} events</li>`).join("")}</ul>` : ""}<hr><p style="font-size:11px;color:#666;">V2 : fake-detector + hiérarchie sources + moteur heure_fin actifs.</p>`;
  let apiKey = null, adminEmail = null;
  try {
    apiKey = (typeof env.RESEND_API_KEY !== 'undefined') ? env.RESEND_API_KEY : null;
    adminEmail = (typeof env.ADMIN_EMAIL !== 'undefined') ? env.ADMIN_EMAIL : null;
  } catch (e) {}
  if (apiKey && adminEmail) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TaxiPulse <noreply@taxipulse.fr>",
          to: adminEmail,
          subject: `📋 TaxiPulse V2 : ${news.length} new + ${changes.length} changements + ${rejects.length} rejets`,
          html: html,
        }),
      });
      return { sent: true, count: news.length + changes.length, rejects: rejects.length };
    } catch (err) {
      return { sent: false, error: err.message };
    }
  }
  return { sent: false, reason: "config manquante" };
}

async function handleAggregate(request, env) {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const rejects = [];
  const [qfap, oaIDF, oaFR] = await Promise.allSettled([
    fetchQueFaireAParis(60, rejects),
    fetchOpenAgendaIDF(60, rejects),
    fetchOpenAgendaFrance(60, rejects),
  ]);
  const all = [
    ...(qfap.status === "fulfilled" ? qfap.value : []),
    ...(oaIDF.status === "fulfilled" ? oaIDF.value : []),
    ...(oaFR.status === "fulfilled" ? oaFR.value : []),
  ];
  const validated = crossValidate(all);
  const diff = await compareWithMaster(validated, env);
  await env.TAXI_KV.put("events_aggregator_last_run", JSON.stringify({
    ts: Date.now(),
    total_fetched: all.length,
    after_dedup: validated.length,
    news: diff.news.length,
    changes: diff.changes.length,
    rejects: rejects.length,
    rejects_by_reason: rejects.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
    sources: {
      qfap: qfap.status === "fulfilled" ? qfap.value.length : 0,
      openagenda_idf: oaIDF.status === "fulfilled" ? oaIDF.value.length : 0,
      openagenda_fr: oaFR.status === "fulfilled" ? oaFR.value.length : 0,
    },
  }));
  if (rejects.length > 0) {
    const dateKey = new Date().toISOString().slice(0, 10);
    await env.TAXI_KV.put(`aggregator_rejects:${dateKey}`, JSON.stringify(rejects), { expirationTtl: 30 * 24 * 3600 });
  }
  if (!dryRun) {
    await sendDailyRecap(diff, rejects, env);
  }
  return new Response(JSON.stringify({
    ok: true, version: "v2",
    total: all.length, validated: validated.length,
    news: diff.news.length, changes: diff.changes.length, rejects: rejects.length,
    rejects_by_reason: rejects.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
    preview_news: diff.news.slice(0, 10),
    preview_rejects: rejects.slice(0, 10),
    sources: {
      qfap: qfap.status === "fulfilled" ? qfap.value.length : `error: ${qfap.reason?.message}`,
      openagenda_idf: oaIDF.status === "fulfilled" ? oaIDF.value.length : `error: ${oaIDF.reason?.message}`,
      openagenda_fr: oaFR.status === "fulfilled" ? oaFR.value.length : `error: ${oaFR.reason?.message}`,
    },
  }, null, 2), { headers: { "Content-Type": "application/json" } });
}

async function scheduledAggregate(event, env, ctx) {
  ctx.waitUntil(handleAggregate(new Request("https://x/events/aggregate"), env));
}

export { 
  handleAggregate, scheduledAggregate, 
  fetchQueFaireAParis, fetchOpenAgendaIDF, fetchOpenAgendaFrance,
  crossValidate, detectVenue, detectCategory, isFakeEvent, normalizeTitle, eventKey,
  calculateEndTime, applyDurationModifiers, getSourceInfo,
  VENUE_MAPPING, DURATION_RULES, SOURCE_LEVELS,
};
