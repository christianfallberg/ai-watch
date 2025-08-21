// scripts/update_data.mjs
// Node 18+ (rekommenderat Node 20+)
// npm i rss-parser googleapis

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
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
const GSC_PROPERTY      = process.env.GSC_PROPERTY || ''; // t.ex. https://worldpoker.guide/ eller sc-domain:worldpoker.guide

// Loggfil (valfritt) – sätt t.ex. till en roterad Nginx/Apache-logg (plaintext). Vårt workflow packar upp .gz.
const LOG_PATH = process.env.LOG_PATH || '';

// Demo-läge (valfritt) – fyller exempeldata om sektioner annars skulle bli tomma
const DEMO = (process.env.DEMO || '').toLowerCase() === 'true';

// Extra botmönster via secret (kommaseparerat), valfritt. T.ex. "bingbot,facebookexternalhit"
const BOT_EXTRA = (process.env.BOT_EXTRA || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ----- Output: data.json i repo-roten -----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE || '';
const LOCAL_ROOT = GITHUB_WORKSPACE || path.resolve(__dirname, '..'); // ../ från scripts/
const OUT_PATH  = path.join(LOCAL_ROOT, 'data.json');

// ------------------------------------------------------------------
function log(msg, ...rest) { console.log(`[ai-watch] ${msg}`, ...rest); }

// Små helpers
const isoDay = (d) => d.toISOString().slice(0,10);

function percent(n) {
  if (!isFinite(n) || n === 0) return '0.00%';
  return `${(n * 100).toFixed(2)}%`;
}

// Läs ev. gz-fil om LOG_PATH skulle råka vara .gz (workflown ger plaintext, men vi gör det robust)
async function readTextMaybeGz(filePath) {
  if (!filePath) return '';
  if (filePath.endsWith('.gz')) {
    const buf = await fs.readFile(filePath);
    const text = gunzipSync(buf).toString('utf8');
    return text;
  }
  return await fs.readFile(filePath, 'utf8');
}

// ------------------------------------------------------------------
// RSS / Alerts
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
      const sourceName = (feed.title || '').replace(/^Google Alerts -\s*/i, '').trim() || (new URL(url).hostname);
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
  // dedupe + sort nyast först
  const seen = new Set();
  const dedup = [];
  for (const it of all.sort((a,b)=> new Date(b.published) - new Date(a.published))) {
    const key = it.link || it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(it);
  }
  log(`Alerts: ${dedup.length} poster`);
  return dedup;
}

// ------------------------------------------------------------------
// Google Search Console
async function fetchGSC() {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN || !GSC_PROPERTY) {
    log('GSC-cred saknas – hoppar över GSC.');
    return null;
  }
  try {
    const oauth2Client = new google.auth.OAuth2(GSC_CLIENT_ID, GSC_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: GSC_REFRESH_TOKEN });
    const webmasters = google.webmasters({ version: 'v3', auth: oauth2Client });

    // Först 30 dagar, annars fallback 90 dagar
    const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
    const start30 = new Date(end); start30.setUTCDate(start30.getUTCDate() - 29);
    const start90 = new Date(end); start90.setUTCDate(start90.getUTCDate() - 89);

    async function queryAll(range) {
      const base = { startDate: isoDay(range.start), endDate: isoDay(range.end), rowLimit: 25000, searchType: 'web', dataState: 'all' };

      const qRes = await webmasters.searchanalytics.query({
        siteUrl: GSC_PROPERTY, requestBody: { ...base, dimensions: ['query'] }
      });
      const pRes = await webmasters.searchanalytics.query({
        siteUrl: GSC_PROPERTY, requestBody: { ...base, dimensions: ['page'] }
      });

      return {
        queries: qRes.data.rows || [],
        pages: pRes.data.rows || [],
        range: `${base.startDate} → ${base.endDate}`
      };
    }

    let result = await queryAll({ start: start30, end });
    let usedRange = result.range;
    let usedWindow = '30d';
    if ((result.queries.length === 0) && (result.pages.length === 0)) {
      log('GSC: 30d gav 0 rader, föll tillbaka till 90d.');
      result = await queryAll({ start: start90, end });
      usedRange = result.range;
      usedWindow = '90d';
    }

    const termsLower = BRAND_TERMS.map(t => t.toLowerCase());
    const topQueries = result.queries
      .filter(r => {
        const q = r.keys?.[0] || '';
        const ql = q.toLowerCase();
        return termsLower.some(t => ql.includes(t));
      })
      .map(r => ({
        query: r.keys?.[0] || '',
        clicks: r.clicks || 0,
        impressions: r.impressions || 0,
        ctr: r.ctr || 0,
        position: r.position || 0
      }))
      .sort((a,b) => b.impressions - a.impressions)
      .slice(0, 50);

    const topPages = result.pages
      .map(r => ({
        page: r.keys?.[0] || '',
        clicks: r.clicks || 0,
        impressions: r.impressions || 0,
        ctr: r.ctr || 0
      }))
      .sort((a,b) => b.clicks - a.clicks)
      .slice(0, 50);

    const clicksSum = topPages.reduce((s,r)=> s + (r.clicks||0), 0);
    const imprSum   = topPages.reduce((s,r)=> s + (r.impressions||0), 0);
    const ctrOverall = imprSum > 0 ? (clicksSum / imprSum) : 0;

    const summary = {
      Klickar: clicksSum,
      Visningar: imprSum,
      'Gen. CTR': percent(ctrOverall),
      Period: usedRange + (usedWindow === '90d' ? ' (fallback 90d)' : '')
    };

    log(`GSC: ${topQueries.length} brand-queries, ${topPages.length} sidor`);
    return { summary, topQueries, topPages };

  } catch (err) {
    const m = err?.message || String(err);
    console.error('[ai-watch] GSC error:', m);
    return null;
  }
}

