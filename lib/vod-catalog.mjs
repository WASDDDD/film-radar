// 刮削公开片库：把各采集站的完整片单按页拉下来，逐条核验可播后并入本机片库。
// 只入库真正通过清单核验的条目；未核验的绝不展示。进度持久化到 scraped-catalog.json。
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';
import { __debug, PROVIDERS } from './vod-sources.mjs';

const { toItem, resolveEpisode, withMedia, norm, JUNK } = __debug;
const FILE = new URL('./scraped-catalog.json', import.meta.url);
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const MAX_ITEMS = Number(process.env.SCRAPE_MAX || 0);   // 0 = 不设上限，按上游片单一直刮
const PER_PAGE = 50;                                        // 每页拉取条数
const CONCURRENCY = 2;                                      // 每来源核验并发
const ADULT = /伦理|成人|情色|色情|三级|午夜|艳情|迷奸|诱惑|禁片|福利/i;
const SHORT = /短剧|漫剧|微短剧/i;                                   // 短剧/漫剧不入正式片库
const CATEGORY = [[/动画|动漫|番剧/i, '动漫'], [/真人秀|脱口秀|综艺|选秀/i, '综艺'], [/纪录片/i, '纪录'], [/体育|篮球|足球|运动/i, '体育']];
const AREA = [[/大陆|内地|中国$/, '中国'], [/香港|港/, '香港'], [/台湾|台$/, '台湾'], [/日本|日韩/, '日本'], [/韩国/, '韩国'], [/美国|欧美|英国|法国|德国|意大利|西班牙|加拿大|澳大利亚/, '欧美'], [/泰国|印度|新加坡|马来/, '亚洲其他']];
const SUFFIX = /(?:动画|动漫|国语|粤语|普通话|中字|双字|高清|超清|完整版|未删减|特别版|版|\d{2,4})$/u;

function base(t) { let s = norm(t); for (let i = 0; i < 4; i++) { const n = s.replace(SUFFIX, ''); if (n === s || !n) break; s = n; } return s; }

// 存储分两处：条目按行追加到 scraped-items.jsonl（每条一行，只增不改，片库变大也不变慢）；
// 游标与已见标题放 scraped-catalog.json 小文件，定时落盘。
const LINES = new URL('./scraped-items.jsonl', import.meta.url);
const META = FILE;

function load() {
  let meta = { cursor: {}, seen: [], updatedAt: '' };
  try { if (existsSync(META)) meta = { ...meta, ...JSON.parse(readFileSync(META, 'utf8')) }; } catch {}
  const items = [];
  if (existsSync(LINES)) {
    for (const line of readFileSync(LINES, 'utf8').split('\n')) {
      if (!line) continue;
      try { items.push(JSON.parse(line)); } catch {}
    }
  } else if (existsSync(META)) {
    try { const old = JSON.parse(readFileSync(META, 'utf8')); if (Array.isArray(old.items)) items.push(...old.items); } catch {}
  }
  return { items, cursor: meta.cursor || {}, seen: meta.seen || [], updatedAt: meta.updatedAt || '' };
}
const state = load();
const seen = new Set(state.seen);
let saving = 0, appended = 0;

// 追加一条：立即写盘，不重写历史。
function appendItem(item) {
  state.items.push(item);
  try { appendFileSync(LINES, JSON.stringify(item) + '\n'); appended++; } catch {}
}
// 元数据落盘（游标、已见集合）：2 秒防抖，文件很小。
function save() {
  clearTimeout(saving);
  saving = setTimeout(() => {
    state.seen = [...seen];
    state.updatedAt = new Date().toISOString();
    const body = JSON.stringify({ cursor: state.cursor, seen: state.seen, updatedAt: state.updatedAt });
    const tmp = `${META}.tmp`;
    try { writeFileSync(tmp, body); renameSync(tmp, META.pathname); } catch { try { writeFileSync(META, body); } catch {} }
  }, 2000);
}

