// 通用影视检索：公开 CMS 采集接口 + 清单级完整性核验 + 画质实测。
// 只返回“清单可完整播放”的条目：VOD 型 ENDLIST、无 DRM 加密、片长合理、分片可取；
// 每条都会探测同目录的多个码率子路径，用分片首包的 H.264 SPS 实测真实分辨率，取最高一档。
import {spsSize} from './sps.mjs';

// 各来源的速度差别很大：快的 1 秒内返回，慢的经常 5–15 秒甚至超时。
// timeout 是单次请求上限，deadline 是这个来源最多能占用检索的总时间。
const ALL_PROVIDERS = [
  // 实测：非凡/无尽 0.2–1.5s 就能回；魔都首次连接常 5–8s、重试立刻回；北斗常 6–15s 超时。
  {id:'ffzy', name:'非凡资源', api:'https://api.ffzyapi.com/api.php/provide/vod/', timeout: 4000, attempts: 2, deadline: 9000},
  {id:'wujin', name:'无尽资源', api:'https://api.wujinapi.com/api.php/provide/vod/', timeout: 4000, attempts: 2, deadline: 9000},
  {id:'modu', name:'魔都资源', api:'https://caiji.moduapi.cc/api.php/provide/vod/', timeout: 9000, attempts: 2, deadline: 18000},
  {id:'bdzy', name:'北斗资源', api:'https://api.apibdzy.com/api.php/provide/vod/', timeout: 7000, attempts: 2, deadline: 13000},
  // 高清补充源（2026-11-23 实测）：爱奇艺多部电影直出 4K/1080P；155 多部剧集稳定 1080P。
  {id:'iqiyi', name:'爱奇艺资源', api:'https://iqiyizyapi.com/api.php/provide/vod', timeout: 5000, attempts: 2, deadline: 10000},
  {id:'p155', name:'155资源', api:'https://155api.com/api.php/provide/vod', timeout: 6000, attempts: 2, deadline: 14000},
  // 2026-11-23 从 GitHub 找到并实测：4KVM 电影多为真 1080P（部分 4K），但剧集只给第 1 集，按「电影」类型过滤；
  // 暴风资源新域名 bfzy1 的 1080P 比例也高于老站，补电影/剧集检索。
  {id:'4kvm', name:'4KVM', api:'https://4kvm.alonglfb.com', timeout: 5000, attempts: 2, deadline: 12000, adapter:'4kvm'},
  {id:'bfzy', name:'暴风资源', api:'https://bfzy1.tv/api.php/provide/vod/', timeout: 5000, attempts: 2, deadline: 10000},
];
// 部署到 Serverless（Netlify 函数 10 秒上限）时用环境变量收紧：VOD_PROVIDERS=ffzy,wujin 与 VOD_DEADLINE_CAP=4000
const ONLY = String(process.env.VOD_PROVIDERS || '').split(',').map(s=>s.trim()).filter(Boolean);
const DEADLINE_CAP = Number(process.env.VOD_DEADLINE_CAP || 0);
const PROVIDERS = ALL_PROVIDERS
  .filter(p => !ONLY.length || ONLY.includes(p.id))
  .map(p => DEADLINE_CAP > 0 ? {...p, deadline: Math.min(p.deadline, DEADLINE_CAP), timeout: Math.min(p.timeout, DEADLINE_CAP), attempts: 1} : p);
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const JUNK = /解说|预告|花絮|片花|特辑|混剪|剪辑|漫剧|短剧|抢先看|彩蛋|幕后|OST|主题曲|片段/i;
// 常见码率子目录：主清单往往只写一档低码率，真正的高清档挂在同目录的固定路径下。
// 每个来源的目录结构固定，只探它自己的命名，避免无谓请求。
const VARIANT_PATHS = {
  ffzy: ['3000k/hls/mixed.m3u8', '2000k/hls/mixed.m3u8', '4000k/hls/mixed.m3u8'],
  wujin: ['2000k_1080/hls/index.m3u8', '3000k_1080/hls/index.m3u8', '1000k_720/hls/index.m3u8'],
  modu: ['2000kb/hls/index.m3u8', '3000kb/hls/index.m3u8', '1500kb/hls/index.m3u8'],
  bdzy: [],
  iqiyi: [],
  p155: [],
  '4kvm': [],
  bfzy: [],
};
const DEFAULT_VARIANTS = ['2000k/hls/mixed.m3u8', '2000kb/hls/index.m3u8', '2000k_1080/hls/index.m3u8'];
const cache = new Map();
const CACHE_MS = 10 * 60_000;
// 一次检索的总预算：慢来源（魔都/北斗常 5–15s）超时后不再等待，先用已核验的结果出页面。
const SEARCH_BUDGET_MS = Number(process.env.VOD_BUDGET || 20000);

