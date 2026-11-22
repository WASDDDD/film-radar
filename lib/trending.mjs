// 当前热门：片方实时热榜（非凡资源 ac=top，每日更新）。
// 热榜只给片名 / ID，再批量补详情拿海报与年份。两边（手机版 server.mjs 与静态站函数）共用这一份。
const API = 'https://api.ffzyapi.com/api.php/provide/vod/';

async function getJSON(url, timeout) {
  const res = await fetch(url, {signal: AbortSignal.timeout(timeout)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchTrending({timeout = 5000} = {}) {
  const top = await getJSON(`${API}?ac=top`, timeout);
  const rows = (Array.isArray(top?.list) ? top.list : []).slice(0, 18).filter(x => x?.vod_id && x?.vod_name);
  if (!rows.length) throw new Error('热榜为空');
  let detail = {list: []};
  try { detail = await getJSON(`${API}?ac=detail&ids=${rows.map(x => x.vod_id).join(',')}`, timeout); } catch {}
  const byId = new Map((Array.isArray(detail.list) ? detail.list : []).map(x => [String(x.vod_id), x]));
  const items = rows.map((r, i) => {
    const d = byId.get(String(r.vod_id)) || r;
    const name = String(d.vod_name || r.vod_name || '').trim();
    return {
      title: name,
      year: /^(?:19|20)\d{2}$/.test(String(d.vod_year || '')) ? String(d.vod_year) : '',
      category: String(d.vod_class || '').split(/[,，/]/)[0].trim(),
      poster: /^https:\/\//i.test(String(d.vod_pic || '')) ? d.vod_pic : '',
      rank: i + 1,
    };
  }).filter(x => x.title);
  return {ok: true, items, source: '非凡资源实时热榜', updatedAt: new Date().toISOString()};
}