// ------------------------------------------------------------------
// Bots (logg-analys)
function parseUA(line) {
  // Hämta sista "..."-segmentet (UA ligger sist i quotes i common/combined loggar)
  const allQuoted = line.match(/"([^"]*)"/g);
  if (allQuoted && allQuoted.length) {
    const last = allQuoted[allQuoted.length - 1];
    return last.slice(1, -1);
  }
  return '';
}

async function fetchBots() {
  if (!LOG_PATH) {
    log('LOG_PATH ej satt – hoppar över bot-analys.');
    return [];
  }

  // Vanliga AI/SEO/social-botar
  const BOT_DEFS = [
    { name: 'GPTBot (OpenAI)',        rx: /gptbot|chatgpt-user/i },
    { name: 'Claude-Web (Anthropic)', rx: /claude-web|claudebot|anthropic/i },
    { name: 'PerplexityBot',          rx: /perplexitybot/i },
    { name: 'Google-Extended',        rx: /google-extended/i },

    // Sökbotar
    { name: 'Googlebot',              rx: /\bgooglebot\b/i },
    { name: 'Bingbot',                rx: /\bbingbot\b|\bbingpreview\b/i },
    { name: 'DuckDuckBot',            rx: /duckduckbot/i },
    { name: 'YandexBot',              rx: /yandex(bot|images)/i },
    { name: 'Applebot',               rx: /applebot/i },

    // Social preview
    { name: 'FacebookExternalHit',    rx: /facebookexternalhit|facebookbot/i },
    { name: 'Twitterbot / XBot',      rx: /\btwitterbot\b|(^|[^a-z])xbot([^a-z]|$)/i },
    { name: 'LinkedInBot',            rx: /linkedinbot/i },
    { name: 'Discordbot',             rx: /discordbot/i },

    // SEO/crawlare
    { name: 'AhrefsBot',              rx: /ahrefsbot/i },
    { name: 'SemrushBot',             rx: /semrushbot/i },
    { name: 'DotBot (Moz)',           rx: /(^|[^a-z])dotbot([^a-z]|$)/i },
    { name: 'MJ12bot',                rx: /mj12bot/i },
    { name: 'Bytespider (ByteDance)', rx: /bytespider/i },
    { name: 'CCBot (CommonCrawl)',    rx: /\bccbot\b/i },
    { name: 'Screaming Frog',         rx: /screaming\s*frog/i },
    { name: 'SeznamBot',              rx: /seznambot/i },
  ];

  // Lägg till egna mönster via secret BOT_EXTRA
  for (const token of BOT_EXTRA) {
    try {
      BOT_DEFS.push({ name: token, rx: new RegExp(token, 'i') });
    } catch (_) { /* ignorera ogiltig regex */ }
  }

  try {
    const raw = await readTextMaybeGz(LOG_PATH);
    if (!raw) {
      log('LOG_PATH fanns men var tomt – hoppar över bot-analys.');
      return [];
    }

    const lines = raw.split('\n').filter(Boolean).reverse(); // nyaste först
    const statsMap = new Map(); // name -> { name, hits, last_seen }
    const timeRe = /\[(.*?)\]/;

    for (const line of lines) {
      const ua = parseUA(line);
      if (!ua || ua === '-') continue;

      for (const def of BOT_DEFS) {
        if (def.rx.test(ua)) {
          const ts = timeRe.exec(line)?.[1] || null;
          const cur = statsMap.get(def.name);
          if (cur) {
            cur.hits++;
          } else {
            statsMap.set(def.name, { name: def.name, hits: 1, last_seen: ts });
          }
          break; // sluta efter första matchen
        }
      }
    }

    const stats = Array.from(statsMap.values()).sort((a, b) => b.hits - a.hits);
    log(`Bots: ${stats.length} typer sedda`);
    return stats;

  } catch (e) {
    console.error('[ai-watch] LOG error:', e.message);
    return [];
  }
}

