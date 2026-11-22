// 豆瓣评分查询。
// 采用两跳（movie.douban.com 的 j/ 接口，无需登录、比 rexxar 稳）：
//   1) https://movie.douban.com/j/subject_suggest?q=<片名>   -> [{id,title,year,type,sub_title}]
//   2) https://movie.douban.com/j/subject_abstract?subject_id=<id> -> {subject:{rate:"9.0", star:4.5, title, release_year,...}}
// 豆瓣对本机 IP 抓取敏感：突发多次会 403。因此：
//   - 全局串行 + 最小请求间隔（默认 1.3s）
//   - 触发 403/429 时熔断一段时间（默认 90s），期间只读缓存不请求
//   - 有评分永久缓存；确实无匹配缓存 12h；网络错误不缓存
// 缓存落盘到项目根目录 douban-cache.json。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = fileURLToPath(new URL('../douban-cache.json', import.meta.url));
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const NEG_TTL = 12 * 3600 * 1000;
const MIN_INTERVAL = Number(process.env.DOUBAN_INTERVAL_MS || 1300);
const BLOCK_MS = Number(process.env.DOUBAN_BLOCK_MS || 90000);

let cache = new Map();
let loaded = false;
let dirty = false;
let saveTimer = 0;
let lastReq = 0;
let blockedUntil = 0;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) cache.set(k, v);
  } catch { /* 首次运行没有缓存文件正常 */ }
}

function saveSoon() {
  if (saveTimer) return;
  dirty = true;
  saveTimer = setTimeout(async () => {
    saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    try {
      const obj = {}, now = Date.now();
      for (const [k, v] of cache) {
        if (v && v.rating) obj[k] = v;
        else if (v && v.ts && now - v.ts < NEG_TTL) obj[k] = v;
      }
      await writeFile(CACHE_FILE, JSON.stringify(obj));
    } catch { /* 写盘失败不影响内存缓存 */ }
  }, 1000);
}

const ZERO = /[\u200b\u200e\u200f\ufeff]/g;
function clean(s) { return String(s || '').replace(ZERO, '').replace(/\s+/g, ' ').trim(); }
function nm(s) {
  return clean(s).toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/第[一二三四五六七八九十百0-9]+[季部期]/g, '')
    .replace(/[(（\[].*?[)）\]]/g, '')
    .replace(/[·・:：\-—_.,，。!！?？'"“”‘’《》]/g, '');
}
function yearOf(v) { const n = Number(String(v || '').match(/\d{4}/)?.[0]); return Number.isFinite(n) ? n : 0; }
const VERSION_RE = /(美版|日版|韩版|港版|台版|泰版|越版|翻拍|剧场版|电影版|特别版|重制|动画版|动漫版)/;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function politeWait() {
  if (Date.now() < blockedUntil) throw new Error('douban-cooling');
  const wait = lastReq + MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://movie.douban.com/', 'Accept': 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(9000),
  });
  if (res.status === 403 || res.status === 429) { blockedUntil = Date.now() + BLOCK_MS; throw new Error('douban-403'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.headers.get('content-type')?.includes('json')) return res.json();
  const text = await res.text();
  return JSON.parse(text);
}

function pickSuggest(list, title, year) {
  const q = nm(title), y = yearOf(year), rawTitle = clean(title);
  const qHasVer = VERSION_RE.test(rawTitle);
  let best = null, bestScore = 0;
  for (const it of list || []) {
    const rawC = clean(it.title || it.sub_title);
    const ct = nm(rawC);
    if (!ct || !it.id) continue;
    let score = 0;
    if (ct === q) score += 100;
    else if (ct.startsWith(q) || q.startsWith(ct)) score += 50;
    else if (ct.includes(q) || q.includes(ct)) score += 25;
    else continue;
    const cy = yearOf(it.year);
    if (y && cy) score += cy === y ? 30 : -Math.min(20, Math.abs(cy - y));
    else if (cy) score += 5;
    if (rawC === rawTitle) score += 40;
    if (!qHasVer && VERSION_RE.test(rawC)) score -= 60;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 50 ? best : null;
}

async function lookupOne(title, year) {
  const q = clean(title);
  if (!q) return { skip: true };
  await politeWait();
  const list = await fetchJson(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`);
  // 空列表可能不是"没有这片"，而是被豆瓣软限流返回空——按瞬时错误处理，不写负缓存。
  if (!Array.isArray(list) || list.length === 0) throw new Error('douban-empty');
  const cand = pickSuggest(list, q, year);
  if (!cand) return null; // 有返回但都不匹配 -> 确实没有，负缓存
  await politeWait();
  const ab = await fetchJson(`https://movie.douban.com/j/subject_abstract?subject_id=${encodeURIComponent(cand.id)}`);
  const s = (ab && ab.subject) || {};
  const rate = clean(s.rate);
  const rating = rate && rate !== '0' && rate !== '0.0' ? rate : '';
  return {
    rating,
    votes: 0,
    doubanId: String(cand.id),
    matched: clean(s.title || cand.title || ''),
    matchedYear: clean(s.release_year || cand.year || ''),
  };
}

// entries: [{t, y}] 或 [{title, year}]。串行查询，返回 [{t, year, rating, votes, doubanId, matched, matchedYear}]
async function doFetch(entries) {
  await ensureLoaded();
  const out = [];
  const now = Date.now();
  for (const e of entries || []) {
    const title = clean(e.t || e.title || '');
    if (!title) continue;
    const year = String(e.y || e.year || '').trim();
    const key = `${title}|${year}`;
    const hit = cache.get(key);
    if (hit && (hit.rating || (hit.ts && now - hit.ts < NEG_TTL))) { out.push({ t: title, year, ...hit }); continue; }
    let val, ok = true;
    try {
      const r = await lookupOne(title, year);
      if (r && r.skip) continue;
      val = r ? { rating: r.rating, votes: r.votes, doubanId: r.doubanId, matched: r.matched, matchedYear: r.matchedYear, ts: Date.now() }
              : { rating: '', votes: 0, doubanId: '', matched: '', matchedYear: '', ts: Date.now() };
    } catch {
      ok = false;
      val = { rating: '', votes: 0, doubanId: '', matched: '', matchedYear: '', ts: Date.now(), pending: true };
    }
    if (ok) { cache.set(key, val); saveSoon(); }
    out.push({ t: title, year, ...val });
  }
  return out;
}

// 全局串行锁：多个请求（前端批量 / 后台预热）排队执行，避免并发把豆瓣 IP 刷封。
let chain = Promise.resolve();
export function fetchDoubanRatings(entries) {
  const task = chain.then(() => doFetch(entries));
  chain = task.then(() => {}, () => {});
  return task;
}
