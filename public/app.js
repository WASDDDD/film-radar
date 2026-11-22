(() => {
'use strict';
const $ = id => document.getElementById(id);
const verifiedFilms = window.RADAR_VERIFIED_FILMS || [];
const verifiedTitles = new Set(verifiedFilms.map(x => `${x.title}:${x.year}`));
const catalog = [...window.RADAR_CATALOG.filter(x => !x.id.startsWith('classic-') || !verifiedTitles.has(`${x.title}:${x.year}`)), ...verifiedFilms];
const checks = new Map(Object.entries(window.RADAR_WATCH_CHECKS || {}));
const items = new Map(catalog.map(x => [x.id, x]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#i-${name}"></use></svg>`;
const clean = v => String(v ?? '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const esc = (v = '') => clean(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url = (v, local = false) => typeof v === 'string' && (/^https:\/\//i.test(v) || (local && /^assets\/[\w.-]+$/.test(v))) ? esc(v) : '';
const normalize = s => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}]+/gu,'');
const plain = html => new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.textContent.trim();
const listsKey = 'film-radar.lists.v1', historyKey = 'film-radar.history.v1', importsKey = 'film-radar.sources.v1', vodKey = 'film-radar.vod.v1';
const searchKey = 'film-radar.searches.v1';
function stored(key, fallback) { try { const raw = JSON.parse(localStorage.getItem(key)); return Array.isArray(raw) ? raw : fallback; } catch { return fallback; } }
let imports = stored(importsKey, []);
const localMedia = new Map();
const sourceStates = new Map();
// 检索到的完整片源按 id 缓存，刷新后片单与继续观看仍能直接播放。
function vodCache() { try { const raw = JSON.parse(localStorage.getItem(vodKey)); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; } catch { return {}; } }
let vodStore = vodCache();
function rememberVod(rows) {
  for (const x of rows) if (x.vod && x.media?.length) vodStore[x.id] = x;
  const ids = Object.keys(vodStore);
  if (ids.length > 80) for (const id of ids.slice(0, ids.length - 80)) delete vodStore[id];
  try { localStorage.setItem(vodKey, JSON.stringify(vodStore)); } catch {}
}
for (const x of Object.values(vodStore)) if (x?.id && x.media?.length) items.set(x.id, x);
for (const x of imports) items.set(x.id,x);
let scraped = [], scrapedDone = false;
// 静态部署版没有后台刮削器，但有「继续刮削」：每次点一下现抓一页、现场核验，增量存在本机。
const extraKey = 'film-radar.extra.v1', cursorKey = 'film-radar.scrape.cursor.v1';
let extras = stored(extraKey, []);
let scrapeCursor = localStorage.getItem(cursorKey) || '0:2';
for (const x of extras) if (x?.id && x.media?.length) { items.set(x.id, x); scraped.push(x); }
let scrapedFilter = {category:'all', region:'all', quality:'all', sort:'default'};
let scrapedFacets = {category:{}, region:{}};
// 片库可能上万条：按当前筛选条件分页拉取，记住拉到第几页，翻页只追加不重拉。
let scrapedPages = {loaded: 0, total: 1, busy: false};
let scrapedQueue = Promise.resolve();                 // 串行化：切换分类时等上一轮拉完，别互相踩
function loadScraped(pages = 4, {reset = false} = {}) {
  scrapedQueue = scrapedQueue.then(() => pullScraped(pages, reset)).catch(() => {});
  return scrapedQueue;
}
async function pullScraped(pages, reset) {
  if (reset) scrapedPages = {loaded: 0, total: 1, busy: false};
  scrapedPages.busy = true;
  try {
    const startLoaded = scrapedPages.loaded;
    const target = startLoaded + pages;          // 本次最多再拉 pages 页（旧逻辑边界随 loaded 增长，会一路拉完整库，导致切筛选极慢）
    for (let page = startLoaded + 1; page <= target; page++) {
      if (scrapedPages.total && page > scrapedPages.total) break;
      const params = new URLSearchParams({limit:48, page, category:scrapedFilter.category, region:scrapedFilter.region, quality:scrapedFilter.quality});
      const d = await json(`api/scrape-browse?${params}`, 20000);
      scrapedPages.total = d.pages || 1;
      if (d.facets) scrapedFacets = d.facets;
      const rows = (d.items || []).filter(x => x.id && x.media?.length);
      for (const x of rows) { if (!items.has(x.id)) { scraped.push(x); items.set(x.id, x); } }
      scrapedPages.loaded = page;
    }
  } catch (e) {} finally { scrapedPages.busy = false; }
  if (view === 'home') renderHome();
}
loadScraped();
setInterval(() => loadScraped(2), 180000);   // 刮削持续入库，定期补拉最新页
async function pickScrapedFilter(kind, value) {
  scrapedFilter = {...scrapedFilter, [kind]: value};
  homeShown = 240;                      // 分类浏览时多铺一些，别被官方片库占满首屏
  renderHome();                         // 先用已加载的数据按新条件即时重绘，不等网络
  loadScraped(6, {reset: true});        // 后台按新条件补拉更多页，拉完 loadScraped 内部会再次 renderHome
}
let lists = stored(listsKey, [{id:'saved', name:'想看', entries:[]}]);
let history = stored(historyKey, []), activeList = lists[0]?.id, filter = 'open';
let slide = 0, toastTimer, searchState, searchToken = 0, view = 'home', current = null, player = null;
const featured = catalog.filter(x => x.featured && x.media?.some(m=>m.key === 'full'));
const filters = [['open','完整可播'],['series','剧集']];
const full = x => x.media?.find(m=>m.key === 'full');
const availability = x => sourceStates.get(x.id) === 'failed' ? 'failed' : x.officialProvider ? 'official' : x.online ? 'online' : full(x) ? 'open' : checks.get(x.id)?.candidate ? 'candidate' : checks.has(x.id) ? 'checked' : 'unchecked';
const availabilityLabel = {open:'站内正片',official:'官方平台 · 无站内源',online:'待检测片源',candidate:'候选待复测',checked:'未找到站内源',unchecked:'仅资料 · 无站内源'};
const kindOf = x => x.genres?.some(g => /动画|animation|anime/i.test(g)) ? '动画' : x.kind === 'tv' || x.kind === '剧集' ? '剧集' : '电影';
const snapshot = ({id,title,original,year,kind,genres,poster,summary,score,official,watch,online,officialProvider,playback,sourceProvider,sourcePage,media,duration,remarks}) => ({id,title,original,year,kind,genres,poster,summary,score,official,watch,online,officialProvider,playback,sourceProvider,sourcePage,media,duration,remarks});
for (const h of history) if (h.item && !items.has(h.id)) items.set(h.id,h.item);
const resumeSnap = (x, key) => {
  const s = snapshot(x);
  s.vod = !!x.vod; s.resolution = x.resolution; s.width = x.width; s.height = x.height; s.area = x.area; s.lang = x.lang; s.director = x.director;
  s.media = (x.media || []).filter(m => m.key === key).concat((x.media || []).filter(m => m.key !== key).slice(0, 5));
  return s;
};
// 择优理由（借鉴 MIYO best+reasons）：解释为什么这条线路成为默认。
function pickReasonRow(x, alts = [], count = 0) {
  if (!x?.vod) return '';
  const rs = [];
  const short = Math.min(x.width || 0, x.height || 0);
  if (short >= 2160) rs.push('4K 超高清');
  else if (short >= 1060) rs.push('1080P+ 画质优选');
  else if (short >= 700) rs.push('720P 高清');
  if (x.kind === 'tv' && count > 1) rs.push(`${count} 集完整`);
  if (alts.length) rs.push(`已对比 ${alts.length + 1} 条线路`);
  if (x.score) rs.push(`评分 ${x.score}`);
  if (!rs.length) rs.push('清单完整可播');
  return `<div class="source-row pick-reasons"><span class="pick-badge">为什么选这条</span>${rs.map(r => `<span class="chip reason">${esc(r)}</span>`).join('')}</div>`;
}
let onlineState = {q:'',provider:'all',page:1,items:[],total:0,pages:1,pending:false,loaded:false}, onlineToken = 0;
const restore = x => items.get(x.id) || x;
for (const span of document.querySelectorAll('[data-i]')) span.innerHTML = icon(span.dataset.i);
$('sheet').classList.add('sheet');
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; toastTimer = setTimeout(() => $('toast').textContent = '', 2800); }
function persist(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { toast('浏览器暂时无法保存数据'); return false; } }
function saved(id) { return lists.some(l => l.entries.some(e => e.id === id)); }
const triggers = {close:'x', save:'bookmark', left:'chevron-left', right:'chevron-right', edit:'pencil'};
function iconButton(action, title, value = '', extra = '', pressed) {
  return `<button type="button" class="icon-button ${extra}" data-action="${action}" data-value="${esc(value)}" title="${esc(title)}" aria-label="${esc(title)}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${icon(triggers[action])}</button>`;
}
function chip(text, action, value, pressed) { return `<button type="button" class="chip" data-action="${action}" data-value="${esc(value)}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${esc(text)}</button>`; }
function picture(x, key = 'full') {
  const src = url(x.poster, true), media = x.media?.find(m=>m.key === key);
  const state = sourceStates.get(x.id);
  const label = state === 'failed' ? '上次播放失败' : x.online ? state === 'decoded' ? '本次已起播' : '待检测片源' : x.officialProvider ? availabilityLabel.official : key === 'trailer' && media ? media.label : x.id.startsWith('user-') && media ? media.label : full(x) && x.kind === 'tv' ? '站内剧集' : availabilityLabel[availability(x)];
  return `<div class="poster"><span class="poster-fallback" aria-hidden="true">${icon(x.kind === 'tv' ? 'tv' : 'film')}</span>${src ? `<img src="${src}" loading="lazy" alt="" decoding="async">` : ''}<span class="badge${media ? '' : ' muted-badge'}">${esc(label)}</span></div>`;
}
function meta(x, details = false) { return [x.year, kindOf(x), ...(details ? [x.duration, ...x.genres || []] : []), ...(x.vod && x.resolution ? [x.resolution] : [])].filter(Boolean).map(esc).join('<span class="dot">·</span>') + (x.score ? `<span class="score">★ ${esc(x.score)}</span>` : ''); }
function cards(xs, key = 'full') { return xs.map(x => {
  const playable = x.media?.some(m=>m.key === key);
  const cardTitle = x.online?.provider === 'cntv' ? x.title.replace(/^《[^》]+》\s*\d{8}\s*/, '') : x.title;
  return `<article class="card" data-douban-title="${esc(x.title)}" data-douban-year="${esc(x.year || '')}"><button type="button" title="${esc(x.title)}" data-action="${playable ? 'resume' : 'detail'}" data-media="${key}" data-value="${esc(x.id)}">${picture(x,key)}<strong class="card-title">${esc(cardTitle)}</strong><span class="meta">${playable ? icon('play') : ''}${meta(x)}</span></button>${save(x, 'save-card')}</article>`;
}).join(''); }
function save(x, extra = '') { const on = saved(x.id); return iconButton('save', '加入或移出片单', x.id, `${extra} ${on ? 'is-saved' : ''}`, on); }
function empty(iconName,title,description='') { return `<div class="blank">${icon(iconName)}<strong>${esc(title)}</strong>${description ? `<p>${esc(description)}</p>` : ''}</div>`; }
// —— 豆瓣评分：卡片角标 + 详情页展示，异步批量补齐（带内存缓存，避免重复请求） ——
const doubanCache = new Map();
let doubanTimer = 0, doubanRunning = false;
function fmtVotes(n) { n = Number(n) || 0; return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n); }
function paintDouban(node, r) {
  const rating = r && r.rating;
  if (node.classList.contains('card')) {
    const poster = node.querySelector('.poster');
    if (rating && poster && !poster.querySelector('.douban-badge')) {
      const b = document.createElement('span');
      b.className = 'douban-badge';
      b.textContent = '豆瓣 ' + rating;
      if (r.matched) b.title = `豆瓣《${r.matched}》${rating} 分${r.votes ? ` · ${fmtVotes(r.votes)} 人评价` : ''}`;
      poster.appendChild(b);
    }
  } else {
    node.hidden = false;
    if (rating) {
      const alias = r.matched && r.matched !== node.dataset.doubanTitle ? `<span class="muted"> · 匹配《${esc(r.matched)}》</span>` : '';
      node.innerHTML = `<span class="douban-stars">豆瓣评分 <b>${esc(String(rating))}</b></span><span class="muted"> / 10${r.votes ? ` · ${fmtVotes(r.votes)} 人评价` : ''}${alias}</span>`;
    } else {
      node.innerHTML = `<span class="muted">豆瓣暂无评分</span>`;
    }
  }
  node.setAttribute('data-douban-done', '');
}
const DOUBAN_BATCH = 6;
function doubanCached(k) { const c = doubanCache.get(k); return c && !c.pending ? c : null; }
async function hydrateDouban() {
  if (doubanRunning) return;
  const all0 = [...document.querySelectorAll('[data-douban-title]:not([data-douban-done])')];
  if (!all0.length) return;
  // 详情/搜索里的条目全处理；首页大列表只处理当前视口附近的，避免一次性把豆瓣配额刷爆
  const nodes = all0.filter(n => {
    if (!n.closest('#home-grid')) return true;
    const r = n.getBoundingClientRect();
    return r.bottom > -300 && r.top < window.innerHeight + 300;
  }).sort((a, b) => (a.closest('#home-grid') ? 1 : 0) - (b.closest('#home-grid') ? 1 : 0));
  if (!nodes.length) return;
  doubanRunning = true;
  try {
    const need = new Map();
    for (const n of nodes) {
      const t = n.dataset.doubanTitle; if (!t) { n.setAttribute('data-douban-done', ''); continue; }
      const y = n.dataset.doubanYear || '', k = t + '|' + y, c = doubanCached(k);
      if (c) { paintDouban(n, c); continue; }
      if (!need.has(k)) need.set(k, { t, y });
    }
    const all = [...need.values()];
    if (all.length) {
      try {
        const data = await json('api/douban?titles=' + encodeURIComponent(JSON.stringify(all.slice(0, DOUBAN_BATCH))), 12000);
        for (const it of (data.items || [])) doubanCache.set(it.t + '|' + (it.year || ''), it);
      } catch { /* 网络失败忽略，下次渲染再补 */ }
      for (const n of nodes) {
        if (n.getAttribute('data-douban-done') !== null) continue;
        const t = n.dataset.doubanTitle, y = n.dataset.doubanYear || '';
        let c = doubanCached(t + '|' + y);
        if (!c) for (const [kk, vv] of doubanCache) { if (!vv.pending && kk.startsWith(t + '|')) { c = vv; break; } }
        if (c) paintDouban(n, c);
      }
    }
    // 还有没补的，稍后接着补（不猛刷，避免豆瓣封 IP）
    const remaining = document.querySelectorAll('[data-douban-title]:not([data-douban-done])').length;
    if (remaining > 0 && all.length > DOUBAN_BATCH) { clearTimeout(doubanTimer); doubanTimer = setTimeout(hydrateDouban, 2500); }
  } finally { doubanRunning = false; }
}
function scheduleDouban() { clearTimeout(doubanTimer); doubanTimer = setTimeout(hydrateDouban, 160); }
// 滚动时补当前视口内还没评分的卡片
window.addEventListener('scroll', () => { if (document.querySelector('#home-grid [data-douban-title]:not([data-douban-done])')) scheduleDouban(); }, { passive: true });
function renderHero() {
  if (!$('hero')) return; // 精选放映大图已移除，保留函数以兼容其他调用
  const x = featured[slide];
  $('hero').innerHTML = `<img class="hero-image" src="${url(x.backdrop,true)}" alt="" fetchpriority="high" style="object-position:${x.position || 'center'}"><div class="wrap hero-inner"><div class="hero-copy"><div class="kicker"><i></i>${esc(x.featured)}</div><h1>${esc(x.title)}</h1><p class="hero-alt">${esc(x.original)}</p><div class="hero-meta">${meta(x,true)}</div><p class="hero-summary">${esc(x.summary)}</p><div class="actions"><button class="button primary" data-action="${x.media?.length ? 'resume' : 'detail'}" data-value="${x.id}">${icon(x.media?.length ? 'play' : 'circle-alert')}${x.media?.length ? '播放正片' : '查看详情'}</button>${save(x)}</div></div><div class="hero-controls">${iconButton('left','上一部精选','','small')}<span class="hero-index"><b>${String(slide+1).padStart(2,'0')}</b> / ${String(featured.length).padStart(2,'0')}</span>${iconButton('right','下一部精选','','small')}</div></div>`;
}
// 当前热门：片方实时热榜，进入首页/刷新时拉取，失败则安静隐藏，不影响其他内容。
let trendingState = null, trendingFetchedAt = 0, trendSlide = 0;
async function loadTrending() {
  if (Date.now() - trendingFetchedAt < 20 * 60_000 && trendingState) return;
  trendingFetchedAt = Date.now();
  try {
    const d = await json('api/trending', 12000);
    trendingState = d;
    trendSlide = 0;
    renderTrending();
  } catch { if ($('trending')) $('trending').hidden = true; }
}
function renderTrending() {
  const box = $('trending-hero'); if (!box || !trendingState) return;
  const rows = trendingState.items || [];
  const note = $('trending-updated');
  if (note) note.textContent = rows.length ? `${esc(trendingState.source || '实时热榜')}${trendingState.updatedAt ? ' · ' + new Date(trendingState.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : ''}` : '';
  if (!rows.length) { $('trending').hidden = true; return; }
  $('trending').hidden = false;
  const x = rows[trendSlide % rows.length];
  const metaText = [x.year, x.category].filter(Boolean).map(esc).join('<span class="dot">·</span>') || '实时热播';
  const pic = url(x.poster, true) ? `<img class="hero-image" src="${esc(x.poster)}" alt="" fetchpriority="high">` : '';
  box.innerHTML = `${pic}<div class="wrap hero-inner"><div class="hero-copy"><div class="kicker"><i></i> 实时热榜 · 第 ${x.rank} 名</div><h1>${esc(x.title)}</h1><div class="hero-meta">${metaText}</div><div class="actions" style="margin-top:18px"><button class="button primary" data-action="trend" data-value="${esc(x.title)}">${icon('play')}搜索播放</button></div></div><div class="hero-controls"><button type="button" class="icon-button small" data-action="trend-left" aria-label="上一条热门">${icon(triggers.left)}</button><span class="hero-index"><b>${String(trendSlide + 1).padStart(2,'0')}</b> / ${String(rows.length).padStart(2,'0')}</span><button type="button" class="icon-button small" data-action="trend-right" aria-label="下一条热门">${icon(triggers.right)}</button></div></div>`;
}
loadTrending();

