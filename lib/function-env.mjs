// Netlify Functions 单次同步调用上限 10 秒，手机版那套 20 秒检索预算搬不过来。
// 这里在加载 vod-sources 之前把预算压到安全区间（实测最慢 7.5 秒）；站点环境变量里设了值就以环境变量为准。
process.env.VOD_PROVIDERS ||= 'ffzy,wujin,modu,iqiyi';
process.env.VOD_DEADLINE_CAP ||= '4000';
process.env.VOD_BUDGET ||= '7000';
