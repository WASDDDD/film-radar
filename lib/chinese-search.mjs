import { randomUUID } from 'node:crypto';

// Public, unauthenticated request captured from the official Tencent search page.
// Evidence: target-show-research/tencent-network.json, tencent-replay-现在就出发.json.
export const TENCENT_SEARCH_ENDPOINT = 'https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vversion_platform=2';
// IMDb alias observed by the parent investigation; search remains live/general.
export const CHINESE_TITLE_ALIASES = Object.freeze({'现在就出发': {original: 'Natural High', imdb: 'tt30461072'}});
const clean = value => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
const key = value => clean(value).normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
const https = value => { try { const u = new URL(String(value).replace(/^\/\//, 'https://')); if (!['http:', 'https:'].includes(u.protocol)) return ''; u.protocol = 'https:'; return u.href; } catch { return ''; } };

export function parseTencentSearch(payload, query) {
  const data = payload?.data;
  if (!data || data.errcode !== 0 || !data.normalList || !Array.isArray(data.areaBoxList)) throw new Error('腾讯搜索返回非预期结构或错误');
  const results = new Map();
  // Area boxes contain programme/season cards; normalList also contains clips.
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    const info = item.videoInfo;
    const cid = item.doc?.id;
    if (info?.coverDoc && /^[a-zA-Z0-9]{10,32}$/.test(cid || '')) {
      const title = clean(info.title);
      const poster = https(info.imgUrl);
      // Tencent also returns recommendations for unavailable titles. Do not pass
      // unrelated suggestions off as matches, or episodes off as programmes.
      if (title && poster && Number(info.year) > 0 && key(title).includes(key(query))) {
        const official = `https://v.qq.com/x/cover/${cid}.html`;
        const seasonMatch = title.match(/第\s*(\d+)\s*季/);
        const aliases = [...(info.coverDoc.byName || []), ...(title.startsWith('现在就出发') ? ['现在就出发', 'Natural High'] : [])];
        const officialEpisodes = (info.episodeSites || []).filter(site => site.enName === 'qq').flatMap(site => (site.episodeInfoList || []).filter(ep => /^[a-zA-Z0-9]{11}$/.test(ep.id || '')).map(ep => ({
          vid: ep.id, title: clean(ep.title), official: `https://v.qq.com/x/cover/${cid}/${ep.id}.html`,
          payStatus: ep.payStatus || '', markLabel: ep.markLabel || '', rawTags: ep.rawTags || '',
          playback: {status: 'official-only', message: '请前往腾讯视频官方播放；会员、限免及地区限制以官方为准。'}
        })));
        results.set(cid, {
          id: `tencent-${cid}`, title,
          ...(info.coverDoc.englishName ? {original: clean(info.coverDoc.englishName)} : {}),
          ...(seasonMatch ? {season: Number(seasonMatch[1])} : {}),
          year: Number(info.year) || null,
          kind: Number(info.videoType) === 1 ? 'movie' : 'tv',
          genres: [...new Set([clean(info.typeName), ...(info.coverDoc.richTags || []).filter(t => t.type === 80 || t.type === 90).map(t => clean(t.text))].filter(Boolean))],
          summary: clean(info.descrip || info.subTitle), poster,
          official, watch: official, officialProvider: '腾讯视频', officialEpisodes,
          ...(aliases.length ? {aliases: [...new Set(aliases.map(clean).filter(Boolean))]} : {}),
          playback: {status: 'official-only', message: '腾讯视频官方节目入口；本站未验证可播放正片，播放及会员要求以官方页面为准。'}
        });
      }
    }
    for (const name of ['nestedDocs', 'richDocs']) if (Array.isArray(item[name])) item[name].forEach(visit);
    if (Array.isArray(item.nestedBoxes)) item.nestedBoxes.forEach(box => (box.itemList || []).forEach(visit));
  };
  for (const box of data.areaBoxList) (box.itemList || []).forEach(visit);
  (data.normalList.itemList || []).forEach(visit);
  return [...results.values()];
}

export async function chineseSearch(q) {
  const query = clean(q).replace(/^[《「『]+|[》」』]+$/g, '').trim();
  if (!query || query.length > 120) return {ok: false, rows: [], note: '请输入 1–120 字的节目名称。'};
  try {
    const response = await fetch(TENCENT_SEARCH_ENDPOINT, {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: {'Content-Type': 'application/json', 'Referer': 'https://v.qq.com/', 'Origin': 'https://v.qq.com'},
      body: JSON.stringify({
        version: '26022601', clientType: 1, filterValue: '', uuid: randomUUID(), retry: 0,
        query, pagenum: 0, isPrefetch: true, pagesize: 30, queryFrom: 0,
        searchDatakey: '', transInfo: '', isneedQc: true, preQid: '', adClientInfo: '',
        extraInfo: {isNewMarkLabel: '1', multi_terminal_pc: '1', themeType: '1', sugRelatedIds: '{}', appVersion: '', frontVersion: '26111906'},
        featureList: ['DEFAULT_FEFEATURE', 'PC_SHORT_VIDEOS_WATERFALL', 'PC_WANT_EPISODE_V2', 'PC_WANT_EPISODE', 'RECOMMEND_AI_QUERY']
      })
    });
    if (!response.ok) throw new Error(`腾讯搜索 HTTP ${response.status}`);
    const rows = parseTencentSearch(await response.json(), query);
    return {ok: true, rows, note: rows.length ? '腾讯视频公开搜索的官方节目资料；仅官方入口，不代表本站可播放。' : '腾讯公开搜索未返回标题匹配的节目；已过滤短视频及无关推荐。'};
  } catch (error) {
    return {ok: false, rows: [], note: `腾讯公开搜索暂不可用：${error.message}`};
  }
}