const clean = v => String(v ?? '').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const httpsUrl = v => { const s = String(v ?? '').trim(); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ''; };
const norm = v => String(v ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}]+/gu,'');

async function getText(url, {timeout = 12000, referer = ''} = {}) {
  const res = await fetch(url, {
    headers: {'User-Agent': UA, Accept: '*/*', ...(referer ? {Referer: referer} : {})},
    signal: AbortSignal.timeout(timeout), redirect: 'follow',
  });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (/json/.test(type)) return await res.text();
  // 限制读取量，避免误抓超大文件
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks = []; let size = 0;
  while (size < 3_000_000) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value); size += value.byteLength;
  }
  try { await reader.cancel(); } catch {}
  return Buffer.concat(chunks).toString('utf8');
}
async function getBytes(url, bytes = 131072, timeout = 12000) {
  const res = await fetch(url, {
    headers: {'User-Agent': UA, Range: `bytes=0-${bytes - 1}`},
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try { await res.body?.cancel(); } catch {}
  return buf;
}
// 采集站偶发断连／超时，统一重试两次。
async function retry(fn, times = 2) {
  let last;
  for (let i = 0; i < times; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 250)); }
  }
  throw last;
}
// 给整段工作设上限：慢来源拖过头就直接放弃，不让它拖住整个检索。
const within = (ms, promise) => Promise.race([
  promise.catch(() => null),
  new Promise(r => setTimeout(() => r(null), ms)),
]);

