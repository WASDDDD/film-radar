// 影视资料补充源：MIYO 开放接口（IMDb / TMDB 元数据），免鉴权。
// 只提供评分 / 年份 / 类型 / 剧情 / 海报等资料，不产生可播片源。
// 手机版 server.mjs 与静态站函数共用这一份。
const API = 'https://api.miyotv.com/api/';
const UA = 'Mozilla/5.0 (Linux; Android 14) miyo-sync/1.0';

export async function fetchMiyo(query, {limit = 8, timeout = 4000} = {}) {
  const url = `${API}movies/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, {headers:{'User-Agent':UA,'Accept':'application/json'}, signal:AbortSignal.timeout(timeout)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  const items = rows.map(x => {
    const poster = x.posterUrlFull || (x.posterUrl ? `https://api.miyotv.com${x.posterUrl}` : '');
    return {
      id:`miyo-${x.imdbId || x.id}`,
      imdbId:x.imdbId || '',
      title:x.primaryTitle || x.originalTitle || '',
      original:x.originalTitle || '',
      year:x.year ? String(x.year) : '',
      kind:/series|episode|mini/i.test(x.titleType || '') ? 'tv' : 'movie',
      genres:Array.isArray(x.genres) ? x.genres : [],
      rating:x.rating ? Number(x.rating) : 0,
      numVotes:Number(x.numVotes || 0),
      runtime:Number(x.runtime || 0),
      plot:x.plot || '',
      poster:/^https?:\/\//i.test(poster) ? poster : '',
      watch:x.imdbId ? `https://www.imdb.com/title/${x.imdbId}/` : '',
      source:'MIYO · IMDb/TMDB',
    };
  }).filter(x => x.title);
  return {ok:true, query, items, source:'MIYO 开放影视资料库', updatedAt:new Date().toISOString()};
}