let scrapeState = {running:false, items:0, cap:3000, rate:0, elapsed:0, providers:{}, kinds:{}, lastError:''};
let scrapeTimer = 0;
async function refreshScrape() {
  try {
    const d = await json('api/scrape-status', 8000);
    scrapeState = {...scrapeState, ...d};
  } catch (e) { /* 服务重启瞬间可能失败，下一轮再取 */ }
  renderScrape();
}
function renderScrape() {
  const s = scrapeState;
  // 静态部署版没有后台刮削器：片库随包发布，按钮改成「继续刮削」——点一下现抓一页、现场核验。
  const pct = s.static ? 100 : s.cap ? Math.min(100, Math.round(s.items / s.cap * 100)) : (s.running ? 100 : 0);
  const panel = $('scrape-panel'); if (!panel) return;
  $('scrape-title').textContent = s.static
    ? (extras.length ? `片库已发布 · 本机 +${extras.length}` : '片库已发布')
    : s.running ? '片库刮削中' : (s.items ? '片库刮削已暂停' : '片库刮削待启动');
  const toggle = $('scrape-toggle');
  if (toggle && !toggle.dataset.busy) toggle.textContent = s.static ? '继续刮削' : s.running ? '暂停' : '继续';
  const bar = panel.querySelector('.scrape-bar'); if (bar) bar.classList.toggle('idle', !s.running);
  $('scrape-fill').style.width = pct + '%';
  const mins = s.elapsed ? Math.max(1, Math.round(s.elapsed / 60)) : 0;
  $('scrape-stats').innerHTML = [
    `<span>已入库 <b>${(s.static ? s.items + extras.length : s.items)}</b> 部${s.cap ? ` / ${s.cap}` : ''}</span>`,
    s.static ? (extras.length ? `<span>本机扩充 <b>${extras.length}</b></span>` : '<span>点右侧「继续刮削」可现抓新片</span>') : `<span>本轮新增 <b>${s.added || 0}</b></span>`,
    s.rate ? `<span>速度 <b>${s.rate}</b> 部/分</span>` : '',
    s.running && mins ? `<span>已运行 <b>${mins}</b> 分钟</span>` : '',
    s.lastError ? `<span title="${esc(s.lastError)}">上游异常已跳过</span>` : '',
  ].filter(Boolean).join('');
  const names = {ffzy:'非凡', wujin:'无尽', modu:'魔都', bdzy:'北斗'};
  const kinds = {tv:'剧集', movie:'电影'};
  $('scrape-sources').innerHTML = Object.entries(s.providers || {}).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>`<span>${esc(names[k] || k)} <b>${v}</b></span>`).join('')
    + Object.entries(s.kinds || {}).map(([k,v])=>`<span>${esc(kinds[k] || k)} <b>${v}</b></span>`).join('');
}
// 静态版「继续刮削」：一次请求抓一页上游片单、核验几条，通过的存在本机并立刻进首页。
async function scrapeSome() {
  const btn = $('scrape-toggle');
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.textContent = '刮削中…';
  try {
    const data = await json(`api/scrape-more?cursor=${encodeURIComponent(scrapeCursor)}&take=3`, 24000);
    if (data.cursor) { scrapeCursor = data.cursor; try { localStorage.setItem(cursorKey, data.cursor); } catch {} }
    const fresh = (data.items || []).filter(x => x?.id && x.media?.length && !items.has(x.id));
    for (const x of fresh) { extras.push(x); items.set(x.id, x); scraped.push(x); }
    if (extras.length > 400) extras = extras.slice(-400);
    try { localStorage.setItem(extraKey, JSON.stringify(extras)); } catch {}
    toast(fresh.length ? `已收入 ${fresh.length} 部可播放影片` : '这一页没有新的可播放影片，再点一次继续翻');
  } catch (e) {
    toast(e.message || '刮削失败，稍后再试');
  } finally {
    delete btn.dataset.busy;
    btn.textContent = '继续刮削';
    renderScrape(); 
    if (view === 'home') renderHome();
  }
}
async function toggleScrape() {
  const on = !scrapeState.running;
  $('scrape-toggle').textContent = on ? '启动中…' : '暂停中…';
  try { await json(on ? 'api/scrape-start' : 'api/scrape-stop', 15000); } catch (e) {}
  await refreshScrape();
  if (on) setTimeout(loadScraped, 3000);
}
refreshScrape();
setInterval(refreshScrape, 5000);

