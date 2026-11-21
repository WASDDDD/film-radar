// 静态部署版片库：刮削结果已随仓库发布成 data/library.mjs，
// 这里只保留浏览/筛选/分页，不再有后台刮削器。
import items from '../data/library.mjs';

const norm = v => String(v ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}]+/gu, '');
const updatedAt = '2026-11-22';

const facets = { category: {}, region: {}, kind: {} };
for (const x of items) {
  if (x.category) facets.category[x.category] = (facets.category[x.category] || 0) + 1;
  if (x.region) facets.region[x.region] = (facets.region[x.region] || 0) + 1;
  facets.kind[x.kind] = (facets.kind[x.kind] || 0) + 1;
}

export function browse({ q = '', kind = 'all', category = 'all', region = 'all', page = 1, limit = 24 } = {}) {
  const term = norm(q);
  const rows = items.filter(x =>
    (kind === 'all' || x.kind === kind) &&
    (category === 'all' || x.category === category) &&
    (region === 'all' || x.region === region) &&
    (!term || norm(x.title).includes(term) || norm(x.original || '').includes(term)));
  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const p = Math.min(Math.max(1, page), pages);
  return {
    total: rows.length, page: p, pages, facets,
    items: rows.slice((p - 1) * limit, (p - 1) * limit + limit),
    updatedAt,
  };
}

// 静态站没有后台刮削，状态固定为「已完成」。
export function scrapeStatus() {
  const providers = {};
  const kinds = {};
  for (const x of items) {
    providers[x.vodProvider || '?'] = (providers[x.vodProvider || '?'] || 0) + 1;
    kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  }
  return { running: false, static: true, items: items.length, cap: 0, added: 0, rate: 0, elapsed: 0, providers, kinds, lastError: '', total: items.length };
}
