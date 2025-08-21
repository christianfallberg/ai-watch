// scripts/update_data.mjs
// Node 18+ (rekommenderat 20+)
// npm i rss-parser googleapis

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';
import { google } from 'googleapis';

// ---------------------------------------------------------------
// Miljövariabler (GitHub Secrets / lokalt)
// ---------------------------------------------------------------
const BRAND_TERMS = (process.env.BRAND_TERMS || 'World Poker Guide,wpg,worldpoker.guide')
  .split(',').map(s => s.trim()).filter(Boolean);

const ALERT_FEEDS = (process.env.ALERT_FEEDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// GSC (valfritt)
const GSC_CLIENT_ID     = process.env.GSC_CLIENT_ID || '';
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || '';
const GSC_REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN || '';
const GSC_PROPERTY      = process.env.GSC_PROPERTY || ''; // ex: https://worldpoker.guide/ eller sc-domain:worldpoker.guide

// Loggfil (valfritt)
const LOG_PATH = process.env.LOG_PATH || '';

// ---------------------------------------------------------------
// Output: data.json i repo-ROTen (robust i Actions)
// ---------------------------------------------------------------
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT  = path.resolve(__dirname, '..');                         // ../ från scripts/
const WORKSPACE   = process.env.GITHUB_WORKSPACE || LOCAL_ROOT;            // Actions: absolut reporot
const OUT_PATH    = path.join(WORKSPACE, 'data.json');

// ---------------------------------------------------------------
function log(msg, ...rest) { console.log(`[ai-watch] ${msg}`, ...rest); }

function logPaths() {
  log('DEBUG __dirname  =', __dirname);
  log('DEBUG LOCAL_ROOT =', LOCAL_ROOT);
  log('DEBUG WORKSPACE  =', WORKSPACE);
  log('DEBUG OUT_PATH   =', OUT_PATH);
}

// ---------------------------------------------------------------
// 1) RSS / Google Alerts
// ---------------------------------------------------------------
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
  // sortera + dedupe
  const seen = new Set(); const out = [];
  for (const it of all.sort((a,b)=>new Date(b.published)-new Date(a.published))) {
    const key = it.link || it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  log(`Alerts: ${out.length} poster`);
  return out;
}

// ---------------------------------------------------------------
// 2) Google Search Console (med fallback & tolerans)
// ---------------------------------------------------------------
async function fetchGSC() {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN || !GSC_PROPERTY) {
    log('GSC-cred saknas – hoppar över GSC.');
    return null;
  }

  try {
    const oauth2Client = new google.auth.OAuth2(GSC_CLIENT_ID, GSC_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: GSC_REFRESH_TOKEN });
    const webmasters = google.webmasters({ version: 'v3', auth: oauth2Client });

    async function queryRange(startISO, endISO) {
      const base = { startDate: startISO, endDate: endISO, searchType: 'web', dataState: 'all' };

      const [qRes, pRes] = await Promise.all([
        webmasters.searchanalytics.query({
          siteUrl: GSC_PROPERTY,
          requestBody: { ...base, dimensions: ['query'], rowLimit: 25000 }
        }),
        webmasters.searchanalytics.query({
          siteUrl: GSC_PROPERTY,
          requestBody: { ...base, dimensions: ['page'], rowLimit: 25000 }
        })
      ]);

      const allQueries = qRes.data.rows || [];
      const allPages   = pRes.data.rows || [];

      const termsLower = BRAND_TERMS.map(t => t.toLowerCase());
      const brandQueries = allQueries
        .filter(r => termsLower.some(t => (r.keys?.[0] || '').toLowerCase().includes(t)))
        .map(r => ({
          query: r.keys?.[0] || '',
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          ctr: r.ctr || 0,
          position: r.position || 0
        }))
        .sort((a,b) => b.impressions - a.impressions);

      const pages = allPages
        .map(r => ({
          page: r.keys?.[0] || '',
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          ctr: r.ctr || 0
        }))
        .sort((a,b) => b.clicks - a.clicks);

      return { brandQueries, pages };
    }

    // Primärt intervall: senaste 30 dagar (till igår)
    const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
    const start30 = new Date(end); start30.setUTCDate(start30.getUTCDate() - 29);
    const fmt = d => d.toISOString().slice(0,10);

    let periodLabel = `${fmt(start30)} → ${fmt(end)}`;
    let { brandQueries, pages } = await queryRange(fmt(start30), fmt(end));

    // Fallback: 90 dagar om 0 rader
    if (brandQueries.length === 0 && pages.length === 0) {
      const start90 = new Date(end); start90.setUTCDate(start90.getUTCDate() - 89);
      periodLabel = `${fmt(start90)} → ${fmt(end)}`;
      ({ brandQueries, pages } = await queryRange(fmt(start90), fmt(end)));
      log('GSC: 30d gav 0 rader, föll tillbaka till 90d.');
    }

    const clicksSum = pages.reduce((s,r)=>s+(r.clicks||0),0);
    const imprSum   = pages.reduce((s,r)=>s+(r.impressions||0),0);
    const ctrAvgPct = pages.length ? ((pages.reduce((s,r)=>s+(r.ctr||0),0)/pages.length)*100) : 0;

    const summary = {
      Klickar: clicksSum,
      Visningar: imprSum,
      'Gen. CTR': `${ctrAvgPct.toFixed(2)}%`,
      Period: periodLabel
    };

    log(`GSC: ${brandQueries.length} brand-queries, ${pages.length} sidor`);
    return { summary, topQueries: brandQueries.slice(0,50), topPages: pages.slice(0,50) };
  } catch (e) {
    // Fånga 403/404/… och fortsätt utan att krascha
    console.error('[ai-watch] GSC error:', e?.response?.status || e?.code || '', e?.message);
    return null;
  }
}