let homeShown = 96;
function renderHome() {
  // 官方片库条目没有上游分类，按类型粗分；选了地区时只保留有地区信息的条目。
  const categoryOf = x => x.category || (x.kind === 'tv' ? '剧集' : '电影');
  const isHd = x => Math.min(x.width || 0, x.height || 0) >= 1060;
  const matchFacet = x =>
    (scrapedFilter.category === 'all' || categoryOf(x) === scrapedFilter.category) &&
    (scrapedFilter.region === 'all' || x.region === scrapedFilter.region) &&
    (scrapedFilter.quality !== '1080' || isHd(x));
  const pool = [...new Map([...imports,...catalog,...scraped].filter(x=>availability(x) === 'open' && (filter !== 'series' || x.kind === 'tv') && matchFacet(x)).map(x=>[x.id,x])).values()];
  if (scrapedFilter.sort === 'newest') pool.sort((a,b)=>((Number(b.year)>2027?0:Number(b.year))||0)-((Number(a.year)>2027?0:Number(a.year))||0));
  else if (scrapedFilter.sort === 'rating') pool.sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
  else if (scrapedFilter.sort === 'episodes') pool.sort((a,b)=>(b.media?.length||0)-(a.media?.length||0));
  const count = Math.max([...catalog,...scraped].filter(x=>availability(x) === 'open').length, (scrapeState.items || 0) + catalog.filter(x=>availability(x) === 'open' && !x.vod).length);
  const cats = [['all','全部'],['剧集','剧集'],['电影','电影'],['动漫','动漫'],['综艺','综艺'],['纪录','纪录'],['体育','体育']];
  const regions = [['all','全部地区'],['中国','国产'],['欧美','欧美'],['日本','日本'],['韩国','韩国'],['台湾','台湾'],['香港','香港'],['亚洲其他','其他']];
  // 服务端 facets 覆盖整个片库；本地目录（官方 72 部）没进刮削库，再单独加上。
  const tally = key => {
    const out = {...(scrapedFacets[key] || {})};
    for (const x of catalog) {
      if (availability(x) !== 'open' || x.vod) continue;
      const v = key === 'category' ? categoryOf(x) : x.region;
      if (v) out[v] = (out[v] || 0) + 1;
    }
    for (const x of extras) {
      const v = key === 'category' ? categoryOf(x) : x.region;
      if (v) out[v] = (out[v] || 0) + 1;
    }
    return out;
  };
  const catCount = tally('category'), regCount = tally('region');
  $('home-filters').innerHTML = filters.map(([id,label])=>chip(id === 'open' ? `${label} ${count}` : label,'filter',id,id === filter)).join('')
    + `<div class="facet-row" id="home-category">${cats.map(([id,label])=>{ const n = id === 'all' ? ` ${Object.values(catCount).reduce((a,b)=>a+b,0)}` : ` ${catCount[id] || 0}`; return chip(label + n,'scrape-category',id,scrapedFilter.category === id); }).join('')}</div>`
    + `<div class="facet-row" id="home-region">${regions.map(([id,label])=>{ const n = id === 'all' ? ` ${Object.values(regCount).reduce((a,b)=>a+b,0)}` : ` ${regCount[id] || 0}`; return chip(label + n,'scrape-region',id,scrapedFilter.region === id); }).join('')}</div>`
    + `<div class="facet-row" id="home-quality">${[['all','全部画质'],['1080','仅高清 1080P+']].map(([id,label])=>chip(label,'scrape-quality',id,scrapedFilter.quality === id)).join('')}</div>`
    + `<div class="facet-row" id="home-sort">${[['default','综合排序'],['newest','最新上映'],['rating','评分最高'],['episodes','集数最多']].map(([id,label])=>chip(label,'scrape-sort',id,scrapedFilter.sort === id)).join('')}</div>`;
  const key = filter === 'preview' ? 'trailer' : 'full';
  const shown = pool.slice(0, homeShown);
  $('home-grid').innerHTML = cards(shown,key) + (pool.length > shown.length ? `<div class="home-more"><button class="button outline" data-action="home-more">继续加载（还有 ${pool.length - shown.length} 部）</button></div>` : ''); scheduleDouban();
  if ($('hero')) $('hero').querySelector('.hero-controls').hidden = featured.length < 2;
  // 同一部片只留最近一条进度，避免同一剧集的多个分集把这一栏撑长
  const recent = [...new Map(history.filter(h => { const x = items.get(h.id) || h.item; return x && (availability(x) === 'open' || x.vod) && x.media?.some(m => m.key === h.key); }).map(h => [h.id, h])).values()].slice(0, 8);
  $('home-resume').hidden = !recent.length;
  $('resume-items').innerHTML = recent.map(h => { const x = items.get(h.id) || h.item || {}, m = x.media?.find(y => y.key === h.key) || {key:h.key,label:'在线正片'}, q = x.resolution ? `<em>${esc(x.resolution)}</em> · ` : ''; return `<button class="resume-card" data-action="resume" data-value="${esc(x.id || h.id)}" data-media="${esc(m.key)}">${icon('play')}<span><strong>${esc(x.title || h.id)}</strong><small>${q}${esc(m.label)} · ${formatTime(h.at)}</small><progress max="${h.duration || 1}" value="${h.at}" aria-label="播放进度"></progress></span>${icon('chevron-right')}</button>`; }).join('');
}
function renderOnline() {
  const s = onlineState;
  $('online-filters').innerHTML = [['all','全部来源'],['cntv','央视完整节目'],['commons','开放电影']].map(([id,label])=>chip(label,'online-provider',id,s.provider === id)).join('');
  $('online-status').textContent = s.pending ? '正在连接在线片库…' : s.error || `${s.total} 条公开目录 · 点播时核验 · 第 ${s.page} / ${s.pages || 1} 页${s.stale ? ' · 离线目录快照' : ''}${s.note ? ' · '+s.note : ''}`;
  $('online-grid').innerHTML = cards(s.items); scheduleDouban();
  $('online-empty').hidden = !!s.items.length || s.pending;
  $('online-empty').innerHTML = empty('search',s.error ? '片库暂时未连接' : '此片库没有匹配结果',s.error ? '可重试连接；下方已验证片库仍可使用。' : '此处仅检索央视与开放电影片库，其他电影、剧集或综艺请搜索全部影视。') + (s.q ? `<div class="source-row">${chip('搜索全部影视','query',s.q)}</div>` : '');
  $('online-pager').innerHTML = `<button class="button outline" data-action="online-page" data-value="${s.page-1}"${s.pending || s.page <= 1 ? ' disabled' : ''}>上一页</button><span>${s.page} / ${s.pages || 1}</span><button class="button outline" data-action="online-page" data-value="${s.page+1}"${s.pending || s.page >= s.pages ? ' disabled' : ''}>下一页</button><button class="button outline" data-action="online-retry">刷新</button>`;
}
async function loadOnline({q=onlineState.q,provider=onlineState.provider,page=1} = {}) {
  const token = ++onlineToken;
  onlineState = {...onlineState,q,provider,page,pending:true,loaded:true,error:''}; renderOnline();
  try {
    const data = await json(`api/library?${new URLSearchParams({q,provider,page,limit:24})}`,16000);
    if (token !== onlineToken) return;
    const rows = (data.items || []).filter(x=>x.id && x.online);
    for (const x of rows) items.set(x.id,{...items.get(x.id),...x});
    onlineState = {...onlineState,...data,items:rows,page:data.page || page,pages:data.pages || 1,pending:false};
  } catch (error) { if (token !== onlineToken) return; onlineState = {...onlineState,items:[],pending:false,error:`在线片库暂不可用：${error.message}`}; }
  renderOnline();
}
function renderLibrary() {
  const list = lists.find(x=>x.id === activeList) || lists[0];
  $('list-tabs').innerHTML = lists.map(l => chip(l.name,'list',l.id,l === list)).join('') + (list && list.id !== 'saved' ? iconButton('edit','重命名片单',list.id,'small') : '');
  const visible = list ? list.entries.map(restore).filter(x=>availability(x) === 'open') : [];
  $('list-notice').textContent = list ? `完整可播 ${visible.length} 部` : '';
  $('library-grid').innerHTML = cards(visible); scheduleDouban();
  $('library-empty').hidden = !!visible.length;
  $('library-empty').innerHTML = empty('bookmark','片单里还没有影片');
}
function platform(name, href) { return `<a class="chip" href="${url(href)}" target="_blank" rel="noopener noreferrer">${esc(name)}${icon('arrow-up-right')}</a>`; }
function platforms(title) {
  const q = encodeURIComponent(title);
  return platform('爱奇艺',`https://so.iqiyi.com/so/q_${q}`) + platform('腾讯视频',`https://v.qq.com/x/search/?q=${q}`) + platform('优酷',`https://so.youku.com/search_video/q_${q}`) + platform('哔哩哔哩',`https://search.bilibili.com/bangumi?keyword=${q}`);
}
// MIYO 影视资料补充：搜索时并行展示 IMDb/TMDB 评分、年份、类型、剧情、海报；只作资料，不产生可播源。
function renderMiyo() {
  const box = $('miyo-panel');
  if (!box) return;
  const m = searchState?.miyo;
  if (!m?.items?.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const genreList = x => (x.genres || []).slice(0,3).map(esc).join(' / ');
  const itemsHtml = m.items.slice(0,5).map(x => {
    const poster = url(x.poster) ? `<img src="${x.poster}" alt="" loading="lazy" decoding="async">` : '';
    const score = x.rating ? `<span class="miyo-score">★ ${esc(x.rating)}</span>` : '';
    return `<article class="miyo-item">${poster ? `<div class="miyo-poster">${poster}</div>` : ''}<div class="miyo-info"><strong>${esc(x.title)}</strong><div class="miyo-meta">${score}${x.year ? `<span>${esc(x.year)}</span>` : ''}${genreList(x) ? `<span>${genreList(x)}</span>` : ''}</div>${x.plot ? `<p class="miyo-plot">${esc(x.plot)}</p>` : ''}${x.watch ? `<a class="miyo-link" href="${x.watch}" target="_blank" rel="noopener noreferrer">IMDb 资料 ${icon('arrow-up-right')}</a>` : ''}</div></article>`;
  }).join('');
  box.innerHTML = `<div class="section-head"><div><div class="kicker"><i></i> TMDB / IMDB</div><h2>影视资料 · ${esc(m.source || 'MIYO')}</h2></div></div><p class="source-caption">以下为公开影视资料库的评分与简介，仅作参考，不代表本站可播。可播片源见下方「完整可播」结果。</p><div class="miyo-list">${itemsHtml}</div>`;
}
function renderSearch() {
  $('search-tags').innerHTML = ['让子弹飞','甄嬛传','三体','肖申克的救赎'].map(q=>chip(q,'query',q)).join('');
  $('search-heading').textContent = searchState ? `搜索「${searchState.q}」` : '搜索影视';
  $('external-links').hidden = true;
  $('external-links').innerHTML = searchState ? `<span>去平台搜索</span>${platforms(searchState.q)}${platform('TMDB',`https://www.themoviedb.org/search?query=${encodeURIComponent(searchState.q)}`)}` : '';
  const all = searchState?.results || [], mode = 'open';
  const totals = {all:all.length,open:0,official:0,online:0,failed:0,candidate:0,checked:0,unchecked:0};
  for (const x of all) totals[availability(x)]++;
  const results = mode === 'all' ? all : all.filter(x=>availability(x) === mode);
  const note = $('search-playback-note');
  note.hidden = !searchState;
  note.textContent = totals.open ? `已核验 ${totals.open} 部完整片源，可直接在站内播放；片长与清单在播放前再次校验。` : searchState?.pending ? '正在向公开片库检索并核验完整清单…' : '这部暂未找到通过核验的完整片源，因此不展示无效结果。可换用正式片名、去掉季数再试。';
  renderMiyo();
  $('search-filters').hidden = true;
  $('search-filters').innerHTML = [['open','完整可播'],['all','全部资料'],['official','官方资料'],['online','待检测来源'],['candidate',availabilityLabel.candidate],['checked',availabilityLabel.checked],['unchecked',availabilityLabel.unchecked]]
    .filter(([id])=>id !== 'candidate' || totals.candidate || mode === id).map(([id,label])=>chip(`${label} ${totals[id]}`,'search-filter',id,mode === id)).join('');
  const grid = cards(results);
  if ($('search-grid').dataset.sig !== grid) { $('search-grid').innerHTML = grid; $('search-grid').dataset.sig = grid; scheduleDouban(); }
  $('search-empty').hidden = !!results.length;
  $('search-empty').innerHTML = !searchState ? empty('search','搜索片名或关键词') : searchState.pending ? empty('search','正在检索完整片源…') : empty('search','暂无完整可播放源');
  $('source-status').textContent = searchState ? `${totals.open} 部完整可播${searchState.pending ? ' · 正在继续检索…' : ''}${searchState.vod ? ` · 片库：${searchState.vod}` : ''}` : '';
}
function setView(next) {
  if (view !== next) window.scrollTo(0,0);
  view = next;
  for (const key of ['home','search','library']) {
    $(`${key}-view`).hidden = key !== next;
    const nav = document.querySelector(`[data-view="${key}"]`);
    if (key === next) nav.setAttribute('aria-current','page'); else nav.removeAttribute('aria-current');
  }
  if (next === 'home') { renderHero(); renderHome(); }
  if (next === 'library') renderLibrary();
  if (next === 'search') renderSearch();
}
function openView(next) { if (next === 'home') location.hash = ''; else location.hash = next; setView(next); }
function route() {
  const [page, params] = location.hash.slice(1).split('?');
  const q = new URLSearchParams(params).get('q')?.trim().slice(0,100);
  if (page === 'search' && q) { $('query').value = q; if (searchState?.q !== q) search(q); else setView('search'); }
  else if (page === 'search') { ++searchToken; searchState = null; setView('search'); }
  else setView(page === 'library' ? 'library' : 'home');
}
let searches = stored(searchKey, []);
function rememberSearch(q) {
  const term = String(q || '').trim().slice(0, 60);
  if (!term) return;
  searches = [term, ...searches.filter(x => x !== term)].slice(0, 12);
  persist(searchKey, searches);
}
function renderSearchHistory(show = true) {
  const box = $('search-history'), list = $('search-history-list');
  if (!box || !list) return;
  const visible = searches.slice(0, 10);
  list.innerHTML = visible.map(q => `<button type="button" class="chip" data-action="query" data-value="${esc(q)}">${esc(q)}</button>`).join('');
  box.hidden = !show || !visible.length;
}
function submit(q) { q = q.trim().slice(0,100); if (!q) return; rememberSearch(q); $('query').value = q; const hash = `#search?${new URLSearchParams({q})}`; if (location.hash === hash) search(q); else { location.hash = hash; search(q); } }
function fromTV({show:s}) { return {id:`tvmaze-${s.id}`, title:s.name, original:s.name, year:s.premiered?.slice(0,4), kind:'tv', genres:s.genres || [], poster:s.image?.medium, score:s.rating?.average, summary:plain(s.summary), official:s.officialSite, watch:s.url}; }
function merge(xs, ys) {
  const list = [...xs];
  const names = x => [x.title,x.original,...(x.aliases || [])].map(normalize);
  for (const y of ys) {
    const index = list.findIndex(x=>x.id === y.id || (x.kind === y.kind && String(x.year) === String(y.year) && names(x).some(a=>a && names(y).includes(a))));
    if (index < 0) list.push(y);
    // 有完整片源的记录优先，整条替换（id 随之换成片源 id，选集才能对上）。
    // 有完整片源的记录接管该作品：清掉目录/官方资料的标记，否则会被判成“待检测”或“官方资料”而隐藏。
    else if (y.media?.length && !full(list[index])) {
      const next = {...list[index], ...y};
      if (y.vod) { delete next.online; delete next.officialProvider; delete next.playback; }
      list[index] = next;
    }
    else if (y.officialProvider && !list[index].officialProvider && !full(list[index])) list[index] = {...list[index],...y};
  }
  for (const x of list) items.set(x.id,x);
  return list;
}
async function json(endpoint, timeout = 8500) { const r = await fetch(endpoint,{signal:AbortSignal.timeout(timeout)}); if (!r.ok) { let message; try { message = (await r.json()).error; } catch {} throw Error(message || `HTTP ${r.status}`); } return r.json(); }
async function search(q) {
  const token = ++searchToken, term = normalize(q);
  const match = x => [x.title,x.original,...(x.aliases || [])].map(normalize).includes(term);
  const local = [...imports,...catalog]
    .filter(x=>term && [x.title,x.original,x.year,kindOf(x),x.kind === 'tv' ? '剧集' : '',...(x.aliases || []),...(x.genres || [])].some(v=>normalize(v).includes(term)))
    .sort((a,b)=>Number(match(b))-Number(match(a)) || Number(!!full(b))-Number(!!full(a)));
  searchState = {q,results:local,pending:true,tencent:location.protocol === 'file:' ? '' : '查询中',vod:location.protocol === 'file:' ? '' : '查询中',online:location.protocol === 'file:' ? '' : '查询中',tv:'查询中',imdb:location.protocol === 'file:' ? '' : '查询中',tmdb:''}; setView('search');
  function update(key,label,rows) { if (token !== searchToken) return; searchState[key] = label; searchState.results = merge(searchState.results,rows).sort((a,b)=>Number(normalize(b.title).includes(term))-Number(normalize(a.title).includes(term)) || Number(!!full(b))-Number(!!full(a)) || Number(!!b.officialProvider)-Number(!!a.officialProvider)); if (view === 'search') renderSearch(); }
  await Promise.all([
    location.protocol === 'file:' ? null : json(`api/vod-search?${new URLSearchParams({q})}`,30000).then(data=>{
      const rows = (data.items || []).filter(x=>x.media?.length);
      rememberVod(rows);
      update('vod',rows.length ? `${rows.length} 部完整片源` : '无完整片源',rows);
    }).catch(()=>update('vod','暂不可用',[])),
    location.protocol === 'file:' ? null : json(`api/library?${new URLSearchParams({q,limit:48})}`,16000).then(data=>update('online',`${data.total} 条目录`,data.items || [])).catch(()=>update('online','暂不可用',[])),
    json(`https://api.tvmaze.com/search/shows?${new URLSearchParams({q})}`).then(rows=>update('tv','已搜索',rows.slice(0,24).map(fromTV))).catch(()=>update('tv','暂不可用',[])),
    location.protocol === 'file:' ? null : json(`api/search?${new URLSearchParams({q})}`,18000).then(data=>{
      for (const key of ['tencent','tmdb','imdb']) if (data[key]) update(key,data[key].ok ? '已搜索' : '暂不可用',data[key].rows || []);
      if (!data.imdb) update('imdb','',[]);
      if (!data.tencent) update('tencent','暂不可用',[]);
    }).catch(()=>{update('tencent','暂不可用',[]);update('imdb','暂不可用',[]);}),
    location.protocol === 'file:' ? null : json(`api/miyo?${new URLSearchParams({q})}`,10000).then(data=>{
      if (token === searchToken) { searchState.miyo = data; if (view === 'search') renderSearch(); }
    }).catch(()=>{}),
  ]);
  if (token === searchToken) { searchState.pending = false; if (view === 'search') renderSearch(); }
}
function detailSources(x) {
  if (x.id.startsWith('user-')) return '';
  if (x.vod) {
    const count = x.media?.length || 0;
    const quality = x.width && x.height ? `，实测 ${x.width}×${x.height}${x.resolution ? `（${esc(x.resolution)}）` : ''}` : '';
    const alts = (x.alt || []).filter(a=>a.id && a.id !== x.id);
    const altRow = alts.length ? `<section class="detail-section"><h3>备用线路</h3><p class="source-caption">同一部片在其他公开片库也有完整版本。主线路卡顿时可换一条，切换后会重新核验片长与画质。</p><div class="source-row">${alts.map(a=>`<button type="button" class="chip" data-action="vod-alt" data-value="${esc(a.id)}" data-item="${esc(x.id)}">${esc(a.provider)} · ${esc(a.resolution || '未知画质')}</button>`).join('')}</div></section>` : '';
    return `<section class="detail-section"><h3>片源说明</h3>${pickReasonRow(x, alts, count)}<p class="source-caption">来源：${esc(x.sourceProvider)}公开片库接口。已核验首个播放清单为完整正片（${count > 1 ? `共 ${count} 集可切换` : `片长 ${formatTime(x.media?.[0]?.expectedDuration || 0)}`}）${quality}，清单为 HLS 分片，未加密；播放前仍会再次校验片长，不符即拒播。${x.remarks ? ` 来源标注：${esc(x.remarks)}。` : ''}</p><div class="source-row">${x.area ? `<span class="chip">${esc(x.area)}</span>` : ''}${x.lang ? `<span class="chip">${esc(x.lang)}</span>` : ''}${x.director ? `<span class="chip">导演 ${esc(x.director)}</span>` : ''}</div></section>${altRow}`;
  }
  if (x.sourceProvider) return `<section class="detail-section"><h3>视频来源</h3><p class="source-caption">${esc(x.sourceProvider)} · 2026-11-21 本机验证完整期段的实际解码、80% 跳播与片尾。</p><div class="source-row">${url(x.sourcePage) ? platform('来源页面',x.sourcePage) : ''}</div></section>`;
  if (x.officialProvider) {
    const episodes = (x.officialEpisodes || []).filter(ep=>url(ep.official)).slice(0,36);
    const tested = x.id === 'tencent-mzc002001bk7moh' ? '本机于 2026-11-21 实测第1期上：第三方嵌入仅提供 3 分钟试看，故不作为本站完整正片。' : '';
    return `<section class="detail-section"><h3>官方观看</h3><p class="source-caption">${esc(x.playback?.message || '请前往官方平台观看；本站暂无完整正片来源。')}${tested ? ` ${esc(tested)}` : ''}</p><div class="source-row"><a class="button primary" href="${url(x.official)}" target="_blank" rel="noopener noreferrer">去${esc(x.officialProvider)}观看${icon('arrow-up-right')}</a></div>${episodes.length ? `<h3>官方选集入口</h3><p class="source-caption">以下为官方选集链接，更新、限免及会员标记以平台页面为准。</p><div class="source-row">${episodes.map(ep=>platform(`${ep.title || ep.vid}${typeof ep.markLabel === 'string' && ep.markLabel ? ' · '+ep.markLabel : ''}`,ep.official)).join('')}</div>` : ''}</section>`;
  }
  if (x.online) return `<section class="detail-section"><h3>片源说明</h3><p class="source-caption">${esc(x.online.provider === 'cntv' ? '央视公开完整节目，连接官方自适应视频。可用性受官方版权状态、地区与网络影响。' : '开放电影目录，播放前核对 Commons 完整文件与许可。影片语言、字幕和画质以原始文件为准。')}</p><div class="source-row">${url(x.official || x.watch) ? platform('来源页面',x.official || x.watch) : ''}</div></section>`;
  const own = /^tmdb-(movie|tv)-(\d+)$/.exec(x.id);
  const sourceName = x.id.startsWith('imdb-') ? 'IMDb 资料' : 'TVmaze 资料';
  const links = (own ? platform('TMDB 观看指南',`https://www.themoviedb.org/${own[1]}/${own[2]}/watch`) : (url(x.watch) ? platform(sourceName,x.watch) : '')) + (url(x.official) ? platform('剧集官网',x.official) : '');
  const check = checks.get(x.id);
  const checked = check ? `<section class="detail-section"><h3>${check.candidate ? '候选版本' : '已查站外渠道'}</h3><p class="source-caption">${esc(check.note)}</p><div class="source-row">${check.links.map(([name,href])=>platform(name,href)).join('')}</div></section>` : '';
  return `${checked}<section class="detail-section"><h3>平台检索</h3><div class="source-top source-row">${links}${platforms(x.title)}</div><p class="source-caption">检索入口不代表已上架；可看情况取决于地区和权限。</p></section>`;
}
function showDetail(id, mediaKey) {
  const x = items.get(id) || lists.flatMap(l=>l.entries).find(y=>y.id === id);
  if (!x) return;
  teardownPlayer(); current = x;
  if (x.online && !x.media?.length) {
    $('detail-content').innerHTML = `<div class="detail-head"><strong>${esc(x.title)}</strong>${iconButton('close','关闭详情','','small')}</div><div class="detail-body"><div id="online-resolve-status" class="player-note" role="status">正在检查完整片源并连接官方视频…</div></div>`;
    if (!$('detail').open) $('detail').showModal();
    resolveOnline(x,mediaKey || 'full'); return;
  }
  const missing = x.officialProvider ? '本站暂无可播放的完整正片，下面提供官方观看入口。' : availability(x) === 'candidate' ? '已找到完整候选，尚未通过站内播放验证。' :
    checks.has(x.id) ? '已查，未找到可接入站内直放的授权正片。' : '尚未核验可在本站播放的正片来源。';
  $('detail-content').innerHTML = `<div class="detail-head"><strong>${esc(x.title)}</strong><div class="source-row">${save(x,'small')}${iconButton('close','关闭详情','','small')}</div></div><div class="detail-body">${x.media?.length ? '<section class="detail-play"><div id="player" class="player"></div><div id="media-options" class="source-row"></div></section>' : ''}${full(x) ? '' : `<p class="source-caption">${missing}</p>`}<div class="detail-intro">${picture(x)}<div><h2>${esc(x.title)}</h2>${x.original && x.original !== x.title ? `<div class="muted">${esc(x.original)}</div>` : ''}<div class="meta">${meta(x,true)}</div><div class="douban-detail" data-douban-title="${esc(x.title)}" data-douban-year="${esc(x.year || '')}" hidden></div><p>${esc(x.summary || '暂无剧情简介。')}</p></div></div>${detailSources(x)}</div>`;
  if (!$('detail').open) $('detail').showModal();
  $('detail').scrollTop = 0; scheduleDouban();
  if (x.media?.length) {
    showMediaOptions(x);
    if (mediaKey) startMedia(x.media.some(m=>m.key === mediaKey) ? mediaKey : x.media[0].key);
  }
}
async function resolveOnline(x,key) {
  try {
    const resolved = await json(`api/resolve?${new URLSearchParams({id:x.id})}`,24000);
    if (current !== x || !$('detail').open) return;
    if (!resolved.media?.length) throw Error('来源未返回可播放的完整视频');
    const titleFields = x.title !== x.original && /[\u3400-\u9fff]/.test(x.title) ? {title:x.title,original:x.original} : {};
    const updated = {...x,...resolved,online:x.online,...titleFields}; items.set(x.id,updated);
    showDetail(x.id,key);
  } catch (error) {
    if (current !== x || !$('detail').open) return;
    markSourceState(x.id,'failed');
    $('online-resolve-status').innerHTML = `<p>${esc(error.message)}</p><button class="button outline" data-action="online-play-retry" data-value="${esc(x.id)}">重试片源</button>${url(x.official || x.watch) ? platform('打开来源页面',x.official || x.watch) : ''}`;
  }
}
async function resolveVodEpisode(x, m) {
  teardownPlayer(); showMediaOptions(x, m.key);
  $('player').innerHTML = `<div id="player-status" class="player-note" role="status">正在核验「${esc(m.label)}」的完整片源…</div>`;
  try {
    const data = await json(`api/vod-episode?${new URLSearchParams({id:x.id,key:m.key})}`, 30000);
    if (current !== x) return;
    if (!url(data.url)) throw Error('该集没有可播放的完整来源');
    const next = {...m, url:data.url, expectedDuration:data.expectedDuration || m.expectedDuration, verified:'2026-11-21 清单核验'};
    const updated = {...x, media:x.media.map(item=>item.key === m.key ? next : item)};
    items.set(x.id, updated); rememberVod([updated]); current = updated;
    startMedia(m.key);
  } catch (error) {
    if (current !== x) return;
    $('player').innerHTML = `<p class="player-note" role="status">${esc(error.message)}</p><button class="button outline" data-action="media" data-value="${esc(m.key)}">重新核验这一集</button>`;
  }
}
// 切换备用线路：取回另一条片源记录，原地替换 media 后接着播。
async function switchVodLine(x, altId) {
  teardownPlayer(); showMediaOptions(x);
  $('player').innerHTML = `<div id="player-status" class="player-note" role="status">正在核验备用线路…</div>`;
  try {
    const data = await json(`api/vod-item?id=${encodeURIComponent(altId)}`, 40000);
    if (current !== x) return;
    if (!data.media?.length) throw Error('这条线路没有可播放的完整片源');
    const updated = {...data, alt:x.alt};
    items.delete(x.id); items.set(updated.id, updated);
    rememberVod([updated]); current = updated;
    showDetail(updated.id, updated.media[0].key);
    toast(`已切换到${data.sourceProvider}${data.resolution ? ` · ${data.resolution}` : ''}`);
  } catch (error) {
    if (current !== x) return;
    $('player').innerHTML = `<p class="player-note" role="status">${esc(error.message)}</p>`;
  }
}

function showMediaOptions(x, active) { $('media-options').innerHTML = x.media.map(m=>chip(m.label,'media',m.key,m.key === active)).join(''); }
function formatTime(n) { const s = Math.max(0,Math.floor(n)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function record(p, remove = false) {
  const at = p.video.currentTime, duration = p.video.duration;
  if (!remove && (!Number.isFinite(duration) || at < 1 || p.video.seeking)) return;
  if (!remove && at >= duration - 1) remove = true;
  const others = history.filter(h=>h.id !== p.id || h.key !== p.key);
  if (remove && others.length === history.length) return;
  if (!remove && p.last === Math.floor(at)) return;
  p.last = Math.floor(at);
  const entry = items.get(p.id);
  history = (remove ? others : [{id:p.id,key:p.key,at,duration,...(entry ? {item:resumeSnap(entry,p.key)} : {})},...others]).slice(0,30);
  persist(historyKey,history);
}
function teardownPlayer() {
  if (!player) return;
  const p = player; player = null;
  record(p,p.video.ended);
  clearTimeout(p.loadingTimer); p.hls?.destroy();
  p.video.pause(); p.video.removeAttribute('src'); p.video.load();
  if (p.blob) URL.revokeObjectURL(p.blob);
}
function markSourceState(id,state) {
  if (sourceStates.get(id) === state) return;
  sourceStates.set(id,state);
  if (searchState) renderSearch();
  if (view === 'home') renderHome();
  if (onlineState.loaded) renderOnline();
}
function startMedia(key) {
  const x = current, m = x?.media?.find(y=>y.key === key);
  if (!m) return;
  if (m.vodEpisode && !url(m.url || m.src, true)) { resolveVodEpisode(x, m); return; }
  teardownPlayer(); showMediaOptions(x,key);
  const file = m.file ? localMedia.get(x.id) : null;
  if (m.file && !file) {
    $('player').innerHTML = `<label for="resume-file">重新选择原片：${esc(m.file.name)}</label><input id="resume-file" type="file" accept="${fileTypes}"><p id="player-status" class="player-note" role="status"></p>`;
    $('resume-file').addEventListener('change',e=>{
      const selected = e.target.files[0]; if (!selected) return;
      if (!sameFile(m.file,selected)) { $('player-status').textContent = '这不是之前打开的同一文件。'; return; }
      localMedia.set(x.id,selected); startMedia(key);
    });
    return;
  }
  if (!file && !url(m.url || m.src,true)) return;
  const source = file ? URL.createObjectURL(file) : m.url || m.src;
  const epCount = x.media?.length || 0;
  $('player').innerHTML = `<video controls playsinline controlsList="nodownload" preload="metadata" aria-label="${esc(x.title)} ${esc(m.label)}"></video><div class="player-actions">${epCount > 1 ? `<button class="button outline" data-action="player-episodes">选集 ${epCount}</button>` : ''}<button class="button outline" data-action="player-fullscreen">全屏观看</button></div><div class="player-epbar">${epCount > 1 ? `<button data-action="player-episodes">选集 ${epCount}</button>` : ''}<button data-action="player-exitfs">退出全屏</button></div><div id="player-eppanel" class="player-eppanel" hidden></div><div id="player-status" class="player-note" role="status">正在读取视频…</div>${m.credit ? `<p class="player-note">${esc(m.credit)}${url(m.official) ? ` · <a href="${url(m.official)}" target="_blank" rel="noopener noreferrer">来源与署名</a>` : ''}${url(m.license) ? ` · <a href="${url(m.license)}" target="_blank" rel="noopener noreferrer">许可</a>` : ''}${url(m.licenseEvidence) ? ` · <a href="${url(m.licenseEvidence)}" target="_blank" rel="noopener noreferrer">许可依据</a>` : ''}${m.verified ? ` · ${esc(m.verified)}` : ''}</p>` : ''}`;
  const video = $('player').querySelector('video'), p = {video,id:x.id,key,last:-1,blob:file ? source : null}; player = p;
  const status = $('player-status'), previous = history.find(h=>h.id === x.id && h.key === key);
  const backups = [...new Set([...(Array.isArray(m.backup) ? m.backup : [m.backup]),...(m.variants || []).map(v=>v.url || v.src)].filter(link=>link !== source && url(link)))].slice(0,3);
  let resume = false, resumeAt = previous?.at || 0, mediaRecovery = false, networkRecovery = false;
  const playbackError = () => {
    if (p !== player) return;
    clearTimeout(p.loadingTimer);
    if (backups.length) { if (Number.isFinite(video.currentTime) && video.currentTime > 1) resumeAt = video.currentTime; status.textContent = '正在连接备用来源…'; attachSource(backups.shift()); return; }
    p.failed = true; video.pause();
    p.hls?.destroy(); p.hls = null;
    markSourceState(x.id,'failed');
    status.innerHTML = `当前片源未能播放。可重试连接或查看来源页面。<br><button class="button outline" data-action="${x.online ? 'online-play-retry' : 'media'}" data-value="${esc(x.online ? x.id : key)}">重试播放</button>${url(m.official || x.official) ? platform('来源页面',m.official || x.official) : ''}`;
  };
  video.addEventListener('loadedmetadata',()=>{
    if (p !== player) return;
    if (m.expectedDuration && (!Number.isFinite(video.duration) || Math.abs(video.duration-m.expectedDuration) > Math.max(12,m.expectedDuration*.02))) { video.pause(); playbackError(); return; }
    resume = resumeAt > 0 && resumeAt < video.duration - 1;
    if (resume) video.currentTime = resumeAt;
  });
  const showQuality = ()=>{
    if (p === player && !p.failed && video.videoWidth) { clearTimeout(p.loadingTimer); status.textContent = `${video.videoWidth} × ${video.videoHeight} · ${p.hls ? 'HLS 自适应视频' : m.upstreamVariant ? '来源方兼容版' : '来源直放'} · 本站未转码${resume ? ` · 从 ${formatTime(resumeAt)} 继续` : ''}`; }
  };
  video.addEventListener('loadeddata',showQuality);
  video.addEventListener('playing',()=>{if(p !== player)return;if(p.failed)video.pause();else markSourceState(x.id,'decoded');});
  video.addEventListener('resize',()=>{ if (video.readyState >= 2) showQuality(); });
  video.addEventListener('timeupdate',()=>{ if (p === player && Math.floor(video.currentTime) % 4 === 0) record(p); });
  for (const event of ['pause','seeked','ended']) video.addEventListener(event,()=>{ if (p === player) record(p,event === 'ended'); });
  const play = ()=>video.play().catch(error=>{ if (p === player && error.name === 'NotAllowedError') { clearTimeout(p.loadingTimer); status.textContent = '点播放器上的播放按钮开始观看。'; } });
  video.addEventListener('error',playbackError);
  function attachSource(link) {
    clearTimeout(p.loadingTimer); p.hls?.destroy(); p.hls = null;
    p.loadingTimer = setTimeout(()=>{ if (p === player && video.readyState < 2) playbackError(); },25000);
    const hls = /\.m3u8(?:[?#]|$)/i.test(link) || /mpegurl/i.test(m.type || '');
    // 有 hls.js 就优先用它：Chromium 的 canPlayType 对 HLS 会答 "maybe"，
    // 但不少公开片源的原生解析会直接报 MEDIA_ERR_SRC_NOT_SUPPORTED（error 4），hls.js 反而能放。
    if (hls && window.Hls?.isSupported()) {
      p.hls = new Hls({maxBufferLength:24,maxMaxBufferLength:48,enableWorker:true});
      p.hls.on(Hls.Events.MANIFEST_PARSED,play);
      p.hls.on(Hls.Events.ERROR,(_,data)=>{
        if (p !== player || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovery) { mediaRecovery = true; p.hls?.recoverMediaError(); }
        else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !networkRecovery) { networkRecovery = true; p.hls?.startLoad(); }
        else playbackError();
      });
      p.hls.loadSource(link); p.hls.attachMedia(video);
    } else if (hls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      clearTimeout(p.loadingTimer); status.textContent = '当前浏览器不支持此自适应视频，请使用更新的浏览器或打开来源页面。';
    } else { video.src = link; play(); }
  }
  attachSource(source);
  armEpbar();
}
let epbarTimer = 0;
function armEpbar() {
  const bar = document.querySelector('.player-epbar');
  if (!bar) return;
  bar.classList.remove('idle');
  clearTimeout(epbarTimer);
  const panel = $('player-eppanel');
  if (panel && !panel.hidden) return; // 面板开着就保持可见
  epbarTimer = setTimeout(()=>{ const b2=document.querySelector('.player-epbar'); if (b2) b2.classList.add('idle'); }, 3500);
}
function toggleEpisodePanel() {
  const panel = $('player-eppanel');
  if (!panel || !current?.media?.length) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  const x = current, active = player?.key;
  panel.innerHTML = `<div class="player-ep-head"><h4>选集 · ${esc(x.title)}（${x.media.length}）</h4><button type="button" data-action="episode-close" aria-label="收起选集">✕</button></div><div class="player-epgrid">${x.media.map(m=>`<button type="button" class="chip" data-action="episode-pick" data-value="${esc(m.key)}" aria-pressed="${m.key === active}">${esc(m.label)}</button>`).join('')}</div>`;
  panel.hidden = false;
}
function openSheet(html,title, focusInput = false) {
  $('sheet-content').innerHTML = `<div class="detail-head"><strong id="sheet-title">${esc(title)}</strong>${iconButton('close','关闭面板','','small')}</div><div class="sheet-body">${html}</div>`;
  if (!$('sheet').open) $('sheet').showModal();
  if (focusInput) $('list-name').focus();
}
const fileTypes = 'video/*,.mkv,.mp4,.webm,.mov,.m4v';
function importForm(mode = 'file') {
  const file = mode === 'file';
  const field = file ? `<input id="import-source" type="file" accept="${fileTypes}" required>` : '<input id="import-source" type="url" maxlength="3072" placeholder="https://…/video.mp4" required>';
  openSheet(`<div class="filters import-tabs">${chip('本机文件','import','file',file)}${chip('视频直链','import','url',!file)}</div><form id="import-form" data-mode="${mode}"><label for="import-source">${file ? '原视频文件' : 'HTTPS 视频直链'}</label>${field}<label for="import-title">片名（可选）</label><input id="import-title" maxlength="90" placeholder="默认使用文件名"><div class="sheet-actions"><button class="button primary" type="submit">${icon('play')}导入并播放</button></div></form>`,'导入原片');
}
function sameFile(meta, file) { return meta && meta.name === file.name && meta.size === file.size && meta.lastModified === file.lastModified; }
function importSource(form) {
  const input = $('import-source'), file = input.files?.[0];
  let media, name, existing;
  if (form.dataset.mode === 'file') {
    if (!file?.size) { input.setCustomValidity('请选择非空的视频文件'); input.reportValidity(); return; }
    name = file.name;
    media = {key:'full',label:'本机原片',file:{name,size:file.size,lastModified:file.lastModified}};
    existing = imports.find(x=>sameFile(x.media[0].file,file));
  } else {
    let link;
    try { link = new URL(input.value); } catch {}
    if (!link || link.protocol !== 'https:' || link.username || link.password) { input.setCustomValidity('请输入有效的 HTTPS 视频直链'); input.reportValidity(); return; }
    name = link.pathname.split('/').at(-1) || link.hostname;
    try { name = decodeURIComponent(name); } catch {}
    media = {key:'full',label:'直链原片',url:link.href};
    existing = imports.find(x=>x.media[0].url === link.href);
  }
  const title = $('import-title').value.trim() || existing?.title || name.replace(/\.[\w]{1,5}$/,'').slice(0,90) || '我的原片';
  const x = {id:existing?.id || `user-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,title,kind:'movie',genres:[],media:[media]};
  const next = [x,...imports.filter(i=>i.id !== x.id)];
  if (!persist(importsKey,next)) return;
  imports = next; items.set(x.id,x);
  if (file) localMedia.set(x.id,file);
  $('sheet').close(); filter = 'open'; setView('home'); showDetail(x.id,'full');
}
function chooseList(id) {
  const x = items.get(id) || lists.flatMap(l=>l.entries).find(y=>y.id === id);
  if (!x) return;
  openSheet(lists.map(l=>{const has=l.entries.some(y=>y.id === id); return `<button class="list-choice" data-action="toggle" data-value="${esc(l.id)}" data-item="${esc(id)}" aria-pressed="${has}">${esc(l.name)}<small>${has ? '已添加' : '加入'}</small></button>`;}).join('')+`<button class="button outline" data-action="new-list" data-value="${esc(id)}">${icon('plus')}新建片单</button>`,x.title);
}
function listForm(id, itemId) {
  const list = lists.find(l=>l.id===id);
  openSheet(`<form id="list-form" data-list="${esc(id)}" data-item="${esc(itemId)}"><label for="list-name">片单名称</label><input id="list-name" maxlength="24" required value="${esc(list?.name)}" placeholder="例如：周末电影"><div class="sheet-actions"><button class="button primary" type="submit">${list ? '保存' : '创建'}</button></div></form>`,list ? '重命名片单' : '新建片单',true);
}
function refreshSaved() {
  for (const b of document.querySelectorAll('button[data-action="save"]')) { const status = saved(b.dataset.value); b.setAttribute('aria-pressed', status); b.classList.toggle('is-saved',status); }
  if (view === 'library') renderLibrary();
}
document.addEventListener('click',event=>{
  if (event.target.closest?.('.player')) armEpbar();
  const b = event.target.closest('button[data-action],button[data-view],#new-list'); if (!b) return;
  if (b.dataset.view) { openView(b.dataset.view); if (b.dataset.view === 'search') $('query').focus(); return; }
  if (b.id === 'new-list') return listForm('','');
  const id = b.dataset.value;
  switch (b.dataset.action) {
    case 'home-more': {
      homeShown += 96;
      // 本地条目不够就先按页补拉，拉不到再渲染（避免「还有 N 部」点了没反应）
      const ready = [...new Map([...imports,...catalog,...scraped].filter(x=>availability(x) === 'open').map(x=>[x.id,x])).values()].length;
      if (homeShown >= ready && scrapedPages.loaded < scrapedPages.total) loadScraped(6).then(renderHome);
      else renderHome();
      break;
    }
    case 'scrape-toggle': if (scrapeState.static) scrapeSome(); else toggleScrape(); break;
    case 'scrape-category': pickScrapedFilter('category', id); break;
    case 'scrape-region': pickScrapedFilter('region', id); break;
    case 'scrape-quality': pickScrapedFilter('quality', id); break;
    case 'scrape-sort': scrapedFilter = {...scrapedFilter, sort:id}; homeShown = 96; renderHome(); $('home-sort')?.querySelector('[aria-pressed=true]')?.focus({preventScroll:true}); break;
    case 'filter': filter = id; homeShown = 96; renderHome(); $('home-filters').querySelector('[aria-pressed=true]')?.focus({preventScroll:true}); break;
    case 'search-filter': if (searchState) { searchState.mode=id; renderSearch(); $('search-filters').querySelector('[aria-pressed=true]')?.focus({preventScroll:true}); } break;
    case 'left': case 'right': { if (!$('hero')) break; const action = b.dataset.action; slide = (slide + (action === 'left' ? -1 : 1) + featured.length) % featured.length; renderHero(); $('hero').querySelector(`[data-action="${action}"]`)?.focus({preventScroll:true}); break;}
    case 'query': submit(id); break;
    case 'history-clear': searches = []; persist(searchKey, searches); renderSearchHistory(false); break;
    case 'trend': submit(id); break;
    case 'trend-left': case 'trend-right': { const n=(trendingState?.items||[]).length||1; trendSlide=(trendSlide+(b.dataset.action==='trend-right'?1:-1)+n)%n; renderTrending(); break; }
    case 'online-provider': loadOnline({provider:id,page:1}); break;
    case 'online-page': loadOnline({page:Math.max(1,Number(id) || 1)}); $('online-library').scrollIntoView({block:'start',behavior:'smooth'}); break;
    case 'online-retry': loadOnline({page:onlineState.page}); break;
    case 'online-play-retry': {const x = items.get(id) || current; if (x?.online) { delete x.media; items.set(x.id,x); showDetail(x.id,'full'); } break;}
    case 'detail': showDetail(id); break;
    case 'resume': showDetail(id,b.dataset.media || 'full'); break;
    case 'media': startMedia(id); $('media-options').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true}); break;
    case 'player-fullscreen': {
      const box = $('player'), v = box?.querySelector('video');
      if (!v) break;
      try {
        // 全屏容器而不是视频本体：这样切集时只换 video，不会退出全屏，选集控件也一直在。
        if (box.requestFullscreen) box.requestFullscreen().then(() => {
          try { const p = screen.orientation?.lock?.('landscape'); if (p?.catch) p.catch(()=>{}); } catch {}
          armEpbar();
        }).catch(()=>{ v.webkitEnterFullscreen?.(); });
        else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
      } catch {}
      break;
    }
    case 'player-exitfs': { const p=$('player-eppanel'); if (p) p.hidden=true; try { document.exitFullscreen?.(); } catch {} break; }
    case 'player-episodes': { toggleEpisodePanel(); armEpbar(); break; }
    case 'episode-close': { const p=$('player-eppanel'); if (p) p.hidden=true; armEpbar(); break; }
    case 'episode-pick': { const p=$('player-eppanel'); if (p) p.hidden=true; if (player) startMedia(id); break; }
    case 'vod-alt': {const x = items.get(b.dataset.item) || current; if (x) switchVodLine(x, id); break;}
    case 'close': b.closest('dialog')?.close(); break;
    case 'save': chooseList(id); break;
    case 'import': importForm(id || 'file'); break;
    case 'list': activeList = id; renderLibrary(); $('list-tabs').querySelector('[aria-pressed=true]')?.focus({preventScroll:true}); break;
    case 'new-list': listForm('',id); break;
    case 'edit': listForm(id,''); break;
    case 'toggle': {
      const itemId = b.dataset.item, x = items.get(itemId) || lists.flatMap(l=>l.entries).find(e=>e.id === itemId);
      const list = lists.find(l=>l.id === id); if (!x || !list) return;
      const had = list.entries.some(e=>e.id === itemId);
      const next = lists.map(l=>l === list ? {...l,entries:had ? l.entries.filter(e=>e.id !== itemId) : [snapshot(x),...l.entries]} : l);
      if (persist(listsKey,next)) { lists = next; refreshSaved(); chooseList(itemId); [...$('sheet').querySelectorAll('[data-action="toggle"]')].find(el=>el.dataset.value===id)?.focus(); }
      break;
    }
  }
});
document.addEventListener('submit',event=>{
  const form = event.target;
  if (form.id === 'search-form') { event.preventDefault(); submit($('query').value); return; }
  if (form.id === 'online-search-form') { event.preventDefault(); loadOnline({q:$('online-query').value.trim().slice(0,100),page:1}); return; }
  if (form.id === 'import-form') { event.preventDefault(); importSource(form); return; }
  if (form.id !== 'list-form') return;
  event.preventDefault(); const input = $('list-name'), name = input.value.trim();
  if (!name) { input.setCustomValidity('请输入片单名称'); input.reportValidity(); return; }
  if (lists.some(l=>l.id!==form.dataset.list && l.name === name)) { input.setCustomValidity('这个片单名称已存在'); input.reportValidity(); return; }
  const itemId = form.dataset.item, x = items.get(itemId) || lists.flatMap(l=>l.entries).find(e=>e.id === itemId);
  const id = form.dataset.list || `list-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const next = form.dataset.list ? lists.map(l=>l.id === id ? {...l,name} : l) : [...lists,{id,name,entries:x ? [snapshot(x)] : []}];
  if (persist(listsKey,next)) { lists = next; activeList = id; $('sheet').close(); refreshSaved(); toast(form.dataset.list ? '片单已重命名' : '片单已创建'); }
});
document.addEventListener('input', e=>{ if (['list-name','import-source'].includes(e.target.id)) e.target.setCustomValidity(''); });
{ const q = $('query'), form = $('search-form');
  for (const ev of ['focus','click','input']) q.addEventListener(ev, () => renderSearchHistory(true));
  form.addEventListener('focusout', () => setTimeout(() => { if (!form.matches(':focus-within')) renderSearchHistory(false); }, 200));
  document.addEventListener('click', e => { if (!form.contains(e.target)) renderSearchHistory(false); }, true);
}
document.addEventListener('error',e=>{ if (e.target.matches?.('.poster img')) e.target.hidden = true; },true);
$('detail').addEventListener('close',()=>{ teardownPlayer(); current = null; if (view === 'home') renderHome(); });
window.addEventListener('pagehide',()=>{ if (player) record(player,player.video.ended); });
window.addEventListener('hashchange',route);
route();
})();