// ------------------------------------------------------------------
// Huvudflöde
async function main() {
  log('Startar…');
  log('DEBUG __dirname  =', __dirname);
  log('DEBUG LOCAL_ROOT =', LOCAL_ROOT);
  log('DEBUG WORKSPACE  =', GITHUB_WORKSPACE || '(none)');
  log('DEBUG OUT_PATH   =', OUT_PATH);

  const [alerts, gsc, bots] = await Promise.all([
    fetchAlerts(),
    fetchGSC(),
    fetchBots()
  ]);

  const data = {
    generated_at: new Date().toISOString(),
    brand_terms: BRAND_TERMS,
    alerts,
    gsc: gsc || { summary: { Notis: 'GSC ej konfigurerat eller tomt' }, topQueries: [], topPages: [] },
    bots
  };

  // DEMO: fyll med exempel om tomt
  if (DEMO) {
    if (!data.alerts?.length) {
      data.alerts = [
        {
          id: "demo-1",
          title: "World Poker Guide nämns i demo-artikel",
          link: "https://example.com/demo-world-poker-guide",
          source: "Demo RSS",
          published: new Date().toISOString()
        },
        {
          id: "demo-2",
          title: "worldpoker.guide omnämns i annan demo",
          link: "https://example.com/demo-2",
          source: "Demo RSS",
          published: new Date(Date.now() - 86400000).toISOString()
        }
      ];
    }
    if (!data.gsc?.topPages?.length) {
      data.gsc = {
        summary: {
          Klickar: 42,
          Visningar: 1234,
          'Gen. CTR': '3.40%',
          Period: 'DEMO (90 dagar)'
        },
        topQueries: [
          { query: 'world poker guide', clicks: 12, impressions: 400, ctr: 0.03, position: 8.1 },
          { query: 'worldpoker.guide', clicks: 8, impressions: 120, ctr: 0.066, position: 2.3 }
        ],
        topPages: [
          { page: 'https://worldpoker.guide/', clicks: 20, impressions: 500, ctr: 0.04 },
          { page: 'https://worldpoker.guide/poker-hands', clicks: 12, impressions: 300, ctr: 0.04 }
        ]
      };
    }
    if (!data.bots?.length) {
      data.bots = [
        { name: 'GPTBot (OpenAI)', hits: 3, last_seen: '21/Aug/2025:10:13:11 +0000' },
        { name: 'PerplexityBot', hits: 1, last_seen: '21/Aug/2025:10:14:55 +0000' }
      ];
    }
  }

  await fs.writeFile(OUT_PATH, JSON.stringify(data, null, 2), 'utf8');
  log(`Skrev ${OUT_PATH}`);
}

main().catch(err => {
  console.error('[ai-watch] FATAL:', err);
  process.exit(1);
});
