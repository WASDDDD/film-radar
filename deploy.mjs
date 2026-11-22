// 一键部署到 Netlify：打包 netlify/functions → 上传 public/ 静态文件与函数 → 轮询到 ready。
// 用法：NETLIFY_AUTH_TOKEN=xxx node deploy.mjs [站点名或站点ID]
// 站点名默认 film-radar-wasdddd；已存在则复用，不存在则新建。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipFunctions } from '/root/workspace/run/netlify/node_modules/@netlify/zip-it-and-ship-it/dist/main.js';

const TOKEN = process.env.NETLIFY_AUTH_TOKEN;
if (!TOKEN) { console.error('缺少 NETLIFY_AUTH_TOKEN'); process.exit(1); }
const SITE_NAME = process.argv[2] || process.env.NETLIFY_SITE || 'film-radar-wasdddd';
const BASE = 'https://api.netlify.com/api/v1';
const ROOT = new URL('./', import.meta.url).pathname;
const PUB = join(ROOT, 'public');
const FN_OUT = '/tmp/film-radar-fn';

async function call(method, url, body, ctype = 'application/json') {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': ctype } : {}) },
    body, signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  const data = text && /^[[{]/.test(text) ? JSON.parse(text) : text;
  if (!res.ok) throw Error(`${method} ${url.replace(BASE, '')} → ${res.status} ${text.slice(0, 300)}`);
  return data;
}

// 站点：先按名字找，找不到就建
let site = (await call('GET', `${BASE}/sites?name=${encodeURIComponent(SITE_NAME)}`))[0];
if (!site) site = await call('POST', `${BASE}/sites`, JSON.stringify({ name: SITE_NAME }));
if (site.sso_login) await call('PATCH', `${BASE}/sites/${site.id}`, JSON.stringify({ sso_login: false }));
console.log('site', site.id, site.ssl_url);

// 函数：esbuild 打包成 zip
const [fn] = await zipFunctions(join(ROOT, 'netlify/functions'), FN_OUT, { config: { nodeBundler: 'esbuild' } });
const fnBytes = readFileSync(fn.path);
const fnHash = createHash('sha256').update(fnBytes).digest('hex');

// 静态文件：路径 → sha1
const files = {}, byHash = {};
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = '/' + relative(PUB, p).split('\\').join('/');
      const h = createHash('sha1').update(readFileSync(p)).digest('hex');
      files[rel] = h;
      (byHash[h] ||= []).push(rel);
    }
  }
};
walk(PUB);
console.log('files', Object.keys(files).length, 'function bytes', fnBytes.length);

const dep = await call('POST', `${BASE}/sites/${site.id}/deploys`, JSON.stringify({
  files, functions: { api: fnHash }, draft: false, async: false,
}));
for (const hash of dep.required || []) {
  for (const rel of byHash[hash] || []) {
    await call('PUT', `${BASE}/deploys/${dep.id}/files${rel}`, readFileSync(join(PUB, rel.slice(1))), 'application/octet-stream');
  }
}
for (const _ of dep.required_functions || []) {
  await call('PUT', `${BASE}/deploys/${dep.id}/functions/api?runtime=js&size=${fnBytes.length}`, fnBytes, 'application/octet-stream');
}

for (let i = 0; i < 80; i++) {
  await new Promise(r => setTimeout(r, 4000));
  const st = await call('GET', `${BASE}/deploys/${dep.id}`);
  if (['ready', 'error', 'rejected'].includes(st.state)) {
    console.log(st.state, st.ssl_url || '', st.error_message || '');
    process.exit(st.state === 'ready' ? 0 : 1);
  }
}
console.error('部署超时');
process.exit(1);
