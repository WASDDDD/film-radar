// 静态部署版：把原先从 source-research/*.json 读的快照换成随包发布的 ES 模块。
import cntv from '../data/cntv.mjs';
import wiki from '../data/wiki.mjs';

export const cntvSnapshot = cntv;
export const wikiSnapshot = wiki;
