// 静态站点的 /api/* 代理：把手机版 server.mjs 的路由原样搬到 Netlify Functions。
// 前端 app.js 全部用相对路径 api/...，靠 _redirects 转到 /.netlify/functions/api/:splat。
import '../../lib/function-env.mjs';
import { library, resolveSource } from '../../lib/online-sources.mjs';
import { chineseSearch, CHINESE_TITLE_ALIASES } from '../../lib/chinese-search.mjs';
import { searchVod, resolveEpisodeById, fetchItemById } from '../../lib/vod-sources.mjs';
import { browse, scrapeStatus } from '../../lib/library-browse.mjs';
import { scrapeMore } from '../../lib/scrape-once.mjs';

const CATEGORIES = ['all', '剧集', '电影', '动漫', '综艺', '纪录', '体育'];
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (statusCode, data) => ({ statusCode, headers: HEADERS, body: JSON.stringify(data) });

// 检索结果短缓存：函数实例复用时能省掉重复的上游请求。
const cache = new Map();
const movieKinds = new Map([['movie', 'movie'], ['tvMovie', 'movie'], ['short', 'movie'], ['video', 'movie'], ['tvSeries', 'tv'], ['tvMiniSeries', 'tv'], ['tvSpecial', 'tv'], ['tvShort', 'tv']]);