// 采集接口返回的播放地址：优先直连 m3u8 组，其次把 /share/ 页面解析成 m3u8。
function directStreams(item) {
  const froms = String(item.vod_play_from || '').split('$$$');
  const groups = String(item.vod_play_url || '').split('$$$');
  let best = null;
  groups.forEach((group, i) => {
    const eps = group.split('#').map(part => {
      const at = part.indexOf('$');
      const label = at > 0 ? part.slice(0, at) : `第${epsIndex(part)}集`;
      const link = at > 0 ? part.slice(at + 1) : part;
      return {label: clean(label), link: link.trim()};
    }).filter(ep => /^https?:\/\//i.test(ep.link));
    if (!eps.length) return;
    const score = (/m3u8/i.test(froms[i] || '') ? 2 : 0) + (eps.every(ep => /\.m3u8(?:[?#]|$)/i.test(ep.link)) ? 2 : 0);
    if (!best || score > best.score) best = {score, eps};
  });
  return best ? best.eps : [];
}
function epsIndex(s) { const m = /第?\s*(\d+)/.exec(s); return m ? m[1] : '1'; }

async function shareToStream(link) {
  const page = await getText(link, {timeout: 10000});
  const m = /const\s+url\s*=\s*["']([^"']+\.m3u8[^"']*)["']/.exec(page);
  if (!m) return '';
  const base = new URL(link);
  return httpsUrl(new URL(m[1].replace(/^\/\//, `${base.protocol}//`), base).href);
}

// 读一张清单：主清单按带宽挑最高几档子清单，媒体清单校验 ENDLIST/加密/片长，
// 再取首个分片的前 256KB 解析 SPS，得到真实分辨率。
async function measurePlaylist(url, depth = 0) {
  if (depth > 2) return null;
  let text;
  try { text = await getText(url, {timeout: 7000}); } catch { return null; }
  if (!/^#EXTM3U/.test(text.trim())) return null;
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]);
      if (!m) continue;
      const bw = Number((/BANDWIDTH=(\d+)/.exec(m[1]) || [])[1] || 0);
      const uri = lines.slice(i + 1).find(l => !l.startsWith('#'));
      if (uri) variants.push({bw, uri});
    }
    variants.sort((a, b) => b.bw - a.bw);
    const got = [];
    for (const v of variants.slice(0, 3)) {
      const r = await measurePlaylist(new URL(v.uri, url).href, depth + 1);
      if (r) got.push(r);
    }
    got.sort((a, b) => b.width * b.height - a.width * a.height);
    return got[0] || null;
  }
  const durations = [...text.matchAll(/#EXTINF:\s*([\d.]+)/g)].map(m => Number(m[1]));
  if (!durations.length) return null;
  if (!/#EXT-X-ENDLIST/.test(text)) return null;
  const keys = [...text.matchAll(/#EXT-X-KEY:([^\n]*)/g)].map(m => m[1]);
  if (keys.some(k => /SAMPLE-AES|widevine|playready|fairplay/i.test(k))) return null;
  const first = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (!first) return null;
  let buf;
  try { buf = await getBytes(new URL(first, url).href, 131072, 8000); } catch { return null; }
  if (!buf || buf.length < 1024) return null;
  const size = spsSize(buf) || {};
  return {
    url, duration: Math.round(durations.reduce((a, b) => a + b, 0) * 100) / 100,
    segments: durations.length, width: size.width || 0, height: size.height || 0,
  };
}

// 清单实测结果缓存：同一集反复点播、同一部片反复检索都不必重新探测。
const measured = new Map();
const MEASURED_MS = 10 * 60_000;
function cacheGet(url) { const hit = measured.get(url); return hit && hit.until > Date.now() ? hit.value : null; }
function cacheSet(url, value) {
  if (measured.size >= 600) measured.delete(measured.keys().next().value);
  measured.set(url, {until: Date.now() + MEASURED_MS, value});
  return value;
}

// 主清单与同目录的高码率子路径一起测，取分辨率最高的一档。
// 串行探测会让最慢的来源拖到 20 秒以上，并起来只花最慢那一次的时间。
export async function bestStream(link, providerId = '') {
  const base = httpsUrl(link);
  if (!base) return null;
  const cached = cacheGet(base);
  if (cached) return cached;
  const dir = base.replace(/\/[^/]*\.m3u8.*$/i, '');
  const paths = VARIANT_PATHS[providerId] || DEFAULT_VARIANTS;
  const cands = dir !== base ? paths.map(p => `${dir}/${p}`) : [];
  const [main, ...rest] = await pool([base, ...cands], 8, async u => {
    try { return await measurePlaylist(u); } catch { return null; }
  });
  const found = rest.filter(Boolean);
  // 同目录下的高码率路径有时挂的是预告片或花絮（几百 KB 的清单），
  // 片长必须和主清单对得上才算同一部正片。
  const same = main && main.duration
    ? found.filter(x => Math.abs(x.duration - main.duration) <= Math.max(30, main.duration * 0.05))
    : found;
  if (main) same.push(main);
  if (!same.length) return cacheSet(base, null);
  same.sort((a, b) => b.width * b.height - a.width * a.height || b.duration - a.duration);
  return cacheSet(base, same[0]);
}

// 兼容旧接口：返回是否可完整播放 + 片长 + 实测分辨率（取最高档）。
export async function inspectStream(url) {
  const best = await bestStream(url);
  if (!best) return {ok: false, reason: '清单不可完整播放'};
  return {ok: true, duration: best.duration, segments: best.segments, width: best.width, height: best.height, stream: best.url};
}

async function resolveEpisode(ep, providerId = '') {
  let stream = /\.m3u8(?:[?#]|$)/i.test(ep.link) ? httpsUrl(ep.link) : '';
  if (!stream && /\/share\//.test(ep.link)) stream = await shareToStream(ep.link);
  if (!stream) return null;
  const best = await bestStream(stream, providerId);
  if (!best) return null;
  return {stream: best.url, duration: best.duration, width: best.width, height: best.height};
}

// 并发映射，限制同时进行的核验数量，避免手机网络被打满。
async function pool(items, size, run) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (i < items.length) { const at = i++; out[at] = await run(items[at], at); }
  }));
  return out;
}

// 4KVM 是自定义 JSON（sources[].episodes[]），先转成 MacCMS 的 vod_play_from / vod_play_url。
function normalizeFourKvm(raw) {
  const sources = Array.isArray(raw?.sources) ? raw.sources : [];
  const froms = [], groups = [];
  for (const src of sources) {
    const eps = (Array.isArray(src?.episodes) ? src.episodes : [])
      .map((e, i) => {
        const url = String(e?.url || '').trim();
        return /^https?:\/\//i.test(url) ? `${clean(e?.name || `第${i + 1}集`)}$` + url : '';
      })
      .filter(Boolean);
    if (!eps.length) continue;
    froms.push(clean(src.sourceName || '4KVM'));
    groups.push(eps.join('#'));
  }
  return {
    ...raw,
    vod_id: raw.id ?? raw.vod_id,
    vod_name: raw.name ?? raw.vod_name,
    vod_year: raw.year ?? raw.vod_year,
    vod_pic: raw.pic ?? raw.vod_pic,
    vod_score: raw.rating ?? raw.vod_score,
    vod_remarks: raw.remarks ?? raw.vod_remarks,
    vod_actor: raw.actor ?? raw.vod_actor,
    vod_director: raw.director ?? raw.vod_director,
    vod_class: raw.type_name ?? raw.vod_class,
    vod_content: raw.content ?? raw.vod_content,
    vod_play_from: froms.join('$$$'),
    vod_play_url: groups.join('$$$'),
  };
}

function toItem(provider, raw) {
  if (provider.adapter === '4kvm') {
    if (clean(raw?.type_name) !== '电影') return null;   // 剧集只给第 1 集，不能当剧集源
    raw = normalizeFourKvm(raw);
  }
  const eps = directStreams(raw);
  if (!eps.length) return null;
  const title = clean(raw.vod_name);
  if (!title) return null;
  const kind = eps.length > 1 ? 'tv' : 'movie';
  const yearRaw = String(raw.vod_year || '').trim();
  const year = /^(?:19|20)\d{2}$/.test(yearRaw) ? yearRaw : '';
  const genres = clean(raw.vod_class).split(/[,，/]/).map(clean).filter(Boolean).slice(0, 4);
  return {
    id: `vod-${provider.id}-${raw.vod_id}`, title,
    original: clean(raw.vod_sub).split('/')[0].trim(),
    year, kind, genres,
    poster: httpsUrl(raw.vod_pic),
    summary: clean(raw.vod_blurb || raw.vod_content).slice(0, 400),
    score: Number(raw.vod_score) > 0 ? String(raw.vod_score) : '',
    duration: kind === 'tv' ? `${eps.length} 集` : '',
    remarks: clean(raw.vod_remarks),
    area: clean(raw.vod_area), lang: clean(raw.vod_lang),
    director: clean(raw.vod_director), actors: clean(raw.vod_actor),
    sourceProvider: provider.name, vod: true, vodProvider: provider.id,
    episodes: eps.map((ep, index) => ({key: `ep${index + 1}`, label: ep.label, link: ep.link})),
  };
}

// 判断标题是否为第 n 季：支持「第2季／第二季／第2部」与结尾数字，忽略国语粤语等版本后缀。
function seasonOf(title, n) {
  const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  const t = norm(title).replace(/(?:动画|动漫|国语|粤语|普通话|中字|双字|高清|超清|完整版|未删减|特别版|版)+$/u, '');
  return t.includes(`第${n}季`) || t.includes(`第${CN[n]}季`) || t.includes(`第${n}部`) || t.includes(`第${CN[n]}部`) || t.endsWith(String(n));
}

// 把核验结果写进 media：第一集带直链与实测片长，其余集只带按需解析的入口。
function withMedia(item, resolved) {
  const media = item.episodes.slice(0, 60).map((ep, i) => ({
    key: i === 0 ? 'full' : `ep${i + 1}`, label: ep.label, type: 'application/vnd.apple.mpegurl',
    credit: `来源：${item.sourceProvider}`, vodEpisode: ep.link,
    ...(i === 0 ? {
      url: resolved.stream, expectedDuration: resolved.duration,
      width: resolved.width, height: resolved.height,
      verified: '2026-11-21 清单核验',
    } : {}),
  }));
  return {
    ...item, media,
    width: resolved.width, height: resolved.height,
    resolution: label(resolved),
  };
}

const pixels = x => (x.width || 0) * (x.height || 0);
const label = x => {
  const w = x.width || 0, h = x.height || 0;
  const short = Math.min(w, h), long = Math.max(w, h);
  if (!short) return '';
  if (long >= 3400) return '4K';
  if (long >= 2400) return '1440P';
  if (short >= 1060) return '1080P';
  if (short >= 700) return '720P';
  return `${short}P`;
};

export const __debug = {toItem, resolveEpisode, measurePlaylist, PROVIDERS, norm, withMedia, JUNK};

export async function searchVod(query, {limit = 40} = {}) {
  const q = clean(query).slice(0, 60);
  if (!q) return {ok: true, items: [], note: '请输入片名'};
  const key = norm(q);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.data;

  // “片名+年份”（西游记1986）与“片名+季数”（庆余年2、庆余年 第二季）这类查询，
  // 上游整串搜不到，必须先按片名检索，再用年份／季数过滤。
  const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  let term = q, yearHint = '', seasonHint = '';
  const yearMatch = /^(.*?)((?:19|20)\d{2})$/u.exec(q);
  if (yearMatch && /[\u4e00-\u9fa5a-z]/iu.test(yearMatch[1])) { term = yearMatch[1].trim(); yearHint = yearMatch[2]; }
  else {
    const seasonMatch = /^(.*?)(?:第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[季部]|\s*S0?([0-9]{1,2})|\s*([0-9]{1,2}))$/u.exec(q);
    if (seasonMatch && /[\u4e00-\u9fa5a-z]/iu.test(seasonMatch[1])) {
      const raw = seasonMatch[2] || seasonMatch[3] || seasonMatch[4] || '';
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : CN_NUM.indexOf(raw);
      if (n >= 1 && n <= 20) { term = seasonMatch[1].trim(); seasonHint = String(n); }
    }
  }

  // 名称完全一致优先，其次正片而非“同名衍生”，再看年份与评分。
  // 版本后缀（动画／国语／粤语／年份等）不影响“就是这一部”的判断，但仍排在完全同名之后。
  const SUFFIX = /(?:动画|动漫|国语|粤语|普通话|中字|双字|高清|超清|完整版|未删减|特别版|版|\d{2,4})$/u;
  const base = t => { let s = norm(t); for (let i = 0; i < 4; i++) { const n = s.replace(SUFFIX, ''); if (n === s || !n) break; s = n; } return s; };
  // 季数标记：「第N季/第N部」或结尾单个数字（欢乐颂2、大江大河2、庆余年2）。
  // 结尾数字前必须是非数字，避免把年份（繁花1990、欢乐颂2019）当成季数。
  const SEASONED = /(?:第\s*(?:[0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[季部]|(?:^|[^0-9])[1-9]$)/u;
  const exact = x => {
    const t = norm(x.title);
    if (t === key) return 4;
    if (base(x.title) === key) return 3;
    if (norm(x.original) === key) return 3;
    if (seasonHint && norm(x.title).startsWith(norm(term))) return 3;   // 指定了季数，同名不同季按片名计
    // 搜基础名时，「片名 + 第N季/第N部」是同一系列的正当条目，不是衍生，按片名同级计。
    // 这样搜《X》时《X第二季》不会被下面的「完全同名优先」收敛当成衍生砍掉。
    if (!seasonHint && SEASONED.test(x.title) && t.startsWith(key)) return 3;
    return t.startsWith(key) ? 2 : 1;
  };
  // “某某之XX”“某某小厨娘”这类比查询多出 3 个字以上的，几乎都是同名短剧或衍生；带季数标记的除外。
  // 结尾数字后还带短后缀（如「一路繁花2 粤语版」）也算季数标记，先剥后缀再判。
  const seasonMarked = x => norm(x.title).startsWith(key) && (SEASONED.test(x.title) || SEASONED.test(norm(x.title).replace(/(?:国语|粤语|普通话|中字|双字|高清|完整版|网络版|特别版|版)+$/u, '')));
  const derived = x => !seasonHint && !seasonMarked(x) && norm(x.title).length - key.length > 2 ? 1 : 0;
  const VARIANT = /(?:粤语|国语|中字|双字|繁体)/u;
  const variant = x => VARIANT.test(x.title) && !VARIANT.test(q) ? 1 : 0;

  // 每个来源检索完立刻核验它自己的候选，不必等最慢的来源返回，整体耗时由最慢那一家决定。
  // 上游检索对片名的标点和长度很挑剔（「你好李焕英」搜不到、加个逗号才有），
  // 所以按「原词 → 去标点 → 末尾 3 字 → 开头 3 字」依次兜底，命中即停。
  const plain = term.replace(/[，,。.、·:：!！?？\s《》"'“”]/gu, '');
  const terms = [...new Set([term, plain, plain.slice(-3), plain.slice(0, 3)].filter(t => t && t.length >= 2))];
  const settled = [];
  const perSource = await Promise.race([
    pool(PROVIDERS, 4, async provider => {
    const ask = async t => {
      try {
        const url = provider.adapter === '4kvm'
          ? `${provider.api}/api/vod?wd=${encodeURIComponent(t)}`
          : `${provider.api}?ac=detail&wd=${encodeURIComponent(t)}`;
        const text = await within(provider.deadline, retry(
          () => getText(url, {timeout: provider.timeout}), provider.attempts || 2));
        const parsed = text ? JSON.parse(text) : null;
        const list = parsed?.list || parsed?.data?.list;
        return Array.isArray(list) && list.length ? {...parsed, list} : null;
      } catch { return null; }
    };
    // 兜底词并发发出并合并结果：只取「最先返回的那个」会漏掉真正的片名
    // （「你好李」先回「你好李国庆」，「李焕英」才回《你好，李焕英》）。
    let found = [];
    const first = await ask(terms[0]);
    if (first) found.push(first);
    if (!found.length && terms.length > 1) found = (await Promise.all(terms.slice(1).map(ask))).filter(Boolean);
    if (!found.length) return [];
    const seenId = new Set();
    const data = {list: found.flatMap(d => d.list).filter(raw => {
      if (seenId.has(raw.vod_id)) return false;
      seenId.add(raw.vod_id);
      return true;
    })};
    const rows = [];
    for (const raw of Array.isArray(data.list) ? data.list : []) {
      const item = toItem(provider, raw);
      if (!item) continue;
      if (JUNK.test(item.title) && !JUNK.test(q)) continue;
      const k = (yearHint || seasonHint) ? norm(term) : key;
      if (!norm(item.title).includes(k) && !norm(item.original).includes(k)) continue;
      if (yearHint && item.year && item.year !== yearHint) continue;
      if (seasonHint && !seasonOf(item.title, seasonHint)) continue;
      rows.push(item);
    }
    if (!rows.length) return [];
    if (process.env.VOD_DEBUG) console.error('[rows]', provider.id, rows.length, rows.map(x => `${x.title}/${x.year}`).join(','));
    // 同一档内先看评分再看年份：搜《西游记》时 86 版（9.7 分）才是正主，
    // 只按年份倒序会把 2010 年的动画版顶到第一张卡。
    rows.sort((a, b) => exact(b) - exact(a) || variant(a) - variant(b) || derived(a) - derived(b) ||
      Number(b.score || 0) - Number(a.score || 0) || String(b.year).localeCompare(String(a.year)));
    // 命中正片时丢掉“片名加长”的衍生条目（如搜《狂飙》里的《狂飙之浴血玫瑰》），避免挤占名额。
    // 有完全同名条目时更严格：只留完全同名（同年份）的，别让《繁花1990》《繁花错》占卡位。
    // 放宽：只要是「片名开头」的相关条目（含各季、各语言版、带后缀的衍生）全部保留，
    // 不再因为存在一条完全同名就把其余砍掉；相关度只在排序时降权，不在这里删除。
    const keep = rows.filter(x => norm(x.title).startsWith(key) || norm(x.original).startsWith(key));
    // 同一来源内的重复条目才算镜像，直接去掉。
    const seen = new Set();
    const picks = [];
    for (const x of keep) {
      const k = `${norm(x.title)}|${x.year}`;
      if (seen.has(k)) continue;
      seen.add(k);
      picks.push(x);
      if (picks.length >= 10) break;  // 每个来源最多 10 部，尽量把相关资源列全
    }
    if (process.env.VOD_DEBUG) console.error('[picks]', provider.id, picks.map(x => `${x.title}/${x.year}`).join(','));
    // 逐条核验：每部只验第一集，失败就丢弃，绝不把未验证条目返回给页面。
    const verifiedHere = (await pool(picks, 2, async item => {
      const first = item.episodes[0];
      const resolved = await within(16000, resolveEpisode(first, item.vodProvider));
      if (process.env.VOD_DEBUG) console.error('[verify]', item.vodProvider, item.title, resolved ? `${resolved.width}x${resolved.height} ${resolved.duration}` : 'FAIL');
      if (!resolved) return null;
      // 正片门槛：单集短于 10 分钟或电影短于 20 分钟的一律视为短剧/切片，不展示。
      if (item.kind === 'tv' && resolved.duration < 600) return null;
      if (item.kind === 'movie' && resolved.duration < 1200) return null;
      return {...withMedia(item, resolved), rank: exact(item)};
    })).filter(Boolean);
      settled.push(...verifiedHere);   // 谁先验完谁先入库，慢来源超预算也不会拖住整页
      return verifiedHere;
    }),
    new Promise(resolve => setTimeout(() => resolve(null), SEARCH_BUDGET_MS)),
  ]);
  void perSource;

  // 各来源分开过滤时，某一家可能只回了《繁花1990》这类同名衍生，而正片在别家。
  // 所以合并后再做一次全局收敛：只要有一部完全同名，就把「查询词+后缀」的衍生卡去掉，
  // 语言版（国语/粤语）与季数版（第二季）保留，它们确实是同一部片的不同线路。
  // 放宽：合并各来源后不再剔除同名衍生，全部交给下面的分组与排序处理，
  // 用户搜一个片名就能看到它的各季、各版本与各家线路。
  let verified = settled.flat().filter(Boolean);

  // 同一部片常有多个镜像与多个来源：按「片名+年份」合并，保留画质最好（剧集则集数最多）的一份，
  // 其余来源作为备用线路挂在 alt 上，主线路失效时可切换。
  // 分组键：片名 + 年份。年份为空的条目补上同名条目的年份，
  // 否则《现在就出发》会因为一条没标年份而裂成两张一模一样的卡。
  const yearOf = new Map();
  for (const item of verified) {
    const b = base(item.title);
    if (item.year && !yearOf.has(b)) yearOf.set(b, item.year);
  }
  const groups = new Map();
  for (const item of verified) {
    const b = base(item.title);
    const y = item.year || yearOf.get(b) || '';
    const k = `${b}|${y}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  const unique = [];
  for (const list of groups.values()) {
    // 画质优先：同一部片有多家线路时，先选实测像素最高的（1080P/4K 压过 720P），
    // 画质相同再比集数、评分。此前剧集按集数优先，会让集数多的 720P 源顶掉 1080P 源。
    list.sort((a, b) =>
      pixels(b) - pixels(a) ||
      (b.kind === 'tv' ? b.media.length - a.media.length : 0) ||
      Number(b.score || 0) - Number(a.score || 0));
    // 组内可能有「国语版／粤语版」这类同名不同语言的线路：主线路取像素最高的那条。
    const [win, ...rest] = list;
    const alt = rest.slice(0, 3).map(x => ({
      id: x.id, provider: x.sourceProvider, resolution: x.resolution || '',
      width: x.width || 0, height: x.height || 0, kind: x.kind,
      duration: x.media[0]?.expectedDuration || 0,
      note: norm(x.title) === norm(win.title) ? '' : x.title,
    }));
    unique.push({...win, alt});
  }
  // 同名作品里如果有一条画质明显更好（像素不到它的 60%），把差的那条降一档相关度。
  // 否则搜《西游记》会先看到魔都那条 432P，而 86 版和动画版都是 720P/1080P。
  const bestOf = new Map();
  for (const x of unique) {
    const k = base(x.title);
    if (pixels(x) > (bestOf.get(k) || 0)) bestOf.set(k, pixels(x));
  }
  for (const x of unique) {
    const best = bestOf.get(base(x.title)) || 0;
    // 只压「标题与查询完全相同」的那一条：它是精确同名，但若同名家族里另有画质高一倍的版本，
    // 说明这条只是低码率镜像/老源，不该占第一张卡。带版本后缀的（86版、动画版、2023）各自保留。
    const demote = norm(x.title) === key && best && pixels(x) < best * 0.6;
    x.tier = (x.rank || 0) - (demote ? 1 : 0);
  }
  // 名称相关度优先，其次画质：搜《繁花》时正片必须排在《一路繁花2》前面。
  unique.sort((a, b) => b.tier - a.tier || pixels(b) - pixels(a) || Number(b.score || 0) - Number(a.score || 0));

  const data = {ok: true, items: unique.slice(0, limit), note: unique.length ? '' : '没有通过完整性核验的来源'};
  cache.delete(key);
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  cache.set(key, {until: Date.now() + CACHE_MS, data});
  return data;
}

// 换线路：按片源编号取回整条记录（含核验过的首集直链），前端据此原地替换 media。
export async function fetchItemById(id) {
  const m = /^vod-([a-z0-9]+)-(\d+)$/.exec(id);
  if (!m) throw Error('片源编号无效');
  const provider = PROVIDERS.find(p => p.id === m[1]);
  if (!provider) throw Error('未知来源');
  const text = await retry(() => getText(`${provider.api}?ac=detail&ids=${m[2]}`, {timeout: 12000}));
  const raw = (JSON.parse(text).list || [])[0];
  if (!raw) throw Error('来源已下架该片');
  const item = toItem(provider, raw);
  if (!item) throw Error('该片没有可播放的完整来源');
  const resolved = await within(16000, resolveEpisode(item.episodes[0], provider.id));
  if (!resolved) throw Error('这条线路暂时无法播放');
  return withMedia(item, resolved);
}

// 选集：按需核验单个分集，返回真实片长与实测分辨率供播放器校验与展示。
export async function resolveEpisodeById(id, episodeKey) {
  const m = /^vod-([a-z0-9]+)-(\d+)$/.exec(id);
  if (!m) throw Error('片源编号无效');
  const provider = PROVIDERS.find(p => p.id === m[1]);
  if (!provider) throw Error('未知来源');
  const text = await retry(() => getText(`${provider.api}?ac=detail&ids=${m[2]}`, {timeout: 12000}));
  const raw = (JSON.parse(text).list || [])[0];
  if (!raw) throw Error('来源已下架该片');
  const item = toItem(provider, raw);
  if (!item) throw Error('该片没有可播放的完整来源');
  const index = episodeKey === 'full' ? 0 : Math.max(0, Number(String(episodeKey).replace(/\D/g, '')) - 1);
  const ep = item.episodes[index] || item.episodes[0];
  const resolved = await resolveEpisode(ep, provider.id);
  if (!resolved) throw Error('该分集暂不可播放');
  return {
    url: resolved.stream, expectedDuration: resolved.duration, label: ep.label,
    width: resolved.width, height: resolved.height, resolution: label(resolved),
    provider: provider.name,
  };
}

export {PROVIDERS};
