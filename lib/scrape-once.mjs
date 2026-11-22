// 静态站点的「继续刮削」：每次请求现抓一页上游片单、现场核验几条，返回给浏览器本地累积。
// 服务器没有可写磁盘，所以增量片库存在访客自己的 localStorage 里，游标也由前端带着走。
import { __debug, PROVIDERS } from './vod-sources.mjs';

const { toItem, resolveEpisode, withMedia, JUNK } = __debug;
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const ADULT = /伦理|成人|情色|色情|三级|午夜|艳情|迷奸|诱惑|禁片|福利/i;
const SHORT = /短剧|漫剧|微短剧/i;
const CATEGORY = [[/动画|动漫|番剧/i, '动漫'], [/真人秀|脱口秀|综艺|选秀/i, '综艺'], [/纪录片/i, '纪录'], [/体育|篮球|足球|运动/i, '体育']];
const AREA = [[/大陆|内地|中国$/, '中国'], [/香港|港/, '香港'], [/台湾|台$/, '台湾'], [/日本|日韩/, '日本'], [/韩国/, '韩国'], [/美国|欧美|英国|法国|德国|意大利|西班牙|加拿大|澳大利亚/, '欧美'], [/泰国|印度|新加坡|马来/, '亚洲其他']];

async function getJSON(url, timeout = 6000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  return res.json();
}

function decorate(item) {
  const hay = `${(item.genres || []).join(' ')} ${item.title}`;
  const cat = CATEGORY.find(([re]) => re.test(hay));
  const area = AREA.find(([re]) => re.test(`${item.area || ''} ${item.original || ''}`));
  return { ...item, category: cat ? cat[1] : item.kind === 'tv' ? '剧集' : '电影', region: area ? area[1] : item.area || '' };
}

// cursor 形如 "0:2"（第几个来源:第几页）；take 为这次要核验通过几部。
export async function scrapeMore({ cursor = '', take = 3 } = {}) {
  const [startProvider, startPage] = (cursor || '0:2').split(':').map(Number);
  let pi = Number.isFinite(startProvider) ? startProvider : 0;
  let pg = Number.isFinite(startPage) && startPage > 0 ? startPage : 1;
  const deadline = Date.now() + 6500;
  let scanned = 0;

  while (Date.now() < deadline && pi < PROVIDERS.length) {
    const provider = PROVIDERS[pi];
    let data;
    try {
      data = await getJSON(`${provider.api}?ac=detail&pg=${pg}`, Math.max(2500, Math.min(6000, deadline - Date.now())));
    } catch {
      pi += 1; pg = 1;                       // 这一家翻页失败就换下一家
      continue;
    }
    const raw = Array.isArray(data?.list) ? data.list : [];
    const pageCount = Math.max(1, Number(data?.pagecount || 1));
    scanned += raw.length;

    const pools = [];
    for (const row of raw) {
      const item = toItem(provider, row);
      if (!item) continue;
      if (JUNK.test(item.title) || ADULT.test(item.title)) continue;
      if ((item.genres || []).some(g => SHORT.test(g))) continue;
      pools.push(decorate(item));
      if (pools.length >= take * 2) break;      // 每页只验最前面几条，够一次请求用
    }

    const verified = (await Promise.all(pools.map(async item => {
      const resolved = await resolveEpisode(item.episodes[0], item.vodProvider);
      if (!resolved) return null;
      if (item.kind === 'tv' && resolved.duration < 600) return null;
      if (item.kind === 'movie' && resolved.duration < 1200) return null;
      return withMedia(item, resolved);
    }))).filter(Boolean).slice(0, take);

    // 游标推进：本页翻完就换下一家
    let nextPi = pi, nextPg = pg + 1;
    if (nextPg > pageCount) { nextPi += 1; nextPg = 1; }
    const nextCursor = nextPi >= PROVIDERS.length ? '0:1' : `${nextPi}:${nextPg}`;
    const done = nextPi >= PROVIDERS.length;

    if (verified.length) return { ok: true, items: verified, cursor: nextCursor, provider: provider.id, page: pg, pageCount, scanned, done };
    pi = nextPi; pg = nextPg;
    if (done) break;
  }
  return { ok: true, items: [], cursor: `0:1`, provider: '', page: pg, scanned, done: true };
}