async function getJSON(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function imdb(q) {
  const term = q.toLowerCase();
  const prefix = /^[a-z0-9]/.test(term) ? term[0] : 'x';
  const data = await getJSON(`https://v3.sg.media-imdb.com/suggestion/${prefix}/${encodeURIComponent(term)}.json`);
  return (data.d || []).filter(x => /^tt\d+$/.test(x.id) && movieKinds.has(x.qid) && x.l && !/adult|porn/i.test(x.q || '')).slice(0, 10).map(x => ({
    id: `imdb-${x.id}`, title: x.l, year: String(x.y || ''), kind: movieKinds.get(x.qid), genres: [],
    poster: typeof x.i?.imageUrl === 'string' && x.i.imageUrl.startsWith('https://m.media-amazon.com/') ? x.i.imageUrl.replace(/\._V1_\.jpg$/, '._V1_SY500_.jpg') : '',
    watch: `https://www.imdb.com/title/${x.id}/`, credits: x.s,
  }));
}
async function tmdb(q, token) {
  const params = new URLSearchParams({ query: q, language: 'zh-CN', include_adult: 'false' });
  const data = await getJSON(`https://api.themoviedb.org/3/search/multi?${params}`, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
  return (data.results || []).filter(x => ['movie', 'tv'].includes(x.media_type) && (x.title || x.name) && !x.adult).slice(0, 20).map(x => ({
    id: `tmdb-${x.media_type}-${x.id}`, kind: x.media_type, title: x.title || x.name, original: x.original_title || x.original_name,
    year: (x.release_date || x.first_air_date || '').slice(0, 4), genres: x.genre_ids?.some(id => id === 16) ? ['动画'] : [],
    score: x.vote_count ? Number(x.vote_average).toFixed(1) : '', summary: x.overview,
    poster: /^\/[\w.-]+$/.test(x.poster_path || '') ? `https://media.themoviedb.org/t/p/w342${x.poster_path}` : '',
  }));
}
async function search(q, token) {
  const key = q.toLowerCase(), hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.data;
  const active = [['tencent', async query => { const source = await chineseSearch(query); if (!source.ok) throw Error(source.note); return source.rows; }], ['imdb', imdb], ...(token ? [['tmdb', query => tmdb(query, token)]] : [])];
  const results = await Promise.all(active.map(async ([name, run]) => {
    try { return [name, { ok: true, rows: await run(q) }]; } catch { return [name, { ok: false, rows: [] }]; }
  }));
  const data = Object.fromEntries(results);
  for (const [title, alias] of Object.entries(CHINESE_TITLE_ALIASES)) {
    for (const row of data.imdb?.rows || []) if (row.id === `imdb-${alias.imdb}`) Object.assign(row, { title, original: alias.original, aliases: [alias.original, title] });
  }
  if (results.every(([, source]) => source.ok)) {
    cache.delete(key);
    if (cache.size >= 120) cache.delete(cache.keys().next().value);
    cache.set(key, { until: Date.now() + 5 * 60_000, data });
  }
  return data;
}

export async function handler(event) {
  const params = event.queryStringParameters || {};
  // /api/<name> → route
  const route = (event.path || '').replace(/^.*?\/api\//, '').replace(/\/+$/, '') || '';
  const token = process.env.TMDB_TOKEN?.trim();
  try {
    if (route === 'health') return json(200, { service: 'film-radar', version: '3.1-static', mode: 'netlify' });

    if (route === 'library') {
      const q = (params.q || '').trim(), provider = params.provider || 'all';
      const page = Number(params.page || 1), limit = Number(params.limit || 24);
      if (q.length > 100 || !['all', 'cntv', 'commons'].includes(provider) || !Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 48) return json(400, { error: '片库查询参数无效' });
      try { return json(200, await library({ q, provider, page, limit })); }
      catch (error) { console.error('library:', error.message); return json(502, { error: '在线片库连接失败，请稍后重试' }); }
    }

    if (route === 'resolve') {
      const id = params.id || '';
      if (!/^(?:cntv-[a-f0-9]{32}|wiki-\d+)$/.test(id)) return json(400, { error: '片源编号无效' });
      try {
        const item = await resolveSource(id);
        const media = (item.media || []).map(m => ({ ...m, key: m.key || 'full', url: m.url || m.src, official: m.official || m.sourcePage, credit: m.credit || m.provider, license: m.licenseURL || (/^https:/.test(m.license || '') ? m.license : '') }));
        return json(200, { ...item, media });
      } catch (error) { console.error('resolve:', id, error.message); return json(502, { error: error.message || '当前片源暂不可用' }); }
    }

    if (route === 'vod-search') {
      const q = (params.q || '').trim();
      if (!q || q.length > 60) return json(400, { error: '请输入 1–60 字的片名' });
      try { return json(200, await searchVod(q)); }
      catch (error) { console.error('vod-search:', error.message); return json(502, { error: '片源检索暂不可用，请稍后重试' }); }
    }

    if (route === 'vod-item') {
      const id = params.id || '';
      if (!/^vod-[a-z0-9]+-\d+$/.test(id)) return json(400, { error: '片源编号无效' });
      try { return json(200, await fetchItemById(id)); }
      catch (error) { console.error('vod-item:', id, error.message); return json(502, { error: error.message || '这条线路暂时无法播放' }); }
    }

    if (route === 'vod-episode') {
      const id = params.id || '', key = params.key || '';
      if (!/^vod-[a-z0-9]+-\d+$/.test(id) || !/^(?:full|ep\d+)$/.test(key)) return json(400, { error: '片源编号无效' });
      try { return json(200, await resolveEpisodeById(id, key)); }
      catch (error) { console.error('vod-episode:', id, key, error.message); return json(502, { error: error.message || '该分集暂不可播放' }); }
    }

    if (route === 'scrape-status') return json(200, scrapeStatus());
    // 「继续刮削」：现抓一页上游片单并核验几条，交给浏览器本地累积（服务器无可写磁盘）。
    if (route === 'scrape-more') {
      const cursor = params.cursor || '0:2';
      if (!/^\d{1,2}:\d{1,5}$/.test(cursor)) return json(400, { error: '游标无效' });
      const take = Math.min(5, Math.max(1, Number(params.take || 3)));
      try { return json(200, await scrapeMore({ cursor, take })); }
      catch (error) { console.error('scrape-more:', error.message); return json(502, { error: '刮削暂时不可用，请稍后再试' }); }
    }
    // 静态站没有后台刮削器：启动/暂停都只是把当前片库状态回给页面，按钮不会报错。
    if (route === 'scrape-start' || route === 'scrape-stop') return json(200, scrapeStatus());

    if (route === 'scrape-browse') {
      const q = (params.q || '').trim(), kind = params.kind || 'all';
      const category = params.category || 'all', region = params.region || 'all';
      const page = Number(params.page || 1), limit = Number(params.limit || 24);
      if (q.length > 60 || !['all', 'movie', 'tv'].includes(kind) || !CATEGORIES.includes(category) || region.length > 12 || !Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 48) return json(400, { error: '片库查询参数无效' });
      return json(200, browse({ q, kind, category, region, page, limit }));
    }

    if (route === 'search') {
      const q = (params.q || '').trim();
      if (!q || q.length > 100) return json(400, { error: 'Expected a search query of 1–100 characters' });
      return json(200, await search(q, token));
    }

    return json(404, { error: 'Not found' });
  } catch (error) {
    console.error('api:', route, error.message);
    return json(502, { error: '服务暂时不可用，请稍后重试' });
  }
}
