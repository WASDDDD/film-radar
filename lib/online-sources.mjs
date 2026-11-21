import { cntvSnapshot, wikiSnapshot } from './online-data.mjs';

const CNTV_LIST = 'https://api.cntv.cn/NewVideo/getVideoListByColumn';
const WIKI = 'https://wikiflix.toolforge.org/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const cache = new Map();
const inflight = new Map();
const httpsURL = s => String(s || '').replace(/^http:\/\//i, 'https://');
const lookup = new Map();
const userAgent = 'FilmRadar/3.0 (public complete-film discovery)';
const plain = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = s => String(s || '').normalize('NFKC').toLowerCase();
async function get(url) {
  const key = String(url), old = cache.get(key);
  if (old && Date.now() - old.time < 300000) return old.value;
  if (inflight.has(key)) return inflight.get(key);
  const pending = (async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(7500), headers: { 'User-Agent': userAgent } });
      if (!r.ok) throw Error(`HTTP ${r.status}${r.headers.get('retry-after') ? '，请稍后重试' : ''}`);
      const value = await r.json();
      cache.delete(key); cache.set(key, { time: Date.now(), value });
      while (cache.size > 300) cache.delete(cache.keys().next().value);
      return value;
    } catch (e) { throw Error(`公开来源暂时不可用：${e.name === 'TimeoutError' ? '请求超时' : e.message}`); }
  })();
  inflight.set(key, pending);
  try { return await pending; } finally { inflight.delete(key); }
}
function api(base, params) { return base + '?' + new URLSearchParams(params); }
function register(item) { lookup.set(item.id, item); return item; }
function cntvItem(x) {
  return register({ id: 'cntv-' + x.guid, title: x.title, original: x.title, year: String(x.time || '').slice(0, 4), kind: '剧集', genres: ['纪录片', '央视'], summary: x.brief || '', poster: httpsURL(x.image), official: httpsURL(x.url), watch: httpsURL(x.url), duration: x.length || '', online: { provider: 'cntv', sourceId: x.guid }, availability: 'online' });
}
function files(x) { try { return Array.isArray(x.entry_files) ? x.entry_files : Array.isArray(x.files) ? x.files : JSON.parse(x.files || '[]'); } catch { return []; } }
function commonsFiles(x) { return files(x).filter(f => Number(f.property) === 10 && !Number(f.is_trailer)); }
function wikiItem(x) {
  const source = 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(commonsFiles(x)[0]?.key || '').replace(/%20/g, '_');
  return register({ id: 'wiki-' + x.q, title: x.title, original: x.title, year: String(x.year || ''), kind: '电影', genres: ['开放电影'], summary: `${x.minutes ? x.minutes + ' 分钟。' : ''}Commons 完整影片候选；点播时核对许可、实际片长及可用转码档。`, poster: x.image ? 'https://commons.wikimedia.org/wiki/Special:Redirect/file/' + encodeURIComponent(x.image) + '?width=400' : '', official: source, watch: source, online: { provider: 'commons', sourceId: String(x.q), files: commonsFiles(x) }, availability: 'online', candidate: true, runtime: Number(x.minutes || 0) * 60 });
}
let snapshotPromise;
async function snapshots() {
  if (!snapshotPromise) snapshotPromise = (async () => {
    const c = cntvSnapshot, w = wikiSnapshot;
    const all = new Map();
    for (const e of w?.entries || []) if (commonsFiles(e).length) all.set(String(e.q), e);
    return { cntv: (c?.items || []).map(cntvItem), wiki: [...all.values()].map(wikiItem), wikiTotal: Number(w?.entry_total || 0), cntvTotal: Number(c?.total || 0) };
  })();
  return snapshotPromise;
}
/** Public discovery candidates. No discovery count is a decoded/playable count. */
export async function library({ q = '', provider = 'all', page = 1, limit = 24 } = {}) {
  page = Math.max(1, Math.floor(Number(page) || 1)); limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 24)));
  if (!['all', 'cntv', 'commons'].includes(provider)) throw Error('未知公开来源');
  q = String(q).trim().slice(0, 120);
  const s = await snapshots(); const sources = [];
  let c = s.cntv, w = s.wiki;
  if (provider !== 'commons') sources.push({ name: '央视《探索·发现》', provider: 'cntv', status: c.length ? 'ok' : 'unavailable', note: `${s.cntvTotal} 期官方节目候选；本地目录 ${c.length} 期，播放时实时检查公开播放状态。` });
  if (provider !== 'cntv') {
    let note = `${w.length} 部具有 Commons 非预告文件的目录候选；WikiFlix 总目录 ${s.wikiTotal} 条含其他平台，不计为本站可播数量。`;
    if (q) {
      try {
        const [result, entities] = await Promise.all([
          get(api(WIKI, { action: 'search', query: q, language: 'zh' })).catch(() => ({ data: {} })),
          /[\u3400-\u9fff]/.test(q) ? get(api('https://www.wikidata.org/w/api.php', { action: 'wbsearchentities', format: 'json', search: q, language: 'zh', uselang: 'zh', limit: 20 })).catch(() => ({ search: [] })) : Promise.resolve({ search: [] })
        ]);
        const fresh = (result.data?.entries || []).filter(x => commonsFiles(x).length).map(wikiItem);
        const merged = new Map(w.map(x => [x.id, x])); for (const x of fresh) merged.set(x.id, x);
        await Promise.all((entities.search || []).slice(0,6).map(async entity => {
          const id = 'wiki-' + entity.id.replace(/^Q/, '');
          let old = merged.get(id);
          if (!old) {
            try {
              const extra = await get(api(WIKI, {action:'get_entry',q:entity.id.replace(/^Q/,''),language:'zh'}));
              if (extra.data?.q && commonsFiles(extra.data).length) old = wikiItem(extra.data);
            } catch {}
          }
          if (old) merged.set(id, register({...old,title:entity.label || old.title,summary:`${entity.description || ''} ${old.summary}`,aliases:[q,entity.label,...(old.aliases || [])].filter(Boolean)}));
        }));
        w = [...merged.values()];
        note += ' 已合并在线检索与 Wikidata 中文片名。';
      } catch { note += ' 在线检索暂不可用，使用本地公开目录。'; }
    }
    sources.push({ name: 'Wikimedia Commons / WikiFlix', provider: 'commons', status: w.length ? 'ok' : 'unavailable', note });
  }
  let items = provider === 'cntv' ? c : provider === 'commons' ? w : [...c, ...w];
  if (q) items = items.filter(x => norm([x.title, x.original, x.summary, x.year, ...(x.aliases || [])].join(' ')).includes(norm(q)));
  const total = items.length, pages = Math.max(1, Math.ceil(total / limit));
  page = Math.min(page, pages);
  return { items: items.slice((page - 1) * limit, page * limit), total, page, pages, limit, sources, totalLabel: '公开目录候选数，点播时动态核验', candidateTotal: total, verifiedPlayableTotal: null };
}
function approvedAsset(src) {
  try { const u = new URL(src); return u.protocol === 'https:' && u.hostname === 'upload.wikimedia.org' && u.pathname.startsWith('/wikipedia/commons/'); } catch { return false; }
}
function allowedHls(src) {
  try { const u = new URL(src); return u.protocol === 'https:' && /(?:^|\.)(?:cntv\.cn|cctv\.com|qcloudcdn\.com|lxdns\.com|cdn20\.com)$/.test(u.hostname) && /\.m3u8$/.test(u.pathname) && !/\/(?:enc|enc2|h5e)\//.test(u.pathname); } catch { return false; }
}
export async function resolveSource(id) {
  id = String(id || ''); await snapshots();
  if (/^cntv-[a-f0-9]{32}$/i.test(id)) {
    const pid = id.slice(5), data = await get(api('https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do', { pid }));
    if (data.ack !== 'yes' || String(data.public) !== '1' || String(data.is_preview) !== '0' || String(data.is_protected) !== '0' || String(data.is_invalid_copyright) !== '0' || String(data.play) !== '1') throw Error('此节目当前不满足官方公开完整播放条件，请前往央视原页观看。');
    data.hls_url = httpsURL(data.hls_url);
    if (!allowedHls(data.hls_url)) throw Error('央视未提供可用的公开未加密 HLS 地址。');
    const known = lookup.get(id), duration = Number(data.video?.totalLength || 0);
    if (!(duration > 60)) throw Error('官方节目片长信息无效。');
    if (known?.duration) { const a = known.duration.split(':').map(Number); const expected = a.reduce((n, v) => n * 60 + v, 0); if (Math.abs(expected - duration) > Math.max(10, expected * .03)) throw Error('节目目录与媒体片长不一致，暂不提供站内播放。'); }
    const sourcePage = known?.official || 'https://tv.cctv.com/';
    const item = known || register({ id, title: data.title, original: data.title, year: String(data.f_pgmtime || '').slice(0, 4), kind: '剧集', genres: ['纪录片', '央视'], summary: '', poster: httpsURL(data.image), official: sourcePage, watch: sourcePage, online: { provider: 'cntv', sourceId: pid }, availability: 'online' });
    return { ...item, candidate: false, playbackVerification: '官方接口公开状态与片长核验；浏览器解码待播放', media: [{ key: 'full', label: '央视官方完整节目', src: data.hls_url, type: 'application/vnd.apple.mpegurl', provider: 'cntv', sourcePage, license: '央视官方公开播放；未声明可再分发许可', licenseURL: sourcePage, duration }] };
  }
  if (!/^wiki-\d+$/.test(id)) throw Error('片源编号无效。');
  const q = id.slice(5); let item = lookup.get(id), entry;
  try { const j = await get(api(WIKI, { action: 'get_entry', q, language: 'zh' })); entry = j.data; } catch (e) { if (!item?.online?.files?.length) throw e; }
  const candidates = entry ? commonsFiles(entry) : item?.online?.files || [];
  if (!candidates.length) throw Error('此条目没有 Commons 完整影片文件，外部平台与预告不计入站内片源。');
  if (entry) item = wikiItem(entry);
  const titles = candidates.slice(0, 5).map(f => 'File:' + f.key).join('|');
  const j = await get(api(COMMONS, { action: 'query', format: 'json', formatversion: 2, titles, prop: 'imageinfo|videoinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: 480, iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Restrictions|Artist', viprop: 'derivatives', vilimit: 1 }));
  if (j.error) throw Error('Commons 元数据接口：' + j.error.info);
  for (const p of j.query?.pages || []) {
    const info = p.imageinfo?.[0], vi = p.videoinfo?.[0], m = info?.extmetadata || {};
    const license = String(m.License?.value || '');
    if (!info || !approvedAsset(info.url) || !/^video\//.test(info.mime || '') || !/^(?:pd|pdm|cc0|cc-by(?:-sa)?-[0-9.]+)$/i.test(license) || plain(m.Restrictions?.value)) continue;
    const duration = Number(info.duration || vi?.duration || 0);
    const file = candidates.find(f => 'File:' + f.key.replaceAll('_', ' ') === p.title.replaceAll('_', ' '));
    const expected = Number(file?.minutes || 0) * 60 || item.runtime;
    if (!(duration >= 60) || !expected || Math.abs(duration - expected) > Math.max(90, expected * .08)) continue;
    const derivatives = (vi?.derivatives || []).filter(d => approvedAsset(d.src) && /^video\/(webm|mp4)/.test(d.type || '') && d.height >= 240).sort((a, b) => Math.abs(a.height - 480) - Math.abs(b.height - 480));
    const variants = [...derivatives.map(d => ({ src: d.src, type: d.type, width: Number(d.width || 0), height: Number(d.height || 0) })), { src: info.url, type: info.mime, width: Number(info.width || 0), height: Number(info.height || 0) }];
    const selected = variants[0];
    return { ...item, official: info.descriptionurl, watch: info.descriptionurl, poster: info.thumburl || item.poster, candidate: false, playbackVerification: 'Commons 许可、非预告标记与片长核验；尚未声明浏览器已解码', media: [{ key: 'full', label: 'Commons 完整影片', src: selected.src, type: selected.type, provider: 'commons', sourcePage: info.descriptionurl, license: plain(m.LicenseShortName?.value || license), licenseURL: m.LicenseUrl?.value || info.descriptionurl, credit: plain(m.Artist?.value), duration, variants, backup: variants.slice(1).map(x => x.src) }] };
  }
  throw Error('未找到同时满足许可白名单、完整片长与公开媒体地址的 Commons 文件。');
}
