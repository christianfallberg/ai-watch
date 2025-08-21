// scripts/update_data.mjs
// Node 18+ (rekommenderat Node 20+)
// npm i rss-parser googleapis

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';
import { google } from 'googleapis';

// ----- Konfig via miljövariabler (GitHub Actions → Secrets) -----
const BRAND_TERMS = (process.env.BRAND_TERMS || 'World Poker Guide,wpg,worldpoker.guide')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALERT_FEEDS = (process.env.ALERT_FEEDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// GSC (valfritt)
const GSC_CLIENT_ID     = process.env.GSC_CLIENT_ID || '';
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || '';
const GSC_REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN || '';
const GSC_PROPERTY      = process.env.GSC_PROPERTY || ''; // t.ex. https://worldpoker.guide/

// Loggfil (valfritt) – sätt t.ex. till en roterad Nginx/Apache-logg
const LOG_PATH = process.env.LOG_PATH || '';

// ----- Output-sökväg: ../ai-watch/data.json relativt denna fil -----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.resolve(__dirname, '../ai-watch');
const OUT_PATH  = path.join(OUT_DIR, 'data.json');

// ------------------------------------------------------------------
// Hjälpfunktioner
// ------------------------------------------------------------------
function log(msg, ...rest) {
  console.log(`[ai-watch] ${msg}`, ...rest);
}

async function fetchAlerts() {
  if (!ALERT_FEEDS.length) {
    log('ALERT_FEEDS saknas – hoppar över RSS.');
    return [];
  }

  const parser = new Parser();
  const all = [];

  for (const url of ALERT_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      const sourceName = (feed.title || '').replace(/^Google Alerts -\s*/i, '').trim();
      for (const item of feed.items || []) {
        all.push({
          id: item.id || item.guid || item.link || `${item.title}-${item.isoDate || item.pubDate || ''}`,
          title: item.title || '(utan titel)',
          link: item.link || '',
          source: sourceName,
          published: item.isoDate || item.pubDate || new Date().toISOString()
        });
      }
    } catch (e) {
      console.error('[ai-watch] RSS error:', url, e.message);
    }
  }

  // Sortera nyast först och deduplicera på länk
  const seen = new Set();
  const dedup = [];
  for (const it of all.sort((a, b) => new Date(b.published) - new Date(a.published))) {
    const key = it.link || it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(it);
  }

  log(`Alerts: ${dedup.length} poster`);
  return dedup;
}

async function fetchGSC() {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN || !GSC_PROPERTY) {
    log('GSC-cred saknas – hoppar över GSC.');
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(GSC_CLIENT_ID, GSC_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GSC_REFRESH_TOKEN });

  // Använd den stabila "webmasters" v3 (Search Console API)
  const webmasters = google.webmasters({ version: 'v3', auth: oauth2Client });

  // Period: senaste 30 dagarna (slutar igår)
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);

  const dateRange = {
    startDate: start.toISOString().slice(0, 10),
    endDate:   end.toISOString().slice(0, 10)
  };

  // 1) Hämta queries
  const qReq = {
    siteUrl: GSC_PROPERTY,
    requestBody: {
      ...dateRange,
      dimensions: ['query'],
      rowLimit: 25000
    }
  };

  const qRes = await webmasters.searchanalytics.query(qReq);
  const qRowsRaw = qRes.data.rows || [];

  // Filtrera till brand-relaterade queries (om BRAND_TERMS definierat)
  const termsLower = BRAND_TERMS.map(t => t.toLowerCase());
  const qRows = qRowsRaw
    .filter(r => {
      const q = (r.keys?.[0] || '').toLowerCase();
      return termsLower.some(t => q.includes(t));
    })
    .map(r => ({
      query: r.keys?.[0] || '',
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: r.position || 0
    }))
    .sort((a, b) => b.impressions - a.impressions);

  // 2) Hämta sidor (aggregerat)
  const pReq = {
    siteUrl: GSC_PROPERTY,
    requestBody: {
      ...dateRange,
      dimensions: ['page'],
      rowLimit: 25000
    }
  };

  const pRes = await webmasters.searchanalytics.query(pReq);
  const pRows = (pRes.data.rows || [])
    .map(r => ({
      page: r.keys?.[0] || '',
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0
    }))
    .sort((a, b) => b.clicks - a.clicks);

  const clicksSum = pRows.reduce((s, r) => s + (r.clicks || 0), 0);
  const imprSum   = pRows.reduce((s, r) => s + (r.impressions || 0), 0);
  const ctrAvgPct = pRows.length ? ((pRows.reduce((s, r) => s + (r.ctr || 0), 0) / pRows.length) * 100) : 0;

  const summary = {
    Klickar: clicksSum,
    Visningar: imprSum,
    'Gen. CTR': `${ctrAvgPct.toFixed(2)}%`,
    Period: `${dateRange.startDate} → ${dateRange.endDate}`
  };

  log(`GSC: ${qRows.length} brand-queries, ${pRows.length} sidor`);
  return { summary, topQueries: qRows.slice(0, 50), topPages: pRows.slice(0, 50) };
}

function parseUA(line) {
  // För "combined" loggformat: sista strängen i citattecken är user-agent
  const m = line.match(/"[^"]*" "([^"]*)"$/);
  return m ? m[1] : '';
}

async function fetchBots() {
  if (!LOG_PATH) {
    log('LOG_PATH ej satt – hoppar över bot-analys.');
    return [];
  }

  try {
    const raw = await fs.readFile(LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    // Bearbeta från nyaste till äldsta
    lines.reverse();

    const bots = [
      { name: 'GPTBot',          test: ua => /GPTBot/i.test(ua) },
      { name: 'PerplexityBot',   test: ua => /PerplexityBot/i.test(ua) },
      { name: 'Claude-Web',      test: ua => /Claude-Web|Anthropic/i.test(ua) },
      { name: 'Google-Extended', test: ua => /Google-Extended|Googlebot/i.test(ua) },
    ];

    const stats = bots.map(b => ({ name: b.name, hits: 0, last_seen: null }));

    for (const line of lines) {
      const ua = parseUA(line);
      for (let i = 0; i < bots.length; i++) {
        if (bots[i].test(ua)) {
          stats[i].hits++;
          if (!stats[i].last_seen) {
            // Försök läsa tidsstämpel i format [10/Oct/2000:13:55:36 +0000]
            const t = line.match(/\[(.*?)\]/)?.[1];
            // Lämna som rå text om parsing är osäker
            stats[i].last_seen = t || null;
          }
        }
      }
    }

    const filtered = stats.filter(s => s.hits > 0);
    log(`Bots: ${filtered.length} typer sedda`);
    return filtered;
  } catch (e) {
    console.error('[ai-watch] LOG error:', e.message);
    return [];
  }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main() {
  log('Startar…');

  const [alerts, gsc, bots] = await Promise.all([
    fetchAlerts(),
    fetchGSC(),
    fetchBots()
  ]);

  const data = {
    generated_at: new Date().toISOString(),
    brand_terms: BRAND_TERMS,
    alerts,
    gsc: gsc || { summary: { Notis: 'GSC ej konfigurerat' }, topQueries: [], topPages: [] },
    bots
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(data, null, 2), 'utf8');

  log(`Skrev ${OUT_PATH}`);
}

main().catch(err => {
  console.error('[ai-watch] FATAL:', err);
  process.exit(1);
});