async function listPage(provider, pg) {
  const url = `${provider.api}?ac=detail&pg=${pg}&pagesize=${PER_PAGE}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.list || [];
}

// 后台刮削状态
let running = false, stopFlag = false, added = 0, tried = 0, lastError = '';
let startedAt = 0, rateMark = {at: 0, items: 0, rate: 0};
const byProvider = () => { const out = {}; for (const x of state.items) out[x.vodProvider] = (out[x.vodProvider] || 0) + 1; return out; };
const byKind = () => { const out = {}; for (const x of state.items) out[x.kind] = (out[x.kind] || 0) + 1; return out; };
export function scrapeStatus() {
  const now = Date.now();
  if (rateMark.at && now - rateMark.at > 5000) {
    rateMark = { at: now, items: state.items.length, rate: Math.round(((state.items.length - rateMark.items) / (now - rateMark.at)) * 60000) };
  } else if (!rateMark.at) rateMark = { at: now, items: state.items.length, rate: 0 };
  return {
    running: running && !stopFlag, items: state.items.length, cap: MAX_ITEMS,
    added, tried, lastError, rate: rateMark.rate,
    startedAt, elapsed: running && startedAt ? Math.round((now - startedAt) / 1000) : 0,
    providers: byProvider(), kinds: byKind(),
    cursor: state.cursor, updatedAt: state.updatedAt,
  };
}
export function stopScraping() { stopFlag = true; return scrapeStatus(); }

// 核验并入库一条：与站内检索同样的门槛（ENDLIST、无 DRM、片长达标）。
async function ingest(provider, raw) {
  const item = toItem(provider, raw);
  if (!item) return null;
  if (ADULT.test(`${item.title} ${item.genres?.join(' ') || ''} ${item.summary || ''}`)) return null;
  if (JUNK.test(item.title)) return null;
  if ((item.genres || []).some(g => SHORT.test(g))) return null;      // 上游标了短剧/漫剧的直接跳过
  const key = `${base(item.title)}|${item.year}`;
  if (seen.has(key)) return null;
  seen.add(key);
  tried++;
  try {
    const resolved = await resolveEpisode(item.episodes[0], provider.id);
    if (!resolved) return null;
    const min = item.kind === 'tv' ? 600 : 1200;
    if (!(resolved.duration >= min)) return null;          // 正片门槛，短剧/试看不入库
    const full = withMedia(item, resolved);
    // 分集入口只留标题与按需解析的 key，控制库文件体积
    full.media = full.media.map(m => ({
      key: m.key, label: m.label, type: m.type, credit: m.credit, vodEpisode: m.vodEpisode,
      ...(m.url ? { url: m.url, expectedDuration: m.expectedDuration, width: m.width, height: m.height, verified: m.verified } : {}),
    }));
    full.episodes = undefined;
    full.region = AREA.find(([re]) => re.test(full.area || ''))?.[1] || '';
    full.category = CATEGORY.find(([re]) => (full.genres || []).some(g => re.test(g)))?.[1] || (full.kind === 'tv' ? '剧集' : '电影');
    full.actors = undefined;                                  // 演员表体积大且展示用不到，不落盘
    if (full.summary) full.summary = String(full.summary).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    return full;
  } catch (e) { lastError = `${provider.id}: ${e.message}`; return null; }
}

// 一次刮削会话：按来源轮流翻页，核验入库，直到达到上限或外部叫停。
export async function startScraping({ maxItems = MAX_ITEMS } = {}) {
  if (running) { stopFlag = false; return scrapeStatus(); }   // 还在收尾时点继续 = 撤销暂停，别丢掉这一轮
  running = true; stopFlag = false; added = 0; tried = 0; startedAt = Date.now(); rateMark = {at: Date.now(), items: state.items.length, rate: 0};
  const queue = PROVIDERS.filter(p => !['bdzy','p155'].includes(p.id)); // bdzy 无翻页接口；p155 片单基本是成人内容，只用于搜索不进刮削；iqiyi 纳入刮削
  try {
    const capped = () => maxItems > 0 && state.items.length >= maxItems;
    outer: while (!stopFlag && !capped()) {
      for (const provider of queue) {
        if (stopFlag || capped()) break outer;
        const pg = (state.cursor[provider.id] || 1);
        let rows = [];
        try { rows = await listPage(provider, pg); }
        catch (e) { lastError = `${provider.id} p${pg}: ${e.message}`; state.cursor[provider.id] = pg + 1; continue; }
        state.cursor[provider.id] = pg + 1;
        if (!rows.length) { state.cursor[provider.id] = 1; continue; }   // 走完一轮从头再来（上游片单会更新）
        const fresh = rows.filter(raw => { const item = toItem(provider, raw); return item && !seen.has(`${base(item.title)}|${item.year}`); });
        // 逐条核验（并发受控），通过即入库
        const jobs = fresh.slice(0, 20).map(raw => () => ingest(provider, raw));
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
          while (i < jobs.length) {
            const at = i++;
            const got = await jobs[at]();
            if (got) { appendItem(got); added++; save(); }
          }
        }));
        save();
        await new Promise(r => setTimeout(r, 400));        // 翻页之间歇一拍，别把上游打急了
      }
    }
  } finally { running = false; save(); }
  return scrapeStatus();
}

// 浏览已入库片库：支持关键词与类型过滤、分页。
export function browse({ q = '', kind = 'all', category = 'all', region = 'all', page = 1, limit = 24 } = {}) {
  const term = norm(q);
  const rows = state.items.filter(x =>
    (kind === 'all' || x.kind === kind) &&
    (category === 'all' || x.category === category) &&
    (region === 'all' || x.region === region) &&
    (!term || norm(x.title).includes(term) || norm(x.original || '').includes(term)));
  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const p = Math.min(Math.max(1, page), pages);
  // 分类计数，供前端展示分类标签
  const facets = { category: {}, region: {}, kind: {} };
  for (const x of state.items) {
    if (x.category) facets.category[x.category] = (facets.category[x.category] || 0) + 1;
    if (x.region) facets.region[x.region] = (facets.region[x.region] || 0) + 1;
    facets.kind[x.kind] = (facets.kind[x.kind] || 0) + 1;
  }
  return {
    total: rows.length, page: p, pages, facets,
    items: rows.slice((p - 1) * limit, (p - 1) * limit + limit),
    updatedAt: state.updatedAt,
  };
}