// ---------------------------------------------------------------
// 3) Botar i loggar (valfritt)
// ---------------------------------------------------------------
function parseUA(line){ const m=line.match(/"[^"]*" "([^"]*)"$/); return m ? m[1] : ''; }

async function fetchBots() {
  if (!LOG_PATH) {
    log('LOG_PATH ej satt – hoppar över bot-analys.');
    return [];
  }
  try {
    const raw = await fs.readFile(LOG_PATH,'utf8');
    const lines = raw.split('\n').filter(Boolean).reverse();

    const bots = [
      { name:'GPTBot',          test: ua=>/GPTBot/i.test(ua) },
      { name:'PerplexityBot',   test: ua=>/PerplexityBot/i.test(ua) },
      { name:'Claude-Web',      test: ua=>/Claude-Web|Anthropic/i.test(ua) },
      { name:'Google-Extended', test: ua=>/Google-Extended|Googlebot/i.test(ua) },
    ];
    const stats = bots.map(b=>({ name:b.name, hits:0, last_seen:null }));

    for (const line of lines) {
      const ua = parseUA(line);
      bots.forEach((b,i)=>{
        if (b.test(ua)) {
          stats[i].hits++;
          if (!stats[i].last_seen) {
            stats[i].last_seen = line.match(/\[(.*?)\]/)?.[1] || null; // lämna rå sträng om parsing är knepig
          }
        }
      });
    }

    const filtered = stats.filter(s=>s.hits>0);
    log(`Bots: ${filtered.length} typer sedda`);
    return filtered;
  } catch (e) {
    console.error('[ai-watch] LOG error:', e.message);
    return [];
  }
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
async function main(){
  log('Startar…');
  logPaths();

  const [alerts, gsc, bots] = await Promise.all([ fetchAlerts(), fetchGSC(), fetchBots() ]);

  const data = {
    generated_at: new Date().toISOString(),
    brand_terms: BRAND_TERMS,
    alerts,
    gsc: gsc || { summary: { Notis: 'GSC ej konfigurerat eller tomt' }, topQueries: [], topPages: [] },
    bots
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(data,null,2), 'utf8');

  log(`Skrev ${OUT_PATH}`);
}

main().catch(err => {
  console.error('[ai-watch] FATAL:', err);
  process.exit(1);
});
