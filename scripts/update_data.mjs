// Requires Node 20+
// npm i rss-parser googleapis fast-xml-parser
import fs from 'node:fs/promises';
import Parser from 'rss-parser';
import { google } from 'googleapis';
import { XMLParser } from 'fast-xml-parser';

const BRAND_TERMS = (process.env.BRAND_TERMS || 'World Poker Guide,wpg,worldpoker.guide')
  .split(',').map(s=>s.trim()).filter(Boolean);

const ALERT_FEEDS = (process.env.ALERT_FEEDS || '').split(',').map(s=>s.trim()).filter(Boolean);
// Exempel på en feed (skapa i Google Alerts och välj "RSS"): https://www.google.se/alerts/feeds/XXXXXXXX

const LOG_PATH = process.env.LOG_PATH || ''; // valfritt: filväg till accesslog (Nginx/Apache/S3)

const OUT_PATH = new URL('../ai-watch/data.json', import.meta.url);

async function fetchAlerts() {
  if (!ALERT_FEEDS.length) return [];
  const parser = new Parser();
  const all = [];
  for (const url of ALERT_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        all.push({
          id: item.id || item.guid || item.link,
          title: item.title,
          link: item.link,
          source: feed.title?.replace('Google Alerts - ', '') || '',
          published: item.isoDate || item.pubDate || new Date().toISOString()
        });
      }
    } catch (e) {
      console.error('RSS error:', url, e.message);
    }
  }
  // dedupe by link
  const seen = new Set(); const dedup = [];
  for (const it of all.sort((a,b)=>new Date(b.published)-new Date(a.published))) {
    if (seen.has(it.link)) continue;
    seen.add(it.link); dedup.push(it);
  }
  return dedup;
}

async function fetchGSC() {
  // Kräver att du skapar OAuth-hemligheter + refresh token och lägger dem i GitHub Secrets
  const {
    GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN, GSC_PROPERTY
  } = process.env;
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN || !GSC_PROPERTY) {
    return null; // hoppa över om ej konfigurerat
  }

  const oauth2Client = new google.auth.OAuth2(GSC_CLIENT_ID, GSC_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GSC_REFRESH_TOKEN });
  const webmasters = google.webmasters({ version: 'v3', auth: oauth2Client });
  const searchconsole = google.searchconsole({ version: 'v1', auth: oauth2Client });

  // 30 dagar bakåt
  const end = new Date(); end.setDate(end.getDate()-1);
  const start = new Date(end); start.setDate(start.getDate()-29);
  const dateRange = { startDate: start.toISOString().slice(0,10), endDate: end.toISOString().slice(0,10) };

  // Frågor med brand-termer
  const queryReq = {
    siteUrl: GSC_PROPERTY,
    requestBody: {
      ...dateRange,
      dimensions: ['query'],
      rowLimit: 25000
    }
  };
  const qRes = await searchconsole.searchanalytics.query(queryReq);
  const qRows = (qRes.data.rows || [])
    .filter(r => BRAND_TERMS.some(t => r.keys[0].toLowerCase().includes(t.toLowerCase())))
    .map(r => ({ query: r.keys[0], clicks: r.clicks||0, impressions: r.impressions||0, ctr: r.ctr||0, position: r.position||0 }))
    .sort((a,b)=>b.impressions-a.impressions);

  // Sidor som får klick/visningar på brand-queries
  const pageReq = {
    siteUrl: GSC_PROPERTY,
    requestBody: {
      ...dateRange,
      dimensions: ['page'],
      rowLimit: 25000
    }
  };
  const pRes = await searchconsole.searchanalytics.query(pageReq);
  const pRows = (pRes.data.rows || []).map(r => ({
    page: r.keys[0], clicks: r.clicks||0, impressions: r.impressions||0, ctr: r.ctr||0
  })).sort((a,b)=>b.clicks-a.clicks);

  const summary = {
    Klickar: Math.round(pRows.reduce((s,r)=>s+r.clicks,0)),
    Visningar: Math.round(pRows.reduce((s,r)=>s+r.impressions,0)),
    'Gen. CTR': +(pRows.reduce((s,r)=>s+r.ctr,0)/(pRows.length||1)*100).toFixed(2) + '%',
    Period: `${dateRange.startDate} → ${dateRange.endDate}`
  };

  return { summary, topQueries: qRows.slice(0,50), topPages: pRows.slice(0,50) };
}

function parseUA(line) {
  // Hämta user-agent från vanligt Nginx "combined" format
  const m = line.match(/"[^"]*" "([^"]*)"$/);
  return m ? m[1] : '';
}

async function fetchBots() {
  if (!LOG_PATH) return [];
  try {
    const raw = await fs.readFile(LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-200000); // sista ~200k rader
    const bots = [
      { name:'GPTBot',       test: ua => /GPTBot/i.test(ua) },
      { name:'PerplexityBot',test: ua => /PerplexityBot/i.test(ua) },
      { name:'Claude-Web',   test: ua => /Claude-Web|Anthropic/i.test(ua) },
      { name:'Google-Extended', test: ua => /Google-Extended|Googlebot/i.test(ua) },
    ];
    const out = bots.map(b=>({ name:b.name, hits:0, last_seen:null }));
    for (const line of lines.reverse()) {
      const ua = parseUA(line);
      for (const row of out) {
        const def = bots.find(b=>b.name===row.name);
        if (def.test(ua)) {
          row.hits++;
          if (!row.last_seen) {
            // extrahera tidsstämpel [10/Oct/2000:13:55:36 +0000]
            const t = line.match(/\[(.*?)\]/)?.[1];
            row.last_seen = t ? new Date(t.replace(/:/,' ').replace(/(\d{2}:\d{2}:\d{2}) .+$/,'$1 UTC')).toISOString() : null;
          }
        }
      }
    }
    return out.filter(r=>r.hits>0);
  } catch (e) {
    console.error('LOG error:', e.message);
    return [];
  }
}

async function main() {
  const [alerts, gsc, bots] = await Promise.all([
    fetchAlerts(),
    fetchGSC(),
    fetchBots()
  ]);

  const data = {
    generated_at: new Date().toISOString(),
    brand_terms: BRAND_TERMS,
    alerts,
    gsc: gsc || { summary:{ Notis:'GSC ej konfigurerat' }, topQueries:[], topPages:[] },
    bots
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(data, null, 2));
  console.log('Wrote', OUT_PATH.pathname);
}
main().catch(e=>{ console.error(e); process.exit(1); });
